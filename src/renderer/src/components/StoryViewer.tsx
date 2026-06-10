import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoryReel, StoryItem } from '../types'

const IMAGE_DURATION_MS = 5000

interface Props {
  reel: StoryReel
  requestedIds: Set<string>
  onDownloadItem: (item: StoryItem) => void
  onDownloadMany: (items: StoryItem[]) => void
  onClose: () => void
}

export function StoryViewer({ reel, requestedIds, onDownloadItem, onDownloadMany, onClose }: Props) {
  const items = reel.items
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mediaError, setMediaError] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number>(0)
  const elapsedRef = useRef<number>(0)

  const current = items[index]
  const atLast = index >= items.length - 1

  const goTo = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(items.length - 1, next)))
    setProgress(0)
    setMediaError(false)
    elapsedRef.current = 0
  }, [items.length])

  const next = useCallback(() => {
    if (atLast) { setPaused(true); setProgress(1); return }
    goTo(index + 1)
  }, [atLast, goTo, index])

  const prev = useCallback(() => goTo(index - 1), [goTo, index])

  // ── Klavye ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === ' ') { e.preventDefault(); setPaused(p => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, onClose])

  // ── Fotoğraf zamanlayıcı (rAF, duraklatılabilir) ───────────────────────────
  useEffect(() => {
    if (!current || current.isVideo) return
    if (paused || mediaError) return

    startRef.current = performance.now()
    const base = elapsedRef.current

    const tick = (now: number) => {
      const elapsed = base + (now - startRef.current)
      const ratio = Math.min(1, elapsed / IMAGE_DURATION_MS)
      elapsedRef.current = elapsed
      setProgress(ratio)
      if (ratio >= 1) { next() ; return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [current, paused, mediaError, next, index])

  // ── Video oynatma kontrolü ─────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v || !current?.isVideo) return
    v.muted = muted
    if (paused) { v.pause(); return }
    const p = v.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => { // sesli autoplay engellendiyse sessize al ve tekrar dene
        v.muted = true
        setMuted(true)
        v.play().catch(() => setMediaError(true))
      })
    }
  }, [current, paused, muted, index])

  if (!current) return null

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const takenLabel = current.takenAt ? relativeTime(current.takenAt) : ''
  const selectedItems = items.filter(it => selected.has(it.id))

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/85 backdrop-blur-md"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Kapat */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20"
        title="Kapat (Esc)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>

      <div className="relative flex h-full max-h-[92vh] w-full max-w-[420px] flex-col px-3 py-4">
        {/* Segment çubukları */}
        <div className="flex gap-1 px-0.5">
          {items.map((it, i) => (
            <div key={it.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/25">
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%`, transition: i === index ? 'none' : 'width .2s' }}
              />
            </div>
          ))}
        </div>

        {/* Başlık */}
        <div className="mt-3 flex items-center gap-2.5 px-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-xs font-bold text-white">
            {(reel.username || '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-white">@{reel.username || 'instagram'}</p>
            {reel.kind === 'highlight' && reel.title && reel.title !== '.' && (
              <p className="truncate text-[11px] text-white/55">{reel.title}</p>
            )}
          </div>
          {takenLabel && <span className="shrink-0 text-[11px] text-white/45">{takenLabel}</span>}
          <button
            onClick={() => setPaused(p => !p)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
            title={paused ? 'Oynat' : 'Duraklat'}
          >
            {paused
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>}
          </button>
          {current.isVideo && (
            <button
              onClick={() => setMuted(m => !m)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
              title={muted ? 'Sesi aç' : 'Sessize al'}
            >
              {muted
                ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>}
            </button>
          )}
        </div>

        {/* Medya */}
        <div className="relative mt-3 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-[#0a0a0c]">
          {mediaError ? (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-white/60">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
              <p className="text-xs">Bu medya yüklenemedi. Süresi dolmuş olabilir; yeniden analiz edin.</p>
            </div>
          ) : current.isVideo ? (
            <video
              ref={videoRef}
              key={current.id}
              src={current.mediaUrl}
              className="h-full w-full object-contain"
              playsInline
              autoPlay
              onEnded={next}
              onError={() => setMediaError(true)}
              onTimeUpdate={(e) => {
                const v = e.currentTarget
                if (v.duration > 0) setProgress(v.currentTime / v.duration)
              }}
            />
          ) : (
            <img
              key={current.id}
              src={current.mediaUrl}
              alt=""
              className="h-full w-full object-contain"
              onError={() => setMediaError(true)}
            />
          )}

          {/* Dokunma alanları */}
          <button className="absolute inset-y-0 left-0 w-1/3 cursor-default focus:outline-none" onClick={prev} aria-label="Önceki" />
          <button className="absolute inset-y-0 right-0 w-1/3 cursor-default focus:outline-none" onClick={next} aria-label="Sonraki" />

          {/* İndir (mevcut) */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <button
              onClick={() => onDownloadItem(current)}
              disabled={requestedIds.has(current.id)}
              className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-semibold text-white backdrop-blur-md transition-all hover:bg-white/25 disabled:opacity-60"
            >
              {requestedIds.has(current.id) ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m20 6-11 11-5-5"/></svg>
                  Kuyruğa eklendi
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Bu {current.isVideo ? 'videoyu' : 'görseli'} indir
                </>
              )}
            </button>
          </div>
        </div>

        {/* Küçük resim şeridi + toplu indirme */}
        <div className="mt-3 shrink-0">
          <div className="flex items-center justify-between px-0.5 pb-2">
            <span className="text-[11px] text-white/45">{index + 1} / {items.length}</span>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <button
                  onClick={() => { onDownloadMany(selectedItems); setSelected(new Set()) }}
                  className="rounded-full bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500"
                >
                  Seçilenleri indir ({selected.size})
                </button>
              )}
              <button
                onClick={() => onDownloadMany(items)}
                className="rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold text-white/80 hover:bg-white/10"
              >
                Tümünü indir
              </button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
            {items.map((it, i) => (
              <div key={it.id} className="relative shrink-0">
                <button
                  onClick={() => goTo(i)}
                  className={`relative h-16 w-10 overflow-hidden rounded-lg border-2 transition-all ${i === index ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'}`}
                >
                  <img src={it.thumbnail || it.mediaUrl} alt="" className="h-full w-full object-cover" />
                  {it.isVideo && (
                    <span className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                    </span>
                  )}
                  {requestedIds.has(it.id) && (
                    <span className="absolute left-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m20 6-11 11-5-5"/></svg>
                    </span>
                  )}
                </button>
                <button
                  onClick={() => toggleSelect(it.id)}
                  className={`absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded border ${selected.has(it.id) ? 'border-violet-400 bg-violet-500' : 'border-white/50 bg-black/40'}`}
                  title="Seç"
                >
                  {selected.has(it.id) && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m20 6-11 11-5-5"/></svg>}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return ''
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(diff / 60_000))}d`
  if (h < 24) return `${h}sa`
  return `${Math.floor(h / 24)}g`
}
