import { useState, useRef, useEffect } from 'react'
import { VideoInfo, VideoFormat } from '../types'
import { detectPlatform, formatDuration } from '../utils/platform'

interface Props {
  onDownload: (url: string, format: string, videoInfo: VideoInfo) => Promise<boolean>
  disabled?: boolean
  incomingUrl?: { id: string; url: string } | null
  onIncomingUrlHandled?: () => void
}

const FETCH_MSGS = [
  'Sunucuya bağlanıyor…',
  'Video bilgisi alınıyor…',
  'Formatlar analiz ediliyor…',
  'İçerik hazırlanıyor…',
  'Metadata işleniyor…',
]

export function UrlInput({ onDownload, disabled, incomingUrl, onIncomingUrlHandled }: Props) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  const [selectedFormat, setSelectedFormat] = useState('')
  const [error, setError] = useState('')
  const [fetchMsgIdx, setFetchMsgIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setFetchMsgIdx(i => (i + 1) % FETCH_MSGS.length), 1600)
    return () => clearInterval(t)
  }, [loading])

  const platform = url ? detectPlatform(url) : null

  function isValidUrl(s: string) {
    try { new URL(s); return true } catch { return false }
  }

  async function handleFetch() {
    if (!url.trim() || !isValidUrl(url)) {
      setError('Geçerli bir URL girin')
      return
    }
    setError('')
    setLoading(true)
    setVideoInfo(null)

    try {
      const info = await window.api.fetchInfo(url) as VideoInfo
      setVideoInfo(info)
      const defaultFmt = info.formats.find(f => f.id === 'best') || info.formats[0]
      setSelectedFormat(defaultFmt?.id || '')
    } catch (e: unknown) {
      setError(cleanError(e))
    } finally {
      setLoading(false)
    }
  }

  async function handlePaste() {
    const text = await navigator.clipboard.readText()
    setUrl(text)
    setVideoInfo(null)
    setError('')
  }

  async function handleDownload() {
    if (!videoInfo || !selectedFormat) return
    const started = await onDownload(url, selectedFormat, videoInfo)
    if (!started) {
      setError('Bu video aynı kalitede zaten kuyruğa eklendi veya başlatılamadı.')
      return
    }
    setUrl('')
    setVideoInfo(null)
    setSelectedFormat('')
  }

  useEffect(() => {
    if (!incomingUrl) return

    setUrl(incomingUrl.url)
    setVideoInfo(null)
    setSelectedFormat('')
    setError('')
    inputRef.current?.focus()
    onIncomingUrlHandled?.()
  }, [incomingUrl?.id])

  useEffect(() => {
    if (url && !videoInfo && !loading) {
      const timer = setTimeout(() => {
        if (isValidUrl(url)) handleFetch()
      }, 800)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [url])

  const videoFormats = videoInfo?.formats.filter(f => f.type === 'video') || []
  const audioFormats = videoInfo?.formats.filter(f => f.type === 'audio') || []

  return (
    <div className="space-y-4">
      {/* URL Giriş Kutusu */}
      <div className="relative group">
        <div className={`
          flex items-center gap-3 px-4 py-3.5 rounded-2xl
          bg-white/5 border border-white/10
          focus-within:border-purple-500/50 focus-within:bg-white/8
          transition-all duration-300
          ${loading ? 'border-purple-500/30 animate-pulse-slow' : ''}
        `}>
          {/* Platform ikonu */}
          <div className={`
            shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold
            transition-all duration-300
            ${platform ? 'opacity-100' : 'opacity-40'}
          `}
          style={{ backgroundColor: platform ? `${platform.color}20` : 'rgba(255,255,255,0.05)', color: platform?.color || '#fff' }}>
            {platform ? platform.name.slice(0, 2) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>
              </svg>
            )}
          </div>

          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setVideoInfo(null); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
            placeholder="YouTube, TikTok, Instagram, X ve daha fazlası..."
            disabled={disabled || loading}
            className="flex-1 bg-transparent text-white placeholder-white/30 text-sm outline-none min-w-0"
          />

          {/* Butonlar */}
          <div className="flex items-center gap-2 shrink-0">
            {url && (
              <button
                onClick={() => { setUrl(''); setVideoInfo(null); setError('') }}
                className="text-white/30 hover:text-white/70 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            )}
            <button
              onClick={handlePaste}
              className="px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-white/60 hover:text-white text-xs font-medium transition-all"
            >
              Yapıştır
            </button>
            <button
              onClick={handleFetch}
              disabled={!url || loading}
              className="px-3 py-1.5 rounded-lg bg-gradient-button text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all shadow-lg shadow-purple-500/20"
            >
              {loading ? (
                <span className="flex items-center gap-1.5">
                  <LoadingSpinner />
                  <span className="hidden sm:inline">{FETCH_MSGS[fetchMsgIdx].replace('…', '')}</span>
                  <span className="sm:hidden">Analiz</span>
                </span>
              ) : 'Analiz Et'}
            </button>
          </div>
        </div>

        {/* Hata */}
        {error && (
          <p className="mt-2 text-red-400/90 text-xs px-1 animate-fade-in">{error}</p>
        )}
      </div>

      {/* Video Bilgisi */}
      {videoInfo && (
        <div className="animate-slide-up">
          <VideoCard
            info={videoInfo}
            selectedFormat={selectedFormat}
            onFormatChange={setSelectedFormat}
            onDownload={handleDownload}
            videoFormats={videoFormats}
            audioFormats={audioFormats}
          />
        </div>
      )}
    </div>
  )
}

function VideoCard({ info, selectedFormat, onFormatChange, onDownload, videoFormats, audioFormats }: {
  info: VideoInfo
  selectedFormat: string
  onFormatChange: (f: string) => void
  onDownload: () => void
  videoFormats: VideoFormat[]
  audioFormats: VideoFormat[]
}) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 overflow-hidden">
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="relative shrink-0 w-32 h-20 rounded-xl overflow-hidden bg-white/5">
          {info.thumbnail ? (
            <img src={info.thumbnail} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg className="text-white/20" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          )}
          {info.duration > 0 && (
            <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-medium">
              {formatDuration(info.duration)}
            </div>
          )}
        </div>

        {/* Bilgi */}
        <div className="flex-1 min-w-0">
          <h3 className="text-white text-sm font-medium leading-snug line-clamp-2 mb-1">
            {info.title}
          </h3>
          <p className="text-white/40 text-xs mb-3">{info.uploader}</p>

          {/* Format seçimi */}
          <div className="space-y-2">
            {videoFormats.length > 0 && (
              <FormatGroup
                label="Video"
                formats={videoFormats}
                selected={selectedFormat}
                onSelect={onFormatChange}
              />
            )}
            {audioFormats.length > 0 && (
              <FormatGroup
                label="Ses"
                formats={audioFormats}
                selected={selectedFormat}
                onSelect={onFormatChange}
              />
            )}
          </div>
        </div>
      </div>

      {/* İndir butonu */}
      <div className="px-4 pb-4">
        <button
          onClick={onDownload}
          disabled={!selectedFormat}
          className="w-full py-2.5 rounded-xl bg-gradient-button text-white font-semibold text-sm
            hover:opacity-90 active:scale-[0.98] transition-all duration-150
            shadow-lg shadow-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed
            flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Kuyruğa Ekle
        </button>
      </div>
    </div>
  )
}

function FormatGroup({ label, formats, selected, onSelect }: {
  label: string
  formats: VideoFormat[]
  selected: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-white/30 text-[10px] uppercase tracking-wider font-medium w-8">{label}</span>
      {formats.map((f) => (
        <button
          key={f.id}
          onClick={() => onSelect(f.id)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-150
            ${selected === f.id
              ? 'bg-gradient-button text-white shadow-sm shadow-purple-500/30'
              : 'bg-white/8 text-white/60 hover:bg-white/12 hover:text-white'
            }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  )
}

function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e || '')
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()

  return cleaned || 'Video bilgisi alınamadı'
}
