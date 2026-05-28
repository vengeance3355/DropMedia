import { spawn, spawnSync } from 'child_process'
import { IpcMain, BrowserWindow, app } from 'electron'
import { existsSync, chmodSync } from 'fs'
import { createWriteStream } from 'fs'
import { get as httpsGet } from 'https'
import Store from 'electron-store'

const store = new Store()
const activeDownloads = new Map<string, ReturnType<typeof spawn>>()

// ── Yol yönetimi ─────────────────────────────────────────────────────────────

function getYtDlpPath(): string {
  const custom = store.get('ytDlpPath') as string | undefined
  if (custom && existsSync(custom)) return custom

  // Öncelik: kullanıcı bin'i (curl/pip ile kurulan güncel sürüm)
  const userBin = `${process.env.HOME}/.local/bin/yt-dlp`
  if (existsSync(userBin)) return userBin

  return 'yt-dlp'
}

function getDownloadDir(): string {
  const saved = store.get('downloadDir') as string | undefined
  return saved || app.getPath('downloads')
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

/** ffmpeg'in sistemde kurulu olup olmadığını kontrol et */
function hasFfmpeg(): boolean {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: 3000 })
    return result.status === 0
  } catch {
    return false
  }
}

// ── Format seçici ─────────────────────────────────────────────────────────────

/**
 * ffmpeg varsa: video+ses ayrı stream'leri birleştirebiliriz → yüksek kalite
 * ffmpeg yoksa: tek stream içinde hem video hem ses barındıran formatı seç
 *   Birçok platform (Twitter/X, TikTok) video+ses ayrı sunar; bunları ffmpeg
 *   olmadan indirmek için `best[height<=N]/best` pattern'i kullanmalıyız.
 */
function buildArgs(url: string, format: string, dir: string, filename?: string): string[] {
  const output = filename ? `${dir}/${filename}.%(ext)s` : `${dir}/%(title)s [%(id)s].%(ext)s`
  const ffmpeg = hasFfmpeg()
  const args = ['--newline', '--no-warnings', '--no-part', '-o', output]

  const isAudio = ['mp3', 'm4a', 'aac'].includes(format)

  if (isAudio) {
    args.push('-x', '--audio-format', format, '--audio-quality', '0')
    args.push(url)
    return args
  }

  const heightMap: Record<string, number> = {
    '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360
  }
  const h = heightMap[format]

  if (ffmpeg) {
    // ffmpeg var → ayrı stream birleştirme + kalite sınırı
    if (h) {
      args.push(
        '-f', `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        '--merge-output-format', 'mp4'
      )
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
    }
  } else {
    // ffmpeg YOK → tek stream, en iyi kalite (video+ses birleşik)
    // Bazı platformlar (X, TikTok) için bu şart
    if (h) {
      args.push('-f', `best[height<=${h}]/best[height<=${h * 1.3}]/best`)
    } else {
      args.push('-f', 'best')
    }
  }

  args.push(url)
  return args
}

// ── İndirme işleyicileri ──────────────────────────────────────────────────────

export function setupDownloadHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('fetch-info', async (_event, url: string) => {
    return new Promise((resolve, reject) => {
      const proc = spawn(getYtDlpPath(), [
        '--dump-json', '--no-playlist', '--no-warnings', url
      ])

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

      proc.on('close', (code) => {
        if (code !== 0) {
          // Hata mesajını kullanıcıya anlamlı şekilde ilet
          const msg = stderr.includes('Unsupported URL')
            ? 'Bu URL desteklenmiyor. Geçerli bir video URL\'si girin.'
            : stderr.includes('Private')
            ? 'Bu video gizli veya erişim kısıtlı.'
            : stderr.includes('not a video')
            ? 'Bu bağlantı bir video içermiyor.'
            : stderr.trim() || 'Video bilgisi alınamadı.'
          reject(new Error(msg))
          return
        }
        try {
          resolve(parseVideoInfo(JSON.parse(stdout)))
        } catch {
          reject(new Error('Video bilgisi işlenemedi.'))
        }
      })

      proc.on('error', () =>
        reject(new Error('yt-dlp bulunamadı. Ayarlar menüsünden kurulum yapın.'))
      )
    })
  })

  ipcMain.handle('start-download', (_event, req: DownloadRequest) => {
    const { id, url, format, outputDir, filename } = req
    const dir = outputDir || getDownloadDir()
    const args = buildArgs(url, format, dir, filename)
    const proc = spawn(getYtDlpPath(), args)
    activeDownloads.set(id, proc)

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        const progress = parseProgress(line)
        if (progress) getMainWindow()?.webContents.send('download-progress', { id, ...progress })
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) getMainWindow()?.webContents.send('download-log', { id, msg })
    })

    proc.on('close', (code) => {
      activeDownloads.delete(id)
      getMainWindow()?.webContents.send('download-complete', {
        id, success: code === 0, code
      })
    })

    proc.on('error', () => {
      activeDownloads.delete(id)
      getMainWindow()?.webContents.send('download-complete', { id, success: false, code: -1 })
    })

    return { started: true }
  })

  ipcMain.handle('cancel-download', (_event, id: string) => {
    const proc = activeDownloads.get(id)
    if (proc) { proc.kill('SIGTERM'); activeDownloads.delete(id); return true }
    return false
  })

  ipcMain.handle('check-ytdlp', () =>
    new Promise<string | null>((resolve) => {
      const proc = spawn(getYtDlpPath(), ['--version'])
      let version = ''
      proc.stdout.on('data', (d: Buffer) => (version += d.toString().trim()))
      proc.on('close', (code) => resolve(code === 0 ? version : null))
      proc.on('error', () => resolve(null))
    })
  )

  ipcMain.handle('check-ffmpeg', () => hasFfmpeg())

  /**
   * yt-dlp güncelleme: -U yerine doğrudan GitHub binary'si indir
   * -U: apt paketi için çalışmaz, ayrıca GitHub rate limit sorunları var
   */
  ipcMain.handle('update-ytdlp', () => updateYtDlpBinary())
}

// ── yt-dlp güncelleme ─────────────────────────────────────────────────────────

function updateYtDlpBinary(): Promise<{ success: boolean; version?: string; error?: string }> {
  const dest = `${process.env.HOME}/.local/bin/yt-dlp`
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

  return new Promise((resolve) => {
    const file = createWriteStream(dest)

    const request = httpsGet(url, { headers: { 'User-Agent': 'DropMedia-Updater' } }, (res) => {
      // GitHub 302 yönlendirmesini takip et
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close()
        const redirectUrl = res.headers.location!
        const redirectReq = httpsGet(redirectUrl, { headers: { 'User-Agent': 'DropMedia-Updater' } }, (r2) => {
          r2.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              try { chmodSync(dest, 0o755) } catch { /* ignore */ }
              const proc = spawn(dest, ['--version'])
              let v = ''
              proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
              proc.on('close', () => resolve({ success: true, version: v }))
              proc.on('error', () => resolve({ success: false, error: 'Binary çalıştırılamadı' }))
            })
          })
        })
        redirectReq.on('error', (e) => resolve({ success: false, error: e.message }))
        return
      }

      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}` })
        return
      }

      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          try { chmodSync(dest, 0o755) } catch { /* ignore */ }
          const proc = spawn(dest, ['--version'])
          let v = ''
          proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
          proc.on('close', () => resolve({ success: true, version: v }))
          proc.on('error', () => resolve({ success: false, error: 'Binary çalıştırılamadı' }))
        })
      })
    })

    request.on('error', (e) => {
      file.close()
      resolve({ success: false, error: e.message })
    })

    file.on('error', (e) => resolve({ success: false, error: e.message }))
  })
}

// ── Progress parser ───────────────────────────────────────────────────────────

function parseProgress(line: string): Record<string, unknown> | null {
  // Normal: [download]  45.2% of 12.34MiB at 1.23MiB/s ETA 00:05
  const m = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+([\S]+)\s+at\s+([\S]+)\s+ETA\s+([\S]+)/
  )
  if (m) return { percent: parseFloat(m[1]), totalSize: m[2], speed: m[3], eta: m[4] }

  // 100%
  if (line.includes('[download] 100%')) return { percent: 100, totalSize: '', speed: '', eta: '0:00' }

  // Bilinmeyen büyüklük (--): [download]    5.00MiB at    1.23MiB/s
  const m2 = line.match(/\[download\]\s+([\d.]+\w+)\s+at\s+([\S]+)/)
  if (m2) return { percent: -1, totalSize: '?', speed: m2[2], eta: '?' }

  return null
}

// ── Video bilgisi parse ───────────────────────────────────────────────────────

interface RawFormat {
  height?: number
  vcodec?: string
  acodec?: string
  ext?: string
  format_id?: string
}

interface RawInfo {
  id: string
  title: string
  thumbnail: string
  duration: number
  uploader: string
  webpage_url: string
  extractor: string
  formats?: RawFormat[]
}

function parseVideoInfo(raw: RawInfo) {
  const ffmpeg = hasFfmpeg()
  const formats = buildAvailableFormats(raw.formats ?? [], ffmpeg)

  return {
    id: raw.id,
    title: raw.title,
    thumbnail: raw.thumbnail,
    duration: raw.duration,
    uploader: raw.uploader,
    url: raw.webpage_url,
    platform: raw.extractor,
    formats,
    hasFfmpeg: ffmpeg
  }
}

function buildAvailableFormats(rawFormats: RawFormat[], ffmpeg: boolean) {
  // Mevcut yükseklikleri bul
  const heights = new Set<number>()
  for (const f of rawFormats) {
    if (f.height && f.height > 0) heights.add(f.height)
  }

  const stdHeights = [2160, 1080, 720, 480, 360]
  const videoFormats: Array<{ id: string; label: string; type: 'video' }> = []

  if (heights.size > 0) {
    for (const h of stdHeights) {
      // Bu yükseklikte veya daha yüksek bir format varsa göster
      const available = [...heights].some((fh) => fh >= h)
      if (available) {
        videoFormats.push({ id: `${h}p`, label: qLabel(`${h}p`), type: 'video' })
      }
    }
    // Hiçbiri eşleşmediyse "en iyi" ekle
    if (videoFormats.length === 0) {
      videoFormats.push({ id: 'best', label: 'En İyi Kalite', type: 'video' })
    }
  } else {
    videoFormats.push({ id: 'best', label: 'En İyi Kalite', type: 'video' })
  }

  // ffmpeg yoksa audio-only formatları sınırla (ses çıkarma için ffmpeg lazım)
  const audioFormats = ffmpeg
    ? ['mp3', 'm4a', 'aac'].map((id) => ({ id, label: qLabel(id), type: 'audio' as const }))
    : [{ id: 'm4a', label: 'M4A (Ses)', type: 'audio' as const }]

  return [...videoFormats, ...audioFormats]
}

function qLabel(f: string): string {
  const map: Record<string, string> = {
    '2160p': '4K (2160p)', '1080p': 'Full HD (1080p)', '720p': 'HD (720p)',
    '480p': 'SD (480p)', '360p': 'Düşük (360p)', 'best': 'En İyi',
    'mp3': 'MP3', 'm4a': 'M4A', 'aac': 'AAC'
  }
  return map[f] ?? f
}

interface DownloadRequest {
  id: string
  url: string
  format: string
  outputDir?: string
  filename?: string
}
