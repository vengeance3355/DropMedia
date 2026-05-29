import { useEffect, useRef, useState } from 'react'
import { DownloadItem } from '../types'

interface Props {
  completedItems: DownloadItem[]
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

const CONVERT_MSGS = [
  'ffmpeg başlatılıyor…',
  'Medya akışları okunuyor…',
  'Codec dönüşümü yapılıyor…',
  'Ses kanalları işleniyor…',
  'Çıktı dosyası yazılıyor…',
  'Son dokunuşlar yapılıyor…',
]

type SourceMode = 'history' | 'file'

export function ConverterTab({ completedItems }: Props) {
  const itemsWithPath = completedItems.filter(i => i.status === 'completed' && i.outputPath)

  const [sourceMode, setSourceMode]     = useState<SourceMode>(itemsWithPath.length > 0 ? 'history' : 'file')
  const [selectedItem, setSelectedItem] = useState<DownloadItem | null>(itemsWithPath[0] ?? null)
  const [customPath, setCustomPath]     = useState('')
  const [outputFormat, setOutputFormat] = useState('mp3')
  const [converting, setConverting]     = useState(false)
  const [progress, setProgress]         = useState(0)
  const [msgIdx, setMsgIdx]             = useState(0)
  const [result, setResult]             = useState<{ success: boolean; outputPath?: string; error?: string } | null>(null)
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // Tamamlanan öğeler değişince history modunda ilk geçerli öğeyi seç
  useEffect(() => {
    if (sourceMode === 'history' && !selectedItem && itemsWithPath.length > 0) {
      setSelectedItem(itemsWithPath[0])
    }
  }, [itemsWithPath.length])

  // Dönüşüm sırasında dönen mesajlar + sahte ilerleme
  useEffect(() => {
    if (!converting) {
      if (progressTimer.current) clearInterval(progressTimer.current)
      return
    }
    setProgress(5)
    setMsgIdx(0)
    progressTimer.current = setInterval(() => {
      setProgress(p => {
        // 90'a kadar kademeli artış, sonra bekle
        if (p >= 90) return p
        const step = p < 40 ? 8 : p < 70 ? 4 : 1
        return Math.min(p + step, 90)
      })
      setMsgIdx(i => (i + 1) % CONVERT_MSGS.length)
    }, 1200)
    return () => { if (progressTimer.current) clearInterval(progressTimer.current) }
  }, [converting])

  const inputPath = sourceMode === 'history' ? selectedItem?.outputPath : customPath

  async function handleBrowse() {
    const path = await window.api.selectFile()
    if (path) { setCustomPath(path); setResult(null) }
  }

  async function handleConvert() {
    if (!inputPath) return
    const outputPath = inputPath.replace(/\.[^.]+$/, `.${outputFormat}`)
    setConverting(true)
    setResult(null)
    try {
      const r = await window.api.convertFile({ inputPath, outputFormat, outputPath }) as { success: boolean; error?: string }
      setProgress(100)
      setTimeout(() => {
        setConverting(false)
        setResult(r.success ? { success: true, outputPath } : { success: false, error: r.error ?? 'Dönüştürme başarısız' })
      }, 300)
    } catch (e) {
      setConverting(false)
      setResult({ success: false, error: e instanceof Error ? e.message : 'Bilinmeyen hata' })
    }
  }

  function handleOpenResult() {
    if (result?.outputPath) window.api.openFileInPlayer(result.outputPath)
  }

  function handleShowResult() {
    if (result?.outputPath) window.api.showItemInFolder(result.outputPath)
  }

  function reset() {
    setResult(null)
    setProgress(0)
    setCustomPath('')
  }

  const inputExt  = inputPath ? inputPath.split('.').pop()?.toLowerCase() : null
  const sameFormat = inputExt === outputFormat

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Kaynak seçimi */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Kaynak</p>

        {/* Mod seçici */}
        <div className="flex gap-1 mb-4 p-1 bg-white/5 rounded-xl w-fit">
          <button
            onClick={() => { setSourceMode('history'); setResult(null) }}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              sourceMode === 'history' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            Geçmişten Seç {itemsWithPath.length > 0 && <span className="ml-1 text-white/30">({itemsWithPath.length})</span>}
          </button>
          <button
            onClick={() => { setSourceMode('file'); setResult(null) }}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              sourceMode === 'file' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            Dosya Seç
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
                  onClick={() => { setSelectedItem(item); setResult(null) }}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-xl transition-all ${
                    selectedItem?.id === item.id
                      ? 'bg-purple-500/15 border border-purple-500/25'
                      : 'hover:bg-white/5 border border-transparent'
                  }`}
                >
                  {item.videoInfo?.thumbnail && (
                    <img src={item.videoInfo.thumbnail} alt="" className="w-10 h-7 rounded-lg object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-white/80 text-xs font-medium truncate">
                      {item.videoInfo?.title ?? item.url}
                    </p>
                    <p className="text-white/30 text-[10px] truncate mt-0.5">
                      {item.outputPath?.split('/').pop()}
                    </p>
                  </div>
                  {selectedItem?.id === item.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-purple-400 shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </button>
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
      <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Çıktı Formatı</p>
        <div className="flex flex-wrap gap-2">
          {OUTPUT_FORMATS.map(f => (
            <button
              key={f.id}
              onClick={() => setOutputFormat(f.id)}
              className={`flex flex-col items-center px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                outputFormat === f.id
                  ? 'bg-gradient-button text-white shadow-sm shadow-purple-500/30'
                  : 'bg-white/8 text-white/60 hover:bg-white/12 hover:text-white'
              }`}
            >
              <span>{f.label}</span>
              <span className={`text-[10px] mt-0.5 ${outputFormat === f.id ? 'text-white/70' : 'text-white/30'}`}>{f.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Dönüştür butonu + progress */}
      {converting ? (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-purple-400 animate-pulse">{CONVERT_MSGS[msgIdx]}</span>
            <span className="text-white/30">{progress < 100 ? `${progress}%` : 'Tamamlandı'}</span>
          </div>
          <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-progress rounded-full transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : result ? (
        <div className={`rounded-2xl p-4 border ${
          result.success
            ? 'bg-green-500/10 border-green-500/20'
            : 'bg-red-500/10 border-red-500/20'
        }`}>
          {result.success ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <span className="text-green-400 text-sm font-medium">Dönüştürme tamamlandı</span>
              </div>
              <p className="text-white/40 text-xs truncate">{result.outputPath?.split('/').pop()}</p>
              <div className="flex gap-2">
                <button onClick={handleOpenResult}
                  className="flex-1 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-xs font-medium transition-all">
                  Oynat
                </button>
                <button onClick={handleShowResult}
                  className="flex-1 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/70 hover:text-white text-xs font-medium transition-all">
                  Klasörde Göster
                </button>
                <button onClick={reset}
                  className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/12 text-white/40 hover:text-white text-xs transition-all">
                  Yeni
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <span className="text-red-400 text-sm font-medium">Dönüştürme başarısız</span>
              </div>
              <p className="text-red-400/70 text-xs">{result.error}</p>
              <button onClick={reset}
                className="mt-1 px-4 py-1.5 rounded-xl bg-white/8 hover:bg-white/12 text-white/60 text-xs transition-all">
                Tekrar Dene
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={handleConvert}
          disabled={!inputPath || sameFormat}
          className="w-full py-3 rounded-2xl bg-gradient-button text-white font-semibold text-sm
            hover:opacity-90 active:scale-[0.99] transition-all duration-150
            shadow-lg shadow-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed
            flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          {sameFormat ? `Kaynak zaten ${outputFormat.toUpperCase()}` : `${outputFormat.toUpperCase()} formatına dönüştür`}
        </button>
      )}
    </div>
  )
}
