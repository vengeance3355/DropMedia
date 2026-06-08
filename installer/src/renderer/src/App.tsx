import { useState, useEffect, useRef } from 'react'

type Screen = 'loading' | 'welcome' | 'installing' | 'done'
type Mode   = 'install' | 'update'

interface InstallerInfo {
  mode: Mode
  installedVersion: string | null
  bundledVersion:   string
  installDir:       string
  autoStart:        boolean
}

// ── Logolar & ikonlar ─────────────────────────────────────────────────────────

function DropMediaLogo() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <div className="w-16 h-16 rounded-2xl bg-gradient-button flex items-center justify-center shadow-lg shadow-purple-900/40">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <div className="absolute -inset-1 rounded-2xl bg-gradient-button opacity-20 blur-lg -z-10" />
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white tracking-tight">DropMedia</h1>
        <p className="text-white/40 text-xs mt-0.5">Multi-platform video indirici</p>
      </div>
    </div>
  )
}

function CheckIcon() {
  return (
    <div className="relative">
      <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div className="absolute -inset-2 rounded-full bg-green-500/10 blur-lg -z-10" />
    </div>
  )
}

function ErrorIcon() {
  return (
    <div className="w-16 h-16 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </div>
  )
}

function Spinner() {
  return (
    <div className="w-5 h-5 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-white/8 overflow-hidden">
      <div
        className="h-full bg-gradient-progress rounded-full transition-all duration-300 ease-out"
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  )
}

// ── Ekranlar ─────────────────────────────────────────────────────────────────

function WelcomeScreen({
  info,
  installDir,
  onDirChange,
  onBrowse,
  onStart
}: {
  info: InstallerInfo
  installDir: string
  onDirChange: (d: string) => void
  onBrowse: () => void
  onStart: () => void
}) {
  const isUpdate = info.mode === 'update'

  return (
    <div className="flex flex-col items-center gap-6 animate-slide-up w-full">
      <DropMediaLogo />

      <div className="text-center">
        {isUpdate ? (
          <>
            <p className="text-white/70 text-sm">
              Güncelleme mevcut
            </p>
            <p className="text-white/40 text-xs mt-1">
              {info.installedVersion} → <span className="text-purple-400">{info.bundledVersion}</span>
            </p>
          </>
        ) : (
          <p className="text-white/60 text-sm">
            v{info.bundledVersion} kuruluma hazır
          </p>
        )}
      </div>

      {/* Kurulum dizini — sadece fresh install'da göster */}
      {!isUpdate && (
        <div className="w-full">
          <label className="text-white/40 text-xs mb-1.5 block">Kurulum dizini</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={installDir}
              onChange={e => onDirChange(e.target.value)}
              className="flex-1 bg-white/6 border border-white/8 rounded-lg px-3 py-2 text-white/80 text-xs outline-none focus:border-purple-500/50 focus:bg-white/8 transition-all"
            />
            <button
              onClick={onBrowse}
              className="px-3 py-2 rounded-lg bg-white/8 hover:bg-white/12 border border-white/8 text-white/60 text-xs transition-all no-drag"
            >
              Seç
            </button>
          </div>
        </div>
      )}

      {/* Bilgi kutusu */}
      <div className="w-full rounded-xl bg-white/3 border border-white/6 p-4 space-y-1.5">
        {isUpdate ? (
          <>
            <InfoRow label="Mevcut sürüm"   value={info.installedVersion || '—'} />
            <InfoRow label="Yeni sürüm"     value={info.bundledVersion} accent />
            <InfoRow label="Konum"          value={shortPath(info.installDir)} />
          </>
        ) : (
          <>
            <InfoRow label="Sürüm"          value={info.bundledVersion} accent />
            <InfoRow label="Kurulum yeri"   value={shortPath(installDir)} />
            <InfoRow label="Kısayol"        value="Masaüstü + Başlat Menüsü" />
          </>
        )}
      </div>

      <button
        onClick={onStart}
        className="w-full py-2.5 rounded-xl bg-gradient-button text-white text-sm font-semibold shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all no-drag"
      >
        {isUpdate ? 'Güncelle' : 'Kur'}
      </button>
    </div>
  )
}

function InfoRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/30 text-xs">{label}</span>
      <span className={`text-xs font-medium ${accent ? 'text-purple-400' : 'text-white/60'}`}>{value}</span>
    </div>
  )
}

function InstallingScreen({
  mode,
  pct,
  status
}: {
  mode: Mode
  pct: number
  status: string
}) {
  return (
    <div className="flex flex-col items-center gap-6 animate-fade-in w-full">
      {/* Animasyonlu logo */}
      <div className="relative">
        <div className="w-16 h-16 rounded-2xl bg-gradient-button flex items-center justify-center shadow-lg shadow-purple-900/40">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        {/* Dönen ring */}
        <div className="absolute -inset-2">
          <svg className="w-full h-full animate-spin-slow" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="none" stroke="url(#ring-grad)" strokeWidth="2" strokeDasharray="60 165" strokeLinecap="round" />
            <defs>
              <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#7c3aed" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-white text-base font-semibold">
          {mode === 'update' ? 'Güncelleniyor...' : 'Kuruluyor...'}
        </h2>
        <p className="text-white/40 text-xs mt-1">{status || 'Lütfen bekleyin'}</p>
      </div>

      <div className="w-full space-y-2">
        <ProgressBar pct={pct} />
        <div className="flex justify-between">
          <span className="text-white/30 text-xs">İlerleme</span>
          <span className="text-white/50 text-xs font-medium">{pct}%</span>
        </div>
      </div>

      <p className="text-white/25 text-xs text-center">
        Bu pencereyi kapatmayın
      </p>
    </div>
  )
}

function DoneScreen({
  success,
  error,
  mode,
  onLaunch,
  onClose
}: {
  success: boolean
  error: string
  mode: Mode
  onLaunch: () => void
  onClose: () => void
}) {
  const [launching, setLaunching] = useState(false)

  const handleLaunch = () => {
    setLaunching(true)
    onLaunch()
  }

  return (
    <div className="flex flex-col items-center gap-6 animate-slide-up w-full">
      {success ? <CheckIcon /> : <ErrorIcon />}

      <div className="text-center">
        <h2 className="text-white text-base font-semibold">
          {success
            ? (mode === 'update' ? 'Güncelleme tamamlandı!' : 'Kurulum tamamlandı!')
            : 'Bir hata oluştu'}
        </h2>
        {!success && error && (
          <p className="text-red-400/80 text-xs mt-2 max-w-xs text-center leading-relaxed">{error}</p>
        )}
        {success && mode === 'update' && (
          <p className="text-white/40 text-xs mt-1">DropMedia yeniden başlatılıyor...</p>
        )}
      </div>

      <div className="flex gap-3 w-full">
        {success && mode === 'install' && (
          <button
            onClick={handleLaunch}
            disabled={launching}
            className="flex-1 py-2.5 rounded-xl bg-gradient-button text-white text-sm font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 no-drag flex items-center justify-center gap-2"
          >
            {launching ? <Spinner /> : null}
            {launching ? 'Başlatılıyor...' : 'DropMedia\'yı Başlat'}
          </button>
        )}
        <button
          onClick={onClose}
          className={`py-2.5 rounded-xl border border-white/8 text-white/60 text-sm hover:bg-white/8 transition-all no-drag ${success && mode === 'install' ? 'px-5' : 'flex-1'}`}
        >
          Kapat
        </button>
      </div>
    </div>
  )
}

// ── Ana bileşen ───────────────────────────────────────────────────────────────

export default function App() {
  const [screen,     setScreen]     = useState<Screen>('loading')
  const [info,       setInfo]       = useState<InstallerInfo | null>(null)
  const [installDir, setInstallDir] = useState('')
  const [pct,        setPct]        = useState(0)
  const [status,     setStatus]     = useState('')
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState('')
  const startedRef = useRef(false)

  useEffect(() => {
    window.api.getInfo().then((i: InstallerInfo) => {
      setInfo(i)
      setInstallDir(i.installDir)

      // --update flag ile çağrıldıysa otomatik başlat
      if (i.autoStart) {
        setScreen('installing')
        if (!startedRef.current) {
          startedRef.current = true
          window.api.start()
        }
      } else {
        setScreen('welcome')
      }
    })

    window.api.onProgress((d: { pct: number; status: string }) => {
      setPct(d.pct)
      setStatus(d.status)
    })

    window.api.onDone((d: { success: boolean; error?: string }) => {
      setSuccess(d.success)
      setError(d.error || '')

      if (d.success && info?.autoStart) {
        // Güncelleme modu — otomatik başlat ve çık
        setTimeout(() => window.api.launchAndQuit(), 800)
      } else {
        setScreen('done')
      }
    })
  }, [])

  // Done ekranına geçince otomatik launch (update mode)
  useEffect(() => {
    if (screen === 'done' && success && info?.mode === 'update') {
      setTimeout(() => window.api.launchAndQuit(), 1000)
    }
  }, [screen, success])

  const handleStart = () => {
    setScreen('installing')
    if (!startedRef.current) {
      startedRef.current = true
      window.api.start(installDir)
    }
  }

  const handleBrowse = async () => {
    const dir = await window.api.selectDir()
    if (dir) setInstallDir(dir)
  }

  return (
    <div
      className="h-full flex flex-col text-white"
      style={{ background: 'var(--bg-gradient)' }}
    >
      {/* Arka plan blob'ları */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-20 -left-20 w-64 h-64 rounded-full" style={{ background: 'rgba(124,58,237,0.15)', filter: 'blur(60px)' }} />
        <div className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full" style={{ background: 'rgba(59,130,246,0.12)', filter: 'blur(60px)' }} />
      </div>

      {/* Title bar */}
      <div className="relative z-10 flex items-center justify-between px-5 py-3 app-drag">
        <span className="text-white/30 text-xs">DropMedia Installer</span>
        {screen !== 'installing' && (
          <button
            onClick={() => window.api.quit()}
            className="no-drag text-white/25 hover:text-white/60 transition-colors p-1 rounded"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>

      {/* İçerik */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-10 pb-8">
        {screen === 'loading' && (
          <Spinner />
        )}

        {screen === 'welcome' && info && (
          <WelcomeScreen
            info={info}
            installDir={installDir}
            onDirChange={setInstallDir}
            onBrowse={handleBrowse}
            onStart={handleStart}
          />
        )}

        {screen === 'installing' && info && (
          <InstallingScreen mode={info.mode} pct={pct} status={status} />
        )}

        {screen === 'done' && info && (
          <DoneScreen
            success={success}
            error={error}
            mode={info.mode}
            onLaunch={() => window.api.launchAndQuit()}
            onClose={() => window.api.quit()}
          />
        )}
      </div>

      {/* Footer */}
      <div className="relative z-10 pb-4 text-center">
        <span className="text-white/15 text-xs">DropMedia {info?.bundledVersion ?? ''}</span>
      </div>
    </div>
  )
}

// ── Yardımcı ─────────────────────────────────────────────────────────────────

function shortPath(p: string): string {
  if (p.length <= 40) return p
  const parts = p.split(/[\\/]/)
  if (parts.length <= 3) return p
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
}

// Global tip tanımı
declare global {
  interface Window {
    api: {
      getInfo:       () => Promise<InstallerInfo>
      selectDir:     () => Promise<string | null>
      start:         (targetDir?: string) => Promise<void>
      launchAndQuit: () => Promise<void>
      quit:          () => void
      onProgress:    (cb: (d: { pct: number; status: string }) => void) => void
      onDone:        (cb: (d: { success: boolean; error?: string }) => void) => void
    }
  }
}
