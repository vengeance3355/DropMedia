import { BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

export function setupUpdater(window: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const send = (data: object) => window.webContents.send('update-status', data)

  autoUpdater.on('checking-for-update',  ()      => send({ type: 'checking' }))
  autoUpdater.on('update-available',     (info)  => send({ type: 'available', info }))
  autoUpdater.on('update-not-available', ()      => send({ type: 'not-available' }))
  autoUpdater.on('download-progress',    (p)     => send({ type: 'downloading', progress: p }))
  autoUpdater.on('update-downloaded',    (info)  => send({ type: 'downloaded', info }))
  autoUpdater.on('error',                (err)   => send({ type: 'error', error: err.message }))

  ipcMain.handle('check-for-updates', () => autoUpdater.checkForUpdates())
  ipcMain.handle('download-update',   () => autoUpdater.downloadUpdate())
  ipcMain.handle('install-update',    () => autoUpdater.quitAndInstall())

  if (!is.dev) {
    setTimeout(() => autoUpdater.checkForUpdates(), 3000)
  }
}
