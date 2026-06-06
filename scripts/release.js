#!/usr/bin/env node
/*
 * DropMedia release helper.
 *
 * Usage:
 *   node scripts/release.js patch --notes-file release-notes/v1.0.2.md
 *   node scripts/release.js 1.2.0 --notes "Release notes"
 *   node scripts/release.js patch --dry-run
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const releaseDir = path.join(root, 'release')
const notesDir = path.join(root, 'release-notes')

function main() {
  const options = parseArgs(process.argv.slice(2))
  const pkgPath = path.join(root, 'package.json')
  const pkg = readJson(pkgPath)
  const currentVersion = pkg.version
  const nextVersion = resolveNextVersion(currentVersion, options.bump)
  const tag = `v${nextVersion}`

  if (!options.allowDirty) assertCleanGit()
  assertCommand('gh', ['--version'])
  assertCommand('git', ['--version'])

  const notes = resolveNotes(options, currentVersion, nextVersion)
  const notesPath = path.join(notesDir, `${tag}.md`)

  console.log(`DropMedia release ${currentVersion} -> ${nextVersion}`)
  console.log(`Notes: ${path.relative(root, notesPath)}`)
  if (options.dryRun) {
    console.log('Dry run: no files changed, no build, no upload.')
    return
  }

  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(notesPath, notes.endsWith('\n') ? notes : `${notes}\n`)
  updateVersionFiles(nextVersion)

  run('npm', ['run', 'build'])
  const target = process.platform === 'win32' ? '--win' : '--linux'
  run('npx', ['electron-builder', target, '--publish', 'never'])
  run('npm', ['run', 'audit:package'])

  const files = collectReleaseFiles(nextVersion)
  if (files.length === 0) fail(`No release files found for ${nextVersion}`)

  run('git', ['add', 'package.json', 'package-lock.json', path.relative(root, notesPath)])
  run('git', ['commit', '-m', `chore: release ${tag}`])
  run('git', ['tag', tag])
  run('git', ['push'])
  run('git', ['push', 'origin', tag])

  const ghArgs = [
    'release', 'create', tag,
    ...files,
    '--title', `DropMedia ${tag}`,
    '--notes-file', notesPath
  ]
  if (options.draft) ghArgs.push('--draft')
  if (options.prerelease) ghArgs.push('--prerelease')
  run('gh', ghArgs)

  console.log(`Release uploaded: https://github.com/vengeance3355/DropMedia/releases/tag/${tag}`)
  console.log('Evidence:')
  console.log(`- version=${nextVersion}`)
  console.log(`- files=${files.map(file => path.basename(file)).join(', ')}`)
  console.log('- audit=passed')
}

function parseArgs(args) {
  const options = {
    bump: 'patch',
    notes: '',
    notesFile: '',
    dryRun: false,
    draft: false,
    prerelease: false,
    allowDirty: false
  }

  if (args[0] && !args[0].startsWith('--')) options.bump = args.shift()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--notes') options.notes = args[++i] ?? ''
    else if (arg === '--notes-file') options.notesFile = args[++i] ?? ''
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--draft') options.draft = true
    else if (arg === '--prerelease') options.prerelease = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else fail(`Unknown option: ${arg}`)
  }
  return options
}

function resolveNextVersion(current, bump) {
  if (isValidSemver(bump)) return bump
  const valid = new Set(['patch', 'minor', 'major'])
  if (!valid.has(bump)) fail(`Invalid bump: ${bump}. Use patch, minor, major, or exact semver.`)
  const [major, minor, patch] = current.split('.').map(Number)
  if (![major, minor, patch].every(Number.isFinite)) fail(`Invalid package version: ${current}`)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function isValidSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(value)
}

function resolveNotes(options, currentVersion, nextVersion) {
  if (options.notesFile) {
    const full = path.resolve(root, options.notesFile)
    if (!fs.existsSync(full)) fail(`Notes file not found: ${options.notesFile}`)
    return fs.readFileSync(full, 'utf8')
  }
  if (options.notes) return options.notes

  const previousTag = capture('git', ['describe', '--tags', '--abbrev=0'], { allowFail: true })
  const range = previousTag ? `${previousTag}..HEAD` : ''
  const log = capture('git', ['log', '--pretty=format:- %s', range].filter(Boolean), { allowFail: true })
  return [
    `DropMedia v${nextVersion}`,
    '',
    'Changes:',
    log || `- Release from v${currentVersion} to v${nextVersion}`,
    '',
    'Validation required before publishing:',
    '- npm run build',
    '- npm run audit:package',
    '- AppImage/deb smoke test'
  ].join('\n')
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

function collectReleaseFiles(version) {
  if (!fs.existsSync(releaseDir)) return []
  return fs.readdirSync(releaseDir)
    .filter(file => {
      if (file === 'latest.yml' || file === 'latest-linux.yml') return true
      if (!file.includes(version)) return false
      return /\.(AppImage|deb|exe|blockmap|yml|yaml)$/i.test(file)
    })
    .map(file => path.join(releaseDir, file))
    .filter(file => fs.statSync(file).isFile())
}

function assertCleanGit() {
  const status = capture('git', ['status', '--porcelain'])
  if (status) {
    fail('Git worktree is dirty. Commit/stash changes first, or pass --allow-dirty intentionally.')
  }
}

function assertCommand(command, args) {
  const result = spawn(command, args, { cwd: root, stdio: 'ignore' })
  if (result.status !== 0) fail(`Required command failed: ${command}`)
}

function run(command, args) {
  const result = spawn(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`Command failed: ${command} ${args.join(' ')}`)
}

function capture(command, args, opts = {}) {
  const result = spawn(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0 && !opts.allowFail) fail(`Command failed: ${command} ${args.join(' ')}`)
  return result.stdout.trim()
}

function spawn(command, args, options) {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', `${command}.cmd ${args.join(' ')}`], options)
  }
  return spawnSync(command, args, options)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

main()
