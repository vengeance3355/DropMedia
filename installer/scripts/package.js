/**
 * installer/scripts/package.js
 *
 * 1. Ana projenin win-unpacked/ klonlanır, ASAR installer koduyla değiştirilir
 * 2. 7zip ile sıkıştırılır
 * 3. 7zip SFX modülü + config + arşiv birleştirilerek tek DropMedia-Installer.exe üretilir
 */

const { spawnSync } = require('child_process')
const path  = require('path')
const fs    = require('fs')

const installerRoot = path.resolve(__dirname, '..')
const projectRoot   = path.resolve(installerRoot, '..')

const srcUnpacked   = path.join(projectRoot,   'release', 'win-unpacked')
const installerOut  = path.join(installerRoot, 'out')
const installerRes  = path.join(installerRoot, 'resources')
const releaseDir    = path.join(installerRoot, 'release')
const stagedDir     = path.join(releaseDir, '_staged')        // geçici klasör
const archivePath   = path.join(releaseDir, '_installer.7z')  // ara arşiv
const finalExe      = path.join(releaseDir, 'DropMedia-Installer.exe')

const SFX_MODULE    = 'C:\\Program Files\\7-Zip\\7z.sfx'
const SEVEN_ZIP_EXE = 'C:\\Program Files\\7-Zip\\7z.exe'

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function cp(src, dst) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const e of fs.readdirSync(src)) cp(path.join(src, e), path.join(dst, e))
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

function run(cmd, args, opts = {}) {
  console.log(`  > ${path.basename(cmd)} ${args.slice(0, 4).join(' ')}...`)
  const r = spawnSync(cmd, args, { cwd: opts.cwd || installerRoot, stdio: 'inherit', shell: false })
  if (r.status !== 0) { console.error(`Başarısız: ${cmd}`); process.exit(1) }
}

// ── Ana akış ─────────────────────────────────────────────────────────────────

function main() {
  // Kontroller
  for (const [p, label] of [
    [srcUnpacked,  'win-unpacked (ana proje dist:win)'],
    [installerOut, 'installer/out (npm run build)'],
    [path.join(installerRes, 'dropmedia-app.zip'),      'dropmedia-app.zip'],
    [path.join(installerRes, 'dropmedia-version.json'), 'dropmedia-version.json'],
    [SFX_MODULE,   '7z.sfx (7-Zip kurulu olmalı)'],
    [SEVEN_ZIP_EXE,'7z.exe (7-Zip kurulu olmalı)']
  ]) {
    if (!fs.existsSync(p)) { console.error(`Eksik: ${label}\n  (${p})`); process.exit(1) }
  }

  // Temizlik
  for (const p of [stagedDir, archivePath, finalExe]) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }
  fs.mkdirSync(releaseDir, { recursive: true })

  // 1. Staged klasörü oluştur
  console.log('\nStaged klasör hazırlanıyor...')
  cp(srcUnpacked, stagedDir)

  // 2. ASAR'ı kaldır, installer kodunu ekle
  for (const name of ['app.asar', 'app.asar.unpacked', 'app-update.yml']) {
    const p = path.join(stagedDir, 'resources', name)
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }

  const appDir = path.join(stagedDir, 'resources', 'app')
  fs.mkdirSync(appDir, { recursive: true })

  const pkg = JSON.parse(fs.readFileSync(path.join(installerRoot, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version,
    main: 'out/main/index.js',
    productName: 'DropMedia Installer'
  }, null, 2))

  cp(installerOut, path.join(appDir, 'out'))

  const admZipSrc = path.join(installerRoot, 'node_modules', 'adm-zip')
  if (fs.existsSync(admZipSrc)) {
    cp(admZipSrc, path.join(appDir, 'node_modules', 'adm-zip'))
  }

  // 3. Kaynakları kopyala
  console.log('Kaynaklar ekleniyor...')
  for (const fname of ['dropmedia-app.zip', 'dropmedia-version.json']) {
    fs.copyFileSync(
      path.join(installerRes, fname),
      path.join(stagedDir, 'resources', fname)
    )
  }

  // 4. DropMedia.exe → DropMedia-Installer.exe
  const srcExe = path.join(stagedDir, 'DropMedia.exe')
  const dstExe = path.join(stagedDir, 'DropMedia-Installer.exe')
  if (fs.existsSync(srcExe)) fs.renameSync(srcExe, dstExe)
  else {
    const exes = fs.readdirSync(stagedDir).filter(f => f.endsWith('.exe'))
    if (exes.length > 0) fs.renameSync(path.join(stagedDir, exes[0]), dstExe)
  }

  // 5. 7zip ile sıkıştır
  console.log('\n7zip ile sıkıştırılıyor...')
  run(SEVEN_ZIP_EXE, [
    'a', '-t7z', '-mx=5', '-mmt=on',
    archivePath, path.join(stagedDir, '*')
  ])

  // 6. SFX config oluştur
  const sfxConfig = path.join(releaseDir, '_sfxconfig.txt')
  fs.writeFileSync(sfxConfig,
    ';!@Install@!UTF-8!\r\n' +
    'Title="DropMedia"\r\n' +
    'GUIMode="2"\r\n' +
    'ExtractTitle="DropMedia kuruluyor..."\r\n' +
    'ExtractDialogText="Lütfen bekleyin"\r\n' +
    'ExecuteFile="DropMedia-Installer.exe"\r\n' +  // ShellExecute yerine CreateProcess
    ';!@InstallEnd@!\r\n',
    'utf8'
  )

  // 7. SFX modülü + config + arşiv → tek exe (Node.js ile binary concat)
  console.log('Tek exe birleştiriliyor...')
  const parts = [SFX_MODULE, sfxConfig, archivePath]
  const buffers = parts.map(p => fs.readFileSync(p))
  fs.writeFileSync(finalExe, Buffer.concat(buffers))

  // Temizlik
  fs.rmSync(stagedDir,   { recursive: true, force: true })
  fs.rmSync(archivePath, { force: true })
  fs.rmSync(sfxConfig,   { force: true })

  const sizeMb = (fs.statSync(finalExe).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ Tek exe hazır: installer/release/DropMedia-Installer.exe (${sizeMb} MB)`)
}

main()
