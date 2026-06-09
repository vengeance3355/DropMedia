/// <reference types="vite/client" />
import {
  AiChatModel,
  AiChatSendRequest,
  AiChatSendResult,
  AiChatSession,
  AiJob,
  AiJobStartRequest,
  AiBenchmarkResult,
  AiSystemReport,
  AiToolState,
  AiToolStatus,
  DownloadItem,
  LibraryRecord,
  LinkInboxItem,
  PostProcessRecipe,
  PreflightReport,
  ProductHubState,
  SmartProfile,
  UpdateStatus,
  VideoInfo,
  WatchItem,
  WatchSource
} from './types'

interface SyncStatus {
  configured: boolean
  signedIn: boolean
  email?: string
  userId?: string
  error?: string
  notice?: string
  emailConfirmationRequired?: boolean
  health?: {
    ok: boolean
    status: 'ready' | 'misconfigured' | 'unreachable' | 'schema_missing'
    message?: string
    missingTables?: string[]
    checkedAt: number
  }
}

declare global {
  interface Window {
    api: {
      // Pencere
      minimizeWindow:    () => void
      maximizeWindow:    () => void
      closeWindow:       () => void
      isMaximized:       () => Promise<boolean>
      onWindowMaximized: (cb: (v: boolean) => void) => void
      openMiniWindow:    () => Promise<void>
      closeMiniWindow:   () => Promise<void>

      // İndirici
      fetchInfo:      (url: string)   => Promise<VideoInfo>
      fetchPlaylist:  (url: string)   => Promise<object[]>
      startDownload:  (req: object)   => Promise<{ started: boolean; error?: string }>
      resumeDownload: (req: object)   => Promise<{ started: boolean; error?: string }>
      pauseDownload:  (id: string)    => Promise<boolean>
      cancelDownload: (id: string)    => Promise<boolean>
      convertFile:    (req: object)   => Promise<{ success: boolean; error?: string }>
      checkYtDlp:     ()              => Promise<string | null>
      checkFfmpeg:    ()              => Promise<boolean>
      updateYtDlp:    ()              => Promise<{ success: boolean; version?: string; error?: string }>
      installFfmpeg:  ()              => Promise<{ success: boolean; error?: string }>
      detectCookieSources: (url?: string) => Promise<Array<{ id: string; label: string; browser: string; profile?: string; hasRelevantCookies: boolean }>>
      repairMediaMetadata: (id: string) => Promise<{ success: boolean; item?: DownloadItem; error?: string }>
      repairThumbnail: (id: string) => Promise<{ success: boolean; item?: DownloadItem; error?: string }>

      // Olaylar
      startConvert:      (req: object) => Promise<{ jobId: string }>
      startSubtitleJob:  (req: object) => Promise<{ jobId: string }>
      startNormalizeJob: (req: object) => Promise<{ jobId: string }>
      cancelMediaJob:    (jobId: string) => Promise<boolean>
      listSubtitleLangs: (url: string, cookieBrowser?: string) => Promise<{ manual: string[]; auto: string[] }>
      findSiblingSubtitle: (videoPath: string) => Promise<string | null>
      onMediaJobProgress: (cb: (d: object) => void) => void
      onMediaJobComplete: (cb: (d: object) => void) => void
      offMediaJobListeners: () => void
      onDownloadProgress: (cb: (d: object) => void) => void
      onDownloadComplete: (cb: (d: object) => void) => void
      onDownloadPaused:   (cb: (d: object) => void) => void
      onDownloadLog:      (cb: (d: object) => void) => void
      onYtDlpProgress:    (cb: (d: object) => void) => void
      onFfmpegProgress:   (cb: (d: object) => void) => void
      offDownloadListeners: () => void
      offInstallerListeners: () => void

      // Clipboard
      onClipboardUrl:       (cb: (url: string) => void) => void
      onClipboardShortcut:  (cb: (url: string) => void) => void
      offClipboardListeners: () => void
      startClipboardWatch:  () => Promise<void>
      stopClipboardWatch:   () => Promise<void>
      setClipboardShortcut: (s: string) => Promise<void>

      // Ayarlar
      getSettings:    () => Promise<Record<string, unknown>>
      getSetting:     (key: string) => Promise<unknown>
      setSetting:     (key: string, value: unknown) => Promise<void>

      // Ürün merkezi
      getProductState:      () => Promise<ProductHubState>
      importProductState:   (state: Partial<ProductHubState>) => Promise<ProductHubState>
      addInboxUrls:         (urls: string[] | string, source?: LinkInboxItem['source']) => Promise<LinkInboxItem[]>
      updateInboxItem:      (id: string, patch: Partial<LinkInboxItem>) => Promise<LinkInboxItem | undefined>
      removeInboxItem:      (id: string) => Promise<boolean>
      checkPreflight:       (url: string, cookieBrowser?: string) => Promise<PreflightReport>
      checkInboxItem:       (id: string, cookieBrowser?: string) => Promise<PreflightReport>
      addWatchSource:       (input: Partial<WatchSource> & { url: string }) => Promise<WatchSource>
      updateWatchSource:    (id: string, patch: Partial<WatchSource>) => Promise<WatchSource | undefined>
      removeWatchSource:    (id: string) => Promise<boolean>
      checkWatchSource:     (id: string) => Promise<{ source: WatchSource; added: WatchItem[] }>
      updateWatchItem:      (id: string, patch: Partial<WatchItem>) => Promise<WatchItem | undefined>
      setSmartProfiles:     (profiles: SmartProfile[]) => Promise<SmartProfile[]>
      setRecipes:           (recipes: PostProcessRecipe[]) => Promise<PostProcessRecipe[]>
      upsertLibraryRecord:  (record: Partial<LibraryRecord> & { url: string }) => Promise<LibraryRecord>
      setAiTools:           (aiTools: AiToolState[]) => Promise<AiToolState[]>
      onProductStateUpdated:(cb: (state: ProductHubState) => void) => void
      onWatchItemsFound:    (cb: (data: { source: WatchSource; items: WatchItem[] }) => void) => void
      offProductListeners:  () => void

      // Local AI
      getAiToolsStatus: () => Promise<AiToolStatus[]>
      getAiSystemReport: () => Promise<AiSystemReport>
      benchmarkAiTool: (toolId: AiToolState['id']) => Promise<AiBenchmarkResult>
      installAiTool:    (toolId: AiToolState['id']) => Promise<{ jobId: string; existing?: boolean }>
      installAiModel:   (modelId: string) => Promise<{ jobId: string; existing?: boolean }>
      installAllAiModels: () => Promise<{ jobId: string; existing?: boolean }>
      repairAiTool:     (toolId: AiToolState['id']) => Promise<{ jobId: string; existing?: boolean }>
      removeAiTool:     (toolId: AiToolState['id']) => Promise<{ jobId: string; existing?: boolean }>
      startAiJob:       (req: AiJobStartRequest) => Promise<{ jobId: string }>
      cancelAiJob:      (jobId: string) => Promise<boolean>
      pauseAiJob:       (jobId: string) => Promise<boolean>
      resumeAiJob:      (jobId: string) => Promise<boolean>
      listAiJobs:       () => Promise<AiJob[]>
      deleteAiJob:      (jobId: string) => Promise<AiJob[]>
      clearAiJobs:      () => Promise<AiJob[]>
      onAiJobProgress:  (cb: (job: AiJob) => void) => void
      onAiJobComplete:  (cb: (job: AiJob) => void) => void
      offAiJobListeners: () => void
      listAiChatModels:   () => Promise<AiChatModel[]>
      listAiChatSessions: () => Promise<AiChatSession[]>
      sendAiChatMessage:  (req: AiChatSendRequest) => Promise<AiChatSendResult>
      deleteAiChatSession:(sessionId: string) => Promise<AiChatSession[]>
      clearAiChatSessions:() => Promise<AiChatSession[]>

      // Supabase sync
      getSyncStatus:        () => Promise<SyncStatus>
      signUpSync:           (email: string, password: string) => Promise<SyncStatus>
      signInSync:           (email: string, password: string) => Promise<SyncStatus>
      signOutSync:          () => Promise<SyncStatus>
      pushProductState:     (state: ProductHubState) => Promise<{ ok: true; syncedAt: number }>
      pullProductState:     () => Promise<{ data: Partial<ProductHubState> | null; syncedAt?: string }>

      // Sistem
      selectFolder:       () => Promise<string | null>
      selectFile:         (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
      getDownloadsFolder: () => Promise<string>
      openFolder:         (path: string) => Promise<void>
      showItemInFolder:   (path: string) => Promise<void>
      openUrl:            (url: string) => Promise<void>
      openFileInPlayer:   (path: string) => Promise<void>
      getThumbnail:       (path: string) => Promise<string | null>
      copyFileToClipboard: (path: string) => Promise<{ ok: boolean; error?: string }>
      startFileDrag:      (path: string, iconDataUrl?: string) => Promise<{ success: boolean; error?: string }>
      getAppVersion:      () => Promise<string>
      logClientError:     (payload: { message?: string; stack?: string; operation?: string; details?: Record<string, unknown> }) => Promise<{ ok: true; localLogPath?: string }>

      // Güncelleme
      checkForUpdates: () => Promise<void>
      installUpdate:   () => Promise<void>
      onUpdateStatus:  (cb: (data: object) => void) => void

      // Tray
      updateTrayCount: (n: number) => void
    }
  }
}
