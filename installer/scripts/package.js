/**
 * Staged klasör + NSIS script üretir.
 * Makensis ayrıca çalıştırılır.
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
const finalExe      = path.join(releaseDir, 'DropMedia-Installer.exe')
const nsisScript    = path.join(releaseDir, '_installer.nsi')
const icon          = path.join(installerRoot, 'resources', 'icon.ico')

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

function getFilesRecursive(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...getFilesRecursive(full))
    else out.push(full)
  }
  return out
}

// 1. Staged
if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true })
console.log('Staged kopyalanıyor...')
cp(srcUnpacked, stagedDir)

for (const f of ['app.asar', 'app.asar.unpacked', 'app-update.yml']) {
  const p = path.join(stagedDir, 'resources', f)
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true })
}

// ASAR olarak paketle (onlyLoadAppFromAsar fuse aktif)
const tmpAppDir = path.join(require('os').tmpdir(), 'dm-inst-app-' + Date.now())
fs.mkdirSync(tmpAppDir, { recursive: true })

const pkg = JSON.parse(fs.readFileSync(path.join(installerRoot, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(tmpAppDir, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version,
  main: 'out/main/index.js',
  productName: 'DropMedia Installer'
}, null, 2))
cp(installerOut, path.join(tmpAppDir, 'out'))

const asarPath = path.join(stagedDir, 'resources', 'app.asar')
const asarBin  = path.join(installerRoot, 'node_modules', '.bin', 'asar.cmd')
console.log('ASAR oluşturuluyor...')
const asarResult = spawnSync(asarBin, ['pack', tmpAppDir, asarPath], { stdio: 'pipe', encoding: 'utf8', shell: true })
if (asarResult.status !== 0) {
  
  
  
  
  process.exit(1)
}
console.log('ASAR hazır:', asarPath)
fs.rmSync(tmpAppDir, { recursive: true })

const iconPng = path.join(installerRoot, 'resources', 'icon.png')
if (fs.existsSync(iconPng)) fs.copyFileSync(iconPng, path.join(stagedDir, 'resources', 'icon.png'))

const srcExe = path.join(stagedDir, 'DropMedia.exe')
const dstExe = path.join(stagedDir, 'DropMedia-Installer.exe')
if (fs.existsSync(srcExe)) fs.renameSync(srcExe, dstExe)
console.log('Staged hazır')

// 2. NSIS script
const filesByDir = {}
for (const f of getFilesRecursive(stagedDir)) {
  const rel     = path.relative(stagedDir, f)
  const dirPart = path.dirname(rel).replace(/\//g, '\\')
  if (!filesByDir[dirPart]) filesByDir[dirPart] = []
  filesByDir[dirPart].push(f.replace(/\//g, '\\'))
}

let fileSec = ''
for (const [dir, files] of Object.entries(filesByDir)) {
  fileSec += '  SetOutPath "' + (dir === '.' ? '$INSTDIR' : ('$INSTDIR\\' + dir)) + '"\n'
  for (const f of files) fileSec += '  File "' + f + '"\n'
}

const hasIco = fs.existsSync(icon)
const script = [
  'Unicode true',
  'SetCompressor zlib',             // lzma yerine hızlı zlib
  'Name "DropMedia Installer"',
  'OutFile "' + finalExe.replace(/\//g, '\\') + '"',
  'InstallDir "$TEMP\\DropMediaInst"',
  'RequestExecutionLevel user',
  'SilentInstall silent',
  hasIco ? ('Icon "' + icon.replace(/\//g, '\\') + '"') : '',
  '',
  'Section',
  fileSec,
  '  ExecShell "open" "$INSTDIR\\DropMedia-Installer.exe"',
  'SectionEnd'
].join('\n')

fs.writeFileSync(nsisScript, script, 'utf8')
console.log('NSIS script hazır:', nsisScript)

// 3. Makensis
console.log('\nMakensis çalışıyor (deflate, hızlı)...')
const r = spawnSync(
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  ['/V2', nsisScript],
  { stdio: 'inherit' }
)

if (r.status !== 0) {
  console.error('makensis başarısız! Exit:', r.status)
  process.exit(1)
}

// Temizle
fs.rmSync(stagedDir,  { recursive: true })
fs.rmSync(nsisScript)

const mb = (fs.statSync(finalExe).size / 1024 / 1024).toFixed(1)
console.log('\n✓ installer/release/DropMedia-Installer.exe — ' + mb + ' MB')
