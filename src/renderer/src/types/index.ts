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
  profiles?: Record<string, string>
  cookieBrowser?: string
  torEnabled?: boolean
  clipboardWatch?: boolean
}

export interface UpdateStatus {
  type: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: Record<string, unknown>
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number }
  error?: string
}
