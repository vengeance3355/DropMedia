import { useEffect, useRef, useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { UrlInput } from './components/UrlInput'
import { DownloadQueue } from './components/DownloadQueue'
import { ConverterTab } from './components/ConverterTab'
import { SubtitleTab } from './components/SubtitleTab'
import { Settings } from './components/Settings'
import { UpdateBanner } from './components/UpdateBanner'
import { MediaListItem } from './components/MediaListItem'
import { ProductHub, type ProductHubView } from './components/ProductHub'
import { AdminPanel } from './components/AdminPanel'
import { useDownloadStore } from './store/downloadStore'
import { useMediaJobs } from './store/mediaJobStore'
import type { ConvertedRecord, SubtitleRecord } from './store/mediaJobStore'
import { DEFAULT_SUBTITLE_STYLE, DownloadItem, PostProcessRecipe, ProductHubState, VideoInfo } from './types'
import { detectPlatform } from './utils/platform'
import { isLikelyVideoUrl } from './utils/videoUrl'

type Tab = 'queue' | 'history' | 'convert' | 'subtitle' | 'stats' | 'admin' | ProductHubView
const PRODUCT_TABS: readonly ProductHubView[] = ['links', 'watch', 'library', 'automation', 'ai', 'ai-chat', 'account']

// Tamamlanma sesi (kısa bip — base64 data URL)
const COMPLETION_BEEP = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

export default function App() {
  const { items, addItem, updateStatus, updateProgress, updateLog, removeItem, clearCompleted } = useDownloadStore()
  const media = useMediaJobs()
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
      const d = data as { id: string; success: boolean; cancelled?: boolean; error?: string; outputPath?: string; outputDir?: string; thumbnailPath?: string; duration?: number }
      if (d.cancelled) {
        updateStatus(d.id, 'cancelled', { error: undefined, speed: '', eta: '' })
        return
      }

      updateStatus(d.id, d.success ? 'completed' : 'error', {
        error: d.success ? undefined : (d.error || 'İndirme tamamlanamadı. Ayrıntılar admin loguna kaydedildi.'),
        outputPath: d.outputPath,
        outputDir: d.outputDir,
        ...(d.thumbnailPath ? { thumbnailPath: d.thumbnailPath, localThumbnailPath: d.thumbnailPath } : {}),
        ...(d.duration !== undefined ? { duration: d.duration } : {}),
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

      if (d.success) {
        void runAutoRecipeAfterDownload(d)
      }
    })

    window.api.onDownloadPaused(data => {
      const d = data as { id: string }
      updateStatus(d.id, 'paused', { speed: '', eta: '' })
    })

    window.api.onDownloadLog(data => {
      const d = data as { id: string; msg: string }
      updateLog(d.id, d.msg)
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
    if (!url || !isLikelyVideoUrl(url)) return
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
    if (!url || !isLikelyVideoUrl(url)) return
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
      const thumbnailPath = videoInfo.thumbnailPath
      const initial = {
        status: 'downloading' as const,
        outputDir: dir,
        error: undefined,
        ...(thumbnailPath ? { thumbnailPath, localThumbnailPath: thumbnailPath } : {})
      }
      const id = addItem(url, format, videoInfo, initial)
      return await startDownloadItem({ id, url, selectedFormat: format, videoInfo, ...initial, progress: 0, speed: '', eta: '', totalSize: '' } as DownloadItem, 'start')
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
        subtitles:     getDownloadSubtitleMode(settings) !== 'none',
        embedSubs:     getDownloadSubtitleMode(settings) === 'soft',
        cookieBrowser: settings['cookieBrowser'] as string | undefined,
        thumbnail:     item.videoInfo?.remoteThumbnail ?? item.videoInfo?.thumbnail
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

  async function handleRepairMediaMetadata(id: string) {
    const result = await window.api.repairThumbnail(id)
    if (result.success && result.item) {
      updateStatus(id, result.item.status, result.item)
    }
  }

  async function runAutoRecipeAfterDownload(done: { id: string; outputPath?: string; outputDir?: string; thumbnailPath?: string; duration?: number }) {
    if (!done.outputPath) return
    const enabled = await window.api.getSetting('automationAutoRecipe').catch(() => false)
    if (!enabled) return

    const base = itemsRef.current.find(item => item.id === done.id)
    if (!base) return
    const item: DownloadItem = {
      ...base,
      status: 'completed',
      outputPath: done.outputPath,
      outputDir: done.outputDir ?? base.outputDir,
      thumbnailPath: done.thumbnailPath ?? base.thumbnailPath,
      duration: done.duration ?? base.duration
    }

    const product = await window.api.getProductState().catch(() => null) as ProductHubState | null
    if (!product) return
    const selectedRecipeId = await window.api.getSetting('automationAutoRecipeId').catch(() => '') as string
    const recipe = pickAutoRecipe(product, item, selectedRecipeId)
    if (!recipe) return

    for (const step of recipe.steps) {
      await runAutoRecipeStep(step, recipe, item).catch(() => {})
    }
  }

  function pickAutoRecipe(product: ProductHubState, item: DownloadItem, selectedRecipeId?: string): PostProcessRecipe | undefined {
    const explicit = selectedRecipeId ? product.recipes.find(recipe => recipe.id === selectedRecipeId) : undefined
    if (explicit) return explicit

    const platform = normalizePlatformKey(item.videoInfo?.platform || detectPlatform(item.url).name)
    const selectedFormat = (item.selectedFormat || '').toLowerCase()
    const profile = product.smartProfiles.find(profile => {
      if (!profile.recipeId) return false
      const profilePlatform = normalizePlatformKey(profile.platform)
      const platformOk = profilePlatform === 'all' || platform.includes(profilePlatform) || profilePlatform.includes(platform)
      const formatOk = profile.format === 'best' || selectedFormat.includes(profile.format.toLowerCase()) || profile.format.toLowerCase().includes(selectedFormat)
      return platformOk && formatOk
    }) ?? product.smartProfiles.find(profile => {
      if (!profile.recipeId) return false
      const profilePlatform = normalizePlatformKey(profile.platform)
      return profilePlatform === 'all' || platform.includes(profilePlatform) || profilePlatform.includes(platform)
    })

    return profile?.recipeId ? product.recipes.find(recipe => recipe.id === profile.recipeId) : undefined
  }

  async function runAutoRecipeStep(step: PostProcessRecipe['steps'][number], recipe: PostProcessRecipe, item: DownloadItem): Promise<void> {
    const inputPath = item.outputPath
    if (!inputPath) return
    const title = item.videoInfo?.title || inputPath.split(/[\\/]/).pop() || item.url

    if (step === 'metadata' || step === 'thumbnail') {
      await handleRepairMediaMetadata(item.id)
      return
    }

    if (step === 'transcript') {
      await window.api.startAiJob({ kind: 'transcript', inputPath, title })
      return
    }

    if (step === 'compress') {
      await media.startConvert({
        inputPath,
        outputPath: derivativePath(inputPath, 'compressed', 'mp4'),
        outputFormat: recipe.format ?? 'mp4',
        title
      })
      return
    }

    if (step === 'audio-normalize') {
      await media.startNormalize({
        inputPath,
        outputPath: derivativePath(inputPath, 'normalized', outputExtension(inputPath, recipe.format)),
        title
      })
      return
    }

    if (step === 'subtitle-save' || step === 'subtitle-soft' || step === 'subtitle-burn') {
      const mode = step === 'subtitle-save' ? 'save' : step === 'subtitle-soft' ? 'soft' : 'burn'
      const ext = mode === 'save' ? 'srt' : 'mp4'
      const suffix = mode === 'save' ? 'subs' : mode === 'soft' ? 'softsubs' : 'burnedsubs'
      const cookieBrowser = await window.api.getSetting('cookieBrowser').catch(() => undefined) as string | undefined
      await media.startSubtitle({
        inputPath,
        outputPath: derivativePath(inputPath, suffix, ext),
        mode,
        style: DEFAULT_SUBTITLE_STYLE,
        url: item.url,
        lang: 'auto',
        cookieBrowser,
        title
      })
    }
  }

  function derivativePath(inputPath: string, suffix: string, extension: string): string {
    const match = inputPath.match(/^(.*?)(\.[^./\\]+)?$/)
    const base = match?.[1] || inputPath
    return `${base}.${suffix}.${extension}`
  }

  function outputExtension(inputPath: string, preferred?: string): string {
    const cleanPreferred = preferred?.replace(/^\./, '').toLowerCase()
    if (cleanPreferred && cleanPreferred !== 'best' && !cleanPreferred.includes('/')) return cleanPreferred
    const match = inputPath.match(/\.([^./\\]+)$/)
    return match?.[1]?.toLowerCase() || 'mp4'
  }

  function normalizePlatformKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  }

  const queueItems   = items.filter(i => i.status !== 'completed' && i.status !== 'error' && i.status !== 'cancelled')
  const historyItems = items.filter(i => i.status === 'completed' || i.status === 'error' || i.status === 'cancelled')

  if (isMini) return <MiniMode items={queueItems} activeCount={activeCount} onExpand={() => { setIsMini(false); window.api.closeMiniWindow() }} />

  return (
    <>
      <audio ref={audioRef} src={COMPLETION_BEEP} />

      {/* Arkaplan */}
      <div className="fixed inset-0 bg-[#09090B] pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_8%,rgba(124,58,237,0.18),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(59,130,246,0.10),transparent_26%),linear-gradient(180deg,#09090B_0%,#0F0F12_52%,#09090B_100%)]" />
        <div className="absolute inset-0 opacity-[0.035] bg-[linear-gradient(rgba(255,255,255,0.7)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.7)_1px,transparent_1px)] bg-[size:48px_48px]" />
      </div>

      <div className="relative flex flex-col h-screen text-white overflow-hidden bg-[#09090B]">
        <div
          className="flex h-[38px] shrink-0 items-center justify-between border-b border-white/[0.04] bg-[#09090B] px-3 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-[#7C3AED] to-[#8B5CF6] shadow-[0_0_24px_rgba(124,58,237,0.35)]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M12 3v12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                <path d="M7 10l5 5 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5 20h14" stroke="white" strokeWidth="2" strokeLinecap="round" opacity=".75"/>
              </svg>
            </div>
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-white/90">DropMedia</span>
          </div>
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button onClick={() => window.api.maximizeWindow()} title="Tam ekran" className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
            <button onClick={() => window.api.openMiniWindow()} title="Mini mod" className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/>
              </svg>
            </button>
            <button onClick={() => window.api.minimizeWindow()} title="Küçült" className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
              <svg width="12" height="2" viewBox="0 0 12 2"><rect width="12" height="1.5" rx="1" fill="currentColor"/></svg>
            </button>
            <button onClick={() => window.api.closeWindow()} title="Kapat" className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-red-500 hover:text-white">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
            </button>
          </div>
        </div>

        {/* Clipboard toast */}
        {clipboardToast && (
          <div className="absolute right-5 top-12 z-40 flex w-[360px] items-center gap-3 rounded-xl border border-[#7C3AED]/30 bg-[#16161A]/95 px-4 py-3 shadow-2xl shadow-black/30 backdrop-blur-xl animate-slide-up">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white/80">Clipboard'dan URL algılandı</p>
              <p className="truncate font-mono text-[11px] text-zinc-500">{clipboardToast.url}</p>
            </div>
            <button onClick={() => { setClipboardToast(null) }}
              className="text-xs text-zinc-500 transition-colors hover:text-white">✕</button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[220px] shrink-0 flex-col border-r border-white/[0.04] bg-[#0F0F12]/95 px-3 py-4">
            <nav className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0 pb-2">
              <SidebarItem active={activeTab === 'queue'} onClick={() => setActiveTab('queue')} icon={<DownloadIcon />}>
                İndir{queueItems.length > 0 && <Badge>{queueItems.length}</Badge>}{activeCount > 0 && <ActiveDot />}
              </SidebarItem>
              <SidebarItem active={activeTab === 'links'} onClick={() => setActiveTab('links')} icon={<LinkIcon />}>
                Linkler
              </SidebarItem>
              <SidebarItem active={activeTab === 'watch'} onClick={() => setActiveTab('watch')} icon={<WatchIcon />}>
                Takip<BetaBadge />
              </SidebarItem>
              <SidebarItem active={activeTab === 'library'} onClick={() => setActiveTab('library')} icon={<LibraryIcon />}>
                Kütüphane
              </SidebarItem>
              <SidebarItem active={activeTab === 'automation'} onClick={() => setActiveTab('automation')} icon={<AutomationIcon />}>
                Otomasyon<BetaBadge />
              </SidebarItem>
              <SidebarItem active={activeTab === 'ai'} onClick={() => setActiveTab('ai')} icon={<AiIcon />}>
                AI<BetaBadge />
              </SidebarItem>
              <SidebarItem active={activeTab === 'ai-chat'} onClick={() => setActiveTab('ai-chat')} icon={<AiIcon />}>
                AI Chat<BetaBadge />
              </SidebarItem>
              <SidebarItem active={activeTab === 'account'} onClick={() => setActiveTab('account')} icon={<AccountIcon />}>
                Hesap
              </SidebarItem>
              <SidebarItem active={activeTab === 'history'} onClick={() => setActiveTab('history')} icon={<ClockIcon />}>
                Geçmiş{historyItems.length > 0 && <Badge muted>{historyItems.length}</Badge>}
              </SidebarItem>
              <SidebarItem active={activeTab === 'convert'} onClick={() => setActiveTab('convert')} icon={<RefreshIcon />}>
                Dönüştür
              </SidebarItem>
              <SidebarItem active={activeTab === 'subtitle'} onClick={() => setActiveTab('subtitle')} icon={<SubtitleIcon />}>
                Altyazı{media.subtitleActive && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse inline-block" />}
              </SidebarItem>
              <SidebarItem active={activeTab === 'stats'} onClick={() => setActiveTab('stats')} icon={<ChartIcon />}>
                İstatistik
              </SidebarItem>
            </nav>

            <div className="shrink-0 space-y-3 pt-2">
              <SidebarItem active={activeTab === 'admin'} onClick={() => setActiveTab('admin')} icon={<LockIcon />}>
                Admin
              </SidebarItem>
              <button
                onClick={() => setSettingsOpen(true)}
                title="Ayarlar"
                className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium text-zinc-500 transition-all hover:bg-[#252530] hover:text-zinc-200"
              >
                <SettingsIcon />
                Ayarlar
              </button>
            </div>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col bg-[#0F0F12]/40">
            <UpdateBanner />
            <div className="border-b border-white/[0.04] px-6 py-5">
              <UrlInput
                onDownload={handleDownload}
                incomingUrl={clipboardRequest}
                onIncomingUrlHandled={() => setClipboardRequest(null)}
              />
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
              <div className="mx-auto max-w-6xl">
                {activeTab === 'queue' && (
                  <DownloadQueue items={queueItems} onCancel={handleCancel} onPause={handlePause} onResume={handleResume} onRedownload={handleRedownload} onRemove={removeItem} onClearCompleted={clearCompleted} onShowItemInFolder={handleShowItemInFolder} onConvertDone={handleConvertDone} onUrlDrop={handleDetectedUrl} />
                )}
                {isProductTab(activeTab) && (
                  <ProductHub
                    view={activeTab}
                    historyItems={historyItems}
                    onUseUrl={handleDetectedUrl}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onCancel={handleCancel}
                    onPause={handlePause}
                    onResume={handleResume}
                    onRedownload={handleRedownload}
                    onRemove={removeItem}
                    onClearCompleted={clearCompleted}
                    onShowItemInFolder={handleShowItemInFolder}
                    onConvertDone={handleConvertDone}
                    onRepairMediaMetadata={handleRepairMediaMetadata}
                    onStartConvert={media.startConvert}
                    onStartNormalize={media.startNormalize}
                    onStartSubtitle={media.startSubtitle}
                  />
                )}
                {activeTab === 'history' && (
                  <DownloadQueue items={historyItems} onCancel={handleCancel} onPause={handlePause} onResume={handleResume} onRedownload={handleRedownload} onRemove={removeItem} onClearCompleted={clearCompleted} onShowItemInFolder={handleShowItemInFolder} onConvertDone={handleConvertDone} onUrlDrop={handleDetectedUrl} onRepairMediaMetadata={handleRepairMediaMetadata} />
                )}
                {activeTab === 'convert' && (
                  <ConverterTab
                    completedItems={historyItems}
                    jobs={media.jobs}
                    convertedRecords={media.convertedRecords}
                    onConvert={media.startConvert}
                    onCancelJob={media.cancelJob}
                    onDismissJob={media.dismissJob}
                    onRemoveConverted={media.removeConverted}
                  />
                )}
                {activeTab === 'subtitle' && (
                  <SubtitleTab
                    completedItems={historyItems}
                    jobs={media.jobs}
                    subtitleRecords={media.subtitleRecords}
                    onSubtitle={media.startSubtitle}
                    onCancelJob={media.cancelJob}
                    onDismissJob={media.dismissJob}
                    onRemoveSubtitle={media.removeSubtitle}
                  />
                )}
                {activeTab === 'stats' && (
                  <StatsView
                    historyItems={historyItems}
                    convertedRecords={media.convertedRecords}
                    subtitleRecords={media.subtitleRecords}
                  />
                )}
                {activeTab === 'admin' && <AdminPanel />}
              </div>
            </div>
          </main>
        </div>
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

function StatsView({ historyItems, convertedRecords, subtitleRecords }: {
  historyItems: DownloadItem[]
  convertedRecords: ConvertedRecord[]
  subtitleRecords: SubtitleRecord[]
}) {
  const completed = historyItems.filter(i => i.status === 'completed')
  const platforms = countBy(completed, i => detectPlatform(i.url).name)
  const formats = countBy(completed, i => (i.selectedFormat || 'unknown').toLowerCase())
  const mediaTypes = countBy(completed, i => isAudioFormat(i.selectedFormat) ? 'Ses' : 'Video')
  const totalSize = completed.reduce((sum, item) => sum + parseSize(item.totalSize), 0)
  const recent = [...completed].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 5)
  const last7 = getLast7Days(completed)
  const topPlatform = Object.entries(platforms).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-'
  const maxDay = Math.max(1, ...last7.map(d => d.count))

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Toplam İndirme</p>
          <p className="text-3xl font-bold text-white">{completed.length}</p>
        </div>
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Dönüştürme</p>
          <p className="text-3xl font-bold text-white">{convertedRecords.length}</p>
        </div>
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Altyazı İşlemi</p>
          <p className="text-3xl font-bold text-white">{subtitleRecords.length}</p>
        </div>
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-1">Toplam Boyut</p>
          <p className="text-3xl font-bold text-white">{formatBytes(totalSize)}</p>
        </div>
      </div>

      {completed.length > 0 && (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-white/40 text-xs uppercase tracking-wider">Son 7 Gün</p>
            <span className="text-white/30 text-xs">En çok: {topPlatform}</span>
          </div>
          <div className="flex h-28 items-end gap-2">
            {last7.map(day => (
              <div key={day.key} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div className="flex h-20 w-full items-end rounded-lg bg-white/[0.04] px-1">
                  <div
                    className="w-full rounded-md bg-gradient-button shadow-[0_0_14px_rgba(124,58,237,0.22)]"
                    style={{ height: `${Math.max(8, (day.count / maxDay) * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-white/30">{day.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <DistributionCard title="Platform Dağılımı" total={completed.length} data={platforms} />
        <DistributionCard title="Format Dağılımı" total={completed.length} data={formats} />
        <DistributionCard title="Video / Ses" total={completed.length} data={mediaTypes} />
        <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
          <p className="text-white/40 text-xs mb-3 uppercase tracking-wider">Son 5 İndirilen</p>
          <div className="space-y-2">
            {recent.map(item => <MediaListItem key={item.id} item={item} compact />)}
            {recent.length === 0 && <p className="py-4 text-center text-sm text-white/25">Henüz veri yok</p>}
          </div>
        </div>
      </div>

      {completed.length === 0 && convertedRecords.length === 0 && subtitleRecords.length === 0 && (
        <div className="text-center py-12">
          <p className="text-white/20 text-sm">Henüz veri yok</p>
        </div>
      )}
    </div>
  )
}

function DistributionCard({ title, total, data }: { title: string; total: number; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
      <p className="text-white/40 text-xs mb-3 uppercase tracking-wider">{title}</p>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-white/25">Henüz veri yok</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([name, count]) => (
            <div key={name} className="flex items-center gap-3">
              <span className="w-24 truncate text-sm capitalize text-white/60">{name}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                <div className="h-full rounded-full bg-gradient-button" style={{ width: `${(count / Math.max(1, total)) * 100}%` }} />
              </div>
              <span className="w-8 text-right text-xs text-white/40">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function countBy(items: DownloadItem[], getKey: (item: DownloadItem) => string): Record<string, number> {
  return items.reduce((acc, item) => {
    const key = getKey(item)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
}

function isAudioFormat(format: string): boolean {
  return ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus'].includes(format.toLowerCase())
}

function getLast7Days(items: DownloadItem[]): { key: string; label: string; count: number }[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - index))
    date.setHours(0, 0, 0, 0)
    const start = date.getTime()
    const end = start + 24 * 60 * 60 * 1000
    return {
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('tr-TR', { weekday: 'short' }),
      count: items.filter(item => (item.completedAt ?? 0) >= start && (item.completedAt ?? 0) < end).length
    }
  })
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function getDownloadSubtitleMode(settings: Record<string, unknown>): 'none' | 'save' | 'soft' | 'burn' {
  const mode = settings['subtitleMode']
  if (mode === 'save' || mode === 'soft' || mode === 'burn') return mode
  if (settings['subtitles']) return settings['embedSubs'] ? 'soft' : 'save'
  return 'none'
}

function isProductTab(tab: Tab): tab is ProductHubView {
  return (PRODUCT_TABS as readonly string[]).includes(tab)
}

function SidebarItem({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-all
        ${active ? 'bg-[#1E1E25] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-zinc-500 hover:bg-[#252530] hover:text-zinc-300'}`}>
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      {children}
    </button>
  )
}

// Aktif işlem göstergesi: yazı yok, sadece nefes alan nokta.
function ActiveDot() {
  return (
    <span className="relative ml-1.5 flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-400" />
    </span>
  )
}

function BetaBadge() {
  return (
    <span className="ml-1.5 rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider leading-none text-violet-300/80">
      Beta
    </span>
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

function DownloadIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
}

function LinkIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg>
}

function WatchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
}

function LibraryIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-1.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
}

function ClockIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
}

function AutomationIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><circle cx="12" cy="12" r="4"/><path d="m16 8 2-2"/><path d="m6 18 2-2"/><path d="m16 16 2 2"/><path d="m6 6 2 2"/></svg>
}

function AiIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4"/><path d="M15 1v4"/><path d="M9 19v4"/><path d="M15 19v4"/><path d="M1 9h4"/><path d="M1 15h4"/><path d="M19 9h4"/><path d="M19 15h4"/><path d="M9 14v-4l3 4 3-4v4"/></svg>
}

function LockIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v2"/></svg>
}

function AccountIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
}

function RefreshIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-15.2 6.5"/><path d="M3 12A9 9 0 0 1 18.2 5.5"/><path d="M3 17v5h5"/><path d="M21 7V2h-5"/></svg>
}

function ChartIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M13 16V8"/><path d="M18 16v-7"/></svg>
}

function SubtitleIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>
}

function SettingsIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V22h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 9c.2.6.8 1 1.5 1h.1v4h-.1c-.7 0-1.3.4-1.5 1z"/></svg>
}
