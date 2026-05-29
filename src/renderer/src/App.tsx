import { useEffect, useRef, useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { TitleBar } from './components/TitleBar'
import { UrlInput } from './components/UrlInput'
import { DownloadQueue } from './components/DownloadQueue'
import { Settings } from './components/Settings'
import { UpdateBanner } from './components/UpdateBanner'
import { useDownloadStore } from './store/downloadStore'
import { DownloadItem, VideoInfo } from './types'
import { detectPlatform } from './utils/platform'

type Tab = 'queue' | 'history' | 'stats'

// Tamamlanma sesi (kısa bip — base64 data URL)
const COMPLETION_BEEP = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

export default function App() {
  const { items, addItem, updateStatus, updateProgress, removeItem, clearCompleted } = useDownloadStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeTab, setActiveTab]       = useState<Tab>('queue')
  const [downloadDir, setDownloadDir]   = useState('')
  const [isMini, setIsMini]             = useState(false)
  const [clipboardRequest, setClipboardRequest] = useState<{ id: string; url: string } | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const itemsRef = useRef(items)
  const recentClipboardUrlsRef = useRef(new Map<string, number>())
  const startingKeysRef = useRef(new Set<string>())
  useTheme()

  const activeCount = items.filter(i => i.status === 'downloading' || i.status === 'fetching').length

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // URL params — mini mod
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setIsMini(params.get('mini') === '1')
  }, [])

  // IPC listener'ları
  useEffect(() => {
    window.api.getSetting('downloadDir').then(dir => {
      if (dir) setDownloadDir(dir as string)
      else window.api.getDownloadsFolder().then(setDownloadDir)
    })

    window.api.onDownloadProgress(data => {
      const d = data as { id: string; percent: number; speed: string; eta: string; totalSize: string }
      updateProgress(d.id, d.percent, d.speed, d.eta, d.totalSize)
    })

    window.api.onDownloadComplete(async data => {
      const d = data as { id: string; success: boolean; cancelled?: boolean; error?: string; outputPath?: string; outputDir?: string }
      if (d.cancelled) {
        updateStatus(d.id, 'cancelled', { error: undefined, speed: '', eta: '' })
        return
      }

      updateStatus(d.id, d.success ? 'completed' : 'error', {
        error: d.success ? undefined : (d.error || 'İndirme tamamlanamadı. Ayrıntılar admin loguna kaydedildi.'),
        outputPath: d.outputPath,
        outputDir: d.outputDir,
        completedAt: d.success ? Date.now() : undefined,
        speed: '',
        eta: ''
      })

      // Tamamlanma sesi
      const soundEnabled = await window.api.getSetting('completionSound')
      if (d.success && soundEnabled && audioRef.current) {
        audioRef.current.play().catch(() => {})
      }

      // Sistem bildirimi
      const notifEnabled = await window.api.getSetting('showNotifications')
      if (d.success && notifEnabled && 'Notification' in window && Notification.permission === 'granted') {
        const item = itemsRef.current.find(i => i.id === d.id)
        new Notification('DropMedia', { body: `İndirme tamamlandı: ${item?.videoInfo?.title ?? ''}` })
      }
    })

    window.api.onDownloadPaused(data => {
      const d = data as { id: string }
      updateStatus(d.id, 'paused', { speed: '', eta: '' })
    })

    // Clipboard URL algılama
    window.api.onClipboardUrl((url: string) => {
      handleDetectedUrl(url)
    })

    // Clipboard kısayol tuşu — arka planda indir, pencere öne gelmesin
    window.api.onClipboardShortcut((url: string) => {
      handleShortcutDownload(url)
    })

    return () => {
      window.api.offDownloadListeners()
      window.api.offClipboardListeners()
    }
  }, [updateProgress, updateStatus])

  // Tray sayacını güncelle
  useEffect(() => {
    window.api.updateTrayCount(activeCount)
  }, [activeCount])

  // Bildirim izni iste
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Clipboard toast
  const [clipboardToast, setClipboardToast] = useState<{ url: string; id: string } | null>(null)

  function handleDetectedUrl(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url) return
    const key = normalizeUrlForUi(url)
    const lastSeen = recentClipboardUrlsRef.current.get(key) ?? 0
    if (Date.now() - lastSeen < 10_000) return
    if (itemsRef.current.some(i => normalizeUrlForUi(i.url) === key)) return

    recentClipboardUrlsRef.current.set(key, Date.now())
    const id = Math.random().toString(36).slice(2)
    setClipboardToast({ url, id })
    setClipboardRequest({ url, id })
    setActiveTab('queue')
    setTimeout(() => setClipboardToast(null), 5000)
  }

  async function handleShortcutDownload(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url) return
    const key = normalizeUrlForUi(url)
    if (itemsRef.current.some(i =>
      normalizeUrlForUi(i.url) === key &&
      ['downloading', 'fetching', 'pending', 'paused'].includes(i.status)
    )) return

    try {
      const info = await window.api.fetchInfo(url) as VideoInfo
      const settings = await window.api.getSettings() as Record<string, unknown>
      const profiles = (settings['profiles'] as Record<string, string> | undefined) ?? {}
      const platform = (info as unknown as Record<string, string>).platform ?? ''
      const profileFormat = profiles[platform]
      const format = profileFormat
        ? (info.formats.find(f => f.id === profileFormat) ? profileFormat : info.formats[0]?.id)
        : info.formats[0]?.id
      if (!format) return
      await handleDownload(url, format, info, { force: false })
    } catch { /* sessiz hata — pencere açmadan arka planda çalışıyor */ }
  }

  async function handleDownload(url: string, format: string, videoInfo: VideoInfo, opts: { force?: boolean } = {}): Promise<boolean> {
    const key = downloadKey(url, format)
    if (!opts.force && (startingKeysRef.current.has(key) || findActiveDuplicate(url, format))) {
      setActiveTab('queue')
      return false
    }

    startingKeysRef.current.add(key)
    try {
      const dir = downloadDir || await window.api.getDownloadsFolder()
      const id = addItem(url, format, videoInfo, { status: 'downloading', outputDir: dir, error: undefined })
      return await startDownloadItem({ id, url, selectedFormat: format, videoInfo, outputDir: dir, status: 'downloading', progress: 0, speed: '', eta: '', totalSize: '' } as DownloadItem, 'start')
    } catch {
      return false
    } finally {
      setTimeout(() => startingKeysRef.current.delete(key), 500)
    }
  }

  async function startDownloadItem(item: DownloadItem, mode: 'start' | 'resume'): Promise<boolean> {
    try {
      const settings = await window.api.getSettings() as Record<string, unknown>
      const dir = (settings['downloadDir'] as string | undefined) || item.outputDir || downloadDir || await window.api.getDownloadsFolder()
      updateStatus(item.id, 'downloading', { outputDir: dir, error: undefined })

      const request = {
        id: item.id, url: item.url, format: item.selectedFormat, outputDir: dir,
        title:         item.videoInfo?.title,
        speedLimit:    settings['speedLimit'] as number | undefined,
        useTor:        settings['torEnabled'] as boolean | undefined,
        subtitles:     settings['subtitles'] as boolean | undefined,
        embedSubs:     settings['embedSubs'] as boolean | undefined,
        cookieBrowser: settings['cookieBrowser'] as string | undefined
      }
      const result = await (mode === 'resume'
        ? window.api.resumeDownload(request)
        : window.api.startDownload(request)) as { started: boolean; error?: string }

      if (!result.started) {
        updateStatus(item.id, 'error', { error: result.error || 'İndirme başlatılamadı. Ayrıntılar admin loguna kaydedildi.' })
        return false
      }
      return true
    } catch {
      updateStatus(item.id, 'error', { error: 'İndirme başlatılamadı. Ayrıntılar admin loguna kaydedildi.' })
      return false
    }
  }

  function findActiveDuplicate(url: string, format: string, ignoreId?: string) {
    const key = downloadKey(url, format)
    return itemsRef.current.find(item => {
      if (item.id === ignoreId) return false
      if (!['pending', 'fetching', 'downloading', 'paused'].includes(item.status)) return false
      return downloadKey(item.url, item.selectedFormat) === key
    })
  }

  async function handlePause(id: string) {
    const ok = await window.api.pauseDownload(id)
    if (ok) updateStatus(id, 'paused', { speed: '', eta: '' })
  }

  async function handleResume(item: DownloadItem) {
    if (findActiveDuplicate(item.url, item.selectedFormat, item.id)) {
      setActiveTab('queue')
      return
    }
    await startDownloadItem(item, 'resume')
  }

  async function handleRedownload(item: DownloadItem) {
    let videoInfo = item.videoInfo
    if (!videoInfo) {
      try {
        videoInfo = await window.api.fetchInfo(item.url)
      } catch {
        updateStatus(item.id, 'error', { error: 'Video bilgisi alınamadı. Bağlantıyı tekrar analiz edin.' })
        return
      }
    }
    await handleDownload(item.url, item.selectedFormat, videoInfo, { force: true })
    setActiveTab('queue')
  }

  function handleConvertDone(id: string, newPath: string) {
    updateStatus(id, 'completed', { outputPath: newPath })
  }

  async function handleShowItemInFolder(item: DownloadItem) {
    if (item.outputPath) {
      await window.api.showItemInFolder(item.outputPath)
      return
    }
    await handleOpenFolder(item.outputDir)
  }

  function downloadKey(url: string, format: string) {
    return `${normalizeUrlForUi(url)}::${format}`
  }

  function normalizeUrlForUi(rawUrl: string) {
    try {
      const parsed = new URL(rawUrl)
      parsed.hash = ''
      parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase()
      if (parsed.hostname === 'youtube.com' && parsed.pathname === '/watch') {
        const id = parsed.searchParams.get('v')
        return id ? `https://youtube.com/watch?v=${id}` : parsed.toString()
      }
      if (parsed.hostname === 'youtu.be') return `https://youtu.be${parsed.pathname}`
      const params = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
      parsed.search = ''
      for (const [name, value] of params) parsed.searchParams.append(name, value)
      return parsed.toString()
    } catch {
      return rawUrl.trim()
    }
  }

  async function handleCancel(id: string) {
    await window.api.cancelDownload(id)
    updateStatus(id, 'cancelled')
  }

  async function handleOpenFolder(path?: string) {
    const folder = path || downloadDir
    if (folder) window.api.openFolder(folder)
  }

  const queueItems   = items.filter(i => i.status !== 'completed' && i.status !== 'error' && i.status !== 'cancelled')
  const historyItems = items.filter(i => i.status === 'completed' || i.status === 'error' || i.status === 'cancelled')

  // İstatistik hesaplama
  const stats = {
    total:     historyItems.filter(i => i.status === 'completed').length,
    platforms: historyItems.reduce((acc, i) => {
      if (i.status !== 'completed') return acc
      const p = detectPlatform(i.url).name
      acc[p] = (acc[p] ?? 0) + 1
      return acc
    }, {} as Record<string, number>),
    formats: historyItems.reduce((acc, i) => {
      if (i.status !== 'completed') return acc
      acc[i.selectedFormat] = (acc[i.selectedFormat] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
  }

  if (isMini) return <MiniMode items={queueItems} activeCount={activeCount} onExpand={() => { setIsMini(false); window.api.closeMiniWindow() }} />

  return (
    <>
      <audio ref={audioRef} src={COMPLETION_BEEP} />

      {/* Arkaplan */}
      <div className="fixed inset-0 bg-gradient-dark pointer-events-none">
        <div className="absolute top-[-10%] left-[-5%] w-72 h-72 rounded-full bg-purple-600/20 blur-[80px]" />
        <div className="absolute top-[30%] right-[-5%] w-64 h-64 rounded-full bg-blue-600/15 blur-[80px]" />
        <div className="absolute bottom-[-5%] left-[30%] w-80 h-80 rounded-full bg-indigo-600/10 blur-[100px]" />
      </div>

      <div className="relative flex flex-col h-screen text-white overflow-hidden">
        <TitleBar />
        <UpdateBanner />

        {/* Clipboard toast */}
        {clipboardToast && (
          <div className="mx-5 mt-2 flex items-center gap-3 px-4 py-3 rounded-xl bg-purple-500/15 border border-purple-500/25 animate-slide-up">
            <div className="flex-1 min-w-0">
              <p className="text-white/70 text-xs font-medium">Clipboard'dan URL algılandı</p>
              <p className="text-white/40 text-xs truncate">{clipboardToast.url}</p>
            </div>
            <button onClick={() => { setClipboardToast(null) }}
              className="text-white/40 hover:text-white/70 text-xs">✕</button>
          </div>
        )}

        <div className="px-5 pt-4 pb-2">
          <UrlInput
            onDownload={handleDownload}
            incomingUrl={clipboardRequest}
            onIncomingUrlHandled={() => setClipboardRequest(null)}
          />
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-5 pt-2 pb-3 border-b border-white/6">
          <TabBtn active={activeTab === 'queue'} onClick={() => setActiveTab('queue')}>
            Kuyruk{queueItems.length > 0 && <Badge>{queueItems.length}</Badge>}
          </TabBtn>
          <TabBtn active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
            Geçmiş{historyItems.length > 0 && <Badge muted>{historyItems.length}</Badge>}
          </TabBtn>
          <TabBtn active={activeTab === 'stats'} onClick={() => setActiveTab('stats')}>
            İstatistik
          </TabBtn>
          <div className="flex-1" />
          <button onClick={() => window.api.openMiniWindow()}
            title="Mini mod" className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/>
            </svg>
          </button>
          <button onClick={() => setSettingsOpen(true)} title="Ayarlar"
            className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>

        {/* Liste / İstatistik */}
        <div className="flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">
          {activeTab === 'queue' && (
            <DownloadQueue items={queueItems} onCancel={handleCancel} onPause={handlePause} onResume={handleResume} onRedownload={handleRedownload} onRemove={removeItem} onClearCompleted={clearCompleted} onShowItemInFolder={handleShowItemInFolder} onConvertDone={handleConvertDone} onUrlDrop={handleDetectedUrl} />
          )}
          {activeTab === 'history' && (
            <DownloadQueue items={historyItems} onCancel={handleCancel} onPause={handlePause} onResume={handleResume} onRedownload={handleRedownload} onRemove={removeItem} onClearCompleted={clearCompleted} onShowItemInFolder={handleShowItemInFolder} onConvertDone={handleConvertDone} onUrlDrop={handleDetectedUrl} />
          )}
          {activeTab === 'stats' && <StatsView stats={stats} />}
        </div>

        {activeCount > 0 && (
          <div className="px-5 py-2 border-t border-white/6 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            <span className="text-white/40 text-xs">{activeCount} indirme devam ediyor</span>
          </div>
        )}
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </>
  )
}

// ── Alt bileşenler ────────────────────────────────────────────────────────────

function MiniMode({ items, activeCount, onExpand }: {
  items: { id: string; videoInfo?: { title: string }; status: string; progress: number }[]
  activeCount: number
  onExpand: () => void
}) {
  return (
    <div className="relative h-screen flex flex-col bg-gradient-dark text-white overflow-hidden rounded-2xl">
      <div className="absolute top-[-20%] left-[-20%] w-48 h-48 rounded-full bg-purple-600/20 blur-[60px]" />
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-gradient-button flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M12 8v8M9 13l3 3 3-3"/></svg>
          </div>
          <span className="text-xs font-semibold text-white/80">DropMedia</span>
        </div>
        <button onClick={onExpand} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="text-white/40 hover:text-white text-xs">Genişlet</button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 scrollbar-thin">
        {items.length === 0
          ? <p className="text-white/20 text-xs text-center py-6">Kuyruk boş</p>
          : items.map(i => (
            <div key={i.id} className="bg-white/5 rounded-xl p-2.5">
              <p className="text-white/70 text-xs truncate">{i.videoInfo?.title ?? i.id}</p>
              {i.status === 'downloading' && (
                <div className="mt-1.5 h-1 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${i.progress}%` }} />
                </div>
              )}
            </div>
          ))
        }
      </div>
      {activeCount > 0 && (
        <div className="px-3 py-2 border-t border-white/8 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
          <span className="text-white/40 text-xs">{activeCount} aktif</span>
        </div>
      )}
    </div>
  )
}

function StatsView({ stats }: { stats: { total: number; platforms: Record<string, number>; formats: Record<string, number> } }) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Toplam İndirme</p>
          <p className="text-3xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Platform Sayısı</p>
          <p className="text-3xl font-bold text-white">{Object.keys(stats.platforms).length}</p>
        </div>
      </div>

      {Object.keys(stats.platforms).length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-3 uppercase tracking-wider">Platform Dağılımı</p>
          <div className="space-y-2">
            {Object.entries(stats.platforms).sort((a,b) => b[1]-a[1]).map(([p, n]) => (
              <div key={p} className="flex items-center gap-3">
                <span className="text-white/60 text-sm w-24 truncate capitalize">{p}</span>
                <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-button rounded-full" style={{ width: `${(n / stats.total) * 100}%` }} />
                </div>
                <span className="text-white/40 text-xs w-8 text-right">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(stats.formats).length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-3 uppercase tracking-wider">Format Dağılımı</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.formats).sort((a,b) => b[1]-a[1]).map(([f, n]) => (
              <div key={f} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/8">
                <span className="text-white/70 text-xs font-medium uppercase">{f}</span>
                <span className="text-white/30 text-xs">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.total === 0 && (
        <div className="text-center py-12">
          <p className="text-white/20 text-sm">Henüz indirme geçmişi yok</p>
        </div>
      )}
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex items-center px-3 py-1.5 rounded-xl text-sm font-medium transition-all
        ${active ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/6'}`}>
      {children}
    </button>
  )
}

function Badge({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={`ml-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold leading-none
      ${muted ? 'bg-white/10 text-white/40' : 'bg-purple-500/30 text-purple-300'}`}>
      {children}
    </span>
  )
}
