/**
 * scripts/prepack-win.js
 *
 * Pre-extraction helper for Windows packaging.
 *
 * Why this exists:
 *   electron-builder calls `app-builder.exe unpack-electron` which normally
 *   extracts the Electron binary correctly into release/win-unpacked. However,
 *   on some Windows setups the first extraction run produces an incomplete
 *   directory (missing electron.exe). Running the same extraction a second
 *   time — against the already-partially-populated directory — fills in the
 *   missing files. This script runs that "warm-up" pass before electron-builder
 *   takes over, so the rename electron.exe → DropMedia.exe always succeeds.
 *
 * Usage: npm run predist:win  (automatically runs before dist:win via npm lifecycle)
 */

'use strict'
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

if (process.platform !== 'win32') {
  console.log('[prepack-win] Not Windows — skipping.')
  process.exit(0)
}

// Read the electron version from the project's node_modules
let electronVersion
try {
  const electronPkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'electron', 'package.json'), 'utf8')
  )
  electronVersion = electronPkg.version
} catch {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  )
  electronVersion = (pkg.devDependencies?.electron || '33.4.11').replace(/[^0-9.]/g, '')
}

const appBuilder = path.join(__dirname, '..', 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')
const outDir = path.join(__dirname, '..', 'release', 'win-unpacked')
const electronExe = path.join(outDir, 'electron.exe')

if (fs.existsSync(electronExe)) {
  console.log('[prepack-win] electron.exe already present — skipping pre-extraction.')
  process.exit(0)
}

if (!fs.existsSync(appBuilder)) {
  console.log('[prepack-win] app-builder.exe not found — skipping.')
  process.exit(0)
}

fs.mkdirSync(outDir, { recursive: true })

const config = JSON.stringify([{ platform: 'win32', arch: 'x64', version: electronVersion }])
console.log(`[prepack-win] Pre-extracting Electron v${electronVersion} into release/win-unpacked …`)

try {
  execFileSync(appBuilder, [
    'unpack-electron',
    '--configuration', config,
    '--output', outDir,
    '--distMacOsAppName', 'Electron.app'
  ], { stdio: 'inherit', timeout: 120000 })
  console.log('[prepack-win] Pre-extraction complete.')
} catch (err) {
  console.warn('[prepack-win] Pre-extraction failed (non-fatal):', err.message)
}
