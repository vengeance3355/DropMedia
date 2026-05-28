import { DownloadItem } from '../types'
import { formatDuration } from '../utils/platform'

interface Props {
  items: DownloadItem[]
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClearCompleted: () => void
  onOpenFolder: (path?: string) => void
}

export function DownloadQueue({ items, onCancel, onRemove, onClearCompleted, onOpenFolder }: Props) {
  const hasCompleted = items.some((i) => i.status === 'completed' || i.status === 'error')

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <p className="text-white/30 text-sm font-medium">İndirme kuyruğu boş</p>
        <p className="text-white/20 text-xs mt-1">Yukarıya bir URL yapıştırın</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {hasCompleted && (
        <div className="flex justify-end">
          <button
            onClick={onClearCompleted}
            className="text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            Tamamlananları temizle
          </button>
        </div>
      )}
      {items.map((item) => (
        <DownloadCard
          key={item.id}
          item={item}
          onCancel={onCancel}
          onRemove={onRemove}
          onOpenFolder={onOpenFolder}
        />
      ))}
    </div>
  )
}

function DownloadCard({
  item,
  onCancel,
  onRemove,
  onOpenFolder
}: {
  item: DownloadItem
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onOpenFolder: (path?: string) => void
}) {
  const { status, progress, speed, eta, totalSize, videoInfo, selectedFormat, error } = item

  const statusConfig = {
    pending:     { color: 'text-white/40',   label: 'Bekliyor',     dot: 'bg-white/30' },
    fetching:    { color: 'text-blue-400',   label: 'Analiz ediliyor', dot: 'bg-blue-400 animate-pulse' },
    downloading: { color: 'text-purple-400', label: 'İndiriliyor',  dot: 'bg-purple-400 animate-pulse' },
    completed:   { color: 'text-green-400',  label: 'Tamamlandı',   dot: 'bg-green-400' },
    error:       { color: 'text-red-400',    label: 'Hata',         dot: 'bg-red-400' },
    cancelled:   { color: 'text-white/30',   label: 'İptal edildi', dot: 'bg-white/20' }
  }

  const cfg = statusConfig[status]
  const title = videoInfo?.title || item.url
  const duration = videoInfo?.duration ? formatDuration(videoInfo.duration) : ''

  return (
    <div className="group rounded-2xl bg-white/5 border border-white/8 hover:border-white/12 transition-all duration-200 overflow-hidden animate-slide-up">
      <div className="flex items-center gap-3 p-3.5">
        {/* Thumbnail / Platform ikonu */}
        <div className="relative shrink-0 w-14 h-10 rounded-xl overflow-hidden bg-white/5">
          {videoInfo?.thumbnail ? (
            <img src={videoInfo.thumbnail} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="text-white/15" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          )}
          {duration && (
            <div className="absolute bottom-0.5 right-0.5 px-1 py-px rounded text-[9px] font-medium bg-black/70 text-white leading-none">
              {duration}
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
            <div className="mt-1.5 flex items-center gap-2 text-xs text-white/30">
              {speed && <span>{speed}</span>}
              {eta && <span>• ETA {eta}</span>}
              {totalSize && <span>• {totalSize}</span>}
            </div>
          )}

          {status === 'error' && error && (
            <p className="mt-1 text-red-400/70 text-xs truncate">{error}</p>
          )}
        </div>

        {/* Aksiyonlar */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {status === 'completed' && (
            <ActionBtn onClick={() => onOpenFolder(item.outputDir)} title="Klasörü aç">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </ActionBtn>
          )}
          {(status === 'downloading' || status === 'pending' || status === 'fetching') && (
            <ActionBtn onClick={() => onCancel(item.id)} title="İptal et" className="hover:text-red-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </ActionBtn>
          )}
          {(status === 'completed' || status === 'error' || status === 'cancelled') && (
            <ActionBtn onClick={() => onRemove(item.id)} title="Kaldır" className="hover:text-red-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </ActionBtn>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(status === 'downloading' || status === 'completed') && (
        <div className="h-0.5 bg-white/5 mx-3.5 mb-3 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-progress rounded-full transition-all duration-300"
            style={{ width: `${status === 'completed' ? 100 : progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

function ActionBtn({
  onClick,
  children,
  title,
  className = ''
}: {
  onClick: () => void
  children: React.ReactNode
  title: string
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:bg-white/8 transition-all ${className}`}
    >
      {children}
    </button>
  )
}
