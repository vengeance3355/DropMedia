/**
 * updater.ts
 * GitHub releases API ile sürüm kontrolü + Electron installer ile güncelleme.
 * electron-updater kullanılmaz; tek release asset: DropMedia-Installer.exe
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { is } from '@electron-toolkit/utils'
import { logError } from './logger'

const VERSION_URL   = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/version.json'
const RELEASE_API   = 'https://api.github.com/repos/vengeance3355/DropMedia/releases/tags/stable'
const ZIP_URL       = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/DropMedia-win-x64.zip'

interface ReleaseInfo {
  version: string
  notes: string
  installerUrl: string
}

function httpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      httpsGet(u, { headers: { 'User-Agent': 'DropMedia/1.0', Accept: 'application/vnd.github.v3+json' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          follow(res.headers.location)
          return
        }
        let data = ''
        res.on('data', (chunk: Buffer) => (data += chunk.toString()))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      }).on('error', reject)
    }
    follow(url)
  })
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    // Versiyon karşılaştırması version.json'dan — tag_name 'stable' olduğundan kullanmıyoruz
    const verData = await httpsGetJson(VERSION_URL) as Record<string, unknown>
    const latestVersion = String(verData.version || '')
    if (!latestVersion) return null

    const currentVersion = app.getVersion()
    if (latestVersion === currentVersion) return null

    // Installer URL için release assets
    const release = await httpsGetJson(RELEASE_API) as Record<string, unknown>
    const assets = release.assets as Array<Record<string, unknown>>
    const installerAsset = assets.find(a => a.name === 'DropMedia-Installer.exe')
    if (!installerAsset) return null

    return {
      version: latestVersion,
      notes: String(verData.notes || ''),
      installerUrl: installerAsset.browser_download_url as string
    }
  } catch {
    return null
  }
}

function downloadFile(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const file = createWriteStream(dest)
      httpsGet(u, { headers: { 'User-Agent': 'DropMedia/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          file.close()
          follow(res.headers.location)
          return
        }
        if (res.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${res.statusCode}`)); return }

        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let downloaded = 0

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          onProgress(total > 0 ? Math.round((downloaded / total) * 100) : -1)
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

export function setupUpdater(window: BrowserWindow): void {
  const send = (data: object) => {
    if (!window.isDestroyed()) window.webContents.send('update-status', data)
  }

  let pendingZipPath: string | null = null

  ipcMain.handle('check-for-updates', async () => {
    send({ type: 'checking' })
    try {
      const info = await fetchLatestRelease()
      if (!info) { send({ type: 'not-available' }); return null }
      send({ type: 'available', info: { version: info.version, releaseNotes: info.notes } })
      return info
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send({ type: 'error', error: msg })
      return null
    }
  })

  ipcMain.handle('download-update', async () => {
    send({ type: 'checking' })
    try {
      const info = await fetchLatestRelease()
      if (!info) { send({ type: 'not-available' }); return }

      const tmpDir = join(tmpdir(), 'dropmedia-update')
      mkdirSync(tmpDir, { recursive: true })
      const zipPath = join(tmpDir, 'DropMedia-win-x64.zip')

      send({ type: 'downloading', progress: { percent: 0 } })

      await downloadFile(ZIP_URL, zipPath, (pct) => {
        send({ type: 'downloading', progress: { percent: pct } })
      })

      pendingZipPath = zipPath
      send({ type: 'downloaded', info: { version: `Hazır - v${info.version}` } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send({ type: 'error', error: msg })
      await logError({ errorType: 'update', errorMessage: msg, operation: 'download-update' })
    }
  })

  ipcMain.handle('install-update', () => {
    if (!pendingZipPath || !existsSync(pendingZipPath)) {
      send({ type: 'error', error: 'Zip bulunamadı. Tekrar indirmeyi deneyin.' })
      return
    }

    const localAppData = process.env.LOCALAPPDATA || join(require('os').homedir(), 'AppData', 'Local')
    const installerExe = join(localAppData, 'DropMedia', 'DropMedia-Installer.exe')
    const installDir   = join(localAppData, 'DropMedia')

    if (existsSync(installerExe)) {
      // Installer kuruluysa, ona bırak (tek indirme: zip zaten var)
      spawn(installerExe, ['--update', `--local-zip=${pendingZipPath}`, `--install-path=${installDir}`], {
        detached: true,
        stdio: 'ignore'
      }).unref()
    } else {
      // Installer kurulu değil, PowerShell ile direkt extract et
      const { spawnSync } = require('child_process')
      spawnSync('taskkill', ['/F', '/IM', 'DropMedia.exe'], { stdio: 'pipe' })
      spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${pendingZipPath}' -DestinationPath '${installDir}' -Force`
      ], { stdio: 'pipe' })
      // Yeniden başlat
      const exe = join(installDir, 'DropMedia.exe')
      if (existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
    }

    app.quit()
  })

  // Uygulama açılışında otomatik kontrol
  if (!is.dev) {
    setTimeout(async () => {
      try {
        const info = await fetchLatestRelease()
        if (info) {
          send({ type: 'available', info: { version: info.version, releaseNotes: info.notes } })
        }
      } catch { /* sessiz hata */ }
    }, 3000)
  }
}
