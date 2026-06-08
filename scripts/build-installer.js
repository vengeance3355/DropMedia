#!/usr/bin/env node
/**
 * build-installer.js
 *
 * 1. DropMedia'yı derle  (npm run dist:win  →  release/win-unpacked/)
 * 2. win-unpacked'i zip'le  →  installer/resources/dropmedia-app.zip
 * 3. Sürüm dosyasını yaz   →  installer/resources/dropmedia-version.json
 * 4. Installer'ı derle     →  installer/release/DropMedia-Installer.exe
 *
 * Kullanım:
 *   node scripts/build-installer.js [--skip-app-build]
 */

const { spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const root           = path.resolve(__dirname, '..')
const installerDir   = path.join(root, 'installer')
const winUnpacked    = path.join(root, 'release', 'win-unpacked')
const installerRes   = path.join(installerDir, 'resources')
const zipDest        = path.join(installerRes, 'dropmedia-app.zip')
const versionDest    = path.join(installerRes, 'dropmedia-version.json')

const skipAppBuild = process.argv.includes('--skip-app-build')

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const result = spawnSync(
    process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')
      ? 'cmd.exe'
      : cmd,
    process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')
      ? ['/d', '/s', '/c', `${cmd}.cmd ${args.join(' ')}`]
      : args,
    { cwd: opts.cwd || root, stdio: 'inherit' }
  )
  if (result.status !== 0) {
    console.error(`\nKomut başarısız: ${cmd} ${args.join(' ')}`)
    process.exit(1)
  }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  console.log(`\nDropMedia Installer build — v${version}\n`)

  // 1. DropMedia build
  if (!skipAppBuild) {
    console.log('── Adım 1: DropMedia derleniyor...')
    run('npm', ['run', 'dist:win'])
  } else {
    console.log('── Adım 1: Uygulama build atlandı (--skip-app-build)')
  }

  if (!fs.existsSync(winUnpacked)) {
    console.error(`Hata: win-unpacked bulunamadı: ${winUnpacked}`)
    process.exit(1)
  }

  // 2. Installer resources klasörünü oluştur
  fs.mkdirSync(installerRes, { recursive: true })

  // 3. Zip oluştur
  console.log('\n── Adım 2: win-unpacked zip\'leniyor...')
  if (fs.existsSync(zipDest)) fs.rmSync(zipDest)

  const psZip = `Compress-Archive -Path '${winUnpacked}\\*' -DestinationPath '${zipDest}' -Force`
  const zipResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psZip], {
    stdio: 'inherit',
    cwd: root
  })
  if (zipResult.status !== 0) {
    console.error('Zip oluşturulamadı.')
    process.exit(1)
  }

  const zipSizeMb = (fs.statSync(zipDest).size / 1024 / 1024).toFixed(1)
  console.log(`   dropmedia-app.zip oluşturuldu (${zipSizeMb} MB)`)

  // 4. Sürüm dosyası
  fs.writeFileSync(versionDest, JSON.stringify({ version }, null, 2))
  console.log(`   dropmedia-version.json yazıldı (v${version})`)

  // 5. Installer npm install (ilk kez)
  const installerModules = path.join(installerDir, 'node_modules')
  if (!fs.existsSync(installerModules)) {
    console.log('\n── Adım 3: Installer bağımlılıkları kuruluyor...')
    run('npm', ['install'], { cwd: installerDir })
  }

  // 6. Installer build
  console.log('\n── Adım 4: Installer derleniyor...')
  run('npm', ['run', 'dist'], { cwd: installerDir })

  const installerExe = path.join(installerDir, 'release', 'DropMedia-Installer.exe')
  if (!fs.existsSync(installerExe)) {
    console.error('Installer exe oluşturulamadı.')
    process.exit(1)
  }

  const exeSizeMb = (fs.statSync(installerExe).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ Installer hazır: installer/release/DropMedia-Installer.exe (${exeSizeMb} MB)`)
  console.log(`  Sürüm: ${version}\n`)
}

main()
