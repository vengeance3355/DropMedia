import { spawn, spawnSync } from 'child_process'
import { IpcMain, BrowserWindow, app } from 'electron'
import { existsSync } from 'fs'
import { net } from 'electron'
import Store from 'electron-store'
import { logError, logStat } from './logger'

const store = new Store()
const activeDownloads = new Map<string, ReturnType<typeof spawn>>()

// ── Yol yönetimi ─────────────────────────────────────────────────────────────

function getYtDlpPath(): string {
  const custom = store.get('ytDlpPath') as string | undefined
  if (custom && existsSync(custom)) return custom
  const userBin = `${process.env.HOME}/.local/bin/yt-dlp`
  if (existsSync(userBin)) return userBin
  return 'yt-dlp'
}

function getDownloadDir(): string {
  return (store.get('downloadDir') as string | undefined) || app.getPath('downloads')
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
}

export function hasFfmpeg(): boolean {
  const userBin = `${process.env.HOME}/.local/bin/ffmpeg`
  if (existsSync(userBin)) return true
  try { return spawnSync('ffmpeg', ['-version'], { timeout: 2000 }).status === 0 }
  catch { return false }
}

function getFfmpegPath(): string {
  const userBin = `${process.env.HOME}/.local/bin/ffmpeg`
  return existsSync(userBin) ? userBin : 'ffmpeg'
}

// ── Tor tespiti ───────────────────────────────────────────────────────────────

function isTorRunning(): boolean {
  try {
    const r = spawnSync('curl', ['--proxy', 'socks5://127.0.0.1:9050', '--max-time', '3', '-s', 'https://check.torproject.org/api/ip'], { timeout: 4000 })
    return r.status === 0 && r.stdout?.toString().includes('"IsTor":true')
  } catch { return false }
}

// ── Format builder ────────────────────────────────────────────────────────────

function buildArgs(url: string, opts: DownloadOptions): string[] {
  const { format, outputDir, filename, speedLimit, useTor, subtitles, embedSubs, cookieBrowser } = opts
  const dir    = outputDir || getDownloadDir()
  const output = filename ? `${dir}/${filename}.%(ext)s` : `${dir}/%(title)s [%(id)s].%(ext)s`
  const ffmpeg = hasFfmpeg()
  const args: string[] = ['--newline', '--no-warnings', '--no-part', '-o', output]

  // Tor proxy
  if (useTor) args.push('--proxy', 'socks5://127.0.0.1:9050')

  // Hız limiti
  if (speedLimit && speedLimit > 0) args.push('--limit-rate', `${speedLimit}M`)

  // Cookie
  if (cookieBrowser) args.push('--cookies-from-browser', cookieBrowser)

  // ffmpeg yolu
  if (ffmpeg) args.push('--ffmpeg-location', getFfmpegPath())

  // Altyazı
  if (subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'tr,en')
    if (embedSubs && ffmpeg) args.push('--embed-subs')
  }

  const isAudio = ['mp3', 'm4a', 'aac'].includes(format)

  if (isAudio) {
    args.push('-x', '--audio-format', format, '--audio-quality', '0')
    args.push(url)
    return args
  }

  const heightMap: Record<string, number> = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
  const h = heightMap[format]

  if (ffmpeg) {
    args.push('-f', h ? `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best` : 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
  } else {
    args.push('-f', h ? `best[height<=${h}]/best[height<=${Math.round(h * 1.3)}]/best` : 'best')
  }

  args.push(url)
  return args
}

// ── IPC handler kurulumu ──────────────────────────────────────────────────────

export function setupDownloadHandlers(ipcMain: IpcMain): void {

  // Tekil video bilgisi
  ipcMain.handle('fetch-info', async (_e, url: string) => {
    const cached = getCache(url)
    if (cached) return cached

    return new Promise((resolve, reject) => {
      const proc = spawn(getYtDlpPath(), ['--dump-json', '--no-playlist', '--no-warnings', url])
      let stdout = '', stderr = ''
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('close', (code) => {
        if (code !== 0) {
          const msg = friendlyError(stderr)
          logError({ errorType: 'fetch', errorMessage: msg, stackTrace: stderr, url })
          reject(new Error(msg)); return
        }
        try {
          const info = parseVideoInfo(JSON.parse(stdout))
          setCache(url, info)
          resolve(info)
        } catch { reject(new Error('Video bilgisi işlenemedi.')) }
      })
      proc.on('error', () => reject(new Error('yt-dlp bulunamadı. Ayarlar menüsünden güncelleyin.')))
    })
  })

  // Playlist bilgisi
  ipcMain.handle('fetch-playlist', async (_e, url: string) => {
    return new Promise((resolve, reject) => {
      const proc = spawn(getYtDlpPath(), ['--dump-json', '--yes-playlist', '--no-warnings', '--flat-playlist', url])
      const items: object[] = []
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => {
        const lines = d.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          try { items.push(JSON.parse(line)) } catch { /* skip */ }
        }
      })
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('close', (code) => {
        if (code !== 0) { reject(new Error(friendlyError(stderr))); return }
        resolve(items)
      })
      proc.on('error', () => reject(new Error('yt-dlp bulunamadı.')))
    })
  })

  // İndirme başlat
  ipcMain.handle('start-download', (_e, opts: DownloadOptions) => {
    const { id, url, format } = opts
    const args = buildArgs(url, opts)
    const proc = spawn(getYtDlpPath(), args)
    activeDownloads.set(id, proc)

    const startMs = Date.now()

    proc.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const p = parseProgress(line)
        if (p) getMainWindow()?.webContents.send('download-progress', { id, ...p })
      }
    })
    proc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg) getMainWindow()?.webContents.send('download-log', { id, msg })
    })
    proc.on('close', (code) => {
      activeDownloads.delete(id)
      const success = code === 0
      getMainWindow()?.webContents.send('download-complete', { id, success, code })
      const platform = detectPlatformName(url)
      if (success) logStat({ platform, format, downloadMs: Date.now() - startMs, success: true })
      else { logError({ errorType: 'download', errorMessage: `Exit ${code}`, url, format }); logStat({ platform, format, success: false }) }
    })
    proc.on('error', (e: Error) => {
      activeDownloads.delete(id)
      getMainWindow()?.webContents.send('download-complete', { id, success: false, code: -1 })
      logError({ errorType: 'download', errorMessage: e.message, stackTrace: e.stack, url, format })
    })

    return { started: true }
  })

  // İptal
  ipcMain.handle('cancel-download', (_e, id: string) => {
    const proc = activeDownloads.get(id)
    if (proc) { proc.kill('SIGTERM'); activeDownloads.delete(id); return true }
    return false
  })

  // Format dönüştürme
  ipcMain.handle('convert-file', (_e, { inputPath, outputFormat, outputPath }: { inputPath: string; outputFormat: string; outputPath: string }) => {
    if (!hasFfmpeg()) return { success: false, error: 'ffmpeg kurulu değil' }
    return new Promise((resolve) => {
      const proc = spawn(getFfmpegPath(), ['-i', inputPath, '-y', outputPath])
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('close', (code) => resolve({ success: code === 0, error: code !== 0 ? stderr.slice(-200) : undefined }))
      proc.on('error', (e: Error) => resolve({ success: false, error: e.message }))
    })
  })

  // yt-dlp kontrolü
  ipcMain.handle('check-ytdlp', () =>
    new Promise<string | null>((resolve) => {
      const proc = spawn(getYtDlpPath(), ['--version'])
      let v = ''
      proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
      proc.on('close', (code) => resolve(code === 0 ? v : null))
      proc.on('error', () => resolve(null))
    })
  )

  ipcMain.handle('check-ffmpeg', () => hasFfmpeg())
  ipcMain.handle('check-tor',    () => isTorRunning())
}

// ── Önbellek ──────────────────────────────────────────────────────────────────

const infoCache = new Map<string, { data: object; ts: number }>()
const CACHE_TTL = 1000 * 60 * 30 // 30 dakika

function getCache(url: string): object | null {
  const entry = infoCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) { infoCache.delete(url); return null }
  return entry.data
}

function setCache(url: string, data: object): void {
  infoCache.set(url, { data, ts: Date.now() })
  // Max 50 giriş
  if (infoCache.size > 50) infoCache.delete(infoCache.keys().next().value!)
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function friendlyError(stderr: string): string {
  if (stderr.includes('Unsupported URL'))   return 'Bu URL desteklenmiyor.'
  if (stderr.includes('Private'))           return 'Bu video gizli veya erişim kısıtlı.'
  if (stderr.includes('not a video'))       return 'Bu bağlantı bir video içermiyor.'
  if (stderr.includes('Sign in'))           return 'Bu video giriş gerektiriyor. Cookie ayarını etkinleştirin.'
  if (stderr.includes('rate limit'))        return 'Platform hız sınırı — bir süre bekleyip tekrar deneyin.'
  return stderr.trim().slice(0, 200) || 'Video bilgisi alınamadı.'
}

function detectPlatformName(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('twitter.com') || u.includes('x.com'))   return 'twitter'
  if (u.includes('instagram.com'))  return 'instagram'
  if (u.includes('tiktok.com'))     return 'tiktok'
  if (u.includes('twitch.tv'))      return 'twitch'
  if (u.includes('vimeo.com'))      return 'vimeo'
  return 'other'
}

function parseProgress(line: string): Record<string, unknown> | null {
  const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\S]+)\s+at\s+([\S]+)\s+ETA\s+([\S]+)/)
  if (m) return { percent: parseFloat(m[1]), totalSize: m[2], speed: m[3], eta: m[4] }
  if (line.includes('[download] 100%')) return { percent: 100, totalSize: '', speed: '', eta: '0:00' }
  const m2 = line.match(/\[download\]\s+([\d.]+\w+)\s+at\s+([\S]+)/)
  if (m2) return { percent: -1, totalSize: '?', speed: m2[2], eta: '?' }
  return null
}

interface RawFormat { height?: number; vcodec?: string }
interface RawInfo {
  id: string; title: string; thumbnail: string; duration: number
  uploader: string; webpage_url: string; extractor: string; formats?: RawFormat[]
}

function parseVideoInfo(raw: RawInfo) {
  const ffmpeg  = hasFfmpeg()
  const heights = new Set<number>()
  for (const f of raw.formats ?? []) {
    if (f.height && f.height > 0) heights.add(f.height)
  }

  const std = [2160, 1080, 720, 480, 360]
  const videoQ = std
    .filter(h => heights.size === 0 || [...heights].some(fh => fh >= h))
    .map(h => ({ id: `${h}p`, label: qLabel(`${h}p`), type: 'video' as const }))

  if (videoQ.length === 0) videoQ.push({ id: 'best', label: 'En İyi', type: 'video' })

  const audioQ = ffmpeg
    ? ['mp3', 'm4a', 'aac'].map(id => ({ id, label: qLabel(id), type: 'audio' as const }))
    : [{ id: 'm4a', label: 'M4A', type: 'audio' as const }]

  return {
    id: raw.id, title: raw.title, thumbnail: raw.thumbnail,
    duration: raw.duration, uploader: raw.uploader,
    url: raw.webpage_url, platform: raw.extractor,
    formats: [...videoQ, ...audioQ], hasFfmpeg: ffmpeg
  }
}

function qLabel(f: string): string {
  const map: Record<string, string> = {
    '2160p': '4K', '1080p': 'Full HD', '720p': 'HD', '480p': 'SD', '360p': 'Düşük',
    'best': 'En İyi', 'mp3': 'MP3', 'm4a': 'M4A', 'aac': 'AAC'
  }
  return map[f] ?? f
}

interface DownloadOptions {
  id: string
  url: string
  format: string
  outputDir?: string
  filename?: string
  speedLimit?: number
  useTor?: boolean
  subtitles?: boolean
  embedSubs?: boolean
  cookieBrowser?: string
}
