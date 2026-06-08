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

const GITHUB_API = 'https://api.github.com/repos/vengeance3355/DropMedia/releases/latest'

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
    const release = await httpsGetJson(GITHUB_API) as Record<string, unknown>
    const latestVersion = (release.tag_name as string).replace(/^v/, '')
    const currentVersion = app.getVersion()
    if (latestVersion === currentVersion) return null

    const assets = release.assets as Array<Record<string, unknown>>
    const installerAsset = assets.find(a => a.name === 'DropMedia-Installer.exe')
    if (!installerAsset) return null

    return {
      version: latestVersion,
      notes: (release.body as string) || '',
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

  let pendingInstallerPath: string | null = null

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
      const installerPath = join(tmpDir, 'DropMedia-Installer.exe')

      send({ type: 'downloading', progress: { percent: 0 } })

      await downloadFile(info.installerUrl, installerPath, (pct) => {
        send({ type: 'downloading', progress: { percent: pct } })
      })

      pendingInstallerPath = installerPath
      send({ type: 'downloaded', info: { version: info.version } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send({ type: 'error', error: msg })
      await logError({ errorType: 'update', errorMessage: msg, operation: 'download-update' })
    }
  })

  ipcMain.handle('install-update', () => {
    if (!pendingInstallerPath || !existsSync(pendingInstallerPath)) {
      send({ type: 'error', error: 'Installer bulunamadı. Tekrar indirmeyi deneyin.' })
      return
    }

    // Mevcut kurulum dizinini hesapla (exe'nin üst klasörü)
    const installPath = join(app.getPath('exe'), '..')

    spawn(pendingInstallerPath, ['--update', `--install-path=${installPath}`], {
      detached: true,
      stdio: 'ignore'
    }).unref()

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
