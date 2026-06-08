#!/usr/bin/env node
/*
 * DropMedia release helper
 *
 * GitHub'da TEK bir "stable" release tutulur.
 * Her yeni versiyonda:
 *   - Asset (DropMedia-Installer.exe) güncellenir
 *   - Release body'ye yeni versiyon bölümü eklenir
 *
 * Kullanım:
 *   node scripts/release.js [patch|minor|major|1.2.3] [seçenekler]
 *
 * Seçenekler:
 *   --notes "metin"          Versiyon notları (inline)
 *   --notes-file dosya.md    Versiyon notları (dosyadan)
 *   --dry-run                Sadece ne yapılacağını göster
 *   --allow-dirty            Kirli git worktree'ye izin ver
 */

const { spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const root         = path.resolve(__dirname, '..')
const notesDir     = path.join(root, 'release-notes')
const bodyFile     = path.join(notesDir, 'RELEASE_BODY.md')
const installerExe = path.join(root, 'installer', 'release', 'DropMedia-Installer.exe')

const STABLE_TAG   = 'stable'
const RELEASE_TITLE = 'DropMedia'

// ── Giriş noktası ─────────────────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv.slice(2))
  const pkg     = readJson(path.join(root, 'package.json'))
  const current = pkg.version
  const next    = resolveNextVersion(current, options.bump)
  const gitTag  = `v${next}`

  if (!options.allowDirty) assertCleanGit()
  assertCommand('gh', ['--version'])
  assertCommand('git', ['--version'])

  console.log(`\nDropMedia release  ${current} → ${next}`)

  if (options.dryRun) {
    console.log('Dry run: hiçbir şey değiştirilmedi.')
    console.log(`  git tag  : ${gitTag}`)
    console.log(`  gh tag   : ${STABLE_TAG}  (güncellenir)`)
    return
  }

  // 1. Versiyon notlarını hazırla
  const versionNotes = resolveVersionNotes(options, current, next)

  // 2. RELEASE_BODY.md'ye ekle
  const newBody = appendVersionToBody(next, versionNotes)
  fs.writeFileSync(bodyFile, newBody)

  // 3. package.json / package-lock.json güncelle
  updateVersionFiles(next)

  // 4. Build
  run('npm', ['run', 'audit:package'])
  run('node', ['scripts/build-installer.js'])

  if (!fs.existsSync(installerExe)) {
    fail(`Installer bulunamadı: ${installerExe}`)
  }

  // 5. Git commit + push (versiyon tagʼı sadece local)
  run('git', ['add', 'package.json', 'package-lock.json',
               path.relative(root, bodyFile)])
  run('git', ['commit', '-m', `chore: release ${gitTag}`])
  run('git', ['tag', gitTag])   // local takip için
  run('git', ['push'])

  // 6. "stable" tagʼını bu commitʼe taşı
  moveStableTag()

  // 7. GitHub "stable" releaseʼıni güncelle
  publishStableRelease(newBody)

  console.log(`\n✓ Release tamamlandı`)
  console.log(`  Versiyon : ${next}`)
  console.log(`  Git tag  : ${gitTag}`)
  console.log(`  Release  : https://github.com/vengeance3355/DropMedia/releases/tag/${STABLE_TAG}`)
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function moveStableTag() {
  // Eski "stable" tag'ini sil (local + remote), yenisini oluştur
  spawnSync('git', ['tag', '-d', STABLE_TAG], { cwd: root })
  spawnSync('git', ['push', 'origin', `:refs/tags/${STABLE_TAG}`], { cwd: root })
  run('git', ['tag', STABLE_TAG])
  run('git', ['push', 'origin', STABLE_TAG])
}

function publishStableRelease(body) {
  // "stable" release var mı kontrol et
  const check = spawnSync('gh', ['release', 'view', STABLE_TAG], {
    cwd: root, encoding: 'utf8'
  })

  if (check.status === 0) {
    // Mevcut release'i güncelle
    console.log('Mevcut "stable" release güncelleniyor...')
    run('gh', [
      'release', 'edit', STABLE_TAG,
      '--title', RELEASE_TITLE,
      '--notes', body
    ])
    // Asset'i değiştir
    run('gh', [
      'release', 'upload', STABLE_TAG,
      installerExe,
      '--clobber'
    ])
  } else {
    // İlk kez oluştur
    console.log('"stable" release oluşturuluyor...')
    run('gh', [
      'release', 'create', STABLE_TAG,
      '--title', RELEASE_TITLE,
      '--notes', body,
      installerExe
    ])
  }
}

function appendVersionToBody(version, notes) {
  let body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8').trimEnd() : defaultBody()
  const section = `\n\n---\n\n# ${version}\n${notes.trim()}`
  return body + section + '\n'
}

function defaultBody() {
  return [
    '## DropMedia',
    '',
    'YouTube, Instagram, Twitter ve daha fazlasından video ve ses indirme uygulaması. ' +
    'yt-dlp + ffmpeg tabanlı altyapısıyla çoklu platform desteği, format/kalite seçimi, ' +
    'indirme kuyruğu yönetimi, otomatik pano algılama, çerez tabanlı özel içerik indirme, ' +
    'medya dönüştürme, altyazı çıkarma ve mini mod sunar. Windows için tasarlanmış, ' +
    'Electron tabanlı modern arayüz.'
  ].join('\n')
}

function resolveVersionNotes(options, currentVersion, nextVersion) {
  if (options.notesFile) {
    const full = path.resolve(root, options.notesFile)
    if (!fs.existsSync(full)) fail(`Notlar dosyası bulunamadı: ${options.notesFile}`)
    return fs.readFileSync(full, 'utf8').trim()
  }
  if (options.notes) return options.notes.trim()

  // Git log'undan otomatik çıkar
  const prevTag = capture('git', ['describe', '--tags', '--abbrev=0', '--match=v*'], { allowFail: true })
  const range   = prevTag ? `${prevTag}..HEAD` : ''
  const log     = capture('git', ['log', '--pretty=format:- %s', range].filter(Boolean), { allowFail: true })
  return log || `- ${nextVersion} sürümüne güncellendi`
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
  const valid = new Set(['patch', 'minor', 'major'])
  if (!valid.has(bump)) fail(`Geçersiz bump: ${bump}. patch/minor/major veya tam semver kullanın.`)
  const [maj, min, pat] = current.split('.').map(Number)
  if ([maj, min, pat].some(n => !Number.isFinite(n))) fail(`Geçersiz versiyon: ${current}`)
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
    if (a === '--notes')       opts.notes     = args[++i] ?? ''
    else if (a === '--notes-file') opts.notesFile = args[++i] ?? ''
    else if (a === '--dry-run')    opts.dryRun    = true
    else if (a === '--allow-dirty') opts.allowDirty = true
    else fail(`Bilinmeyen seçenek: ${a}`)
  }
  return opts
}

function assertCleanGit() {
  const out = capture('git', ['status', '--porcelain'])
  if (out) fail('Git çalışma dizini temiz değil. Commit/stash yapın veya --allow-dirty kullanın.')
}

function assertCommand(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'ignore' })
  if (r.status !== 0) fail(`Gerekli komut bulunamadı: ${cmd}`)
}

function run(cmd, args) {
  console.log(`  > ${cmd} ${args.join(' ')}`)
  const result = spawnSyncCompat(cmd, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`Komut başarısız: ${cmd} ${args.join(' ')}`)
}

function capture(cmd, args, opts = {}) {
  const r = spawnSyncCompat(cmd, args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0 && !opts.allowFail) fail(`Komut başarısız: ${cmd} ${args.join(' ')}`)
  return (r.stdout || '').trim()
}

function spawnSyncCompat(cmd, args, options) {
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    return spawnSync(cmd, args, { ...options, shell: true })
  }
  return spawnSync(cmd, args, options)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fail(msg) {
  console.error(`\nHata: ${msg}`)
  process.exit(1)
}

main()
