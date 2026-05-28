import { useState, useEffect } from 'react'
import { UpdateStatus } from '../types'

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.api.onUpdateStatus((data) => {
      setStatus(data as UpdateStatus)
      setDismissed(false)
    })
  }, [])

  if (!status || dismissed) return null
  if (status.type === 'not-available' || status.type === 'checking') return null

  if (status.type === 'available') {
    return (
      <Banner color="purple" onDismiss={() => setDismissed(true)}>
        <span className="text-white/80 text-xs">
          Yeni sürüm mevcut
          {status.info?.version ? ` (v${status.info.version})` : ''}
        </span>
        <button
          onClick={() => window.api.downloadUpdate()}
          className="ml-3 px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-all"
        >
          İndir
        </button>
      </Banner>
    )
  }

  if (status.type === 'downloading') {
    const pct = Math.round(status.progress?.percent ?? 0)
    return (
      <Banner color="blue">
        <span className="text-white/80 text-xs">Güncelleme indiriliyor…</span>
        <div className="ml-3 flex items-center gap-2">
          <div className="w-24 h-1 rounded-full bg-white/20 overflow-hidden">
            <div
              className="h-full bg-white/70 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-white/50 text-xs">{pct}%</span>
        </div>
      </Banner>
    )
  }

  if (status.type === 'downloaded') {
    return (
      <Banner color="green" onDismiss={() => setDismissed(true)}>
        <span className="text-white/80 text-xs">Güncelleme hazır — yeniden başlatılacak</span>
        <button
          onClick={() => window.api.installUpdate()}
          className="ml-3 px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-all"
        >
          Şimdi Kur
        </button>
      </Banner>
    )
  }

  if (status.type === 'error') {
    return (
      <Banner color="red" onDismiss={() => setDismissed(true)}>
        <span className="text-white/70 text-xs">Güncelleme hatası: {status.error}</span>
      </Banner>
    )
  }

  return null
}

function Banner({
  color,
  children,
  onDismiss
}: {
  color: 'purple' | 'blue' | 'green' | 'red'
  children: React.ReactNode
  onDismiss?: () => void
}) {
  const bg = {
    purple: 'bg-purple-500/15 border-purple-500/25',
    blue:   'bg-blue-500/15 border-blue-500/25',
    green:  'bg-green-500/15 border-green-500/25',
    red:    'bg-red-500/15 border-red-500/25'
  }[color]

  return (
    <div className={`flex items-center justify-between px-4 py-2 border-b ${bg} animate-fade-in`}>
      <div className="flex items-center">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-white/30 hover:text-white/60 transition-colors ml-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      )}
    </div>
  )
}
