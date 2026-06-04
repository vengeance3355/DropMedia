import { spawn } from 'child_process'
import { IpcMain, BrowserWindow, app } from 'electron'
import { existsSync, statSync, unlinkSync, readdirSync, copyFileSync } from 'fs'
import { dirname, basename, join, extname } from 'path'
import {
  getFfmpegPath, getYtDlpPath, formatCommand, buildAccessArgs, hasFfmpeg
} from './downloader'
import { logError } from './logger'

// Background ffmpeg/yt-dlp jobs (format conversion + subtitle application).
// Lives in the main process so jobs keep running when the user switches tabs.
// Progress is parsed from ffmpeg's real `-progress` output — never fabricated.

const activeJobs = new Map<string, ReturnType<typeof spawn>>()
const cancelledJobs = new Set<string>()

type JobKind = 'convert' | 'subtitle'

export interface SubtitleStyle {
  fontName: string
  fontSize: number
  textColor: string      // #RRGGBB
  bgColor: string        // #RRGGBB
  bgOpacity: number      // 0..1 (1 = opaque box, 0 = transparent → outline only)
  position: 'top' | 'middle' | 'bottom'
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
}

function emitProgress(data: { id: string; kind: JobKind; title: string; percent: number | null; message: string }): void {
  getMainWindow()?.webContents.send('media-job-progress', data)
}

function emitComplete(data: { id: string; kind: JobKind; title: string; success: boolean; outputPath?: string; error?: string; cancelled?: boolean }): void {
  getMainWindow()?.webContents.send('media-job-complete', data)
}

function appendTail(current: string, chunk: string, max = 8000): string {
  const next = current + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

function parseDurationSec(line: string): number | null {
  const m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
}

function parseOutTimeSec(line: string): number | null {
  const m = line.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
}

// Runs an ffmpeg command, streaming real percent (when total duration is known).
function runFfmpeg(
  jobId: string,
  kind: JobKind,
  title: string,
  args: string[],
  message: string,
  onClose: (code: number | null, stderr: string, cancelled: boolean, spawnError?: Error) => void
): void {
  const bin = getFfmpegPath()
  // -progress pipe:1 writes machine-readable key=value lines to stdout;
  // -nostats silences the noisy carriage-return stats on stderr.
  const fullArgs = [...args, '-progress', 'pipe:1', '-nostats']
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(bin, fullArgs)
  } catch (err) {
    onClose(-1, '', false, err instanceof Error ? err : new Error(String(err)))
    return
  }

  activeJobs.set(jobId, proc)
  let durationSec: number | null = null
  let stderr = ''

  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString()
    stderr = appendTail(stderr, text)
    if (durationSec == null) {
      for (const line of text.split('\n')) {
        const dur = parseDurationSec(line)
        if (dur && dur > 0) { durationSec = dur; break }
      }
    }
  })

  proc.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      const cur = parseOutTimeSec(line)
      if (cur == null) continue
      const percent = durationSec
        ? Math.max(1, Math.min(99, Math.round((cur / durationSec) * 100)))
        : null
      emitProgress({ id: jobId, kind, title, percent, message })
    }
  })

  proc.on('close', (code) => {
    activeJobs.delete(jobId)
    const cancelled = cancelledJobs.delete(jobId)
    onClose(code, stderr, cancelled)
  })
  proc.on('error', (err: Error) => {
    activeJobs.delete(jobId)
    cancelledJobs.delete(jobId)
    onClose(-1, stderr, false, err)
  })
}

// ── Format conversion ───────────────────────────────────────────────────────

function startConvert(opts: { jobId: string; inputPath: string; outputFormat: string; outputPath: string; title?: string }): void {
  const { jobId, inputPath, outputFormat, outputPath } = opts
  const title = opts.title || basename(inputPath)

  if (!hasFfmpeg()) {
    emitComplete({ id: jobId, kind: 'convert', title, success: false, error: 'ffmpeg kurulu değil.' })
    return
  }

  const startMs = Date.now()
  emitProgress({ id: jobId, kind: 'convert', title, percent: null, message: 'Dönüştürülüyor…' })

  runFfmpeg(jobId, 'convert', title, ['-i', inputPath, '-y', outputPath], 'Dönüştürülüyor…',
    async (code, stderr, cancelled, spawnError) => {
      if (cancelled) {
        try { if (existsSync(outputPath)) unlinkSync(outputPath) } catch { /* ignore */ }
        emitComplete({ id: jobId, kind: 'convert', title, success: false, cancelled: true, error: 'Dönüştürme iptal edildi.' })
        return
      }
      if (code === 0) {
        let fileSizeMb: number | undefined
        try { fileSizeMb = statSync(outputPath).size / (1024 * 1024) } catch { /* ignore */ }
        emitComplete({ id: jobId, kind: 'convert', title, success: true, outputPath })
        return
      }
      const error = spawnError ? 'ffmpeg çalıştırılamadı. Kurulumu kontrol edin.' : 'Dosya dönüştürülemedi. Format veya ffmpeg işlemi başarısız oldu.'
      logError({
        errorType: 'download',
        errorMessage: error,
        operation: 'media-convert',
        command: formatCommand(getFfmpegPath(), ['-i', inputPath, '-y', outputPath]),
        exitCode: code,
        stderr,
        stackTrace: spawnError?.stack
      })
      emitComplete({ id: jobId, kind: 'convert', title, success: false, error })
    })
}

// ── Subtitle application ──────────────────────────────────────────────────────

function hexToAss(hex: string, alpha = 0): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6)
  const aa = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0').toUpperCase()
  return `&H${aa}${b}${g}${r}`.toUpperCase()
}

// SRT timestamp (HH:MM:SS,mmm) → ASS timestamp (H:MM:SS.cc)
function srtTimeToAss(t: string): string {
  const normalized = t.trim().replace(',', '.')
  const dotIdx = normalized.lastIndexOf('.')
  const hms = dotIdx >= 0 ? normalized.slice(0, dotIdx) : normalized
  const ms  = dotIdx >= 0 ? normalized.slice(dotIdx + 1) : '000'
  const [h, m, s] = hms.split(':').map(Number)
  const cs = Math.floor(Number(ms.padEnd(3, '0').slice(0, 3)) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// Converts an SRT string into an ASS document with fully-specified styles.
// ASS/libass color format: &HAABBGGRR. AA=00 opaque, FF transparent.
// BorderStyle=3 opaque box uses OutlineColour as box color; if OutlineColour
// is transparent, the subtitle background box becomes invisible.
function srtToAss(srtContent: string, style: SubtitleStyle): string {
  const alignment  = style.position === 'top' ? 8 : style.position === 'middle' ? 5 : 2
  const primary    = hexToAss(style.textColor, 0)
  const bgOpacity  = (typeof style.bgOpacity === 'number' && !isNaN(style.bgOpacity)) ? style.bgOpacity : 0.6
  const bgAlpha    = Math.round((1 - bgOpacity) * 255)
  const hasBg      = bgOpacity > 0.02

  // Box mode: BorderStyle=3 draws the rectangular background using OutlineColour.
  // No-bg mode: BorderStyle=1 draws normal black text outline/shadow.
  const borderStyle = hasBg ? 3 : 1
  const outline     = hasBg ? Math.max(2, Math.round(style.fontSize / 8)) : 2
  const shadow      = hasBg ? 0 : 1
  const outlineCol  = hasBg ? hexToAss(style.bgColor, bgAlpha) : hexToAss('#000000', 0)
  const backCol     = '&HFF000000'


  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 384',
    'PlayResY: 288',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.fontName},${style.fontSize},${primary},${primary},${outlineCol},${backCol},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},10,10,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const dialogues: string[] = []
  for (const block of srtContent.trim().split(/\r?\n\s*\r?\n/)) {
    const lines  = block.trim().split(/\r?\n/)
    const tIdx   = lines.findIndex(l => l.includes('-->'))
    if (tIdx < 0) continue
    const [startRaw, endRaw] = lines[tIdx].split(/\s*-->\s*/)
    const start = srtTimeToAss(startRaw)
    const end   = srtTimeToAss(endRaw)
    const text  = lines.slice(tIdx + 1)
      .join('\\N')
      .replace(/<b>/gi, '{\\b1}').replace(/<\/b>/gi, '{\\b0}')
      .replace(/<i>/gi, '{\\i1}').replace(/<\/i>/gi, '{\\i0}')
      .replace(/<u>/gi, '{\\u1}').replace(/<\/u>/gi, '{\\u0}')
      .replace(/<[^>]+>/g, '')
    if (text.trim()) dialogues.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`)
  }

  return header + '\n' + dialogues.join('\n') + '\n'
}

// libavfilter path escaping for the subtitles= filter argument.
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function tempSubDir(): string {
  return join(app.getPath('temp'), 'dropmedia-subs')
}

// Fetches subtitles via yt-dlp for specific language codes.
function fetchSubtitle(jobId: string, kind: JobKind, title: string, url: string, langs: string[], cookieBrowser?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dir = tempSubDir()
    try { require('fs').mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const outTemplate = join(dir, `${jobId}.%(ext)s`)
    const args = [
      '--ignore-config', '--no-warnings', '--no-playlist', '--skip-download',
      '--write-subs', '--write-auto-subs', '--sub-langs', langs.join(','),
      '--convert-subs', 'srt',
      '--sleep-subtitles', '1', '--retries', '3', '--socket-timeout', '20',
      ...buildAccessArgs(url, { cookieBrowser, useTor: false }),
      '-o', outTemplate, url
    ]
    emitProgress({ id: jobId, kind, title, percent: null, message: 'Altyazı indiriliyor…' })
    let stderr = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(getYtDlpPath(), args)
    } catch {
      resolve(null)
      return
    }
    activeJobs.set(jobId, proc)
    proc.stderr?.on('data', (d: Buffer) => { stderr = appendTail(stderr, d.toString()) })
    proc.on('close', () => {
      activeJobs.delete(jobId)
      const srt = findSubFile(dir, jobId)
      if (!srt) {
        logError({
          errorType: 'download',
          errorMessage: 'Altyazı indirilemedi.',
          url,
          operation: 'subtitle-fetch',
          command: formatCommand(getYtDlpPath(), args),
          stderr
        })
      }
      resolve(srt)
    })
    proc.on('error', () => { activeJobs.delete(jobId); resolve(null) })
  })
}

// For 'auto' mode: tries English first (YouTube auto-subs almost always exist in
// English), then falls back to Turkish. This avoids a 429 on 'tr' aborting the
// whole request before 'en' is attempted.
async function fetchSubtitleAuto(jobId: string, kind: JobKind, title: string, url: string, lang: string, cookieBrowser?: string): Promise<string | null> {
  if (lang !== 'auto') return fetchSubtitle(jobId, kind, title, url, [lang], cookieBrowser)
  const first = await fetchSubtitle(jobId, kind, title, url, ['en'], cookieBrowser)
  if (first) return first
  return fetchSubtitle(jobId, kind, title, url, ['tr'], cookieBrowser)
}

function findSubFile(dir: string, jobId: string): string | null {
  try {
    const match = readdirSync(dir).find(f => f.startsWith(`${jobId}.`) && /\.srt$/i.test(f))
    return match ? join(dir, match) : null
  } catch {
    return null
  }
}

async function startSubtitle(opts: {
  jobId: string
  inputPath: string
  outputPath: string
  mode: 'burn' | 'soft' | 'save'
  style: SubtitleStyle
  url?: string
  subtitlePath?: string
  lang?: string
  cookieBrowser?: string
  replaceOriginal?: boolean
}): Promise<void> {
  const { jobId, inputPath, outputPath, mode, style } = opts
  const title = basename(inputPath)

  const startMs = Date.now()

  if (!hasFfmpeg()) {
    emitComplete({ id: jobId, kind: 'subtitle', title, success: false, error: 'ffmpeg kurulu değil.' })
    return
  }
  if (!existsSync(inputPath)) {
    emitComplete({ id: jobId, kind: 'subtitle', title, success: false, error: 'Kaynak video bulunamadı.' })
    return
  }

  // Resolve the subtitle source: an explicit file, or fetch from the URL.
  let subPath: string | null = opts.subtitlePath ?? null
  let isTempSub = false
  if (!subPath && opts.url) {
    subPath = await fetchSubtitleAuto(jobId, 'subtitle', title, opts.url, opts.lang ?? 'auto', opts.cookieBrowser)
    isTempSub = true
  }

  if (cancelledJobs.delete(jobId)) {
    if (isTempSub && subPath) safeUnlink(subPath)
    emitComplete({ id: jobId, kind: 'subtitle', title, success: false, cancelled: true, error: 'Altyazı işlemi iptal edildi.' })
    return
  }

  if (!subPath || !existsSync(subPath)) {
    emitComplete({ id: jobId, kind: 'subtitle', title, success: false, error: 'Altyazı bulunamadı. Bu video için altyazı olmayabilir.' })
    return
  }

  // "save" modu: altyazıyı videonun yanına .srt olarak bırak, ffmpeg yok.
  if (opts.mode === 'save') {
    const dest = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.srt`)
    try {
      copyFileSync(subPath, dest)
      if (isTempSub) safeUnlink(subPath)
      emitComplete({ id: jobId, kind: 'subtitle', title, success: true, outputPath: dest })
    } catch (err) {
      if (isTempSub) safeUnlink(subPath)
      const e = err instanceof Error ? err : new Error(String(err))
      logError({ errorType: 'download', errorMessage: 'Altyazı dosyası kaydedilemedi.', operation: 'subtitle-save', stackTrace: e.stack })
      emitComplete({ id: jobId, kind: 'subtitle', title, success: false, error: 'Altyazı dosyası kaydedilemedi.' })
    }
    return
  }

  // For burn mode: convert SRT to ASS so styles (including BackColour alpha) are
  // embedded directly in the subtitle file. force_style ignores BackColour alpha
  // in libass BorderStyle=3 — writing it into the ASS header is the reliable fix.
  let assPath: string | null = null
  if (mode === 'burn') {
    try {
      require('fs').mkdirSync(tempSubDir(), { recursive: true })
      const srtContent = require('fs').readFileSync(subPath, 'utf8') as string
      assPath = join(tempSubDir(), `${jobId}.ass`)
      require('fs').writeFileSync(assPath, srtToAss(srtContent, style), 'utf8')
    } catch {
      assPath = null
    }
  }

  // For soft embed: copy SRT to a safe temp name to avoid path-escaping issues.
  const safeSrt = join(tempSubDir(), `${jobId}.srt`)
  if (!assPath) {
    try {
      if (subPath !== safeSrt) { require('fs').mkdirSync(tempSubDir(), { recursive: true }); copyFileSync(subPath, safeSrt) }
    } catch { /* fall back to original path */ }
  }
  const useSub = assPath ?? (existsSync(safeSrt) ? safeSrt : subPath)

  // Soft-embed subtitle codec depends on the container (mov_text for mp4/mov, srt otherwise).
  const outExt = extname(outputPath).toLowerCase()
  const softCodec = outExt === '.mp4' || outExt === '.mov' || outExt === '.m4v' ? 'mov_text' : 'srt'
  const args = mode === 'burn'
    ? ['-i', inputPath, '-vf', `subtitles=${escapeFilterPath(useSub)}`, '-c:a', 'copy', '-y', outputPath]
    : ['-i', inputPath, '-i', useSub, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', softCodec, '-y', outputPath]

  const cleanup = (): void => {
    if (isTempSub && subPath) safeUnlink(subPath)
    if (assPath) safeUnlink(assPath)
    if (!assPath && useSub !== subPath) safeUnlink(useSub)
  }

  runFfmpeg(jobId, 'subtitle', title, args, 'Altyazı uygulanıyor…', (code, stderr, cancelled, spawnError) => {
    cleanup()
    if (cancelled) {
      safeUnlink(outputPath)
      emitComplete({ id: jobId, kind: 'subtitle', title, success: false, cancelled: true, error: 'Altyazı işlemi iptal edildi.' })
      return
    }
    if (code === 0) {
      let finalPath = outputPath
      if (opts.replaceOriginal && extname(inputPath).toLowerCase() === extname(outputPath).toLowerCase()) {
        try { require('fs').renameSync(outputPath, inputPath); finalPath = inputPath } catch { /* keep new file */ }
      }
      emitComplete({ id: jobId, kind: 'subtitle', title, success: true, outputPath: finalPath })
      return
    }
    const error = spawnError ? 'ffmpeg çalıştırılamadı.' : 'Altyazı videoya uygulanamadı.'
    logError({
      errorType: 'download',
      errorMessage: error,
      operation: `subtitle-${mode}`,
      command: formatCommand(getFfmpegPath(), args),
      exitCode: code,
      stderr,
      stackTrace: spawnError?.stack
    })
    emitComplete({ id: jobId, kind: 'subtitle', title, success: false, error })
  })
}

function safeUnlink(p?: string | null): void {
  if (!p) return
  try { if (existsSync(p)) unlinkSync(p) } catch { /* best-effort temp cleanup */ }
}

// Lists subtitle languages available for a URL (manual + auto-generated).
function listSubtitleLangs(url: string, cookieBrowser?: string): Promise<{ manual: string[]; auto: string[] }> {
  return new Promise((resolve) => {
    const args = ['--ignore-config', '--dump-json', '--no-warnings', '--no-playlist', '--skip-download', ...buildAccessArgs(url, { cookieBrowser }), url]
    let stdout = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(getYtDlpPath(), args)
    } catch {
      resolve({ manual: [], auto: [] })
      return
    }
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', () => {
      try {
        const info = JSON.parse(stdout) as { subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown> }
        resolve({ manual: Object.keys(info.subtitles ?? {}), auto: Object.keys(info.automatic_captions ?? {}) })
      } catch {
        resolve({ manual: [], auto: [] })
      }
    })
    proc.on('error', () => resolve({ manual: [], auto: [] }))
  })
}

// Finds a subtitle file sitting next to an already-downloaded video.
function findSiblingSubtitle(videoPath: string): string | null {
  try {
    const dir = dirname(videoPath)
    const stem = basename(videoPath, extname(videoPath))
    const match = readdirSync(dir).find(f => f.startsWith(stem) && /\.(srt|vtt|ass)$/i.test(f))
    return match ? join(dir, match) : null
  } catch {
    return null
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

export function setupMediaJobHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('media-convert', (_e, opts: { jobId: string; inputPath: string; outputFormat: string; outputPath: string; title?: string }) => {
    startConvert(opts)
    return { jobId: opts.jobId }
  })

  ipcMain.handle('media-subtitle', (_e, opts: Parameters<typeof startSubtitle>[0]) => {
    startSubtitle(opts)
    return { jobId: opts.jobId }
  })

  ipcMain.handle('media-job-cancel', (_e, jobId: string) => {
    const proc = activeJobs.get(jobId)
    cancelledJobs.add(jobId)
    if (proc) { proc.kill('SIGTERM'); return true }
    return false
  })

  ipcMain.handle('subtitle-list-langs', (_e, url: string, cookieBrowser?: string) => listSubtitleLangs(url, cookieBrowser))
  ipcMain.handle('subtitle-find-sibling', (_e, videoPath: string) => findSiblingSubtitle(videoPath))
}
