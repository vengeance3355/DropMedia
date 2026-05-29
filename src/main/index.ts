import { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, globalShortcut, clipboard } from 'electron'
import { join } from 'path'
import { existsSync, appendFileSync } from 'fs'

function dbgSettings(msg: string) {
  try { appendFileSync('/tmp/dropmedia_settings.log', `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupDownloadHandlers } from './downloader'
import { setupUpdater } from './updater'
import { setupInstallerHandlers } from './installer'
import { flushPendingRemoteLogs, logActivity, logError, getLocalLogPath } from './logger'
import { startAdminBridge } from './adminBridge'
import Store from 'electron-store'

const store = new Store()

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let tray: Tray | null = null

// ── Pencere oluşturma ─────────────────────────────────────────────────────────

function createWindow(): void {
  const bounds = store.get('windowBounds') as Electron.Rectangle | undefined

  mainWindow = new BrowserWindow({
    width:  bounds?.width  ?? 1100,
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Pencere boyutunu kaydet
  mainWindow.on('close', () => {
    if (mainWindow) store.set('windowBounds', mainWindow.getBounds())
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

  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window-maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximized', false))
}

function createMiniWindow(): void {
  if (miniWindow) { miniWindow.focus(); return }

  miniWindow = new BrowserWindow({
    width: 360,
    height: 480,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const url = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}?mini=1`
    : join(__dirname, '../renderer/index.html')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mini=1`)
  } else {
    miniWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { mini: '1' } })
  }

  miniWindow.on('closed', () => { miniWindow = null })
}

// ── Sistem tepsisi ────────────────────────────────────────────────────────────

function setupTray(): void {
  // 16x16 minimal PNG icon (base64 embedded — dosya bulunamazsa)
  const iconPath = join(__dirname, '../../resources/tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath).isEmpty()
    ? nativeImage.createEmpty()
    : nativeImage.createFromPath(iconPath)

  tray = new Tray(icon)
  tray.setToolTip('DropMedia')

  const updateMenu = (activeCount = 0) => {
    const menu = Menu.buildFromTemplate([
      { label: activeCount > 0 ? `${activeCount} indirme devam ediyor` : 'DropMedia', enabled: false },
      { type: 'separator' },
      { label: 'Aç',        click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Mini Mod',  click: () => createMiniWindow() },
      { type: 'separator' },
      { label: 'Çıkış',    click: () => app.quit() }
    ])
    tray?.setContextMenu(menu)
  }

  updateMenu(0)
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })

  ipcMain.on('tray-update-count', (_e, count: number) => updateMenu(count))
}

// ── Clipboard izleme ──────────────────────────────────────────────────────────

let clipboardInterval: ReturnType<typeof setInterval> | null = null
let lastClipboard = ''

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function sendClipboardUrl(text: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('clipboard-url', text)
}

function startClipboardWatch(): void {
  if (clipboardInterval) return
  try {
    lastClipboard = clipboard.readText().trim()
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    logError({ errorType: 'clipboard', errorMessage: 'Clipboard okunamadı.', stackTrace: e.stack, operation: 'clipboard-watch-start' })
    return
  }

  clipboardInterval = setInterval(() => {
    try {
      const text = clipboard.readText().trim()
      if (text === lastClipboard) return
      lastClipboard = text

      if (isHttpUrl(text)) {
        sendClipboardUrl(text)
      }
    } catch (err) {
      if (app.isQuiting) {
        stopClipboardWatch()
        return
      }
      const e = err instanceof Error ? err : new Error(String(err))
      logError({ errorType: 'clipboard', errorMessage: 'Clipboard izleme sırasında pano okunamadı.', stackTrace: e.stack, operation: 'clipboard-watch-tick' })
    }
  }, 1000)
}

function stopClipboardWatch(): void {
  if (clipboardInterval) {
    clearInterval(clipboardInterval)
    clipboardInterval = null
  }
}

function registerClipboardShortcut(shortcut: string): void {
  globalShortcut.unregisterAll()
  if (!shortcut) return

  try {
    globalShortcut.register(shortcut, () => {
      try {
        const text = clipboard.readText().trim()
        if (isHttpUrl(text)) {
          if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
          mainWindow.webContents.send('clipboard-shortcut-url', text)
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        logError({
          errorType: 'clipboard',
          errorMessage: 'Clipboard kısayolu çalıştırılamadı.',
          stackTrace: e.stack,
          operation: 'clipboard-shortcut-run'
        })
      }
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    logError({
      errorType: 'clipboard',
      errorMessage: 'Clipboard kısayolu kaydedilemedi.',
      stackTrace: e.stack,
      operation: 'clipboard-shortcut-register',
      details: { shortcut }
    })
  }
}

// ── Crash koruması ────────────────────────────────────────────────────────────

process.on('uncaughtException',  (err)    => logError({ errorType: 'crash', errorMessage: err.message, stackTrace: err.stack }))
process.on('unhandledRejection', (reason) => logError({ errorType: 'crash', errorMessage: String(reason) }))

// ── App başlatma ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.dropmedia.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupWindowControls()
  setupDownloadHandlers(ipcMain)
  setupInstallerHandlers(ipcMain)
  setupSettingsHandlers(ipcMain, store)
  setupClipboardHandlers(ipcMain)

  createWindow()
  setupTray()
  setupUpdater(mainWindow!)
  startAdminBridge()
  flushPendingRemoteLogs()
  const remoteLogRetry = setInterval(() => flushPendingRemoteLogs(), 60_000)
  remoteLogRetry.unref?.()
  logActivity({ eventType: 'app_open', message: 'Uygulama açıldı', details: { windowCount: BrowserWindow.getAllWindows().length } })

  // Clipboard izlemeyi ayara göre başlat
  if (store.get('clipboardWatch')) startClipboardWatch()
  const shortcut = store.get('clipboardShortcut') as string | undefined
  if (shortcut) registerClipboardShortcut(shortcut)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Tray varsa pencere kapatınca çıkma — minimize et
app.on('before-quit', () => {
  app.isQuiting = true
  stopClipboardWatch()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Tray yoksa çıkış yap
    if (!tray) app.quit()
  }
})

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function setupWindowControls(): void {
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window-close', () => {
    if (store.get('closeToTray')) {
      mainWindow?.hide()
    } else {
      app.isQuiting = true
      mainWindow?.close()
    }
  })
  ipcMain.handle('window-is-maximized',    () => mainWindow?.isMaximized())
  ipcMain.handle('open-mini-window',       () => createMiniWindow())
  ipcMain.handle('close-mini-window',      () => miniWindow?.close())
  ipcMain.handle('open-file-in-player',    (_e, path: string) => shell.openPath(path))
  ipcMain.handle('start-file-drag',        async (_e, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) {
        await logError({
          errorType: 'general',
          errorMessage: 'Sürüklenmek istenen dosya bulunamadı.',
          operation: 'start-file-drag',
          details: { filePath }
        })
        return { success: false, error: 'Dosya bulunamadı.' }
      }
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { success: false, error: 'Ana pencere hazır değil.' }
      }

      const iconPath = join(__dirname, '../../resources/icon.png')
      const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
      mainWindow.webContents.startDrag({ file: filePath, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon })
      return { success: true }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({
        errorType: 'general',
        errorMessage: 'Dosya sürükleme başlatılamadı.',
        stackTrace: e.stack,
        operation: 'start-file-drag',
        details: { filePath }
      })
      return { success: false, error: 'Dosya sürükleme başlatılamadı.' }
    }
  })
}

function setupClipboardHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('clipboard-watch-start',  () => {
    store.set('clipboardWatch', true)
    startClipboardWatch()
  })
  ipcMain.handle('clipboard-watch-stop',   () => {
    store.set('clipboardWatch', false)
    stopClipboardWatch()
  })
  ipcMain.handle('clipboard-shortcut-set', (_e, shortcut: string) => {
    store.set('clipboardShortcut', shortcut)
    registerClipboardShortcut(shortcut)
  })
}

function setupSettingsHandlers(ipcMain: Electron.IpcMain, store: Store): void {
  ipcMain.handle('settings-get',     (_e, key: string)           => store.get(key))
  ipcMain.handle('settings-set',     async (_e, key: string, val: unknown) => {
    dbgSettings(`SET ${key}=${JSON.stringify(val)?.slice(0, 100)}`)
    try {
      store.set(key, val)
      dbgSettings(`SET_OK ${key}`)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({
        errorType: 'settings',
        errorMessage: 'Ayar kaydedilemedi.',
        stackTrace: e.stack,
        operation: 'settings-set',
        details: { key }
      })
      throw new Error('Ayar kaydedilemedi.')
    }
  })
  ipcMain.handle('settings-get-all', () => {
    const s = store.store
    dbgSettings(`GET_ALL → clipboardWatch=${s['clipboardWatch']} cookieBrowser=${s['cookieBrowser']}`)
    return s
  })

  ipcMain.handle('dialog-select-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog-select-file', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: filters ?? [{ name: 'Medya Dosyaları', extensions: ['mp4','mkv','webm','mov','avi','mp3','m4a','flac','wav','ogg'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('get-downloads-folder', () => app.getPath('downloads'))
  ipcMain.handle('open-folder',          (_e, p: string) => shell.openPath(p))
  ipcMain.handle('show-item-in-folder',  (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('open-url',             (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app-version',          () => app.getVersion())
  ipcMain.handle('get-log-path',         () => getLocalLogPath())
}

// TypeScript için app genişletme
declare global {
  namespace Electron {
    interface App { isQuiting?: boolean }
  }
}
