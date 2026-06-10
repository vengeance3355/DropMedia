/**
 * installer.ts
 * yt-dlp ve ffmpeg otomatik kurulum/güncelleme — progress IPC ile renderer'a stream edilir
 * Windows ve Linux/macOS desteklenir.
 */

import { get as httpsGet } from 'https'
import { copyFileSync, createWriteStream, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { IpcMain, BrowserWindow } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { logError } from './logger'
import { IS_WIN, getBinDir, getYtDlpBin, getFfmpegBin, getFfprobeBin } from './platform'

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

// İndirici (downloader) aktif iş varken auto-update'i ertelemek için kanca.
let ytDlpBusyCheck: (() => boolean) | null = null
export function setYtDlpBusyCheck(fn: () => boolean): void {
  ytDlpBusyCheck = fn
}

function send(channel: string, data: object) {
  getMainWindow()?.webContents.send(channel, data)
}

function commandExists(command: string): boolean {
  if (IS_WIN) {
    return spawnSync('where', [command], { timeout: 1000 }).status === 0
  }
  return spawnSync('sh', ['-lc', `command -v ${command}`], { timeout: 1000 }).status === 0
}

function hasWorkingFfmpeg(): boolean {
  const local = join(getBinDir(), getFfmpegBin())
  if (existsSync(local)) return spawnSync(local, ['-version'], { timeout: 2000 }).status === 0
  return spawnSync(getFfmpegBin(), ['-version'], { timeout: 2000 }).status === 0
}

// ── Ortak indirme yardımcısı ──────────────────────────────────────────────────

function downloadWithProgress(
  url: string,
  dest: string,
  progressChannel: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (redirectUrl: string) => {
      const file = createWriteStream(dest)

      httpsGet(redirectUrl, { headers: { 'User-Agent': 'DropMedia/1.0' } }, (res) => {
        // Yönlendirme
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          file.close()
          follow(res.headers.location)
          return
        }
        if (res.statusCode !== 200) {
          file.close()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let downloaded = 0

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : -1
          send(progressChannel, {
            percent,
            downloaded: Math.round(downloaded / 1024 / 1024 * 10) / 10,
            total:      Math.round(total      / 1024 / 1024 * 10) / 10
          })
        })

        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error',  (e) => reject(e))
      }).on('error', reject)
    }

    follow(url)
  })
}

// ── yt-dlp güncelleme ─────────────────────────────────────────────────────────

export async function updateYtDlp(): Promise<{ success: boolean; version?: string; error?: string }> {
  const binDir      = getBinDir()
  const binName     = getYtDlpBin()
  const dest        = join(binDir, binName)
  const tempDir     = mkdtempSync(join(tmpdir(), 'dropmedia-ytdlp-'))
  const tempFile    = join(tempDir, binName)
  const downloadUrl = IS_WIN
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

  mkdirSync(binDir, { recursive: true })

  try {
    send('ytdlp-update-progress', { status: 'downloading', percent: 0 })

    await downloadWithProgress(downloadUrl, tempFile, 'ytdlp-update-progress')

    const version = await getVersion(tempFile)
    if (!version || version === 'unknown') throw new Error('yt-dlp version check failed')

    copyFileSync(tempFile, dest)

    send('ytdlp-update-progress', { status: 'done', percent: 100, version })
    rmSync(tempDir, { recursive: true, force: true })
    return { success: true, version }
  } catch (e: unknown) {
    const technical = e instanceof Error ? e.message : String(e)
    const err = friendlyInstallerError('ytdlp', technical)
    send('ytdlp-update-progress', { status: 'error', error: err })
    await logError({
      errorType: 'update',
      errorMessage: err,
      operation: 'update-ytdlp',
      command: `download ${downloadUrl}`,
      stackTrace: e instanceof Error ? e.stack : undefined,
      stderr: technical
    })
    rmSync(tempDir, { recursive: true, force: true })
    return { success: false, error: err }
  }
}

// ── yt-dlp otomatik güncelleme (sessiz, arka plan) ────────────────────────────
//
// Bayat yt-dlp = YouTube'da "requested format is not available" / extractor
// kırılması: platformlar sık değişir, yt-dlp haftalık güncellenir. Kullanıcıya
// hiçbir eylem yaptırmadan, açılışta (ve günde bir) en son sürüme yükseltir.
// Aktif indirme varken ertelenir (çalışan binary'i değiştirmek riskli).

function latestYtDlpTag(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet(
      'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
      { headers: { 'User-Agent': 'DropMedia/1.0', Accept: 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return }
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => {
          try { resolve(String(JSON.parse(data).tag_name || '') || null) } catch { resolve(null) }
        })
        res.on('error', () => resolve(null))
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(10_000, () => req.destroy())
  })
}

let autoUpdateRunning = false

export async function maybeAutoUpdateYtDlp(): Promise<void> {
  if (autoUpdateRunning) return
  autoUpdateRunning = true
  try {
    const local = join(getBinDir(), getYtDlpBin())
    // Yerel binary yoksa ilk kurulumu downloader/installer ayrı yapar; burada
    // yalnızca güncelleme yapılır.
    if (!existsSync(local)) return
    if (ytDlpBusyCheck?.()) return

    const installed = await getVersion(local)
    const latest = await latestYtDlpTag()
    if (!latest || !installed || installed === 'unknown') return
    if (installed === latest) return

    // Sessiz indirme: progress UI'sı yok (kullanıcı fark etmeden güncellenir).
    const tempDir  = mkdtempSync(join(tmpdir(), 'dropmedia-ytdlp-auto-'))
    const tempFile = join(tempDir, getYtDlpBin())
    const url = IS_WIN
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
    try {
      await downloadWithProgress(url, tempFile, '__noop-ytdlp-auto')
      const ver = await getVersion(tempFile)
      if (ver && ver !== 'unknown' && !ytDlpBusyCheck?.()) {
        copyFileSync(tempFile, local)
        send('ytdlp-update-progress', { status: 'auto-updated', version: ver })
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  } catch {
    // Sessiz: auto-update başarısızlığı kullanıcıyı ilgilendirmez (manuel
    // güncelleme Ayarlar'dan hâlâ mümkün).
  } finally {
    autoUpdateRunning = false
  }
}

// ── ffmpeg otomatik kurulum ───────────────────────────────────────────────────

export async function installFfmpeg(): Promise<{ success: boolean; error?: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'dropmedia-ffmpeg-'))

  try {
    if (hasWorkingFfmpeg()) {
      send('ffmpeg-install-progress', { status: 'done' })
      rmSync(tempDir, { recursive: true, force: true })
      return { success: true }
    }

    await installFfmpegWindows(tempDir)

    if (!hasWorkingFfmpeg()) throw new Error('ffmpeg version check failed')

    send('ffmpeg-install-progress', { status: 'done' })
    rmSync(tempDir, { recursive: true, force: true })
    return { success: true }
  } catch (e: unknown) {
    const technical = e instanceof Error ? e.message : String(e)
    const err = friendlyInstallerError('ffmpeg', technical)
    send('ffmpeg-install-progress', { status: 'error', error: err })
    await logError({
      errorType: 'update',
      errorMessage: err,
      operation: 'install-ffmpeg',
      stackTrace: e instanceof Error ? e.stack : undefined,
      stderr: technical
    })
    rmSync(tempDir, { recursive: true, force: true })
    return { success: false, error: err }
  }
}

// ── Windows: ZIP indirme + PowerShell extract ─────────────────────────────────

async function installFfmpegWindows(tempDir: string): Promise<void> {
  const FFMPEG_URL = 'https://github.com/BtbN/ffmpeg-builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'
  const zipPath    = join(tempDir, 'ffmpeg.zip')
  const extractDir = join(tempDir, 'extract')
  const binDir     = getBinDir()

  mkdirSync(binDir, { recursive: true })
  mkdirSync(extractDir, { recursive: true })

  send('ffmpeg-install-progress', { status: 'downloading', percent: 0 })

  await downloadWithProgress(FFMPEG_URL, zipPath, 'ffmpeg-install-progress')
  if (!existsSync(zipPath) || statSync(zipPath).size < 1024 * 1024) {
    throw new Error('Downloaded ffmpeg archive is missing or too small')
  }

  send('ffmpeg-install-progress', { status: 'extracting', percent: 100 })

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`
    ])
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Extract failed (${code}): ${stderr}`)))
    proc.on('error', reject)
  })

  const ffmpegExe  = findExeInDir(extractDir, 'ffmpeg.exe')
  const ffprobeExe = findExeInDir(extractDir, 'ffprobe.exe')

  if (!ffmpegExe)  throw new Error('ffmpeg.exe not found after extraction')
  if (!ffprobeExe) throw new Error('ffprobe.exe not found after extraction')

  copyFileSync(ffmpegExe,  join(binDir, 'ffmpeg.exe'))
  copyFileSync(ffprobeExe, join(binDir, 'ffprobe.exe'))
}

function findExeInDir(dir: string, name: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
        return join(dir, entry.name)
      }
      if (entry.isDirectory()) {
        const found = findExeInDir(join(dir, entry.name), name)
        if (found) return found
      }
    }
  } catch { /* ignore */ }
  return null
}

function friendlyInstallerError(tool: 'ffmpeg' | 'ytdlp', detail: string): string {
  const text = detail.toLowerCase()
  const name = tool === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp'

  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('etimedout') || text.includes('econnreset') || text.includes('socket hang up')) {
    return `${name} sunucusuna ulaşılamadı. İnternet bağlantısını kontrol edip tekrar deneyin.`
  }
  if (text.includes('http 403') || text.includes('http 404') || text.includes('http 5')) {
    return `${name} indirme sunucusu şu anda dosyayı vermedi. Daha sonra tekrar deneyin.`
  }
  if (text.includes('tar exit') || text.includes('archive') || text.includes('extraction') || text.includes('too small') || text.includes('extract failed')) {
    return 'ffmpeg otomatik indirilemedi. İnternet/DNS erişimi kesilmiş olabilir; tekrar deneyin.'
  }
  if (text.includes('eacces') || text.includes('permission')) {
    return `${name} kurulumu için hedef dizine yazılamadı. İzinleri kontrol edin.`
  }
  if (text.includes('version check failed')) {
    return `${name} indirildi ancak çalıştırılamadı. Dosya bozuk olabilir; tekrar deneyin.`
  }
  return `${name} kurulumu tamamlanamadı. Teknik ayrıntılar admin loguna kaydedildi.`
}

function getVersion(bin: string, args = ['--version']): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args)
    let v = ''
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // Bozuk binary asılırsa sürüm kontrolü sonsuza dek beklemesin.
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      finish('unknown')
    }, 8000)
    proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
    proc.on('close', () => finish(v || 'unknown'))
    proc.on('error', () => finish('unknown'))
  })
}

// ── IPC kurulumu ──────────────────────────────────────────────────────────────

export function setupInstallerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('update-ytdlp',   () => updateYtDlp())
  ipcMain.handle('install-ffmpeg', () => installFfmpeg())
}
