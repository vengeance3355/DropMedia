import { useEffect, useRef, useState } from 'react'
import type { DownloadItem, HistoryEntry } from '../types'
import { formatMediaDuration } from '../utils/formatDuration'
import { getMediaPlatform, resolveMediaThumbnail } from '../utils/mediaThumbnail'

interface MediaListItemProps {
  item: DownloadItem | HistoryEntry
  compact?: boolean
  selected?: boolean
  onClick?: () => void
  showActions?: boolean
  onConvert?: (item: DownloadItem | HistoryEntry) => void
}


export function MediaListItem({ item, compact = false, selected = false, onClick, showActions = false, onConvert }: MediaListItemProps) {
  const thumbnail = resolveMediaThumbnail(item)
  const resolvedSrc = thumbnail.src || thumbnail.fallbackSrc
  const [image, setImage] = useState({ src: resolvedSrc, broken: false })
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const sourceMenuRef = useRef<HTMLDivElement | null>(null)
  const platform = getMediaPlatform(item)
  const title = item.videoInfo?.title || item.outputPath?.replace(/.*[\\/]/, '') || item.url
  const filename = item.outputPath?.replace(/.*[\\/]/, '') || item.selectedFormat?.toUpperCase()
  const durationSeconds = item.duration ?? item.videoInfo?.duration
  const duration = formatMediaDuration(durationSeconds)

  useEffect(() => {
    setImage({ src: resolvedSrc, broken: false })
    if (!thumbnail.src || !/^file:\/\//i.test(thumbnail.src)) return
    const localPath = decodeURI(thumbnail.src.replace(/^file:\/\//, ''))
    let cancelled = false
    window.api.getThumbnail(localPath)
      .then(result => { if (!cancelled && result) setImage({ src: result, broken: false }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [resolvedSrc])

  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (!sourceMenuRef.current?.contains(event.target as Node)) setSourceMenuOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const imageSrc = image.broken ? thumbnail.fallbackSrc : image.src
  const handleImageError = () => setImage({ src: thumbnail.fallbackSrc, broken: true })

  const content = (
    <>
      <div
        onClick={showActions && item.outputPath ? () => window.api.openFileInPlayer(item.outputPath!) : undefined}
        draggable={!!(showActions && item.outputPath)}
        onDragStart={showActions && item.outputPath ? (e) => {
          const imgEl = e.currentTarget.querySelector('img')
          if (imgEl) e.dataTransfer.setDragImage(imgEl, imgEl.clientWidth / 2, imgEl.clientHeight / 2)
          e.dataTransfer.setData('text/uri-list', `file://${item.outputPath!}`)
          e.dataTransfer.setData('text/plain', item.outputPath!)
          e.dataTransfer.effectAllowed = 'copy'
        } : undefined}
        className={`relative shrink-0 overflow-hidden rounded-lg border border-white/[0.06] bg-[#1E1E25] ${showActions && item.outputPath ? 'cursor-pointer' : ''} ${compact ? 'h-10 w-16' : 'h-14 w-24'}`}
      >
          <img
            src={imageSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={handleImageError}
          />
          {duration && (
            <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 font-mono text-[9px] font-medium leading-none text-white">
              {duration}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <span
              className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[9px] font-bold leading-none text-white"
              style={{ backgroundColor: platformColor(platform) }}
            >
              {thumbnail.label}
            </span>
            <p className={`${compact ? 'text-[11px]' : 'text-xs'} min-w-0 truncate font-medium text-white/80`}>
              {title}
            </p>
          </div>
          <p className={`${compact ? 'text-[10px]' : 'text-[11px]'} truncate text-white/30`}>
            {filename}
          </p>
        </div>
        {showActions && onConvert && item.outputPath && (
          <button onClick={(e) => { e.stopPropagation(); onConvert(item) }} className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[10px] text-white/50 hover:bg-white/8 hover:text-white">
            Dönüştür
          </button>
        )}
        {showActions && item.url && (
          <div ref={sourceMenuRef} className="relative shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setSourceMenuOpen(open => !open) }}
              className="rounded-lg border border-white/10 px-2 py-1 text-[10px] text-white/50 hover:bg-white/8 hover:text-white"
            >
              Kaynak
            </button>
            {sourceMenuOpen && (
              <div className="absolute right-0 top-7 z-50 min-w-[8rem] rounded-lg border border-white/10 bg-[#1E1E25] p-1 shadow-xl shadow-black/30">
                <button
                  onClick={(e) => { e.stopPropagation(); window.api.openUrl(item.url); setSourceMenuOpen(false) }}
                  className="block w-full rounded-md px-2 py-1.5 text-left text-[10px] text-white/60 hover:bg-white/8 hover:text-white"
                >
                  Kaynağa git
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(item.url); setSourceMenuOpen(false) }}
                  className="block w-full rounded-md px-2 py-1.5 text-left text-[10px] text-white/60 hover:bg-white/8 hover:text-white"
                >
                  Kaynağı kopyala
                </button>
              </div>
            )}
          </div>
        )}
    </>
  )

  const className = `flex min-w-0 items-center ${compact ? 'gap-2' : 'gap-3'} ${selected ? 'rounded-xl border border-violet-500/35 bg-violet-600/15 px-2 py-1.5' : ''}`

  if (onClick) {
    return <button onClick={onClick} className={`${className} w-full text-left`}>{content}</button>
  }

  return (
    <div className={className}>{content}</div>
  )
}

function platformColor(platform: ReturnType<typeof getMediaPlatform>): string {
  if (platform === 'instagram') return '#E1306C'
  if (platform === 'discord') return '#5865F2'
  if (platform === 'youtube') return '#FF0033'
  if (platform === 'twitter') return '#1D9BF0'
  return '#7C3AED'
}
