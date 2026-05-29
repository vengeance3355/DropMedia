import { useState, useEffect } from 'react'
import { AppSettings } from '../types'

interface Props { onClose: () => void }

const DEFAULTS: AppSettings = {
  downloadDir: '', theme: 'dark', maxConcurrentDownloads: 3, language: 'tr',
  ytDlpPath: '', autoUpdate: true, showNotifications: true, filenameTemplate: '%(title)s',
  speedLimit: 0, completionSound: false, closeToTray: false, subtitles: false,
  embedSubs: false, profiles: {}, cookieBrowser: 'auto', torEnabled: false,
  clipboardWatch: false
}

interface CookieSource {
  id: string
  label: string
  browser: string
  profile?: string
  hasRelevantCookies: boolean
}

type Tab = 'genel' | 'indirme' | 'gizlilik' | 'sistem'

const SETTINGS_CACHE_KEY = 'dropmedia.settings.cache'

function loadCachedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) } : DEFAULTS
  } catch { return DEFAULTS }
}

export function Settings({ onClose }: Props) {
  const [settings, setSettings]       = useState<AppSettings>(loadCachedSettings)
  const [tab, setTab]                 = useState<Tab>('genel')
  const [ytDlpVer, setYtDlpVer]       = useState<string | null | undefined>(undefined)
  const [ffmpegOk, setFfmpegOk]       = useState<boolean | null>(null)
  const [torOk, setTorOk]             = useState<boolean | null>(null)
  const [appVersion, setAppVersion]   = useState('')
  const [saved, setSaved]             = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [cookieSources, setCookieSources] = useState<CookieSource[]>([])
  const [cookieLoading, setCookieLoading] = useState(true)

  // Installer progress
  const [ytdlpProgress, setYtdlpProgress] = useState<{ status?: string; percent?: number; version?: string; error?: string } | null>(null)
  const [ffmpegProgress, setFfmpegProgress] = useState<{ status?: string; percent?: number; error?: string } | null>(null)

  // Clipboard shortcut editing
  const [shortcutInput, setShortcutInput] = useState('')
  const [recordingKey, setRecordingKey]   = useState(false)

  useEffect(() => {
    let alive = true

    // Versiyon anında gelsin — yavaş binary check'leri beklemesin
    window.api.getAppVersion().then(v => { if (alive) setAppVersion(v) })

    async function load() {
      const [stored, ytDlp, ffmpeg, downloadsFolder, shortcut] = await Promise.all([
        window.api.getSettings(),
        window.api.checkYtDlp(),
        window.api.checkFfmpeg(),
        window.api.getDownloadsFolder(),
        window.api.getSetting('clipboardShortcut')
      ])

      if (!alive) return

      const merged = { ...DEFAULTS, ...(stored as Partial<AppSettings>) }
      const resolved = merged.downloadDir ? merged : { ...merged, downloadDir: downloadsFolder }
      setSettings(resolved)
      try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(resolved)) } catch { /* ignore */ }
      setYtDlpVer(ytDlp)
      setFfmpegOk(ffmpeg)
      setShortcutInput((shortcut as string) ?? 'Ctrl+Shift+V')
      setTorOk(!!merged.torEnabled)

      setCookieLoading(true)
      let sources = await window.api.detectCookieSources()
      if (sources.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 750))
        sources = await window.api.detectCookieSources()
      }
      if (!alive) return
      setCookieSources(sources)
      setCookieLoading(false)
      if (merged.cookieBrowser && merged.cookieBrowser !== 'auto' && sources.length > 0) {
        const selectedExists = sources.some(source =>
          source.id === merged.cookieBrowser || source.browser === merged.cookieBrowser
        )
        if (!selectedExists) {
          // Kayıtlı tarayıcı bulunamadı — sadece UI'ı sıfırla, store'a yazma
          setSettings(prev => ({ ...prev, cookieBrowser: 'auto' }))
        }
      }
    }

    load().catch(() => {
      setCookieLoading(false)
      setSettingsError('Ayarlar yüklenemedi. Teknik detay admin loguna kaydedildi.')
    })

    window.api.onYtDlpProgress(d => setYtdlpProgress(d as typeof ytdlpProgress))
    window.api.onFfmpegProgress(d => setFfmpegProgress(d as typeof ffmpegProgress))

    return () => {
      alive = false
      window.api.offInstallerListeners()
    }
  }, [])

  async function save() {
    try {
      for (const [k, v] of Object.entries(settings)) await window.api.setSetting(k, v)
      // Clipboard watch state
      if (settings.clipboardWatch) await window.api.startClipboardWatch()
      else await window.api.stopClipboardWatch()
      // Shortcut
      await window.api.setClipboardShortcut(shortcutInput)
      setSettingsError('')
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch {
      setSettingsError('Ayarlar kaydedilemedi. Teknik detay admin loguna kaydedildi.')
    }
  }

  async function handleUpdateYtDlp() {
    setYtdlpProgress({ status: 'downloading', percent: 0 })
    const r = await window.api.updateYtDlp() as { success: boolean; version?: string; error?: string }
    if (r.success) { setYtDlpVer(r.version ?? null); setYtdlpProgress({ status: 'done', version: r.version }) }
    else setYtdlpProgress({ status: 'error', error: r.error })
  }

  async function handleInstallFfmpeg() {
    setFfmpegProgress({ status: 'downloading', percent: 0 })
    const r = await window.api.installFfmpeg() as { success: boolean; error?: string }
    if (r.success) { setFfmpegOk(true); setFfmpegProgress({ status: 'done' }) }
    else setFfmpegProgress({ status: 'error', error: r.error })
  }

  function handleKeyCapture(e: React.KeyboardEvent) {
    e.preventDefault()
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    // Sadece modifier tuşuna basılıyorsa bekle — gerçek tuş gelince kaydet
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return
    const parts: string[] = []
    if (e.ctrlKey)  parts.push('Ctrl')
    if (e.shiftKey) parts.push('Shift')
    if (e.altKey)   parts.push('Alt')
    parts.push(key)
    if (parts.length > 1) {
      const combo = parts.join('+')
      setShortcutInput(combo)
      setRecordingKey(false)
      window.api.setClipboardShortcut(combo).catch(() => {})
    }
  }

  function set<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setSettingsError('')
    setSettings(s => {
      const next = { ...s, [k]: v }
      try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    window.api.setSetting(String(k), v).catch(() => {
      setSettingsError('Ayar kaydedilemedi. Teknik detay admin loguna kaydedildi.')
    })
  }

  function toggleClipboardWatch(v: boolean) {
    set('clipboardWatch', v)
    const action = v ? window.api.startClipboardWatch() : window.api.stopClipboardWatch()
    action.catch(() => setSettingsError('Clipboard izleme başlatılamadı. Teknik detay admin loguna kaydedildi.'))
  }

  async function setCookieBrowser(browser: string) {
    set('cookieBrowser', browser)
    if (browser === 'auto') {
      setCookieLoading(true)
      try {
        const sources = await window.api.detectCookieSources()
        setCookieSources(sources)
      } finally {
        setCookieLoading(false)
      }
    }
  }

  function setProfile(site: string, format: string) {
    set('profiles', { ...(settings.profiles ?? {}), [site]: format })
  }

  const speedLimit = settings.speedLimit ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <div className="relative w-full max-w-xl rounded-3xl bg-[#100c20] border border-white/10 shadow-2xl overflow-hidden animate-slide-up flex flex-col max-h-[85vh]">
        {/* Başlık */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8 shrink-0">
          <div>
            <h2 className="text-white font-semibold">Ayarlar</h2>
            <p className="text-white/30 text-xs mt-0.5">v{appVersion}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-6 pt-3 shrink-0">
          {(['genel','indirme','gizlilik','sistem'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all
                ${tab === t ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* İçerik */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5 scrollbar-thin">

          {tab === 'genel' && <>
            <Section title="İndirme Klasörü">
              <div className="flex gap-2">
                <div className="flex-1 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 text-white/60 text-sm truncate">{settings.downloadDir || 'Seçilmedi'}</div>
                <button onClick={() => window.api.selectFolder().then(f => f && set('downloadDir', f))}
                  className="px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-sm transition-all">Seç</button>
              </div>
            </Section>

            <Section title="Tema">
              <div className="flex gap-2">
                {(['dark','light'] as const).map(t => (
                  <button key={t} onClick={() => set('theme', t)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all
                      ${settings.theme === t ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'}`}>
                    {t === 'dark' ? '🌙 Koyu' : '☀️ Açık'}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Eş Zamanlı İndirme">
              <div className="flex gap-2">
                {[1,2,3,5].map(n => (
                  <button key={n} onClick={() => set('maxConcurrentDownloads', n)}
                    className={`w-12 h-10 rounded-xl text-sm font-semibold transition-all
                      ${settings.maxConcurrentDownloads === n ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Hız Limiti (MB/s)" description="0 = sınırsız">
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="50" step="1"
                  value={speedLimit}
                  onChange={e => set('speedLimit', parseInt(e.target.value, 10))}
                  className="flex-1 accent-purple-500" />
                <span className="text-white/60 text-sm w-16 text-right">
                  {speedLimit === 0 ? 'Sınırsız' : `${speedLimit} MB/s`}
                </span>
              </div>
            </Section>

            <Section title="Seçenekler">
              <div className="space-y-3">
                <Toggle label="Otomatik güncelleme" checked={settings.autoUpdate} onChange={v => set('autoUpdate', v)} />
                <Toggle label="Bildirim göster" checked={settings.showNotifications} onChange={v => set('showNotifications', v)} />
                <Toggle label="İndirme tamamlanınca ses" checked={!!settings.completionSound} onChange={v => set('completionSound', v)} />
                <Toggle label="Kapatınca tray'e küçült" checked={!!settings.closeToTray} onChange={v => set('closeToTray', v)} />
              </div>
            </Section>
          </>}

          {tab === 'indirme' && <>
            <Section title="Altyazı">
              <div className="space-y-3">
                <Toggle label="Altyazı indir (TR/EN)" checked={!!settings.subtitles} onChange={v => set('subtitles', v)} />
                <Toggle label="Altyazıyı videoya göm (ffmpeg gerekli)" checked={!!settings.embedSubs} onChange={v => set('embedSubs', v)} />
              </div>
            </Section>

            <Section title="Hızlı Presetler">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: '🎵 Müzik Modu', desc: 'Her şeyi MP3\'e dönüştür' },
                  { label: '📦 Arşiv Modu', desc: 'En yüksek kalite MP4' },
                ].map(p => (
                  <button key={p.label}
                    className="p-3 rounded-xl bg-white/5 border border-white/8 hover:border-purple-500/30 text-left transition-all group">
                    <p className="text-white/80 text-sm font-medium">{p.label}</p>
                    <p className="text-white/30 text-xs mt-0.5">{p.desc}</p>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Site Bazlı Profiller" description="Her platform için varsayılan format">
              <div className="space-y-2">
                {['youtube','twitter','instagram','tiktok'].map(site => (
                  <div key={site} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <span className="text-white/60 text-sm capitalize">{site}</span>
                    <select
                      value={settings.profiles?.[site] ?? 'best'}
                      onChange={e => setProfile(site, e.target.value)}
                      className="bg-white/8 border border-white/10 rounded-lg px-2 py-1 text-white/70 text-xs outline-none">
                      {['best','1080p','720p','480p','360p','mp3','m4a'].map(f => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </Section>
          </>}

          {tab === 'gizlilik' && <>
            <Section title="Cookie (Giriş Gerektiren Videolar)" description="Tarayıcı cookie'lerini otomatik kullan">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-white/35 text-xs">
                  {cookieLoading ? 'Cookie profilleri aranıyor…' : cookieSources.length > 0 ? `${cookieSources.length} profil bulundu` : 'Profil bulunamadı'}
                </p>
                <button
                  onClick={() => setCookieBrowser(settings.cookieBrowser ?? 'auto')}
                  className="px-2.5 py-1 rounded-lg bg-white/8 hover:bg-white/12 text-white/50 hover:text-white text-xs transition-colors"
                >
                  Yenile
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'auto', label: cookieSources[0]?.label ? `Otomatik: ${cookieSources[0].label}` : 'Otomatik' },
                  { id: '', label: 'Devre dışı' },
                  ...cookieSources.map(source => ({
                    id: source.id,
                    label: source.hasRelevantCookies ? `${source.label} ✓` : source.label
                  }))
                ].map(b => (
                  <button key={b.id || 'disabled'} onClick={() => setCookieBrowser(b.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all
                      ${(settings.cookieBrowser ?? 'auto') === b.id ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'}`}>
                    {b.label}
                  </button>
                ))}
              </div>
              {!cookieLoading && cookieSources.length === 0 && (
                <p className="text-amber-400/80 text-xs mt-2">Tarayıcı cookie profili bulunamadı.</p>
              )}
            </Section>

            <Section title="Tor Proxy" description="İndirmeleri Tor ağı üzerinden yönlendir">
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-2 text-sm ${torOk ? 'text-green-400' : 'text-white/40'}`}>
                  <span className={`w-2 h-2 rounded-full ${torOk ? 'bg-green-400 animate-pulse' : 'bg-white/20'}`} />
                  {torOk === null ? 'Kontrol ediliyor…' : torOk ? 'Tor indir açık' : 'Tor indir kapalı'}
                </div>
                <Toggle label="Tor üzerinden indir" checked={!!settings.torEnabled} onChange={v => { set('torEnabled', v); setTorOk(v) }} />
              </div>
              {!torOk && (
                <p className="text-white/30 text-xs mt-2">
                  Tor Browser'ı açık tutun veya <code className="bg-white/8 px-1 rounded">sudo apt install tor && sudo service tor start</code>
                </p>
              )}
            </Section>

            <Section title="Clipboard İzleme" description="URL kopyaladığında otomatik algılar ve indirme kutusuna doldurur">
              <Toggle label="Clipboard izlemeyi etkinleştir" checked={!!settings.clipboardWatch} onChange={toggleClipboardWatch} />
            </Section>

            <Section title="Direkt İndirme Kısayolu" description="Kısayola basınca clipboard'daki URL pencere açılmadan arka planda indirilir">
              <div className="flex items-center gap-2">
                <div
                  onClick={() => setRecordingKey(true)}
                  onKeyDown={recordingKey ? handleKeyCapture : undefined}
                  tabIndex={0}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm cursor-pointer outline-none transition-all
                    ${recordingKey ? 'bg-purple-500/20 border border-purple-500/50 text-purple-300' : 'bg-white/8 border border-white/10 text-white/60'}`}>
                  {recordingKey ? 'Modifier + tuş kombinasyonuna basın…' : (shortcutInput || 'Kısayol belirle')}
                </div>
                {shortcutInput && (
                  <button onClick={() => { setShortcutInput(''); window.api.setClipboardShortcut('') }}
                    className="text-white/30 hover:text-white/60 text-xs">Sil</button>
                )}
              </div>
            </Section>
          </>}

          {tab === 'sistem' && <>
            {/* ffmpeg */}
            <Section title="ffmpeg" description={ffmpegOk === null ? 'Kontrol ediliyor…' : ffmpegOk ? 'Kurulu — yüksek kalite aktif' : 'Kurulu değil — bazı formatlar kısıtlı'}>
              <div className="flex items-center gap-3 mb-2">
                <span className={`w-2 h-2 rounded-full ${ffmpegOk ? 'bg-green-400' : 'bg-amber-400'}`} />
                <span className={`text-sm ${ffmpegOk ? 'text-green-400' : 'text-amber-400'}`}>
                  {ffmpegOk === null ? 'ffmpeg kontrol ediliyor…' : ffmpegOk ? 'ffmpeg kurulu' : 'ffmpeg kurulu değil'}
                </span>
              </div>
              {ffmpegOk === false && (
                <button onClick={handleInstallFfmpeg} disabled={ffmpegProgress?.status === 'downloading'}
                  className="px-4 py-2 rounded-xl bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 text-sm transition-all disabled:opacity-50">
                  Otomatik Kur
                </button>
              )}
              {ffmpegProgress && (
                <ProgressBar status={ffmpegProgress.status ?? ''} percent={ffmpegProgress.percent} error={ffmpegProgress.error}
                  doneLabel="ffmpeg kuruldu ✓" />
              )}
            </Section>

            {/* yt-dlp */}
            <Section title="yt-dlp" description={ytDlpVer === undefined ? 'Kontrol ediliyor…' : ytDlpVer ? `Sürüm: ${ytDlpVer}` : 'Bulunamadı'}>
              <button onClick={handleUpdateYtDlp} disabled={ytdlpProgress?.status === 'downloading'}
                className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-sm transition-all disabled:opacity-50">
                {ytdlpProgress?.status === 'downloading' ? 'İndiriliyor…' : 'Güncelle'}
              </button>
              {ytdlpProgress && (
                <ProgressBar status={ytdlpProgress.status ?? ''} percent={ytdlpProgress.percent} error={ytdlpProgress.error}
                  doneLabel={`yt-dlp güncellendi → ${ytdlpProgress.version} ✓`} />
              )}
              {ytDlpVer === null && (
                <p className="text-red-400/80 text-xs mt-2">
                  yt-dlp bulunamadı — "Güncelle" ile otomatik kur
                </p>
              )}
            </Section>

            {/* Özel yt-dlp yolu */}
            <Section title="Özel yt-dlp Yolu" description="Boş = sistem PATH">
              <input type="text" value={settings.ytDlpPath}
                onChange={e => set('ytDlpPath', e.target.value)}
                placeholder="/usr/local/bin/yt-dlp"
                className="w-full px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 focus:border-purple-500/50 text-white/70 text-sm outline-none" />
            </Section>
          </>}
        </div>

        {/* Kaydet */}
        <div className="px-6 py-4 border-t border-white/8 flex items-center justify-between gap-3 shrink-0">
          <p className="min-h-4 text-red-400/80 text-xs">{settingsError}</p>
          <div className="flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-white/6 hover:bg-white/10 text-white/60 text-sm font-medium transition-all">İptal</button>
          <button onClick={save}
            className="px-5 py-2 rounded-xl bg-gradient-button text-white text-sm font-semibold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20 flex items-center gap-2">
            {saved ? <><CheckIcon />Kaydedildi</> : 'Kaydet'}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Alt bileşenler ────────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-white/70 text-sm font-medium">{title}</p>
        {description && <p className="text-white/30 text-xs mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className="w-full flex items-center justify-between cursor-pointer group text-left"
    >
      <span className="text-white/60 text-sm group-hover:text-white/80 transition-colors">{label}</span>
      <span
        style={{ width: 40, height: 22 }}
        className={`relative shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-gradient-button' : 'bg-white/15'}`}
      >
        <span
          className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
          style={{ transform: checked ? 'translateX(18px)' : 'translateX(0)' }}
        />
      </span>
    </button>
  )
}

function ProgressBar({ status, percent, error, doneLabel }: { status: string; percent?: number; error?: string; doneLabel: string }) {
  if (status === 'done')  return <p className="text-green-400 text-xs mt-2">{doneLabel}</p>
  if (status === 'error') return <p className="text-red-400 text-xs mt-2">Hata: {error}</p>
  if (status === 'system-install') return <p className="text-blue-400 text-xs mt-2">Paket yöneticisiyle kuruluyor… Yetki penceresi açılabilir.</p>
  if (status === 'extracting') return <p className="text-blue-400 text-xs mt-2">Çıkartılıyor…</p>
  return (
    <div className="mt-2 space-y-1">
      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-button rounded-full transition-all duration-300"
          style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="text-white/40 text-xs">{percent ?? 0}% indiriliyor…</p>
    </div>
  )
}

function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
}
