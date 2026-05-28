import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Pencere
  minimizeWindow:   () => ipcRenderer.send('window-minimize'),
  maximizeWindow:   () => ipcRenderer.send('window-maximize'),
  closeWindow:      () => ipcRenderer.send('window-close'),
  isMaximized:      () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximized:(cb: (v: boolean) => void) => ipcRenderer.on('window-maximized', (_e, v) => cb(v)),
  openMiniWindow:   () => ipcRenderer.invoke('open-mini-window'),
  closeMiniWindow:  () => ipcRenderer.invoke('close-mini-window'),

  // İndirici
  fetchInfo:      (url: string)   => ipcRenderer.invoke('fetch-info', url),
  fetchPlaylist:  (url: string)   => ipcRenderer.invoke('fetch-playlist', url),
  startDownload:  (req: object)   => ipcRenderer.invoke('start-download', req),
  cancelDownload: (id: string)    => ipcRenderer.invoke('cancel-download', id),
  convertFile:    (req: object)   => ipcRenderer.invoke('convert-file', req),
  checkYtDlp:     ()              => ipcRenderer.invoke('check-ytdlp'),
  checkFfmpeg:    ()              => ipcRenderer.invoke('check-ffmpeg'),
  updateYtDlp:    ()              => ipcRenderer.invoke('update-ytdlp'),
  installFfmpeg:  ()              => ipcRenderer.invoke('install-ffmpeg'),

  // İndirme olayları
  onDownloadProgress: (cb: (d: object) => void) => ipcRenderer.on('download-progress',    (_e, d) => cb(d)),
  onDownloadComplete: (cb: (d: object) => void) => ipcRenderer.on('download-complete',    (_e, d) => cb(d)),
  onDownloadLog:      (cb: (d: object) => void) => ipcRenderer.on('download-log',         (_e, d) => cb(d)),
  onYtDlpProgress:    (cb: (d: object) => void) => ipcRenderer.on('ytdlp-update-progress',(_e, d) => cb(d)),
  onFfmpegProgress:   (cb: (d: object) => void) => ipcRenderer.on('ffmpeg-install-progress',(_e,d) => cb(d)),
  offDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.removeAllListeners('download-log')
  },

  // Clipboard
  onClipboardUrl:        (cb: (url: string) => void) => ipcRenderer.on('clipboard-url', (_e, url) => cb(url)),
  startClipboardWatch:   () => ipcRenderer.invoke('clipboard-watch-start'),
  stopClipboardWatch:    () => ipcRenderer.invoke('clipboard-watch-stop'),
  setClipboardShortcut:  (s: string) => ipcRenderer.invoke('clipboard-shortcut-set', s),

  // Ayarlar
  getSettings:    () => ipcRenderer.invoke('settings-get-all'),
  getSetting:     (k: string)         => ipcRenderer.invoke('settings-get', k),
  setSetting:     (k: string, v: unknown) => ipcRenderer.invoke('settings-set', k, v),

  // Sistem
  selectFolder:       () => ipcRenderer.invoke('dialog-select-folder'),
  getDownloadsFolder: () => ipcRenderer.invoke('get-downloads-folder'),
  openFolder:         (p: string) => ipcRenderer.invoke('open-folder', p),
  openFileInPlayer:   (p: string) => ipcRenderer.invoke('open-file-in-player', p),
  startFileDrag:      (p: string) => ipcRenderer.invoke('start-file-drag', p),
  getAppVersion:      () => ipcRenderer.invoke('app-version'),

  // Güncelleme
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate:  () => ipcRenderer.invoke('download-update'),
  installUpdate:   () => ipcRenderer.invoke('install-update'),
  onUpdateStatus:  (cb: (d: object) => void) => ipcRenderer.on('update-status', (_e, d) => cb(d)),

  // Tray
  updateTrayCount: (n: number) => ipcRenderer.send('tray-update-count', n)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (e) { console.error(e) }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
