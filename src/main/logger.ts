import { app } from 'electron'
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import Store from 'electron-store'
import { spawnSync } from 'child_process'

const store = new Store()
const sessionId = randomUUID()
let reportedRemoteConfigMissing = false
let lastRemoteFailureLogAt = 0
let remoteRetryBlockedUntil = 0

// Cihaz UUID'si — ilk çalıştırmada oluşturulur, kalıcı saklanır
function getDeviceId(): string {
  let id = store.get('deviceId') as string | undefined
  if (!id) {
    id = randomUUID()
    store.set('deviceId', id)
  }
  return id
}

function getYtDlpVersion(): string {
  try {
    const custom = store.get('ytDlpPath') as string | undefined
    if (custom && existsSync(custom)) {
      const r = spawnSync(custom, ['--version'], { timeout: 2000 })
      return r.stdout?.toString().trim() || 'unknown'
    }
    const userBin = `${process.env.HOME}/.local/bin/yt-dlp`
    const bin = existsSync(userBin) ? userBin : 'yt-dlp'
    const r = spawnSync(bin, ['--version'], { timeout: 2000 })
    return r.stdout?.toString().trim() || 'unknown'
  } catch { return 'unknown' }
}

function hasFfmpeg(): boolean {
  const userBin = `${process.env.HOME}/.local/bin/ffmpeg`
  if (existsSync(userBin)) return true
  try { return spawnSync('ffmpeg', ['-version'], { timeout: 1000 }).status === 0 }
  catch { return false }
}

type ErrorType = 'download' | 'download_ok' | 'warning' | 'fetch' | 'update' | 'crash' | 'general' | 'system' | 'clipboard' | 'settings' | 'app_open'

interface LogPayload {
  device_id:    string
  hostname:     string
  app_version:  string
  os:           string
  url?:         string
  format?:      string
  error_type:   ErrorType
  error_message: string
  stack_trace?: string
  ytdlp_version: string
  ffmpeg:       boolean
  tor_enabled:  boolean
}

interface StatPayload {
  device_id:    string
  hostname:     string
  app_version:  string
  os:           string
  platform:     string
  format:       string
  file_size_mb?: number
  duration_sec?: number
  download_ms?: number
  success:      boolean
}

const SUPABASE_URL  = process.env.SUPABASE_URL  ?? ''
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY ?? ''   // anon key: sadece insert

async function postToSupabase(table: string, data: object): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    if (!reportedRemoteConfigMissing) {
      reportedRemoteConfigMissing = true
      appendLocalLog({
        level: 'warn',
        event: 'remote_log_disabled',
        message: 'Supabase URL veya anon key tanımlı değil; admin paneline uzaktan log gönderilemedi.'
      })
    }
    queueRemotePayload(table, data, 'missing_supabase_config')
    return
  }

  const sent = await sendToSupabase(table, data)
  if (!sent) queueRemotePayload(table, data, 'send_failed')
}

async function sendToSupabase(table: string, data: object): Promise<boolean> {
  try {
    const { net } = await import('electron')
    const req = net.request({
      method: 'POST',
      url: `${SUPABASE_URL}/rest/v1/${table}`,
    })
    req.setHeader('Content-Type', 'application/json')
    req.setHeader('apikey', SUPABASE_KEY)
    req.setHeader('Authorization', `Bearer ${SUPABASE_KEY}`)
    req.setHeader('Prefer', 'return=minimal')

    return await new Promise<boolean>((resolve) => {
      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk.toString()))
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            noteRemoteFailure({ table, status_code: res.statusCode, response: sanitizeText(body).slice(0, 1000) })
            resolve(false)
            return
          }
          resolve(true)
        })
      })
      req.on('error', (err) => {
        noteRemoteFailure({ table, error: sanitizeText(err.message) })
        resolve(false)
      })
      req.write(JSON.stringify(data))
      req.end()
    })
  } catch {
    return false
  }
}

export async function logError(opts: {
  errorType: ErrorType
  errorMessage: string
  stackTrace?: string
  url?: string
  format?: string
  operation?: string
  command?: string
  exitCode?: number | null
  stderr?: string
  stdout?: string
  details?: Record<string, unknown>
}): Promise<void> {
  const torEnabled = !!(store.get('torEnabled') as boolean | undefined)
  const technicalDetails = buildTechnicalDetails(opts)

  const payload: LogPayload = {
    device_id:     getDeviceId(),
    hostname:      require('os').hostname(),
    app_version:   app.getVersion(),
    os:            `${process.platform} ${require('os').release()}`,
    url:           sanitizeUrl(opts.url),
    format:        opts.format,
    error_type:    opts.errorType,
    error_message: sanitizeText(opts.errorMessage),
    stack_trace:   technicalDetails,
    ytdlp_version: getYtDlpVersion(),
    ffmpeg:        hasFfmpeg(),
    tor_enabled:   torEnabled
  }

  // Lokal log dosyasına da yaz (offline debug için)
  appendLocalLog({ level: 'error', ...payload })

  await postToSupabase('error_logs', payload)
}

export async function logActivity(opts: {
  eventType: Extract<ErrorType, 'app_open' | 'general' | 'system' | 'settings' | 'clipboard'>
  message: string
  details?: Record<string, unknown>
}): Promise<void> {
  const payload: LogPayload = {
    device_id:     getDeviceId(),
    hostname:      require('os').hostname(),
    app_version:   app.getVersion(),
    os:            `${process.platform} ${require('os').release()}`,
    error_type:    opts.eventType,
    error_message: sanitizeText(opts.message),
    stack_trace:   buildTechnicalDetails({ details: opts.details }),
    ytdlp_version: getYtDlpVersion(),
    ffmpeg:        hasFfmpeg(),
    tor_enabled:   !!(store.get('torEnabled') as boolean | undefined)
  }

  appendLocalLog({ level: 'info', ...payload })
  await postToSupabase('error_logs', payload)
}

export async function logStat(opts: {
  platform: string
  format: string
  fileSizeMb?: number
  durationSec?: number
  downloadMs?: number
  success: boolean
}): Promise<void> {
  const payload: StatPayload = {
    device_id:    getDeviceId(),
    hostname:     require('os').hostname(),
    app_version:  app.getVersion(),
    os:           `${process.platform} ${require('os').release()}`,
    platform:     opts.platform,
    format:       opts.format,
    file_size_mb: opts.fileSizeMb,
    duration_sec: opts.durationSec,
    download_ms:  opts.downloadMs,
    success:      opts.success
  }

  appendLocalLog({ level: 'stat', ...payload })
  await postToSupabase('stats', payload)
}

export async function logDownload(opts: {
  url: string
  title?: string
  format: string
  platform: string
  outputPath?: string
  fileSizeMb?: number
  durationSec?: number
  downloadMs: number
  speedMbps?: number
  mergedStreams?: boolean
  command?: string
}): Promise<void> {
  // Temel stat kaydı (mevcut Supabase stats tablosu)
  await logStat({
    platform:     opts.platform,
    format:       opts.format,
    fileSizeMb:   opts.fileSizeMb,
    durationSec:  opts.durationSec,
    downloadMs:   opts.downloadMs,
    success:      true
  })

  // Kapsamlı download log (error_logs tablosu, download_ok tipi)
  const details: Record<string, unknown> = {
    url:           sanitizeUrl(opts.url),
    title:         opts.title?.slice(0, 200),
    output_path:   opts.outputPath,
    file_size_mb:  opts.fileSizeMb,
    duration_sec:  opts.durationSec,
    download_ms:   opts.downloadMs,
    speed_mbps:    opts.speedMbps !== undefined ? Math.round(opts.speedMbps * 100) / 100 : undefined,
    merged_streams: opts.mergedStreams,
    format:        opts.format,
    platform:      opts.platform
  }

  const torEnabled = !!(store.get('torEnabled') as boolean | undefined)
  const payload: LogPayload = {
    device_id:     getDeviceId(),
    hostname:      require('os').hostname(),
    app_version:   app.getVersion(),
    os:            `${process.platform} ${require('os').release()}`,
    url:           sanitizeUrl(opts.url),
    format:        opts.format,
    error_type:    'download_ok',
    error_message: opts.title ? `✓ ${opts.title}` : '✓ İndirme tamamlandı',
    stack_trace:   buildTechnicalDetails({ command: opts.command, details }),
    ytdlp_version: getYtDlpVersion(),
    ffmpeg:        hasFfmpeg(),
    tor_enabled:   torEnabled
  }

  appendLocalLog({ level: 'download_ok', ...payload })
  await postToSupabase('error_logs', payload)

  // Anomali tespiti
  const SLOW_MS     = 15 * 60 * 1000  // 15 dakika
  const SMALL_MB    = 0.05             // 50 KB'dan küçük video → merge sorunu olabilir
  const SLOW_MBPS   = 0.05             // 50 KB/s

  const anomalies: string[] = []
  if (opts.downloadMs > SLOW_MS) anomalies.push(`İndirme ${Math.round(opts.downloadMs / 60000)} dakika sürdü`)
  if (opts.fileSizeMb !== undefined && opts.fileSizeMb < SMALL_MB && !['mp3','m4a','aac'].includes(opts.format))
    anomalies.push(`Dosya şüpheli derecede küçük: ${opts.fileSizeMb.toFixed(3)} MB — ffmpeg merge sorunu olabilir`)
  if (opts.speedMbps !== undefined && opts.speedMbps < SLOW_MBPS)
    anomalies.push(`İndirme hızı çok düşük: ${(opts.speedMbps * 1024).toFixed(0)} KB/s`)

  for (const msg of anomalies) {
    const warnPayload: LogPayload = {
      device_id:     getDeviceId(),
      hostname:      require('os').hostname(),
      app_version:   app.getVersion(),
      os:            `${process.platform} ${require('os').release()}`,
      url:           sanitizeUrl(opts.url),
      format:        opts.format,
      error_type:    'warning',
      error_message: msg,
      stack_trace:   buildTechnicalDetails({ details }),
      ytdlp_version: getYtDlpVersion(),
      ffmpeg:        hasFfmpeg(),
      tor_enabled:   torEnabled
    }
    appendLocalLog({ level: 'warning', ...warnPayload })
    await postToSupabase('error_logs', warnPayload)
  }
}

export async function flushPendingRemoteLogs(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  if (Date.now() < remoteRetryBlockedUntil) return

  const queueFile = getRemoteQueuePath()
  if (!existsSync(queueFile)) return

  const processingFile = `${queueFile}.processing`
  try {
    renameSync(queueFile, processingFile)
  } catch {
    return
  }

  const failed: string[] = []
  const lines = readFileSync(processingFile, 'utf8').split('\n').filter(Boolean)

  for (const line of lines) {
    try {
      const item = JSON.parse(line) as { table: string; data: object }
      const sent = await sendToSupabase(item.table, item.data)
      if (!sent) failed.push(line)
    } catch {
      failed.push(line)
    }
  }

  if (failed.length > 0) {
    writeFileSync(queueFile, `${failed.join('\n')}\n`)
  }
  try { unlinkSync(processingFile) } catch { /* ignore */ }
}

function noteRemoteFailure(data: Record<string, unknown>): void {
  const now = Date.now()
  remoteRetryBlockedUntil = now + 60_000
  if (now - lastRemoteFailureLogAt < 5 * 60_000) return
  lastRemoteFailureLogAt = now
  appendLocalLog({
    level: 'warn',
    event: 'remote_log_failed',
    ...data
  })
}

function buildTechnicalDetails(opts: {
  operation?: string
  command?: string
  exitCode?: number | null
  stderr?: string
  stdout?: string
  stackTrace?: string
  details?: Record<string, unknown>
}): string | undefined {
  const lines: string[] = [`Session: ${sessionId}`]

  if (opts.operation) lines.push(`Operation: ${sanitizeText(opts.operation)}`)
  if (opts.command) lines.push(`Command: ${sanitizeText(opts.command)}`)
  if (typeof opts.exitCode === 'number') lines.push(`Exit code: ${opts.exitCode}`)
  if (opts.details && Object.keys(opts.details).length > 0) {
    lines.push(`Details: ${safeStringify(opts.details)}`)
  }
  if (opts.stderr) lines.push(`stderr:\n${sanitizeText(opts.stderr)}`)
  if (opts.stdout) lines.push(`stdout:\n${sanitizeText(opts.stdout)}`)
  if (opts.stackTrace) lines.push(`stack:\n${sanitizeText(opts.stackTrace)}`)

  return lines.length > 1 ? lines.join('\n\n').slice(0, 12000) : lines[0]
}

function sanitizeUrl(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return sanitizeText(url).slice(0, 500)
  }
}

function sanitizeText(value: unknown): string {
  let text = String(value ?? '')
  text = text.replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[redacted]')
  text = text.replace(/(apikey['"]?\s*[:=]\s*['"]?)[^'",\s}]+/gi, '$1[redacted]')
  text = text.replace(/((?:access|refresh|id)?_?token['"]?\s*[:=]\s*['"]?)[^'",\s}]+/gi, '$1[redacted]')
  text = text.replace(/(password['"]?\s*[:=]\s*['"]?)[^'",\s}]+/gi, '$1[redacted]')
  text = text.replace(/(cookie(?:s)?['"]?\s*[:=]\s*)[^\n\r]+/gi, '$1[redacted]')
  text = text.replace(/([?&](?:token|auth|key|password|session|cookie)=[^&\s]*)/gi, '[redacted-query]')
  text = text.replace(/(--cookies\s+)([^\s]+)/gi, '$1[redacted]')
  return text
}

function safeStringify(value: Record<string, unknown>): string {
  return sanitizeText(JSON.stringify(value, (_key, val) => {
    const key = String(_key).toLowerCase()
    if (/(token|password|secret|cookie|authorization|apikey)/.test(key)) return '[redacted]'
    return val
  }, 2))
}

function queueRemotePayload(table: string, data: object, reason: string): void {
  try {
    const line = JSON.stringify({
      queued_at: new Date().toISOString(),
      table,
      reason,
      data
    }) + '\n'
    appendFileSync(getRemoteQueuePath(), line)
  } catch { /* offline queue failure should not break the app */ }
}

function getRemoteQueuePath(): string {
  return join(app.getPath('userData'), 'pending-remote-logs.jsonl')
}

// Lokal log dosyası
function appendLocalLog(data: object): void {
  try {
    const logDir  = app.getPath('logs')
    const logFile = join(logDir, 'dropmedia.log')
    const line    = JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n'

    // Max 5MB — aşarsa eski yarısını sil
    if (existsSync(logFile)) {
      const stat = require('fs').statSync(logFile)
      if (stat.size > 5 * 1024 * 1024) {
        const content = readFileSync(logFile, 'utf8')
        writeFileSync(logFile, content.slice(content.length / 2))
      }
    }
    require('fs').appendFileSync(logFile, line)
  } catch { /* Dosya yazma hatası kritik değil */ }
}

export function getLocalLogPath(): string {
  return join(app.getPath('logs'), 'dropmedia.log')
}
