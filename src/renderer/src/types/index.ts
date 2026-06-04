export type DownloadStatus = 'pending' | 'fetching' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

export interface VideoFormat {
  id: string
  label: string
  type: 'video' | 'audio'
}

export interface VideoInfo {
  id: string
  title: string
  thumbnail: string
  remoteThumbnail?: string
  thumbnailPath?: string
  duration: number
  uploader: string
  url: string
  platform: string
  formats: VideoFormat[]
}

export interface DownloadItem {
  id: string
  url: string
  videoInfo?: VideoInfo
  duration?: number
  selectedFormat: string
  status: DownloadStatus
  progress: number
  speed: string
  eta: string
  totalSize: string
  error?: string
  completedAt?: number
  outputDir?: string
  outputPath?: string
  thumbnailUrl?: string
  thumbnail?: string
  thumbnailPath?: string
  localThumbnail?: string
  localThumbnailPath?: string
  downloadLog?: string
}

export type HistoryEntry = DownloadItem

export interface SubtitleStyle {
  fontName: string
  fontSize: number
  textColor: string      // #RRGGBB
  bgColor: string        // #RRGGBB
  bgOpacity: number      // 0..1
  position: 'top' | 'middle' | 'bottom'
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 24,
  textColor: '#FFFFFF',
  bgColor: '#000000',
  bgOpacity: 0.6,
  position: 'bottom'
}

export interface AppSettings {
  downloadDir: string
  theme: 'dark' | 'light'
  maxConcurrentDownloads: number
  language: string
  ytDlpPath: string
  autoUpdate: boolean
  showNotifications: boolean
  filenameTemplate: string
  speedLimit?: number
  completionSound?: boolean
  closeToTray?: boolean
  subtitles?: boolean
  embedSubs?: boolean
  subtitleMode?: 'none' | 'save' | 'soft' | 'burn'
  subtitleLang?: string
  subtitleStyle?: SubtitleStyle
  profiles?: Record<string, string>
  cookieBrowser?: string
  torEnabled?: boolean
  clipboardWatch?: boolean
  fileDragBehavior?: 'drag' | 'copy'
}

export interface UpdateStatus {
  type: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: Record<string, unknown>
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number }
  error?: string
}

export type PreflightSeverity = 'info' | 'warning' | 'error'

export interface PreflightMessage {
  severity: PreflightSeverity
  code: string
  message: string
}

export interface PreflightReport {
  url: string
  ok: boolean
  title?: string
  uploader?: string
  platform: string
  duration?: number
  isPlaylist?: boolean
  itemCount?: number
  needsCookies?: boolean
  hasCookies?: boolean
  recommendedFormat?: string
  messages: PreflightMessage[]
  checkedAt: number
}

export interface LinkInboxItem {
  id: string
  url: string
  status: 'new' | 'checked' | 'queued' | 'ignored' | 'error'
  source: 'manual' | 'clipboard' | 'drop' | 'watch'
  createdAt: number
  updatedAt: number
  preflight?: PreflightReport
}

export interface WatchSource {
  id: string
  type: 'youtube-channel' | 'youtube-playlist' | 'instagram-profile' | 'instagram-story' | 'instagram-highlight' | 'x-profile' | 'tiktok-profile' | 'generic'
  label: string
  url: string
  enabled: boolean
  intervalMinutes: number
  action: 'notify' | 'queue' | 'download'
  defaultFormat: string
  recipeId?: string
  includeKeywords?: string
  excludeKeywords?: string
  lastCheckedAt?: number
  nextCheckAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface WatchItem {
  id: string
  sourceId: string
  url: string
  title: string
  platform: string
  thumbnail?: string
  duration?: number
  status: 'new' | 'queued' | 'downloaded' | 'ignored'
  discoveredAt: number
}

export interface SmartProfile {
  id: string
  name: string
  mode: 'archive' | 'music' | 'course' | 'edit' | 'social'
  platform: string
  format: string
  filenameTemplate: string
  outputDir?: string
  subtitleMode: 'none' | 'save' | 'soft' | 'burn'
  recipeId?: string
}

export interface PostProcessRecipe {
  id: string
  name: string
  description: string
  format?: string
  steps: Array<'metadata' | 'thumbnail' | 'subtitle-save' | 'subtitle-soft' | 'subtitle-burn' | 'audio-normalize' | 'compress' | 'transcript'>
  createdAt: number
  updatedAt: number
}

export interface ProvenanceRecord {
  sourceUrl: string
  downloadedAt: number
  format: string
  ytdlpVersion?: string
  ffmpeg: boolean
  fileHash?: string
}

export interface LibraryRecord {
  id: string
  url: string
  title: string
  platform: string
  outputPath?: string
  format: string
  duration?: number
  thumbnailPath?: string
  tags: string[]
  favorite: boolean
  createdAt: number
  updatedAt: number
  provenance?: ProvenanceRecord
}

export interface AiToolState {
  id: 'whisper' | 'ollama' | 'argos'
  label: string
  enabled: boolean
  installed: boolean
  installApproved: boolean
  sizeHint: string
  description: string
}

export interface ProductHubState {
  inbox: LinkInboxItem[]
  watchSources: WatchSource[]
  watchItems: WatchItem[]
  smartProfiles: SmartProfile[]
  recipes: PostProcessRecipe[]
  library: LibraryRecord[]
  aiTools: AiToolState[]
}
