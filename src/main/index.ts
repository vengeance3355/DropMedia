import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupDownloadHandlers } from './downloader'
import { setupUpdater } from './updater'
import { logError, getLocalLogPath } from './logger'
import Store from 'electron-store'

const store = new Store()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximized', false))
}

// Yakalanmamış hatalar — crash koruması
process.on('uncaughtException', (err) => {
  logError({ errorType: 'crash', errorMessage: err.message, stackTrace: err.stack })
})
process.on('unhandledRejection', (reason) => {
  logError({ errorType: 'crash', errorMessage: String(reason) })
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.dropmedia.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupWindowControls()
  setupDownloadHandlers(ipcMain)
  setupSettingsHandlers(ipcMain, store)

  createWindow()
  setupUpdater(mainWindow!)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function setupWindowControls(): void {
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized())
}

function setupSettingsHandlers(ipcMain: Electron.IpcMain, store: Store): void {
  ipcMain.handle('settings-get', (_event, key: string) => store.get(key))
  ipcMain.handle('settings-set', (_event, key: string, value: unknown) => store.set(key, value))
  ipcMain.handle('settings-get-all', () => store.store)

  ipcMain.handle('dialog-select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('get-downloads-folder', () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('open-folder', (_event, folderPath: string) => {
    shell.openPath(folderPath)
  })

  ipcMain.handle('app-version', () => app.getVersion())
  ipcMain.handle('get-log-path', () => getLocalLogPath())
}
