import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, IpcMain } from 'electron'
import Store from 'electron-store'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { arch as osArch, cpus, freemem, platform as osPlatform, release as osRelease, totalmem } from 'os'
import { delimiter, dirname, extname, basename, join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { getFfmpegPath, hasFfmpeg } from './downloader'
import { logError } from './logger'

type AiToolId = 'whisper' | 'ollama' | 'argos'
type AiJobKind = 'install' | 'repair' | 'remove' | 'transcript' | 'summary' | 'translate' | 'titles' | 'benchmark'
type AiJobStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled'
type AiInstallStage = 'planning' | 'downloading' | 'installing' | 'done'

interface AiToolStatus {
  id: AiToolId
  installed: boolean
  detail?: string
  version?: string
}

interface AiChatModel {
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

interface AiChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string
}

interface AiChatSession {
  id: string
  title: string
  model: string
  attachmentPath?: string
  attachmentTitle?: string
  messages: AiChatMessage[]
  createdAt: number
  updatedAt: number
}

interface AiChatSendRequest {
  sessionId?: string
  message: string
  model?: string
  attachmentPath?: string
  attachmentTitle?: string
}

type AiChatSendResult = {
  removed?: false
  session: AiChatSession
  assistant: AiChatMessage
  action?: { kind: Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>; jobId: string }
} | { removed: true }

interface AiSystemSpecs {
  platform: string
  arch: string
  release: string
  cpuModel: string
  cpuThreads: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  diskFreeBytes: number
  diskTotalBytes: number
}

interface AiRequirementCheck {
  key: 'platform' | 'cpu' | 'memory' | 'freeMemory' | 'disk'
  label: string
  ok: boolean
  actual: string
  required: string
  detail?: string
}

interface AiToolRequirementReport {
  toolId: AiToolId
  label: string
  summary: string
  checks: AiRequirementCheck[]
}

interface AiSystemReport {
  specs: AiSystemSpecs
  tools: AiToolRequirementReport[]
}

interface AiBenchmarkResult {
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

interface AiBenchmarkStats {
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

interface AiJob {
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

interface AiRuntimeProgress {
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

interface AiDownloadProgress {
  label?: string
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  etaSeconds?: number
  updatedAt: number
}

interface AiInstallProgress {
  stage: AiInstallStage
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

type InstallItemState = 'queued' | 'waiting' | 'downloading' | 'cached' | 'done'

interface InstallTrackerItem {
  label: string
  state: InstallItemState
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  updatedAt: number
}

interface InstallTracker {
  jobId: string
  stage: AiInstallStage
  startedAt: number
  items: Map<string, InstallTrackerItem>
}

interface AiJobStartRequest {
  kind: Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>
  inputPath: string
  title?: string
  model?: string
  targetLanguage?: string
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  cancelled: boolean
  error?: Error
}

interface OllamaGenerateResult {
  response: string
  outputChars?: number
  firstTokenMs?: number
  totalDurationMs?: number
  loadDurationMs?: number
  promptEvalCount?: number
  promptEvalDurationMs?: number
  evalCount?: number
  evalDurationMs?: number
}

interface PythonRuntime {
  bin: string
  prefix: string[]
  inVenv: boolean
}

const store = new Store()
const activeJobs = new Map<string, ReturnType<typeof spawn>>()
const cancelledJobs = new Set<string>()
const pausedJobs = new Set<string>()
const runningJobs = new Map<string, AiJob>()
const lastStoredRunningJobAt = new Map<string, number>()
const recentLimit = 200
const activeHttpJobs = new Map<string, { destroy: (error?: Error) => void }>()
const activeWheelDownloads = new Map<string, Promise<string>>()
const installTrackers = new Map<string, InstallTracker>()
const chatSessionLimit = 50
const chatMessageLimit = 80
const chatStoreKey = 'ai.chat.sessions'

const toolLabels: Record<AiToolId, string> = {
  whisper: 'Whisper Local',
  ollama: 'Ollama Local',
  argos: 'Argos Translate'
}

const ollamaRecommendedModels: AiChatModel[] = [
  {
    id: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B - önerilen',
    installed: false,
    recommended: true,
    sizeHint: '6.6 GB',
    weightGb: 6.6,
    description: 'Genel sohbet, özet, başlık ve Türkçe kullanım için ana kalite/hız dengesi.'
  },
  {
    id: 'qwen3.5:4b',
    label: 'Qwen 3.5 4B - hızlı',
    installed: false,
    recommended: true,
    sizeHint: '3.4 GB',
    weightGb: 3.4,
    description: 'Daha zayıf cihazlarda hızlı yanıt ve düşük bellek kullanımı.'
  },
  {
    id: 'gemma3:12b',
    label: 'Gemma 3 12B - kalite',
    installed: false,
    recommended: true,
    sizeHint: '8.1 GB',
    weightGb: 8.1,
    description: 'Daha güçlü cihazlarda uzun bağlam, özet ve muhakeme kalitesi.'
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 8B - uyumlu',
    installed: false,
    recommended: true,
    sizeHint: '4.9 GB',
    weightGb: 4.9,
    description: 'Geniş uyumluluk, uzun bağlam ve kararlı genel amaçlı kullanım.'
  }
]
const ollamaModel = ollamaRecommendedModels[0].id
const benchmarkCorpus = [
  'DropMedia, video indirme ve arşivleme sürecinde kullanıcının iş akışını hızlandırmak için local AI kullanır.',
  'Bir içerik üreticisi haftada onlarca uzun video indiriyor, transcript çıkarıyor, Türkçe özet alıyor ve sosyal medya başlıkları hazırlıyor.',
  'Gerçek kullanımda modelin yalnızca açılması yeterli değildir; ilk token süresi, üretim hızı, prompt işleme hızı ve toplam yanıt süresi birlikte ölçülmelidir.',
  'Hız testi kısa bir OK yanıtı yerine anlamlı bir metni özetlemeli, birkaç maddelik sonuç üretmeli ve cihazın uzun yanıt performansını görünür yapmalıdır.',
  'Kullanıcı için iyi sonuç; beklemeden başlayan, saniyede yeterli token üreten ve Türkçe metinde tutarlı kalan modeldir.'
].join(' ')
const gib = 1024 ** 3

const aiRequirementProfiles: Record<AiToolId, {
  cpuThreads: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  diskFreeBytes: number
  supportedPlatforms: NodeJS.Platform[]
}> = {
  whisper: {
    cpuThreads: 8,
    totalMemoryBytes: 16 * gib,
    freeMemoryBytes: 4 * gib,
    diskFreeBytes: 8 * gib,
    supportedPlatforms: ['linux', 'win32']
  },
  ollama: {
    cpuThreads: 12,
    totalMemoryBytes: 24 * gib,
    freeMemoryBytes: 10 * gib,
    diskFreeBytes: 24 * gib,
    supportedPlatforms: ['linux', 'win32']
  },
  argos: {
    cpuThreads: 4,
    totalMemoryBytes: 8 * gib,
    freeMemoryBytes: 2 * gib,
    diskFreeBytes: 4 * gib,
    supportedPlatforms: ['linux', 'win32']
  }
}

function aiDataDir(): string {
  return join(app.getPath('userData'), 'ai')
}

function localOllamaRoot(): string {
  return join(aiDataDir(), 'ollama')
}

function localOllamaBin(): string {
  return join(localOllamaRoot(), 'bin', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
}

function systemOllamaCandidates(): string[] {
  if (process.platform !== 'win32') return []
  return [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe') : ''
  ].filter(Boolean)
}

function localOllamaModels(): string {
  return join(aiDataDir(), 'ollama-models')
}

function whisperCacheDir(): string {
  const home = process.env.HOME || app.getPath('home')
  return process.platform === 'win32'
    ? join(app.getPath('userData'), '..', 'whisper')
    : join(home, '.cache', 'whisper')
}

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
}

function storedJobs(): AiJob[] {
  const raw = store.get('ai.jobs', []) as AiJob[]
  let changed = false
  const normalized = raw.map(job => {
    if ((job.status === 'running' || job.status === 'paused') && !runningJobs.has(job.id) && !activeJobs.has(job.id)) {
      changed = true
      return {
        ...job,
        status: 'cancelled' as AiJobStatus,
        message: 'Uygulama yeniden açıldığı için durdu.',
        error: 'Bu AI işi tamamlanmadan uygulama kapandı; tekrar deneyin.',
        updatedAt: Date.now()
      }
    }
    return job
  })
  if (changed) store.set('ai.jobs', normalized)
  return normalized
}

function listJobs(): AiJob[] {
  const current = Array.from(runningJobs.values())
  const byId = new Map<string, AiJob>()
  for (const job of [...current, ...storedJobs()]) byId.set(job.id, job)
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, recentLimit)
}

function deleteStoredJob(jobId: string): AiJob[] {
  const running = runningJobs.get(jobId)
  if (running?.status === 'running' || running?.status === 'paused') {
    throw new Error('Çalışan AI işi silinemez. Önce iptal edin veya bitmesini bekleyin.')
  }
  store.set('ai.jobs', storedJobs().filter(job => job.id !== jobId))
  return listJobs()
}

function clearStoredJobs(): AiJob[] {
  const active = Array.from(runningJobs.values()).filter(job => job.status === 'running' || job.status === 'paused')
  store.set('ai.jobs', active)
  return listJobs()
}

function saveJob(job: AiJob): void {
  const active = job.status === 'running' || job.status === 'paused'
  if (active) runningJobs.set(job.id, job)
  else {
    runningJobs.delete(job.id)
    lastStoredRunningJobAt.delete(job.id)
  }

  const now = Date.now()
  if (active) {
    const lastStored = lastStoredRunningJobAt.get(job.id)
    if (lastStored && now - lastStored < 1_000) return
    lastStoredRunningJobAt.set(job.id, now)
  }

  const next = [job, ...storedJobs().filter(item => item.id !== job.id)].slice(0, recentLimit)
  store.set('ai.jobs', next)
}

function emitProgress(job: AiJob): void {
  saveJob(job)
  mainWindow()?.webContents.send('ai-job-progress', job)
}

function emitComplete(job: AiJob): void {
  saveJob(job)
  mainWindow()?.webContents.send('ai-job-complete', job)
}

function createJob(input: Omit<AiJob, 'id' | 'status' | 'percent' | 'createdAt' | 'updatedAt'>): AiJob {
  const ts = Date.now()
  const job: AiJob = {
    ...input,
    id: randomUUID(),
    status: 'running',
    percent: null,
    createdAt: ts,
    updatedAt: ts
  }
  emitProgress(job)
  return job
}

function findActiveToolJob(kind: 'install' | 'repair' | 'remove', toolId: AiToolId): AiJob | undefined {
  return listJobs().find(job =>
    job.kind === kind &&
    job.toolId === toolId &&
    (job.status === 'running' || job.status === 'paused')
  )
}

function updateJob(job: AiJob, patch: Partial<AiJob>, complete = false): AiJob {
  const base = runningJobs.get(job.id) ?? job
  const next = { ...base, ...patch, updatedAt: Date.now() }
  if (complete) emitComplete(next)
  else emitProgress(next)
  return next
}

async function logAiActivity(job: AiJob, message: string, details?: Record<string, unknown>): Promise<void> {
  void job
  void message
  void details
  // Routine AI telemetry stays in the in-app AI job history. Admin logs are reserved for failures.
}

function appendTail(current: string, chunk: string, max = 8000): string {
  const next = current + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

function lastUsefulLine(text: string): string {
  const clean = sanitizeTerminalText(text)
  const lines = clean
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1)?.slice(0, 220) ?? ''
}

function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, '')
    .replace(/\x1B[@-_]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
}

function basePythonCommand(): PythonRuntime {
  return process.platform === 'win32'
    ? { bin: 'py', prefix: ['-3'], inVenv: false }
    : { bin: 'python3', prefix: [], inVenv: false }
}

function pythonEnvDir(): string {
  return join(aiDataDir(), 'python-env')
}

function pythonEnvBin(): string {
  return process.platform === 'win32'
    ? join(pythonEnvDir(), 'Scripts', 'python.exe')
    : join(pythonEnvDir(), 'bin', 'python')
}

function pythonWheelhouseDir(): string {
  return join(aiDataDir(), 'wheelhouse')
}

function argosPackagesDir(): string {
  return join(aiDataDir(), 'argos-packages')
}

function pythonCommand(): PythonRuntime {
  const local = pythonEnvBin()
  if (existsSync(local)) return { bin: local, prefix: [], inVenv: true }
  return basePythonCommand()
}

function childEnv(): NodeJS.ProcessEnv {
  const ffmpegDir = dirname(getFfmpegPath())
  const ollamaDir = dirname(localOllamaBin())
  const currentPath = process.env.PATH ?? ''
  return {
    ...process.env,
    PATH: [ffmpegDir, ollamaDir, currentPath].filter(Boolean).join(delimiter),
    OLLAMA_MODELS: process.env.OLLAMA_MODELS ?? localOllamaModels(),
    ARGOS_PACKAGES_DIR: argosPackagesDir(),
    ARGOS_TRANSLATE_PACKAGE_DIR: argosPackagesDir()
  }
}

function runSimple(bin: string, args: string[], stdin?: string, timeoutMs = 12_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let proc: ReturnType<typeof spawn>

    const done = (result: CommandResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    try {
      proc = spawn(bin, args, { env: childEnv() })
    } catch (err) {
      done({ code: -1, stdout, stderr, cancelled: false, error: err instanceof Error ? err : new Error(String(err)) })
      return
    }

    timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      done({ code: -1, stdout, stderr, cancelled: false, error: new Error('timeout') })
    }, timeoutMs)

    proc.stdout?.on('data', (data: Buffer) => { stdout = appendTail(stdout, data.toString()) })
    proc.stderr?.on('data', (data: Buffer) => { stderr = appendTail(stderr, data.toString()) })
    proc.on('close', (code) => done({ code, stdout, stderr, cancelled: false }))
    proc.on('error', (err: Error) => done({ code: -1, stdout, stderr, cancelled: false, error: err }))
    if (stdin) proc.stdin?.end(stdin)
  })
}

async function detectOllamaCommand(): Promise<string | null> {
  const local = localOllamaBin()
  if (existsSync(local)) {
    const result = await runSimple(local, ['--version'])
    if (result.code === 0) return local
  }

  for (const candidate of systemOllamaCandidates()) {
    if (!existsSync(candidate)) continue
    const result = await runSimple(candidate, ['--version'])
    if (result.code === 0) return candidate
  }

  const global = await runSimple('ollama', ['--version'])
  return global.code === 0 ? 'ollama' : null
}

function ollamaWindowsInstallCommand(): { bin: string; args: string[] } {
  return {
    bin: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'irm https://ollama.com/install.ps1 | iex'
    ]
  }
}

function ollamaDownloadUrl(): string {
  if (!isOllamaManagedInstallSupported()) {
    throw new Error(ollamaManagedInstallUnsupportedMessage())
  }
  if (process.arch === 'x64') return 'https://ollama.com/download/ollama-linux-amd64.tar.zst'
  if (process.arch === 'arm64') return 'https://ollama.com/download/ollama-linux-arm64.tar.zst'
  throw new Error(`Bu CPU mimarisi için Ollama paketi desteklenmiyor: ${process.arch}`)
}

function isOllamaManagedInstallSupported(): boolean {
  return process.platform === 'linux' || process.platform === 'win32'
}

function ollamaManagedInstallUnsupportedMessage(): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform
  return `Ollama otomatik kurulumu ${platform} üzerinde desteklenmiyor. Ollama'yı sistemden kurup "ollama pull ${ollamaModel}" çalıştırın, sonra Kurulum Durumunu Yenile'ye basın.`
}

async function assertCanStartToolSetup(toolId: AiToolId): Promise<void> {
  if (toolId !== 'ollama' || isOllamaManagedInstallSupported()) return

  const ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) throw new Error(ollamaManagedInstallUnsupportedMessage())
}

async function installOllamaRuntime(job: AiJob): Promise<string> {
  mkdirSync(localOllamaRoot(), { recursive: true })
  mkdirSync(localOllamaModels(), { recursive: true })

  if (process.platform === 'win32') {
    const command = ollamaWindowsInstallCommand()
    logAiActivity(job, 'Ollama Windows kurulumu başlıyor.', { command: command.bin, args: command.args }).catch(() => {})
    const install = await runJobCommand(
      job,
      command.bin,
      command.args,
      'Ollama Windows installer çalıştırılıyor...'
    )
    assertCommand(install, 'Ollama Windows kurulumu tamamlanamadı.')
    const detected = await detectOllamaCommand()
    if (!detected) {
      throw new Error('Ollama kuruldu ama komut bulunamadı. Uygulamayı yeniden açıp Kurulum Durumunu Yenile ile kontrol edin.')
    }
    return detected
  }

  const archivePath = join(aiDataDir(), `ollama-${process.arch}.tar.zst`)
  const url = ollamaDownloadUrl()
  logAiActivity(job, 'Ollama runtime indirimi hazırlanıyor.', { url, archivePath }).catch(() => {})

  const download = await runJobCommand(
    job,
    'curl',
    ['-L', '--fail', '--show-error', '-o', archivePath, url],
    'Ollama runtime indiriliyor...'
  )
  assertCommand(download, 'Ollama runtime indirilemedi.')
  logAiActivity(job, 'Ollama runtime indirildi.', { archivePath }).catch(() => {})

  const extract = await runJobCommand(
    job,
    'tar',
    ['--zstd', '-xf', archivePath, '-C', localOllamaRoot()],
    'Ollama runtime çıkarılıyor...'
  )
  assertCommand(extract, 'Ollama runtime çıkarılamadı.')
  logAiActivity(job, 'Ollama runtime çıkarıldı.', { installRoot: localOllamaRoot(), bin: localOllamaBin() }).catch(() => {})

  if (!existsSync(localOllamaBin())) {
    throw new Error('Ollama binary çıkarıldı ama beklenen konumda bulunamadı.')
  }
  return localOllamaBin()
}

async function ensureOllamaServer(job: AiJob, bin: string): Promise<void> {
  const list = await runSimple(bin, ['list'], undefined, 5_000)
  if (list.code === 0) return

  updateJob(job, { message: 'Ollama local server başlatılıyor...' })
  logAiActivity(job, 'Ollama local server başlatılıyor.', { bin, modelsDir: localOllamaModels() }).catch(() => {})
  try {
    mkdirSync(localOllamaModels(), { recursive: true })
    const proc = spawn(bin, ['serve'], {
      env: childEnv(),
      detached: true,
      stdio: 'ignore'
    })
    proc.unref()
  } catch (err) {
    throw new Error(`Ollama server başlatılamadı: ${err instanceof Error ? err.message : String(err)}`)
  }

  for (let i = 0; i < 12; i += 1) {
    if (cancelledJobs.has(job.id)) throw new Error('__AI_CANCELLED__')
    await new Promise(resolve => setTimeout(resolve, 750))
    const ready = await runSimple(bin, ['list'], undefined, 5_000)
    if (ready.code === 0) {
      logAiActivity(job, 'Ollama local server hazır.', { bin }).catch(() => {})
      return
    }
  }

  throw new Error('Ollama server zamanında hazır olmadı.')
}

function ollamaBaseUrl(): URL {
  const configured = (process.env.OLLAMA_HOST ?? '127.0.0.1:11434').trim()
  const value = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`
  return new URL(value)
}

function ollamaApiUrl(pathname: string): URL {
  const url = ollamaBaseUrl()
  url.pathname = pathname
  url.search = ''
  return url
}

function fromOllamaNanos(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value / 1_000_000 : undefined
}

function runOllamaGenerate(job: AiJob, prompt: string, timeoutMs: number): Promise<OllamaGenerateResult> {
  return new Promise((resolve, reject) => {
    if (cancelledJobs.has(job.id)) {
      reject(new Error('__AI_CANCELLED__'))
      return
    }

    const url = ollamaApiUrl('/api/generate')
    const payload = JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      options: {
        num_predict: 1,
        temperature: 0,
        top_k: 1,
        top_p: 0.1
      }
    })
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body = appendTail(body, chunk, 32_000)
      })
      res.on('end', () => {
        const cleanBody = sanitizeTerminalText(body).trim()
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Ollama API hata döndürdü (${res.statusCode ?? '-'}): ${cleanBody.slice(0, 500)}`))
          return
        }

        try {
          const parsed = JSON.parse(cleanBody) as Record<string, unknown>
          if (typeof parsed.error === 'string' && parsed.error) {
            reject(new Error(`Ollama API hatası: ${parsed.error}`))
            return
          }
          resolve({
            response: typeof parsed.response === 'string' ? parsed.response.trim() : '',
            outputChars: typeof parsed.response === 'string' ? parsed.response.trim().length : 0,
            totalDurationMs: fromOllamaNanos(parsed.total_duration),
            loadDurationMs: fromOllamaNanos(parsed.load_duration),
            promptEvalCount: typeof parsed.prompt_eval_count === 'number' ? parsed.prompt_eval_count : undefined,
            promptEvalDurationMs: fromOllamaNanos(parsed.prompt_eval_duration),
            evalCount: typeof parsed.eval_count === 'number' ? parsed.eval_count : undefined,
            evalDurationMs: fromOllamaNanos(parsed.eval_duration)
          })
        } catch (err) {
          reject(new Error(`Ollama API yanıtı okunamadı: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error(`OLLAMA_BENCHMARK_TIMEOUT:${timeoutMs}`))
    })
    req.on('error', (err: Error) => reject(err))
    req.write(payload)
    req.end()
  })
}

function runOllamaBenchmark(job: AiJob, model: string, timeoutMs: number): Promise<OllamaGenerateResult> {
  return new Promise((resolve, reject) => {
    if (cancelledJobs.has(job.id)) {
      reject(new Error('__AI_CANCELLED__'))
      return
    }

    const startedAt = Date.now()
    const url = ollamaApiUrl('/api/generate')
    const prompt = [
      'Aşağıdaki metni Türkçe olarak 5 maddede özetle.',
      'Sonuna 2 kısa başlık önerisi ve 3 etiket ekle.',
      'Kısa ama gerçek bir yanıt üret; sadece OK yazma.',
      '',
      benchmarkCorpus
    ].join('\n')
    const payload = JSON.stringify({
      model,
      prompt,
      stream: true,
      options: {
        num_predict: 180,
        temperature: 0.2,
        top_p: 0.85
      }
    })
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    let output = ''
    let buffer = ''
    let firstTokenMs: number | undefined
    let finalStats: Partial<OllamaGenerateResult> = {}
    let heartbeat: ReturnType<typeof setInterval> | undefined

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (heartbeat) clearInterval(heartbeat)
      activeHttpJobs.delete(job.id)
      fn()
    }

    const emitBenchmarkProgress = () => {
      const elapsedMs = Date.now() - startedAt
      const ratio = Math.min(0.96, elapsedMs / timeoutMs)
      updateJob(job, {
        percent: Math.min(92, Math.round(38 + (54 * ratio))),
        message: `Gerçek hız testi çalışıyor... ${Math.round(elapsedMs / 1000)} sn · ${output.length} karakter`,
        runtime: {
          label: 'Ollama gerçek hız testi',
          startedAt,
          updatedAt: Date.now(),
          elapsedMs,
          outputChars: output.length,
          tokens: finalStats.evalCount,
          tokensPerSecond: tokensPerSecond(finalStats.evalCount, finalStats.evalDurationMs),
          note: firstTokenMs != null ? `İlk token: ${formatMainDuration(firstTokenMs)}` : 'İlk token bekleniyor.'
        }
      })
    }

    heartbeat = setInterval(emitBenchmarkProgress, 1_000)
    heartbeat.unref?.()

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.error === 'string' && parsed.error) {
        throw new Error(`Ollama API hatası: ${parsed.error}`)
      }
      if (typeof parsed.response === 'string' && parsed.response) {
        if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt
        output += parsed.response
      }
      if (parsed.done === true) {
        finalStats = {
          response: output.trim(),
          outputChars: output.trim().length,
          firstTokenMs,
          totalDurationMs: fromOllamaNanos(parsed.total_duration),
          loadDurationMs: fromOllamaNanos(parsed.load_duration),
          promptEvalCount: typeof parsed.prompt_eval_count === 'number' ? parsed.prompt_eval_count : undefined,
          promptEvalDurationMs: fromOllamaNanos(parsed.prompt_eval_duration),
          evalCount: typeof parsed.eval_count === 'number' ? parsed.eval_count : undefined,
          evalDurationMs: fromOllamaNanos(parsed.eval_duration)
        }
      }
    }

    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res) => {
      res.setEncoding('utf8')
      if ((res.statusCode ?? 500) >= 400) {
        let errorBody = ''
        res.on('data', (chunk: string) => { errorBody = appendTail(errorBody, chunk, 2_000) })
        res.on('end', () => finish(() => reject(new Error(`Ollama API hata döndürdü (${res.statusCode ?? '-'}): ${sanitizeTerminalText(errorBody).trim()}`))))
        return
      }
      res.on('data', (chunk: string) => {
        if (cancelledJobs.has(job.id)) {
          req.destroy(new Error('__AI_CANCELLED__'))
          return
        }
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        try {
          for (const line of lines) handleLine(line)
          emitBenchmarkProgress()
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('end', () => {
        try {
          if (buffer.trim()) handleLine(buffer)
          finish(() => resolve({
            response: (finalStats.response || output).trim(),
            outputChars: finalStats.outputChars ?? output.trim().length,
            firstTokenMs,
            totalDurationMs: finalStats.totalDurationMs,
            loadDurationMs: finalStats.loadDurationMs,
            promptEvalCount: finalStats.promptEvalCount,
            promptEvalDurationMs: finalStats.promptEvalDurationMs,
            evalCount: finalStats.evalCount,
            evalDurationMs: finalStats.evalDurationMs
          }))
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    })

    activeHttpJobs.set(job.id, req)
    req.on('timeout', () => req.destroy(new Error(`OLLAMA_BENCHMARK_TIMEOUT:${timeoutMs}`)))
    req.on('error', (err: Error) => finish(() => reject(err)))
    req.write(payload)
    req.end()
    emitBenchmarkProgress()
  })
}

function runOllamaStreamJob(job: AiJob, prompt: string, message: string, model = ollamaModel): Promise<OllamaGenerateResult> {
  return new Promise((resolve, reject) => {
    if (cancelledJobs.has(job.id)) {
      reject(new Error('__AI_CANCELLED__'))
      return
    }

    const startedAt = Date.now()
    const url = ollamaApiUrl('/api/generate')
    const payload = JSON.stringify({
      model,
      prompt,
      stream: true,
      options: {
        temperature: 0.2,
        top_p: 0.9
      }
    })
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    let output = ''
    let buffer = ''
    let outputChunks = 0
    let lastUiAt = 0
    let finalStats: Partial<OllamaGenerateResult> = {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const timeoutMs = 10 * 60_000

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (heartbeat) clearInterval(heartbeat)
      activeHttpJobs.delete(job.id)
      fn()
    }

    const emitRuntime = (force = false) => {
      const now = Date.now()
      if (!force && now - lastUiAt < 1_000) return
      lastUiAt = now
      const elapsedMs = now - startedAt
      const tokens = finalStats.evalCount ?? outputChunks
      const tokensPerSecond = elapsedMs > 0 && tokens ? tokens / (elapsedMs / 1000) : undefined
      updateJob(job, {
        percent: null,
        message: `${message} ${Math.round(elapsedMs / 1000)} sn · çıktı alınıyor`,
        runtime: {
          label: message.replace(/\.+$/, ''),
          startedAt,
          updatedAt: now,
          elapsedMs,
          outputChars: output.length,
          outputChunks,
          tokens,
          tokensPerSecond,
          note: output.length < 20
            ? 'Model düşünüyor; ilk uzun yanıtta bu bekleme normal olabilir.'
            : 'Yanıt üretiliyor; uzun transcriptlerde süre CPU hızına göre artar.'
        }
      })
    }
    heartbeat = setInterval(() => emitRuntime(), 1_000)
    heartbeat.unref?.()

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.error === 'string' && parsed.error) {
        throw new Error(`Ollama API hatası: ${parsed.error}`)
      }
      if (typeof parsed.response === 'string' && parsed.response) {
        output += parsed.response
        outputChunks += 1
        emitRuntime()
      }
      if (parsed.done === true) {
        finalStats = {
          response: output.trim(),
          totalDurationMs: fromOllamaNanos(parsed.total_duration),
          loadDurationMs: fromOllamaNanos(parsed.load_duration),
          promptEvalCount: typeof parsed.prompt_eval_count === 'number' ? parsed.prompt_eval_count : undefined,
          promptEvalDurationMs: fromOllamaNanos(parsed.prompt_eval_duration),
          evalCount: typeof parsed.eval_count === 'number' ? parsed.eval_count : undefined,
          evalDurationMs: fromOllamaNanos(parsed.eval_duration)
        }
      }
    }

    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res) => {
      res.setEncoding('utf8')
      if ((res.statusCode ?? 500) >= 400) {
        let errorBody = ''
        res.on('data', (chunk: string) => { errorBody = appendTail(errorBody, chunk, 2_000) })
        res.on('end', () => finish(() => reject(new Error(`Ollama API hata döndürdü (${res.statusCode ?? '-'}): ${sanitizeTerminalText(errorBody).trim()}`))))
        return
      }
      res.on('data', (chunk: string) => {
        if (cancelledJobs.has(job.id)) {
          req.destroy(new Error('__AI_CANCELLED__'))
          return
        }
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        try {
          for (const line of lines) handleLine(line)
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('end', () => {
        try {
          if (buffer.trim()) handleLine(buffer)
          emitRuntime(true)
          finish(() => resolve({
            response: (finalStats.response || output).trim(),
            totalDurationMs: finalStats.totalDurationMs,
            loadDurationMs: finalStats.loadDurationMs,
            promptEvalCount: finalStats.promptEvalCount,
            promptEvalDurationMs: finalStats.promptEvalDurationMs,
            evalCount: finalStats.evalCount,
            evalDurationMs: finalStats.evalDurationMs
          }))
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    })

    activeHttpJobs.set(job.id, req)
    req.on('timeout', () => {
      req.destroy(new Error(`OLLAMA_GENERATE_TIMEOUT:${timeoutMs}`))
    })
    req.on('error', (err: Error) => {
      finish(() => reject(err))
    })
    req.write(payload)
    req.end()
    emitRuntime(true)
  })
}

function ollamaBenchmarkDetail(result: OllamaGenerateResult): string {
  const evalSpeed = tokensPerSecond(result.evalCount, result.evalDurationMs)
  const parts = [
    result.response ? `Yanıt: ${result.response}` : 'Yanıt alındı',
    result.firstTokenMs != null ? `İlk token: ${formatMainDuration(result.firstTokenMs)}` : '',
    result.totalDurationMs != null ? `API toplam: ${formatMainDuration(result.totalDurationMs)}` : '',
    result.loadDurationMs != null ? `Model yükleme: ${formatMainDuration(result.loadDurationMs)}` : '',
    result.evalCount != null && result.evalDurationMs != null
      ? `Üretim: ${result.evalCount} token / ${formatMainDuration(result.evalDurationMs)}${evalSpeed ? ` (${evalSpeed.toFixed(1)} token/sn)` : ''}`
      : ''
  ].filter(Boolean)
  return parts.join(' · ')
}

function ollamaBenchmarkStats(result: OllamaGenerateResult, elapsedMs: number, timeoutMs: number, rating: string): AiBenchmarkStats {
  const loadMs = result.loadDurationMs ?? 0
  const warm = loadMs < 2_000
  const evalTokensPerSecond = tokensPerSecond(result.evalCount, result.evalDurationMs)
  const promptTokensPerSecond = tokensPerSecond(result.promptEvalCount, result.promptEvalDurationMs)
  return {
    model: ollamaModel,
    mode: 'Gerçek Türkçe özet üretimi',
    elapsedMs,
    rating,
    response: result.response,
    outputChars: result.outputChars ?? result.response.length,
    firstTokenMs: result.firstTokenMs,
    evalTokensPerSecond,
    promptTokensPerSecond,
    totalDurationMs: result.totalDurationMs,
    loadDurationMs: result.loadDurationMs,
    promptEvalCount: result.promptEvalCount,
    promptEvalDurationMs: result.promptEvalDurationMs,
    evalCount: result.evalCount,
    evalDurationMs: result.evalDurationMs,
    timeoutMs,
    note: warm
      ? 'Model RAM’de sıcak görünüyor; token/sn değeri günlük özet ve başlık işlerinin gerçek hızına daha yakın.'
      : 'Model yükleme süresi yüksek; ilk çalıştırma soğuk başlangıç etkisi içeriyor, token/sn değerini ayrıca değerlendirin.'
  }
}

function formatMainDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} sn`
}

type JobCommandProgressHandler = (patch: Partial<AiJob>, line: string, currentJob: AiJob) => Partial<AiJob> | void

function runJobCommand(
  job: AiJob,
  bin: string,
  args: string[],
  message: string,
  stdin?: string,
  onProgress?: JobCommandProgressHandler,
  timeoutMs?: number
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let currentJob = updateJob(job, { message })
    let lastOutputUpdateAt = 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    let proc: ReturnType<typeof spawn>

    const done = (result: CommandResult) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      activeJobs.delete(job.id)
      resolve(result)
    }

    if (cancelledJobs.delete(job.id)) {
      done({ code: null, stdout, stderr, cancelled: true })
      return
    }

    try {
      proc = spawn(bin, args, { env: childEnv() })
    } catch (err) {
      done({ code: -1, stdout, stderr, cancelled: false, error: err instanceof Error ? err : new Error(String(err)) })
      return
    }

    activeJobs.set(job.id, proc)
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        stderr = appendTail(stderr, `\nKomut zaman aşımına uğradı (${Math.round(timeoutMs / 1000)} sn).\n`)
        currentJob = updateJob(currentJob, {
          message: `${message} Zaman aşımı; işlem durduruluyor...`
        })
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => {
          if (!settled) {
            try { proc.kill('SIGKILL') } catch { /* ignore */ }
          }
        }, 2_000)
      }, timeoutMs)
    }
    logAiActivity(job, 'AI komutu başlatıldı.', {
      command: bin,
      args: redactArgs(args),
      message,
      timeoutMs
    }).catch(() => {})

    const onOutput = (chunk: string) => {
      const line = lastUsefulLine(chunk)
      const downloadPatch = downloadPatchFromChunk(chunk, currentJob.download)
      if ((line || Object.keys(downloadPatch).length > 0) && !pausedJobs.has(job.id)) {
        const basePatch: Partial<AiJob> = {
          ...(line ? { message: `${message} ${line}` } : {}),
          ...downloadPatch
        }
        const extraPatch = onProgress?.(basePatch, line, currentJob) ?? {}
        const nextPatch = { ...basePatch, ...extraPatch }
        const now = Date.now()
        const progressOnly = Boolean(nextPatch.download || nextPatch.install || nextPatch.percent != null)
        if (!progressOnly || now - lastOutputUpdateAt >= 300) {
          lastOutputUpdateAt = now
          currentJob = updateJob(currentJob, nextPatch)
        } else {
          currentJob = { ...currentJob, ...nextPatch, updatedAt: now }
          if (currentJob.status === 'running' || currentJob.status === 'paused') runningJobs.set(currentJob.id, currentJob)
        }
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout = appendTail(stdout, text)
      onOutput(text)
    })
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr = appendTail(stderr, text)
      onOutput(text)
    })
    proc.on('close', (code) => {
      const cancelled = cancelledJobs.delete(job.id)
      if (!settled && (currentJob.status === 'running' || currentJob.status === 'paused')) emitProgress(currentJob)
      logAiActivity(job, 'AI komutu bitti.', {
        command: bin,
        args: redactArgs(args),
        code,
        cancelled,
        timedOut,
        stdoutTail: lastUsefulLine(stdout),
        stderrTail: lastUsefulLine(stderr)
      }).catch(() => {})
      done({
        code: timedOut ? -1 : code,
        stdout,
        stderr,
        cancelled,
        error: timedOut ? new Error('timeout') : undefined
      })
    })
    proc.on('error', (err: Error) => {
      const cancelled = cancelledJobs.delete(job.id)
      logError({
        errorType: 'general',
        errorMessage: `AI komutu başlatılamadı: ${err.message}`,
        operation: `ai-command-${job.kind}`,
        stackTrace: err.stack,
        details: {
          jobId: job.id,
          toolId: job.toolId,
          command: bin,
          args: redactArgs(args)
        }
      }).catch(() => {})
      done({ code: -1, stdout, stderr, cancelled, error: err })
    })
    if (stdin) proc.stdin?.end(stdin)
  })
}

function assertCommand(result: CommandResult, fallback: string): void {
  if (result.cancelled) throw new Error('__AI_CANCELLED__')
  if (result.code === 0 && !result.error) return
  const detail = lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout) || result.error?.message || ''
  throw new Error(detail ? `${fallback} (${detail})` : fallback)
}

function downloadPatchFromChunk(chunk: string, previous?: AiDownloadProgress): Partial<AiJob> {
  const clean = sanitizeTerminalText(chunk)
    .replace(/[━╸╺─│┃▏▎▍▌▋▊▉█]+/g, ' ')
  const lines = clean
    .split(/\n+/)
    .map(line => line.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)

  let currentDownload = previous
  let currentPatch: Partial<AiJob> = {}
  for (const line of lines) {
    const patch = downloadPatchFromLine(line, currentDownload)
    if (patch.download) currentDownload = patch.download
    currentPatch = { ...currentPatch, ...patch }
  }
  return currentPatch
}

function downloadPatchFromLine(line: string, previous?: AiDownloadProgress): Partial<AiJob> {
  const text = sanitizeTerminalText(line)
    .replace(/[━╸╺─│┃▏▎▍▌▋▊▉█]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const now = Date.now()

  const curl = parseCurlProgressLine(text)
  if (curl) {
    return {
      percent: curl.percent,
      download: {
        ...previous,
        transferredBytes: curl.transferredBytes,
        totalBytes: curl.totalBytes,
        bytesPerSecond: curl.bytesPerSecond,
        etaSeconds: curl.etaSeconds,
        updatedAt: now
      }
    }
  }

  const ollama = text.match(/(?:pulling\s+\S+:\s*)?(\d{1,3})%\s+([\d.]+\s*[KMGT]?i?B)\/([\d.]+\s*[KMGT]?i?B)\s+([\d.]+\s*[KMGT]?i?B\/s)\s+(\S+)/i)
  if (ollama) {
    const transferredBytes = parseBytes(ollama[2])
    const totalBytes = parseBytes(ollama[3])
    const bytesPerSecond = parseBytesPerSecond(ollama[4])
    const etaSeconds = parseEta(ollama[5])
    return {
      percent: clampPercent(Number(ollama[1])),
      download: {
        ...previous,
        transferredBytes,
        totalBytes,
        bytesPerSecond,
        etaSeconds,
        label: previous?.label,
        updatedAt: now
      }
    }
  }

  const rich = text.match(/([\d.]+)\s*([KMGT]?i?B|[KMGT]?B)?\s*\/\s*([\d.]+)\s*([KMGT]?i?B|[KMGT]?B)\s+([\d.]+\s*[KMGT]?i?B\/s)(?:\s+eta)?\s+(\d+(?::\d{2}){1,2}|(?:(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?))/i)
  if (rich) {
    const transferredBytes = parseBytes(`${rich[1]} ${rich[2] || rich[4]}`)
    const totalBytes = parseBytes(`${rich[3]} ${rich[4]}`)
    const bytesPerSecond = parseBytesPerSecond(rich[5])
    const etaSeconds = parseEta(rich[6])
    const percent = transferredBytes != null && totalBytes ? clampPercent((transferredBytes / totalBytes) * 100) : undefined
    return {
      percent,
      download: {
        ...previous,
        transferredBytes,
        totalBytes,
        bytesPerSecond,
        etaSeconds,
        updatedAt: now
      }
    }
  }

  const downloading = text.match(/Downloading\s+(.+?)\s+\(([\d.]+\s*[KMGT]?i?B)\)/i)
  if (downloading) {
    return {
      download: {
        ...previous,
        label: downloading[1].slice(0, 90),
        totalBytes: parseBytes(downloading[2]) ?? previous?.totalBytes,
        updatedAt: now
      }
    }
  }

  return {}
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseBytes(value: string): number | undefined {
  const match = value.trim().match(/^([\d.]+)\s*([KMGT]?i?B|[KMGT]?B)$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2].toLowerCase()
  const base = unit.includes('i') ? 1024 : 1000
  const power =
    unit.startsWith('t') ? 4 :
    unit.startsWith('g') ? 3 :
    unit.startsWith('m') ? 2 :
    unit.startsWith('k') ? 1 :
    0
  return Math.round(amount * Math.pow(base, power))
}

function parseBytesPerSecond(value: string): number | undefined {
  return parseBytes(value.replace(/\/s$/i, ''))
}

function parseCurlProgressLine(text: string): { percent?: number; transferredBytes?: number; totalBytes?: number; bytesPerSecond?: number; etaSeconds?: number } | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 12 || !/^\d{1,3}$/.test(parts[0]) || !/^\d{1,3}$/.test(parts[2])) return null
  const totalBytes = parseCurlSize(parts[1])
  const transferredBytes = parseCurlSize(parts[3])
  const bytesPerSecond = parseCurlSize(parts[11])
  return {
    percent: clampPercent(Number(parts[2])),
    transferredBytes,
    totalBytes,
    bytesPerSecond,
    etaSeconds: parseEta(parts[10])
  }
}

function parseCurlSize(value: string): number | undefined {
  const match = value.trim().match(/^([\d.]+)([kKmMgGtT]?)$/)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2].toLowerCase()
  const power =
    unit === 't' ? 4 :
    unit === 'g' ? 3 :
    unit === 'm' ? 2 :
    unit === 'k' ? 1 :
    0
  return Math.round(amount * Math.pow(1024, power))
}

function parseEta(value: string): number | undefined {
  const clean = value.trim().toLowerCase()
  const combined = clean.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (combined && combined.slice(1).some(Boolean)) {
    return Number(combined[1] ?? 0) * 86400 +
      Number(combined[2] ?? 0) * 3600 +
      Number(combined[3] ?? 0) * 60 +
      Number(combined[4] ?? 0)
  }
  const unit = clean.match(/^(\d+)\s*([smhd])$/)
  if (unit) {
    const amount = Number(unit[1])
    if (unit[2] === 'd') return amount * 86400
    if (unit[2] === 'h') return amount * 3600
    if (unit[2] === 'm') return amount * 60
    return amount
  }
  const parts = clean.split(':').map(part => Number(part))
  if (parts.some(part => !Number.isFinite(part))) return undefined
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return undefined
}

function commandFailureSummary(result: CommandResult): string {
  return lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout) || result.error?.message || `exit ${result.code ?? 'unknown'}`
}

async function hasPythonPip(py: PythonRuntime): Promise<boolean> {
  const result = await runSimple(py.bin, [...py.prefix, '-m', 'pip', '--version'])
  return result.code === 0
}

function pipLocalInstallArgs(py: PythonRuntime, packages: string[]): string[] {
  return [
    ...py.prefix,
    '-m',
    'pip',
    'install',
    '--no-index',
    '--find-links',
    pythonWheelhouseDir(),
    '--disable-pip-version-check',
    ...(py.inVenv ? [] : ['--user']),
    '-U',
    ...packages
  ]
}

function pipReportArgs(py: PythonRuntime, packages: string[], reportPath: string): string[] {
  return [
    ...py.prefix,
    '-m',
    'pip',
    'install',
    '--dry-run',
    '--ignore-installed',
    '--report',
    reportPath,
    '--disable-pip-version-check',
    '--progress-bar',
    'off',
    ...packages
  ]
}

function createInstallTracker(job: AiJob, wheels: PipDownloadEntry[]): Partial<AiJob> {
  const now = Date.now()
  const items = new Map<string, InstallTrackerItem>()
  for (const entry of wheels) {
    const fileSize = existingFileSize(entry.filePath)
    items.set(entry.url, {
      label: entry.label,
      state: fileSize ? 'cached' : 'queued',
      transferredBytes: fileSize,
      totalBytes: fileSize,
      updatedAt: now
    })
  }
  const tracker: InstallTracker = {
    jobId: job.id,
    stage: 'planning',
    startedAt: now,
    items
  }
  installTrackers.set(job.id, tracker)
  return installTrackerPatch(tracker)
}

function setInstallStage(job: AiJob, stage: AiInstallStage): Partial<AiJob> {
  const tracker = installTrackers.get(job.id)
  if (!tracker) return {}
  tracker.stage = stage
  return installTrackerPatch(tracker)
}

function updateInstallItem(job: AiJob, entry: PipDownloadEntry, state: InstallItemState, download?: AiDownloadProgress): Partial<AiJob> {
  const tracker = installTrackers.get(job.id)
  if (!tracker) return {}
  const previous = tracker.items.get(entry.url)
  const fileSize = state === 'cached' || state === 'done' ? existingFileSize(entry.filePath) : undefined
  const totalBytes = fileSize ?? download?.totalBytes ?? previous?.totalBytes
  const transferredBytes = fileSize ?? download?.transferredBytes ?? previous?.transferredBytes
  tracker.items.set(entry.url, {
    label: entry.label,
    state,
    transferredBytes,
    totalBytes,
    bytesPerSecond: state === 'downloading' ? download?.bytesPerSecond ?? previous?.bytesPerSecond : undefined,
    updatedAt: Date.now()
  })
  return installTrackerPatch(tracker)
}

function installTrackerPatch(tracker: InstallTracker): Partial<AiJob> {
  const items = Array.from(tracker.items.values())
  const now = Date.now()
  let completedItems = 0
  let cachedItems = 0
  let activeItems = 0
  let queuedItems = 0
  let waitingItems = 0
  let knownBytesItems = 0
  let transferredBytes = 0
  let totalBytes = 0
  let bytesPerSecond = 0
  let weightedItems = 0
  for (const item of items) {
    const complete = item.state === 'done' || item.state === 'cached'
    if (complete) completedItems += 1
    if (item.state === 'cached') cachedItems += 1
    if (item.state === 'downloading' || item.state === 'waiting') activeItems += 1
    if (item.state === 'queued') queuedItems += 1
    if (item.state === 'waiting') waitingItems += 1

    if (item.totalBytes != null && item.totalBytes > 0) {
      knownBytesItems += 1
      totalBytes += item.totalBytes
      const transferred = complete ? item.totalBytes : Math.min(item.transferredBytes ?? 0, item.totalBytes)
      transferredBytes += transferred
      weightedItems += complete ? 1 : Math.max(0, Math.min(0.98, transferred / item.totalBytes))
    } else if (complete) {
      weightedItems += 1
    }

    if (item.state === 'downloading' && item.bytesPerSecond != null) bytesPerSecond += item.bytesPerSecond
  }

  const totalItems = items.length
  const allBytesKnown = totalItems > 0 && knownBytesItems === totalItems
  const itemFraction = totalItems > 0 ? weightedItems / totalItems : 0
  const byteFraction = allBytesKnown && totalBytes > 0 ? transferredBytes / totalBytes : itemFraction
  const rawPercent = tracker.stage === 'done' ? 100 : byteFraction * 100
  const percent = tracker.stage === 'done' || completedItems === totalItems
    ? 100
    : Math.min(99, clampPercent(rawPercent))
  const elapsedSeconds = Math.max(1, (now - tracker.startedAt) / 1000)
  const remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - transferredBytes) : undefined
  const etaSeconds = bytesPerSecond > 0 && allBytesKnown && remainingBytes != null
    ? Math.round(remainingBytes / bytesPerSecond)
    : itemFraction > 0.01
      ? Math.round((elapsedSeconds / itemFraction) - elapsedSeconds)
      : undefined
  const currentLabel =
    items.find(item => item.state === 'downloading')?.label ??
    items.find(item => item.state === 'waiting')?.label ??
    items.find(item => item.state === 'queued')?.label

  return {
    percent,
    install: {
      stage: tracker.stage,
      startedAt: tracker.startedAt,
      updatedAt: now,
      completedItems,
      totalItems,
      cachedItems,
      activeItems,
      queuedItems,
      waitingItems,
      knownBytesItems,
      percent,
      transferredBytes: totalBytes > 0 ? transferredBytes : undefined,
      totalBytes: totalBytes > 0 ? totalBytes : undefined,
      remainingBytes,
      bytesPerSecond: bytesPerSecond > 0 ? bytesPerSecond : undefined,
      etaSeconds,
      currentLabel
    }
  }
}

function existingFileSize(path: string): number | undefined {
  try {
    if (!existsSync(path)) return undefined
    const size = statSync(path).size
    return size > 0 ? size : undefined
  } catch {
    return undefined
  }
}

async function runSharedPythonPackageInstall(job: AiJob, py: PythonRuntime, packages: string[], message: string): Promise<CommandResult> {
  mkdirSync(pythonWheelhouseDir(), { recursive: true })
  const reportPath = join(aiDataDir(), `pip-report-${job.id}.json`)
  try {
    const report = await runJobCommand(job, py.bin, pipReportArgs(py, packages, reportPath), `${message} Bağımlılıklar çözümleniyor...`)
    assertCommand(report, 'Python paket indirme planı çıkarılamadı.')

    const wheels = readPipReportDownloads(reportPath)
    if (wheels.length > 0) {
      updateJob(job, {
        message: `${message} ${wheels.length} paket kontrol ediliyor; aynı dosyalar tek kez indirilecek...`,
        ...createInstallTracker(job, wheels)
      })
      updateJob(job, { message: `${message} Paketler indiriliyor veya cache üzerinden hazırlanıyor...`, ...setInstallStage(job, 'downloading') })
      await mapLimit(wheels, 4, entry => downloadWheelWithLock(job, entry))
      updateJob(job, { message: `${message} Paketler hazır; local kurulum başlıyor...`, ...setInstallStage(job, 'installing') })
    }

    const localInstall = await runJobCommand(job, py.bin, pipLocalInstallArgs(py, packages), `${message} Local cache üzerinden kuruluyor...`)
    if (localInstall.code === 0 && !localInstall.cancelled) {
      updateJob(job, { message: `${message} Local kurulum tamamlandı.`, ...setInstallStage(job, 'done') })
    }
    return localInstall
  } finally {
    installTrackers.delete(job.id)
    try {
      if (existsSync(reportPath)) unlinkSync(reportPath)
    } catch { /* ignore */ }
  }
}

interface PipDownloadEntry {
  url: string
  label: string
  filePath: string
}

function readPipReportDownloads(reportPath: string): PipDownloadEntry[] {
  const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    install?: Array<{
      download_info?: { url?: string }
      metadata?: { name?: string; version?: string }
    }>
  }
  const byUrl = new Map<string, PipDownloadEntry>()
  for (const item of raw.install ?? []) {
    const url = item.download_info?.url
    if (!url || !/^https?:\/\//i.test(url)) continue
    const fileName = safeWheelFileName(url)
    const label = [item.metadata?.name, item.metadata?.version].filter(Boolean).join('-') || fileName
    byUrl.set(url, { url, label, filePath: join(pythonWheelhouseDir(), fileName) })
  }
  return Array.from(byUrl.values())
}

function safeWheelFileName(url: string): string {
  try {
    const parsed = new URL(url)
    const name = decodeURIComponent(basename(parsed.pathname))
    return name.replace(/[^a-zA-Z0-9._+-]/g, '_') || `package-${randomUUID()}.whl`
  } catch {
    return `package-${randomUUID()}.whl`
  }
}

async function downloadWheelWithLock(job: AiJob, entry: PipDownloadEntry): Promise<string> {
  const cachedSize = existingFileSize(entry.filePath)
  if (cachedSize) {
    updateJob(job, {
      message: `${entry.label} cache'te hazır; tekrar indirilmeyecek.`,
      download: {
        label: entry.label,
        transferredBytes: cachedSize,
        totalBytes: cachedSize,
        updatedAt: Date.now()
      },
      ...updateInstallItem(job, entry, 'cached')
    })
    return entry.filePath
  }

  const existing = activeWheelDownloads.get(entry.url)
  if (existing) {
    updateJob(job, {
      message: `${entry.label} başka bir AI işi tarafından indiriliyor; aynı dosya tekrar indirilmeyecek, bitmesi bekleniyor...`,
      download: {
        label: entry.label,
        totalBytes: undefined,
        updatedAt: Date.now()
      },
      ...updateInstallItem(job, entry, 'waiting')
    })
    const filePath = await existing
    updateJob(job, {
      message: `${entry.label} ortak indirme tamamlandı; dosya cache'ten kullanılacak.`,
      ...updateInstallItem(job, entry, 'done')
    })
    return filePath
  }

  const promise = downloadWheel(job, entry).finally(() => {
    activeWheelDownloads.delete(entry.url)
  })
  activeWheelDownloads.set(entry.url, promise)
  return promise
}

async function downloadWheel(job: AiJob, entry: PipDownloadEntry): Promise<string> {
  const tmpPath = `${entry.filePath}.part-${job.id}`
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  } catch { /* ignore */ }

  updateJob(job, {
    message: `${entry.label} indiriliyor...`,
    download: { label: entry.label, updatedAt: Date.now() },
    ...updateInstallItem(job, entry, 'downloading')
  })
  const result = await runJobCommand(
    job,
    'curl',
    ['-L', '--fail', '--show-error', '-o', tmpPath, entry.url],
    `${entry.label} indiriliyor...`,
    undefined,
    patch => updateInstallItem(job, entry, 'downloading', patch.download)
  )
  assertCommand(result, `${entry.label} indirilemedi.`)
  if (!isUsableFile(tmpPath)) throw new Error(`${entry.label} indirildi ama dosya boş görünüyor.`)
  renameSync(tmpPath, entry.filePath)
  const size = existingFileSize(entry.filePath)
  updateJob(job, {
    message: `${entry.label} indirildi; cache'e alındı.`,
    download: {
      label: entry.label,
      transferredBytes: size,
      totalBytes: size,
      etaSeconds: 0,
      updatedAt: Date.now()
    },
    ...updateInstallItem(job, entry, 'done')
  })
  return entry.filePath
}

function isUsableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<unknown>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const item = items[index]
      index += 1
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(workers)
}

async function ensureLocalPythonEnv(job: AiJob, errors: string[]): Promise<PythonRuntime | null> {
  const localPy: PythonRuntime = { bin: pythonEnvBin(), prefix: [], inVenv: true }
  if (existsSync(localPy.bin)) {
    if (await hasPythonPip(localPy)) return localPy
    const ensure = await runJobCommand(job, localPy.bin, ['-m', 'ensurepip', '--upgrade'], 'Local Python pip onarılıyor...')
    if (ensure.cancelled) throw new Error('__AI_CANCELLED__')
    if (ensure.code !== 0) errors.push(`local ensurepip: ${commandFailureSummary(ensure)}`)
    if (await hasPythonPip(localPy)) return localPy
    if (await bootstrapPipWithGetPip(job, localPy, errors) && await hasPythonPip(localPy)) return localPy
    rmSync(pythonEnvDir(), { recursive: true, force: true })
    return null
  }

  mkdirSync(aiDataDir(), { recursive: true })
  const base = basePythonCommand()
  const created = await runJobCommand(job, base.bin, [...base.prefix, '-m', 'venv', pythonEnvDir()], 'Local Python ortamı hazırlanıyor...')
  if (created.cancelled) throw new Error('__AI_CANCELLED__')
  if (created.code !== 0 || !existsSync(localPy.bin)) {
    errors.push(`venv: ${commandFailureSummary(created)}`)
    rmSync(pythonEnvDir(), { recursive: true, force: true })
    return null
  }

  if (await hasPythonPip(localPy)) return localPy
  const ensure = await runJobCommand(job, localPy.bin, ['-m', 'ensurepip', '--upgrade'], 'Local Python pip hazırlanıyor...')
  if (ensure.cancelled) throw new Error('__AI_CANCELLED__')
  if (ensure.code !== 0) errors.push(`local ensurepip: ${commandFailureSummary(ensure)}`)
  if (await hasPythonPip(localPy)) return localPy
  if (await bootstrapPipWithGetPip(job, localPy, errors) && await hasPythonPip(localPy)) return localPy
  rmSync(pythonEnvDir(), { recursive: true, force: true })
  return null
}

async function bootstrapPipWithGetPip(job: AiJob, py: PythonRuntime, errors: string[]): Promise<boolean> {
  mkdirSync(aiDataDir(), { recursive: true })
  const getPipPath = join(aiDataDir(), 'get-pip.py')
  const download = await runJobCommand(
    job,
    py.bin,
    [...py.prefix, '-c', GET_PIP_DOWNLOAD_SCRIPT, getPipPath],
    'Python pip onarım dosyası indiriliyor...'
  )
  if (download.cancelled) throw new Error('__AI_CANCELLED__')
  if (download.code !== 0 || !existsSync(getPipPath)) {
    errors.push(`get-pip download: ${commandFailureSummary(download)}`)
    return false
  }

  const attempts = py.inVenv
    ? [[getPipPath]]
    : process.platform === 'win32'
      ? [[...py.prefix, getPipPath, '--user']]
      : [[...py.prefix, getPipPath, '--user'], [...py.prefix, getPipPath, '--user', '--break-system-packages']]

  for (const args of attempts) {
    const repair = await runJobCommand(job, py.bin, args, 'Python pip otomatik onarılıyor...')
    if (repair.cancelled) throw new Error('__AI_CANCELLED__')
    if (repair.code === 0 && await hasPythonPip(py)) return true
    errors.push(`get-pip: ${commandFailureSummary(repair)}`)
  }
  return false
}

async function ensurePythonPip(job: AiJob): Promise<PythonRuntime> {
  const preferred = pythonCommand()
  if (preferred.inVenv && await hasPythonPip(preferred)) return preferred

  const errors: string[] = []

  const local = await ensureLocalPythonEnv(job, errors)
  if (local && await hasPythonPip(local)) {
    logAiActivity(job, 'Local Python ortamı hazırlandı.', { python: local.bin }).catch(() => {})
    return local
  }

  let py = basePythonCommand()
  if (await hasPythonPip(py)) return py

  updateJob(job, { message: 'Python pip eksik; otomatik onarım deneniyor...' })
  logAiActivity(job, 'Python pip eksik; otomatik onarım başlatıldı.', { python: py.bin }).catch(() => {})

  const ensure = await runJobCommand(job, py.bin, [...py.prefix, '-m', 'ensurepip', '--upgrade'], 'Python pip ensurepip ile onarılıyor...')
  if (ensure.cancelled) throw new Error('__AI_CANCELLED__')
  if (ensure.code === 0 && await hasPythonPip(py)) return py
  errors.push(`ensurepip: ${commandFailureSummary(ensure)}`)

  if (await bootstrapPipWithGetPip(job, py, errors) && await hasPythonPip(py)) return py

  throw new Error(`Otomatik pip onarımı tamamlanamadı. ${errors.slice(-3).join(' | ')}`)
}

async function ensurePythonModule(job: AiJob, importCode: string, packages: string[], message: string, fallback: string): Promise<PythonRuntime> {
  const py = await ensurePythonPip(job)
  const check = await runSimple(py.bin, [...py.prefix, '-c', importCode])
  if (check.code === 0) return py

  updateJob(job, { message })
  logAiActivity(job, 'Python paketi eksik; otomatik kurulum deneniyor.', {
    packages,
    detail: commandFailureSummary(check)
  }).catch(() => {})
  const install = await runSharedPythonPackageInstall(job, py, packages, message)
  assertCommand(install, fallback)
  return py
}

function redactArgs(args: string[]): string[] {
  return args.map(arg => {
    if (/token|key|secret|password|authorization/i.test(arg)) return '[redacted]'
    return arg.length > 260 ? `${arg.slice(0, 260)}...` : arg
  })
}

function sidecarPath(inputPath: string, suffix: string, extension: string): string {
  const ext = extname(inputPath)
  const base = basename(inputPath, ext) || basename(inputPath)
  return join(dirname(inputPath), `${base}.${suffix}.${extension}`)
}

function textCandidates(inputPath: string): string[] {
  if (/\.(txt|md|srt|vtt)$/i.test(inputPath)) return [inputPath]
  const ext = extname(inputPath)
  const base = basename(inputPath, ext) || basename(inputPath)
  return [
    sidecarPath(inputPath, 'transcript', 'txt'),
    join(dirname(inputPath), `${base}.txt`),
    join(dirname(inputPath), `${base}.srt`),
    join(dirname(inputPath), `${base}.vtt`)
  ]
}

function readTextSource(inputPath: string): { path: string; text: string } {
  const found = textCandidates(inputPath).find(candidate => existsSync(candidate))
  if (!found) {
    throw new Error('Metin kaynağı bulunamadı. Önce bu dosya için transcript çıkarın.')
  }
  const text = readFileSync(found, 'utf8').trim()
  if (!text) throw new Error('Metin kaynağı boş. Transcript dosyasını kontrol edin.')
  return { path: found, text }
}

async function getAiToolsStatus(): Promise<AiToolStatus[]> {
  const [whisper, argos, ollama] = await Promise.all([
    diagnosePythonTool('whisper'),
    diagnosePythonTool('argos'),
    diagnoseOllamaTool()
  ])
  return [whisper, argos, ollama]
}

async function diagnosePythonTool(toolId: 'whisper' | 'argos'): Promise<AiToolStatus> {
  const importCode = toolId === 'whisper'
    ? 'import whisper; print(getattr(whisper, "__version__", "installed"))'
    : 'import argostranslate.translate; print("package-ok")'
  const label = toolId === 'whisper' ? 'Whisper' : 'Argos'
  const localPy: PythonRuntime = { bin: pythonEnvBin(), prefix: [], inVenv: true }
  const preferred = pythonCommand()
  const base = basePythonCommand()
  const localCheck = existsSync(localPy.bin)
    ? await runSimple(localPy.bin, ['-c', importCode], undefined, 8_000)
    : null
  const baseCheck = await runSimple(base.bin, [...base.prefix, '-c', importCode], undefined, 8_000)
  const preferredCheck = preferred.inVenv && localCheck
    ? localCheck
    : preferred.inVenv
      ? await runSimple(preferred.bin, [...preferred.prefix, '-c', importCode], undefined, 8_000)
      : baseCheck

  if (toolId === 'argos' && preferredCheck.code === 0) {
    const langCheck = await runSimple(preferred.bin, [...preferred.prefix, '-c', ARGOS_BENCHMARK_SCRIPT], undefined, 12_000)
    return {
      id: toolId,
      installed: langCheck.code === 0,
      detail: langCheck.code === 0
        ? `Hazır (${preferred.inVenv ? 'local Python' : 'sistem Python'})`
        : 'Python paketi var, EN->TR dil paketi eksik veya bozuk',
      version: lastUsefulLine(langCheck.stdout) || lastUsefulLine(preferredCheck.stdout)
    }
  }

  if (preferredCheck.code === 0) {
    return {
      id: toolId,
      installed: true,
      detail: `Hazır (${preferred.inVenv ? 'local Python' : 'sistem Python'})`,
      version: lastUsefulLine(preferredCheck.stdout)
    }
  }

  const hints = [
    localCheck ? `local: ${commandFailureSummary(localCheck) || 'paket yok'}` : 'local Python ortamı yok',
    `sistem: ${commandFailureSummary(baseCheck) || 'paket yok'}`
  ]
  return {
    id: toolId,
    installed: false,
    detail: `${label} kullanılamıyor. ${hints.join(' · ')}`,
    version: ''
  }
}

async function diagnoseOllamaTool(): Promise<AiToolStatus> {
  const ollamaBin = await detectOllamaCommand()
  const version = ollamaBin ? await runSimple(ollamaBin, ['--version'], undefined, 8_000) : null
  let models = ollamaBin ? await runSimple(ollamaBin, ['list'], undefined, 12_000) : null
  if (ollamaBin && version?.code === 0 && models?.code !== 0) {
    await ensureOllamaServerQuiet(ollamaBin).catch(() => {})
    models = await runSimple(ollamaBin, ['list'], undefined, 12_000)
  }
  const modelReady = !!models && models.code === 0 && hasOllamaModel(models.stdout, ollamaModel)
  const runtimeMissingDetail = isOllamaManagedInstallSupported()
    ? 'Ollama runtime bulunamadı'
    : ollamaManagedInstallUnsupportedMessage()
  return {
    id: 'ollama',
    installed: !!ollamaBin && version?.code === 0 && modelReady,
    detail: !ollamaBin || version?.code !== 0
      ? runtimeMissingDetail
      : models?.code !== 0
        ? 'Ollama çalışıyor ama model listesi okunamadı'
        : modelReady
          ? `${ollamaModel} modeli hazır`
          : `${ollamaModel} modeli eksik`,
    version: lastUsefulLine(version?.stdout ?? '') || lastUsefulLine(version?.stderr ?? '')
  }
}

function hasOllamaModel(output: string, model: string): boolean {
  const names = output
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean)
  return names.some(name => name === model || name === `${model}:latest`)
}

function modelInstalled(names: string[], model: string): boolean {
  return names.some(name => name === model || name === `${model}:latest`)
}

function ollamaChatModelLabel(model: AiChatModel, installed: boolean): string {
  const size = model.sizeHint ? ` · ${model.sizeHint}` : ''
  const status = installed ? ' · kurulu' : ' · kurulu değil'
  return `${model.label}${size}${status}`
}

function tokensPerSecond(count?: number, durationMs?: number): number | undefined {
  if (!count || !durationMs || durationMs <= 0) return undefined
  return count / (durationMs / 1000)
}

function readAiSystemSpecs(): AiSystemSpecs {
  mkdirSync(aiDataDir(), { recursive: true })
  const cpuList = cpus()
  const disk = statfsSync(aiDataDir())
  return {
    platform: osPlatform(),
    arch: osArch(),
    release: osRelease(),
    cpuModel: cpuList[0]?.model?.trim() || 'Bilinmiyor',
    cpuThreads: cpuList.length || 1,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    diskFreeBytes: disk.bavail * disk.bsize,
    diskTotalBytes: disk.blocks * disk.bsize
  }
}

function recommendOllamaModel(model: AiChatModel, specs: AiSystemSpecs, installed = model.installed): AiChatModel {
  const parsedWeightGb = parseFloat(model.sizeHint ?? '0')
  const weightGb = model.weightGb ?? (Number.isFinite(parsedWeightGb) && parsedWeightGb > 0 ? parsedWeightGb : 4)
  const ramGb = specs.totalMemoryBytes / gib
  const freeGb = specs.freeMemoryBytes / gib
  const fastRamNeeded = Math.max(16, weightGb * 2.6)
  const usableRamNeeded = Math.max(8, weightGb * 1.7)
  const fastFreeNeeded = Math.max(5, weightGb * 1.1)
  const cpuFast = specs.cpuThreads >= 12
  const cpuUsable = specs.cpuThreads >= 8

  if (installed) {
    return {
      ...model,
      recommendation: 'Kurulu',
      recommendationDetail: 'Bu model cihazda zaten var; direkt kullanılabilir.'
    }
  }

  if (ramGb >= fastRamNeeded && freeGb >= fastFreeNeeded && cpuFast) {
    return {
      ...model,
      recommendation: 'Bu cihaz için önerilir',
      recommendationDetail: `${formatSystemBytes(specs.totalMemoryBytes)} RAM ve ${specs.cpuThreads} thread ile bu model hızlı çalışmalı.`
    }
  }

  if (ramGb >= usableRamNeeded && freeGb >= Math.max(3, weightGb * 0.7) && cpuUsable) {
    return {
      ...model,
      recommendation: 'Çalışır, orta hız',
      recommendationDetail: 'Bu cihazda kullanılabilir; uzun yanıtlarda bekleme olabilir.'
    }
  }

  return {
    ...model,
    recommendation: 'Ağır kalabilir',
    recommendationDetail: 'İndirilebilir ama hızlı kullanım için daha küçük model daha doğru olur.'
  }
}

function getAiSystemReport(): AiSystemReport {
  const specs = readAiSystemSpecs()

  return {
    specs,
    tools: (Object.keys(aiRequirementProfiles) as AiToolId[]).map(toolId => buildRequirementReport(toolId, specs))
  }
}

function buildRequirementReport(toolId: AiToolId, specs: AiSystemSpecs): AiToolRequirementReport {
  const req = aiRequirementProfiles[toolId]
  const platformOk = req.supportedPlatforms.includes(process.platform)
  const checks: AiRequirementCheck[] = [
    {
      key: 'platform',
      label: 'Platform',
      ok: platformOk,
      actual: `${specs.platform} ${specs.arch}`,
      required: req.supportedPlatforms.map(formatPlatform).join(' / '),
      detail: platformOk ? undefined : 'Otomatik kurulum bu platformda henüz aktif değil.'
    },
    {
      key: 'cpu',
      label: 'CPU',
      ok: specs.cpuThreads >= req.cpuThreads,
      actual: `${specs.cpuThreads} thread`,
      required: `${req.cpuThreads}+ thread`
    },
    {
      key: 'memory',
      label: 'RAM',
      ok: specs.totalMemoryBytes >= req.totalMemoryBytes,
      actual: formatSystemBytes(specs.totalMemoryBytes),
      required: `${formatSystemBytes(req.totalMemoryBytes)}+`
    },
    {
      key: 'freeMemory',
      label: 'Boş RAM',
      ok: specs.freeMemoryBytes >= req.freeMemoryBytes,
      actual: formatSystemBytes(specs.freeMemoryBytes),
      required: `${formatSystemBytes(req.freeMemoryBytes)}+`,
      detail: 'Anlık değerdir; açık uygulamalar kapatılırsa değişebilir.'
    },
    {
      key: 'disk',
      label: 'Disk',
      ok: specs.diskFreeBytes >= req.diskFreeBytes,
      actual: formatSystemBytes(specs.diskFreeBytes),
      required: `${formatSystemBytes(req.diskFreeBytes)}+`
    }
  ]
  const failed = checks.filter(check => !check.ok).length
  return {
    toolId,
    label: toolLabels[toolId],
    summary: failed ? `${failed} öneri altında görünüyor.` : 'Önerilen kullanım için uygun görünüyor.',
    checks
  }
}

async function benchmarkAiTool(toolId: AiToolId): Promise<AiBenchmarkResult> {
  if (!['whisper', 'ollama', 'argos'].includes(toolId)) throw new Error('Bilinmeyen AI aracı.')
  const started = Date.now()
  const job = createJob({
    kind: 'benchmark',
    title: `${toolLabels[toolId]} yanıt testi`,
    message: 'Yanıt testi hazırlanıyor...',
    toolId
  })

  let result: CommandResult | null = null
  let message = `${toolLabels[toolId]} yanıt testi tamamlandı.`
  let detail: string | undefined
  let stats: AiBenchmarkStats | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    const status = (await getAiToolsStatus()).find(item => item.id === toolId)
    if (!status?.installed) throw new Error(`${toolLabels[toolId]} kurulu değil. Önce Kur / Hazırla çalıştırın.`)

    if (toolId === 'whisper') {
      const py = pythonCommand()
      const timeoutMs = 45_000
      updateJob(job, { percent: 25, message: 'Whisper import testi başlıyor...' })
      heartbeat = startBenchmarkHeartbeat(job, 25, 92, 'Whisper paketi yükleniyor', timeoutMs)
      result = await runJobCommand(
        job,
        py.bin,
        [...py.prefix, '-c', 'import time; print("Whisper paketi yükleniyor..."); import whisper; print("Whisper hazır"); time.sleep(0.2)'],
        'Whisper yanıt testi çalışıyor...',
        undefined,
        undefined,
        timeoutMs
      )
      message = 'Whisper paket hazırlık testi tamamlandı. Gerçek transcript süresi dosya uzunluğuna göre değişir.'
    } else if (toolId === 'argos') {
      const py = pythonCommand()
      const timeoutMs = 45_000
      updateJob(job, { percent: 25, message: 'Argos kısa çeviri testi başlıyor...' })
      heartbeat = startBenchmarkHeartbeat(job, 25, 92, 'Argos çeviri motoru test ediliyor', timeoutMs)
      result = await runJobCommand(job, py.bin, [...py.prefix, '-c', ARGOS_BENCHMARK_SCRIPT], 'Argos kısa çeviri testi çalışıyor...', undefined, undefined, timeoutMs)
      message = 'Argos kısa çeviri testi tamamlandı.'
    } else {
      updateJob(job, { percent: 15, message: 'Ollama komutu aranıyor...' })
      const ollamaBin = await detectOllamaCommand()
      if (!ollamaBin) throw new Error('Ollama komutu bulunamadı.')
      updateJob(job, { percent: 25, message: 'Ollama local server kontrol ediliyor...' })
      await ensureOllamaServer(job, ollamaBin)
      const list = await runSimple(ollamaBin, ['list'], undefined, 8_000)
      if (!hasOllamaModel(list.stdout, ollamaModel)) {
        throw new Error(`${ollamaModel} modeli kurulu değil. Ollama için "Kur / Hazırla" çalıştırın.`)
      }
      const timeoutMs = 180_000
      updateJob(job, { percent: 35, message: `${ollamaModel} gerçek hız testi başlıyor...` })
      const ollamaResult = await runOllamaBenchmark(job, ollamaModel, timeoutMs)
      const elapsedMs = Date.now() - started
      stats = ollamaBenchmarkStats(
        ollamaResult,
        elapsedMs,
        timeoutMs,
        benchmarkRating(elapsedMs, toolId, tokensPerSecond(ollamaResult.evalCount, ollamaResult.evalDurationMs))
      )
      detail = ollamaBenchmarkDetail(ollamaResult)
      result = {
        code: 0,
        stdout: ollamaResult.response || detail,
        stderr: '',
        cancelled: false
      }
      message = 'Ollama gerçek hız testi tamamlandı.'
    }
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat)
    return failBenchmark(job, toolId, started, err instanceof Error ? err.message : String(err))
  } finally {
    if (heartbeat) clearInterval(heartbeat)
  }

  const elapsedMs = Date.now() - started
  if (!result) {
    return failBenchmark(job, toolId, started, `${toolLabels[toolId]} benchmark sonucu alınamadı.`)
  }
  if (result.code !== 0 || result.error) {
    const error = commandFailureSummary(result) || `${toolLabels[toolId]} benchmark tamamlanamadı.`
    return failBenchmark(job, toolId, started, error)
  }

  const benchmark: AiBenchmarkResult = {
    toolId,
    ok: true,
    elapsedMs,
    rating: benchmarkRating(elapsedMs, toolId),
    message,
    jobId: job.id,
    detail: detail || lastUsefulLine(result.stdout) || lastUsefulLine(result.stderr),
    stats,
    createdAt: Date.now()
  }
  updateJob(job, {
    status: 'done',
    percent: 100,
    message: `${message} Süre: ${formatMainDuration(elapsedMs)} · ${benchmark.rating}.`,
    benchmark: stats ?? {
      elapsedMs,
      rating: benchmark.rating,
      mode: `${toolLabels[toolId]} hazırlık testi`,
      response: lastUsefulLine(result.stdout) || lastUsefulLine(result.stderr)
    }
  }, true)
  return benchmark
}

function failBenchmark(job: AiJob, toolId: AiToolId, started: number, error: string): AiBenchmarkResult {
  const elapsedMs = Date.now() - started
  const message = userFriendlyAiError(error, job)
  updateJob(job, {
    status: 'error',
    percent: 100,
    message: '',
    error: message
  }, true)
  const benchmark: AiBenchmarkResult = {
    toolId,
    ok: false,
    elapsedMs,
    rating: 'Başarısız',
    message,
    jobId: job.id,
    detail: error,
    createdAt: Date.now()
  }
  logError({
    errorType: 'general',
    errorMessage: message,
    operation: 'ai-benchmark',
    details: {
      subsystem: 'ai',
      jobId: job.id,
      kind: job.kind,
      toolId,
      title: job.title,
      elapsedMs,
      detail: error
    }
  }).catch(() => {})
  return benchmark
}

function startBenchmarkHeartbeat(job: AiJob, startPercent: number, maxPercent: number, label: string, timeoutMs: number): ReturnType<typeof setInterval> {
  const started = Date.now()
  return setInterval(() => {
    const elapsed = Date.now() - started
    const ratio = Math.min(0.96, elapsed / timeoutMs)
    const percent = Math.max(startPercent, Math.min(maxPercent, Math.round(startPercent + ((maxPercent - startPercent) * ratio))))
    updateJob(job, {
      percent,
      message: `${label}... ${Math.round(elapsed / 1000)}sn / ${Math.round(timeoutMs / 1000)}sn`
    })
  }, 1_000)
}

function benchmarkRating(elapsedMs: number, toolId: AiToolId, evalTokensPerSecond?: number): string {
  if (toolId === 'ollama' && evalTokensPerSecond != null) {
    if (evalTokensPerSecond >= 18) return 'Hızlı'
    if (evalTokensPerSecond >= 8) return 'Normal'
    return 'Yavaş'
  }
  const fast = toolId === 'ollama' ? 8_000 : 1_500
  const ok = toolId === 'ollama' ? 20_000 : 5_000
  if (elapsedMs <= fast) return 'Hızlı'
  if (elapsedMs <= ok) return 'Normal'
  return 'Yavaş'
}

function formatPlatform(value: NodeJS.Platform): string {
  if (value === 'linux') return 'Linux'
  if (value === 'win32') return 'Windows'
  if (value === 'darwin') return 'macOS'
  return value
}

function formatSystemBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const decimals = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${units[unit]}`
}

async function installTool(job: AiJob, toolId: AiToolId): Promise<void> {
  if (toolId === 'whisper') {
    const py = await ensurePythonPip(job)
    logAiActivity(job, 'Whisper kurulumu başlıyor.', { python: py.bin, localEnv: py.inVenv }).catch(() => {})
    const result = await runSharedPythonPackageInstall(job, py, ['openai-whisper'], 'Whisper paketi indiriliyor...')
    assertCommand(result, 'Whisper kurulumu tamamlanamadı.')
    updateJob(job, { status: 'done', message: 'Whisper hazır.', percent: 100 }, true)
    return
  }

  if (toolId === 'argos') {
    const py = await ensurePythonPip(job)
    logAiActivity(job, 'Argos kurulumu başlıyor.', { python: py.bin, localEnv: py.inVenv }).catch(() => {})
    const packageResult = await runSharedPythonPackageInstall(job, py, ['argostranslate'], 'Argos Translate paketi indiriliyor...')
    assertCommand(packageResult, 'Argos kurulumu tamamlanamadı.')
    logAiActivity(job, 'Argos Python paketi kuruldu; dil paketi hazırlanıyor.').catch(() => {})
    const modelResult = await runJobCommand(job, py.bin, [...py.prefix, '-c', ARGOS_INSTALL_SCRIPT], 'EN -> TR dil paketi hazırlanıyor...')
    assertCommand(modelResult, 'Argos dil paketi hazırlanamadı.')
    updateJob(job, { status: 'done', message: 'Argos Translate hazır.', percent: 100 }, true)
    return
  }

  const modelId = preferredOllamaModelId()
  logAiActivity(job, 'Ollama kurulumu başlıyor.', { model: modelId }).catch(() => {})
  await installOllamaModel(job, modelId)
}

function assertKnownOllamaModel(modelId: string): void {
  if (!ollamaRecommendedModels.some(model => model.id === modelId)) {
    throw new Error('Bilinmeyen Ollama modeli.')
  }
}

function preferredOllamaModelId(): string {
  const specs = readAiSystemSpecs()
  const recommended = ollamaRecommendedModels
    .map(model => recommendOllamaModel(model, specs, false))
    .filter(model => model.recommendation !== 'Ağır kalabilir')
  return recommended.find(model => model.id === ollamaModel)?.id ??
    recommended.find(model => model.id === 'qwen3.5:4b')?.id ??
    'qwen3.5:4b'
}

async function ensureOllamaRuntime(job: AiJob): Promise<string> {
  let ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) {
    ollamaBin = await installOllamaRuntime(job)
  }
  await ensureOllamaServer(job, ollamaBin)
  return ollamaBin
}

async function installOllamaModel(job: AiJob, modelId: string): Promise<void> {
  assertKnownOllamaModel(modelId)
  const model = ollamaRecommendedModels.find(item => item.id === modelId)
  updateJob(job, {
    modelId,
    message: `${modelId} modeli için Ollama hazırlanıyor...`,
    percent: job.percent ?? 5
  })

  const ollamaBin = await ensureOllamaRuntime(job)
  const list = await runSimple(ollamaBin, ['list'], undefined, 12_000)
  if (list.code === 0 && hasOllamaModel(list.stdout, modelId)) {
    updateJob(job, { status: 'done', message: `${modelId} modeli zaten hazır.`, percent: 100 }, true)
    return
  }

  const pull = await runJobCommand(
    job,
    ollamaBin,
    ['pull', modelId],
    `${model?.label ?? modelId} indiriliyor...`
  )
  assertCommand(pull, 'Ollama modeli indirilemedi.')
  updateJob(job, { status: 'done', message: `${modelId} modeli hazır.`, percent: 100 }, true)
}

async function installAllOllamaModels(job: AiJob): Promise<void> {
  updateJob(job, { message: 'Ollama modelleri için runtime hazırlanıyor...', percent: 3 })
  const ollamaBin = await ensureOllamaRuntime(job)
  const list = await runSimple(ollamaBin, ['list'], undefined, 12_000)
  const installedOutput = list.code === 0 ? list.stdout : ''

  for (let index = 0; index < ollamaRecommendedModels.length; index += 1) {
    if (cancelledJobs.has(job.id)) throw new Error('__AI_CANCELLED__')
    const model = ollamaRecommendedModels[index]
    const basePercent = 10 + Math.round((index / ollamaRecommendedModels.length) * 80)
    updateJob(job, {
      modelId: model.id,
      message: `${model.label} kontrol ediliyor...`,
      percent: basePercent
    })

    if (hasOllamaModel(installedOutput, model.id)) {
      updateJob(job, {
        message: `${model.label} zaten kurulu, sıradaki modele geçiliyor...`,
        percent: basePercent + 5
      })
      continue
    }

    const pull = await runJobCommand(
      job,
      ollamaBin,
      ['pull', model.id],
      `${model.label} indiriliyor...`
    )
    assertCommand(pull, `${model.id} modeli indirilemedi.`)
  }

  updateJob(job, { status: 'done', message: 'Tüm Ollama modelleri hazır.', percent: 100 }, true)
}

async function removeToolModel(job: AiJob, toolId: AiToolId): Promise<void> {
  const py = pythonCommand()
  logAiActivity(job, 'AI model kaldırma başlıyor.', { toolId }).catch(() => {})

  if (toolId === 'whisper') {
    const cacheDir = whisperCacheDir()
    updateJob(job, { message: 'Whisper model cache temizleniyor...' })
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true })
    }
    updateJob(job, { status: 'done', message: 'Whisper model cache kaldırıldı.', percent: 100 }, true)
    return
  }

  if (toolId === 'argos') {
    const result = await runJobCommand(
      job,
      py.bin,
      [...py.prefix, '-c', ARGOS_REMOVE_SCRIPT],
      'Argos EN -> TR dil paketi kaldırılıyor...'
    )
    assertCommand(result, 'Argos dil paketi kaldırılamadı.')
    updateJob(job, { status: 'done', message: 'Argos dil paketi kaldırıldı.', percent: 100 }, true)
    return
  }

  const ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) {
    updateJob(job, { status: 'done', message: 'Ollama kurulu değil; kaldırılacak model yok.', percent: 100 }, true)
    return
  }
  await ensureOllamaServer(job, ollamaBin)
  const result = await runJobCommand(job, ollamaBin, ['rm', ollamaModel], `${ollamaModel} modeli kaldırılıyor...`)
  if (result.code !== 0) {
    const detail = lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout)
    if (!/not found|model.*not/i.test(detail)) assertCommand(result, 'Ollama modeli kaldırılamadı.')
  }
  updateJob(job, { status: 'done', message: 'Ollama modeli kaldırıldı.', percent: 100 }, true)
}

async function repairTool(job: AiJob, toolId: AiToolId): Promise<void> {
  updateJob(job, { message: `${toolLabels[toolId]} durumu teşhis ediliyor...` })
  const before = toolId === 'ollama' ? await diagnoseOllamaTool() : await diagnosePythonTool(toolId)
  updateJob(job, { message: `Teşhis: ${before.detail ?? 'durum okunamadı'}` })

  if (before.installed) {
    updateJob(job, { status: 'done', message: `${toolLabels[toolId]} sağlam görünüyor. Onarım gerekmedi.`, percent: 100 }, true)
    return
  }

  if (toolId === 'whisper') {
    await ensurePythonModule(
      job,
      'import whisper; print(getattr(whisper, "__version__", "installed"))',
      ['openai-whisper'],
      'Whisper eksik/bozuk paketleri onarılıyor...',
      'Whisper onarımı tamamlanamadı.'
    )
    const after = await diagnosePythonTool('whisper')
    if (!after.installed) throw new Error(after.detail || 'Whisper onarıldı ama doğrulama geçmedi.')
    updateJob(job, { status: 'done', message: `Whisper onarıldı. ${after.detail ?? ''}`.trim(), percent: 100 }, true)
    return
  }

  if (toolId === 'argos') {
    const py = await ensurePythonModule(
      job,
      'import argostranslate.translate; print("package-ok")',
      ['argostranslate'],
      'Argos eksik/bozuk paketleri onarılıyor...',
      'Argos onarımı tamamlanamadı.'
    )
    const modelResult = await runJobCommand(job, py.bin, [...py.prefix, '-c', ARGOS_INSTALL_SCRIPT], 'Argos EN -> TR dil paketi onarılıyor...')
    assertCommand(modelResult, 'Argos dil paketi onarılamadı.')
    const after = await diagnosePythonTool('argos')
    if (!after.installed) throw new Error(after.detail || 'Argos onarıldı ama doğrulama geçmedi.')
    updateJob(job, { status: 'done', message: `Argos onarıldı. ${after.detail ?? ''}`.trim(), percent: 100 }, true)
    return
  }

  let ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) {
    updateJob(job, { message: 'Ollama runtime eksik; sadece runtime indirilecek...' })
    ollamaBin = await installOllamaRuntime(job)
  }
  await ensureOllamaServer(job, ollamaBin)
  const list = await runSimple(ollamaBin, ['list'], undefined, 12_000)
  if (list.code !== 0 || !hasOllamaModel(list.stdout, ollamaModel)) {
    updateJob(job, { message: `${ollamaModel} modeli eksik; model indirimi/onarma başlıyor...` })
    const pull = await runJobCommand(job, ollamaBin, ['pull', ollamaModel], `${ollamaModel} modeli onarılıyor...`)
    assertCommand(pull, 'Ollama modeli onarılamadı.')
  }
  const after = await diagnoseOllamaTool()
  if (!after.installed) throw new Error(after.detail || 'Ollama onarıldı ama doğrulama geçmedi.')
  updateJob(job, { status: 'done', message: `Ollama onarıldı. ${after.detail ?? ''}`.trim(), percent: 100 }, true)
}

function listChatSessions(): AiChatSession[] {
  const sessions = store.get(chatStoreKey, []) as AiChatSession[]
  return sessions
    .filter(session => session?.id && Array.isArray(session.messages))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, chatSessionLimit)
}

function saveChatSession(session: AiChatSession): AiChatSession[] {
  const normalized = {
    ...session,
    messages: session.messages.slice(-chatMessageLimit),
    updatedAt: Date.now()
  }
  const next = [normalized, ...listChatSessions().filter(item => item.id !== session.id)].slice(0, chatSessionLimit)
  store.set(chatStoreKey, next)
  return next
}

function deleteChatSession(sessionId: string): AiChatSession[] {
  const next = listChatSessions().filter(item => item.id !== sessionId)
  store.set(chatStoreKey, next)
  return next
}

function chatSessionExists(sessionId: string): boolean {
  return listChatSessions().some(item => item.id === sessionId)
}

function clearChatSessions(): AiChatSession[] {
  store.set(chatStoreKey, [])
  return []
}

async function listAiChatModels(): Promise<AiChatModel[]> {
  const specs = readAiSystemSpecs()
  const ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) {
    return ollamaRecommendedModels.map(model => {
      const recommended = recommendOllamaModel({ ...model, installed: false }, specs, false)
      return {
        ...recommended,
        label: ollamaChatModelLabel(recommended, false)
      }
    })
  }
  const list = await runSimple(ollamaBin, ['list'], undefined, 12_000)
  const names = list.code === 0
    ? list.stdout.split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/)[0]).filter(Boolean)
    : []
  const recommended = ollamaRecommendedModels.map(model => {
    const installed = modelInstalled(names, model.id)
    const enriched = recommendOllamaModel({ ...model, installed }, specs, installed)
    return {
      ...enriched,
      ...model,
      installed,
      recommendation: enriched.recommendation,
      recommendationDetail: enriched.recommendationDetail,
      label: ollamaChatModelLabel(enriched, installed)
    }
  })
  const known = new Set(ollamaRecommendedModels.flatMap(model => [model.id, `${model.id}:latest`]))
  const custom = Array.from(new Set(names))
    .filter(name => !known.has(name))
    .map(name => ({
      id: name,
      label: `${name} · kurulu`,
      installed: true,
      recommendation: 'Kurulu',
      recommendationDetail: 'Sistemde kurulu özel model; indirme gerektirmez.',
      description: 'Sistemde kurulu özel Ollama modeli.'
    }))
  return [...recommended, ...custom]
}

async function sendAiChatMessage(req: AiChatSendRequest): Promise<AiChatSendResult> {
  const messageText = String(req.message ?? '').trim()
  if (!messageText) throw new Error('Mesaj boş.')
  const model = req.model?.trim() || ollamaModel
  const now = Date.now()
  const existing = req.sessionId ? listChatSessions().find(item => item.id === req.sessionId) : undefined
  const session: AiChatSession = existing ?? {
    id: randomUUID(),
    title: messageText.slice(0, 48) || 'Yeni Sohbet',
    model,
    attachmentPath: req.attachmentPath,
    attachmentTitle: req.attachmentTitle,
    messages: [],
    createdAt: now,
    updatedAt: now
  }

  session.model = model
  session.attachmentPath = req.attachmentPath || session.attachmentPath
  session.attachmentTitle = req.attachmentTitle || session.attachmentTitle
  const userMessage: AiChatMessage = { id: randomUUID(), role: 'user', content: messageText, createdAt: now, model }
  session.messages = [...session.messages, userMessage]
  saveChatSession(session)

  const actionKind = detectChatAction(messageText)
  if (actionKind) {
    if (!session.attachmentPath || !existsSync(session.attachmentPath)) throw new Error('Bu komut için tamamlanmış local dosya seçin.')
    if (!chatSessionExists(session.id)) return { removed: true }
    const action = startAi({ kind: actionKind, inputPath: session.attachmentPath, title: session.attachmentTitle || basename(session.attachmentPath) })
    const assistant = chatAssistantMessage(`${aiActionText(actionKind)} başlatıldı. İlerlemeyi AI job geçmişinden takip edebilirsin.`, model)
    if (!chatSessionExists(session.id)) return { removed: true }
    session.messages = [...session.messages, assistant]
    saveChatSession(session)
    return { session, assistant, action: { kind: actionKind, jobId: action.jobId } }
  }

  const response = await runOllamaChat(model, buildChatPrompt(session, messageText))
  const assistant = chatAssistantMessage(response, model)
  if (!chatSessionExists(session.id)) return { removed: true }
  session.messages = [...session.messages, assistant]
  saveChatSession(session)
  return { session, assistant }
}

function chatAssistantMessage(content: string, model: string): AiChatMessage {
  return { id: randomUUID(), role: 'assistant', content, createdAt: Date.now(), model }
}

function detectChatAction(message: string): Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'> | null {
  const text = message.toLowerCase()
  if (/transkript|transcript|konuşma metni/.test(text)) return 'transcript'
  if (/özet|ozet|summary|summarize/.test(text)) return 'summary'
  if (/başlık|baslik|etiket|hashtag|title/.test(text)) return 'titles'
  if (/çevir|cevir|translate|türkçe|turkce/.test(text)) return 'translate'
  return null
}

function aiActionText(kind: Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>): string {
  if (kind === 'transcript') return 'Transcript çıkarma'
  if (kind === 'summary') return 'Özet üretme'
  if (kind === 'titles') return 'Başlık/etiket üretme'
  return 'TR çeviri'
}

function buildChatPrompt(session: AiChatSession, userMessage: string): string {
  const context = session.attachmentPath ? readChatAttachmentContext(session.attachmentPath) : ''
  const history = session.messages
    .slice(-10)
    .map(message => `${message.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${message.content}`)
    .join('\n')
  return [
    'Sen DropMedia içindeki local AI asistanısın. Türkçe, kısa, net ve pratik cevap ver.',
    'Kullanıcı video/dosya bağladıysa transcript bağlamını kullan; transcript yoksa bunu açıkça söyle.',
    context ? `Dosya bağlamı:\n${context}` : '',
    `Sohbet geçmişi:\n${history}`,
    `Son kullanıcı mesajı:\n${userMessage}`,
    'Cevap:'
  ].filter(Boolean).join('\n\n')
}

function readChatAttachmentContext(inputPath: string): string {
  try {
    const source = readTextSource(inputPath)
    return `Bağlı dosya: ${basename(inputPath)}\nMetin kaynağı: ${basename(source.path)}\n---\n${source.text.slice(0, 16_000)}`
  } catch {
    return `Bağlı dosya: ${basename(inputPath)}\nTranscript bulunamadı. Video içeriği hakkında ayrıntılı cevap için önce transcript çıkarılması gerekir.`
  }
}

async function runOllamaChat(model: string, prompt: string): Promise<string> {
  const ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) throw new Error('Ollama hazır değil. Önce AI araçlarından Ollama kurulumunu çalıştırın.')
  await ensureOllamaServerQuiet(ollamaBin)
  const result = await runOllamaRawGenerate(model, prompt, 10 * 60_000)
  if (!result.trim()) throw new Error('Ollama boş yanıt döndürdü.')
  return result.trim()
}

async function ensureOllamaServerQuiet(bin: string): Promise<void> {
  const list = await runSimple(bin, ['list'], undefined, 5_000)
  if (list.code === 0) return
  try {
    mkdirSync(localOllamaModels(), { recursive: true })
    const proc = spawn(bin, ['serve'], { env: childEnv(), detached: true, stdio: 'ignore' })
    proc.unref()
  } catch (err) {
    throw new Error(`Ollama server başlatılamadı: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (let i = 0; i < 16; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 750))
    const ready = await runSimple(bin, ['list'], undefined, 5_000)
    if (ready.code === 0) return
  }
  throw new Error('Ollama server zamanında hazır olmadı.')
}

function runOllamaRawGenerate(model: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = ollamaApiUrl('/api/generate')
    const payload = JSON.stringify({ model, prompt, stream: true, options: { temperature: 0.3, top_p: 0.9 } })
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
    let output = ''
    let buffer = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.error === 'string' && parsed.error) throw new Error(parsed.error)
      if (typeof parsed.response === 'string') output += parsed.response
    }
    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (res) => {
      res.setEncoding('utf8')
      if ((res.statusCode ?? 500) >= 400) {
        let body = ''
        res.on('data', (chunk: string) => { body = appendTail(body, chunk, 2_000) })
        res.on('end', () => finish(() => reject(new Error(`Ollama API hata döndürdü (${res.statusCode ?? '-'}): ${sanitizeTerminalText(body).trim()}`))))
        return
      }
      res.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        try {
          for (const line of lines) {
            handleLine(line)
          }
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('end', () => {
        try {
          if (buffer.trim()) handleLine(buffer)
          finish(() => resolve(output))
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`OLLAMA_CHAT_TIMEOUT:${timeoutMs}`)))
    req.on('error', err => finish(() => reject(err)))
    req.write(payload)
    req.end()
  })
}

async function runTranscript(job: AiJob, req: AiJobStartRequest): Promise<string> {
  if (!hasFfmpeg()) throw new Error('Transcript için ffmpeg gerekiyor.')
  const outputPath = sidecarPath(req.inputPath, 'transcript', 'txt')
  const py = await ensurePythonModule(
    job,
    'import whisper; print("ok")',
    ['openai-whisper'],
    'Whisper paketi otomatik hazırlanıyor...',
    'Whisper otomatik kurulamadı.'
  )
  const result = await runJobCommand(
    job,
    py.bin,
    [...py.prefix, '-c', WHISPER_TRANSCRIPT_SCRIPT, req.inputPath, outputPath, req.model ?? 'base'],
    'Transcript çıkarılıyor...'
  )
  assertCommand(result, 'Transcript çıkarılamadı.')
  if (!existsSync(outputPath)) throw new Error('Transcript tamamlandı ama çıktı dosyası bulunamadı.')
  return outputPath
}

async function runOllamaTextJob(job: AiJob, req: AiJobStartRequest, mode: 'summary' | 'titles'): Promise<string> {
  const source = readTextSource(req.inputPath)
  const outputPath = sidecarPath(req.inputPath, mode === 'summary' ? 'summary' : 'titles', 'md')
  const ollamaBin = await detectOllamaCommand()
  if (!ollamaBin) throw new Error('Ollama hazır değil. Önce AI araçlarından Ollama kurulumunu çalıştırın.')
  await ensureOllamaServer(job, ollamaBin)
  const prompt = mode === 'summary'
    ? [
        'Aşağıdaki video transcriptini Türkçe özetle.',
        'Çıktı formatı:',
        '- 5 maddelik kısa özet',
        '- önemli zaman/konu notları varsa ayrıca liste',
        '- kullanıcı için aksiyon/not',
        '',
        source.text
      ].join('\n')
    : [
        'Aşağıdaki video transcriptinden Türkçe içerik paket önerisi üret.',
        'Çıktı formatı:',
        '- 5 başlık önerisi',
        '- 12 etiket',
        '- kısa açıklama',
        '- dosya adı için slug',
        '',
        source.text
      ].join('\n')
  const result = await runOllamaStreamJob(
    job,
    prompt,
    mode === 'summary' ? 'Özet üretiliyor...' : 'Başlık ve etiket üretiliyor...',
    req.model ?? ollamaModel
  )
  const text = result.response.trim()
  if (!text) throw new Error('Ollama boş yanıt döndürdü.')
  writeFileSync(outputPath, text + '\n', 'utf8')
  return outputPath
}

async function runTranslate(job: AiJob, req: AiJobStartRequest): Promise<string> {
  const source = readTextSource(req.inputPath)
  const target = req.targetLanguage ?? 'tr'
  const outputPath = sidecarPath(req.inputPath, target, 'txt')
  const py = await ensurePythonModule(
    job,
    'import argostranslate.translate; print("ok")',
    ['argostranslate'],
    'Argos Translate paketi otomatik hazırlanıyor...',
    'Argos Translate otomatik kurulamadı.'
  )
  let result = await runJobCommand(
    job,
    py.bin,
    [...py.prefix, '-c', ARGOS_TRANSLATE_SCRIPT, outputPath, target],
    'Çeviri hazırlanıyor...',
    source.text
  )
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.code !== 0 && detail.includes('dil paketi kurulu değil')) {
    const modelResult = await runJobCommand(job, py.bin, [...py.prefix, '-c', ARGOS_INSTALL_SCRIPT], 'Argos dil paketi otomatik hazırlanıyor...')
    assertCommand(modelResult, 'Argos dil paketi otomatik hazırlanamadı.')
    result = await runJobCommand(
      job,
      py.bin,
      [...py.prefix, '-c', ARGOS_TRANSLATE_SCRIPT, outputPath, target],
      'Çeviri hazırlanıyor...',
      source.text
    )
  }
  assertCommand(result, 'Çeviri üretilemedi.')
  if (!existsSync(outputPath)) throw new Error('Çeviri tamamlandı ama çıktı dosyası bulunamadı.')
  return outputPath
}

async function runAiJob(job: AiJob, req: AiJobStartRequest): Promise<void> {
  let outputPath: string
  if (req.kind === 'transcript') outputPath = await runTranscript(job, req)
  else if (req.kind === 'summary') outputPath = await runOllamaTextJob(job, req, 'summary')
  else if (req.kind === 'titles') outputPath = await runOllamaTextJob(job, req, 'titles')
  else outputPath = await runTranslate(job, req)

  updateJob(job, { status: 'done', percent: 100, message: 'Tamamlandı.', outputPath }, true)
}

function completeError(job: AiJob, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err || 'İşlem tamamlanamadı.')
  if (message === '__AI_CANCELLED__') {
    updateJob(job, { status: 'cancelled', message: 'İptal edildi.', error: 'İptal edildi.' }, true)
    return
  }
  logError({
    errorType: 'download',
    errorMessage: message,
    operation: `ai-${job.kind}`,
    stackTrace: err instanceof Error ? err.stack : undefined,
    details: { inputPath: job.inputPath, toolId: job.toolId, modelId: job.modelId }
  })
  updateJob(job, { status: 'error', message: '', error: userFriendlyAiError(message, job) }, true)
}

function userFriendlyAiError(message: string, job: AiJob): string {
  const text = message.toLowerCase()
  const prefix = 'İşlem tamamlanamadı.'

  if (text.includes('otomatik pip onarımı')) {
    return `${prefix} Python pip otomatik onarılamadı. İnternet bağlantısı, Python venv/ensurepip desteği veya sistem Python izinleri engel olmuş olabilir. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('no module named pip')) {
    return `${prefix} Python pip otomatik onarılamadı. Python venv/ensurepip desteği veya sistem Python izinleri engel olmuş olabilir. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('no module named whisper')) {
    return `${prefix} Whisper paketi hazır değil. Local AI araçlarından Whisper için "Onar" veya "Kur / Hazırla" çalıştırın. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('no module named argostranslate')) {
    return `${prefix} Argos Translate paketi hazır değil. Local AI araçlarından Argos için "Onar" veya "Kur / Hazırla" çalıştırın. Teknik detay admin loguna kaydedildi.`
  }
  if (/spawn .*python.*enoent|python.*not found|py.*not found/i.test(message)) {
    return `${prefix} Python bulunamadı. Sistem Python kurulumunu kontrol edip tekrar deneyin. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('metin kaynağı bulunamadı')) {
    return 'Metin kaynağı bulunamadı. Önce bu dosya için transcript çıkarın, sonra özet/çeviri/başlık işlemini tekrar deneyin.'
  }
  if (text.includes('ollama hazır değil') || text.includes('ollama komutu yok')) {
    return `${prefix} Ollama hazır değil. Local AI araçlarından Ollama için "Onar" veya "Kur / Hazırla" çalıştırın. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('ollama otomatik kurulumu')) {
    return `${prefix} ${ollamaManagedInstallUnsupportedMessage()}`
  }
  if (text.includes('modeli kurulu değil') || text.includes('modeli yok')) {
    return `${prefix} Gerekli model kurulu görünmüyor. İlgili araç için "Onar" veya "Kur / Hazırla" çalıştırıp tekrar deneyin. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('ollama_benchmark_timeout')) {
    return `${prefix} Ollama kurulu ve model kontrolü geçti; yanıt testi süre limitini aştı. Bu genelde CPU-only cihazlarda ilk soğuk çalıştırmadan kaynaklanır. Birkaç dakika bekleyip testi tekrar deneyin. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('ollama_generate_timeout')) {
    return `${prefix} Ollama yanıt üretimi süre limitini aştı. Transcript çok uzun, CPU yükü yüksek veya model soğuk başlamış olabilir. Kısa bir dosyayla tekrar deneyin ya da modeli yeniden başlatın. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('timeout') || text.includes('zaman aşım')) {
    return `${prefix} Yanıt testi zaman aşımına uğradı. Araç kurulu olabilir fakat cihaz yükü, ilk model açılışı veya internet/disk hızı testi geciktirmiş olabilir. Biraz bekleyip tekrar deneyin. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('server zamanında hazır olmadı')) {
    return `${prefix} Ollama local server zamanında açılmadı. Birkaç saniye bekleyip tekrar deneyin; devam ederse uygulamayı kapatıp açın. Teknik detay admin loguna kaydedildi.`
  }
  if (text.includes('geçerli local dosya seçin')) {
    return 'AI işlemi için tamamlanmış ve bilgisayarda bulunan bir dosya seçin.'
  }

  return `${prefix} Kurulum/dosya durumunu kontrol edip tekrar deneyin. Teknik detay admin loguna kaydedildi.`
}

async function startInstall(toolId: AiToolId): Promise<{ jobId: string; existing?: boolean }> {
  const existing = findActiveToolJob('install', toolId)
  if (existing) {
    logAiActivity(existing, 'Aynı AI kurulum isteği tekrarlandı; mevcut job kullanılacak.', { duplicateBlocked: true }).catch(() => {})
    return { jobId: existing.id, existing: true }
  }
  await assertCanStartToolSetup(toolId)
  const job = createJob({
    kind: 'install',
    title: `${toolLabels[toolId]} kurulumu`,
    message: 'Hazırlanıyor...',
    toolId
  })
  installTool(job, toolId).catch(err => completeError(job, err))
  return { jobId: job.id }
}

async function startInstallModel(modelId: string): Promise<{ jobId: string; existing?: boolean }> {
  assertKnownOllamaModel(modelId)
  const existing = findActiveToolJob('install', 'ollama')
  if (existing) return { jobId: existing.id, existing: true }

  const job = createJob({
    kind: 'install',
    title: `Ollama model kurulumu: ${modelId}`,
    message: 'Hazırlanıyor...',
    toolId: 'ollama',
    modelId
  })
  installOllamaModel(job, modelId).catch(err => completeError(job, err))
  return { jobId: job.id }
}

async function startInstallAllModels(): Promise<{ jobId: string; existing?: boolean }> {
  const existing = findActiveToolJob('install', 'ollama')
  if (existing) return { jobId: existing.id, existing: true }

  const job = createJob({
    kind: 'install',
    title: 'Ollama tüm model kurulumu',
    message: 'Hazırlanıyor...',
    toolId: 'ollama',
    modelId: 'all'
  })
  installAllOllamaModels(job).catch(err => completeError(job, err))
  return { jobId: job.id }
}

async function startRepair(toolId: AiToolId): Promise<{ jobId: string; existing?: boolean }> {
  const existing = findActiveToolJob('repair', toolId) ?? findActiveToolJob('install', toolId)
  if (existing) {
    return { jobId: existing.id, existing: true }
  }
  await assertCanStartToolSetup(toolId)
  const job = createJob({
    kind: 'repair',
    title: `${toolLabels[toolId]} onarımı`,
    message: 'Teşhis hazırlanıyor...',
    toolId
  })
  repairTool(job, toolId).catch(err => completeError(job, err))
  return { jobId: job.id }
}

function startRemove(toolId: AiToolId): { jobId: string; existing?: boolean } {
  const existing = findActiveToolJob('remove', toolId)
  if (existing) {
    logAiActivity(existing, 'Aynı AI kaldırma isteği tekrarlandı; mevcut job kullanılacak.', { duplicateBlocked: true }).catch(() => {})
    return { jobId: existing.id, existing: true }
  }
  const job = createJob({
    kind: 'remove',
    title: `${toolLabels[toolId]} model kaldırma`,
    message: 'Hazırlanıyor...',
    toolId
  })
  removeToolModel(job, toolId).catch(err => completeError(job, err))
  return { jobId: job.id }
}

function startAi(req: AiJobStartRequest): { jobId: string } {
  if (!req?.inputPath || !existsSync(req.inputPath)) throw new Error('Geçerli local dosya seçin.')
  const job = createJob({
    kind: req.kind,
    title: req.title || basename(req.inputPath),
    message: 'Hazırlanıyor...',
    inputPath: req.inputPath
  })
  runAiJob(job, req).catch(err => completeError(job, err))
  return { jobId: job.id }
}

function cancelJob(jobId: string): boolean {
  const proc = activeJobs.get(jobId)
  const httpJob = activeHttpJobs.get(jobId)
  cancelledJobs.add(jobId)
  pausedJobs.delete(jobId)
  if (httpJob) {
    httpJob.destroy(new Error('__AI_CANCELLED__'))
    return true
  }
  if (proc) {
    proc.kill('SIGTERM')
    return true
  }
  const running = runningJobs.get(jobId)
  if (running) {
    updateJob(running, { status: 'cancelled', message: 'İptal edildi.', error: 'İptal edildi.' }, true)
    return true
  }
  return false
}

function pauseJob(jobId: string): boolean {
  const proc = activeJobs.get(jobId)
  const running = runningJobs.get(jobId)
  if (!proc || !running || running.status !== 'running') return false
  if (process.platform === 'win32') throw new Error('AI indirme duraklatma Windows için sonraki buildde eklenecek.')
  const ok = proc.kill('SIGSTOP')
  if (!ok) return false
  pausedJobs.add(jobId)
  updateJob(running, { status: 'paused', message: 'Duraklatıldı.' })
  return true
}

function resumeJob(jobId: string): boolean {
  const proc = activeJobs.get(jobId)
  const running = runningJobs.get(jobId)
  if (!proc || !running || running.status !== 'paused') return false
  if (process.platform === 'win32') throw new Error('AI indirme devam ettirme Windows için sonraki buildde eklenecek.')
  const ok = proc.kill('SIGCONT')
  if (!ok) return false
  pausedJobs.delete(jobId)
  updateJob(running, { status: 'running', message: 'Devam ediyor...' })
  return true
}

export function setupAiHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('ai-tools-status', () => getAiToolsStatus())
  ipcMain.handle('ai-system-report', () => getAiSystemReport())
  ipcMain.handle('ai-tool-benchmark', (_e, toolId: AiToolId) => benchmarkAiTool(toolId))
  ipcMain.handle('ai-tool-install', (_e, toolId: AiToolId) => {
    if (!['whisper', 'ollama', 'argos'].includes(toolId)) throw new Error('Bilinmeyen AI aracı.')
    return startInstall(toolId)
  })
  ipcMain.handle('ai-model-install', (_e, modelId: string) => startInstallModel(modelId))
  ipcMain.handle('ai-model-install-all', () => startInstallAllModels())
  ipcMain.handle('ai-tool-repair', (_e, toolId: AiToolId) => {
    if (!['whisper', 'ollama', 'argos'].includes(toolId)) throw new Error('Bilinmeyen AI aracı.')
    return startRepair(toolId)
  })
  ipcMain.handle('ai-tool-remove', (_e, toolId: AiToolId) => {
    if (!['whisper', 'ollama', 'argos'].includes(toolId)) throw new Error('Bilinmeyen AI aracı.')
    return startRemove(toolId)
  })
  ipcMain.handle('ai-job-start', (_e, req: AiJobStartRequest) => startAi(req))
  ipcMain.handle('ai-job-cancel', (_e, jobId: string) => cancelJob(jobId))
  ipcMain.handle('ai-job-pause', (_e, jobId: string) => pauseJob(jobId))
  ipcMain.handle('ai-job-resume', (_e, jobId: string) => resumeJob(jobId))
  ipcMain.handle('ai-jobs-list', () => listJobs())
  ipcMain.handle('ai-job-delete', (_e, jobId: string) => deleteStoredJob(jobId))
  ipcMain.handle('ai-jobs-clear', () => clearStoredJobs())
  ipcMain.handle('ai-chat-models', () => listAiChatModels())
  ipcMain.handle('ai-chat-sessions', () => listChatSessions())
  ipcMain.handle('ai-chat-send', (_e, req: AiChatSendRequest) => sendAiChatMessage(req))
  ipcMain.handle('ai-chat-delete', (_e, sessionId: string) => deleteChatSession(sessionId))
  ipcMain.handle('ai-chat-clear', () => clearChatSessions())
}

const GET_PIP_DOWNLOAD_SCRIPT = String.raw`
import sys
import urllib.request

target = sys.argv[1]
url = "https://bootstrap.pypa.io/get-pip.py"
with urllib.request.urlopen(url, timeout=60) as response:
    data = response.read()
with open(target, "wb") as handle:
    handle.write(data)
print(target)
`

const WHISPER_TRANSCRIPT_SCRIPT = String.raw`
import sys
from pathlib import Path

input_path, output_path, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    import whisper
except Exception as exc:
    raise SystemExit("Whisper paketi kurulu değil: " + str(exc))

model = whisper.load_model(model_name)
result = model.transcribe(input_path, fp16=False)
text = (result.get("text") or "").strip()
Path(output_path).write_text(text + "\n", encoding="utf-8")
print(output_path)
`

const ARGOS_INSTALL_SCRIPT = String.raw`
from argostranslate import package, translate

def verify_en_tr():
    installed = translate.get_installed_languages()
    source = next((lang for lang in installed if lang.code == "en"), None)
    target = next((lang for lang in installed if lang.code == "tr"), None)
    if not source or not target:
        return False
    try:
        sample = source.get_translation(target).translate("hello world")
        print("en_tr installed: " + sample[:120])
        return True
    except Exception as exc:
        print("en_tr verify failed: " + str(exc))
        return False

package.update_package_index()
if verify_en_tr():
    raise SystemExit(0)

available = package.get_available_packages()
pkg = next((item for item in available if item.from_code == "en" and item.to_code == "tr"), None)
if not pkg:
    raise SystemExit("Argos en->tr paketi bulunamadı.")
path = pkg.download()
package.install_from_path(path)
if not verify_en_tr():
    raise SystemExit("Argos en->tr dil paketi kuruldu ama doğrulama geçmedi.")
`

const ARGOS_BENCHMARK_SCRIPT = String.raw`
from argostranslate import translate

installed = translate.get_installed_languages()
source = next((lang for lang in installed if lang.code == "en"), None)
target = next((lang for lang in installed if lang.code == "tr"), None)
if not source or not target:
    raise SystemExit("Argos en->tr dil paketi kurulu değil.")
translation = source.get_translation(target)
print(translation.translate("hello world")[:120])
`

const ARGOS_TRANSLATE_SCRIPT = String.raw`
import sys
from pathlib import Path
from argostranslate import translate

output_path, target_code = sys.argv[1], sys.argv[2]
text = sys.stdin.read().strip()
if not text:
    raise SystemExit("Çevrilecek metin boş.")

installed = translate.get_installed_languages()
source = next((lang for lang in installed if lang.code == "en"), None)
target = next((lang for lang in installed if lang.code == target_code), None)
if not source or not target:
    raise SystemExit("Argos en->%s dil paketi kurulu değil." % target_code)

translation = source.get_translation(target)
Path(output_path).write_text(translation.translate(text) + "\n", encoding="utf-8")
print(output_path)
`

const ARGOS_REMOVE_SCRIPT = String.raw`
from argostranslate import package

removed = False
for pkg in package.get_installed_packages():
    from_code = getattr(pkg, "from_code", "")
    to_code = getattr(pkg, "to_code", "")
    if from_code == "en" and to_code == "tr":
        uninstall = getattr(pkg, "uninstall", None)
        if callable(uninstall):
            uninstall()
            removed = True
        else:
            raise SystemExit("Argos package uninstall API bulunamadı.")

print("removed" if removed else "not installed")
`
