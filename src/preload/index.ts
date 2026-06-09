import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface DownloadCompletePayload {
  id: string
  success: boolean
  code?: number | null
  cancelled?: boolean
  error?: string
  outputPath?: string
  outputDir?: string
  thumbnailPath?: string
  duration?: number
}

interface DownloadUpdatedPayload {
  id: string
  thumbnailPath?: string
  localThumbnailPath?: string
  duration?: number
}

interface DownloadItemsUpdatedPayload {
  id: string
  [key: string]: unknown
}

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
  resumeDownload: (req: object)   => ipcRenderer.invoke('resume-download', req),
  pauseDownload:  (id: string)    => ipcRenderer.invoke('pause-download', id),
  cancelDownload: (id: string)    => ipcRenderer.invoke('cancel-download', id),
  checkYtDlp:     ()              => ipcRenderer.invoke('check-ytdlp'),
  checkFfmpeg:    ()              => ipcRenderer.invoke('check-ffmpeg'),
  updateYtDlp:    ()              => ipcRenderer.invoke('update-ytdlp'),
  installFfmpeg:  ()              => ipcRenderer.invoke('install-ffmpeg'),
  detectCookieSources: (url?: string) => ipcRenderer.invoke('detect-cookie-sources', url),
  repairMediaMetadata: (id: string) => ipcRenderer.invoke('repair-media-metadata', id),
  repairThumbnail: (id: string) => ipcRenderer.invoke('repair-thumbnail', id),

  // Medya işleri (dönüştürme + altyazı) — arka planda main process'te çalışır
  startConvert:      (req: object) => ipcRenderer.invoke('media-convert', req),
  startSubtitleJob:  (req: object) => ipcRenderer.invoke('media-subtitle', req),
  startNormalizeJob: (req: object) => ipcRenderer.invoke('media-normalize', req),
  cancelMediaJob:    (jobId: string) => ipcRenderer.invoke('media-job-cancel', jobId),
  listSubtitleLangs: (url: string, cookieBrowser?: string) => ipcRenderer.invoke('subtitle-list-langs', url, cookieBrowser),
  findSiblingSubtitle: (videoPath: string) => ipcRenderer.invoke('subtitle-find-sibling', videoPath),
  onMediaJobProgress: (cb: (d: object) => void) => ipcRenderer.on('media-job-progress', (_e, d) => cb(d)),
  onMediaJobComplete: (cb: (d: object) => void) => ipcRenderer.on('media-job-complete', (_e, d) => cb(d)),
  offMediaJobListeners: () => {
    ipcRenderer.removeAllListeners('media-job-progress')
    ipcRenderer.removeAllListeners('media-job-complete')
  },

  // İndirme olayları
  onDownloadProgress: (cb: (d: object) => void) => ipcRenderer.on('download-progress',    (_e, d) => cb(d)),
  onDownloadComplete: (cb: (d: DownloadCompletePayload) => void) => ipcRenderer.on('download-complete',    (_e, d) => cb(d)),
  onDownloadUpdated:  (cb: (d: DownloadUpdatedPayload) => void) => ipcRenderer.on('download-updated',     (_e, d) => cb(d)),
  onDownloadItemsUpdated: (cb: (d: DownloadItemsUpdatedPayload[]) => void) => ipcRenderer.on('download-items-updated', (_e, d) => cb(d)),
  onDownloadPaused:   (cb: (d: object) => void) => ipcRenderer.on('download-paused',      (_e, d) => cb(d)),
  onDownloadLog:      (cb: (d: object) => void) => ipcRenderer.on('download-log',         (_e, d) => cb(d)),
  onYtDlpProgress:    (cb: (d: object) => void) => ipcRenderer.on('ytdlp-update-progress',(_e, d) => cb(d)),
  onFfmpegProgress:   (cb: (d: object) => void) => ipcRenderer.on('ffmpeg-install-progress',(_e,d) => cb(d)),
  onFetchInfoLog:  (cb: (d: object) => void) => ipcRenderer.on('fetch-info-log', (_e, d) => cb(d)),
  offFetchInfoLog: () => ipcRenderer.removeAllListeners('fetch-info-log'),
  offDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.removeAllListeners('download-updated')
    ipcRenderer.removeAllListeners('download-items-updated')
    ipcRenderer.removeAllListeners('download-paused')
    ipcRenderer.removeAllListeners('download-log')
    ipcRenderer.removeAllListeners('convert-progress')
  },
  offInstallerListeners: () => {
    ipcRenderer.removeAllListeners('ytdlp-update-progress')
    ipcRenderer.removeAllListeners('ffmpeg-install-progress')
  },

  // Clipboard
  onClipboardUrl:         (cb: (url: string) => void) => ipcRenderer.on('clipboard-url', (_e, url) => cb(url)),
  onClipboardShortcut:    (cb: (url: string) => void) => ipcRenderer.on('clipboard-shortcut-url', (_e, url) => cb(url)),
  offClipboardListeners:  () => {
    ipcRenderer.removeAllListeners('clipboard-url')
    ipcRenderer.removeAllListeners('clipboard-shortcut-url')
  },
  startClipboardWatch:   () => ipcRenderer.invoke('clipboard-watch-start'),
  stopClipboardWatch:    () => ipcRenderer.invoke('clipboard-watch-stop'),
  setClipboardShortcut:  (s: string) => ipcRenderer.invoke('clipboard-shortcut-set', s),

  // Ayarlar
  getSettings:    () => ipcRenderer.invoke('settings-get-all'),
  getSetting:     (k: string)         => ipcRenderer.invoke('settings-get', k),
  setSetting:     (k: string, v: unknown) => ipcRenderer.invoke('settings-set', k, v),

  // Ürün merkezi
  getProductState:      () => ipcRenderer.invoke('product-state-get'),
  importProductState:   (state: object) => ipcRenderer.invoke('product-state-import', state),
  addInboxUrls:         (urls: string[] | string, source?: string) => ipcRenderer.invoke('product-inbox-add', urls, source),
  updateInboxItem:      (id: string, patch: object) => ipcRenderer.invoke('product-inbox-update', id, patch),
  removeInboxItem:      (id: string) => ipcRenderer.invoke('product-inbox-remove', id),
  checkPreflight:       (url: string, cookieBrowser?: string) => ipcRenderer.invoke('product-preflight-check', url, cookieBrowser),
  checkInboxItem:       (id: string, cookieBrowser?: string) => ipcRenderer.invoke('product-inbox-check', id, cookieBrowser),
  addWatchSource:       (input: object) => ipcRenderer.invoke('product-watch-add', input),
  updateWatchSource:    (id: string, patch: object) => ipcRenderer.invoke('product-watch-update', id, patch),
  removeWatchSource:    (id: string) => ipcRenderer.invoke('product-watch-remove', id),
  checkWatchSource:     (id: string) => ipcRenderer.invoke('product-watch-check', id),
  updateWatchItem:      (id: string, patch: object) => ipcRenderer.invoke('product-watch-item-update', id, patch),
  setSmartProfiles:     (profiles: object[]) => ipcRenderer.invoke('product-profiles-set', profiles),
  setRecipes:           (recipes: object[]) => ipcRenderer.invoke('product-recipes-set', recipes),
  upsertLibraryRecord:  (record: object) => ipcRenderer.invoke('product-library-upsert', record),
  setAiTools:           (aiTools: object[]) => ipcRenderer.invoke('product-ai-set', aiTools),
  onProductStateUpdated:(cb: (d: object) => void) => ipcRenderer.on('product-state-updated', (_e, d) => cb(d)),
  onWatchItemsFound:    (cb: (d: object) => void) => ipcRenderer.on('watch-items-found', (_e, d) => cb(d)),
  offProductListeners:  () => {
    ipcRenderer.removeAllListeners('product-state-updated')
    ipcRenderer.removeAllListeners('watch-items-found')
  },

  // Local AI
  getAiToolsStatus: () => ipcRenderer.invoke('ai-tools-status'),
  getAiSystemReport: () => ipcRenderer.invoke('ai-system-report'),
  benchmarkAiTool: (toolId: string) => ipcRenderer.invoke('ai-tool-benchmark', toolId),
  installAiTool:    (toolId: string) => ipcRenderer.invoke('ai-tool-install', toolId),
  installAiModel:   (modelId: string) => ipcRenderer.invoke('ai-model-install', modelId),
  installAllAiModels: () => ipcRenderer.invoke('ai-model-install-all'),
  repairAiTool:     (toolId: string) => ipcRenderer.invoke('ai-tool-repair', toolId),
  removeAiTool:     (toolId: string) => ipcRenderer.invoke('ai-tool-remove', toolId),
  startAiJob:       (req: object) => ipcRenderer.invoke('ai-job-start', req),
  cancelAiJob:      (jobId: string) => ipcRenderer.invoke('ai-job-cancel', jobId),
  pauseAiJob:       (jobId: string) => ipcRenderer.invoke('ai-job-pause', jobId),
  resumeAiJob:      (jobId: string) => ipcRenderer.invoke('ai-job-resume', jobId),
  listAiJobs:       () => ipcRenderer.invoke('ai-jobs-list'),
  deleteAiJob:      (jobId: string) => ipcRenderer.invoke('ai-job-delete', jobId),
  clearAiJobs:      () => ipcRenderer.invoke('ai-jobs-clear'),
  listAiChatModels:   () => ipcRenderer.invoke('ai-chat-models'),
  listAiChatSessions: () => ipcRenderer.invoke('ai-chat-sessions'),
  sendAiChatMessage:  (req: object) => ipcRenderer.invoke('ai-chat-send', req),
  deleteAiChatSession:(sessionId: string) => ipcRenderer.invoke('ai-chat-delete', sessionId),
  clearAiChatSessions:() => ipcRenderer.invoke('ai-chat-clear'),
  onAiJobProgress:  (cb: (d: object) => void) => ipcRenderer.on('ai-job-progress', (_e, d) => cb(d)),
  onAiJobComplete:  (cb: (d: object) => void) => ipcRenderer.on('ai-job-complete', (_e, d) => cb(d)),
  offAiJobListeners: () => {
    ipcRenderer.removeAllListeners('ai-job-progress')
    ipcRenderer.removeAllListeners('ai-job-complete')
  },

  // Supabase sync
  getSyncStatus:        () => ipcRenderer.invoke('sync-status'),
  signUpSync:           (email: string, password: string) => ipcRenderer.invoke('sync-sign-up', email, password),
  signInSync:           (email: string, password: string) => ipcRenderer.invoke('sync-sign-in', email, password),
  signOutSync:          () => ipcRenderer.invoke('sync-sign-out'),
  pushProductState:     (state: object) => ipcRenderer.invoke('sync-push-product-state', state),
  pullProductState:     () => ipcRenderer.invoke('sync-pull-product-state'),

  // Admin
  getAdminStatus:       () => ipcRenderer.invoke('admin-status'),
  loginAdmin:           (password: string) => ipcRenderer.invoke('admin-login', password),
  logoutAdmin:          () => ipcRenderer.invoke('admin-logout'),
  listAdminReleases:    () => ipcRenderer.invoke('admin-releases-list'),
  saveAdminRelease:     (payload: object) => ipcRenderer.invoke('admin-release-save', payload),
  publishAdminRelease:  (payload: object) => ipcRenderer.invoke('admin-release-publish', payload),

  // Sistem
  getThumbnail:       (path: string) => ipcRenderer.invoke('get-thumbnail', path),
  selectFolder:       () => ipcRenderer.invoke('dialog-select-folder'),
  selectFile:         (filters?: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog-select-file', filters),
  getDownloadsFolder: () => ipcRenderer.invoke('get-downloads-folder'),
  openFolder:         (p: string) => ipcRenderer.invoke('open-folder', p),
  showItemInFolder:   (p: string) => ipcRenderer.invoke('show-item-in-folder', p),
  openUrl:            (url: string) => ipcRenderer.invoke('open-url', url),
  openFileInPlayer:   (p: string) => ipcRenderer.invoke('open-file-in-player', p),
  copyFileToClipboard: (p: string) => ipcRenderer.invoke('copy-file-to-clipboard', p),
  startFileDrag:      (p: string, iconDataUrl?: string) => ipcRenderer.invoke('start-file-drag', p, iconDataUrl),
  getAppVersion:      () => ipcRenderer.invoke('app-version'),
  logClientError:     (payload: object) => ipcRenderer.invoke('client-error-log', payload),

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
