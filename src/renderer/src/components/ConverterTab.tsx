import { useEffect, useState } from 'react'
import { DownloadItem } from '../types'
import { MediaJob, ConvertedRecord } from '../store/mediaJobStore'
import { MediaListItem } from './MediaListItem'

interface Props {
  completedItems: DownloadItem[]
  jobs: MediaJob[]
  convertedRecords: ConvertedRecord[]
  onConvert: (opts: { inputPath: string; outputFormat: string; outputPath: string; title: string }) => Promise<string>
  onCancelJob: (id: string) => void
  onDismissJob: (id: string) => void
  onRemoveConverted: (id: string) => void
}

const OUTPUT_FORMATS = [
  { id: 'mp3',  label: 'MP3',  desc: 'Ses' },
  { id: 'm4a',  label: 'M4A',  desc: 'Ses' },
  { id: 'flac', label: 'FLAC', desc: 'Kayıpsız' },
  { id: 'wav',  label: 'WAV',  desc: 'Ham' },
  { id: 'mp4',  label: 'MP4',  desc: 'Video' },
  { id: 'webm', label: 'WEBM', desc: 'Video' },
  { id: 'mkv',  label: 'MKV',  desc: 'Video' },
]

type SourceMode = 'history' | 'file' | 'converted'

export function ConverterTab({ completedItems, jobs, convertedRecords, onConvert, onCancelJob, onDismissJob, onRemoveConverted }: Props) {
  const itemsWithPath = completedItems.filter(i => i.status === 'completed' && i.outputPath)

  const [sourceMode, setSourceMode]     = useState<SourceMode>(itemsWithPath.length > 0 ? 'history' : 'file')
  const [selectedItem, setSelectedItem] = useState<DownloadItem | null>(itemsWithPath[0] ?? null)
  const [customPath, setCustomPath]     = useState('')
  const [outputFormat, setOutputFormat] = useState('mp3')
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null)

  const job = jobs.find(j => j.id === trackedJobId && j.kind === 'convert')
    ?? jobs.find(j => j.kind === 'convert')

  // Tamamlanan öğeler değişince history modunda ilk geçerli öğeyi seç
  useEffect(() => {
    if (sourceMode === 'history' && !selectedItem && itemsWithPath.length > 0) {
      setSelectedItem(itemsWithPath[0])
    }
  }, [itemsWithPath.length])

  const inputPath = sourceMode === 'history' ? selectedItem?.outputPath : customPath

  async function handleBrowse() {
    const path = await window.api.selectFile()
    if (path) setCustomPath(path)
  }

  async function handleConvert() {
    if (!inputPath) return
    const outputPath = inputPath.replace(/\.[^.]+$/, `.${outputFormat}`)
    const title = sourceMode === 'history'
      ? (selectedItem?.videoInfo?.title || inputPath.replace(/.*[\\/]/, ''))
      : inputPath.replace(/.*[\\/]/, '')
    const id = await onConvert({ inputPath, outputFormat, outputPath, title })
    setTrackedJobId(id)
  }

  const inputExt  = inputPath ? inputPath.split('.').pop()?.toLowerCase() : null
  const sameFormat = inputExt === outputFormat
  const showJob = job && (job.status === 'running' || job.id === trackedJobId)

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Kaynak seçimi */}
      <div className="bg-[#16161A] border border-white/[0.06] rounded-xl p-4">
        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Kaynak</p>

        {/* Mod seçici */}
        <div className="flex gap-1 mb-4 p-1 bg-[#1E1E25] rounded-xl w-fit">
          <button
            onClick={() => setSourceMode('history')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              sourceMode === 'history' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            Geçmişten Seç {itemsWithPath.length > 0 && <span className="ml-1 text-white/30">({itemsWithPath.length})</span>}
          </button>
          <button
            onClick={() => setSourceMode('file')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              sourceMode === 'file' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            Dosya Seç
          </button>
          <button
            onClick={() => setSourceMode('converted')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              sourceMode === 'converted' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            Dönüştürüldü {convertedRecords.length > 0 && <span className="ml-1 text-white/30">({convertedRecords.length})</span>}
          </button>
        </div>

        {/* Geçmiş listesi */}
        {sourceMode === 'history' && (
          itemsWithPath.length === 0 ? (
            <p className="text-white/30 text-sm text-center py-4">Henüz tamamlanan indirme yok</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-thin pr-1">
              {itemsWithPath.map(item => (
                <button
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-all ${
                    selectedItem?.id === item.id
                      ? 'border-violet-500/35 bg-violet-600/15'
                      : 'border-transparent hover:border-white/8 hover:bg-white/[0.04]'
                  }`}
                >
                  <MediaListItem item={item} compact />
                </button>
              ))}
            </div>
          )
        )}

        {sourceMode === 'converted' && (
          convertedRecords.length === 0 ? (
            <p className="text-white/30 text-sm text-center py-4">Henüz dönüştürülen dosya yok</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin pr-1">
              {convertedRecords.map(rec => (
                <div key={rec.id} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-[#1E1E25] group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold text-purple-400 bg-purple-500/15 px-1.5 py-0.5 rounded shrink-0">{rec.format}</span>
                      <p className="text-white/70 text-xs font-medium truncate">{rec.title || rec.inputName}</p>
                    </div>
                    <p className="text-white/25 text-[10px] truncate mt-0.5">{rec.outputPath.replace(/.*[\\/]/, '')}</p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => window.api.openFileInPlayer(rec.outputPath)} title="Oynat"
                      className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </button>
                    <button draggable
                      onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', rec.outputPath); window.api.startFileDrag(rec.outputPath).catch(() => {}) }}
                      onClick={e => e.preventDefault()} title="Sürükleyerek paylaş"
                      className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all cursor-grab">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </button>
                    <button onClick={() => window.api.showItemInFolder(rec.outputPath)} title="Klasörde göster"
                      className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    </button>
                    <button onClick={() => onRemoveConverted(rec.id)} title="Listeden kaldır"
                      className="w-6 h-6 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-white/8 transition-all">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  </div>
                  <span className="text-white/20 text-[10px] shrink-0">{new Date(rec.convertedAt).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          )
        )}

        {/* Dosya seçici */}
        {sourceMode === 'file' && (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/8 min-w-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/30 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span className="text-sm truncate min-w-0 flex-1 text-white/60">
                {customPath ? customPath.split('/').pop() : <span className="text-white/30">Dosya seçilmedi</span>}
              </span>
            </div>
            <button onClick={handleBrowse}
              className="px-3 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/60 hover:text-white text-xs font-medium transition-all shrink-0">
              Gözat
            </button>
          </div>
        )}
      </div>

      {/* Format seçimi */}
      {sourceMode !== 'converted' && <div className="bg-[#16161A] border border-white/[0.06] rounded-xl p-4">
        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Çıktı Formatı</p>
        <div className="flex flex-wrap gap-2">
          {OUTPUT_FORMATS.map(f => (
            <button
              key={f.id}
              onClick={() => setOutputFormat(f.id)}
              className={`flex flex-col items-center px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                outputFormat === f.id
                  ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/30'
                  : 'bg-[#1E1E25] text-zinc-400 hover:bg-[#252530] hover:text-zinc-200'
              }`}
            >
              <span>{f.label}</span>
              <span className={`text-[10px] mt-0.5 ${outputFormat === f.id ? 'text-white/70' : 'text-white/30'}`}>{f.desc}</span>
            </button>
          ))}
        </div>
      </div>}

      {/* Dönüştür butonu + progress */}
      {sourceMode !== 'converted' && (showJob && job ? (
        <JobPanel job={job} onCancel={onCancelJob} onDismiss={() => { onDismissJob(job.id); setTrackedJobId(null) }} />
      ) : (
        <button
          onClick={handleConvert}
          disabled={!inputPath || sameFormat}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-semibold text-sm
            active:scale-[0.99] transition-all duration-150
            shadow-lg shadow-violet-500/25 disabled:opacity-40 disabled:cursor-not-allowed
            flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          {sameFormat ? `Kaynak zaten ${outputFormat.toUpperCase()}` : `${outputFormat.toUpperCase()} formatına dönüştür`}
        </button>
      ))}
    </div>
  )
}

export function JobPanel({ job, onCancel, onDismiss }: { job: MediaJob; onCancel: (id: string) => void; onDismiss: () => void }) {
  if (job.status === 'running') {
    return (
      <div className="bg-[#16161A] border border-white/[0.06] rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-purple-400 animate-pulse">{job.message || 'İşleniyor…'}</span>
          <div className="flex items-center gap-3">
            <span className="text-white/30">{job.percent != null ? `${job.percent}%` : ''}</span>
            <button onClick={() => onCancel(job.id)} className="text-white/30 hover:text-red-400 transition-colors">İptal</button>
          </div>
        </div>
        <div className="h-1.5 bg-[#252530] rounded-full overflow-hidden">
          {job.percent != null ? (
            <div className="h-full animate-shimmer rounded-full transition-all duration-700" style={{ width: `${job.percent}%` }} />
          ) : (
            <div className="h-full w-1/3 animate-shimmer rounded-full" />
          )}
        </div>
        <p className="text-white/20 text-[10px] truncate">{job.title}</p>
      </div>
    )
  }

  if (job.status === 'done') {
    return (
      <div className="rounded-2xl p-4 border bg-green-500/10 border-green-500/20 space-y-3">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <span className="text-green-400 text-sm font-medium">İşlem tamamlandı</span>
        </div>
        <p className="text-white/40 text-xs truncate">{job.outputPath?.split('/').pop()}</p>
        <div className="flex gap-2">
          <button onClick={() => job.outputPath && window.api.openFileInPlayer(job.outputPath)}
            className="flex-1 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-xs font-medium transition-all">
            Oynat
          </button>
          <button onClick={() => job.outputPath && window.api.showItemInFolder(job.outputPath)}
            className="flex-1 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-xs font-medium transition-all">
            Klasörde Göster
          </button>
          <button onClick={onDismiss}
            className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/40 hover:text-white text-xs transition-all">
            Yeni
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-4 border bg-red-500/10 border-red-500/20 space-y-2">
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span className="text-red-400 text-sm font-medium">{job.status === 'cancelled' ? 'İptal edildi' : 'İşlem başarısız'}</span>
      </div>
      {job.error && <p className="text-red-400/70 text-xs">{job.error}</p>}
      <button onClick={onDismiss}
        className="mt-1 px-4 py-1.5 rounded-xl bg-white/8 hover:bg-white/12 text-white/60 text-xs transition-all">
        Tamam
      </button>
    </div>
  )
}
