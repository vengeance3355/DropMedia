import { spawn } from 'child_process'
import { BrowserWindow, IpcMain, app } from 'electron'
import Store from 'electron-store'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { buildAccessArgs, detectPlatformName, formatCommand, getYtDlpPath, hasFfmpeg } from './downloader'
import { logError } from './logger'

type InboxStatus = 'new' | 'checked' | 'queued' | 'ignored' | 'error'
type WatchAction = 'notify' | 'queue' | 'download'
type WatchItemStatus = 'new' | 'queued' | 'downloaded' | 'ignored'

interface PreflightMessage {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

interface PreflightReport {
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

interface LinkInboxItem {
  id: string
  url: string
  status: InboxStatus
  source: 'manual' | 'clipboard' | 'drop' | 'watch'
  createdAt: number
  updatedAt: number
  preflight?: PreflightReport
}

interface WatchSource {
  id: string
  type: string
  label: string
  url: string
  enabled: boolean
  intervalMinutes: number
  action: WatchAction
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

interface WatchItem {
  id: string
  sourceId: string
  url: string
  title: string
  platform: string
  thumbnail?: string
  duration?: number
  status: WatchItemStatus
  discoveredAt: number
}

interface SmartProfile {
  id: string
  name: string
  mode: string
  platform: string
  format: string
  filenameTemplate: string
  outputDir?: string
  subtitleMode: 'none' | 'save' | 'soft' | 'burn'
  recipeId?: string
}

interface PostProcessRecipe {
  id: string
  name: string
  description: string
  format?: string
  steps: string[]
  createdAt: number
  updatedAt: number
}

interface LibraryRecord {
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
  provenance?: Record<string, unknown>
}

interface AiToolState {
  id: 'whisper' | 'ollama' | 'argos'
  label: string
  enabled: boolean
  installed: boolean
  installApproved: boolean
  sizeHint: string
  description: string
}

interface ProductHubState {
  inbox: LinkInboxItem[]
  watchSources: WatchSource[]
  watchItems: WatchItem[]
  smartProfiles: SmartProfile[]
  recipes: PostProcessRecipe[]
  library: LibraryRecord[]
  aiTools: AiToolState[]
}

const store = new Store()
let scheduler: ReturnType<typeof setInterval> | null = null

const defaults: ProductHubState = {
  inbox: [],
  watchSources: [],
  watchItems: [],
  smartProfiles: [
    { id: 'archive', name: 'Arşiv', mode: 'archive', platform: 'all', format: 'best', filenameTemplate: '%(uploader)s/%(upload_date)s - %(title)s [%(id)s]', subtitleMode: 'save' },
    { id: 'music', name: 'Müzik', mode: 'music', platform: 'all', format: 'mp3', filenameTemplate: '%(uploader)s - %(title)s', subtitleMode: 'none', recipeId: 'music-metadata' },
    { id: 'course', name: 'Ders', mode: 'course', platform: 'youtube', format: '720p', filenameTemplate: 'Dersler/%(uploader)s/%(title)s [%(id)s]', subtitleMode: 'save', recipeId: 'course-pack' },
    { id: 'social', name: 'Sosyal Paylaşım', mode: 'social', platform: 'instagram', format: 'best', filenameTemplate: '%(uploader)s/%(title)s [%(id)s]', subtitleMode: 'none', recipeId: 'social-mp4' }
  ],
  recipes: [
    { id: 'music-metadata', name: 'Müzik Paketi', description: 'MP3, kapak ve ID3 metadata hazırlığı.', format: 'mp3', steps: ['metadata', 'thumbnail'], createdAt: 0, updatedAt: 0 },
    { id: 'course-pack', name: 'Ders Paketi', description: 'Video, sidecar altyazı ve transcript hazırlığı.', format: 'mp4', steps: ['metadata', 'subtitle-save', 'transcript'], createdAt: 0, updatedAt: 0 },
    { id: 'social-mp4', name: 'Sosyal MP4', description: 'Paylaşıma uygun MP4 ve küçük dosya hazırlığı.', format: 'mp4', steps: ['metadata', 'compress'], createdAt: 0, updatedAt: 0 }
  ],
  library: [],
  aiTools: [
    { id: 'whisper', label: 'Whisper Local', enabled: false, installed: false, installApproved: false, sizeHint: '100 MB - 1.5 GB', description: 'Transcript ve konuşma metni için local model.' },
    { id: 'ollama', label: 'Ollama Local', enabled: false, installed: false, installApproved: false, sizeHint: '1 GB+', description: 'Özet, başlık ve not üretimi için local LLM.' },
    { id: 'argos', label: 'Argos Translate', enabled: false, installed: false, installApproved: false, sizeHint: '100-800 MB', description: 'Altyazı/transcript çevirisi için local çeviri paketi.' }
  ]
}

function now(): number { return Date.now() }

function getState(): ProductHubState {
  return {
    inbox: store.get('product.inbox', defaults.inbox) as LinkInboxItem[],
    watchSources: store.get('product.watchSources', defaults.watchSources) as WatchSource[],
    watchItems: store.get('product.watchItems', defaults.watchItems) as WatchItem[],
    smartProfiles: store.get('product.smartProfiles', defaults.smartProfiles) as SmartProfile[],
    recipes: store.get('product.recipes', defaults.recipes) as PostProcessRecipe[],
    library: store.get('product.library', defaults.library) as LibraryRecord[],
    aiTools: store.get('product.aiTools', defaults.aiTools) as AiToolState[]
  }
}

function importState(input: Partial<ProductHubState>): ProductHubState {
  const arrayKeys: Array<keyof ProductHubState> = ['inbox', 'watchSources', 'watchItems', 'smartProfiles', 'recipes', 'library', 'aiTools']

  for (const key of arrayKeys) {
    const value = input[key]
    if (Array.isArray(value)) {
      store.set(`product.${key}`, value)
    }
  }

  emitState()
  return getState()
}

function setKey<K extends keyof ProductHubState>(key: K, value: ProductHubState[K]): ProductHubState[K] {
  store.set(`product.${key}`, value)
  return value
}

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
}

function emitState(): void {
  mainWindow()?.webContents.send('product-state-updated', getState())
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch { return false }
}

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.trim())
    url.hash = ''
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase()
    if (url.hostname === 'youtu.be') return `https://youtu.be${url.pathname}`
    if (url.hostname === 'youtube.com' && url.pathname === '/watch') {
      const id = url.searchParams.get('v')
      return id ? `https://youtube.com/watch?v=${id}` : url.toString()
    }
    return url.toString()
  } catch {
    return rawUrl.trim()
  }
}

function addInboxUrls(urls: string[], source: LinkInboxItem['source']): LinkInboxItem[] {
  const state = getState()
  const byUrl = new Map(state.inbox.map(item => [normalizeUrl(item.url), item]))
  const added: LinkInboxItem[] = []

  for (const raw of urls) {
    const url = normalizeUrl(raw)
    if (!isHttpUrl(url) || byUrl.has(url)) continue
    const item: LinkInboxItem = {
      id: randomUUID(),
      url,
      status: 'new',
      source,
      createdAt: now(),
      updatedAt: now()
    }
    byUrl.set(url, item)
    added.push(item)
  }

  if (added.length > 0) {
    setKey('inbox', [...added, ...state.inbox].slice(0, 500))
    emitState()
  }

  return added
}

function runProcess(args: string[], timeoutMs = 45_000): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const proc = spawn(getYtDlpPath(), args)
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (payload: { code: number | null; stdout: string; stderr: string; error?: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      done({ code: null, stdout, stderr, error: new Error('timeout') })
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      done({ code, stdout, stderr })
    })
    proc.on('error', (error: Error) => {
      done({ code: null, stdout, stderr, error })
    })
  })
}

function safeHostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 48) || 'Takip kaynağı'
  }
}

function cookieSetting(value?: string): string | undefined {
  if (value !== undefined) return value
  return store.get('cookieBrowser') as string | undefined
}

function friendlyPreflightMessage(stderr: string, url: string): PreflightMessage {
  const text = stderr.toLowerCase()
  if (text.includes('cookies-from-browser') || text.includes('login') || text.includes('registered users') || text.includes('private')) {
    return {
      severity: 'warning',
      code: 'cookies-required',
      message: 'Bu bağlantı oturum veya takipçi erişimi istiyor. Ayarlar > Gizlilik bölümünden giriş yaptığınız tarayıcı cookie profilini seçin.'
    }
  }
  if (text.includes('unsupported url')) {
    return { severity: 'error', code: 'unsupported-url', message: 'Bu bağlantı desteklenmiyor.' }
  }
  if (text.includes('http error 429') || text.includes('rate limit')) {
    return { severity: 'warning', code: 'rate-limit', message: 'Platform geçici hız sınırı uyguladı. Bir süre sonra tekrar deneyin.' }
  }
  if (text.includes('timed out') || text.includes('temporary failure') || text.includes('network')) {
    return { severity: 'warning', code: 'network', message: 'Ağ bağlantısı veya platform erişimi sorunlu görünüyor.' }
  }
  return { severity: 'error', code: 'fetch-failed', message: `${detectPlatformName(url)} bilgisi alınamadı.` }
}

function recommendedFormat(raw: Record<string, unknown>): string {
  const formats = Array.isArray(raw.formats) ? raw.formats as Array<{ height?: number }> : []
  const heights = formats.map(f => f.height).filter((h): h is number => typeof h === 'number')
  if (heights.some(h => h >= 1080)) return '1080p'
  if (heights.some(h => h >= 720)) return '720p'
  return hasFfmpeg() ? 'best' : '480p'
}

async function preflight(url: string, cookieBrowser?: string): Promise<PreflightReport> {
  const target = normalizeUrl(url)
  const messages: PreflightMessage[] = []
  const accessArgs = buildAccessArgs(target, { cookieBrowser: cookieSetting(cookieBrowser) })
  const args = ['--ignore-config', '--dump-json', '--no-playlist', '--no-warnings', ...accessArgs, target]
  const result = await runProcess(args)

  if (result.code !== 0) {
    const msg = friendlyPreflightMessage(`${result.stderr}\n${result.stdout}`, target)
    messages.push(msg)
    return {
      url: target,
      ok: false,
      platform: detectPlatformName(target),
      needsCookies: msg.code === 'cookies-required',
      hasCookies: accessArgs.includes('--cookies-from-browser'),
      messages,
      checkedAt: now()
    }
  }

  try {
    const raw = JSON.parse(result.stdout) as Record<string, unknown>
    const outputDir = (store.get('downloadDir') as string | undefined) || app.getPath('downloads')
    const free = await diskFreeMb(outputDir)
    if (free !== undefined && free < 1024) {
      messages.push({ severity: 'warning', code: 'low-disk', message: `Disk alanı düşük: yaklaşık ${Math.round(free)} MB boş.` })
    }
    if (!hasFfmpeg()) {
      messages.push({ severity: 'warning', code: 'ffmpeg-missing', message: 'ffmpeg yok. En iyi kalite birleştirme, dönüştürme ve altyazı işlemleri kısıtlı çalışır.' })
    }

    messages.push({ severity: 'info', code: 'ready', message: 'Bağlantı indirilebilir görünüyor.' })
    return {
      url: target,
      ok: true,
      title: String(raw.title ?? ''),
      uploader: String(raw.uploader ?? raw.channel ?? ''),
      platform: String(raw.extractor_key ?? raw.extractor ?? detectPlatformName(target)).toLowerCase(),
      duration: typeof raw.duration === 'number' ? raw.duration : undefined,
      hasCookies: accessArgs.includes('--cookies-from-browser'),
      recommendedFormat: recommendedFormat(raw),
      messages,
      checkedAt: now()
    }
  } catch (err) {
    await logError({
      errorType: 'fetch',
      errorMessage: 'Preflight sonucu işlenemedi.',
      url: target,
      operation: 'product-preflight-parse',
      command: formatCommand(getYtDlpPath(), args),
      stackTrace: err instanceof Error ? err.stack : undefined,
      stdout: result.stdout
    })
    return {
      url: target,
      ok: false,
      platform: detectPlatformName(target),
      messages: [{ severity: 'error', code: 'parse-failed', message: 'Bağlantı bilgisi işlenemedi.' }],
      checkedAt: now()
    }
  }
}

function diskFreeMb(dir: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve(undefined)
      return
    }
    const target = existsSync(dir) ? dir : app.getPath('downloads')
    const proc = spawn('df', ['-Pk', target])
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) { resolve(undefined); return }
      const line = stdout.trim().split('\n')[1]
      const freeKb = Number(line?.split(/\s+/)[3])
      resolve(Number.isFinite(freeKb) ? freeKb / 1024 : undefined)
    })
    proc.on('error', () => resolve(undefined))
  })
}

function inferWatchType(url: string): WatchSource['type'] {
  const lower = url.toLowerCase()
  if (lower.includes('instagram.com/stories/highlights')) return 'instagram-highlight'
  if (lower.includes('instagram.com/stories/')) return 'instagram-story'
  if (lower.includes('instagram.com')) return 'instagram-profile'
  if (lower.includes('youtube.com/playlist')) return 'youtube-playlist'
  if (lower.includes('youtube.com/') || lower.includes('youtu.be/')) return 'youtube-channel'
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'x-profile'
  if (lower.includes('tiktok.com')) return 'tiktok-profile'
  return 'generic'
}

function normalizeWatchUrl(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('@')) return `https://www.instagram.com/${value.slice(1).replace(/^@/, '')}/`
  return normalizeUrl(value)
}

async function checkWatchSource(sourceId: string): Promise<{ source: WatchSource; added: WatchItem[] }> {
  const state = getState()
  const source = state.watchSources.find(item => item.id === sourceId)
  if (!source) throw new Error('Takip kaynağı bulunamadı.')

  const accessArgs = buildAccessArgs(source.url)
  const args = ['--ignore-config', '--flat-playlist', '--dump-json', '--yes-playlist', '--no-warnings', ...accessArgs, source.url]
  const result = await runProcess(args, 75_000)
  const updatedSource: WatchSource = {
    ...source,
    lastCheckedAt: now(),
    nextCheckAt: now() + source.intervalMinutes * 60_000,
    updatedAt: now()
  }

  if (result.code !== 0) {
    updatedSource.lastError = friendlyPreflightMessage(`${result.stderr}\n${result.stdout}`, source.url).message
    setKey('watchSources', state.watchSources.map(item => item.id === sourceId ? updatedSource : item))
    emitState()
    return { source: updatedSource, added: [] }
  }

  const known = new Set(state.watchItems.map(item => `${item.sourceId}:${normalizeUrl(item.url)}`))
  const added: WatchItem[] = []
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>
      const url = normalizeUrl(String(raw.url || raw.webpage_url || raw.original_url || source.url))
      const title = String(raw.title || raw.description || basename(url) || 'Yeni içerik')
      if (!matchesSourceFilters(source, title)) continue
      const key = `${sourceId}:${url}`
      if (known.has(key)) continue
      known.add(key)
      added.push({
        id: randomUUID(),
        sourceId,
        url,
        title,
        platform: detectPlatformName(url),
        thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
        duration: typeof raw.duration === 'number' ? raw.duration : undefined,
        status: 'new',
        discoveredAt: now()
      })
    } catch { /* skip malformed item */ }
  }

  const nextSources = state.watchSources.map(item => item.id === sourceId ? { ...updatedSource, lastError: undefined } : item)
  const nextItems = [...added, ...state.watchItems].slice(0, 1000)
  setKey('watchSources', nextSources)
  if (added.length) {
    setKey('watchItems', nextItems)
    if (source.action === 'queue') addInboxUrls(added.map(item => item.url), 'watch')
    notifyWatchItems(source, added)
  }
  emitState()
  return { source: { ...updatedSource, lastError: undefined }, added }
}

function matchesSourceFilters(source: WatchSource, title: string): boolean {
  const text = title.toLowerCase()
  const include = source.includeKeywords?.trim().toLowerCase()
  const exclude = source.excludeKeywords?.trim().toLowerCase()
  if (include && !include.split(',').some(word => text.includes(word.trim()))) return false
  if (exclude && exclude.split(',').some(word => word.trim() && text.includes(word.trim()))) return false
  return true
}

function notifyWatchItems(source: WatchSource, items: WatchItem[]): void {
  const win = mainWindow()
  if (!win || items.length === 0) return
  win.webContents.send('watch-items-found', { source, items })
}

function upsertLibrary(record: Partial<LibraryRecord> & { url: string; title?: string; format?: string }): LibraryRecord {
  const state = getState()
  const existing = state.library.find(item => normalizeUrl(item.url) === normalizeUrl(record.url))
  const next: LibraryRecord = {
    id: existing?.id ?? randomUUID(),
    url: normalizeUrl(record.url),
    title: record.title ?? existing?.title ?? record.url,
    platform: record.platform ?? existing?.platform ?? detectPlatformName(record.url),
    outputPath: record.outputPath ?? existing?.outputPath,
    format: record.format ?? existing?.format ?? 'best',
    duration: record.duration ?? existing?.duration,
    thumbnailPath: record.thumbnailPath ?? existing?.thumbnailPath,
    tags: record.tags ?? existing?.tags ?? [],
    favorite: record.favorite ?? existing?.favorite ?? false,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
    provenance: record.provenance ?? existing?.provenance
  }
  const library = existing
    ? state.library.map(item => item.id === existing.id ? next : item)
    : [next, ...state.library]
  setKey('library', library.slice(0, 2000))
  emitState()
  return next
}

export function setupProductHubHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('product-state-get', () => getState())
  ipcMain.handle('product-state-import', (_e, input: Partial<ProductHubState>) => importState(input))
  ipcMain.handle('product-inbox-add', (_e, urls: string[] | string, source: LinkInboxItem['source'] = 'manual') => {
    return addInboxUrls(Array.isArray(urls) ? urls : [urls], source)
  })
  ipcMain.handle('product-inbox-update', (_e, id: string, patch: Partial<LinkInboxItem>) => {
    const state = getState()
    const inbox = state.inbox.map(item => item.id === id ? { ...item, ...patch, updatedAt: now() } : item)
    setKey('inbox', inbox)
    emitState()
    return inbox.find(item => item.id === id)
  })
  ipcMain.handle('product-inbox-remove', (_e, id: string) => {
    const inbox = getState().inbox.filter(item => item.id !== id)
    setKey('inbox', inbox)
    emitState()
    return true
  })
  ipcMain.handle('product-preflight-check', async (_e, url: string, cookieBrowser?: string) => preflight(url, cookieBrowser))
  ipcMain.handle('product-inbox-check', async (_e, id: string, cookieBrowser?: string) => {
    const state = getState()
    const item = state.inbox.find(entry => entry.id === id)
    if (!item) throw new Error('Inbox kaydı bulunamadı.')
    const report = await preflight(item.url, cookieBrowser)
    const inbox = state.inbox.map(entry => entry.id === id ? { ...entry, preflight: report, status: report.ok ? 'checked' as const : 'error' as const, updatedAt: now() } : entry)
    setKey('inbox', inbox)
    emitState()
    return report
  })
  ipcMain.handle('product-watch-add', (_e, input: Partial<WatchSource> & { url: string }) => {
    const state = getState()
    const url = normalizeWatchUrl(input.url)
    const source: WatchSource = {
      id: randomUUID(),
      type: input.type ?? inferWatchType(url),
      label: input.label?.trim() || safeHostLabel(url),
      url,
      enabled: input.enabled ?? true,
      intervalMinutes: Math.max(5, Number(input.intervalMinutes ?? 30)),
      action: input.action ?? 'notify',
      defaultFormat: input.defaultFormat ?? 'best',
      recipeId: input.recipeId,
      includeKeywords: input.includeKeywords,
      excludeKeywords: input.excludeKeywords,
      nextCheckAt: now(),
      createdAt: now(),
      updatedAt: now()
    }
    setKey('watchSources', [source, ...state.watchSources].slice(0, 300))
    emitState()
    return source
  })
  ipcMain.handle('product-watch-update', (_e, id: string, patch: Partial<WatchSource>) => {
    const state = getState()
    const watchSources = state.watchSources.map(source => source.id === id ? { ...source, ...patch, updatedAt: now() } : source)
    setKey('watchSources', watchSources)
    emitState()
    return watchSources.find(source => source.id === id)
  })
  ipcMain.handle('product-watch-remove', (_e, id: string) => {
    const state = getState()
    setKey('watchSources', state.watchSources.filter(source => source.id !== id))
    setKey('watchItems', state.watchItems.filter(item => item.sourceId !== id))
    emitState()
    return true
  })
  ipcMain.handle('product-watch-check', (_e, id: string) => checkWatchSource(id))
  ipcMain.handle('product-watch-item-update', (_e, id: string, patch: Partial<WatchItem>) => {
    const state = getState()
    const watchItems = state.watchItems.map(item => item.id === id ? { ...item, ...patch } : item)
    setKey('watchItems', watchItems)
    emitState()
    return watchItems.find(item => item.id === id)
  })
  ipcMain.handle('product-profiles-set', (_e, profiles: SmartProfile[]) => {
    setKey('smartProfiles', profiles)
    emitState()
    return profiles
  })
  ipcMain.handle('product-recipes-set', (_e, recipes: PostProcessRecipe[]) => {
    setKey('recipes', recipes)
    emitState()
    return recipes
  })
  ipcMain.handle('product-library-upsert', (_e, record: Partial<LibraryRecord> & { url: string }) => upsertLibrary(record))
  ipcMain.handle('product-ai-set', (_e, aiTools: AiToolState[]) => {
    setKey('aiTools', aiTools)
    emitState()
    return aiTools
  })
}

export function startProductWatchScheduler(): void {
  if (scheduler) return
  scheduler = setInterval(() => {
    const watchEnabled = store.get('watchEnabled', true) as boolean
    if (!watchEnabled) return
    const due = getState().watchSources.find(source => source.enabled && (source.nextCheckAt ?? 0) <= now())
    if (!due) return
    checkWatchSource(due.id).catch(err => {
      logError({
        errorType: 'general',
        errorMessage: 'Takip kaynağı kontrol edilemedi.',
        operation: 'watch-scheduler',
        stackTrace: err instanceof Error ? err.stack : undefined,
        details: { sourceId: due.id, url: due.url }
      })
    })
  }, 60_000)
  scheduler.unref?.()
}

export function stopProductWatchScheduler(): void {
  if (!scheduler) return
  clearInterval(scheduler)
  scheduler = null
}
