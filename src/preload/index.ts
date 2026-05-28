import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Pencere
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximized: (cb: (maximized: boolean) => void) =>
    ipcRenderer.on('window-maximized', (_e, v) => cb(v)),

  // İndirici
  fetchInfo: (url: string) => ipcRenderer.invoke('fetch-info', url),
  startDownload: (req: object) => ipcRenderer.invoke('start-download', req),
  cancelDownload: (id: string) => ipcRenderer.invoke('cancel-download', id),
  checkYtDlp: () => ipcRenderer.invoke('check-ytdlp'),
  updateYtDlp: () => ipcRenderer.invoke('update-ytdlp'),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  // İndirme olayları
  onDownloadProgress: (cb: (data: object) => void) =>
    ipcRenderer.on('download-progress', (_e, d) => cb(d)),
  onDownloadComplete: (cb: (data: object) => void) =>
    ipcRenderer.on('download-complete', (_e, d) => cb(d)),
  onDownloadLog: (cb: (data: object) => void) =>
    ipcRenderer.on('download-log', (_e, d) => cb(d)),
  offDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.removeAllListeners('download-log')
  },

  // Ayarlar
  getSettings: () => ipcRenderer.invoke('settings-get-all'),
  getSetting: (key: string) => ipcRenderer.invoke('settings-get', key),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings-set', key, value),

  // Sistem
  selectFolder: () => ipcRenderer.invoke('dialog-select-folder'),
  getDownloadsFolder: () => ipcRenderer.invoke('get-downloads-folder'),
  openFolder: (path: string) => ipcRenderer.invoke('open-folder', path),
  getAppVersion: () => ipcRenderer.invoke('app-version'),

  // Güncelleme
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb: (data: object) => void) =>
    ipcRenderer.on('update-status', (_e, d) => cb(d))
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
