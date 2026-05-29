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
}

interface BrowserDef {
  browser: string
  label: string
  root: string
  kind: 'firefox' | 'chromium'
}

const HOME = process.env.HOME ?? ''

const BROWSERS: BrowserDef[] = [
  { browser: 'firefox',  label: 'Firefox',  root: join(HOME, '.mozilla/firefox'), kind: 'firefox' },
  { browser: 'chrome',   label: 'Chrome',   root: join(HOME, '.config/google-chrome'), kind: 'chromium' },
  { browser: 'chromium', label: 'Chromium', root: join(HOME, '.config/chromium'), kind: 'chromium' },
  { browser: 'brave',    label: 'Brave',    root: join(HOME, '.config/BraveSoftware/Brave-Browser'), kind: 'chromium' },
  { browser: 'edge',     label: 'Edge',     root: join(HOME, '.config/microsoft-edge'), kind: 'chromium' }
]

export function detectCookieSources(url?: string): CookieSource[] {
  const domains = domainsForUrl(url)
  const sources: CookieSource[] = []

  for (const def of BROWSERS) {
    if (!existsSync(def.root)) continue
    const profiles = profileDirs(def)

    for (const profile of profiles) {
      const cookiePath = cookiePathFor(def, profile)
      if (!cookiePath || !existsSync(cookiePath)) continue

      const hasRelevantCookies = domains.length > 0
        ? hasDomainCookie(def.kind, cookiePath, domains)
        : false

      const arg = `${def.browser}:${profile}`
      sources.push({
        id: arg,
        label: `${def.label} (${profile})`,
        browser: def.browser,
        profile,
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

// Hafif kaynak bulma — sqlite3 çalıştırmaz, sadece dosya varlığı kontrol eder.
// İndirme/fetch sırasında kullanılır; Settings UI hasDomainCookie için detectCookieSources kullanır.
function findCookieSources(): { arg: string; browser: string }[] {
  const sources: { arg: string; browser: string }[] = []
  for (const def of BROWSERS) {
    if (!existsSync(def.root)) continue
    for (const profile of profileDirs(def)) {
      const cookiePath = cookiePathFor(def, profile)
      if (!cookiePath || !existsSync(cookiePath)) continue
      sources.push({ arg: `${def.browser}:${profile}`, browser: def.browser })
    }
  }
  return sources.sort((a, b) => browserRank(a.browser) - browserRank(b.browser))
}

export function resolveCookieBrowser(setting?: string): string | undefined {
  const value = (setting ?? '').trim()
  // Boş veya 'auto' → cookie kullanma (cookiesiz yt-dlp genellikle daha güvenli çalışır)
  if (!value || value === 'auto' || value === 'devre dışı' || value === 'disabled') return undefined

  const sources = findCookieSources()

  if (value.includes(':')) {
    const exact = sources.find(s => s.arg === value)
    return exact?.arg ?? value  // Bulunamazsa olduğu gibi geç
  }

  return sources.find(s => s.browser === value)?.arg
}

function profileDirs(def: BrowserDef): string[] {
  try {
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

  const networkPath = join(def.root, profile, 'Network', 'Cookies')
  if (existsSync(networkPath)) return networkPath
  return join(def.root, profile, 'Cookies')
}

function hasDomainCookie(kind: BrowserDef['kind'], dbPath: string, domains: string[]): boolean {
  if (!existsSync('/usr/bin/sqlite3')) return false
  const column = kind === 'firefox' ? 'host' : 'host_key'
  const table = kind === 'firefox' ? 'moz_cookies' : 'cookies'
  const where = domains
    .map(domain => `${column} LIKE '%${domain.replace(/'/g, "''")}'`)
    .join(' OR ')
  const query = `SELECT 1 FROM ${table} WHERE ${where} LIMIT 1;`
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
  const ranks: Record<string, number> = { firefox: 0, brave: 1, chrome: 2, chromium: 3, edge: 4 }
  return ranks[browser] ?? 99
}
