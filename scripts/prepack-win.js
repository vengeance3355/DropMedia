/**
 * scripts/prepack-win.js
 *
 * Pre-extraction helper for Windows packaging.
 *
 * electron-builder delegates Electron extraction to app-builder.exe. If the
 * Electron cache zip is corrupt, app-builder can exit successfully while
 * leaving release/win-unpacked without electron.exe. This script verifies the
 * staged Electron runtime before electron-builder continues.
 *
 * Usage: npm run predist:win
 */

'use strict'

const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

if (process.platform !== 'win32') {
  console.log('[prepack-win] Not Windows - skipping.')
  process.exit(0)
}

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const outDir = path.join(releaseDir, 'win-unpacked')
const appBuilder = path.join(projectRoot, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')

let electronVersion
try {
  const electronPkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
  )
  electronVersion = electronPkg.version
} catch {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  electronVersion = (pkg.devDependencies?.electron || '33.4.11').replace(/[^0-9.]/g, '')
}

const requiredElectronFiles = [
  'electron.exe',
  'icudtl.dat',
  'resources.pak',
  'chrome_100_percent.pak',
  'd3dcompiler_47.dll',
  'libEGL.dll'
]
const config = JSON.stringify([{ platform: 'win32', arch: 'x64', version: electronVersion }])
const electronZipName = `electron-v${electronVersion}-win32-x64.zip`

function getMissingElectronFiles() {
  return requiredElectronFiles.filter((file) => !fs.existsSync(path.join(outDir, file)))
}

function assertSafeOutDir() {
  const resolvedOutDir = path.resolve(outDir)
  const resolvedReleaseDir = path.resolve(releaseDir)

  if (!resolvedOutDir.startsWith(`${resolvedReleaseDir}${path.sep}`)) {
    throw new Error(`Refusing to clean unexpected output directory: ${resolvedOutDir}`)
  }
}

function getCacheCandidates() {
  return [
    process.env.ELECTRON_CACHE,
    process.env.electron_config_cache,
    process.env.npm_config_electron_cache,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache') : null
  ].filter(Boolean)
}

function findCachedElectronZip() {
  for (const cacheDir of getCacheCandidates()) {
    const candidate = path.join(cacheDir, electronZipName)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function cleanOutputDir() {
  assertSafeOutDir()
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
}

function unpackElectron() {
  cleanOutputDir()
  execFileSync(appBuilder, [
    'unpack-electron',
    '--configuration', config,
    '--output', outDir,
    '--distMacOsAppName', 'Electron.app'
  ], { stdio: 'inherit', timeout: 120000 })

  const missing = getMissingElectronFiles()
  if (missing.length > 0) {
    throw new Error(`Electron extraction is incomplete. Missing: ${missing.join(', ')}`)
  }
}

function removeCachedElectronZip(reason) {
  const cachedZip = findCachedElectronZip()

  if (cachedZip == null) {
    console.warn(`[prepack-win] Could not find ${electronZipName} in the Electron cache.`)
    return false
  }

  console.warn(`[prepack-win] ${reason}`)
  console.warn(`[prepack-win] Removing cached Electron archive: ${cachedZip}`)
  fs.rmSync(cachedZip, { force: true })
  return true
}

function run() {
  if (!fs.existsSync(appBuilder)) {
    console.log('[prepack-win] app-builder.exe not found - skipping.')
    return
  }

  if (getMissingElectronFiles().length === 0) {
    console.log('[prepack-win] Electron stage already complete - skipping pre-extraction.')
    return
  }

  console.log(`[prepack-win] Pre-extracting Electron v${electronVersion} into release/win-unpacked ...`)

  try {
    unpackElectron()
    console.log('[prepack-win] Pre-extraction complete.')
    return
  } catch (err) {
    console.warn('[prepack-win] Pre-extraction failed:', err.message)
  }

  const didRemoveCache = removeCachedElectronZip('Cached Electron archive may be corrupt; retrying with a fresh download.')
  if (!didRemoveCache) {
    process.exit(1)
  }

  try {
    unpackElectron()
    console.log('[prepack-win] Pre-extraction complete after refreshing Electron cache.')
  } catch (err) {
    console.error('[prepack-win] Pre-extraction failed after refreshing Electron cache:', err.message)
    process.exit(1)
  }
}

run()
