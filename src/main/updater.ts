/**
 * updater.ts
 * Sürüm kontrolü stable/version.json'dan yapılır.
 * Güncellemeyi UYGULAMA İNDİRMEZ: kurulum dizinindeki DropMedia-Installer.exe'yi
 * --update ile açar; installer GitHub'dan en son sürümü indirir, kurar, yeniden başlatır.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { is } from '@electron-toolkit/utils'
import { logError } from './logger'

const VERSION_URL = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/version.json'

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

  // "Güncelle": uygulama hiçbir şey indirmez. Kurulum dizinindeki installer'ı açar.
  // Installer (DropMedia-Installer.exe) kurulum sırasında kendini buraya kopyalar.
  ipcMain.handle('install-update', () => {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const installDir   = join(localAppData, 'DropMedia')
    const installerExe = join(installDir, 'DropMedia-Installer.exe')

    if (!existsSync(installerExe)) {
      send({ type: 'error', error: 'Güncelleyici bulunamadı. Lütfen en son DropMedia-Installer.exe ile bir kez güncelleyin.' })
      void logError({
        errorType: 'update',
        errorMessage: 'Kurulum dizininde DropMedia-Installer.exe yok.',
        operation: 'install-update',
        details: { installerExe }
      })
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
