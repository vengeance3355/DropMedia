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
    const notes = extractReleaseNotes(status.info)
    return (
      <Banner color="purple" onDismiss={() => setDismissed(true)}>
        <div className="min-w-0">
          <span className="text-white/80 text-xs">
            Yeni sürüm mevcut
            {status.info?.version ? ` (v${status.info.version})` : ''}
          </span>
          {notes && <pre className="mt-1 max-h-24 max-w-3xl overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-white/45">{notes}</pre>}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <button
            onClick={() => window.api.downloadUpdate()}
            className="px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-all"
          >
            Güncelle
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="px-3 py-1 rounded-lg bg-white/8 hover:bg-white/15 text-white/60 text-xs font-medium transition-all"
          >
            Bu Sürümle Devam Et
          </button>
        </div>
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
        <span className="text-white/80 text-xs">Güncelleme indirildi — kurmak için onay bekliyor</span>
        <button
          onClick={() => window.api.installUpdate()}
          className="ml-3 px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-all"
        >
          Kur ve Yeniden Başlat
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

function extractReleaseNotes(info?: Record<string, unknown>): string {
  const notes = info?.releaseNotes
  if (typeof notes === 'string') return cleanReleaseNotes(notes)
  if (Array.isArray(notes)) {
    const combined = notes
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'note' in item) return String((item as { note?: unknown }).note ?? '')
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return cleanReleaseNotes(combined)
  }
  return ''
}

function cleanReleaseNotes(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200)
}

function decodeHtmlEntities(value: string): string {
  const element = document.createElement('textarea')
  element.innerHTML = value
  return element.value
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
