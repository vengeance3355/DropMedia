#!/usr/bin/env node
/**
 * DropMedia release helper
 *
 * Akış:
 *   1. Version bump (package.json)
 *   2. DropMedia build → release/win-unpacked
 *   3. ZIP → release/DropMedia-win-x64.zip
 *   4. RELEASE_BODY.md + version.json güncelle
 *   5. Git commit + push
 *   6. "stable" GitHub release: zip + version.json upload, body güncelle
 *
 * Kullanım:
 *   node scripts/release.js [patch|minor|major|1.2.3] [--notes "..."] [--notes-file ...] [--dry-run] [--allow-dirty]
 */

const { spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const root         = path.resolve(__dirname, '..')
const notesDir     = path.join(root, 'release-notes')
const bodyFile     = path.join(notesDir, 'RELEASE_BODY.md')
const versionFile  = path.join(notesDir, 'version.json')
const releaseDir   = path.join(root, 'release')
const zipDest      = path.join(releaseDir, 'DropMedia-win-x64.zip')

const STABLE_TAG    = 'stable'
const RELEASE_TITLE = 'DropMedia'

// ── Ana akış ──────────────────────────────────────────────────────────────────

function main() {
  const opts    = parseArgs(process.argv.slice(2))
  const pkg     = readJson(path.join(root, 'package.json'))
  const current = pkg.version
  const next    = resolveNextVersion(current, opts.bump)
  const gitTag  = `v${next}`

  if (!opts.allowDirty) assertCleanGit()
  assertCommand('gh',  ['--version'])
  assertCommand('git', ['--version'])

  console.log(`\nDropMedia release  ${current} → ${next}`)

  if (opts.dryRun) {
    console.log('Dry run: hiçbir şey değiştirilmedi.')
    return
  }

  // 1. Notlar
  const notes   = resolveNotes(opts, current, next)

  // 2. RELEASE_BODY.md güncelle
  const newBody = appendVersionToBody(next, notes)
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(bodyFile, newBody)

  // 3. version.json güncelle
  fs.writeFileSync(versionFile, JSON.stringify({ version: next, notes: notes.trim() }, null, 2))

  // 4. package.json version bump
  updateVersionFiles(next)

  // 5. Build
  run('npm', ['run', 'build'])
  run('npx', ['electron-builder', '--win', '--publish', 'never'])

  // 6. ZIP oluştur
  console.log('\nwin-unpacked zipleniyor...')
  const winUnpacked = path.join(releaseDir, 'win-unpacked')
  if (!fs.existsSync(winUnpacked)) fail('win-unpacked bulunamadı.')
  if (fs.existsSync(zipDest)) fs.rmSync(zipDest)

  const psZip = `Compress-Archive -Path '${winUnpacked}\\*' -DestinationPath '${zipDest}' -Force`
  const zipResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psZip], {
    cwd: root, stdio: 'inherit'
  })
  if (zipResult.status !== 0) fail('ZIP oluşturulamadı.')

  const zipMb = (fs.statSync(zipDest).size / 1024 / 1024).toFixed(1)
  console.log(`  DropMedia-win-x64.zip: ${zipMb} MB`)

  // 7. Git commit + tag (local only, stable tag remote'a taşınır)
  run('git', ['add', 'package.json', 'package-lock.json',
    path.relative(root, bodyFile), path.relative(root, versionFile)])
  run('git', ['commit', '-m', `chore: release ${gitTag}`])
  run('git', ['tag', gitTag])
  run('git', ['push'])

  // 8. stable tag'i taşı
  spawnSync('git', ['tag', '-d', STABLE_TAG], { cwd: root })
  spawnSync('git', ['push', 'origin', `:refs/tags/${STABLE_TAG}`], { cwd: root })
  run('git', ['tag', STABLE_TAG])
  run('git', ['push', 'origin', STABLE_TAG])

  // 9. GitHub release güncelle
  const check = spawnSync('gh', ['release', 'view', STABLE_TAG], { cwd: root, encoding: 'utf8' })
  if (check.status === 0) {
    // Güncelle
    run('gh', ['release', 'edit', STABLE_TAG, '--title', RELEASE_TITLE, '--notes', newBody, '--draft=false'])
    run('gh', ['release', 'upload', STABLE_TAG, zipDest, '--clobber'])
    run('gh', ['release', 'upload', STABLE_TAG, versionFile, '--clobber'])
  } else {
    // İlk oluştur
    run('gh', ['release', 'create', STABLE_TAG,
      '--title', RELEASE_TITLE, '--notes', newBody,
      zipDest, versionFile
    ])
  }

  console.log(`\n✓ Release tamamlandı: v${next}`)
  console.log(`  https://github.com/vengeance3355/DropMedia/releases/tag/${STABLE_TAG}`)
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function appendVersionToBody(version, notes) {
  const existing = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8').trimEnd() : defaultBody()
  return existing + `\n\n---\n\n# ${version}\n${notes.trim()}\n`
}

function defaultBody() {
  return `## DropMedia\n\nYouTube, Instagram, Twitter ve daha fazlasından video ve ses indirme uygulaması. yt-dlp + ffmpeg tabanlı altyapısıyla çoklu platform desteği, format/kalite seçimi, indirme kuyruğu yönetimi, otomatik pano algılama, çerez tabanlı özel içerik indirme, medya dönüştürme, altyazı çıkarma ve mini mod sunar. Windows için tasarlanmış, Electron tabanlı modern arayüz.`
}

function resolveNotes(opts, current, next) {
  if (opts.notesFile) {
    const f = path.resolve(root, opts.notesFile)
    if (!fs.existsSync(f)) fail(`Dosya bulunamadı: ${opts.notesFile}`)
    return fs.readFileSync(f, 'utf8').trim()
  }
  if (opts.notes) return opts.notes.trim()
  const prev = capture('git', ['describe', '--tags', '--abbrev=0', '--match=v*'], { allowFail: true })
  const range = prev ? `${prev}..HEAD` : ''
  const log = capture('git', ['log', '--pretty=format:- %s', range].filter(Boolean), { allowFail: true })
  return log || `- ${next} sürümüne güncellendi`
}

function updateVersionFiles(version) {
  const pkgPath = path.join(root, 'package.json')
  const pkg = readJson(pkgPath)
  pkg.version = version
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const lockPath = path.join(root, 'package-lock.json')
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath)
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  }
}

function resolveNextVersion(current, bump) {
  if (isValidSemver(bump)) return bump
  if (!['patch', 'minor', 'major'].includes(bump)) fail(`Geçersiz bump: ${bump}`)
  const [maj, min, pat] = current.split('.').map(Number)
  if (bump === 'major') return `${maj + 1}.0.0`
  if (bump === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function isValidSemver(v) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(v)
}

function parseArgs(args) {
  const opts = { bump: 'patch', notes: '', notesFile: '', dryRun: false, allowDirty: false }
  if (args[0] && !args[0].startsWith('--')) opts.bump = args.shift()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--notes')        opts.notes     = args[++i] ?? ''
    else if (a === '--notes-file')  opts.notesFile = args[++i] ?? ''
    else if (a === '--dry-run')     opts.dryRun    = true
    else if (a === '--allow-dirty') opts.allowDirty = true
    else fail(`Bilinmeyen seçenek: ${a}`)
  }
  return opts
}

function assertCleanGit() {
  if (capture('git', ['status', '--porcelain'])) fail('Git worktree temiz değil.')
}

function assertCommand(cmd, args) {
  if (spawnSync(cmd, args, { cwd: root, stdio: 'ignore' }).status !== 0) fail(`Komut bulunamadı: ${cmd}`)
}

function run(cmd, args) {
  console.log(`  > ${cmd} ${args.slice(0, 3).join(' ')}`)
  const r = spawnSyncCompat(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) fail(`Başarısız: ${cmd} ${args.join(' ')}`)
}

function capture(cmd, args, opts = {}) {
  const r = spawnSyncCompat(cmd, args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0 && !opts.allowFail) fail(`Başarısız: ${cmd}`)
  return (r.stdout || '').trim()
}

function spawnSyncCompat(cmd, args, opts) {
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    return spawnSync(cmd, args, { ...opts, shell: true })
  }
  return spawnSync(cmd, args, opts)
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')) }
function fail(msg)   { console.error(`\nHata: ${msg}`); process.exit(1) }

main()
