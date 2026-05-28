import { useEffect, useRef, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { UrlInput } from './components/UrlInput'
import { DownloadQueue } from './components/DownloadQueue'
import { Settings } from './components/Settings'
import { UpdateBanner } from './components/UpdateBanner'
import { useDownloadStore } from './store/downloadStore'
import { VideoInfo } from './types'

type Tab = 'queue' | 'history'

export default function App() {
  const { items, addItem, updateStatus, updateProgress, removeItem, clearCompleted } =
    useDownloadStore()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('queue')
  const [downloadDir, setDownloadDir] = useState('')

  const activeCount = items.filter(
    (i) => i.status === 'downloading' || i.status === 'fetching'
  ).length

  // IPC listener'ları kur
  useEffect(() => {
    window.api.getDownloadsFolder().then(setDownloadDir)

    window.api.onDownloadProgress((data) => {
      const d = data as { id: string; percent: number; speed: string; eta: string; totalSize: string }
      updateProgress(d.id, d.percent, d.speed, d.eta, d.totalSize)
    })

    window.api.onDownloadComplete((data) => {
      const d = data as { id: string; success: boolean }
      updateStatus(d.id, d.success ? 'completed' : 'error', {
        error: d.success ? undefined : 'İndirme başarısız'
      })
    })

    return () => {
      window.api.offDownloadListeners()
    }
  }, [updateProgress, updateStatus])

  async function handleDownload(url: string, format: string, videoInfo: VideoInfo) {
    const dir = downloadDir || await window.api.getDownloadsFolder()
    const id = addItem(url, format, videoInfo)
    updateStatus(id, 'downloading')
    await window.api.startDownload({ id, url, format, outputDir: dir })
  }

  async function handleCancel(id: string) {
    await window.api.cancelDownload(id)
    updateStatus(id, 'cancelled')
  }

  async function handleOpenFolder(path?: string) {
    const folder = path || downloadDir
    if (folder) window.api.openFolder(folder)
  }

  const queueItems = items.filter((i) =>
    i.status !== 'completed' && i.status !== 'error' && i.status !== 'cancelled'
  )
  const historyItems = items.filter((i) =>
    i.status === 'completed' || i.status === 'error' || i.status === 'cancelled'
  )

  return (
    <>
      {/* Arkaplan — glassmorphism gradyan */}
      <div className="fixed inset-0 bg-gradient-dark pointer-events-none">
        {/* Dekoratif blob'lar */}
        <div className="absolute top-[-10%] left-[-5%] w-72 h-72 rounded-full bg-purple-600/20 blur-[80px]" />
        <div className="absolute top-[30%] right-[-5%] w-64 h-64 rounded-full bg-blue-600/15 blur-[80px]" />
        <div className="absolute bottom-[-5%] left-[30%] w-80 h-80 rounded-full bg-indigo-600/10 blur-[100px]" />
      </div>

      {/* Ana pencere */}
      <div className="relative flex flex-col h-screen text-white overflow-hidden">
        {/* Başlık çubuğu */}
        <TitleBar />

        {/* Güncelleme banner */}
        <UpdateBanner />

        {/* İçerik */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* URL girişi */}
          <div className="px-5 pt-4 pb-2">
            <UrlInput onDownload={handleDownload} />
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-1 px-5 pt-2 pb-3 border-b border-white/6">
            <TabBtn active={activeTab === 'queue'} onClick={() => setActiveTab('queue')}>
              Kuyruk
              {queueItems.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-purple-500/30 text-purple-300 text-[10px] font-semibold leading-none">
                  {queueItems.length}
                </span>
              )}
            </TabBtn>
            <TabBtn active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
              Geçmiş
              {historyItems.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-white/10 text-white/40 text-[10px] font-semibold leading-none">
                  {historyItems.length}
                </span>
              )}
            </TabBtn>

            <div className="flex-1" />

            {/* Ayarlar butonu */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-all"
              title="Ayarlar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>

          {/* Liste */}
          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1 scrollbar-thin">
            {activeTab === 'queue' ? (
              <DownloadQueue
                items={queueItems}
                onCancel={handleCancel}
                onRemove={removeItem}
                onClearCompleted={clearCompleted}
                onOpenFolder={handleOpenFolder}
              />
            ) : (
              <DownloadQueue
                items={historyItems}
                onCancel={handleCancel}
                onRemove={removeItem}
                onClearCompleted={clearCompleted}
                onOpenFolder={handleOpenFolder}
              />
            )}
          </div>
        </div>

        {/* Alt durum çubuğu */}
        {activeCount > 0 && (
          <div className="px-5 py-2 border-t border-white/6 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            <span className="text-white/40 text-xs">{activeCount} indirme devam ediyor</span>
          </div>
        )}
      </div>

      {/* Ayarlar modal */}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </>
  )
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center px-3 py-1.5 rounded-xl text-sm font-medium transition-all
        ${active
          ? 'bg-white/10 text-white'
          : 'text-white/40 hover:text-white/70 hover:bg-white/6'
        }`}
    >
      {children}
    </button>
  )
}
