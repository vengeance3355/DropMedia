import { useState, useEffect } from 'react'
import { AppSettings } from '../types'

interface Props { onClose: () => void }

const DEFAULTS: AppSettings = {
  downloadDir: '', theme: 'dark', maxConcurrentDownloads: 3, language: 'tr',
  ytDlpPath: '', autoUpdate: true, showNotifications: true, filenameTemplate: '%(title)s'
}

type Tab = 'genel' | 'indirme' | 'gizlilik' | 'sistem'

export function Settings({ onClose }: Props) {
  const [settings, setSettings]       = useState<AppSettings>(DEFAULTS)
  const [tab, setTab]                 = useState<Tab>('genel')
  const [ytDlpVer, setYtDlpVer]       = useState<string | null>(null)
  const [ffmpegOk, setFfmpegOk]       = useState<boolean | null>(null)
  const [torOk, setTorOk]             = useState<boolean | null>(null)
  const [appVersion, setAppVersion]   = useState('')
  const [saved, setSaved]             = useState(false)

  // Installer progress
  const [ytdlpProgress, setYtdlpProgress] = useState<{ status?: string; percent?: number; version?: string; error?: string } | null>(null)
  const [ffmpegProgress, setFfmpegProgress] = useState<{ status?: string; percent?: number; error?: string } | null>(null)

  // Clipboard shortcut editing
  const [shortcutInput, setShortcutInput] = useState('')
  const [recordingKey, setRecordingKey]   = useState(false)

  useEffect(() => {
    window.api.getSettings().then(s  => setSettings({ ...DEFAULTS, ...(s as Partial<AppSettings>) }))
    window.api.checkYtDlp().then(setYtDlpVer)
    window.api.checkFfmpeg().then(setFfmpegOk)
    window.api.getAppVersion().then(setAppVersion)
    window.api.getDownloadsFolder().then(f => setSettings(p => p.downloadDir ? p : { ...p, downloadDir: f }))
    window.api.getSetting('clipboardShortcut').then(s => setShortcutInput((s as string) ?? 'Ctrl+Shift+V'))

    // Tor kontrolü asenkron
    setTimeout(async () => {
      // Tor durumu için check-tor IPC (basit kontrol)
      const s = await window.api.getSetting('torEnabled')
      setTorOk(!!(s))
    }, 100)

    window.api.onYtDlpProgress(d => setYtdlpProgress(d as typeof ytdlpProgress))
    window.api.onFfmpegProgress(d => setFfmpegProgress(d as typeof ffmpegProgress))
  }, [])

  async function save() {
    for (const [k, v] of Object.entries(settings)) await window.api.setSetting(k, v)
    // Clipboard watch state
    if ((settings as Record<string,unknown>)['clipboardWatch']) await window.api.startClipboardWatch()
    else await window.api.stopClipboardWatch()
    // Shortcut
    await window.api.setClipboardShortcut(shortcutInput)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
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
    const parts: string[] = []
    if (e.ctrlKey)  parts.push('Ctrl')
    if (e.shiftKey) parts.push('Shift')
    if (e.altKey)   parts.push('Alt')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (!['Control','Shift','Alt','Meta'].includes(key)) parts.push(key)
    if (parts.length > 1) { setShortcutInput(parts.join('+')); setRecordingKey(false) }
  }

  function set<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setSettings(s => ({ ...s, [k]: v }))
  }

  const s = settings as Record<string, unknown>

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

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
                  value={(s['speedLimit'] as number) ?? 0}
                  onChange={e => window.api.setSetting('speedLimit', parseInt(e.target.value))}
                  className="flex-1 accent-purple-500" />
                <span className="text-white/60 text-sm w-16 text-right">
                  {(s['speedLimit'] as number) ?? 0 === 0 ? 'Sınırsız' : `${s['speedLimit']} MB/s`}
                </span>
              </div>
            </Section>

            <Section title="Seçenekler">
              <div className="space-y-3">
                <Toggle label="Otomatik güncelleme" checked={settings.autoUpdate} onChange={v => set('autoUpdate', v)} />
                <Toggle label="Bildirim göster" checked={settings.showNotifications} onChange={v => set('showNotifications', v)} />
                <Toggle label="İndirme tamamlanınca ses" checked={!!(s['completionSound'])} onChange={v => window.api.setSetting('completionSound', v)} />
                <Toggle label="Kapatınca tray'e küçült" checked={!!(s['closeToTray'])} onChange={v => window.api.setSetting('closeToTray', v)} />
              </div>
            </Section>
          </>}

          {tab === 'indirme' && <>
            <Section title="Altyazı">
              <div className="space-y-3">
                <Toggle label="Altyazı indir (TR/EN)" checked={!!(s['subtitles'])} onChange={v => window.api.setSetting('subtitles', v)} />
                <Toggle label="Altyazıyı videoya göm (ffmpeg gerekli)" checked={!!(s['embedSubs'])} onChange={v => window.api.setSetting('embedSubs', v)} />
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
                      value={((s['profiles'] as Record<string,string>)?.[site]) ?? 'best'}
                      onChange={e => {
                        const profiles = { ...((s['profiles'] as Record<string,string>) ?? {}), [site]: e.target.value }
                        window.api.setSetting('profiles', profiles)
                      }}
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
              <div className="flex flex-wrap gap-2">
                {['devre dışı','chrome','firefox','brave','edge','chromium'].map(b => (
                  <button key={b} onClick={() => window.api.setSetting('cookieBrowser', b === 'devre dışı' ? '' : b)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize transition-all
                      ${(s['cookieBrowser'] || 'devre dışı') === b ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'}`}>
                    {b}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Tor Proxy" description="İndirmeleri Tor ağı üzerinden yönlendir">
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-2 text-sm ${torOk ? 'text-green-400' : 'text-white/40'}`}>
                  <span className={`w-2 h-2 rounded-full ${torOk ? 'bg-green-400 animate-pulse' : 'bg-white/20'}`} />
                  {torOk === null ? 'Kontrol ediliyor…' : torOk ? 'Tor çalışıyor' : 'Tor çalışmıyor'}
                </div>
                <Toggle label="Tor üzerinden indir" checked={!!(s['torEnabled'])} onChange={v => { window.api.setSetting('torEnabled', v); setTorOk(v) }} />
              </div>
              {!torOk && (
                <p className="text-white/30 text-xs mt-2">
                  Tor Browser'ı açık tutun veya <code className="bg-white/8 px-1 rounded">sudo apt install tor && sudo service tor start</code>
                </p>
              )}
            </Section>

            <Section title="Clipboard İzleme">
              <div className="space-y-3">
                <Toggle label="URL kopyalanınca otomatik algıla" checked={!!(s['clipboardWatch'])} onChange={v => { window.api.setSetting('clipboardWatch', v); v ? window.api.startClipboardWatch() : window.api.stopClipboardWatch() }} />
                <div className="flex items-center gap-2">
                  <span className="text-white/60 text-sm">Kısayol:</span>
                  <div
                    onClick={() => setRecordingKey(true)}
                    onKeyDown={recordingKey ? handleKeyCapture : undefined}
                    tabIndex={0}
                    className={`flex-1 px-3 py-2 rounded-xl text-sm cursor-pointer outline-none transition-all
                      ${recordingKey ? 'bg-purple-500/20 border border-purple-500/50 text-purple-300' : 'bg-white/8 border border-white/10 text-white/60'}`}>
                    {recordingKey ? 'Tuş kombinasyonuna basın…' : (shortcutInput || 'Kısayol seç')}
                  </div>
                  {shortcutInput && <button onClick={() => { setShortcutInput(''); window.api.setClipboardShortcut('') }}
                    className="text-white/30 hover:text-white/60 text-xs">Sil</button>}
                </div>
              </div>
            </Section>
          </>}

          {tab === 'sistem' && <>
            {/* ffmpeg */}
            <Section title="ffmpeg" description={ffmpegOk ? 'Kurulu — yüksek kalite aktif' : 'Kurulu değil — bazı formatlar kısıtlı'}>
              <div className="flex items-center gap-3 mb-2">
                <span className={`w-2 h-2 rounded-full ${ffmpegOk ? 'bg-green-400' : 'bg-amber-400'}`} />
                <span className={`text-sm ${ffmpegOk ? 'text-green-400' : 'text-amber-400'}`}>
                  {ffmpegOk ? 'ffmpeg kurulu' : 'ffmpeg kurulu değil'}
                </span>
              </div>
              {!ffmpegOk && (
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
            <Section title="yt-dlp" description={ytDlpVer ? `Sürüm: ${ytDlpVer}` : 'Bulunamadı'}>
              <button onClick={handleUpdateYtDlp} disabled={ytdlpProgress?.status === 'downloading'}
                className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-sm transition-all disabled:opacity-50">
                {ytdlpProgress?.status === 'downloading' ? 'İndiriliyor…' : 'Güncelle'}
              </button>
              {ytdlpProgress && (
                <ProgressBar status={ytdlpProgress.status ?? ''} percent={ytdlpProgress.percent} error={ytdlpProgress.error}
                  doneLabel={`yt-dlp güncellendi → ${ytdlpProgress.version} ✓`} />
              )}
              {!ytDlpVer && (
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
        <div className="px-6 py-4 border-t border-white/8 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-white/6 hover:bg-white/10 text-white/60 text-sm font-medium transition-all">İptal</button>
          <button onClick={save}
            className="px-5 py-2 rounded-xl bg-gradient-button text-white text-sm font-semibold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20 flex items-center gap-2">
            {saved ? <><CheckIcon />Kaydedildi</> : 'Kaydet'}
          </button>
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
    <label className="flex items-center justify-between cursor-pointer group">
      <span className="text-white/60 text-sm group-hover:text-white/80 transition-colors">{label}</span>
      <div onClick={() => onChange(!checked)} style={{ width: 40, height: 22 }}
        className={`relative rounded-full cursor-pointer transition-all duration-200 ${checked ? 'bg-gradient-button' : 'bg-white/15'}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${checked ? 'left-5' : 'left-0.5'}`} />
      </div>
    </label>
  )
}

function ProgressBar({ status, percent, error, doneLabel }: { status: string; percent?: number; error?: string; doneLabel: string }) {
  if (status === 'done')  return <p className="text-green-400 text-xs mt-2">{doneLabel}</p>
  if (status === 'error') return <p className="text-red-400 text-xs mt-2">Hata: {error}</p>
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
