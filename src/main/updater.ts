/**
 * updater.ts
 * Sürüm kontrolü stable/version.json'dan yapılır.
 * Güncellemeyi UYGULAMA İNDİRMEZ: kurulum dizinindeki DropMedia-Installer.exe'yi
 * --update ile açar; installer GitHub'dan en son sürümü indirir, kurar, yeniden başlatır.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { is } from '@electron-toolkit/utils'
import { logError } from './logger'

const VERSION_URL = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/version.json'
const INSTALLER_URL = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/DropMedia-Installer.exe'

interface ReleaseInfo {
  version: string
  notes: string
}

function stripBom(s: string): string {
  return s.replace(/^﻿/, '').trim()
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
          try { resolve(JSON.parse(stripBom(data))) } catch (e) { reject(e) }
        })
      }).on('error', reject)
    }
    follow(url)
  })
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    // tag 'stable' sabit olduğundan sürüm karşılaştırması version.json'dan yapılır
    const verData = await httpsGetJson(VERSION_URL) as Record<string, unknown>
    const latestVersion = String(verData.version || '')
    if (!latestVersion) return null

    const currentVersion = app.getVersion()
    if (latestVersion === currentVersion) return null

    return { version: latestVersion, notes: String(verData.notes || '') }
  } catch {
    return null
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const file = createWriteStream(dest)
      httpsGet(u, { headers: { 'User-Agent': 'DropMedia/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          file.close(); follow(res.headers.location); return
        }
        if (res.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${res.statusCode}`)); return }
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

  // "Güncelle": gerçek NSIS installer'ı (kendi app.asar'ını taşıyan self-extractor)
  // HER ZAMAN stable'dan indirip çalıştırır. Kurulum dizinine kopyalanan exe YANLIŞ:
  // o exe app'in resources/app.asar'ını yükleyip installer yerine app'i açar
  // (bu yüzden eski sürümlerde "Güncelle" sadece uygulamayı yeniden başlatıyordu).
  ipcMain.handle('install-update', async () => {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const installDir   = join(localAppData, 'DropMedia')

    let installerExe: string
    try {
      const tmp = join(tmpdir(), 'dropmedia-update')
      mkdirSync(tmp, { recursive: true })
      installerExe = join(tmp, 'DropMedia-Installer.exe')
      await downloadFile(`${INSTALLER_URL}?nc=${Date.now()}`, installerExe)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send({ type: 'error', error: 'Güncelleyici indirilemedi: ' + msg })
      void logError({ errorType: 'update', errorMessage: 'Installer indirilemedi: ' + msg, operation: 'install-update-download' })
      return
    }

    // Installer DropMedia'yı kapatır, GitHub'dan en son sürümü indirir, kurar, yeniden başlatır.
    spawn(installerExe, ['--update', `--install-path=${installDir}`], {
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
