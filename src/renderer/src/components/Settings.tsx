import { useState, useEffect } from 'react'
import { AppSettings } from '../types'

interface Props {
  onClose: () => void
}

const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: '',
  theme: 'dark',
  maxConcurrentDownloads: 3,
  language: 'tr',
  ytDlpPath: '',
  autoUpdate: true,
  showNotifications: true,
  filenameTemplate: '%(title)s'
}

export function Settings({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [ytDlpVersion, setYtDlpVersion] = useState<string | null>(null)
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [ytDlpUpdating, setYtDlpUpdating] = useState(false)
  const [ytDlpUpdateMsg, setYtDlpUpdateMsg] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings({ ...DEFAULT_SETTINGS, ...(s as Partial<AppSettings>) })
    })
    window.api.checkYtDlp().then(setYtDlpVersion)
    window.api.checkFfmpeg().then(setFfmpegAvailable)
    window.api.getAppVersion().then(setAppVersion)

    window.api.getDownloadsFolder().then((folder) => {
      setSettings((prev) => (prev.downloadDir ? prev : { ...prev, downloadDir: folder }))
    })
  }, [])

  async function handleSave() {
    for (const [k, v] of Object.entries(settings)) {
      await window.api.setSetting(k, v)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleSelectDir() {
    const folder = await window.api.selectFolder()
    if (folder) setSettings((s) => ({ ...s, downloadDir: folder }))
  }

  async function handleUpdateYtDlp() {
    setYtDlpUpdating(true)
    setYtDlpUpdateMsg('İndiriliyor…')
    const result = await window.api.updateYtDlp() as { success: boolean; version?: string; error?: string }
    if (result.success) {
      setYtDlpUpdateMsg(`Güncellendi → ${result.version} ✓`)
      window.api.checkYtDlp().then(setYtDlpVersion)
    } else {
      setYtDlpUpdateMsg(`Hata: ${result.error ?? 'bilinmiyor'}`)
    }
    setYtDlpUpdating(false)
  }

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg rounded-3xl bg-[#100c20] border border-white/10 shadow-2xl shadow-black/50 overflow-hidden animate-slide-up">
        {/* Başlık */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
          <div>
            <h2 className="text-white font-semibold text-base">Ayarlar</h2>
            <p className="text-white/30 text-xs mt-0.5">DropMedia v{appVersion}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* İçerik */}
        <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto scrollbar-thin">

          {/* İndirme Klasörü */}
          <Section title="İndirme Klasörü">
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 text-white/60 text-sm truncate">
                {settings.downloadDir || 'Klasör seçilmedi'}
              </div>
              <button
                onClick={handleSelectDir}
                className="px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-sm font-medium transition-all whitespace-nowrap"
              >
                Seç
              </button>
            </div>
          </Section>

          {/* Tema */}
          <Section title="Tema">
            <div className="flex gap-2">
              {(['dark', 'light'] as const).map((t) => (
                <ThemeBtn
                  key={t}
                  active={settings.theme === t}
                  onClick={() => set('theme', t)}
                  label={t === 'dark' ? '🌙 Koyu' : '☀️ Açık'}
                />
              ))}
            </div>
          </Section>

          {/* Eş zamanlı indirme */}
          <Section title="Eş Zamanlı İndirme" description="Aynı anda kaç video indirilsin">
            <div className="flex gap-2">
              {[1, 2, 3, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => set('maxConcurrentDownloads', n)}
                  className={`w-12 h-10 rounded-xl text-sm font-semibold transition-all
                    ${settings.maxConcurrentDownloads === n
                      ? 'bg-gradient-button text-white shadow-sm shadow-purple-500/30'
                      : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'
                    }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </Section>

          {/* Bildirimler */}
          <Section title="Seçenekler">
            <div className="space-y-3">
              <Toggle
                label="Otomatik güncelleme kontrolü"
                checked={settings.autoUpdate}
                onChange={(v) => set('autoUpdate', v)}
              />
              <Toggle
                label="Tamamlanınca bildirim göster"
                checked={settings.showNotifications}
                onChange={(v) => set('showNotifications', v)}
              />
            </div>
          </Section>

          {/* ffmpeg durumu */}
          <Section title="ffmpeg">
            <div className={`flex items-center gap-2 text-sm ${ffmpegAvailable ? 'text-green-400' : 'text-amber-400'}`}>
              <span className={`w-2 h-2 rounded-full ${ffmpegAvailable ? 'bg-green-400' : 'bg-amber-400'}`} />
              {ffmpegAvailable === null ? 'Kontrol ediliyor…'
                : ffmpegAvailable ? 'Kurulu — yüksek kalite birleştirme aktif'
                : 'Kurulu değil — bazı formatlar kısıtlı'}
            </div>
            {ffmpegAvailable === false && (
              <p className="text-white/30 text-xs mt-1">
                1080p/4K ve ses çıkarma için gerekli:{' '}
                <code className="bg-white/8 px-1.5 py-0.5 rounded text-white/50">sudo apt install ffmpeg</code>
              </p>
            )}
          </Section>

          {/* yt-dlp */}
          <Section title="yt-dlp" description={ytDlpVersion ? `Sürüm: ${ytDlpVersion}` : 'Bulunamadı'}>
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={handleUpdateYtDlp}
                  disabled={ytDlpUpdating || !ytDlpVersion}
                  className="px-3 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-sm transition-all disabled:opacity-40 flex items-center gap-2"
                >
                  {ytDlpUpdating ? (
                    <><Spinner /> Güncelleniyor…</>
                  ) : 'yt-dlp Güncelle'}
                </button>
                {!ytDlpVersion && (
                  <p className="text-red-400/80 text-xs self-center">
                    yt-dlp bulunamadı — terminalde <code className="bg-white/10 px-1 rounded">pip install yt-dlp</code> çalıştırın
                  </p>
                )}
              </div>
              {ytDlpUpdateMsg && (
                <p className="text-white/50 text-xs">{ytDlpUpdateMsg}</p>
              )}
            </div>
          </Section>

          {/* Özel yt-dlp yolu */}
          <Section title="Özel yt-dlp Yolu" description="Boş bırakırsanız sistem PATH kullanılır">
            <input
              type="text"
              value={settings.ytDlpPath}
              onChange={(e) => set('ytDlpPath', e.target.value)}
              placeholder="/usr/local/bin/yt-dlp"
              className="w-full px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 focus:border-purple-500/50 text-white/70 text-sm outline-none transition-all placeholder-white/20"
            />
          </Section>
        </div>

        {/* Kaydet */}
        <div className="px-6 py-4 border-t border-white/8 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/6 hover:bg-white/10 text-white/60 text-sm font-medium transition-all"
          >
            İptal
          </button>
          <button
            onClick={handleSave}
            className="px-5 py-2 rounded-xl bg-gradient-button text-white text-sm font-semibold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20 flex items-center gap-2"
          >
            {saved ? (
              <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>Kaydedildi</>
            ) : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}) {
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

function ThemeBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all
        ${active
          ? 'bg-gradient-button text-white shadow-sm shadow-purple-500/30'
          : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'
        }`}
    >
      {label}
    </button>
  )
}

function Toggle({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer group">
      <span className="text-white/60 text-sm group-hover:text-white/80 transition-colors">{label}</span>
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5.5 rounded-full transition-all duration-200 cursor-pointer
          ${checked ? 'bg-gradient-button' : 'bg-white/15'}`}
        style={{ height: '22px', width: '40px' }}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200
            ${checked ? 'left-5' : 'left-0.5'}`}
        />
      </div>
    </label>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  )
}
