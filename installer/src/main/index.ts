/**
 * DropMedia Installer — main process (bootstrapper)
 * GitHub'dan indirir, kurar, günceller, kaldırır, onarır.
 *
 * Flags:
 *   --update             : uygulama içinden çağrıldı, otomatik güncelle
 *   --install-path=<dir> : hedef dizin
 *   --silent             : UI olmadan kur (CI/test)
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, createWriteStream } from 'fs'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { is } from '@electron-toolkit/utils'

// ── Sabitler ──────────────────────────────────────────────────────────────────

const LOCAL_APPDATA   = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local')
const DEFAULT_DIR     = join(LOCAL_APPDATA, 'DropMedia')
const VERSION_URL     = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/version.json'
const ZIP_URL         = 'https://github.com/vengeance3355/DropMedia/releases/download/stable/DropMedia-win-x64.zip'
const REG_KEY         = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DropMedia'

// ── Başlangıç parametreleri ───────────────────────────────────────────────────

const rawArgs         = process.argv.slice(app.isPackaged ? 1 : 2)
const IS_UPDATE       = rawArgs.includes('--update')
const IS_SILENT       = rawArgs.includes('--silent')
const installPathArg  = rawArgs.find(a => a.startsWith('--install-path='))
let   activeDir       = installPathArg ? installPathArg.split('=').slice(1).join('=') : DEFAULT_DIR

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function getInstalledVersion(dir = activeDir): string | null {
  try {
    const vf = join(dir, 'version.json')
    if (!existsSync(vf)) return null
    return JSON.parse(readFileSync(vf, 'utf8')).version || null
  } catch { return null }
}

function httpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      httpsGet(u, { headers: { 'User-Agent': 'DropMedia-Installer/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          follow(res.headers.location); return
        }
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        res.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number, mb: number, totalMb: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const file = createWriteStream(dest)
      httpsGet(u, { headers: { 'User-Agent': 'DropMedia-Installer/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          file.close(); follow(res.headers.location); return
        }
        if (res.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${res.statusCode}`)); return }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let done = 0
        res.on('data', (chunk: Buffer) => {
          done += chunk.length
          onProgress(
            total > 0 ? Math.round((done / total) * 100) : -1,
            done / 1024 / 1024,
            total / 1024 / 1024
          )
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

function runCmd(cmd: string): Promise<void> {
  return new Promise(resolve => {
    const p = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { stdio: 'pipe' })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}

function runPs(script: string): Promise<void> {
  return new Promise(resolve => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}

function killDropMedia(): Promise<void> {
  return new Promise(resolve => {
    const p = spawn('taskkill', ['/F', '/IM', 'DropMedia.exe'], { stdio: 'pipe' })
    p.on('close', () => setTimeout(resolve, 1500))
    p.on('error', () => resolve())
  })
}

function launchDropMedia(dir: string): void {
  const exe = join(dir, 'DropMedia.exe')
  if (existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
}

async function createShortcuts(dir: string): Promise<void> {
  const exe  = join(dir, 'DropMedia.exe')
  const desk = join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop', 'DropMedia.lnk')
  const smDir = join(
    process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DropMedia'
  )
  mkdirSync(smDir, { recursive: true })
  const sm = join(smDir, 'DropMedia.lnk')
  const s  = (v: string) => v.replace(/'/g, "''")
  await runPs(`
$sh=New-Object -COM WScript.Shell
$a=$sh.CreateShortcut('${s(desk)}')
$a.TargetPath='${s(exe)}';$a.WorkingDirectory='${s(dir)}';$a.Save()
$b=$sh.CreateShortcut('${s(sm)}')
$b.TargetPath='${s(exe)}';$b.WorkingDirectory='${s(dir)}';$b.Save()
`.trim())
}

async function writeRegistry(dir: string, version: string): Promise<void> {
  const exe = join(dir, 'DropMedia.exe')
  await Promise.all([
    runCmd(`reg add "${REG_KEY}" /v "DisplayName"    /t REG_SZ    /d "DropMedia"    /f`),
    runCmd(`reg add "${REG_KEY}" /v "DisplayVersion" /t REG_SZ    /d "${version}"   /f`),
    runCmd(`reg add "${REG_KEY}" /v "InstallLocation"/t REG_SZ    /d "${dir}"       /f`),
    runCmd(`reg add "${REG_KEY}" /v "UninstallString"/t REG_SZ    /d "\\"${exe}\\" --uninstall" /f`),
    runCmd(`reg add "${REG_KEY}" /v "Publisher"      /t REG_SZ    /d "DropMedia"    /f`),
    runCmd(`reg add "${REG_KEY}" /v "NoModify"       /t REG_DWORD /d 1              /f`),
    runCmd(`reg add "${REG_KEY}" /v "NoRepair"       /t REG_DWORD /d 1              /f`)
  ])
}

// ── Temel operasyonlar ────────────────────────────────────────────────────────

async function performInstall(
  dir: string,
  onProgress: (pct: number, status: string) => void
): Promise<{ version: string }> {
  const tmpDir  = join(tmpdir(), 'dropmedia-install-' + Date.now())
  const zipPath = join(tmpDir, 'DropMedia-win-x64.zip')
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(dir,    { recursive: true })

  // Versiyon bilgisi
  onProgress(0, 'Sürüm bilgisi alınıyor...')
  const verData = await httpsGetJson(VERSION_URL) as Record<string, string>
  const version = verData.version || '0.0.0'

  // İndir
  onProgress(2, `DropMedia v${version} indiriliyor...`)
  await downloadFile(ZIP_URL, zipPath, (pct, mb, total) => {
    onProgress(
      Math.round(2 + pct * 0.73),
      `İndiriliyor... ${mb.toFixed(1)} / ${total.toFixed(1)} MB`
    )
  })

  // Çıkart
  onProgress(76, 'Dosyalar çıkartılıyor...')
  await new Promise<void>((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dir}' -Force`
    ], { stdio: 'pipe' })
    let stderr = ''
    ps.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    let pct = 76
    const tick = setInterval(() => { pct = Math.min(pct + 2, 85); onProgress(pct, 'Dosyalar çıkartılıyor...') }, 1000)
    ps.on('close', code => {
      clearInterval(tick)
      code === 0 ? resolve() : reject(new Error(`Extract başarısız: ${stderr}`))
    })
    ps.on('error', e => { clearInterval(tick); reject(e) })
  })

  // Temizle
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  // Kayıt
  onProgress(88, 'Sürüm bilgisi yazılıyor...')
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version }, null, 2))

  onProgress(92, 'Kayıt defteri güncelleniyor...')
  await writeRegistry(dir, version)

  onProgress(96, 'Kısayollar oluşturuluyor...')
  await createShortcuts(dir)

  onProgress(100, 'Tamamlandı.')
  return { version }
}

async function performUninstall(onProgress: (pct: number, status: string) => void): Promise<void> {
  onProgress(5,  'DropMedia kapatılıyor...')
  await killDropMedia()

  onProgress(20, 'Dosyalar siliniyor...')
  if (existsSync(activeDir)) rmSync(activeDir, { recursive: true, force: true })

  onProgress(60, 'Kısayollar siliniyor...')
  const desk = join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop', 'DropMedia.lnk')
  const sm   = join(
    process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DropMedia'
  )
  try { if (existsSync(desk)) rmSync(desk) } catch {}
  try { if (existsSync(sm))   rmSync(sm, { recursive: true, force: true }) } catch {}

  onProgress(80, 'Kayıt defteri temizleniyor...')
  await runCmd(`reg delete "${REG_KEY}" /f`)

  onProgress(100, 'Kaldırma tamamlandı.')
}

// ── Pencere ───────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 520, height: 640,
    frame: false, transparent: true,
    backgroundColor: '#00000000',
    resizable: false, show: false,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true,
      devTools: true
    }
  })
  win.on('ready-to-show', () => {
    win?.show()
    win?.focus()
    app.focus({ steal: true })
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('Renderer yüklenemedi:', code, desc)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer çöktü:', details)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(ch: string, data: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}

// ── IPC + Başlangıç ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow()

  // ── Silent / update modu (UI yok) ─────────────────────────────────────────
  if (IS_SILENT || IS_UPDATE) {
    if (IS_UPDATE) await killDropMedia()
    try {
      const { version } = await performInstall(activeDir, (pct, status) => {
        process.stdout.write(`\r[${String(pct).padStart(3)}%] ${status}                 `)
      })
      process.stdout.write(`\n✓ ${IS_UPDATE ? 'Güncelleme' : 'Kurulum'} tamamlandı: v${version}\n`)
      if (IS_UPDATE) { launchDropMedia(activeDir); setTimeout(() => app.quit(), 600) }
      else app.quit()
    } catch (e) {
      process.stderr.write(`\nHata: ${e}\n`)
      app.exit(1)
    }
    return
  }

  // ── UI modu ────────────────────────────────────────────────────────────────

  ipcMain.handle('installer-info', async () => {
    const installedVersion = getInstalledVersion()
    let latestVersion: string | null = null
    let notes = ''
    try {
      const vd = await httpsGetJson(VERSION_URL) as Record<string, string>
      latestVersion = vd.version || null
      notes = vd.notes || ''
    } catch {}

    const mode =
      !installedVersion                                         ? 'install'  :
      latestVersion && installedVersion !== latestVersion       ? 'update'   :
                                                                  'uptodate'

    return { mode, installedVersion, latestVersion, installDir: activeDir, notes }
  })

  ipcMain.handle('installer-select-dir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('installer-start', async (_e, targetDir?: string) => {
    if (targetDir) activeDir = targetDir
    if (getInstalledVersion()) {
      send('installer-progress', { pct: 0, status: 'DropMedia kapatılıyor...' })
      await killDropMedia()
    }
    try {
      await performInstall(activeDir, (pct, status) => send('installer-progress', { pct, status }))
      send('installer-done', { success: true, action: 'install' })
    } catch (e) {
      send('installer-done', { success: false, error: String(e), action: 'install' })
    }
  })

  ipcMain.handle('installer-uninstall', async () => {
    try {
      await performUninstall((pct, status) => send('installer-progress', { pct, status }))
      send('installer-done', { success: true, action: 'uninstall' })
    } catch (e) {
      send('installer-done', { success: false, error: String(e), action: 'uninstall' })
    }
  })

  ipcMain.handle('installer-repair', async () => {
    await killDropMedia()
    try {
      await performInstall(activeDir, (pct, status) => send('installer-progress', { pct, status }))
      send('installer-done', { success: true, action: 'repair' })
    } catch (e) {
      send('installer-done', { success: false, error: String(e), action: 'repair' })
    }
  })

  ipcMain.handle('installer-launch-and-quit', () => {
    launchDropMedia(activeDir)
    setTimeout(() => app.quit(), 600)
  })

  ipcMain.on('window-close', () => app.quit())
})

app.on('window-all-closed', () => app.quit())
