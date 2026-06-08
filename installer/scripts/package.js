/**
 * installer/scripts/package.js — Bootstrapper SFX oluşturur
 *
 * Bootstrapper'da dropmedia-app.zip YOK.
 * Installer çalışınca GitHub'dan indirir.
 * Sonuç: ~80-90MB (vs önceki 187MB)
 */

const { spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const installerRoot = path.resolve(__dirname, '..')
const projectRoot   = path.resolve(installerRoot, '..')

const srcUnpacked   = path.join(projectRoot,   'release', 'win-unpacked')
const installerOut  = path.join(installerRoot, 'out')
const releaseDir    = path.join(installerRoot, 'release')
const stagedDir     = path.join(releaseDir, '_staged')
const archivePath   = path.join(releaseDir, '_installer.7z')
const finalExe      = path.join(releaseDir, 'DropMedia-Installer.exe')

const SFX_EXE  = 'C:\\Program Files\\7-Zip\\7z.sfx'
const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe'

function cp(s, d) {
  const stat = fs.statSync(s)
  if (stat.isDirectory()) {
    fs.mkdirSync(d, { recursive: true })
    for (const e of fs.readdirSync(s)) cp(path.join(s, e), path.join(d, e))
  } else {
    fs.mkdirSync(path.dirname(d), { recursive: true })
    fs.copyFileSync(s, d)
  }
}

function run(cmd, args) {
  console.log(`  > ${path.basename(cmd)} ${args[0] || ''}`)
  const r = spawnSync(cmd, args, { cwd: installerRoot, stdio: 'inherit' })
  if (r.status !== 0) { console.error(`Başarısız: ${cmd}`); process.exit(1) }
}

function main() {
  // Kontroller
  if (!fs.existsSync(srcUnpacked)) {
    console.error('Hata: win-unpacked bulunamadı. Önce npm run dist:win çalıştırın.')
    process.exit(1)
  }
  if (!fs.existsSync(installerOut)) {
    console.error('Hata: installer/out bulunamadı. Önce npm run build çalıştırın.')
    process.exit(1)
  }
  if (!fs.existsSync(SFX_EXE)) {
    console.error('Hata: 7-Zip kurulu olmalı (C:\\Program Files\\7-Zip).')
    process.exit(1)
  }

  // Temizle
  for (const p of [stagedDir, archivePath, finalExe]) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }

  // 1. win-unpacked kopyala
  console.log('Staged klasör hazırlanıyor...')
  cp(srcUnpacked, stagedDir)

  // 2. DropMedia'nın ASAR'ını kaldır, installer kodunu koy
  for (const f of ['app.asar', 'app.asar.unpacked', 'app-update.yml']) {
    const p = path.join(stagedDir, 'resources', f)
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

  // 3. İkon kopyala
  const iconSrc = path.join(installerRoot, 'resources', 'icon.png')
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(stagedDir, 'resources', 'icon.png'))
  }

  // 4. DropMedia.exe → DropMedia-Installer.exe
  const srcExe = path.join(stagedDir, 'DropMedia.exe')
  const dstExe = path.join(stagedDir, 'DropMedia-Installer.exe')
  if (fs.existsSync(srcExe)) fs.renameSync(srcExe, dstExe)

  // 5. 7zip ile sıkıştır
  console.log('\n7zip sıkıştırılıyor...')
  run(SEVEN_ZIP, ['a', '-t7z', '-mx=5', '-mmt=on', archivePath, path.join(stagedDir, '*')])

  // 6. SFX config
  const sfxConfig = path.join(releaseDir, '_sfx.txt')
  fs.writeFileSync(sfxConfig,
    ';!@Install@!UTF-8!\r\nTitle="DropMedia"\r\nGUIMode="2"\r\nExecuteFile="DropMedia-Installer.exe"\r\n;!@InstallEnd@!\r\n',
    'utf8'
  )

  // 7. SFX birleştir
  console.log('Tek exe oluşturuluyor...')
  const buffers = [SFX_EXE, sfxConfig, archivePath].map(p => fs.readFileSync(p))
  fs.writeFileSync(finalExe, Buffer.concat(buffers))

  // Temizle
  for (const p of [stagedDir, archivePath, sfxConfig]) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }

  const sizeMb = (fs.statSync(finalExe).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ Installer hazır: installer/release/DropMedia-Installer.exe (${sizeMb} MB)`)
}

main()
