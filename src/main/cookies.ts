import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

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

// Tarayıcı AÇIKKEN chromium çerez DB'si kilitlidir; yt-dlp kopyalayamaz
// ("Could not copy Chrome cookie database", yt-dlp#7271). AUTO seçim çalışan
// tarayıcıyı atlasın diye süreç listesi kontrol edilir (5sn cache).
const BROWSER_PROCESSES: Record<string, string[]> = {
  chrome: ['chrome.exe'],
  chromium: ['chromium.exe'],
  brave: ['brave.exe'],
  opera: ['opera.exe'],
  edge: ['msedge.exe']
}

let runningProcsCache: { at: number; names: Set<string> } | null = null

function runningProcessNames(): Set<string> {
  if (runningProcsCache && Date.now() - runningProcsCache.at < 5000) return runningProcsCache.names
  const names = new Set<string>()
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 4000 })
    for (const line of (r.stdout?.toString() ?? '').split('\n')) {
      const m = line.match(/^"([^"]+)"/)
      if (m) names.add(m[1].toLowerCase())
    }
  } catch { /* tasklist yoksa kilit tespiti devre dışı kalır */ }
  runningProcsCache = { at: Date.now(), names }
  return names
}

function isBrowserLocked(browser: string, kind: 'firefox' | 'chromium'): boolean {
  if (!IS_WIN || kind !== 'chromium') return false
  const procs = BROWSER_PROCESSES[browser] ?? []
  if (!procs.length) return false
  const running = runningProcessNames()
  return procs.some(p => running.has(p))
}

// AUTO'nun normalde seçeceği ama tarayıcı açık olduğu için kilitli olan en iyi
// kaynak — indirme hatalarında "tarayıcıyı kapatın" yönlendirmesi için.
export function lockedAutoSourceLabel(url?: string): string | null {
  const locked = detectCookieSources(url).find(source => source.locked)
  return locked?.label ?? null
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
        label: profileLabel(def, profile),
        browser: def.browser,
        profile: def.rootProfile ? undefined : profile,
        path: cookiePath,
        arg,
        hasRelevantCookies,
        locked: isBrowserLocked(def.browser, def.kind)
      })
    }
  }

  return sources.sort((a, b) => {
    if (a.hasRelevantCookies !== b.hasRelevantCookies) return a.hasRelevantCookies ? -1 : 1
    if (!!a.locked !== !!b.locked) return a.locked ? 1 : -1
    return browserRank(a.browser) - browserRank(b.browser)
  })
}

// Hafif kaynak bulma — sqlite3 çalıştırmaz, sadece dosya varlığı kontrol eder.
function findCookieSources(): { arg: string; browser: string; locked: boolean }[] {
  const sources: { arg: string; browser: string; locked: boolean }[] = []
  for (const def of getBrowserDefs()) {
    if (!existsSync(def.root)) continue
    for (const profile of profileDirs(def)) {
      const cookiePath = cookiePathFor(def, profile)
      if (!cookiePath || !existsSync(cookiePath)) continue
      sources.push({
        arg: cookieArgFor(def, profile),
        browser: def.browser,
        locked: isBrowserLocked(def.browser, def.kind)
      })
    }
  }
  return sources.sort((a, b) => browserRank(a.browser) - browserRank(b.browser))
}

export function resolveAutoCookieBrowser(url?: string): string | undefined {
  // Kilitli (açık tarayıcı) kaynakları atla: denemesi kesin başarısız, her
  // işlemde ilk denemeyi boşa harcar + log kirletir.
  const detected = detectCookieSources(url).find(source => !source.locked)
  if (detected) return detected.arg
  return findCookieSources().find(source => !source.locked)?.arg
}

export function resolveCookieBrowser(setting?: string, url?: string): string | undefined {
  const value = (setting ?? '').trim()
  if (!value) return resolveAutoCookieBrowser(url)
  if (value === 'auto') return resolveAutoCookieBrowser(url)
  if (value === 'devre dışı' || value === 'disabled') return undefined

  const sources = findCookieSources()

  if (value.includes(':')) {
    const exact = sources.find(s => s.arg === value)
    return exact?.arg ?? value  // Bulunamazsa olduğu gibi geç
  }

  return sources.find(s => s.browser === value)?.arg
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

function profileLabel(def: BrowserDef, profile: string): string {
  if (def.rootProfile) return profile ? `${def.label} (${profile})` : def.label
  return `${def.label} (${profile})`
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
