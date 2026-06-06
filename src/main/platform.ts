/**
 * platform.ts
 * Cross-platform binary path utilities for yt-dlp and ffmpeg.
 * All path-returning functions are safe to call after app.whenReady().
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { app } from 'electron'

export const IS_WIN   = process.platform === 'win32'
export const IS_MAC   = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/** Directory where DropMedia stores its own downloaded binaries */
export function getBinDir(): string {
  if (IS_WIN) {
    try {
      return join(app.getPath('userData'), 'bin')
    } catch {
      // app not ready yet — use a safe temp fallback
      return join(tmpdir(), 'dropmedia', 'bin')
    }
  }
  return join(process.env.HOME ?? '', '.local', 'bin')
}

export function getYtDlpBin(): string {
  return IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'
}

export function getFfmpegBin(): string {
  return IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
}

export function getFfprobeBin(): string {
  return IS_WIN ? 'ffprobe.exe' : 'ffprobe'
}

/** Resolves yt-dlp to an absolute path if installed locally, else returns the bare binary name */
export function resolveYtDlpPath(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath
  const local = join(getBinDir(), getYtDlpBin())
  if (existsSync(local)) return local
  return getYtDlpBin()
}

/** Resolves ffmpeg to an absolute path if available, else returns the bare binary name */
export function resolveFfmpegPath(): string {
  const local = join(getBinDir(), getFfmpegBin())
  if (existsSync(local)) return local

  if (!IS_WIN) {
    const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']
    const found = candidates.find(p => existsSync(p))
    if (found) return found
  }

  return getFfmpegBin()
}

/** Resolves ffprobe — prefers the directory next to ffmpeg */
export function resolveFfprobePath(): string {
  const ffmpeg = resolveFfmpegPath()
  // Strip trailing /ffmpeg or \ffmpeg.exe to get the directory
  const dir = ffmpeg.replace(/[/\\]ffmpeg(?:\.exe)?$/i, '')
  if (dir !== ffmpeg) {
    const probe = join(dir, getFfprobeBin())
    if (existsSync(probe)) return probe
  }

  const local = join(getBinDir(), getFfprobeBin())
  if (existsSync(local)) return local
  return getFfprobeBin()
}
