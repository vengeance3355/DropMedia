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
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, createWriteStream, promises as fsp } from 'fs'
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
async function downloadFile(
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
  try { if (existsSync(dest)) await fsp.rm(dest, { force: true }) } catch { /* ignore */ }
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

// ── Dosya/süreç yardımcıları ──────────────────────────────────────────────────
// HEPSİ ASYNC: installer'ın main process'i hiçbir zaman bloklanmaz. Önceki
// sürümdeki spawnSync döngüleri + senkron rmSync (büyük ağaçta saniyeler,
// kilitli dosyada retry'larla 10+ sn) event loop'u kilitleyip pencereyi
// "yanıt vermiyor"a düşürüyordu (%20'de donma). Async I/O + canlı progress ile
// pencere hep akıcı kalır.

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Uzun (ama ilerlemesi ölçülemeyen) bir işi sararken progress bar'ı from→to
// arası yavaşça ilerletir → kullanıcı "takıldı" sanmaz, pencere canlı görünür.
async function withHeartbeat<T>(
  from: number, to: number, label: string,
  onProgress: (pct: number, status: string) => void,
  fn: () => Promise<T>
): Promise<T> {
  let pct = from
  onProgress(pct, label)
  const tick = setInterval(() => { pct = Math.min(pct + 1, to); onProgress(pct, label) }, 550)
  try { return await fn() } finally { clearInterval(tick) }
}

function runQuiet(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const t = setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, timeoutMs)
    p.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out }) })
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, stdout: out }) })
  })
}

async function isDropMediaRunning(): Promise<boolean> {
  const r = await runQuiet('tasklist', ['/FI', 'IMAGENAME eq DropMedia.exe', '/NH'], 5000)
  return r.stdout.toLowerCase().includes('dropmedia.exe')
}

/**
 * DropMedia'yı sonlandırır ve süreç tablosundan KAYBOLANA kadar bekler (60sn'ye
 * kadar; askıdaki süreç bazen ilk taskkill'i yemez — tekrarlar). Canlı durum
 * callback'i ile kullanıcı sayaç görür; pencere donmaz. true = kapandı.
 */
async function killDropMedia(onStatus?: (s: string) => void): Promise<boolean> {
  if (!(await isDropMediaRunning())) return true
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    await runQuiet('taskkill', ['/F', '/T', '/IM', 'DropMedia.exe'], 8000)
    await sleep(700)
    if (!(await isDropMediaRunning())) { await sleep(900); return true } // handle settle
    const secs = Math.round((Date.now() - started) / 1000)
    onStatus?.(`DropMedia kapatılıyor... (${secs} sn — kapanmıyorsa pencerelerini elle kapatın)`)
    await sleep(1300)
  }
  return false
}

/** Dayanıklı async silme: kilit/yarışta tekrar dener; ASLA throw etmez. */
async function rmrfAsync(target: string, attempts = 15): Promise<boolean> {
  if (!existsSync(target)) return true
  for (let i = 0; i < attempts; i++) {
    try { await fsp.rm(target, { recursive: true, force: true }); return true }
    catch { await sleep(400) }
  }
  return !existsSync(target)
}

const RUNONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'

// Kalan dizini bir sonraki oturum açılışında siler (kilit reboot'ta serbest kalır).
async function scheduleDeleteOnReboot(target: string): Promise<void> {
  await runQuiet('reg', ['add', RUNONCE_KEY,
    '/v', `DropMediaCleanup${Date.now()}`, '/t', 'REG_SZ',
    '/d', `cmd /c rmdir /s /q "${target}"`, '/f'], 5000)
}

// KRİTİK: kaldırma sırasında AV-kilitli leftover için bu dizinin reboot'ta
// silinmesi planlanmış olabilir. Kullanıcı reboot'tan ÖNCE yeniden kurarsa, o
// RunOnce taze kurulumu silerdi. Kurulumdan sonra TAM bu dizini hedefleyen
// (".old-*" değil) bekleyen RunOnce görevlerini iptal et.
async function clearRebootCleanup(dir: string): Promise<void> {
  const r = await runQuiet('reg', ['query', RUNONCE_KEY], 5000)
  const needle = `"${dir}"`.toLowerCase() // kapanış tırnağı ".old-*"i hariç tutar
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(DropMediaCleanup\d+)\s+REG_SZ\s+(.+?)\s*$/)
    if (m && m[2].toLowerCase().includes(needle)) {
      await runQuiet('reg', ['delete', RUNONCE_KEY, '/v', m[1], '/f'], 5000)
    }
  }
}

type RemoveOutcome = 'removed' | 'scheduled' | 'leftover'

/**
 * Kurulum dizinini güvenle boşaltır — ASLA throw etmez (ENOTEMPTY diyaloğu bitti):
 *  0) Önce version.json + DropMedia.exe tek tek silinir: işlem yarıda kalsa bile
 *     installer bir daha "güncel" YALANI söyleyemez ve bozuk exe kalmaz.
 *  1) Dayanıklı async silme.
 *  2) Olmazsa dizini yana taşı (.old-*) ve onu sil / reboot'ta sil.
 *  3) O da olmazsa: kaldırmada reboot'ta sil; kurulumda kalanların üstüne
 *     -Force extract edilir (allowSchedule=false → RunOnce YENİ kurulumu silmesin).
 */
async function removeInstallDir(dir: string, opts: { allowSchedule: boolean }): Promise<RemoveOutcome> {
  if (!existsSync(dir)) return 'removed'

  for (const f of ['version.json', 'DropMedia.exe']) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    for (let i = 0; i < 10; i++) {
      try { await fsp.rm(p, { force: true }); break } catch { await sleep(300) }
    }
  }

  if (await rmrfAsync(dir, 12)) return 'removed'

  const aside = `${dir}.old-${Date.now()}`
  try {
    await fsp.rename(dir, aside)
    if (!(await rmrfAsync(aside, 5)) && opts.allowSchedule) await scheduleDeleteOnReboot(aside)
    return 'removed' // hedef yol boşaldı — kurulum açısından temiz
  } catch { /* dizin handle'ı açık — son çare */ }

  if (await rmrfAsync(dir, 5)) return 'removed'
  if (opts.allowSchedule) { await scheduleDeleteOnReboot(dir); return 'scheduled' }
  return 'leftover'
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
  // dosya üzerine yazma çakışmasını ve stale dosyaları önler. Kilitliyse yana
  // taşınır → her hâlükârda temiz dizine extract edilir. allowSchedule=false:
  // YENİ kurulumu RunOnce'la silmeyelim.
  await withHeartbeat(70, 75, 'Eski sürüm temizleniyor...', onProgress,
    () => removeInstallDir(dir, { allowSchedule: false }))
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
  await rmrfAsync(tmpDir, 5)

  // Kayıt
  onProgress(88, 'Sürüm bilgisi yazılıyor...')
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version }, null, 2))
  // Bu dizini hedefleyen bekleyen reboot-silme görevini iptal et (taze kurulum
  // reboot'ta kendini silmesin).
  await clearRebootCleanup(dir)

  onProgress(92, 'Kayıt defteri güncelleniyor...')
  await writeRegistry(dir, version)

  onProgress(96, 'Kısayollar oluşturuluyor...')
  await createShortcuts(dir)

  onProgress(100, 'Tamamlandı.')
  return { version }
}

async function performUninstall(onProgress: (pct: number, status: string) => void): Promise<RemoveOutcome> {
  onProgress(5, 'DropMedia kapatılıyor...')
  // Canlı sayaçlı kill (askıdaki süreçte bile pencere donmaz).
  await killDropMedia(s => onProgress(12, s))

  // Silme: heartbeat ile bar 20→58 arası akıcı ilerler (statik %20 donması biter).
  // removeInstallDir ASLA throw etmez: silemezse yana taşır / reboot'a planlar.
  const outcome = await withHeartbeat(20, 58, 'Dosyalar siliniyor...', onProgress,
    () => removeInstallDir(activeDir, { allowSchedule: true }))

  onProgress(62, 'Kısayollar siliniyor...')
  const desk = join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop', 'DropMedia.lnk')
  const sm   = join(
    process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DropMedia'
  )
  await rmrfAsync(desk, 5)
  await rmrfAsync(sm, 5)

  onProgress(82, 'Kayıt defteri temizleniyor...')
  await runCmd(`reg delete "${REG_KEY}" /f`)

  onProgress(100, outcome === 'scheduled'
    ? 'Kaldırıldı. Kalan birkaç dosya yeniden başlatınca silinecek.'
    : 'Kaldırma tamamlandı.')
  return outcome
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

    // IS_UPDATE (in-app "Güncelle"): kurulu sürüm = latest görünse bile (CDN/cache
    // gecikmesi) 'update' moduna zorla — kullanıcı güncelleme istedi, "güncel" deyip
    // boş bırakma. Yeniden kurulum zaten zararsız (temiz extract).
    const mode =
      !installedVersion                                          ? 'install'  :
      IS_UPDATE                                                  ? 'update'   :
      latestVersion && installedVersion !== latestVersion        ? 'update'   :
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
      send('installer-progress', { pct: 4, status: 'DropMedia kapatılıyor...' })
      await killDropMedia(s => send('installer-progress', { pct: 6, status: s }))
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
    send('installer-progress', { pct: 4, status: 'DropMedia kapatılıyor...' })
    await killDropMedia(s => send('installer-progress', { pct: 6, status: s }))
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
