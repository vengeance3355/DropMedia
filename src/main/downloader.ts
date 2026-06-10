import { spawn, spawnSync } from 'child_process'
import { IpcMain, BrowserWindow, app } from 'electron'
import { existsSync, appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Store from 'electron-store'
import { statSync } from 'fs'
import { logError, logStat, logDownload } from './logger'
import { detectCookieSources, resolveCookieBrowser, cookieSnapshotMissingLabel } from './cookies'
import { generateThumbnail, downloadRemoteThumbnail } from './thumbnailCache'
import { resolveYtDlpPath, resolveFfmpegPath, resolveFfprobePath, getYtDlpBin } from './platform'
import { maybeAutoUpdateYtDlp, setYtDlpBusyCheck } from './installer'

const DEBUG_LOG = join(tmpdir(), 'dropmedia_debug.log')
function dbg(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(DEBUG_LOG, line) } catch { /* ignore */ }
}

const store = new Store()
const activeDownloads = new Map<string, ReturnType<typeof spawn>>()
const activeDownloadKeys = new Map<string, string>()
const pausingDownloads = new Set<string>()
const cancellingDownloads = new Set<string>()
let activeFetchCount = 0

// installer auto-update'in çalışan yt-dlp binary'sini değiştirmemesi için:
// indirme veya bilgi-çekme aktifken meşgul say.
export function isYtDlpBusy(): boolean {
  return activeDownloads.size > 0 || activeFetchCount > 0
}
setYtDlpBusyCheck(isYtDlpBusy)

// ── Yol yönetimi ─────────────────────────────────────────────────────────────

export function getYtDlpPath(): string {
  const custom = store.get('ytDlpPath') as string | undefined
  return resolveYtDlpPath(custom ?? undefined)
}

function getDownloadDir(): string {
  return (store.get('downloadDir') as string | undefined) || app.getPath('downloads')
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
}

export function hasFfmpeg(): boolean {
  try { return spawnSync(resolveFfmpegPath(), ['-version'], { timeout: 2000 }).status === 0 }
  catch { return false }
}

export function getFfmpegPath(): string {
  return resolveFfmpegPath()
}

function getFfprobePath(): string {
  return resolveFfprobePath()
}

export function probeDuration(outputPath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(getFfprobePath(), [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      outputPath
    ])
    let stdout = ''

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.on('error', () => resolve(undefined))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined)
        return
      }
      const parsed = Number.parseFloat(stdout.trim())
      resolve(Number.isFinite(parsed) ? Math.floor(parsed) : undefined)
    })
  })
}

function checkBinary(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args)
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve(false)
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function checkFfmpegAvailable(): Promise<boolean> {
  return checkBinary(resolveFfmpegPath(), ['-version'], 2000)
}

// ── Tor tespiti ───────────────────────────────────────────────────────────────

function isTorRunning(): boolean {
  try {
    const r = spawnSync('curl', ['--proxy', 'socks5://127.0.0.1:9050', '--max-time', '3', '-s', 'https://check.torproject.org/api/ip'], { timeout: 4000 })
    return r.status === 0 && r.stdout?.toString().includes('"IsTor":true')
  } catch { return false }
}

function isTwitterUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('twitter.com') || u.includes('x.com')
}

function isYoutubeUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('youtube.com') || u.includes('youtu.be')
}

// YouTube'da seçilen player client'ı o an hiç format döndürmediğinde alınan
// hata. Format merdiveni (.../best) zaten varken bu hata = client/extraction
// sorunu; çözüm farklı kaliteyi değil, farklı player client'ları denemek.
function isYoutubeFormatError(text: string): boolean {
  const t = text.toLowerCase()
  return t.includes('requested format is not available') ||
    t.includes('no video formats') ||
    t.includes('unable to extract') ||
    t.includes('player response') ||
    t.includes('failed to extract any player response')
}

// Açılışta seçilen player client değişebilir; geniş bir set vererek biri boş
// dönerse diğeri kapatır. tv + web_safari + android + web: PO-token gerektirmeden
// en geniş format kapsaması (canlı doğrulandı).
const YT_FALLBACK_CLIENTS = 'youtube:player_client=tv,web_safari,android,web'

function isAuthenticationRequiredError(text: string): boolean {
  return text.includes('need to log in') ||
    text.includes('login required') ||
    text.includes('cookies-from-browser') ||
    text.includes('private content') ||
    text.includes('registered users') ||
    text.includes('authentication')
}

// Tarayıcı cookie'si OKUNAMADI (örn. Chrome'un yeni şifrelemesi: "Failed to
// decrypt with DPAPI", yt-dlp #10927; ya da tarayıcı açıkken kilitli DB:
// "Could not copy Chrome cookie database", #7271). Bu, "giriş gerekli"
// değildir — cookiesiz tekrar denemek doğru harekettir.
function isCookieExtractionError(text: string): boolean {
  return text.includes('failed to decrypt') ||
    text.includes('dpapi') ||
    (text.includes('could not copy') && text.includes('cookie')) ||
    (text.includes('cookie') && text.includes('database'))
}

// Oturum içi kara liste: cookie çıkarımı başarısız olan kaynaklar (kilitli DB,
// DPAPI). Sonraki işlemler aynı kaynağı tekrar deneyip ilk denemeyi boşa
// harcamasın. Uygulama yeniden başlatılınca sıfırlanır (tarayıcı kapanmış
// olabilir).
const failedCookieSources = new Set<string>()

function cookieArgOf(args: string[]): string | undefined {
  const i = args.indexOf('--cookies-from-browser')
  return i >= 0 ? args[i + 1] : undefined
}

function noteCookieRetry(opts: {
  operation: string
  url: string
  cookieArg?: string
  stderr: string
  cookieError: boolean
}): void {
  if (opts.cookieError && opts.cookieArg) failedCookieSources.add(opts.cookieArg)
  void logError({
    errorType: 'warning',
    errorMessage: opts.cookieError
      ? `Tarayıcı çerezi okunamadı (${opts.cookieArg ?? '?'}); cookiesiz tekrar denendi.`
      : 'Cookie ile format hatası alındı; cookiesiz tekrar denendi.',
    url: opts.url,
    operation: opts.operation,
    stderr: opts.stderr.slice(0, 1500)
  })
}

export function buildAccessArgs(url: string, opts: { useTor?: boolean; cookieBrowser?: string } = {}): string[] {
  const args: string[] = []
  const useTor = opts.useTor ?? !!(store.get('torEnabled') as boolean | undefined)
  const cookieBrowser = opts.cookieBrowser ?? (store.get('cookieBrowser') as string | undefined)
  const resolvedCookieBrowser = resolveCookieBrowser(cookieBrowser, url)

  // Kara listedeki kaynak (kilitli/şifreli cookie DB) cookiesiz gibi davranır.
  const usableCookieBrowser = resolvedCookieBrowser && !failedCookieSources.has(resolvedCookieBrowser)
    ? resolvedCookieBrowser
    : undefined

  if (useTor) args.push('--proxy', 'socks5://127.0.0.1:9050')
  if (usableCookieBrowser) args.push('--cookies-from-browser', usableCookieBrowser)

  if (isTwitterUrl(url) && !usableCookieBrowser) args.push('--extractor-args', 'twitter:api=syndication')

  return args
}

// ── Format builder ────────────────────────────────────────────────────────────

function getExpectedStreamCount(opts: DownloadOptions): number {
  if (opts.singleStream) return 1 // direkt medya URL'si (örn. story mp4) — tek akış
  if (['mp3', 'm4a', 'aac'].includes(opts.format)) return 1
  if (!hasFfmpeg()) return 1
  return 2 // bestvideo+bestaudio → video stream + audio stream
}

function buildArgs(url: string, opts: DownloadOptions): string[] {
  const { format, outputDir, filename, speedLimit, useTor, subtitles, embedSubs, cookieBrowser } = opts
  const dir    = outputDir || getDownloadDir()
  const output = join(dir, filename ? `${filename}.%(ext)s` : `%(title)s [%(id)s].%(ext)s`)
  const ffmpeg = hasFfmpeg()
  const args: string[] = ['--ignore-config', '--newline', '--no-warnings', '--no-playlist', '--continue', '--retries', '3', '--fragment-retries', '3', '-o', output]
  args.push(...buildAccessArgs(url, { useTor, cookieBrowser }))

  // YouTube format/extraction hatası sonrası geniş player client seti dene.
  if (opts.ytExtraClients && isYoutubeUrl(url)) args.push('--extractor-args', YT_FALLBACK_CLIENTS)

  // Hız limiti
  if (speedLimit && speedLimit > 0) args.push('--limit-rate', `${speedLimit}M`)

  // ffmpeg yolu
  if (ffmpeg) args.push('--ffmpeg-location', getFfmpegPath())

  // Altyazı
  if (subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'tr,en')
    if (embedSubs && ffmpeg) args.push('--embed-subs')
  }

  // Direkt medya URL'si (story mp4 CDN linki gibi): format merdiveni uygulanmaz,
  // tek akış olduğu gibi indirilir; merge gerekmez.
  if (opts.singleStream) {
    args.push('-f', 'best/bestvideo+bestaudio')
    args.push(url)
    return args
  }

  const isAudio = ['mp3', 'm4a', 'aac'].includes(format)

  if (isAudio) {
    args.push('-x', '--audio-format', format, '--audio-quality', '0')
    args.push(url)
    return args
  }

  const heightMap: Record<string, number> = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
  const h = heightMap[format]

  if (ffmpeg) {
    args.push('-f', h ? `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best` : 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
  } else {
    args.push('-f', h ? `best[height<=${h}]/best[height<=${Math.round(h * 1.3)}]/best` : 'best')
  }

  args.push(url)
  return args
}

// ── IPC handler kurulumu ──────────────────────────────────────────────────────

export function setupDownloadHandlers(ipcMain: IpcMain): void {

  // Tekil video bilgisi
  ipcMain.handle('fetch-info', async (_e, url: string) => {
    activeFetchCount++
    try {
      return await fetchInfoInternal(url)
    } finally {
      activeFetchCount--
    }
  })

  async function fetchInfoInternal(url: string) {
    const cached = getCache(url)
    if (cached) return await withInstagramThumbnailPath(url, cached)

    const bin = getYtDlpPath()
    const baseArgs = ['--ignore-config', '--dump-json', '--no-playlist', '--no-warnings']
    const accessArgs = buildAccessArgs(url)
    const args = [...baseArgs, ...accessArgs, url]
    let result = await runProcess(bin, args)
    let usedArgs = args

    // YouTube format/extraction hatası → geniş player client seti ile tekrar
    // (cookie'yi düşürmeden). Hata genelde o anki tek client'ın boş dönmesi.
    if (result.code !== 0 && isYoutubeUrl(url) && isYoutubeFormatError((result.stderr + result.stdout).toLowerCase())) {
      const clientArgs = [...baseArgs, ...accessArgs, '--extractor-args', YT_FALLBACK_CLIENTS, url]
      const retry = await runProcess(bin, clientArgs)
      if (retry.code === 0) {
        result = retry
        usedArgs = clientArgs
      }
    }

    // Cookie'li deneme format hatası verirse cookiesiz yeniden dene
    if (result.code !== 0 && accessArgs.includes('--cookies-from-browser')) {
      const lower = (result.stderr + result.stdout).toLowerCase()
      const isFormatOrCookieError = lower.includes('no video formats')
        || lower.includes('requested format is not available')
        || lower.includes('cookies')
        || isCookieExtractionError(lower)
      if (isFormatOrCookieError && (!isAuthenticationRequiredError(lower) || isCookieExtractionError(lower))) {
        // Retry'ı admin loguna yaz + okunamayan kaynağı oturum boyu kara listele.
        noteCookieRetry({
          operation: 'fetch-info-cookie-retry',
          url,
          cookieArg: cookieArgOf(accessArgs),
          stderr: result.stderr,
          cookieError: isCookieExtractionError(lower)
        })
        // 'disabled' şart: '' resolveCookieBrowser'da AUTO'ya düşer ve yine
        // aynı cookie'li argümanı üretir (DPAPI hatası sonsuza dek tekrarlardı).
        const ytClient = isYoutubeUrl(url) && isYoutubeFormatError(lower) ? ['--extractor-args', YT_FALLBACK_CLIENTS] : []
        const noCookieArgs = [...baseArgs, ...buildAccessArgs(url, { cookieBrowser: 'disabled' }), ...ytClient, url]
        const retry = await runProcess(bin, noCookieArgs)
        if (retry.code === 0) {
          result = retry
          usedArgs = noCookieArgs
        } else {
          // Retry de düştü: asıl sebep cookiesiz denemenin hatası. İkisini de
          // logla — eskiden yalnız ilk (cookie) hata loglanıp gerçek sebep
          // maskeleniyordu.
          result = {
            ...retry,
            stderr: `[cookie'li deneme]\n${result.stderr}\n\n[cookiesiz tekrar]\n${retry.stderr}`
          }
          usedArgs = noCookieArgs
        }
      }
    }

    if (result.spawnError) {
      const msg = 'İndirme motoru bulunamadı. Ayarlar > Sistem bölümünden yt-dlp güncellemesini çalıştırın.'
      await logError({ errorType: 'fetch', errorMessage: msg, url, operation: 'fetch-info-spawn', command: formatCommand(bin, usedArgs), stackTrace: result.spawnError.stack })
      throw new Error(msg)
    }

    if (result.code !== 0) {
      let msg = friendlyError(result.stderr, url, 'fetch')
      // Giriş isteyen içerik + henüz çerez snapshot'ı yoksa: kullanıcıdan her
      // indirmede değil, BİR KEZ tarayıcıyı kapatmasını iste (snapshot seed).
      if (isAuthenticationRequiredError((result.stderr + result.stdout).toLowerCase())) {
        const missing = cookieSnapshotMissingLabel(url)
        if (missing) {
          msg = `Bu içerik giriş gerektiriyor. ${missing} çerezleri henüz kaydedilmedi. ${missing}'i bir kez tamamen kapatıp (arka plan/tepsi dahil) yeniden açın — DropMedia çerezleri otomatik kaydedecek, sonra ${missing} açıkken bile çalışır.`
        }
      }
      await logError({ errorType: 'fetch', errorMessage: msg, url, operation: 'fetch-info', command: formatCommand(bin, usedArgs), exitCode: result.code, stderr: result.stderr, stdout: result.stdout })
      throw new Error(msg)
    }

    try {
      const info = parseVideoInfo(JSON.parse(result.stdout))
      const next = await withInstagramThumbnailPath(url, info)
      setCache(url, next)
      return next
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({ errorType: 'fetch', errorMessage: 'Video bilgisi işlenemedi.', url, operation: 'fetch-info-parse', command: formatCommand(bin, usedArgs), stackTrace: e.stack, stdout: result.stdout })
      throw new Error('Video bilgisi işlenemedi.')
    }
  }

  // Playlist bilgisi
  ipcMain.handle('fetch-playlist', async (_e, url: string) => {
    return new Promise((resolve, reject) => {
      const bin = getYtDlpPath()
      const args = ['--ignore-config', '--dump-json', '--yes-playlist', '--no-warnings', '--flat-playlist', ...buildAccessArgs(url), url]
      const proc = spawn(bin, args)
      const items: object[] = []
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => {
        const lines = d.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          try { items.push(JSON.parse(line)) } catch { /* skip */ }
        }
      })
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('close', (code) => {
        if (code !== 0) {
          const msg = friendlyError(stderr, url, 'fetch')
          logError({
            errorType: 'fetch',
            errorMessage: msg,
            url,
            operation: 'fetch-playlist',
            command: formatCommand(bin, args),
            exitCode: code,
            stderr
          })
          reject(new Error(msg)); return
        }
        resolve(items)
      })
      proc.on('error', (err: Error) => {
        const msg = 'İndirme motoru bulunamadı. Ayarlar > Sistem bölümünden yt-dlp güncellemesini çalıştırın.'
        logError({
          errorType: 'fetch',
          errorMessage: msg,
          url,
          operation: 'fetch-playlist-spawn',
          command: formatCommand(bin, args),
          stackTrace: err.stack
        })
        reject(new Error(msg))
      })
    })
  })

  // İndirme başlat / devam ettir
  ipcMain.handle('start-download', (_e, opts: DownloadOptions) => startDownloadProcess(opts, 'start'))
  ipcMain.handle('resume-download', (_e, opts: DownloadOptions) => startDownloadProcess(opts, 'resume'))

  // İptal
  ipcMain.handle('cancel-download', (_e, id: string) => {
    const proc = activeDownloads.get(id)
    if (proc) {
      cancellingDownloads.add(id)
      proc.kill('SIGTERM')
      return true
    }
    return false
  })

  // Duraklat
  ipcMain.handle('pause-download', (_e, id: string) => {
    const proc = activeDownloads.get(id)
    if (proc) {
      pausingDownloads.add(id)
      proc.kill('SIGTERM')
      return true
    }
    return false
  })

  // yt-dlp kontrolü
  ipcMain.handle('check-ytdlp', () =>
    new Promise<string | null>((resolve) => {
      // getYtDlpPath() already returns the best available path or bare binary name
      const bin = getYtDlpPath()
      const proc = spawn(bin, ['--version'])
      let v = ''
      proc.stdout.on('data', (d: Buffer) => (v += d.toString().trim()))
      proc.on('close', (code) => resolve(code === 0 ? v : null))
      proc.on('error', () => resolve(null))
    })
  )

  ipcMain.handle('check-ffmpeg', () => checkFfmpegAvailable())
  ipcMain.handle('check-tor',    () => isTorRunning())
  ipcMain.handle('detect-cookie-sources', (_e, url?: string) => detectCookieSources(url))
}

type DownloadMode = 'start' | 'resume' | 'retry-no-subs' | 'retry-yt-clients' | 'retry-no-cookies'

function startDownloadProcess(opts: DownloadOptions, mode: DownloadMode, retryWithoutSubtitles = false): { started: boolean; error?: string } {
  const { id, url, format } = opts
  const key = downloadKey(url, format)
  const existingId = activeDownloadKeys.get(key)

  if (activeDownloads.has(id)) {
    return { started: false, error: 'Bu indirme zaten devam ediyor.' }
  }
  if (existingId && existingId !== id) {
    return { started: false, error: 'Bu video aynı kalitede zaten indiriliyor.' }
  }

  const bin = getYtDlpPath()
  const args = buildArgs(url, opts)
  let proc: ReturnType<typeof spawn>

  try {
    proc = spawn(bin, args)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    const msg = 'İndirme motoru başlatılamadı. yt-dlp yolunu ve kurulumunu kontrol edin.'
    logError({
      errorType: 'download',
      errorMessage: msg,
      url,
      format,
      operation: `${mode}-download-spawn`,
      command: formatCommand(bin, args),
      stackTrace: e.stack
    })
    return { started: false, error: msg }
  }

  activeDownloads.set(id, proc)
  activeDownloadKeys.set(key, id)

  const startMs = Date.now()
  const outputDir = opts.outputDir || getDownloadDir()
  let outputPath = ''
  let stderr = ''
  let stdoutTail = ''

  const expectedStreams = getExpectedStreamCount(opts)
  let currentStream = 0
  let streamMaxPercent = 0

  dbg(`START id=${id} url=${url} format=${format} expectedStreams=${expectedStreams} cmd: ${formatCommand(bin, args)}`)

  proc.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue
      stdoutTail = appendTail(stdoutTail, line)
      outputPath = parseOutputPath(line) || outputPath

      dbg(`STDOUT: ${line}`)

      // ffmpeg merge/extract aşaması — progress'i 99%'de tut
      if (/^\[(?:Merger|ExtractAudio|ffmpeg)\]/.test(line)) {
        getMainWindow()?.webContents.send('download-progress', { id, percent: 99, totalSize: '', speed: '', eta: '' })
        continue
      }

      const p = parseProgress(line)
      if (!p) continue

      const rawPercent = typeof p.percent === 'number' ? p.percent : -1

      if (rawPercent >= 0 && expectedStreams > 1) {
        // Yeni stream başlangıcı: yüksek değerden ani düşüş
        if (rawPercent < streamMaxPercent - 60 && streamMaxPercent >= 85) {
          currentStream = Math.min(currentStream + 1, expectedStreams - 1)
          streamMaxPercent = 0
          dbg(`STREAM_CHANGE → currentStream=${currentStream}`)
        }
        streamMaxPercent = Math.max(streamMaxPercent, rawPercent)
        const blended = (currentStream * 100 + rawPercent) / expectedStreams
        dbg(`PROGRESS raw=${rawPercent} stream=${currentStream} blended=${blended.toFixed(1)}`)
        getMainWindow()?.webContents.send('download-progress', { id, ...p, percent: blended })
      } else {
        dbg(`PROGRESS raw=${rawPercent}`)
        getMainWindow()?.webContents.send('download-progress', { id, ...p })
      }
    }
  })
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    stderr = appendTail(stderr, msg)
    if (msg) {
      dbg(`STDERR: ${msg}`)
      getMainWindow()?.webContents.send('download-log', { id, msg })
    }
  })
  proc.on('close', async (code) => {
    dbg(`CLOSE id=${id} code=${code} success=${code === 0}`)
    activeDownloads.delete(id)
    activeDownloadKeys.delete(key)

    if (pausingDownloads.delete(id)) {
      getMainWindow()?.webContents.send('download-paused', { id })
      return
    }

    if (cancellingDownloads.delete(id)) {
      getMainWindow()?.webContents.send('download-complete', {
        id,
        success: false,
        code,
        cancelled: true,
        error: 'İndirme iptal edildi.'
      })
      return
    }

    const success = code === 0
    const platform = detectPlatformName(url)
    const lowerOut = (stderr + stdoutTail).toLowerCase()

    // Bekleyen iptal/duraklatı, yeniden denemeden önce onurlandıran yardımcı —
    // aynı id'yi kullandığımız için yeni sürece sızıp görünmez devam etmesin.
    const honorPendingControls = (): boolean => {
      if (cancellingDownloads.delete(id)) {
        getMainWindow()?.webContents.send('download-complete', { id, success: false, code, cancelled: true, error: 'İndirme iptal edildi.' })
        return true
      }
      if (pausingDownloads.delete(id)) {
        getMainWindow()?.webContents.send('download-paused', { id })
        return true
      }
      return false
    }

    // ── Adım 1: YouTube format/extraction hatası → geniş player client seti ──
    // Cookie'yi DÜŞÜRMEDEN önce dene: hata genelde o anki tek client'ın boş
    // dönmesinden kaynaklanır; farklı client'lar formatları geri getirir.
    if (!success && isYoutubeUrl(url) && !opts.ytExtraClients &&
        mode !== 'retry-yt-clients' && mode !== 'retry-no-cookies' &&
        isYoutubeFormatError(lowerOut)) {
      dbg(`YT_FORMAT_ERROR — retrying with fallback player clients`)
      if (honorPendingControls()) return
      getMainWindow()?.webContents.send('download-log', { id, msg: 'YouTube formatları yenileniyor (alternatif oynatıcılar deneniyor)…' })
      startDownloadProcess({ ...opts, ytExtraClients: true }, 'retry-yt-clients')
      return
    }

    // ── Adım 2: Cookie kaynaklı / format hatası → cookiesiz tekrar ──
    // (YouTube'da multi-client de denenmiş olur; ytExtraClients sticky kalır.)
    if (!success && mode !== 'retry-no-cookies' && args.includes('--cookies-from-browser')) {
      if ((!isAuthenticationRequiredError(lowerOut) || isCookieExtractionError(lowerOut)) &&
          (lowerOut.includes('no video formats') || lowerOut.includes('requested format is not available') || isCookieExtractionError(lowerOut))) {
        dbg(`FORMAT_ERROR_WITH_COOKIES — retrying without cookies`)
        if (honorPendingControls()) return
        getMainWindow()?.webContents.send('download-log', { id, msg: 'Cookie kaynaklı hata alındı, cookiesiz tekrar deneniyor…' })
        // Retry'ı admin loguna yaz + okunamayan kaynağı oturum boyu kara listele.
        noteCookieRetry({
          operation: 'download-cookie-retry',
          url,
          cookieArg: cookieArgOf(args),
          stderr,
          cookieError: isCookieExtractionError(lowerOut)
        })
        // 'disabled' şart: '' AUTO'ya düşüp yine cookie eklerdi.
        startDownloadProcess({ ...opts, cookieBrowser: 'disabled' }, 'retry-no-cookies')
        return
      }
    }

    if (!success && opts.subtitles && !retryWithoutSubtitles && isSubtitleDownloadFailure(`${stderr}\n${stdoutTail}`)) {
      const msg = 'Altyazı indirilemedi. Video altyazısız olarak tekrar deneniyor.'
      getMainWindow()?.webContents.send('download-log', { id, msg })
      logError({
        errorType: 'download',
        errorMessage: msg,
        url,
        format,
        operation: 'download-subtitle-retry',
        command: formatCommand(bin, args),
        exitCode: code,
        stderr,
        stdout: stdoutTail
      })

      // Altyazısız yeniden denemeden önce bekleyen iptal/duraklatı onurlandır.
      if (cancellingDownloads.delete(id)) {
        getMainWindow()?.webContents.send('download-complete', { id, success: false, code, cancelled: true, error: 'İndirme iptal edildi.' })
        return
      }
      if (pausingDownloads.delete(id)) {
        getMainWindow()?.webContents.send('download-paused', { id })
        return
      }
      const retry = startDownloadProcess({ ...opts, subtitles: false, embedSubs: false }, 'retry-no-subs', true)
      if (!retry.started) {
        const retryError = retry.error || 'İndirme yeniden başlatılamadı. Ayrıntılar admin loguna kaydedildi.'
        getMainWindow()?.webContents.send('download-complete', {
          id,
          success: false,
          code,
          error: retryError,
          outputDir
        })
        logError({
          errorType: 'download',
          errorMessage: retryError,
          url,
          format,
          operation: 'download-subtitle-retry-start',
          command: formatCommand(bin, args),
          exitCode: code,
          stderr,
          stdout: stdoutTail
        })
        logStat({ platform, format, success: false })
      }
      return
    }

    const elapsedMs = Date.now() - startMs
    const error = success ? undefined : friendlyError(stderr || stdoutTail, url, 'download')
    const thumbPromise =
      success && platform === 'discord' && outputPath
        ? generateThumbnail(outputPath).catch(() => null)
        : success && platform === 'instagram'
          ? resolveInstagramDownloadThumbnail(outputPath, opts.thumbnail)
          : Promise.resolve(undefined)
    const thumbnailPath = await thumbPromise
    const duration = success && outputPath
      ? await probeDuration(outputPath).catch(() => undefined)
      : undefined
    getMainWindow()?.webContents.send('download-complete', {
      id,
      success,
      code,
      error,
      outputPath: success ? outputPath : undefined,
      thumbnailPath: thumbnailPath || undefined,
      duration: duration || undefined,
      outputDir
    })
    if (success) {
      // Dosya boyutunu ölç
      let fileSizeMb: number | undefined
      if (outputPath) {
        try { fileSizeMb = statSync(outputPath).size / (1024 * 1024) } catch { /* ignore */ }
      }
      const speedMbps = fileSizeMb !== undefined && elapsedMs > 0
        ? (fileSizeMb / (elapsedMs / 1000))
        : undefined
      const mergedStreams = stdoutTail.includes('[Merger]')

      await logDownload({
        url,
        title:         opts.title,
        format,
        platform,
        outputPath:    outputPath || undefined,
        fileSizeMb,
        downloadMs:    elapsedMs,
        speedMbps,
        mergedStreams,
        command:       formatCommand(bin, args)
      })
    } else {
      logError({
        errorType: 'download',
        errorMessage: error ?? 'İndirme tamamlanamadı.',
        url,
        format,
        operation: mode === 'resume' ? 'download-resume'
          : mode === 'retry-no-subs' ? 'download-retry-no-subs'
          : mode === 'retry-yt-clients' ? 'download-retry-yt-clients'
          : mode === 'retry-no-cookies' ? 'download-retry-no-cookies'
          : 'download',
        command: formatCommand(bin, args),
        exitCode: code,
        stderr,
        stdout: stdoutTail
      })
      logStat({ platform, format, success: false })
    }
  })
  proc.on('error', (e: Error) => {
    activeDownloads.delete(id)
    activeDownloadKeys.delete(key)
    pausingDownloads.delete(id)
    cancellingDownloads.delete(id)
    const msg = 'İndirme motoru çalıştırılamadı. yt-dlp kurulumunu veya özel yt-dlp yolunu kontrol edin.'
    getMainWindow()?.webContents.send('download-complete', { id, success: false, code: -1, error: msg })
    logError({
      errorType: 'download',
      errorMessage: msg,
      stackTrace: e.stack,
      url,
      format,
      operation: `${mode}-download-process-error`,
      command: formatCommand(bin, args)
    })
  })

  return { started: true }
}

// ── Önbellek ──────────────────────────────────────────────────────────────────

const infoCache = new Map<string, { data: object; ts: number }>()
const CACHE_TTL = 1000 * 60 * 30 // 30 dakika

function getCache(url: string): object | null {
  const entry = infoCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) { infoCache.delete(url); return null }
  return entry.data
}

function setCache(url: string, data: object): void {
  infoCache.set(url, { data, ts: Date.now() })
  // Max 50 giriş
  if (infoCache.size > 50) infoCache.delete(infoCache.keys().next().value!)
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function runProcess(bin: string, args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: Error }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args)
    let stdout = '', stderr = ''
    let settled = false
    // yt-dlp asılırsa (ölü ağ/bozuk extractor) fetch-info sonsuza dek beklerdi.
    const timer = setTimeout(() => {
      if (settled) return
      stderr += '\n(zaman aşımı: süreç sonlandırıldı)'
      try { proc.kill() } catch { /* ignore */ }
    }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('close', (code) => { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }) })
    proc.on('error', (spawnError: Error) => { settled = true; clearTimeout(timer); resolve({ code: null, stdout, stderr, spawnError }) })
  })
}

function isSubtitleDownloadFailure(output: string): boolean {
  const text = output.toLowerCase()
  const isSubtitleError = text.includes('subtitle') || text.includes('subtitles')
  if (!isSubtitleError) return false

  return text.includes('unable to download') ||
    text.includes('failed to download') ||
    text.includes('http error 429') ||
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('timed out') ||
    text.includes('connection')
}

function friendlyError(stderr: string, url?: string, phase: 'fetch' | 'download' = 'fetch'): string {
  const text = stderr.toLowerCase()
  const isTwitter = url ? isTwitterUrl(url) : false

  if (text.includes('unsupported url')) return 'Bu bağlantı desteklenmiyor. Direkt video/reel/tweet/story bağlantısı deneyin.'
  if (text.includes('content is unreachable')) {
    return 'Bu içerik giriş gerektiriyor (örn. Instagram hikâyesi). Çerez ayarından giriş yaptığınız tarayıcıyı seçin ve o tarayıcı kapalıyken tekrar deneyin.'
  }
  if (text.includes('private')) return 'Bu içerik gizli veya erişim kısıtlı. Cookie ayarından giriş yaptığınız tarayıcıyı seçip tekrar deneyin.'
  if (text.includes('not a video')) return 'Bu bağlantı video içermiyor. Direkt medya bağlantısı kullanın.'
  if (text.includes('sign in') || text.includes('login required') || text.includes('unauthorized') || text.includes('http error 401')) {
    return isTwitter
      ? 'X/Twitter bu video için oturum istiyor. Cookie ayarından giriş yaptığınız tarayıcıyı seçip tekrar deneyin.'
      : 'Bu video oturum gerektiriyor. Cookie ayarından giriş yaptığınız tarayıcıyı seçip tekrar deneyin.'
  }
  if (text.includes('cookies') && (text.includes('could not') || text.includes('failed') || text.includes('unable') || text.includes('keyring'))) {
    return 'Seçili tarayıcı cookie’leri okunamadı. Tarayıcıyı kapatıp tekrar deneyin veya farklı bir tarayıcı seçin.'
  }
  if (text.includes('http error 403') || text.includes('forbidden')) {
    return isTwitter
      ? 'X/Twitter bu bağlantıya erişimi engelledi. Cookie ayarını etkinleştirip yt-dlp’yi güncelledikten sonra tekrar deneyin.'
      : 'Platform bu bağlantıya erişimi engelledi. Cookie ayarını ve ağ bağlantınızı kontrol edip tekrar deneyin.'
  }
  if (text.includes('no video formats') || text.includes('requested format is not available')) {
    return 'Seçilen kalite bu video için uygun değil. Başka bir kalite seçip tekrar deneyin.'
  }
  if (text.includes('rate limit') || text.includes('too many requests') || text.includes('http error 429')) {
    return 'Platform geçici hız sınırı uyguladı. Bir süre bekleyip tekrar deneyin.'
  }
  if (text.includes('timed out') || text.includes('temporary failure') || text.includes('network') || text.includes('connection')) {
    return 'Bağlantı sırasında sorun oluştu. İnternet bağlantınızı veya proxy/Tor ayarını kontrol edin.'
  }
  if (isTwitter) {
    return 'X/Twitter videosu alınamadı. yt-dlp güncel değilse güncelleyin; giriş gerektiren içeriklerde cookie ayarını kullanın.'
  }
  return phase === 'download'
    ? 'İndirme tamamlanamadı. Ayrıntılar admin loguna kaydedildi.'
    : 'Video bilgisi alınamadı. Bağlantıyı ve erişim ayarlarını kontrol edin.'
}

function appendTail(current: string, chunk: string, max = 12000): string {
  const next = `${current}${chunk}\n`
  return next.length > max ? next.slice(next.length - max) : next
}

function downloadKey(url: string, format: string): string {
  return `${normalizeUrlForKey(url)}::${format}`
}

function normalizeUrlForKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase()

    if (url.hostname === 'youtube.com' && url.pathname === '/watch') {
      const id = url.searchParams.get('v')
      return id ? `https://youtube.com/watch?v=${id}` : url.toString()
    }
    if (url.hostname === 'youtu.be') {
      return `https://youtu.be${url.pathname}`
    }

    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    url.search = ''
    for (const [key, value] of params) url.searchParams.append(key, value)
    return url.toString()
  } catch {
    return rawUrl.trim()
  }
}

function parseOutputPath(line: string): string {
  const patterns = [
    /^\[download\]\s+Destination:\s+(.+)$/,
    /^\[download\]\s+(.+?)\s+has already been downloaded$/,
    /^\[Merger\]\s+Merging formats into\s+"(.+)"$/,
    /^\[ExtractAudio\]\s+Destination:\s+(.+)$/,
    /^\[MoveFiles\]\s+Moving file\s+".+"\s+to\s+"(.+)"$/
  ]

  for (const pattern of patterns) {
    const match = line.match(pattern)
    if (match?.[1]) return match[1].replace(/^"|"$/g, '').trim()
  }
  return ''
}

export function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args.map(arg => {
    if (/^https?:\/\//i.test(arg)) {
      try {
        const u = new URL(arg)
        u.search = ''
        u.hash = ''
        return u.toString()
      } catch {
        return '[url]'
      }
    }
    if (arg.length > 500) return `${arg.slice(0, 500)}...`
    return arg
  })].join(' ')
}

export function detectPlatformName(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('twitter.com') || u.includes('x.com'))   return 'twitter'
  if (u.includes('instagram.com'))  return 'instagram'
  if (u.includes('discord.com') || u.includes('discordapp.com') || u.includes('cdn.discordapp.com')) return 'discord'
  if (u.includes('tiktok.com'))     return 'tiktok'
  if (u.includes('twitch.tv'))      return 'twitch'
  if (u.includes('vimeo.com'))      return 'vimeo'
  return 'other'
}

async function withInstagramThumbnailPath(url: string, info: object & { thumbnail?: string; remoteThumbnail?: string }) {
  if (detectPlatformName(url) !== 'instagram' || !info.thumbnail) return info
  const thumbnailPath = await downloadRemoteThumbnail(info.remoteThumbnail ?? info.thumbnail).catch(() => null)
  if (!thumbnailPath) return info
  return {
    ...info,
    remoteThumbnail: info.remoteThumbnail ?? info.thumbnail,
    thumbnail: pathToFileUrl(thumbnailPath),
    thumbnailPath
  }
}

async function resolveInstagramDownloadThumbnail(outputPath?: string, remoteThumbnail?: string): Promise<string | null> {
  const remote = remoteThumbnail ? await downloadRemoteThumbnail(remoteThumbnail).catch(() => null) : null
  if (remote) return remote
  return outputPath ? generateThumbnail(outputPath).catch(() => null) : null
}

function pathToFileUrl(filePath: string): string {
  if (/^file:\/\//i.test(filePath)) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(prefixed)}`
}

function parseProgress(line: string): Record<string, unknown> | null {
  const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\S]+)\s+at\s+([\S]+)\s+ETA\s+([\S]+)/)
  if (m) return { percent: parseFloat(m[1]), totalSize: m[2], speed: m[3], eta: m[4] }
  if (line.includes('[download] 100%')) return { percent: 100, totalSize: '', speed: '', eta: '0:00' }
  const m2 = line.match(/\[download\]\s+([\d.]+\w+)\s+at\s+([\S]+)/)
  if (m2) return { percent: -1, totalSize: '?', speed: m2[2], eta: '?' }
  return null
}

interface RawFormat { height?: number; vcodec?: string }
interface RawInfo {
  id: string; title: string; thumbnail: string; duration: number
  uploader: string; webpage_url: string; extractor: string; formats?: RawFormat[]
}

function parseVideoInfo(raw: RawInfo) {
  const ffmpeg  = hasFfmpeg()
  const heights = new Set<number>()
  for (const f of raw.formats ?? []) {
    if (f.height && f.height > 0) heights.add(f.height)
  }

  const std = [2160, 1080, 720, 480, 360]
  const videoQ = std
    .filter(h => heights.size === 0 || [...heights].some(fh => fh >= h))
    .map(h => ({ id: `${h}p`, label: qLabel(`${h}p`), type: 'video' as const }))

  if (videoQ.length === 0) videoQ.push({ id: 'best', label: 'En İyi', type: 'video' })

  const audioQ = ffmpeg
    ? ['mp3', 'm4a', 'aac'].map(id => ({ id, label: qLabel(id), type: 'audio' as const }))
    : [{ id: 'm4a', label: 'M4A', type: 'audio' as const }]

  return {
    id: raw.id, title: raw.title, thumbnail: raw.thumbnail,
    duration: raw.duration, uploader: raw.uploader,
    url: raw.webpage_url, platform: raw.extractor,
    formats: [...videoQ, ...audioQ], hasFfmpeg: ffmpeg,
    remoteThumbnail: raw.thumbnail
  }
}

function qLabel(f: string): string {
  const map: Record<string, string> = {
    '2160p': '4K', '1080p': 'Full HD', '720p': 'HD', '480p': 'SD', '360p': 'Düşük',
    'best': 'En İyi', 'mp3': 'MP3', 'm4a': 'M4A', 'aac': 'AAC'
  }
  return map[f] ?? f
}

interface DownloadOptions {
  id: string
  url: string
  format: string
  title?: string
  outputDir?: string
  filename?: string
  speedLimit?: number
  useTor?: boolean
  subtitles?: boolean
  embedSubs?: boolean
  cookieBrowser?: string
  thumbnail?: string
  singleStream?: boolean
  ytExtraClients?: boolean
}
