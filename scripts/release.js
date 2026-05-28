#!/usr/bin/env node
/**
 * DropMedia Release Script
 * Kullanım: node scripts/release.js [patch|minor|major]
 */

const { spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    console.error(`❌ Hata: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
  return result
}

function runWithOutput(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return result.stdout?.trim() ?? ''
}

const bump  = process.argv[2] ?? 'patch'
const valid = ['patch', 'minor', 'major']
if (!valid.includes(bump)) {
  console.error(`❌ Geçersiz tip: ${bump}. patch / minor / major kullanın.`)
  process.exit(1)
}

const pkgPath = path.join(__dirname, '../package.json')
const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

const [major, minor, patch] = pkg.version.split('.').map(Number)
const newVersion = bump === 'major'
  ? `${major + 1}.0.0`
  : bump === 'minor'
  ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`

console.log(`\n🚀 DropMedia ${pkg.version} → ${newVersion}\n`)

// package.json güncelle
pkg.version = newVersion
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('✓ package.json güncellendi')

// Build
console.log('⚙️  Build alınıyor...')
run('npx', ['electron-vite', 'build'])
console.log('✓ Build tamamlandı')

// Linux paketi
console.log('📦 Linux paketi oluşturuluyor...')
run('npx', ['electron-builder', '--linux'])
console.log('✓ Paket oluşturuldu')

// Git
run('git', ['add', 'package.json'])
run('git', ['commit', '-m', `chore: release v${newVersion}`])
run('git', ['tag', `v${newVersion}`])
run('git', ['push'])
run('git', ['push', '--tags'])
console.log('✓ GitHub\'a push edildi')

// Release dosyaları
const releaseDir = path.join(__dirname, '../release')
const files = fs.readdirSync(releaseDir)
  .filter(f => f.endsWith('.AppImage') || f.endsWith('.deb') || f.endsWith('.yml'))
  .map(f => path.join(releaseDir, f))

if (files.length === 0) {
  console.warn('⚠️  Release klasöründe dosya bulunamadı')
  process.exit(1)
}

// GitHub Release
run('gh', [
  'release', 'create', `v${newVersion}`,
  ...files,
  '--title', `DropMedia v${newVersion}`,
  '--generate-notes'
])

console.log(`\n✅ DropMedia v${newVersion} yayınlandı!`)
console.log(`   https://github.com/vengeance3355/DropMedia/releases/tag/v${newVersion}\n`)
