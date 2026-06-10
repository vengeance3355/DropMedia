import { existsSync, readdirSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { app } from 'electron'

export interface CookieSource {
  id: string
  label: string
  browser: string
  profile?: string
  path: string
  arg: string
  hasRelevantCookies: boolean
  locked?: boolean
}

interface BrowserDef {
  browser: string
  label: string
  root: string
  kind: 'firefox' | 'chromium'
  rootProfile?: boolean
}

const IS_WIN = process.platform === 'win32'

// ── Çerez snapshot ────────────────────────────────────────────────────────────
// Tarayıcı AÇIKKEN chromium çerez DB'si paylaşımsız kilitlidir; admin'siz canlı
// kopya imkansızdır (esentutl /y ve FileStream ReadWrite ikisi de "in use" verir).
// yt-dlp'nin "tarayıcıyı kapatın" demesinin sebebi budur. Çözüm: dosya
// kopyalanabildiği HER an (tarayıcı kapalı/erişilebilir) Cookies + Local State'i
// (decrypt anahtarı) userData/cookie-cache'e kopyala; kilitliyken son
// snapshot'tan oku. Opera GX vb. ESKİ DPAPI şifrelemesi kullanır (App-Bound
// değil) — yt-dlp snapshot'tan decrypt edebilir; session çerezleri haftalarca
// geçerli olduğundan kullanıcı tarayıcıyı yalnızca bir kez (ya da doğal kapalı
// anlarda) kapatması yeter, her indirmede değil.
//
// yt-dlp yol semantiği (canlı doğrulandı): "browser:<dir>" -> Cookies <dir>
// ağacında aranır; Local State browser_dir'den okunur. opera
// supports_profiles=False -> browser_dir = verilen path (Local State o path'in
// kökünde olmalı); chrome/edge/brave/chromium -> browser_dir = dirname(path).

interface SourceRef { def: BrowserDef; profile: string; cookiePath: string }

function cookieCacheRoot(): string {
  try {
    const dir = join(app.getPath('userData'), 'cookie-cache')
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return join(process.env.LOCALAPPDATA || process.env.TMP || '.', 'dropmedia-cookie-cache')
  }
}

// Tüm tarayıcı/profillerde var olan çerez kaynakları (rank sıralı).
function listSourceRefs(): SourceRef[] {
  const refs: SourceRef[] = []
  for (const def of getBrowserDefs()) {
    if (!existsSync(def.root)) continue
    for (const profile of profileDirs(def)) {
      const cookiePath = cookiePathFor(def, profile)
      if (cookiePath && existsSync(cookiePath)) refs.push({ def, profile, cookiePath })
    }
  }
  return refs.sort((a, b) => browserRank(a.def.browser) - browserRank(b.def.browser))
}

// Snapshot'ı tazele (kopyalanabiliyorsa) + geçerli snapshot varsa yt-dlp
// argümanını döndür; yoksa null (firefox kilitlemez -> canlı arg).
function snapshotArg(ref: SourceRef): string | null {
  const { def, profile, cookiePath } = ref
  if (def.kind === 'firefox') return cookieArgFor(def, profile)

  const snapDir = join(cookieCacheRoot(), def.browser)
  try { mkdirSync(snapDir, { recursive: true }) } catch { /* ignore */ }

  // Local State (kilitsiz) — her seferinde tazele.
  const lsSrc = join(def.root, 'Local State')
  try { if (existsSync(lsSrc)) copyFileSync(lsSrc, join(snapDir, 'Local State')) } catch { /* ignore */ }

  const opera = def.browser === 'opera'
  const profDir = opera ? snapDir : join(snapDir, profile || 'Default')
  try { mkdirSync(profDir, { recursive: true }) } catch { /* ignore */ }
  const cookieDest = join(profDir, 'Cookies')
  // Cookies — kilitliyse kopya atılır, ESKİ snapshot korunur.
  try { copyFileSync(cookiePath, cookieDest) } catch { /* kilitli */ }

  if (existsSync(join(snapDir, 'Local State')) && existsSync(cookieDest)) {
    return `${def.browser}:${opera ? snapDir : profDir}`
  }
  return null
}

// Uygulama açılışında + periyodik: erişilebilir tüm çerezleri snapshot'la.
export function snapshotAllCookies(): void {
  for (const ref of listSourceRefs()) {
    try { snapshotArg(ref) } catch { /* ignore */ }
  }
}

// Mesajlaşma: chromium kaynağı VAR ama henüz okunabilir snapshot YOK (tarayıcı
// hiç kapanmamış) -> "bir kez kapat" denecek etiket; aksi halde null.
export function cookieSnapshotMissingLabel(_url?: string): string | null {
  const refs = listSourceRefs().filter(ref => ref.def.kind === 'chromium')
  if (!refs.length) return null
  for (const ref of refs) if (snapshotArg(ref)) return null
  return refs[0].def.label
}

// Platform-aware home paths
const HOME         = process.env.HOME ?? process.env.USERPROFILE ?? ''
const APPDATA      = process.env.APPDATA ?? ''
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''

function getBrowserDefs(): BrowserDef[] {
  if (IS_WIN) {
    return [
      { browser: 'firefox',  label: 'Firefox',  root: join(APPDATA, 'Mozilla', 'Firefox', 'Profiles'),                       kind: 'firefox'  },
      { browser: 'chrome',   label: 'Chrome',   root: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),                   kind: 'chromium' },
      { browser: 'chromium', label: 'Chromium', root: join(LOCALAPPDATA, 'Chromium', 'User Data'),                           kind: 'chromium' },
      { browser: 'brave',    label: 'Brave',    root: join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data'),     kind: 'chromium' },
      { browser: 'opera',    label: 'Opera GX', root: join(APPDATA, 'Opera Software', 'Opera GX Stable'),                    kind: 'chromium', rootProfile: true },
      { browser: 'opera',    label: 'Opera',    root: join(APPDATA, 'Opera Software', 'Opera Stable'),                       kind: 'chromium', rootProfile: true },
      { browser: 'edge',     label: 'Edge',     root: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),                  kind: 'chromium' },
    ]
  }
  return [
    { browser: 'firefox',  label: 'Firefox',  root: join(HOME, '.mozilla/firefox'),                      kind: 'firefox'  },
    { browser: 'chrome',   label: 'Chrome',   root: join(HOME, '.config/google-chrome'),                 kind: 'chromium' },
    { browser: 'chromium', label: 'Chromium', root: join(HOME, '.config/chromium'),                      kind: 'chromium' },
    { browser: 'brave',    label: 'Brave',    root: join(HOME, '.config/BraveSoftware/Brave-Browser'),   kind: 'chromium' },
    { browser: 'opera',    label: 'Opera',    root: join(HOME, '.config/opera'),                         kind: 'chromium', rootProfile: true },
    { browser: 'edge',     label: 'Edge',     root: join(HOME, '.config/microsoft-edge'),                kind: 'chromium' },
  ]
}

export function detectCookieSources(url?: string): CookieSource[] {
  const domains = domainsForUrl(url)
  const sources: CookieSource[] = []
  const defaultProgId = readDefaultBrowserProgId()

  for (const def of getBrowserDefs()) {
    if (!existsSync(def.root)) continue
    const profiles = profileDirs(def)

    for (const profile of profiles) {
      const cookiePath = cookiePathFor(def, profile)
      if (!cookiePath || !existsSync(cookiePath)) continue

      const hasRelevantCookies = domains.length > 0
        ? hasDomainCookie(def.kind, cookiePath, domains)
        : false

      const arg = cookieArgFor(def, profile)
      sources.push({
        id: arg,
        label: profileLabel(def, profile, defaultProgId),
        browser: def.browser,
        profile: def.rootProfile ? undefined : profile,
        path: cookiePath,
        arg,
        hasRelevantCookies
      })
    }
  }

  return sources.sort((a, b) => {
    if (a.hasRelevantCookies !== b.hasRelevantCookies) return a.hasRelevantCookies ? -1 : 1
    return browserRank(a.browser) - browserRank(b.browser)
  })
}

export function resolveAutoCookieBrowser(_url?: string): string | undefined {
  // Snapshot'ı olan (okunabilir) ilk kaynağı kullan. Hiçbiri yoksa undefined ->
  // çerezsiz dene (chromium canlı argümanı kilitli/yanlış olur, boşa deneme).
  for (const ref of listSourceRefs()) {
    const arg = snapshotArg(ref)
    if (arg) return arg
  }
  return undefined
}

// Story/post için: TÜM tarayıcıların okunabilir (snapshot) cookie argümanları
// (rank sıralı, tekrarsız). exportCookieBundle bunları sırayla dener — kullanıcının
// "varsayılan" tarayıcısı Instagram'a girişli değilse bile başka bir tarayıcı
// (Opera/Firefox/Edge) çerezi yakalanabilir. firefox snapshot vermez → canlı arg.
export function listCookieExportArgs(): string[] {
  const args: string[] = []
  for (const ref of listSourceRefs()) {
    const arg = snapshotArg(ref) ?? (ref.def.kind === 'firefox' ? cookieArgFor(ref.def, ref.profile) : null)
    if (arg && !args.includes(arg)) args.push(arg)
  }
  return args
}

export function resolveCookieBrowser(setting?: string, url?: string): string | undefined {
  const value = (setting ?? '').trim()
  if (value === 'devre dışı' || value === 'disabled') return undefined
  if (!value || value === 'auto') return resolveAutoCookieBrowser(url)

  const match = listSourceRefs().find(ref =>
    value.includes(':') ? cookieArgFor(ref.def, ref.profile) === value : ref.def.browser === value
  )
  if (match) return snapshotArg(match) ?? undefined
  return value.includes(':') ? value : undefined // bilinmeyen explicit değer: olduğu gibi
}

function profileDirs(def: BrowserDef): string[] {
  try {
    if (def.rootProfile) {
      // Eski Opera düzeni: çerez kökte. Yeni Opera/Opera GX: Chrome gibi
      // Default / "Profile N" alt dizinlerinde. İkisini de destekle.
      const dirs: string[] = []
      if (existsSync(join(def.root, 'Network', 'Cookies')) || existsSync(join(def.root, 'Cookies'))) {
        dirs.push('')
      }
      const entries = readdirSync(def.root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      for (const name of entries) {
        if (name === 'Default' || name.startsWith('Profile ')) dirs.push(name)
      }
      return dirs.length ? dirs : ['']
    }

    const entries = readdirSync(def.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)

    if (def.kind === 'firefox') {
      return entries.filter(name =>
        name.includes('.default') ||
        name.includes('.default-release') ||
        name.includes('.release')
      )
    }

    return entries.filter(name =>
      name === 'Default' ||
      name.startsWith('Profile ') ||
      name === 'Guest Profile'
    )
  } catch {
    return []
  }
}

function cookiePathFor(def: BrowserDef, profile: string): string | null {
  if (def.kind === 'firefox') return join(def.root, profile, 'cookies.sqlite')

  const profileRoot = profile ? join(def.root, profile) : def.root
  const networkPath = join(profileRoot, 'Network', 'Cookies')
  if (existsSync(networkPath)) return networkPath
  return join(profileRoot, 'Cookies')
}

function cookieArgFor(def: BrowserDef, profile: string): string {
  // rootProfile tarayıcılarda (Opera/GX) yt-dlp'nin "opera" anahtarı yalnızca
  // Opera Stable'ı bulur; profil olarak TAM YOL geçilir (yt-dlp destekler).
  if (def.rootProfile) return `${def.browser}:${profile ? join(def.root, profile) : def.root}`
  return `${def.browser}:${profile}`
}

// OS varsayılan tarayıcısının ProgId'sini okur (Windows). Örn. Opera GX ->
// "operagxstable", Chrome -> "chromehtml-...". Yalnızca etiketleme için.
function readDefaultBrowserProgId(): string {
  if (!IS_WIN) return ''
  try {
    const r = spawnSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v', 'ProgId'], { encoding: 'utf8', timeout: 3000 })
    // Değer boşluk içerebilir ("Opera GXStable") — satır sonuna kadar yakala,
    // yoksa \S+ boşlukta kesilip yanlış eşleşir.
    const m = (r.stdout || '').match(/ProgId\s+REG_SZ\s+(.+)/)
    return m ? m[1].trim().toLowerCase().replace(/\s+/g, '') : ''
  } catch {
    return ''
  }
}

// Bu tarayıcı tanımı OS varsayılanı mı? (Opera GX vs Opera ayrımı dahil)
function isDefaultBrowserDef(def: BrowserDef, progId: string): boolean {
  if (!progId) return false
  const isGx = def.label.toLowerCase().includes('gx')
  switch (def.browser) {
    case 'opera':    return isGx ? progId.includes('operagx') : (progId.includes('opera') && !progId.includes('operagx'))
    case 'chrome':   return progId.includes('chromehtml') || (progId.includes('chrome') && !progId.includes('chromium'))
    case 'edge':     return progId.includes('msedge') || progId.includes('edgehtm')
    case 'brave':    return progId.includes('brave')
    case 'firefox':  return progId.includes('firefox')
    case 'chromium': return progId.includes('chromium')
    default:         return false
  }
}

// Sade etiket: ana profil ("Default"/boş/firefox .default*) -> yalnız tarayıcı
// adı (gereksiz "(Default)" gürültüsü yok); ikincil profil -> profil adıyla.
function cleanProfileLabel(def: BrowserDef, profile: string): string {
  if (def.kind === 'firefox') {
    if (/\.default(-release)?$/i.test(profile) || /\.release$/i.test(profile)) return def.label
    return `${def.label} (${profile.replace(/^[^.]*\./, '')})`
  }
  if (!profile || profile === 'Default') return def.label
  return `${def.label} (${profile})` // "Profile 1" vb.
}

function profileLabel(def: BrowserDef, profile: string, defaultProgId = ''): string {
  const base = cleanProfileLabel(def, profile)
  return isDefaultBrowserDef(def, defaultProgId) ? `${base} (varsayılan)` : base
}

function hasDomainCookie(kind: BrowserDef['kind'], dbPath: string, domains: string[]): boolean {
  // sqlite3 Windows'ta standart değil — domain kontrolünü atla
  if (IS_WIN) return false
  if (!existsSync('/usr/bin/sqlite3')) return false

  const column = kind === 'firefox' ? 'host' : 'host_key'
  const table  = kind === 'firefox' ? 'moz_cookies' : 'cookies'
  const where  = domains
    .map(domain => `${column} LIKE '%${domain.replace(/'/g, "''")}'`)
    .join(' OR ')
  const query  = `SELECT 1 FROM ${table} WHERE ${where} LIMIT 1;`
  const result = spawnSync('sqlite3', ['-readonly', dbPath, query], { timeout: 1000 })
  return result.status === 0 && result.stdout.toString().trim() === '1'
}

function domainsForUrl(url?: string): string[] {
  if (!url) return []
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'x.com' || host.endsWith('.x.com') || host.includes('twitter.com')) return ['x.com', 'twitter.com']
    if (host.includes('youtube.com') || host === 'youtu.be') return ['youtube.com', 'google.com']
    if (host.includes('instagram.com')) return ['instagram.com']
    if (host.includes('tiktok.com')) return ['tiktok.com']
    if (host.includes('facebook.com') || host === 'fb.watch') return ['facebook.com']
    return [host]
  } catch {
    return []
  }
}

function browserRank(browser: string): number {
  const ranks: Record<string, number> = { opera: 0, firefox: 1, brave: 2, chrome: 3, chromium: 4, edge: 5 }
  return ranks[browser] ?? 99
}
