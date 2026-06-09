import { useEffect, useRef, useState } from 'react'
import { DownloadItem } from '../types'
import { formatMediaDuration } from '../utils/formatDuration'
import { resolveMediaThumbnail } from '../utils/mediaThumbnail'
import { detectPlatform } from '../utils/platform'
import { getHistoryPlatform, HistoryDateRange, HistoryFilters, HistoryMediaType, HistoryPlatform, HistorySort, HistoryStatus } from './HistoryFilters'
import { MediaListItem } from './MediaListItem'

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
  onRepairMediaMetadata?: (id: string) => Promise<void>
}

const FETCH_MESSAGES = [
  'Sunucuya bağlanıyor…',
  'Video bilgisi alınıyor…',
  'Formatlar analiz ediliyor…',
  'İçerik hazırlanıyor…',
  'Metadata işleniyor…',
]

export function DownloadQueue({ items, onCancel, onPause, onResume, onRedownload, onRemove, onClearCompleted, onShowItemInFolder, onConvertDone, onUrlDrop, onRepairMediaMetadata }: Props) {
  const hasCompleted = items.some(i => i.status === 'completed' || i.status === 'error')
  const isHistoryView = items.length > 0 && items.every(isHistoryItem)
  const [search, setSearch] = useState('')
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('all')
  const [platform, setPlatform] = useState<HistoryPlatform>('all')
  const [mediaType, setMediaType] = useState<HistoryMediaType>('all')
  const [dateRange, setDateRange] = useState<HistoryDateRange>('all')
  const [sort, setSort] = useState<HistorySort>('newest')
  const visibleItems = isHistoryView
    ? filterHistoryItems(items, { search, status: historyStatus, platform, mediaType, dateRange, sort })
    : items

  if (items.length === 0) {
    return (
      <div
        className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-[#16161A]/70 py-16 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl transition-colors animate-fade-in"
        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-[#7C3AED]/50') }}
        onDragLeave={e => e.currentTarget.classList.remove('border-[#7C3AED]/50')}
        onDrop={e => {
          e.preventDefault()
          e.currentTarget.classList.remove('border-[#7C3AED]/50')
          const url = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
          if (isHttpUrl(url)) onUrlDrop?.(url.trim())
        }}
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.06] bg-[#1E1E25] shadow-[0_0_40px_rgba(124,58,237,0.12)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <p className="text-sm font-medium text-zinc-300">İndirme kuyruğu boş</p>
        <p className="mt-1 text-xs text-zinc-600">URL yapıştırın veya buraya sürükleyin</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {isHistoryView && (
        <HistoryFilters
          search={search}
          setSearch={setSearch}
          status={historyStatus}
          setStatus={setHistoryStatus}
          platform={platform}
          setPlatform={setPlatform}
          mediaType={mediaType}
          setMediaType={setMediaType}
          dateRange={dateRange}
          setDateRange={setDateRange}
          sort={sort}
          setSort={setSort}
          items={items}
        />
      )}
      {hasCompleted && (
        <div className="flex justify-end gap-2">
          <button onClick={onClearCompleted} className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-300">
            {isHistoryView ? 'Geçmişi temizle' : 'Tamamlananları temizle'}
          </button>
        </div>
      )}
      {isHistoryView && visibleItems.length === 0 && (
        <div className="rounded-xl border border-white/[0.04] bg-[#16161A]/70 px-4 py-8 text-center text-sm text-zinc-500">
          Filtrelere uygun geçmiş kaydı yok
        </div>
      )}
      {visibleItems.map(item => (
        isHistoryView ? (
          <HistoryCard key={item.id} item={item} onRedownload={onRedownload} onRemove={onRemove} onShowItemInFolder={onShowItemInFolder} onRepairMediaMetadata={onRepairMediaMetadata} />
        ) : (
          <DownloadCard key={item.id} item={item} onCancel={onCancel} onPause={onPause} onResume={onResume} onRedownload={onRedownload} onRemove={onRemove} onShowItemInFolder={onShowItemInFolder} onConvertDone={onConvertDone} />
        )
      ))}
    </div>
  )
}

function HistoryCard({ item, onRedownload, onRemove, onShowItemInFolder, onRepairMediaMetadata }: {
  item: DownloadItem
  onRedownload: (item: DownloadItem) => void
  onRemove: (id: string) => void
  onShowItemInFolder: (item: DownloadItem) => void
  onRepairMediaMetadata?: (id: string) => Promise<void>
}) {
  const statusConfig = {
    completed: { color: 'text-green-400', label: 'Tamamlandı', dot: 'bg-green-400' },
    error: { color: 'text-red-400', label: 'Hata', dot: 'bg-red-400' },
    cancelled: { color: 'text-white/30', label: 'İptal edildi', dot: 'bg-white/20' },
    pending: { color: 'text-white/40', label: 'Bekliyor', dot: 'bg-white/30' },
    fetching: { color: 'text-blue-400', label: 'Analiz', dot: 'bg-blue-400' },
    downloading: { color: 'text-purple-400', label: 'İndiriliyor', dot: 'bg-purple-400' },
    paused: { color: 'text-amber-400', label: 'Duraklatıldı', dot: 'bg-amber-400' }
  }
  const cfg = statusConfig[item.status]

  return (
    <div className="group rounded-xl border border-white/[0.04] bg-[#16161A] px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.03),0_24px_60px_rgba(0,0,0,0.18)] transition-all duration-200 hover:border-white/[0.08] hover:bg-[#1E1E25]">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <MediaListItem item={item} showActions />
          {item.error && <p title={item.error} className="mt-2 line-clamp-2 text-xs text-red-400/80">{item.error}</p>}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] font-medium ${cfg.color}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onRepairMediaMetadata && (
            <ActionBtn onClick={() => { onRepairMediaMetadata(item.id).catch(() => {}) }} title="Kapak/süre onar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 2l-2 2"/><path d="M3 22l7-7"/><path d="M7 12l5 5"/><path d="M14 4l6 6"/><path d="M5 14l5 5"/>
              </svg>
            </ActionBtn>
          )}
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
        </div>
      </div>
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

  const platform = detectPlatform(item.url)
  const thumbnail = resolveMediaThumbnail(item)
  const thumbnailSrc = thumbnail.src || thumbnail.fallbackSrc
  const thumbnailFallback = thumbnail.fallbackSrc

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
  const durationSeconds = item.duration ?? videoInfo?.duration
  const duration = formatMediaDuration(durationSeconds)

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
    try {
      await window.api.startConvert({
        inputPath: item.outputPath,
        outputFormat: toFormat,
        outputPath,
        title: item.videoInfo?.title || item.outputPath.replace(/.*[\\/]/, '')
      })
      setShowConvert(false)
      onConvertDone?.(item.id, outputPath)
    } catch {
      setConvertError('Dönüştürme başlatılamadı')
    } finally {
      setConverting(false)
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
    <div className="group rounded-xl border border-white/[0.04] bg-[#16161A] shadow-[0_1px_0_rgba(255,255,255,0.03),0_24px_60px_rgba(0,0,0,0.18)] transition-all duration-200 hover:border-white/[0.08] hover:bg-[#1E1E25] animate-slide-up">
      <div className="flex items-center gap-4 px-4 py-3">
        {/* Thumbnail */}
        <div className="relative h-[72px] w-32 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-white/[0.06] bg-[linear-gradient(135deg,#252530,#16161A)]"
          onClick={() => status === 'completed' && item.outputPath && window.api.openFileInPlayer(item.outputPath)}>
          <ThumbnailContent src={thumbnailSrc} fallbackSrc={thumbnailFallback} platform={platform} />
          {duration && (
            <div className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[9px] font-medium leading-none text-white">{duration}</div>
          )}
          {status === 'completed' && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            </div>
          )}
        </div>

        {/* Bilgi */}
        <div className="flex-1 min-w-0">
          <div className="mb-1 flex items-start gap-3">
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 tracking-[-0.01em] text-zinc-100">{title}</p>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] font-medium ${cfg.color}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
          </div>
          <p className="truncate font-mono text-[11px] text-zinc-600">{item.url}</p>
          {status === 'downloading' && (
            <div className="mt-2 flex items-center gap-2 font-mono text-xs text-zinc-500">
              <span className="font-sans text-zinc-400">{selectedFormat}</span>
              {speed  && <span>{speed}</span>}
              {eta    && <span>ETA {eta}</span>}
              {totalSize && <span>{totalSize}</span>}
              {activityMsg && !speed && (
                <span className="text-blue-400/70 animate-pulse">{activityMsg}</span>
              )}
            </div>
          )}
          {activityMsg && status === 'fetching' && (
            <p className="mt-2 text-xs text-blue-400/70 animate-pulse">{activityMsg}</p>
          )}
          {status === 'error' && error && <p title={error} className="mt-2 line-clamp-2 text-xs text-red-400/80">{error}</p>}
          {convertError && <p className="mt-2 text-xs text-red-400/80">{convertError}</p>}
        </div>

        {/* Aksiyonlar */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
                  <div className="absolute right-0 top-8 z-50 min-w-[9rem] rounded-xl border border-white/[0.08] bg-[#1E1E25] p-2 shadow-2xl shadow-black/30">
                    <button onClick={handleCopyUrl}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      {urlCopied ? 'Kopyalandı!' : 'URL Kopyala'}
                    </button>
                    <button onClick={() => { window.api.openUrl(item.url); setShowSource(false) }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white">
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
                  <div className="absolute right-0 top-8 z-50 min-w-32 rounded-xl border border-white/[0.08] bg-[#1E1E25] p-2 shadow-2xl shadow-black/30">
                    {['mp3','m4a','mp4','webm'].map(f => (
                      <button key={f} onClick={() => handleConvert(f)} disabled={converting}
                        className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
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
        <div className="mx-4 mb-3 h-[3px] overflow-hidden rounded-full bg-[#252530]">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              status === 'downloading'
                ? 'bg-gradient-to-r from-[#7C3AED] via-[#8B5CF6] to-[#2563EB] shadow-[0_0_18px_rgba(124,58,237,0.45)]'
                : status === 'paused'
                  ? 'bg-amber-400/60'
                  : 'bg-gradient-to-r from-emerald-400 to-green-500'
            }`}
            style={{ width: `${status === 'completed' ? 100 : progress}%` }}
          />
        </div>
      )}
      {/* Fetching indeterminate bar */}
      {status === 'fetching' && (
        <div className="mx-4 mb-3 h-[3px] overflow-hidden rounded-full bg-[#252530]">
          <div className="h-full w-1/3 rounded-full bg-blue-400/70 animate-[slide-right_1.4s_ease-in-out_infinite]" />
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
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-white ${className}`}>
      {children}
    </button>
  )
}

function DragActionBtn({ onDragStart, children, title, className = '' }: {
  onDragStart: (e: React.DragEvent) => void; children: React.ReactNode; title: string; className?: string
}) {
  return (
    <button draggable onDragStart={onDragStart} onClick={e => e.preventDefault()} title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-all hover:bg-white/[0.06] hover:text-white ${className}`}>
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

function ThumbnailContent({ src, fallbackSrc, platform }: { src?: string; fallbackSrc: string; platform: ReturnType<typeof detectPlatform> }) {
  const [isBroken, setIsBroken] = useState(false)
  const resolvedSrc = src?.trim() ?? ''
  const platformIcon = platform.icon.length <= 3 ? platform.icon.toUpperCase() : ''

  useEffect(() => { setIsBroken(false) }, [resolvedSrc])

  if (resolvedSrc && !isBroken) {
    return <img key={resolvedSrc} src={resolvedSrc} alt="" className="w-full h-full object-cover" onError={() => setIsBroken(true)} />
  }

  return (
    <img src={fallbackSrc} alt={platformIcon} className="h-full w-full object-cover" />
  )
}

function isHistoryItem(item: DownloadItem): boolean {
  return item.status === 'completed' || item.status === 'error' || item.status === 'cancelled'
}

function filterHistoryItems(items: DownloadItem[], filters: {
  search: string
  status: HistoryStatus
  platform: HistoryPlatform
  mediaType: HistoryMediaType
  dateRange: HistoryDateRange
  sort: HistorySort
}): DownloadItem[] {
  const query = filters.search.trim().toLowerCase()
  const minDate = getMinHistoryDate(filters.dateRange)
  return [...items].filter(item => {
    if (filters.status !== 'all' && item.status !== filters.status) return false
    if (filters.platform !== 'all' && getHistoryPlatform(item) !== filters.platform) return false
    if (filters.mediaType !== 'all' && getMediaType(item) !== filters.mediaType) return false
    if (minDate && (!item.completedAt || item.completedAt < minDate)) return false
    if (!query) return true
    const haystack = `${item.videoInfo?.title ?? ''} ${item.url} ${item.outputPath ?? ''}`.toLowerCase()
    return haystack.includes(query)
  }).sort((a, b) => compareHistoryItems(a, b, filters.sort))
}

function getMinHistoryDate(range: HistoryDateRange): number | null {
  const now = Date.now()
  if (range === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (range === 'week') return now - 7 * 24 * 60 * 60 * 1000
  if (range === 'month') return now - 30 * 24 * 60 * 60 * 1000
  return null
}

function getMediaType(item: DownloadItem): HistoryMediaType {
  return ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus'].includes(item.selectedFormat.toLowerCase()) ? 'audio' : 'video'
}

function compareHistoryItems(a: DownloadItem, b: DownloadItem, sort: HistorySort): number {
  const titleA = (a.videoInfo?.title || a.url).toLowerCase()
  const titleB = (b.videoInfo?.title || b.url).toLowerCase()
  if (sort === 'oldest') return (a.completedAt ?? 0) - (b.completedAt ?? 0)
  if (sort === 'az') return titleA.localeCompare(titleB, 'tr')
  if (sort === 'za') return titleB.localeCompare(titleA, 'tr')
  if (sort === 'platform') return getHistoryPlatform(a).localeCompare(getHistoryPlatform(b))
  if (sort === 'size-desc') return parseSize(b.totalSize) - parseSize(a.totalSize)
  if (sort === 'size-asc') return parseSize(a.totalSize) - parseSize(b.totalSize)
  return (b.completedAt ?? 0) - (a.completedAt ?? 0)
}

function parseSize(value: string): number {
  const match = value.match(/([\d.]+)\s*([kmgt]?i?b)?/i)
  if (!match) return 0
  const amount = Number(match[1])
  const unit = (match[2] || '').toLowerCase()
  const multiplier = unit.startsWith('t') ? 1024 ** 4
    : unit.startsWith('g') ? 1024 ** 3
      : unit.startsWith('m') ? 1024 ** 2
        : unit.startsWith('k') ? 1024
          : 1
  return Number.isFinite(amount) ? amount * multiplier : 0
}
