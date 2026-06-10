/**
 * instagramStories.ts
 * Instagram story/highlight listesini DOĞRUDAN Instagram'ın reels_media
 * API'sinden çeker ve story görüntüleyiciyi besler.
 *
 * Neden yt-dlp değil: instagram:story extractor'ı highlight/story
 * playlist'lerinde 0 öğe döndürüyor (2026.03.17 ve 2026.06.09 ile canlı
 * doğrulandı); aynı çerezlerle reels_media API'si tam veri veriyor.
 *
 * Çerez çözümü yt-dlp'ye bırakılır: --cookies-from-browser (snapshot dahil)
 * + --cookies export'u ile DPAPI çözülmüş Netscape jar alınır, Instagram
 * çerezleri Cookie header'ına çevrilir. Jar okunur okunmaz silinir.
 */

import { spawn } from 'child_process'
import { get as httpsGet } from 'https'
import { IpcMain, BrowserWindow } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Store from 'electron-store'
import { resolveCookieBrowser, cookieSnapshotMissingLabel } from './cookies'
import { getYtDlpPath } from './downloader'
import { logError, logDownload } from './logger'

const store = new Store()

const IG_APP_ID = '936619743392459'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface StoryItem {
  id: string
  index: number
  username: string
  isVideo: boolean
  mediaUrl: string
  thumbnail: string
  duration: number
  takenAt: number
  width: number
  height: number
  pageUrl: string
}

export interface StoryReel {
  kind: 'user' | 'highlight'
  id: string
  username: string
  title: string
  items: StoryItem[]
}

// ── URL ayrıştırma ────────────────────────────────────────────────────────────

export function parseStoriesUrl(rawUrl: string): { kind: 'user'; username: string } | { kind: 'highlight'; id: string } | null {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'stories' || parts.length < 2) return null
    if (parts[1] === 'highlights') {
      const id = (parts[2] ?? '').replace(/\D/g, '')
      return id ? { kind: 'highlight', id } : null
    }
    return { kind: 'user', username: parts[1] }
  } catch {
    return null
  }
}

// ── Çerez çözümü (yt-dlp jar export, 5 dk cache) ─────────────────────────────

interface CookieBundle { header: string; csrf?: string }
let cookieCache: { bundle: CookieBundle; at: number } | null = null
const COOKIE_TTL = 5 * 60_000

function exportCookieBundle(): Promise<CookieBundle | null> {
  const cached = cookieCache
  if (cached && Date.now() - cached.at < COOKIE_TTL) return Promise.resolve(cached.bundle)

  const source = resolveCookieBrowser(store.get('cookieBrowser') as string | undefined, 'https://www.instagram.com/')
  if (!source) return Promise.resolve(null)

  const jar = join(tmpdir(), `dropmedia-ig-jar-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  return new Promise((resolve) => {
    // URL "unsupported" hatası verir (exit != 0) ama jar yine de yazılır —
    // amaç yalnızca çerezleri çözüp dışa aktarmak.
    const proc = spawn(getYtDlpPath(), [
      '--ignore-config', '--no-warnings',
      '--cookies-from-browser', source,
      '--cookies', jar,
      '--simulate', 'https://www.instagram.com/'
    ])
    const timer = setTimeout(() => { try { proc.kill() } catch { /* ignore */ } }, 60_000)
    proc.on('error', () => { clearTimeout(timer); resolve(null) })
    proc.on('close', () => {
      clearTimeout(timer)
      try {
        if (!existsSync(jar)) { resolve(null); return }
        const lines = readFileSync(jar, 'utf8').split('\n')
        const pairs: string[] = []
        let csrf: string | undefined
        for (const rawLine of lines) {
          const line = rawLine.startsWith('#HttpOnly_') ? rawLine.slice('#HttpOnly_'.length) : rawLine
          if (!line || line.startsWith('#')) continue
          const cols = line.split('\t')
          if (cols.length < 7) continue
          const [domain, , , , , name, value] = cols
          if (!domain.includes('instagram.com')) continue
          const trimmed = value.trim()
          if (!name || !trimmed) continue
          pairs.push(`${name}=${trimmed}`)
          if (name === 'csrftoken') csrf = trimmed
        }
        if (!pairs.length) { resolve(null); return }
        const bundle = { header: pairs.join('; '), csrf }
        cookieCache = { bundle, at: Date.now() }
        resolve(bundle)
      } catch {
        resolve(null)
      } finally {
        try { rmSync(jar, { force: true }) } catch { /* ignore */ }
      }
    })
  })
}

// ── Instagram API GET ─────────────────────────────────────────────────────────

function igApiGet(url: string, cookies: CookieBundle): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Accept': '*/*',
      'X-IG-App-ID': IG_APP_ID,
      'Referer': 'https://www.instagram.com/',
      'Cookie': cookies.header
    }
    if (cookies.csrf) headers['X-CSRFToken'] = cookies.csrf

    const req = httpsGet(url, { headers }, (res) => {
      // Login sayfasına yönlendirme = oturum geçersiz; takip etme.
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location?.includes('login')) {
        res.resume()
        resolve({ status: 401, body: '' })
        return
      }
      let data = ''
      res.on('data', (c: Buffer) => (data += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('Instagram API zaman aşımı')))
  })
}

function authHelpMessage(): string {
  const missing = cookieSnapshotMissingLabel()
  if (missing) {
    return `Instagram oturumu için ${missing} çerezleri henüz kaydedilmedi. ${missing}'i bir kez tamamen kapatıp (arka plan/tepsi dahil) yeniden açın — DropMedia çerezleri otomatik kaydedecek.`
  }
  return 'Instagram oturumu doğrulanamadı. Tarayıcınızda instagram.com\'a giriş yaptığınızdan emin olun; gerekirse tarayıcıyı bir kez kapatıp açın.'
}

// topsearch ile user_id (pk) çöz. web_profile_info çoğu zaman 429 (rate-limit)
// döndürüyor ve 24 saatlik story'lerde "tarayıcı aç-kapa" hatasına yol açıyordu
// (canlı doğrulandı: web_profile_info=429, topsearch=200). Highlights bu yolu
// kullanmaz — onların işleyişi değişmez.
async function resolveUserIdViaSearch(username: string, cookies: CookieBundle): Promise<string | null> {
  const r = await igApiGet(
    `https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(username)}`,
    cookies
  )
  if (r.status !== 200) return null
  try {
    const data = JSON.parse(r.body) as { users?: Array<{ user?: { pk?: string | number; username?: string } }> }
    const lower = username.toLowerCase()
    const match = data.users?.find(u => (u.user?.username || '').toLowerCase() === lower)
    const pk = match?.user?.pk
    return pk != null ? String(pk) : null
  } catch {
    return null
  }
}

async function resolveUserId(username: string, cookies: CookieBundle): Promise<string> {
  // Önce topsearch (güvenilir), olmazsa web_profile_info'ya düş.
  const viaSearch = await resolveUserIdViaSearch(username, cookies)
  if (viaSearch) return viaSearch

  const r = await igApiGet(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    cookies
  )
  if (r.status === 200) {
    try {
      const id = (JSON.parse(r.body) as { data?: { user?: { id?: string } } }).data?.user?.id
      if (id) return id
    } catch { /* aşağıdaki hataya düş */ }
  }
  if (r.status === 401 || r.status === 403) throw new Error(authHelpMessage())
  if (r.status === 404) throw new Error(`@${username} bulunamadı. Kullanıcı adını kontrol edin.`)
  throw new Error(`@${username} profil bilgisi alınamadı. ${authHelpMessage()}`)
}

interface RawCandidate { url?: string; width?: number; height?: number }
interface RawStoryItem {
  pk?: string | number
  id?: string
  taken_at?: number
  media_type?: number
  video_duration?: number
  image_versions2?: { candidates?: RawCandidate[] }
  video_versions?: RawCandidate[]
  user?: { username?: string }
}
interface RawReel {
  title?: string
  user?: { username?: string }
  items?: RawStoryItem[]
}

export async function fetchStories(rawUrl: string): Promise<StoryReel> {
  const parsed = parseStoriesUrl(rawUrl)
  if (!parsed) throw new Error('Bu bağlantı bir Instagram story/highlight bağlantısı değil.')

  const cookies = await exportCookieBundle()
  if (!cookies) {
    throw new Error(`Story'ler için Instagram çerezi gerekli. ${authHelpMessage()}`)
  }

  const reelId = parsed.kind === 'highlight' ? `highlight:${parsed.id}` : await resolveUserId(parsed.username, cookies)
  const r = await igApiGet(
    `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`,
    cookies
  )
  if (r.status === 401 || r.status === 403) throw new Error(authHelpMessage())
  if (r.status !== 200) throw new Error(`Instagram yanıt vermedi (HTTP ${r.status}). Daha sonra tekrar deneyin.`)

  let reel: RawReel | undefined
  try {
    const data = JSON.parse(r.body) as { reels?: Record<string, RawReel>; reels_media?: RawReel[] }
    reel = data.reels?.[reelId] ?? data.reels_media?.[0]
  } catch {
    throw new Error(`Instagram yanıtı işlenemedi. ${authHelpMessage()}`)
  }

  const username = reel?.user?.username ?? (parsed.kind === 'user' ? parsed.username : '')
  const pageUrl = parsed.kind === 'highlight'
    ? `https://www.instagram.com/stories/highlights/${parsed.id}/`
    : `https://www.instagram.com/stories/${username}/`

  const items: StoryItem[] = (reel?.items ?? []).map((it, idx) => {
    const isVideo = it.media_type === 2
    const img = it.image_versions2?.candidates?.[0]
    const vid = isVideo ? it.video_versions?.[0] : undefined
    return {
      id: String(it.pk ?? it.id ?? idx),
      index: idx,
      username: it.user?.username ?? username,
      isVideo,
      mediaUrl: vid?.url ?? img?.url ?? '',
      thumbnail: img?.url ?? '',
      duration: typeof it.video_duration === 'number' ? it.video_duration : 0,
      takenAt: (it.taken_at ?? 0) * 1000,
      width: vid?.width ?? img?.width ?? 0,
      height: vid?.height ?? img?.height ?? 0,
      pageUrl: parsed.kind === 'user' && it.pk ? `https://www.instagram.com/stories/${username}/${it.pk}/` : pageUrl
    }
  }).filter(s => s.mediaUrl)

  if (!items.length) {
    throw new Error(parsed.kind === 'user'
      ? `@${username} şu anda aktif story paylaşmamış.`
      : 'Bu highlight boş görünüyor veya erişilemiyor.')
  }

  return {
    kind: parsed.kind,
    id: parsed.kind === 'highlight' ? parsed.id : reelId,
    username,
    title: reel?.title?.trim() || `@${username}`,
    items
  }
}

// ── Fotoğraf story indirme (yt-dlp resimleri indirmez; basit https) ──────────

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function downloadStoryMedia(opts: { id: string; url: string; outputDir: string; filename: string; isVideo?: boolean; sourceUrl?: string; title?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const ext = (() => {
      try {
        const m = new URL(opts.url).pathname.match(/\.(mp4|mov|webm|jpe?g|png|webp|heic)/i)
        if (m) return m[0]
      } catch { /* ignore */ }
      return opts.isVideo ? '.mp4' : '.jpg'
    })()
    mkdirSync(opts.outputDir, { recursive: true })
    const outputPath = join(opts.outputDir, `${sanitizeFilename(opts.filename)}${ext}`)
    const file = createWriteStream(outputPath)
    const startMs = Date.now()

    const follow = (u: string, redirects: number): void => {
      if (redirects > 5) { reject(new Error('Çok fazla yönlendirme')); return }
      const req = httpsGet(u, { headers: { 'User-Agent': UA, 'Referer': 'https://www.instagram.com/' } }, (res) => {
        const code = res.statusCode ?? 0
        if ((code === 301 || code === 302) && res.headers.location) { res.resume(); follow(res.headers.location, redirects + 1); return }
        if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code}`)); return }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let done = 0
        res.on('data', (chunk: Buffer) => {
          done += chunk.length
          if (total > 0) {
            getMainWindow()?.webContents.send('download-progress', {
              id: opts.id, percent: Math.round((done / total) * 100), totalSize: `${(total / 1024 / 1024).toFixed(1)}MiB`, speed: '', eta: ''
            })
          }
        })
        res.on('error', reject)
        res.pipe(file)
        file.on('finish', () => file.close(() => {
          getMainWindow()?.webContents.send('download-complete', { id: opts.id, success: true, code: 0, outputPath, outputDir: opts.outputDir })
          let fileSizeMb: number | undefined
          try { fileSizeMb = statSync(outputPath).size / (1024 * 1024) } catch { /* ignore */ }
          void logDownload({
            url: opts.sourceUrl ?? opts.url,
            title: opts.title,
            format: opts.isVideo ? 'story-video' : 'story-photo',
            platform: 'instagram',
            outputPath,
            fileSizeMb,
            downloadMs: Date.now() - startMs,
            command: 'internal:story-media'
          })
          resolve()
        }))
        file.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60_000, () => req.destroy(new Error('Fotoğraf indirme zaman aşımı')))
    }
    follow(opts.url, 0)
  })
}

// ── IPC ───────────────────────────────────────────────────────────────────────

export function setupInstagramStoryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('fetch-stories', async (_e, url: string) => {
    try {
      return await fetchStories(url)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({
        errorType: 'fetch',
        errorMessage: e.message,
        url,
        operation: 'fetch-stories',
        stackTrace: e.stack
      })
      throw e
    }
  })

  ipcMain.handle('download-story-media', async (_e, opts: { id: string; url: string; outputDir: string; filename: string; isVideo?: boolean; sourceUrl?: string; title?: string }) => {
    try {
      await downloadStoryMedia(opts)
      return { started: true }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const label = opts.isVideo ? 'Story videosu indirilemedi.' : 'Story fotoğrafı indirilemedi.'
      getMainWindow()?.webContents.send('download-complete', {
        id: opts.id, success: false, code: -1, error: label, outputDir: opts.outputDir
      })
      await logError({
        errorType: 'download',
        errorMessage: label,
        url: opts.sourceUrl ?? opts.url,
        operation: 'download-story-media',
        stackTrace: e.stack,
        stderr: e.message
      })
      return { started: false, error: label }
    }
  })
}
