/**
 * installer.ts
 * yt-dlp ve ffmpeg otomatik kurulum/güncelleme — progress IPC ile renderer'a stream edilir
 */

import { get as httpsGet, request as httpsRequest } from 'https'
import { createWriteStream, chmodSync, existsSync, mkdirSync } from 'fs'
import { IpcMain, BrowserWindow } from 'electron'
import { spawn } from 'child_process'

const USER_BIN = `${process.env.HOME}/.local/bin`

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function send(channel: string, data: object) {
  getMainWindow()?.webContents.send(channel, data)
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
  const dest = `${USER_BIN}/yt-dlp`
  mkdirSync(USER_BIN, { recursive: true })

  try {
    send('ytdlp-update-progress', { status: 'downloading', percent: 0 })

    await downloadWithProgress(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
      dest,
      'ytdlp-update-progress'
    )

    chmodSync(dest, 0o755)

    const version = await getVersion(dest)
    send('ytdlp-update-progress', { status: 'done', percent: 100, version })
    return { success: true, version }
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e)
    send('ytdlp-update-progress', { status: 'error', error: err })
    return { success: false, error: err }
  }
}

// ── ffmpeg otomatik kurulum ───────────────────────────────────────────────────

export async function installFfmpeg(): Promise<{ success: boolean; error?: string }> {
  // Linux: John Van Sickle'ın static build'ini kullan (tam bağımsız binary)
  const FFMPEG_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
  const tarPath    = `/tmp/ffmpeg-static.tar.xz`
  const destBin    = `${USER_BIN}/ffmpeg`
  const destProbe  = `${USER_BIN}/ffprobe`

  mkdirSync(USER_BIN, { recursive: true })

  try {
    send('ffmpeg-install-progress', { status: 'downloading', percent: 0 })

    await downloadWithProgress(FFMPEG_URL, tarPath, 'ffmpeg-install-progress')

    send('ffmpeg-install-progress', { status: 'extracting', percent: 100 })

    // tar xJf ile çıkar, ffmpeg ve ffprobe binary'lerini bul ve kopyala
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', ['xJf', tarPath, '--wildcards', '--no-anchored', 'ffmpeg', 'ffprobe', '-C', '/tmp/ffmpeg-extract', '--strip-components=1'], {
        stdio: 'pipe'
      })

      // /tmp/ffmpeg-extract dizinini önceden oluştur
      mkdirSync('/tmp/ffmpeg-extract', { recursive: true })

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exit ${code}`))
      })
      proc.on('error', reject)
    })

    // Binary'leri taşı ve izin ver
    for (const [src, dst] of [['/tmp/ffmpeg-extract/ffmpeg', destBin], ['/tmp/ffmpeg-extract/ffprobe', destProbe]]) {
      if (existsSync(src)) {
        const { copyFileSync } = await import('fs')
        copyFileSync(src, dst)
        chmodSync(dst, 0o755)
      }
    }

    send('ffmpeg-install-progress', { status: 'done' })
    return { success: true }
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e)
    send('ffmpeg-install-progress', { status: 'error', error: err })
    return { success: false, error: err }
  }
}

function getVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'])
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
