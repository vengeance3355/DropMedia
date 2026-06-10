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
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, statSync, createWriteStream } from 'fs'
import { get as httpsGet } from 'https'
import { spawn, spawnSync } from 'child_process'
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

function stripBom(s: string): string {
  return s.replace(/^﻿/, '').trim()
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
        res.on('end', () => { try { resolve(JSON.parse(stripBom(data))) } catch (e) { reject(e) } })
        res.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

/**
 * Dayanıklı indirme: stall-watchdog (veri akarken takılırsa kopar), HTTP Range ile
 * resume (yarım kalan bayttan devam), retry (yeni bağlantı). 40MB'de sonsuz asılı
 * kalma sorununu çözer.
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number, mb: number, totalMb: number) => void
): Promise<void> {
  const MAX_ATTEMPTS = 5
  const STALL_MS = 30_000 // 30sn veri gelmezse bağlantı ölü say -> kopar -> retry

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
      const arm = (label: string): void => {
        clearDog()
        watchdog = setTimeout(() => fail(new Error(`İndirme zaman aşımı (${label})`)), STALL_MS)
      }

      const follow = (u: string, redirects: number, from: number): void => {
        if (redirects > 5) { fail(new Error('Çok fazla yönlendirme')); return }
        const headers: Record<string, string> = { 'User-Agent': 'DropMedia-Installer/1.0' }
        if (from > 0) headers.Range = `bytes=${from}-`

        arm('bağlantı')
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

          arm('veri akışı')
          res.on('data', (chunk: Buffer) => {
            done += chunk.length
            arm('veri akışı')
            onProgress(
              total > 0 ? Math.round((done / total) * 100) : -1,
              done / 1024 / 1024,
              total / 1024 / 1024
            )
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
        req.on('timeout', () => fail(new Error('Soket zaman aşımı')))
        req.setTimeout(STALL_MS)
      }

      follow(url, 0, existing)
    }).catch((err: Error) => {
      if (n + 1 >= MAX_ATTEMPTS) throw err
      return new Promise<void>(r => setTimeout(r, 1500 * (n + 1))).then(() => attempt(n + 1))
    })

  // Temiz başlangıç: önceki yarım dosyayı sil; resume yalnız aynı çağrının retry'larında.
  try { if (existsSync(dest)) rmSync(dest) } catch { /* ignore */ }
  return attempt(0)
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

function isDropMediaRunning(): boolean {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DropMedia.exe', '/NH'], { encoding: 'utf8', timeout: 5000 })
    return (r.stdout || '').toLowerCase().includes('dropmedia.exe')
  } catch {
    return false
  }
}

/**
 * DropMedia'yı GÜVENLE sonlandırır ve dosya kilitleri serbest kalana kadar bekler.
 * Eski sürüm yalnızca 1 kez taskkill + sabit 1.5sn bekliyordu; süreç tam ölmeden
 * dosya işlemine geçilince `resources\app.asar` kilitli kalıp recursive silme
 * `ENOTEMPTY` ile patlıyordu (yarım kurulum/yarım kaldırma). Burada:
 *  - tüm DropMedia.exe süreçleri ağaçça (/T) zorla (/F) öldürülür,
 *  - tasklist ile süreç KAYBOLANA kadar beklenir (~15sn'ye kadar),
 *  - Windows'un handle'ları geç bırakması için kısa bir settle eklenir.
 */
async function killDropMedia(): Promise<void> {
  await new Promise<void>(resolve => {
    const p = spawn('taskkill', ['/F', '/T', '/IM', 'DropMedia.exe'], { stdio: 'pipe' })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
  // Süreç tablosundan kaybolana kadar bekle (handle'lar serbest kalsın).
  for (let i = 0; i < 30; i++) {
    if (!isDropMediaRunning()) break
    spawnSync('taskkill', ['/F', '/T', '/IM', 'DropMedia.exe'], { stdio: 'ignore', timeout: 5000 })
    await new Promise(r => setTimeout(r, 500))
  }
  // Kilit serbest bırakma gecikmesi için son bir settle.
  await new Promise(r => setTimeout(r, 1200))
}

/**
 * Dizini/dosyayı kilit ve "boş değil" yarışlarına karşı dayanıklı siler.
 * Node rmSync(maxRetries/retryDelay) EBUSY/ENOTEMPTY/EPERM'de otomatik tekrar
 * eder — `ENOTEMPTY: rmdir` hatasının doğrudan çözümü.
 */
function rmrf(target: string): void {
  if (!existsSync(target)) return
  rmSync(target, { recursive: true, force: true, maxRetries: 25, retryDelay: 400 })
}

// Kalan dizini bir sonraki oturum açılışında siler (kilit reboot'ta serbest
// kalır). MoveFileEx yerine RunOnce — P/Invoke gerektirmez, güvenilir.
function scheduleDeleteOnReboot(target: string): void {
  try {
    spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
      '/v', `DropMediaCleanup${Date.now()}`, '/t', 'REG_SZ',
      '/d', `cmd /c rmdir /s /q "${target}"`, '/f'], { stdio: 'ignore', timeout: 5000 })
  } catch { /* ignore */ }
}

/**
 * Dizini kesinlikle "yoldan çıkarır": önce dayanıklı sil; olmazsa yana taşı
 * (kill sonrası exe ölü olduğundan dizin rename'i çalışır, içteki dosya 3.
 * partice kilitli olsa bile), sonra reboot'ta sil. Böylece kaldırma/kurulum
 * ASLA "ENOTEMPTY" ile patlamaz — kullanıcı bir daha o hatayı görmez.
 */
function forceRemoveDir(dir: string): void {
  if (!existsSync(dir)) return
  try { rmrf(dir); return } catch { /* hâlâ kilitli — yana taşımayı dene */ }
  const aside = `${dir}.old-${Date.now()}`
  try {
    renameSync(dir, aside)
    try { rmrf(aside) } catch { scheduleDeleteOnReboot(aside) }
    return
  } catch { /* taşıma da olmadı (dizin handle'ı açık) — son çare */ }
  try { rmrf(dir) } catch { scheduleDeleteOnReboot(dir) }
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
  // IconLocation exe'nin gömülü ikonunu kullanır → kısayollar + (AUMID eşleşince)
  // toast logosu DropMedia ikonu olur.
  await runPs(`
$sh=New-Object -COM WScript.Shell
$a=$sh.CreateShortcut('${s(desk)}')
$a.TargetPath='${s(exe)}';$a.WorkingDirectory='${s(dir)}';$a.IconLocation='${s(exe)},0';$a.Save()
$b=$sh.CreateShortcut('${s(sm)}')
$b.TargetPath='${s(exe)}';$b.WorkingDirectory='${s(dir)}';$b.IconLocation='${s(exe)},0';$b.Save()
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
  const verData = await httpsGetJson(`${VERSION_URL}?nc=${Date.now()}`) as Record<string, string>
  const version = verData.version || '0.0.0'

  // İndir
  onProgress(2, `DropMedia v${version} indiriliyor...`)
  await downloadFile(`${ZIP_URL}?nc=${Date.now()}`, zipPath, (pct, mb, total) => {
    onProgress(
      Math.round(2 + pct * 0.73),
      `İndiriliyor... ${mb.toFixed(1)} / ${total.toFixed(1)} MB`
    )
  })

  // Çıkart — başarısızlıkta bir kez daha dene (dosya kilidi gibi geçici
  // sebepler), sonra kritik dosyayı doğrula. Yarım kurulumun "tamamlandı"
  // sayılıp version.json yazılması felaket olur.
  const extract = (): Promise<void> => new Promise<void>((resolve, reject) => {
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

  // Eski kurulumu temiz kaldır (çağıran zaten killDropMedia yaptı): kilitli/eski
  // dosya üzerine yazma çakışmasını ve stale dosyaları önler. Kilitliyse
  // forceRemoveDir yana taşır → her hâlükârda temiz dizine extract edilir.
  forceRemoveDir(dir)
  mkdirSync(dir, { recursive: true })

  onProgress(76, 'Dosyalar çıkartılıyor...')
  try {
    await extract()
  } catch {
    onProgress(76, 'Çıkartma tekrar deneniyor...')
    await new Promise(r => setTimeout(r, 2000))
    await extract()
  }

  if (!existsSync(join(dir, 'DropMedia.exe')) || !existsSync(join(dir, 'resources', 'app.asar'))) {
    throw new Error('Kurulum doğrulanamadı: gerekli dosyalar çıkartılamadı. Tekrar deneyin.')
  }

  // Temizle
  try { rmrf(tmpDir) } catch {}

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
  // forceRemoveDir asla throw etmez: silemezse yana taşır / reboot'a planlar.
  // Yarım kaldırma (exe silinip app.asar kalması) + ENOTEMPTY çökmesi biter.
  forceRemoveDir(activeDir)

  onProgress(60, 'Kısayollar siliniyor...')
  const desk = join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop', 'DropMedia.lnk')
  const sm   = join(
    process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DropMedia'
  )
  try { rmrf(desk) } catch {}
  try { rmrf(sm) } catch {}

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
  const reveal = () => {
    if (!win || win.isDestroyed() || win.isVisible()) return
    win.show()
    win.focus()
    app.focus({ steal: true })
  }
  win.on('ready-to-show', reveal)
  // Yedek: renderer beklenenden yavaş hazırlanırsa pencere yine de erken görünsün
  // (NSIS extract + boot sonrası "installer geç açılıyor" algısını azaltır).
  win.webContents.once('dom-ready', reveal)
  setTimeout(reveal, 1200)
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

  // ── Silent modu (UI yok, sadece CI/test) ──────────────────────────────────
  // --update artık UI gösterir + otomatik başlar (aşağıdaki autoStart); böylece
  // kullanıcı "Güncelle"ye basınca installer açılır ve ilerlemeyi görür.
  if (IS_SILENT) {
    try {
      if (getInstalledVersion()) await killDropMedia()
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
      const vd = await httpsGetJson(`${VERSION_URL}?nc=${Date.now()}`) as Record<string, string>
      latestVersion = vd.version || null
      notes = vd.notes || ''
    } catch {}

    const mode =
      !installedVersion                                         ? 'install'  :
      latestVersion && installedVersion !== latestVersion       ? 'update'   :
                                                                  'uptodate'

    // autoStart: app içinden --update ile açıldıysa renderer güncellemeyi otomatik başlatır
    return { mode, installedVersion, latestVersion, installDir: activeDir, notes, autoStart: IS_UPDATE }
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
