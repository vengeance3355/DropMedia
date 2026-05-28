import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import Store from 'electron-store'
import { spawnSync } from 'child_process'

const store = new Store()

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
    const userBin = `${process.env.HOME}/.local/bin/yt-dlp`
    const bin = existsSync(userBin) ? userBin : 'yt-dlp'
    const r = spawnSync(bin, ['--version'], { timeout: 2000 })
    return r.stdout?.toString().trim() ?? 'unknown'
  } catch { return 'unknown' }
}

function hasFfmpeg(): boolean {
  try { return spawnSync('ffmpeg', ['-version'], { timeout: 1000 }).status === 0 }
  catch { return false }
}

interface LogPayload {
  device_id:    string
  hostname:     string
  app_version:  string
  os:           string
  url?:         string
  format?:      string
  error_type:   'download' | 'fetch' | 'update' | 'crash' | 'general'
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
  if (!SUPABASE_URL || !SUPABASE_KEY) return   // Key yoksa sessizce atla

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

    await new Promise<void>((resolve) => {
      req.on('response', () => resolve())
      req.on('error', () => resolve())   // Hata olursa sessizce geç
      req.write(JSON.stringify(data))
      req.end()
    })
  } catch { /* Loglama hatası uygulamayı etkilemesin */ }
}

export async function logError(opts: {
  errorType: LogPayload['error_type']
  errorMessage: string
  stackTrace?: string
  url?: string
  format?: string
}): Promise<void> {
  const torEnabled = !!(store.get('torEnabled') as boolean | undefined)

  const payload: LogPayload = {
    device_id:     getDeviceId(),
    hostname:      require('os').hostname(),
    app_version:   app.getVersion(),
    os:            `${process.platform} ${require('os').release()}`,
    url:           opts.url,
    format:        opts.format,
    error_type:    opts.errorType,
    error_message: opts.errorMessage,
    stack_trace:   opts.stackTrace,
    ytdlp_version: getYtDlpVersion(),
    ffmpeg:        hasFfmpeg(),
    tor_enabled:   torEnabled
  }

  // Lokal log dosyasına da yaz (offline debug için)
  appendLocalLog({ level: 'error', ...payload })

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

  await postToSupabase('stats', payload)
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
