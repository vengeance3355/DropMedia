#!/usr/bin/env node
/**
 * build-installer.js
 * Bootstrapper installer'ı derler.
 * Dropmedia-app.zip YOK — installer GitHub'dan indirir.
 *
 * Kullanım:
 *   node scripts/build-installer.js [--skip-app-build]
 */

const { spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const root         = path.resolve(__dirname, '..')
const installerDir = path.join(root, 'installer')
const winUnpacked  = path.join(root, 'release', 'win-unpacked')
const skipAppBuild = process.argv.includes('--skip-app-build')

function run(cmd, args, opts = {}) {
  const isNpmCmd = process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')
  const result = spawnSync(
    isNpmCmd ? 'cmd.exe' : cmd,
    isNpmCmd ? ['/d', '/s', '/c', `${cmd}.cmd ${args.join(' ')}`] : args,
    { cwd: opts.cwd || root, stdio: 'inherit' }
  )
  if (result.status !== 0) { console.error(`Başarısız: ${cmd} ${args.join(' ')}`); process.exit(1) }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  console.log(`\nDropMedia Installer build — v${pkg.version}\n`)

  // 1. DropMedia app build
  if (!skipAppBuild) {
    console.log('── Adım 1: DropMedia derleniyor...')
    run('npm', ['run', 'build'])
    run('npx', ['electron-builder', '--win', '--publish', 'never'])
  } else {
    console.log('── Adım 1: App build atlandı (--skip-app-build)')
  }

  if (!fs.existsSync(winUnpacked)) {
    console.error(`Hata: win-unpacked bulunamadı: ${winUnpacked}`)
    process.exit(1)
  }

  // 2. Installer node_modules
  const installerModules = path.join(installerDir, 'node_modules')
  if (!fs.existsSync(installerModules)) {
    console.log('\n── Adım 2: Installer bağımlılıkları kuruluyor...')
    run('npm', ['install'], { cwd: installerDir })
  }

  // 3. Installer build (JS + package)
  console.log('\n── Adım 3: Installer derleniyor...')
  run('npm', ['run', 'dist'], { cwd: installerDir })

  const finalExe = path.join(installerDir, 'release', 'DropMedia-Installer.exe')
  if (!fs.existsSync(finalExe)) { console.error('Installer exe oluşturulamadı.'); process.exit(1) }

  const sizeMb = (fs.statSync(finalExe).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ Installer hazır: installer/release/DropMedia-Installer.exe (${sizeMb} MB)`)
  console.log(`  Sürüm: ${pkg.version}\n`)
}

main()
