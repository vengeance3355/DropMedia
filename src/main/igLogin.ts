/**
 * igLogin.ts
 * Uygulama içi Instagram girişi — tarayıcı çerezi çıkarılamadığında son çare.
 *
 * Neden gerekli: Chrome/Edge 127+ çerezleri App-Bound Encryption ile şifreler;
 * yt-dlp DPAPI ile çözemez (yt-dlp #7271/#10927). Kullanıcı yalnızca Chrome
 * kullanıyorsa "tüm tarayıcıları dene" bile boş döner. Burada kullanıcı
 * DropMedia içinde açılan pencerede Instagram'a bir kez girer; çerezler
 * Electron'un kendi kalıcı partition'ından (persist:ig-login) okunur —
 * hiçbir tarayıcı şifrelemesine bağımlılık kalmaz, oturum app yeniden
 * başlatılınca da yaşar.
 */

import { BrowserWindow, session, Session } from 'electron'

export interface CookieBundle { header: string; csrf?: string }

const IG_PARTITION = 'persist:ig-login'
const LOGIN_URL = 'https://www.instagram.com/accounts/login/'
// instagramStories.ts ile aynı UA: login sayfası + sonraki API çağrıları tutarlı
// bir Chrome gibi görünsün (Electron'un varsayılan UA'sı engellenebiliyor).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function igSession(): Session {
  const ses = session.fromPartition(IG_PARTITION)
  ses.setUserAgent(UA)
  return ses
}

async function bundleFrom(ses: Session): Promise<CookieBundle | null> {
  try {
    const cookies = await ses.cookies.get({ domain: 'instagram.com' })
    const pairs: string[] = []
    let csrf: string | undefined
    let hasSession = false
    for (const c of cookies) {
      if (!c.name || !c.value) continue
      pairs.push(`${c.name}=${c.value}`)
      if (c.name === 'csrftoken') csrf = c.value
      if (c.name === 'sessionid') hasSession = true
    }
    // sessionid yoksa giriş yok (anonim çerez) — geçersiz say.
    if (!hasSession) return null
    return { header: pairs.join('; '), csrf }
  } catch {
    return null
  }
}

/** Pencere açmadan: daha önce uygulama içinden girilmişse çerezleri döndürür. */
export function cookieBundleFromPartition(): Promise<CookieBundle | null> {
  return bundleFrom(igSession())
}

let pendingLogin: Promise<CookieBundle | null> | null = null

/**
 * Instagram giriş penceresi açar; kullanıcı giriş yapınca (sessionid çerezi
 * oluşunca) pencere otomatik kapanır ve çerezler döner. Kullanıcı pencereyi
 * kapatır ya da 5 dk dolarsa null. Eşzamanlı çağrılar tek pencereyi paylaşır.
 * clearFirst: bayat/geçersiz oturumda partition temizlenir — poll eski
 * sessionid'yi "giriş yapıldı" sanmasın.
 */
export function promptIgLogin(opts: { clearFirst?: boolean } = {}): Promise<CookieBundle | null> {
  if (pendingLogin) return pendingLogin
  pendingLogin = (async () => {
    const ses = igSession()
    if (opts.clearFirst) {
      try { await ses.clearStorageData() } catch { /* ignore */ }
    }
    return await new Promise<CookieBundle | null>((resolve) => {
      let win: BrowserWindow | null = new BrowserWindow({
        width: 460,
        height: 780,
        autoHideMenuBar: true,
        title: 'Instagram Girişi — DropMedia',
        webPreferences: { partition: IG_PARTITION }
      })

      let settled = false
      let poll: ReturnType<typeof setInterval> | null = null
      let deadline: ReturnType<typeof setTimeout> | null = null
      const finish = (b: CookieBundle | null): void => {
        if (settled) return
        settled = true
        if (poll) clearInterval(poll)
        if (deadline) clearTimeout(deadline)
        const w = win
        win = null
        if (w && !w.isDestroyed()) { try { w.destroy() } catch { /* ignore */ } }
        resolve(b)
      }

      poll = setInterval(() => { void bundleFrom(ses).then(b => { if (b) finish(b) }) }, 1500)
      deadline = setTimeout(() => finish(null), 5 * 60_000)
      // Kullanıcı pencereyi elle kapattı: tam o anda giriş bitmiş olabilir —
      // son bir kez çerezlere bak.
      win.on('closed', () => { void bundleFrom(ses).then(finish) })

      win.webContents.setUserAgent(UA)
      void win.loadURL(LOGIN_URL)
    })
  })().finally(() => { pendingLogin = null })
  return pendingLogin
}
