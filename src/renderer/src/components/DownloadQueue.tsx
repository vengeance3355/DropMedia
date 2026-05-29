import { useEffect, useRef, useState } from 'react'
import { DownloadItem } from '../types'
import { formatDuration } from '../utils/platform'

interface Props {
  items: DownloadItem[]
  onCancel: (id: string) => void
  onPause: (id: string) => void
  onResume: (item: DownloadItem) => void
  onRedownload: (item: DownloadItem) => void
  onRemove: (id: string) => void
  onClearCompleted: () => void
  onShowItemInFolder: (item: DownloadItem) => void
  onConvertDone?: (id: string, newPath: string) => void
  onUrlDrop?: (url: string) => void
}

const FETCH_MESSAGES = [
  'Sunucuya bağlanıyor…',
  'Video bilgisi alınıyor…',
  'Formatlar analiz ediliyor…',
  'İçerik hazırlanıyor…',
  'Metadata işleniyor…',
]

export function DownloadQueue({ items, onCancel, onPause, onResume, onRedownload, onRemove, onClearCompleted, onShowItemInFolder, onConvertDone, onUrlDrop }: Props) {
  const hasCompleted = items.some(i => i.status === 'completed' || i.status === 'error')

  if (items.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center animate-fade-in rounded-2xl border-2 border-dashed border-white/8 transition-colors"
        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-purple-500/40') }}
        onDragLeave={e => e.currentTarget.classList.remove('border-purple-500/40')}
        onDrop={e => {
          e.preventDefault()
          e.currentTarget.classList.remove('border-purple-500/40')
          const url = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
          if (isHttpUrl(url)) onUrlDrop?.(url.trim())
        }}
      >
        <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <p className="text-white/30 text-sm font-medium">İndirme kuyruğu boş</p>
        <p className="text-white/20 text-xs mt-1">URL yapıştırın veya buraya sürükleyin</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {hasCompleted && (
        <div className="flex justify-end">
          <button onClick={onClearCompleted} className="text-xs text-white/30 hover:text-white/60 transition-colors">
            Tamamlananları temizle
          </button>
        </div>
      )}
      {items.map(item => (
        <DownloadCard key={item.id} item={item} onCancel={onCancel} onPause={onPause} onResume={onResume} onRedownload={onRedownload} onRemove={onRemove} onShowItemInFolder={onShowItemInFolder} onConvertDone={onConvertDone} />
      ))}
    </div>
  )
}

function DownloadCard({ item, onCancel, onPause, onResume, onRedownload, onRemove, onShowItemInFolder, onConvertDone }: {
  item: DownloadItem
  onCancel: (id: string) => void
  onPause: (id: string) => void
  onResume: (item: DownloadItem) => void
  onRedownload: (item: DownloadItem) => void
  onRemove: (id: string) => void
  onShowItemInFolder: (item: DownloadItem) => void
  onConvertDone?: (id: string, newPath: string) => void
}) {
  const { status, progress, speed, eta, totalSize, videoInfo, selectedFormat, error, downloadLog } = item
  const [converting, setConverting]     = useState(false)
  const [convertError, setConvertError] = useState('')
  const [showConvert, setShowConvert]   = useState(false)
  const [showSource, setShowSource]     = useState(false)
  const [urlCopied, setUrlCopied]       = useState(false)
  const [fetchMsgIdx, setFetchMsgIdx]   = useState(0)
  const sourceRef  = useRef<HTMLDivElement>(null)
  const convertRef = useRef<HTMLDivElement>(null)

  // Fetching sırasında dönen mesajlar
  useEffect(() => {
    if (status !== 'fetching') return
    const t = setInterval(() => setFetchMsgIdx(i => (i + 1) % FETCH_MESSAGES.length), 1800)
    return () => clearInterval(t)
  }, [status])

  // Popup dışı tıkla kapat
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) setShowSource(false)
      if (convertRef.current && !convertRef.current.contains(e.target as Node)) setShowConvert(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const statusConfig = {
    pending:     { color: 'text-white/40',   label: 'Bekliyor',        dot: 'bg-white/30' },
    fetching:    { color: 'text-blue-400',   label: 'Analiz ediliyor', dot: 'bg-blue-400 animate-pulse' },
    downloading: { color: 'text-purple-400', label: 'İndiriliyor',     dot: 'bg-purple-400 animate-pulse' },
    paused:      { color: 'text-amber-400',  label: 'Duraklatıldı',    dot: 'bg-amber-400' },
    completed:   { color: 'text-green-400',  label: 'Tamamlandı',      dot: 'bg-green-400' },
    error:       { color: 'text-red-400',    label: 'Hata',            dot: 'bg-red-400' },
    cancelled:   { color: 'text-white/30',   label: 'İptal edildi',    dot: 'bg-white/20' }
  }

  const cfg      = statusConfig[status]
  const title    = videoInfo?.title || item.url
  const duration = videoInfo?.duration ? formatDuration(videoInfo.duration) : ''

  function handleDragStart(e: React.DragEvent) {
    e.stopPropagation()
    if (!item.outputPath) { e.preventDefault(); return }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', item.outputPath)
    window.api.startFileDrag(item.outputPath).catch(() => {})
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(item.url).then(() => {
      setUrlCopied(true)
      setTimeout(() => setUrlCopied(false), 1500)
    })
    setShowSource(false)
  }

  async function handleConvert(toFormat: string) {
    if (!item.outputPath) return
    setConverting(true); setConvertError('')
    const outputPath = item.outputPath.replace(/\.[^.]+$/, `.${toFormat}`)
    const r = await window.api.convertFile({ inputPath: item.outputPath, outputFormat: toFormat, outputPath }) as { success: boolean; error?: string }
    setConverting(false)
    if (!r.success) {
      setConvertError(r.error ?? 'Dönüştürme başarısız')
    } else {
      setShowConvert(false)
      onConvertDone?.(item.id, outputPath)
    }
  }

  // İndirme log mesajını temizle — kısa ve okunabilir hale getir
  function cleanLog(raw: string): string {
    return raw
      .replace(/^\[download\]\s*/i, '')
      .replace(/^\[ffmpeg\]\s*/i, '')
      .replace(/^\[Merger\]\s*/i, 'Birleştiriliyor: ')
      .replace(/^\[ExtractAudio\]\s*/i, 'Ses çıkarılıyor: ')
      .replace(/^Deleting original file.*/, 'Geçici dosyalar temizleniyor…')
      .replace(/^Destination:.*/, 'Hedef dosya hazırlanıyor…')
      .trim()
      .slice(0, 60)
  }

  const activityMsg = status === 'fetching'
    ? FETCH_MESSAGES[fetchMsgIdx]
    : (status === 'downloading' && downloadLog && !speed)
      ? cleanLog(downloadLog)
      : null

  return (
    <div className="group rounded-2xl bg-white/5 border border-white/8 hover:border-white/12 transition-all duration-200 animate-slide-up">
      <div className="flex items-center gap-3 p-3.5">
        {/* Thumbnail */}
        <div className="relative shrink-0 w-14 h-10 rounded-xl overflow-hidden bg-white/5 cursor-pointer"
          onClick={() => status === 'completed' && item.outputPath && window.api.openFileInPlayer(item.outputPath)}>
          {videoInfo?.thumbnail
            ? <img src={videoInfo.thumbnail} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center">
                <svg className="text-white/15" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </div>
          }
          {duration && (
            <div className="absolute bottom-0.5 right-0.5 px-1 py-px rounded text-[9px] font-medium bg-black/70 text-white leading-none">{duration}</div>
          )}
          {status === 'completed' && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            </div>
          )}
        </div>

        {/* Bilgi */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.color}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
            <span className="text-white/20 text-xs">•</span>
            <span className="text-white/40 text-xs">{selectedFormat}</span>
          </div>
          <p className="text-white/80 text-sm font-medium leading-tight truncate">{title}</p>
          {status === 'downloading' && (
            <div className="mt-1 flex items-center gap-2 text-xs text-white/30">
              {speed  && <span>{speed}</span>}
              {eta    && <span>• ETA {eta}</span>}
              {totalSize && <span>• {totalSize}</span>}
              {activityMsg && !speed && (
                <span className="text-blue-400/70 animate-pulse">{activityMsg}</span>
              )}
            </div>
          )}
          {activityMsg && status === 'fetching' && (
            <p className="mt-0.5 text-blue-400/60 text-xs animate-pulse">{activityMsg}</p>
          )}
          {status === 'error' && error && <p className="mt-1 text-red-400/70 text-xs truncate">{error}</p>}
          {convertError && <p className="mt-1 text-red-400/70 text-xs">{convertError}</p>}
        </div>

        {/* Aksiyonlar */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {status === 'completed' && item.outputPath && (
            <>
              {/* Kaynak popup */}
              <div className="relative" ref={sourceRef}>
                <ActionBtn onClick={() => setShowSource(v => !v)} title="Kaynak">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                </ActionBtn>
                {showSource && (
                  <div className="absolute right-0 top-8 z-20 bg-[#1a1030] border border-white/10 rounded-xl p-2 min-w-[9rem] shadow-xl">
                    <button onClick={handleCopyUrl}
                      className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/8 rounded-lg transition-colors flex items-center gap-2">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      {urlCopied ? 'Kopyalandı!' : 'URL Kopyala'}
                    </button>
                    <button onClick={() => { window.api.openUrl(item.url); setShowSource(false) }}
                      className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/8 rounded-lg transition-colors flex items-center gap-2">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                      Tarayıcıda Aç
                    </button>
                  </div>
                )}
              </div>

              {/* Sürükle */}
              <DragActionBtn onDragStart={handleDragStart} title="Sürükleyerek paylaş" className="cursor-grab">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </DragActionBtn>

              {/* Dönüştür */}
              <div className="relative" ref={convertRef}>
                <ActionBtn onClick={() => setShowConvert(v => !v)} title="Dönüştür">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                </ActionBtn>
                {showConvert && (
                  <div className="absolute right-0 top-8 z-20 bg-[#1a1030] border border-white/10 rounded-xl p-2 min-w-32 shadow-xl">
                    {['mp3','m4a','mp4','webm'].map(f => (
                      <button key={f} onClick={() => handleConvert(f)} disabled={converting}
                        className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/8 rounded-lg transition-colors disabled:opacity-40">
                        {converting ? '…' : f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {status === 'downloading' && (
            <ActionBtn onClick={() => onPause(item.id)} title="Duraklat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 5h4v14H7zM13 5h4v14h-4z"/>
              </svg>
            </ActionBtn>
          )}
          {status === 'paused' && (
            <ActionBtn onClick={() => onResume(item)} title="Devam et">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </ActionBtn>
          )}
          {(status === 'downloading' || status === 'pending' || status === 'fetching' || status === 'paused') && (
            <ActionBtn onClick={() => onCancel(item.id)} title="İptal et" className="hover:text-red-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </ActionBtn>
          )}
          {(status === 'completed' || status === 'error' || status === 'cancelled') && (
            <>
              <ActionBtn onClick={() => onRedownload(item)} title="Tekrar indir">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
                </svg>
              </ActionBtn>
              <ActionBtn onClick={() => onShowItemInFolder(item)} title="Dosya konumunu aç">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </ActionBtn>
              <ActionBtn onClick={() => onRemove(item.id)} title="Kaldır" className="hover:text-red-400">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
              </ActionBtn>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(status === 'downloading' || status === 'paused' || status === 'completed') && (
        <div className="h-0.5 bg-white/5 mx-3.5 mb-3 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              status === 'downloading'
                ? 'bg-gradient-progress'
                : status === 'paused'
                  ? 'bg-amber-400/60'
                  : 'bg-gradient-progress'
            }`}
            style={{ width: `${status === 'completed' ? 100 : progress}%` }}
          />
        </div>
      )}
      {/* Fetching indeterminate bar */}
      {status === 'fetching' && (
        <div className="h-0.5 bg-white/5 mx-3.5 mb-3 rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-blue-400/60 rounded-full animate-[slide-right_1.4s_ease-in-out_infinite]" />
        </div>
      )}
    </div>
  )
}

function ActionBtn({ onClick, children, title, className = '' }: {
  onClick: () => void; children: React.ReactNode; title: string; className?: string
}) {
  return (
    <button onClick={onClick} title={title}
      className={`w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:bg-white/8 transition-all ${className}`}>
      {children}
    </button>
  )
}

function DragActionBtn({ onDragStart, children, title, className = '' }: {
  onDragStart: (e: React.DragEvent) => void; children: React.ReactNode; title: string; className?: string
}) {
  return (
    <button draggable onDragStart={onDragStart} onClick={e => e.preventDefault()} title={title}
      className={`w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:bg-white/8 transition-all ${className}`}>
      {children}
    </button>
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch { return false }
}
