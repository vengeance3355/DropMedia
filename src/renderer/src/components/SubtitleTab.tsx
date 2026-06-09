import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { DownloadItem, SubtitleStyle, DEFAULT_SUBTITLE_STYLE } from '../types'
import { MediaJob, SubtitleRecord } from '../store/mediaJobStore'
import { JobPanel } from './ConverterTab'
import { MediaListItem } from './MediaListItem'

interface Props {
  completedItems: DownloadItem[]
  jobs: MediaJob[]
  subtitleRecords: SubtitleRecord[]
  onSubtitle: (opts: {
    inputPath: string; outputPath: string; mode: 'burn' | 'soft' | 'save'; style: SubtitleStyle
    url?: string; subtitlePath?: string; lang?: string; cookieBrowser?: string; title?: string
  }) => Promise<string>
  onCancelJob: (id: string) => void
  onDismissJob: (id: string) => void
  onRemoveSubtitle: (id: string) => void
}

const FONTS = ['Arial', 'Verdana', 'Tahoma', 'Georgia', 'Times New Roman', 'Courier New']
const POSITIONS: { id: SubtitleStyle['position']; label: string }[] = [
  { id: 'top', label: 'Üst' }, { id: 'middle', label: 'Orta' }, { id: 'bottom', label: 'Alt' }
]

type SubSource = 'auto' | 'file'
type SubtitleMode = 'none' | 'save' | 'soft' | 'burn'

export function SubtitleTab({ completedItems, jobs, subtitleRecords, onSubtitle, onCancelJob, onDismissJob, onRemoveSubtitle }: Props) {
  const videoItems = completedItems.filter(i => i.status === 'completed' && i.outputPath && !['mp3', 'm4a', 'aac'].includes(i.selectedFormat))
  const subtitledItems = subtitleRecords.map(rec => subtitleRecordToItem(rec, completedItems))
  const [style, setStyle]               = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE)
  const [downloadMode, setDownloadMode] = useState<SubtitleMode>('none')
  const [cookieBrowser, setCookieBrowser] = useState<string | undefined>(undefined)

  const [inputPath, setInputPath]       = useState('')
  const [selectedItemId, setSelectedItemId] = useState('')
  const [subSource, setSubSource]       = useState<SubSource>('auto')
  const [subFilePath, setSubFilePath]   = useState('')
  const [lang, setLang]                 = useState('auto')
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedItemId && videoItems.length > 0) {
      handleSelectHistory(videoItems[0].id)
    }
  }, [videoItems.length])

  useEffect(() => {
    window.api.getSettings().then(s => {
      const st = s as Record<string, unknown>
      if (st.subtitleStyle) setStyle({ ...DEFAULT_SUBTITLE_STYLE, ...(st.subtitleStyle as Partial<SubtitleStyle>) })
      const mode = normalizeSubtitleMode(st.subtitleMode, st.subtitles, st.embedSubs)
      setDownloadMode(mode)
      if (st.subtitleMode !== mode || st.embedSubs || st.subtitles) {
        persist('subtitleMode', mode)
        persist('embedSubs', false)
        persist('subtitles', false)
      }
      setLang((st.subtitleLang as string) ?? 'auto')
      setCookieBrowser(st.cookieBrowser as string | undefined)
    }).catch(() => {})
  }, [])

  function persist(key: string, value: unknown) {
    window.api.setSetting(key, value).catch(() => {})
  }

  function updateStyle(patch: Partial<SubtitleStyle>) {
    const next = { ...style, ...patch }
    setStyle(next)
    persist('subtitleStyle', next)
  }

  function setSubtitleMode(mode: SubtitleMode) {
    setDownloadMode(mode)
    persist('subtitleMode', mode)
    persist('embedSubs', false)
    persist('subtitles', false)
  }

  const job = jobs.find(j => j.id === trackedJobId && j.kind === 'subtitle')
    ?? jobs.find(j => j.kind === 'subtitle')
  const showJob = job && (job.status === 'running' || job.id === trackedJobId)
  const selectedItem = videoItems.find(item => item.id === selectedItemId)
  const sourceUrl = selectedItem?.url

  const canFetchAuto = subSource === 'auto' && !!inputPath && !!sourceUrl
  const hasSubSource = subSource === 'file' ? !!subFilePath : canFetchAuto
  const canApply = !!inputPath && hasSubSource

  function handleSelectHistory(id: string) {
    const item = videoItems.find(i => i.id === id)
    setSelectedItemId(id)
    if (item?.outputPath) setInputPath(item.outputPath)
  }

  async function handleBrowseSub() {
    const path = await window.api.selectFile([{ name: 'Altyazı', extensions: ['srt', 'vtt', 'ass'] }])
    if (path) setSubFilePath(path)
  }

  async function handleApply() {
    if (!inputPath) return
    const outputPath = inputPath.replace(/\.[^.]+$/, '.subtitled.mp4')
    const title = selectedItem?.videoInfo?.title || inputPath.replace(/.*[\\/]/, '')
    const id = await onSubtitle({
      inputPath, outputPath, mode: 'burn', style,
      url: subSource === 'auto' ? sourceUrl : undefined,
      subtitlePath: subSource === 'file' ? subFilePath : undefined,
      lang, cookieBrowser, title
    })
    setTrackedJobId(id)
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      {/* İndirme davranışı */}
      <div className="glass rounded-2xl p-4 space-y-3 shadow-glow">
        <p className="text-white/55 text-xs uppercase tracking-wider font-semibold">İndirme sırasında altyazı</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { id: 'none', label: 'Altyazı yok', desc: 'Normal indirme, otomatik deneme yok' },
            { id: 'save', label: 'Sidecar .srt', desc: 'Videonun yanına altyazı dosyası' },
            { id: 'soft', label: 'Embed', desc: 'Mümkünse dosya içine göm' },
            { id: 'burn', label: 'Burn-in', desc: 'Videoya yak, stil uygula' }
          ].map(m => (
            <button
              key={m.id}
              onClick={() => setSubtitleMode(m.id as SubtitleMode)}
              className={`relative rounded-2xl border p-3 text-left transition-all duration-150 ${
                downloadMode === m.id
                  ? 'border-violet-400/60 bg-gradient-to-br from-violet-600/35 via-purple-600/20 to-blue-600/20 text-white shadow-[0_0_24px_rgba(124,58,237,0.22)]'
                  : 'border-white/8 bg-white/[0.03] text-white/45 hover:border-white/12 hover:bg-white/[0.05] hover:text-white/65'
              }`}
            >
              <span className="block pr-6 text-sm font-semibold">{m.label}</span>
              <small className="mt-1 block text-[11px] leading-snug text-white/35">{m.desc}</small>
              {downloadMode === m.id && (
                <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-white text-violet-600 shadow-sm">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="text-white/25 text-[11px] leading-relaxed">
          Varsayılan kapalıdır. Altyazı yalnızca burada açıkça seçilirse indirme sonrası ayrı iş olarak çalışır.
        </p>
      </div>

      {/* Stil + canlı önizleme */}
      <div className="glass rounded-2xl p-4 space-y-4 shadow-glow">
        <p className="text-white/55 text-xs uppercase tracking-wider font-semibold">Altyazı Stili (videoya yakma)</p>

        <SubtitlePreview style={style} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-white/40 text-[11px] mb-1">Yazı tipi</p>
            <select value={style.fontName} onChange={e => updateStyle({ fontName: e.target.value })}
              className="w-full bg-white/8 border border-white/10 rounded-lg px-2 py-1.5 text-white/70 text-xs outline-none">
              {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <p className="text-white/40 text-[11px] mb-1">Boyut: {style.fontSize}</p>
            <input type="range" min="12" max="48" step="1" value={style.fontSize}
              onChange={e => updateStyle({ fontSize: parseInt(e.target.value, 10) })} className="w-full accent-purple-500" />
          </div>
        </div>

        <div>
          <p className="text-white/40 text-[11px] mb-1">Konum</p>
          <div className="flex gap-2">
            {POSITIONS.map(p => (
              <button key={p.id} onClick={() => updateStyle({ position: p.id })}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${style.position === p.id ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12 hover:text-white'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Yazı rengi" value={style.textColor} onChange={c => updateStyle({ textColor: c })} />
          <ColorField label="Arka plan rengi" value={style.bgColor} onChange={c => updateStyle({ bgColor: c })} />
        </div>

        <div>
          <p className="text-white/40 text-[11px] mb-1">Arka plan opaklığı: {Math.round(style.bgOpacity * 100)}%</p>
          <input type="range" min="0" max="100" step="5" value={Math.round(style.bgOpacity * 100)}
            onChange={e => updateStyle({ bgOpacity: parseInt(e.target.value, 10) / 100 })} className="w-full accent-purple-500" />
        </div>
      </div>

      {/* Videoya uygula */}
      <div className="bg-[#16161A] border border-white/[0.06] rounded-xl p-4">
        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Videoya Uygula</p>
        <div className="flex gap-1 mb-4 p-1 bg-[#1E1E25] rounded-xl w-fit">
          <span className="px-3 py-1 rounded-lg text-xs font-medium bg-white/10 text-white">
            Geçmişten Seç {videoItems.length > 0 && <span className="ml-1 text-white/30">({videoItems.length})</span>}
          </span>
        </div>
        {videoItems.length === 0 ? (
          <p className="text-white/30 text-sm text-center py-4">Henüz tamamlanan video yok</p>
        ) : (
          <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-thin pr-1">
            {videoItems.map(item => (
              <button
                key={item.id}
                onClick={() => handleSelectHistory(item.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left transition-all ${
                  selectedItemId === item.id
                    ? 'border-violet-500/35 bg-violet-600/15'
                    : 'border-transparent hover:border-white/8 hover:bg-white/[0.04]'
                }`}
              >
                <MediaListItem item={item} compact />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bg-[#16161A] border border-white/[0.06] rounded-xl p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-white/40 text-[11px]">Altyazı Eklenenler</p>
          <span className="text-white/25 text-[10px]">{subtitleRecords.length}</span>
        </div>
        {subtitleRecords.length === 0 ? (
          <p className="text-white/30 text-sm text-center py-3">Henüz altyazı eklenen video yok</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin pr-1">
            {subtitleRecords.map((rec, index) => (
              <div key={rec.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-white/5 group">
                <MediaListItem item={subtitledItems[index]} compact />
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <OpenActionButton path={rec.outputPath} action="file" title="Oynat"
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </OpenActionButton>
                  <button draggable
                    onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', rec.outputPath); window.api.startFileDrag(rec.outputPath).catch(() => {}) }}
                    onClick={e => e.preventDefault()} title="Sürükleyerek paylaş"
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all cursor-grab">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </button>
                  <OpenActionButton path={rec.outputPath} action="folder" title="Klasörde göster"
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </OpenActionButton>
                  <button onClick={() => onRemoveSubtitle(rec.id)} title="Listeden kaldır"
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-white/8 transition-all">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <span className="text-white/20 text-[10px] shrink-0">{new Date(rec.subtitledAt).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <>
          <div className="pt-1">
            <p className="text-white/40 text-[11px] mb-1.5">Altyazı kaynağı</p>
            <div className="flex gap-2 mb-2">
              <button onClick={() => setSubSource('auto')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${subSource === 'auto' ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12'}`}>
                Otomatik indir
              </button>
              <button onClick={() => setSubSource('file')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${subSource === 'file' ? 'bg-gradient-button text-white' : 'bg-white/8 text-white/50 hover:bg-white/12'}`}>
                Altyazı dosyası seç
              </button>
            </div>
            {subSource === 'auto' ? (
              <div className="flex items-center gap-2">
                <span className="text-white/40 text-[11px]">Dil:</span>
                {[{ id: 'auto', label: 'Otomatik' }, { id: 'tr', label: 'TR' }, { id: 'en', label: 'EN' }].map(l => (
                  <button key={l.id} onClick={() => { setLang(l.id); persist('subtitleLang', l.id) }}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${lang === l.id ? 'bg-white/15 text-white' : 'bg-white/8 text-white/50 hover:text-white'}`}>
                    {l.label}
                  </button>
                ))}
                {!inputPath && <span className="text-amber-400/70 text-[11px] ml-1">Önce video seçin</span>}
                {inputPath && !sourceUrl && <span className="text-amber-400/70 text-[11px] ml-1">Otomatik için geçmişten seçin</span>}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/8 text-white/60 text-xs truncate">{subFilePath ? subFilePath.split('/').pop() : <span className="text-white/30">Altyazı seçilmedi</span>}</div>
                <button onClick={handleBrowseSub} className="px-3 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/60 hover:text-white text-xs font-medium transition-all shrink-0">Gözat</button>
              </div>
            )}
          </div>

          {showJob && job ? (
            <JobPanel job={job} onCancel={onCancelJob} onDismiss={() => { onDismissJob(job.id); setTrackedJobId(null) }} />
          ) : (
            <motion.button onClick={handleApply} disabled={!canApply} whileHover={{ y: -1 }} whileTap={{ scale: 0.99 }}
              className="w-full py-3 rounded-2xl bg-gradient-button text-white font-semibold text-sm hover:opacity-90 active:scale-[0.99] transition-all duration-150 shadow-lg shadow-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10h10M7 14h6"/></svg>
              Altyazıyı videoya yak
            </motion.button>
          )}
      </>
    </motion.div>
  )
}

function subtitleRecordToItem(rec: SubtitleRecord, completedItems: DownloadItem[]): DownloadItem {
  const match = completedItems.find(item => {
    const title = item.videoInfo?.title || ''
    const inputName = rec.inputName || ''
    return title === rec.title || title === inputName || item.outputPath?.includes(inputName)
  })

  return {
    ...(match ?? {
      id: rec.id,
      url: rec.outputPath,
      selectedFormat: rec.outputPath.split('.').pop()?.toLowerCase() || 'mp4',
      status: 'completed' as const,
      progress: 100,
      speed: '',
      eta: '',
      totalSize: ''
    }),
    id: rec.id,
    outputPath: rec.outputPath,
    videoInfo: match?.videoInfo
      ? { ...match.videoInfo, title: rec.title || match.videoInfo.title }
      : undefined,
    completedAt: rec.subtitledAt
  }
}

// Preview container is fixed at max 480×270px so font sizing is consistent
// regardless of window size. Scale = fontSize * (270 / PlayResY) where
// PlayResY=288 is ffmpeg libass default for SRT→ASS conversion.
const PREVIEW_H = 270
const PLAY_RES_Y = 288

function OpenActionButton({ path, action, title, className, children }: {
  path?: string
  action: 'file' | 'folder'
  title: string
  className: string
  children: React.ReactNode
}) {
  const [opening, setOpening] = useState(false)

  async function handleClick() {
    if (!path || opening) return
    setOpening(true)
    try {
      if (action === 'file') await window.api.openFileInPlayer(path)
      else await window.api.showItemInFolder(path)
    } finally {
      setOpening(false)
    }
  }

  return (
    <button onClick={handleClick} disabled={!path || opening} title={title}
      className={`${className} disabled:cursor-wait disabled:opacity-40`}>
      {children}
    </button>
  )
}

function SubtitlePreview({ style, thumbnail }: { style: SubtitleStyle; thumbnail?: string }) {
  const justify = style.position === 'top' ? 'flex-start' : style.position === 'middle' ? 'center' : 'flex-end'
  const bgRgba = hexToRgba(style.bgColor, style.bgOpacity)
  const fontPx = Math.round(style.fontSize * PREVIEW_H / PLAY_RES_Y)

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mx-auto rounded-xl overflow-hidden border border-white/10 bg-black relative shadow-glow"
      style={{ width: '100%', maxWidth: 480, aspectRatio: '16 / 9' }}>
      <div className="absolute inset-0 bg-gradient-to-br from-purple-600 to-blue-500" />
      {thumbnail && <img src={thumbnail} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" onError={e => { e.currentTarget.style.display = 'none' }} />}
      <div className="absolute inset-0 flex flex-col px-4 py-3" style={{ justifyContent: justify, alignItems: 'center' }}>
        <span
          style={{
            fontFamily: style.fontName,
            fontSize: `${fontPx}px`,
            color: style.textColor,
            backgroundColor: bgRgba,
            padding: style.bgOpacity > 0.02 ? '2px 8px' : '0',
            borderRadius: 4,
            lineHeight: 1.3,
            textAlign: 'center',
            textShadow: style.bgOpacity > 0.02 ? 'none' : '0 1px 2px rgba(0,0,0,0.9)',
            maxWidth: '90%'
          }}
        >
          Örnek altyazı metni
        </span>
      </div>
    </motion.div>
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function normalizeSubtitleMode(value: unknown, subtitles?: unknown, embedSubs?: unknown): SubtitleMode {
  if (value === 'save' || value === 'soft' || value === 'burn') return value
  if (subtitles) return embedSubs ? 'soft' : 'save'
  return 'none'
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div>
      <p className="text-white/40 text-[11px] mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          className="w-8 h-8 rounded-lg bg-transparent border border-white/10 cursor-pointer p-0.5" />
        <span className="text-white/50 text-xs font-mono">{value.toUpperCase()}</span>
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} aria-pressed={checked} className="w-full flex items-center justify-between cursor-pointer group text-left rounded-xl px-2 py-1.5 hover:bg-white/5 transition-colors">
      <span className="text-white/60 text-sm group-hover:text-white/80 transition-colors">{label}</span>
      <span style={{ width: 40, height: 22 }} className={`relative shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-gradient-button' : 'bg-white/15'}`}>
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200" style={{ transform: checked ? 'translateX(18px)' : 'translateX(0)' }} />
      </span>
    </button>
  )
}
