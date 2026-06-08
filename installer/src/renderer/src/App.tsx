import { useState, useEffect, useRef } from 'react'

type Mode   = 'install' | 'update' | 'uptodate'
type Screen = 'loading' | 'welcome' | 'confirm-uninstall' | 'working' | 'done'
type Action = 'install' | 'update' | 'uninstall' | 'repair'

interface InstallerInfo {
  mode:             Mode
  installedVersion: string | null
  latestVersion:    string | null
  installDir:       string
  notes:            string
}

// ── Simgeler ──────────────────────────────────────────────────────────────────

function Logo({ spinning = false }: { spinning?: boolean }) {
  return (
    <div className="relative">
      <div className="w-16 h-16 rounded-2xl bg-gradient-button flex items-center justify-center shadow-lg shadow-purple-900/40">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
      {spinning && (
        <div className="absolute -inset-2 pointer-events-none">
          <svg className="w-full h-full animate-spin-slow" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="none" stroke="url(#rg)" strokeWidth="2.5" strokeDasharray="60 165" strokeLinecap="round"/>
            <defs>
              <linearGradient id="rg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#7c3aed"/>
                <stop offset="100%" stopColor="#3b82f6"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
      )}
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
      <div className="absolute -inset-2 rounded-full bg-green-500/10 blur-lg -z-10"/>
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

function Spinner({ size = 5 }: { size?: number }) {
  return <div className={`w-${size} h-${size} rounded-full border-2 border-white/20 border-t-white/80 animate-spin`}/>
}

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

function WelcomeScreen({ info, installDir, onDirChange, onBrowse, onInstall, onUninstall, onRepair }: {
  info:         InstallerInfo
  installDir:   string
  onDirChange:  (d: string) => void
  onBrowse:     () => void
  onInstall:    () => void
  onUninstall:  () => void
  onRepair:     () => void
}) {
  const isInstall  = info.mode === 'install'
  const isUpdate   = info.mode === 'update'
  const isUpToDate = info.mode === 'uptodate'

  return (
    <div className="flex flex-col items-center gap-5 animate-slide-up w-full">
      <Logo/>

      <div className="text-center">
        <h1 className="text-xl font-bold text-white tracking-tight">DropMedia</h1>
        {isInstall  && <p className="text-white/50 text-xs mt-1">v{info.latestVersion} kuruluma hazır</p>}
        {isUpdate   && <p className="text-white/50 text-xs mt-1">
          Güncelleme mevcut: <span className="text-white/30 line-through">{info.installedVersion}</span>{' '}
          → <span className="text-purple-400">{info.latestVersion}</span>
        </p>}
        {isUpToDate && <p className="text-green-400/70 text-xs mt-1">✓ Güncel — v{info.installedVersion}</p>}
      </div>

      {/* Güncelleme notları */}
      {(isUpdate || isInstall) && info.notes && (
        <div className="w-full rounded-xl bg-white/3 border border-white/6 px-4 py-3">
          <p className="text-white/30 text-[11px] mb-1 font-medium uppercase tracking-wider">Yenilikler</p>
          <pre className="text-white/60 text-xs whitespace-pre-wrap leading-relaxed">{info.notes}</pre>
        </div>
      )}

      {/* Kurulum dizini — sadece install modunda */}
      {isInstall && (
        <div className="w-full">
          <label className="text-white/40 text-xs mb-1.5 block">Kurulum dizini</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={installDir}
              onChange={e => onDirChange(e.target.value)}
              className="flex-1 bg-white/6 border border-white/8 rounded-lg px-3 py-2 text-white/80 text-xs outline-none focus:border-purple-500/50 transition-all no-drag"
            />
            <button onClick={onBrowse} className="px-3 py-2 rounded-lg bg-white/8 hover:bg-white/12 border border-white/8 text-white/60 text-xs transition-all no-drag">
              Seç
            </button>
          </div>
        </div>
      )}

      {/* Ana buton */}
      {(isInstall || isUpdate) && (
        <button
          onClick={onInstall}
          className="w-full py-2.5 rounded-xl bg-gradient-button text-white text-sm font-semibold shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all no-drag"
        >
          {isInstall ? 'Kur' : 'Güncelle'}
        </button>
      )}

      {/* Onar + Kaldır */}
      {(info.installedVersion || isUpToDate) && (
        <div className="flex gap-2 w-full">
          <button
            onClick={onRepair}
            className="flex-1 py-2 rounded-xl bg-white/6 hover:bg-white/10 border border-white/8 text-white/60 text-xs font-medium transition-all no-drag"
          >
            Onar
          </button>
          <button
            onClick={onUninstall}
            className="flex-1 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/15 text-red-400/80 text-xs font-medium transition-all no-drag"
          >
            Kaldır
          </button>
        </div>
      )}
    </div>
  )
}

function ConfirmUninstall({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6 animate-slide-up w-full text-center">
      <div className="w-16 h-16 rounded-full bg-red-500/15 border border-red-500/25 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </div>
      <div>
        <h2 className="text-white text-base font-semibold">DropMedia kaldırılsın mı?</h2>
        <p className="text-white/40 text-xs mt-1">Tüm dosyalar, kısayollar ve kayıt defteri girdileri silinecek.</p>
      </div>
      <div className="flex gap-3 w-full">
        <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-white/8 text-white/60 text-sm hover:bg-white/8 transition-all no-drag">
          İptal
        </button>
        <button onClick={onConfirm} className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition-all no-drag">
          Kaldır
        </button>
      </div>
    </div>
  )
}

function WorkingScreen({ action, pct, status }: { action: Action; pct: number; status: string }) {
  const labels: Record<Action, string> = {
    install:   'Kuruluyor...',
    update:    'Güncelleniyor...',
    uninstall: 'Kaldırılıyor...',
    repair:    'Onarılıyor...'
  }
  return (
    <div className="flex flex-col items-center gap-6 animate-fade-in w-full">
      <Logo spinning/>
      <div className="text-center">
        <h2 className="text-white text-base font-semibold">{labels[action]}</h2>
        <p className="text-white/40 text-xs mt-1">{status || 'Lütfen bekleyin'}</p>
      </div>
      <div className="w-full space-y-2">
        <ProgressBar pct={pct}/>
        <div className="flex justify-between">
          <span className="text-white/30 text-xs">İlerleme</span>
          <span className="text-white/50 text-xs font-medium">{pct}%</span>
        </div>
      </div>
      <p className="text-white/20 text-xs">Bu pencereyi kapatmayın</p>
    </div>
  )
}

function DoneScreen({ success, action, error, onLaunch, onClose }: {
  success:  boolean
  action:   Action
  error:    string
  onLaunch: () => void
  onClose:  () => void
}) {
  const [launching, setLaunching] = useState(false)

  const successMsgs: Record<Action, string> = {
    install:   'Kurulum tamamlandı!',
    update:    'Güncelleme tamamlandı!',
    uninstall: 'Kaldırma tamamlandı.',
    repair:    'Onarma tamamlandı!'
  }

  return (
    <div className="flex flex-col items-center gap-6 animate-slide-up w-full">
      {success ? <CheckIcon/> : <ErrorIcon/>}
      <div className="text-center">
        <h2 className="text-white text-base font-semibold">
          {success ? successMsgs[action] : 'Bir hata oluştu'}
        </h2>
        {!success && error && (
          <p className="text-red-400/80 text-xs mt-2 max-w-xs text-center leading-relaxed">{error}</p>
        )}
      </div>
      <div className="flex gap-3 w-full">
        {success && action !== 'uninstall' && (
          <button
            onClick={() => { setLaunching(true); onLaunch() }}
            disabled={launching}
            className="flex-1 py-2.5 rounded-xl bg-gradient-button text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all no-drag flex items-center justify-center gap-2"
          >
            {launching ? <Spinner size={4}/> : null}
            {launching ? 'Başlatılıyor...' : "DropMedia'yı Başlat"}
          </button>
        )}
        <button
          onClick={onClose}
          className={`py-2.5 rounded-xl border border-white/8 text-white/60 text-sm hover:bg-white/8 transition-all no-drag ${success && action !== 'uninstall' ? 'px-5' : 'flex-1'}`}
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
  const [action,     setAction]     = useState<Action>('install')
  const [pct,        setPct]        = useState(0)
  const [status,     setStatus]     = useState('')
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState('')
  const working = useRef(false)

  useEffect(() => {
    window.api.getInfo().then((i: InstallerInfo) => {
      setInfo(i)
      setInstallDir(i.installDir)
      setScreen('welcome')

      if (i.mode === 'update' && (window as any).__AUTO_UPDATE) {
        triggerAction('update')
      }
    })
    window.api.onProgress((d) => { setPct(d.pct); setStatus(d.status) })
    window.api.onDone((d) => {
      setSuccess(d.success)
      setError(d.error || '')
      setScreen('done')
      working.current = false
    })
  }, [])

  function triggerAction(act: Action, dir?: string) {
    if (working.current) return
    working.current = true
    setAction(act)
    setPct(0)
    setStatus('')
    setScreen('working')

    if      (act === 'install' || act === 'update') window.api.start(dir || installDir)
    else if (act === 'repair')    window.api.repair()
    else if (act === 'uninstall') window.api.uninstall()
  }

  return (
    <div className="h-full flex flex-col text-white" style={{ background: 'var(--bg-gradient)' }}>
      {/* Blob'lar */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-20 -left-20 w-64 h-64 rounded-full" style={{ background: 'rgba(124,58,237,0.15)', filter: 'blur(60px)' }}/>
        <div className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full" style={{ background: 'rgba(59,130,246,0.12)', filter: 'blur(60px)' }}/>
      </div>

      {/* Title bar */}
      <div className="relative z-10 flex items-center justify-between px-5 py-3 app-drag">
        <span className="text-white/25 text-xs">DropMedia Installer</span>
        {screen !== 'working' && (
          <button onClick={() => window.api.quit()} className="no-drag text-white/20 hover:text-white/60 transition-colors p-1 rounded">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>

      {/* İçerik */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-10 pb-6">
        {screen === 'loading' && <Spinner size={6}/>}

        {screen === 'welcome' && info && (
          <WelcomeScreen
            info={info}
            installDir={installDir}
            onDirChange={setInstallDir}
            onBrowse={async () => { const d = await window.api.selectDir(); if (d) setInstallDir(d) }}
            onInstall={() => triggerAction(info.mode === 'update' ? 'update' : 'install', installDir)}
            onUninstall={() => setScreen('confirm-uninstall')}
            onRepair={() => triggerAction('repair')}
          />
        )}

        {screen === 'confirm-uninstall' && (
          <ConfirmUninstall
            onConfirm={() => triggerAction('uninstall')}
            onCancel={() => setScreen('welcome')}
          />
        )}

        {screen === 'working' && (
          <WorkingScreen action={action} pct={pct} status={status}/>
        )}

        {screen === 'done' && (
          <DoneScreen
            success={success}
            action={action}
            error={error}
            onLaunch={() => window.api.launchAndQuit()}
            onClose={() => {
              if (action === 'uninstall' || !success) window.api.quit()
              else setScreen('welcome')
            }}
          />
        )}
      </div>

      {/* Footer */}
      {info && (
        <div className="relative z-10 pb-3 text-center">
          <span className="text-white/15 text-xs">
            {info.latestVersion ? `v${info.latestVersion}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

// Global types
declare global {
  interface Window {
    api: {
      getInfo:       () => Promise<InstallerInfo>
      selectDir:     () => Promise<string | null>
      start:         (dir?: string) => Promise<void>
      uninstall:     () => Promise<void>
      repair:        () => Promise<void>
      launchAndQuit: () => Promise<void>
      quit:          () => void
      onProgress: (cb: (d: { pct: number; status: string }) => void) => void
      onDone:     (cb: (d: { success: boolean; action: string; error?: string }) => void) => void
    }
  }
}
