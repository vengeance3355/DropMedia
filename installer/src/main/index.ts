/**
 * DropMedia Installer — main process
 *
 * Flags:
 *   --update                  : uygulama içinden güncelleme akışı, otomatik başlar
 *   --install-path=<dir>      : hedef dizin (--update ile birlikte kullanılır)
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync } from 'fs'
import { spawn } from 'child_process'
import { is } from '@electron-toolkit/utils'

// ── Başlangıç parametreleri ──────────────────────────────────────────────────

const rawArgs = process.argv.slice(app.isPackaged ? 1 : 2)
const IS_UPDATE_MODE  = rawArgs.includes('--update')
const IS_SILENT_MODE  = rawArgs.includes('--silent')  // UI olmadan direkt kur
const installPathArg  = rawArgs.find(a => a.startsWith('--install-path='))

const LOCAL_APPDATA = process.env.LOCALAPPDATA
  || join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local')
const DEFAULT_INSTALL_DIR = join(LOCAL_APPDATA, 'DropMedia')

let activeInstallDir = installPathArg
  ? installPathArg.split('=').slice(1).join('=')
  : DEFAULT_INSTALL_DIR

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DropMedia'

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function getResourcesPath(): string {
  if (!app.isPackaged) return join(__dirname, '../../resources')
  // SFX'ten çıkarılan exe: process.resourcesPath doğru çalışır
  // ASAR'sız paket: resources/ klasörü exe ile aynı dizinde
  if (existsSync(join(process.resourcesPath, 'dropmedia-app.zip'))) {
    return process.resourcesPath
  }
  // Fallback: exe yanındaki resources/ klasörü
  const exeDir = join(process.execPath, '..')
  return join(exeDir, 'resources')
}

function getBundledVersion(): string {
  try {
    const data = JSON.parse(readFileSync(join(getResourcesPath(), 'dropmedia-version.json'), 'utf8'))
    return data.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function getInstalledVersion(dir: string): string | null {
  const vf = join(dir, 'version.json')
  if (!existsSync(vf)) return null
  try {
    return JSON.parse(readFileSync(vf, 'utf8')).version || null
  } catch {
    return null
  }
}

function runPsCommand(script: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

function runRegCommand(cmd: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { stdio: 'pipe' })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

// ── Kurulum mantığı ──────────────────────────────────────────────────────────

async function performInstall(
  installDir: string,
  onProgress: (pct: number, status: string) => void
): Promise<void> {
  const zipPath = join(getResourcesPath(), 'dropmedia-app.zip')
  if (!existsSync(zipPath)) throw new Error('Uygulama paketi (dropmedia-app.zip) bulunamadı.')

  onProgress(2, 'Klasör oluşturuluyor...')
  mkdirSync(installDir, { recursive: true })

  onProgress(8, 'Dosyalar çıkartılıyor...')

  // PowerShell ile extract — Windows'ta en güvenilir, app.asar gibi binary dosyalarda sorun çıkarmaz
  await new Promise<void>((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${installDir}' -Force`
    ], { stdio: 'pipe' })
    let stderr = ''
    ps.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    let pct = 8
    const ticker = setInterval(() => { pct = Math.min(pct + 3, 74); onProgress(pct, 'Dosyalar çıkartılıyor...') }, 800)
    ps.on('close', code => {
      clearInterval(ticker)
      if (code === 0) resolve()
      else reject(new Error(`Extract başarısız (${code}): ${stderr}`))
    })
    ps.on('error', e => { clearInterval(ticker); reject(e) })
  })

  onProgress(78, 'Sürüm bilgisi yazılıyor...')
  writeFileSync(join(installDir, 'version.json'), JSON.stringify({ version: getBundledVersion() }, null, 2))

  onProgress(82, 'Kayıt defteri güncelleniyor...')
  const exePath = join(installDir, 'DropMedia.exe')
  const ver = getBundledVersion()
  await Promise.all([
    runRegCommand(`reg add "${REG_KEY}" /v "DisplayName"    /t REG_SZ    /d "DropMedia"          /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "DisplayVersion" /t REG_SZ    /d "${ver}"              /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "InstallLocation"/t REG_SZ    /d "${installDir}"       /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "UninstallString"/t REG_SZ    /d "\\"${exePath}\\" --uninstall" /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "Publisher"      /t REG_SZ    /d "DropMedia"           /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "NoModify"       /t REG_DWORD /d 1                     /f`),
    runRegCommand(`reg add "${REG_KEY}" /v "NoRepair"       /t REG_DWORD /d 1                     /f`)
  ])

  onProgress(90, 'Kısayollar oluşturuluyor...')
  const desktopLnk = join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop', 'DropMedia.lnk')
  const startMenuDir = join(
    process.env.APPDATA || join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DropMedia'
  )
  mkdirSync(startMenuDir, { recursive: true })
  const startMenuLnk = join(startMenuDir, 'DropMedia.lnk')

  const safeExe = exePath.replace(/'/g, "''")
  const safeDir = installDir.replace(/'/g, "''")
  await runPsCommand(`
$sh = New-Object -comObject WScript.Shell
$s1 = $sh.CreateShortcut('${desktopLnk.replace(/'/g, "''")}')
$s1.TargetPath = '${safeExe}'; $s1.WorkingDirectory = '${safeDir}'; $s1.Save()
$s2 = $sh.CreateShortcut('${startMenuLnk.replace(/'/g, "''")}')
$s2.TargetPath = '${safeExe}'; $s2.WorkingDirectory = '${safeDir}'; $s2.Save()
`.trim())

  onProgress(100, 'Tamamlandı.')
}

async function killDropMedia(installDir: string): Promise<void> {
  const exePath = join(installDir, 'DropMedia.exe')
  return new Promise((resolve) => {
    const proc = spawn('taskkill', ['/F', '/IM', 'DropMedia.exe'], { stdio: 'pipe' })
    proc.on('close', () => {
      if (existsSync(exePath)) {
        setTimeout(resolve, 1500)
      } else {
        resolve()
      }
    })
    proc.on('error', () => resolve())
  })
}

function launchDropMedia(installDir: string): void {
  const exePath = join(installDir, 'DropMedia.exe')
  if (existsSync(exePath)) {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
  }
}

// ── Pencere ──────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    show: false,
    icon: join(getResourcesPath(), 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win?.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendToRenderer(channel: string, data: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()

  const installedVersion = getInstalledVersion(activeInstallDir)
  const bundledVersion   = getBundledVersion()
  const mode = IS_UPDATE_MODE || (installedVersion !== null && installedVersion !== bundledVersion)
    ? 'update'
    : 'install'

  // Silent mod: UI olmadan direkt kur (test / CI için)
  if (IS_SILENT_MODE) {
    performInstall(activeInstallDir, (pct, status) => {
      process.stdout.write(`\r[${String(pct).padStart(3)}%] ${status}                    `)
    }).then(() => {
      process.stdout.write('\n✓ Kurulum tamamlandı: ' + activeInstallDir + '\n')
      launchDropMedia(activeInstallDir)
      setTimeout(() => app.quit(), 500)
    }).catch(e => {
      process.stderr.write('\nHata: ' + String(e) + '\n')
      app.exit(1)
    })
    return
  }

  ipcMain.handle('installer-info', () => ({
    mode,
    installedVersion,
    bundledVersion,
    installDir: activeInstallDir,
    autoStart: IS_UPDATE_MODE
  }))

  ipcMain.handle('installer-select-dir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('installer-start', async (_e, targetDir?: string) => {
    if (targetDir) activeInstallDir = targetDir

    // Güncelleme modunda önce DropMedia'yı kapat
    if (mode === 'update') {
      sendToRenderer('installer-progress', { pct: 0, status: 'DropMedia kapatılıyor...' })
      await killDropMedia(activeInstallDir)
    }

    try {
      await performInstall(activeInstallDir, (pct, status) => {
        sendToRenderer('installer-progress', { pct, status })
      })
      sendToRenderer('installer-done', { success: true })
    } catch (e) {
      sendToRenderer('installer-done', {
        success: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })

  ipcMain.handle('installer-launch-and-quit', () => {
    launchDropMedia(activeInstallDir)
    setTimeout(() => app.quit(), 500)
  })

  ipcMain.on('window-close', () => app.quit())
})

app.on('window-all-closed', () => app.quit())
