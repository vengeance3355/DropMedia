/**
 * updater.ts
 * Sürüm kontrolü stable/version.json'dan yapılır.
 * Güncellemeyi UYGULAMA İNDİRMEZ: kurulum dizinindeki DropMedia-Installer.exe'yi
 * --update ile açar; installer GitHub'dan en son sürümü indirir, kurar, yeniden başlatır.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'fs'
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
    // tag 'stable' sabit olduğundan sürüm karşılaştırması version.json'dan yapılır.
    // cache-bust şart: CDN bayat version.json verirse banner hiç çıkmıyor.
    const verData = await httpsGetJson(`${VERSION_URL}?nc=${Date.now()}`) as Record<string, unknown>
    const latestVersion = String(verData.version || '')
    if (!latestVersion) return null

    const currentVersion = app.getVersion()
    if (latestVersion === currentVersion) return null

    return { version: latestVersion, notes: String(verData.notes || '') }
  } catch {
    return null
  }
}

/**
 * Dayanıklı indirme (installer'dakiyle aynı desen): stall-watchdog (30sn veri
 * gelmezse kopar), HTTP Range ile resume, 5 denemeye kadar retry. İlerleme
 * callback'i banner'a aktarılır — eskiden 114MB sessizce iniyor, kullanıcı
 * "Güncelle'ye bastım hiçbir şey olmuyor" görüyordu.
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress: (transferred: number, total: number) => void
): Promise<void> {
  const MAX_ATTEMPTS = 5
  const STALL_MS = 30_000

  const attempt = (n: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let existing = 0
      try { existing = existsSync(dest) ? statSync(dest).size : 0 } catch { existing = 0 }

      let settled = false
      let req: ReturnType<typeof httpsGet> | null = null
      let file: ReturnType<typeof createWriteStream> | null = null
      let watchdog: ReturnType<typeof setTimeout> | null = null

      const clearDog = (): void => { if (watchdog) { clearTimeout(watchdog); watchdog = null } }
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearDog()
        try { req?.destroy() } catch { /* ignore */ }
        try { file?.close() } catch { /* ignore */ }
        reject(err)
      }
      const ok = (): void => {
        if (settled) return
        settled = true
        clearDog()
        resolve()
      }
      const arm = (): void => {
        clearDog()
        watchdog = setTimeout(() => fail(new Error('İndirme zaman aşımı')), STALL_MS)
      }

      const follow = (u: string, redirects: number, from: number): void => {
        if (redirects > 5) { fail(new Error('Çok fazla yönlendirme')); return }
        const headers: Record<string, string> = { 'User-Agent': 'DropMedia/1.0' }
        if (from > 0) headers.Range = `bytes=${from}-`

        arm()
        req = httpsGet(u, { headers }, (res) => {
          const code = res.statusCode ?? 0
          if ((code === 301 || code === 302 || code === 307 || code === 308) && res.headers.location) {
            res.resume()
            follow(res.headers.location, redirects + 1, from)
            return
          }
          if (code !== 200 && code !== 206) { res.resume(); fail(new Error(`HTTP ${code}`)); return }

          const resuming = code === 206 && from > 0
          file = createWriteStream(dest, { flags: resuming ? 'a' : 'w' })
          file.on('error', fail)

          const lenHeader = parseInt(res.headers['content-length'] ?? '0', 10)
          const startAt = resuming ? from : 0
          const total = resuming ? startAt + lenHeader : lenHeader
          let done = startAt

          arm()
          res.on('data', (chunk: Buffer) => {
            done += chunk.length
            arm()
            onProgress(done, total)
          })
          res.on('error', fail)
          res.pipe(file)
          file.on('finish', () => {
            const f = file
            file = null
            try { f?.close(() => ok()) } catch { ok() }
          })
        })
        req.on('error', fail)
        req.setTimeout(STALL_MS)
      }

      follow(url, 0, existing)
    }).catch((err: Error) => {
      if (n + 1 >= MAX_ATTEMPTS) throw err
      return new Promise<void>(r => setTimeout(r, 1500 * (n + 1))).then(() => attempt(n + 1))
    })

  // Temiz başlangıç: önceki çağrıdan kalan yarım dosyayı sil (bayat sürüm
  // parçasına resume etmeyelim); resume yalnız bu çağrının retry'larında.
  try { if (existsSync(dest)) rmSync(dest) } catch { /* ignore */ }
  return attempt(0)
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
  let installing = false
  ipcMain.handle('install-update', async () => {
    if (installing) return // çift tık: indirme zaten sürüyor
    installing = true

    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const installDir   = join(localAppData, 'DropMedia')

    let installerExe: string
    try {
      const tmp = join(tmpdir(), 'dropmedia-update')
      mkdirSync(tmp, { recursive: true })
      installerExe = join(tmp, 'DropMedia-Installer.exe')

      let lastSent = 0
      send({ type: 'downloading', progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 } })
      await downloadFile(`${INSTALLER_URL}?nc=${Date.now()}`, installerExe, (transferred, total) => {
        const now = Date.now()
        if (now - lastSent < 250) return // banner'ı boğma
        lastSent = now
        send({
          type: 'downloading',
          progress: {
            percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
            bytesPerSecond: 0,
            total,
            transferred
          }
        })
      })
    } catch (err) {
      installing = false
      const msg = err instanceof Error ? err.message : String(err)
      send({ type: 'error', error: 'Güncelleyici indirilemedi: ' + msg })
      void logError({ errorType: 'update', errorMessage: 'Installer indirilemedi: ' + msg, operation: 'install-update-download' })
      return
    }

    send({ type: 'downloaded' })

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
