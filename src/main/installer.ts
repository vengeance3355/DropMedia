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

    if (!IS_WIN) chmodSync(tempFile, 0o755)

    const version = await getVersion(tempFile)
    if (!version || version === 'unknown') throw new Error('yt-dlp version check failed')

    copyFileSync(tempFile, dest)
    if (!IS_WIN) chmodSync(dest, 0o755)

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

// ── ffmpeg otomatik kurulum ───────────────────────────────────────────────────

export async function installFfmpeg(): Promise<{ success: boolean; error?: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'dropmedia-ffmpeg-'))

  try {
    if (hasWorkingFfmpeg()) {
      send('ffmpeg-install-progress', { status: 'done' })
      rmSync(tempDir, { recursive: true, force: true })
      return { success: true }
    }

    if (IS_WIN) {
      await installFfmpegWindows(tempDir)
    } else {
      await installFfmpegLinux(tempDir)
    }

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

// ── Linux/macOS: tar.xz indirme ───────────────────────────────────────────────

async function installFfmpegLinux(tempDir: string): Promise<void> {
  const FFMPEG_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
  const tarPath    = join(tempDir, 'ffmpeg-static.tar.xz')
  const extractDir = join(tempDir, 'extract')
  const binDir     = getBinDir()
  const destBin    = join(binDir, 'ffmpeg')
  const destProbe  = join(binDir, 'ffprobe')

  mkdirSync(extractDir, { recursive: true })

  const aptResult = await tryInstallFfmpegWithApt()
  if (aptResult.success) return  // 'done' göndermeyi üst fonksiyon yapar

  send('ffmpeg-install-progress', { status: 'downloading', percent: 0 })

  await downloadWithProgress(FFMPEG_URL, tarPath, 'ffmpeg-install-progress')
  if (!existsSync(tarPath) || statSync(tarPath).size < 1024 * 1024) {
    throw new Error('Downloaded ffmpeg archive is missing or too small')
  }

  send('ffmpeg-install-progress', { status: 'extracting', percent: 100 })

  await new Promise<void>((resolve, reject) => {
    const args = ['-xJf', tarPath, '-C', extractDir, '--strip-components=1', '--wildcards', '--no-anchored', '*/ffmpeg', '*/ffprobe']
    const proc = spawn('tar', args, { stdio: 'pipe' })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exit ${code}\n${stderr}`))
    })
    proc.on('error', reject)
  })

  for (const [src, dst] of [[join(extractDir, 'ffmpeg'), destBin], [join(extractDir, 'ffprobe'), destProbe]] as [string, string][]) {
    if (existsSync(src)) {
      copyFileSync(src, dst)
      chmodSync(dst, 0o755)
    }
  }

  if (!existsSync(destBin) || !existsSync(destProbe)) {
    throw new Error('ffmpeg or ffprobe binary was not found after extraction')
  }
}

function tryInstallFfmpegWithApt(): Promise<{ success: boolean; stderr?: string; code?: number | null }> {
  if (process.platform !== 'linux' || !commandExists('apt-get') || !commandExists('pkexec')) {
    return Promise.resolve({ success: false })
  }

  send('ffmpeg-install-progress', { status: 'system-install', percent: 0 })

  return new Promise((resolve) => {
    const proc = spawn('pkexec', ['apt-get', 'install', '-y', 'ffmpeg'], { stdio: 'pipe' })
    let stderr = ''

    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', (code) => {
      resolve({ success: code === 0 && hasWorkingFfmpeg(), stderr, code })
    })
    proc.on('error', (err) => {
      resolve({ success: false, stderr: err.message, code: null })
    })
  })
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
    proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
    proc.on('close', () => resolve(v || 'unknown'))
    proc.on('error', () => resolve('unknown'))
  })
}

// ── IPC kurulumu ──────────────────────────────────────────────────────────────

export function setupInstallerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('update-ytdlp',   () => updateYtDlp())
  ipcMain.handle('install-ffmpeg', () => installFfmpeg())
}
