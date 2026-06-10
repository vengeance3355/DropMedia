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

export interface AdminStatus {
  configured: boolean
  signedIn: boolean
  baseUrl: string
  expiresAt?: number
}

export interface AdminRelease {
  github_id?: number
  version: string
  title?: string
  notes?: string
  github_tag?: string
  windows_exe_url?: string
  windows_blockmap_url?: string
  latest_yml_url?: string
  asset_names?: string[]
  created_at?: string
  prerelease?: boolean
}

export interface AdminReleasePublishInput {
  version?: string
  notes?: string
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
  statusDetail?: string
  statusVersion?: string
}

export type AiToolId = AiToolState['id']
export type AiJobKind = 'install' | 'repair' | 'remove' | 'transcript' | 'summary' | 'translate' | 'titles' | 'benchmark'
export type AiJobStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled'

export interface AiToolStatus {
  id: AiToolId
  installed: boolean
  detail?: string
  version?: string
}

export interface AiChatModel {
  id: string
  label: string
  installed: boolean
  recommended?: boolean
  sizeHint?: string
  weightGb?: number
  recommendation?: string
  recommendationDetail?: string
  description?: string
}

export interface AiChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string
  citations?: AiChatCitation[]
}

export interface AiChatSession {
  id: string
  title: string
  model: string
  attachmentPath?: string
  attachmentTitle?: string
  messages: AiChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface AiChatSendRequest {
  sessionId?: string
  message: string
  model?: string
  attachmentPath?: string
  attachmentTitle?: string
}

export type AiChatSendResult = {
  removed?: false
  session: AiChatSession
  assistant: AiChatMessage
  action?: { kind: Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>; jobId: string }
} | { removed: true }

export interface AiSystemSpecs {
  platform: string
  arch: string
  release: string
  cpuModel: string
  cpuThreads: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  diskFreeBytes: number
  diskTotalBytes: number
  gpu?: string
}

export interface AiRequirementCheck {
  key: 'platform' | 'cpu' | 'memory' | 'freeMemory' | 'disk' | 'gpu'
  label: string
  ok: boolean
  actual: string
  required: string
  detail?: string
}

export interface AiChatCitation {
  ref: string
  snippet: string
}

export interface AiToolRequirementReport {
  toolId: AiToolId
  label: string
  summary: string
  checks: AiRequirementCheck[]
}

export interface AiSystemReport {
  specs: AiSystemSpecs
  tools: AiToolRequirementReport[]
}

export interface AiBenchmarkResult {
  toolId: AiToolId
  ok: boolean
  elapsedMs: number
  rating: string
  message: string
  jobId?: string
  detail?: string
  stats?: AiBenchmarkStats
  createdAt: number
}

export interface AiBenchmarkStats {
  model?: string
  mode?: string
  elapsedMs: number
  rating: string
  response?: string
  outputChars?: number
  firstTokenMs?: number
  evalTokensPerSecond?: number
  promptTokensPerSecond?: number
  totalDurationMs?: number
  loadDurationMs?: number
  promptEvalCount?: number
  promptEvalDurationMs?: number
  evalCount?: number
  evalDurationMs?: number
  timeoutMs?: number
  note?: string
}

export interface AiJob {
  id: string
  kind: AiJobKind
  title: string
  status: AiJobStatus
  percent: number | null
  message: string
  download?: AiDownloadProgress
  install?: AiInstallProgress
  toolId?: AiToolId
  modelId?: string
  inputPath?: string
  outputPath?: string
  benchmark?: AiBenchmarkStats
  runtime?: AiRuntimeProgress
  error?: string
  createdAt: number
  updatedAt: number
}

export interface AiRuntimeProgress {
  label: string
  startedAt: number
  updatedAt: number
  elapsedMs: number
  outputChars?: number
  outputChunks?: number
  tokens?: number
  tokensPerSecond?: number
  note?: string
}

export interface AiDownloadProgress {
  label?: string
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  etaSeconds?: number
  updatedAt: number
}

export interface AiInstallProgress {
  stage: 'planning' | 'downloading' | 'installing' | 'done'
  startedAt: number
  updatedAt: number
  completedItems: number
  totalItems: number
  cachedItems: number
  activeItems: number
  queuedItems: number
  waitingItems: number
  knownBytesItems: number
  percent?: number
  transferredBytes?: number
  totalBytes?: number
  remainingBytes?: number
  bytesPerSecond?: number
  etaSeconds?: number
  currentLabel?: string
}

export interface AiJobStartRequest {
  kind: Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>
  inputPath: string
  title?: string
  model?: string
  targetLanguage?: string
}

export interface StoryItem {
  id: string
  index: number
  username: string
  isVideo: boolean
  mediaUrl: string
  thumbnail: string
  duration: number
  takenAt: number
  width: number
  height: number
  pageUrl: string
}

export interface StoryReel {
  kind: 'user' | 'highlight' | 'post'
  id: string
  username: string
  title: string
  items: StoryItem[]
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

