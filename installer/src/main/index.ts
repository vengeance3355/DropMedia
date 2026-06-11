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
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, createWriteStream, promises as fsp } from 'fs'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { is } from '@electron-toolkit/utils'

// KRİTİK: Electron main process'inde fs asar-yamalıdır — "app.asar" içeren yollar
// sanal KLASÖR gibi davranır. Installer app.asar'ı düz dosya olarak kopyalar/
// siler/stat'lar; yama açıkken copyFile arşivin binlerce sanal dosyasını gerçek
// klasöre "patlatıyor" (kopyalama dakikalarca sürüyor, kurulum bozuluyor) ve
// stat boyutları yalan söylüyor (doğrulama anlamsızlaşıyor). Kapat.
process.noAsar = true

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

function httpsGetJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      const req = httpsGet(u, { headers: { 'User-Agent': 'DropMedia-Installer/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          res.resume()
          follow(res.headers.location); return
        }
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => { try { resolve(JSON.parse(stripBom(data))) } catch (e) { reject(e) } })
        res.on('error', reject)
      })
      req.on('error', reject)
      // TIMEOUT ŞART: bu istek askıda kalırsa installer-info hiç dönmüyor ve
      // arayüz sonsuza dek spinner'da kalıyordu (canlı görüldü). Soket sessiz
      // kalırsa kopar → çağıran catch'iyle akış devam eder.
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Sürüm bilgisi zaman aşımı')))
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
 *
 * /T (tree) KULLANILMAZ: in-app güncellemede installer DropMedia'nın çocuk
 * sürecidir — /T installer'ın kendisini de öldürür (güncelleme sessizce yarıda
 * kalır). DropMedia'nın çocukları (yt-dlp/ffmpeg) kurulum dizinini kilitlemez
 * (Roaming\drop-media\bin altında çalışırlar), tree kill'e gerek yok.
 */
async function killDropMedia(onStatus?: (s: string) => void): Promise<boolean> {
  if (!(await isDropMediaRunning())) return true
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    await runQuiet('taskkill', ['/F', '/IM', 'DropMedia.exe'], 8000)
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
    // aside farklı yol (".old-*"): clearRebootCleanup'ın iğnesi (kapanış tırnaklı
    // tam yol) onu hariç tutar, taze kurulumu silemez → kurulumda da planlamak
    // güvenli; planlamazsak silinemeyen kopyalar diskte sonsuza dek birikir.
    if (!(await rmrfAsync(aside, 5))) await scheduleDeleteOnReboot(aside)
    return 'removed' // hedef yol boşaldı — kurulum açısından temiz
  } catch { /* dizin handle'ı açık — son çare */ }

  if (await rmrfAsync(dir, 5)) return 'removed'
  if (opts.allowSchedule) { await scheduleDeleteOnReboot(dir); return 'scheduled' }
  return 'leftover'
}

// Önceki yarım kalmış staging dizinlerini temizle (crash/elektrik kesintisi
// ".new-*" artığı bırakmış olabilir).
async function cleanupStaleStages(dir: string): Promise<void> {
  try {
    const parent = dirname(dir)
    const prefix = `${basename(dir)}.new-`
    for (const name of await fsp.readdir(parent)) {
      if (name.startsWith(prefix)) await rmrfAsync(join(parent, name), 3)
    }
  } catch { /* ignore */ }
}

// Staging'i, silinemeyen (inatçı leftover) eski dizinin ÜZERİNE dosya dosya
// kopyalar; dosya başına retry. Hata fırlatmaz — sonuç, performInstall'daki
// birebir app.asar boyut doğrulamasıyla denetlenir.
async function copyDirOver(src: string, dst: string): Promise<void> {
  try { await fsp.mkdir(dst, { recursive: true }) } catch { /* ignore */ }
  let names: string[] = []
  try { names = await fsp.readdir(src) } catch { return }
  for (const name of names) {
    const s = join(src, name)
    const d = join(dst, name)
    let isDir = false
    try { isDir = (await fsp.stat(s)).isDirectory() } catch { continue }
    if (isDir) {
      await copyDirOver(s, d)
    } else {
      for (let i = 0; i < 10; i++) {
        try { await fsp.copyFile(s, d); break }
        catch {
          try { await fsp.rm(d, { force: true }) } catch { /* ignore */ }
          await sleep(300)
        }
      }
    }
  }
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

  // Versiyon bilgisi
  onProgress(0, 'Sürüm bilgisi alınıyor...')
  const verData = await httpsGetJson(`${VERSION_URL}?nc=${Date.now()}`) as Record<string, string>
  const version = verData.version || '0.0.0'

  // İndir
  onProgress(2, `DropMedia v${version} indiriliyor...`)
  await downloadFile(`${ZIP_URL}?nc=${Date.now()}`, zipPath, (pct, mb, total) => {
    onProgress(
      Math.round(2 + pct * 0.64),
      `İndiriliyor... ${mb.toFixed(1)} / ${total.toFixed(1)} MB`
    )
  })

  // ── Staged kurulum ─────────────────────────────────────────────────────────
  // Zip ESKİ kurulumun üzerine DEĞİL, her zaman BOŞ bir staging dizinine açılır;
  // eski dizin kaldırılıp staging yerine taşınır. Eski akış kilitli app.asar
  // üzerine extract ederken eski dosya hayatta kalabiliyor, installer yine de
  // version.json'a yeni sürümü yazıyordu → "güncelleme indi ama uygulama hâlâ
  // v1.0.16" vakası. Staging + aşağıdaki birebir boyut doğrulaması bu hata
  // sınıfını tamamen kapatır.
  await cleanupStaleStages(dir)
  const stageDir = `${dir}.new-${Date.now()}` // aynı volume → rename ucuz/atomik
  mkdirSync(stageDir, { recursive: true })

  const extract = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stageDir}' -Force`
    ], { stdio: 'pipe' })
    let stderr = ''
    ps.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    let pct = 68
    const tick = setInterval(() => { pct = Math.min(pct + 2, 78); onProgress(pct, 'Dosyalar çıkartılıyor...') }, 1000)
    ps.on('close', code => {
      clearInterval(tick)
      code === 0 ? resolve() : reject(new Error(`Extract başarısız: ${stderr}`))
    })
    ps.on('error', e => { clearInterval(tick); reject(e) })
  })

  onProgress(68, 'Dosyalar çıkartılıyor...')
  try {
    await extract()
  } catch {
    onProgress(68, 'Çıkartma tekrar deneniyor...')
    await sleep(2000)
    await extract()
  }

  // Staging doğrulaması + yeni app.asar kimliği (yerleştirme sonrası birebir
  // karşılaştırma için boyut kaydedilir).
  const stagedAsar = join(stageDir, 'resources', 'app.asar')
  if (!existsSync(join(stageDir, 'DropMedia.exe')) || !existsSync(stagedAsar)) {
    await rmrfAsync(stageDir, 3)
    throw new Error('Kurulum doğrulanamadı: indirilen paket eksik çıkartıldı. Tekrar deneyin.')
  }
  const stagedAsarSize = statSync(stagedAsar).size

  // İndirme uzun sürmüş olabilir; kullanıcı DropMedia'yı bu arada açtıysa kapat
  // (yerleştirme kilitli dosyaya çarpmasın).
  await withHeartbeat(80, 82, 'DropMedia kapatılıyor...', onProgress, () => killDropMedia())

  // Eski kurulumu kaldır (kilitliyse yana taşınır → hedef yol yine boşalır).
  // allowSchedule=false: bu dizini hedefleyen RunOnce YENİ kurulumu silmesin.
  await withHeartbeat(82, 88, 'Eski sürüm temizleniyor...', onProgress,
    () => removeInstallDir(dir, { allowSchedule: false }))

  // Staging'i yerine koy: hedef yol boşsa atomik rename; inatçı leftover varsa
  // dosya dosya üzerine kopyala (eksik kalan her şeyi doğrulama yakalar).
  onProgress(89, 'Yeni sürüm yerleştiriliyor...')
  let placed = false
  if (!existsSync(dir)) {
    // AV taze extract edilmiş dosyaları birkaç saniye tutabilir → bolca dene;
    // rename başarısı = atomik yerleştirme, copy fallback'e hiç düşülmez.
    for (let i = 0; i < 15 && !placed; i++) {
      try { await fsp.rename(stageDir, dir); placed = true } catch { await sleep(500) }
    }
  }
  if (!placed) {
    await withHeartbeat(89, 91, 'Yeni sürüm kopyalanıyor...', onProgress,
      () => copyDirOver(stageDir, dir))
    await rmrfAsync(stageDir, 5)
  }

  // ── GERÇEK DOĞRULAMA ───────────────────────────────────────────────────────
  // Kurulan app.asar staging'dekiyle birebir aynı boyutta olmalı. Değilse eski
  // sürümün dosyası hayatta demektir: version.json YAZILMAZ (removeInstallDir
  // onu en başta sildi → installer bir daha "güncel" yalanı söyleyemez) ve
  // kullanıcı net bir hata + çözüm yolu görür.
  const finalAsar = join(dir, 'resources', 'app.asar')
  const finalOk = existsSync(join(dir, 'DropMedia.exe')) && existsSync(finalAsar) &&
    statSync(finalAsar).size === stagedAsarSize
  if (!finalOk) {
    throw new Error(
      'Güncelleme dosyaları yerleştirilemedi (eski sürümün dosyaları kilitli görünüyor). ' +
      'Bilgisayarı yeniden başlatıp installer\'ı tekrar çalıştırın.'
    )
  }

  // Temizle
  await rmrfAsync(tmpDir, 5)

  // Kayıt — yalnızca doğrulama geçtikten sonra yazılır.
  onProgress(93, 'Sürüm bilgisi yazılıyor...')
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version }, null, 2))
  // Bu dizini hedefleyen bekleyen reboot-silme görevini iptal et (taze kurulum
  // reboot'ta kendini silmesin).
  await clearRebootCleanup(dir)

  onProgress(95, 'Kayıt defteri güncelleniyor...')
  await writeRegistry(dir, version)

  onProgress(97, 'Kısayollar oluşturuluyor...')
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
  // ── Silent modu (UI yok, sadece CI/test) ──────────────────────────────────
  // Pencere hiç açılmaz (eskiden açılıyordu: hem gereksiz hem de renderer'ın
  // installer-info'su silent kurulumla yarışıyordu). --update UI gösterir +
  // otomatik başlar (aşağıdaki autoStart).
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
  createWindow()

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
