'use client'
import { useEffect, useState, useCallback } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'

interface StatsData {
  total: number
  totalMb: number
  avgSpeedMbps: number
  platforms: Record<string, number>
  devices: { id: string; name: string }[]
  recent: RecentItem[]
}

interface RecentItem {
  id: string
  created_at: string
  device_id: string
  hostname: string
  platform: string
  format: string
  file_size_mb: number
  download_ms: number
  success: boolean
}

interface LogItem {
  id: string
  created_at: string
  device_id: string
  hostname: string
  app_version: string
  os: string
  url: string
  format: string
  error_type: string
  error_message: string
  stack_trace: string
  ytdlp_version: string
  ffmpeg?: boolean
  tor_enabled?: boolean
}

interface LogsResponse {
  data?: LogItem[]
  count?: number
}

const COLORS = ['#7c3aed','#3b82f6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#8b5cf6']
const LOCAL_BRIDGES = ['http://127.0.0.1:17389', 'http://localhost:17389']
type BridgeState = 'checking' | 'connected' | 'unavailable'

function emptyStats(): StatsData {
  return { total: 0, totalMb: 0, avgSpeedMbps: 0, platforms: {}, devices: [], recent: [] }
}

async function fetchJson<T>(url: string, timeoutMs?: number): Promise<T | null> {
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller?.signal })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

async function fetchLocalJson<T>(path: string): Promise<T | null> {
  for (const bridge of LOCAL_BRIDGES) {
    const result = await fetchJson<T>(`${bridge}${path}`, 900)
    if (result) return result
  }
  return null
}

function mergeStats(remote: StatsData | null, local: StatsData | null): StatsData {
  const merged = emptyStats()
  const deviceMap = new Map<string, string>()

  for (const source of [remote, local]) {
    if (!source) continue
    merged.total += source.total ?? 0
    merged.totalMb += source.totalMb ?? 0
    for (const [platform, count] of Object.entries(source.platforms ?? {})) {
      merged.platforms[platform] = (merged.platforms[platform] ?? 0) + count
    }
    for (const device of source.devices ?? []) deviceMap.set(device.id, device.name)
    merged.recent.push(...(source.recent ?? []))
  }

  merged.devices = [...deviceMap.entries()].map(([id, name]) => ({ id, name }))
  merged.recent = uniqueBy(
    merged.recent.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    item => `${item.created_at}|${item.device_id}|${item.platform}|${item.format}`
  ).slice(0, 100)

  const speedSources = [remote, local].filter((source): source is StatsData => !!source && source.avgSpeedMbps > 0 && source.total > 0)
  const speedWeight = speedSources.reduce((sum, source) => sum + source.total, 0)
  merged.avgSpeedMbps = speedWeight
    ? Math.round((speedSources.reduce((sum, source) => sum + source.avgSpeedMbps * source.total, 0) / speedWeight) * 10) / 10
    : 0
  merged.totalMb = Math.round(merged.totalMb * 10) / 10

  return merged
}

function mergeLogs(remote: LogsResponse | null, local: LogsResponse | null): LogsResponse {
  const items = uniqueBy(
    [...(remote?.data ?? []), ...(local?.data ?? [])]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    item => `${item.created_at}|${item.device_id}|${item.error_type}|${item.error_message}|${item.url ?? ''}`
  )

  return {
    data: items.slice(0, 50),
    count: Math.max(items.length, (remote?.count ?? 0) + (local?.count ?? 0))
  }
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = keyFn(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function DashboardClient() {
  const [stats, setStats]         = useState<StatsData | null>(null)
  const [logs, setLogs]           = useState<LogItem[]>([])
  const [logCount, setLogCount]   = useState(0)
  const [tab, setTab]             = useState<'overview' | 'logs' | 'devices'>('overview')
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [expandedLog, setExpandedLog]       = useState<string | null>(null)
  const [logPage, setLogPage]     = useState(1)
  const [loading, setLoading]     = useState(true)
  const [bridgeState, setBridgeState] = useState<BridgeState>('checking')

  const fetchData = useCallback(async () => {
    setLoading(true)
    const deviceQuery = selectedDevice ? `&device=${encodeURIComponent(selectedDevice)}` : ''
    const statsPath = `/api/stats${selectedDevice ? `?device=${encodeURIComponent(selectedDevice)}` : ''}`
    const logsPath = `/api/logs?page=${logPage}${deviceQuery}`

    try {
      const [remoteStats, remoteLogs, localStats, localLogs] = await Promise.all([
        fetchJson<StatsData>(statsPath),
        fetchJson<LogsResponse>(logsPath),
        fetchLocalJson<StatsData>(statsPath),
        fetchLocalJson<LogsResponse>(logsPath)
      ])
      setBridgeState(localStats || localLogs ? 'connected' : 'unavailable')
      const mergedStats = mergeStats(remoteStats, localStats)
      const mergedLogs = mergeLogs(remoteLogs, localLogs)
      setStats(mergedStats)
      setLogs(mergedLogs.data ?? [])
      setLogCount(mergedLogs.count ?? 0)
    } finally {
      setLoading(false)
    }
  }, [selectedDevice, logPage])

  useEffect(() => { fetchData() }, [fetchData])

  const platformData = stats
    ? Object.entries(stats.platforms).map(([name, value]) => ({ name, value }))
    : []

  async function handleLogout() {
    await fetch('/api/auth', { method: 'DELETE' })
    window.location.href = '/'
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-white/8 px-6 py-4 flex items-center justify-between sticky top-0 bg-[#0a0a0f]/90 backdrop-blur-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 to-blue-500 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L4 7v10l8 5 8-5V7L12 2z"/>
              <path d="M12 8v8M9 13l3 3 3-3"/>
            </svg>
          </div>
          <span className="font-bold text-white">DropMedia Admin</span>
        </div>
        <div className="flex items-center gap-4">
          <span className={`text-xs ${bridgeState === 'connected' ? 'text-green-400' : bridgeState === 'checking' ? 'text-white/30' : 'text-amber-400'}`}>
            {bridgeState === 'connected' ? 'Yerel uygulama bağlı' : bridgeState === 'checking' ? 'Bağlantı kontrol ediliyor' : 'Yerel uygulama bağlı değil'}
          </span>
          <button onClick={fetchData} className="text-white/40 hover:text-white transition-colors text-sm">↻ Yenile</button>
          <button onClick={handleLogout} className="text-white/40 hover:text-red-400 transition-colors text-sm">Çıkış</button>
        </div>
      </header>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Sidebar — cihazlar */}
        <aside className="w-56 border-r border-white/8 p-4 overflow-y-auto shrink-0">
          <p className="text-white/30 text-xs uppercase tracking-wider mb-3">Cihazlar</p>
          <button
            onClick={() => { setSelectedDevice(null); setLogPage(1) }}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${!selectedDevice ? 'bg-purple-500/20 text-purple-300' : 'text-white/50 hover:text-white hover:bg-white/5'}`}
          >
            Tümü
          </button>
          {stats?.devices.map(d => (
            <button
              key={d.id}
              onClick={() => { setSelectedDevice(d.id); setLogPage(1) }}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors truncate ${selectedDevice === d.id ? 'bg-purple-500/20 text-purple-300' : 'text-white/50 hover:text-white hover:bg-white/5'}`}
              title={d.name}
            >
              {d.name}
            </button>
          ))}
        </aside>

        {/* Ana içerik */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* Tab'lar */}
          <div className="flex gap-1 mb-6">
            {(['overview', 'logs', 'devices'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${tab === t ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}
              >
                {t === 'overview' ? 'Genel Bakış' : t === 'logs' ? `Loglar (${logCount})` : 'İstatistikler'}
              </button>
            ))}
          </div>

          {!loading && bridgeState === 'unavailable' && (
            <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-amber-200/90 text-sm">
              Admin panel açık DropMedia uygulamasına bağlanamadı. Uygulama açık değilse açın; Vercel sayfası eski deploy ise admin paneli yeniden deploy edin.
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64 text-white/30">Yükleniyor…</div>
          ) : tab === 'overview' ? (
            <OverviewTab stats={stats} platformData={platformData} />
          ) : tab === 'logs' ? (
            <LogsTab logs={logs} logCount={logCount} logPage={logPage} setLogPage={setLogPage} expandedLog={expandedLog} setExpandedLog={setExpandedLog} bridgeState={bridgeState} />
          ) : (
            <StatsTab stats={stats} />
          )}
        </main>
      </div>
    </div>
  )
}

function OverviewTab({ stats, platformData }: { stats: StatsData | null; platformData: { name: string; value: number }[] }) {
  return (
    <div className="space-y-6">
      {/* Özet kartlar */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Toplam İndirme" value={stats?.total ?? 0} unit="" />
        <StatCard label="Toplam Boyut" value={stats?.totalMb ?? 0} unit="MB" />
        <StatCard label="Ort. Hız" value={stats?.avgSpeedMbps ?? 0} unit="MB/s" />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Platform dağılımı */}
        <div className="bg-white/5 rounded-2xl p-5 border border-white/8">
          <h3 className="text-white/70 text-sm font-medium mb-4">Platform Dağılımı</h3>
          {platformData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={platformData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {platformData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyState />}
        </div>

        {/* Son indirmeler */}
        <div className="bg-white/5 rounded-2xl p-5 border border-white/8">
          <h3 className="text-white/70 text-sm font-medium mb-4">Son İndirmeler</h3>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {stats?.recent.slice(0, 8).map(r => (
              <div key={r.id} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                <div>
                  <span className="text-white/80 text-xs">{r.platform}</span>
                  <span className="text-white/30 text-xs ml-2">{r.format}</span>
                </div>
                <div className="text-right">
                  <span className={`text-xs ${r.success ? 'text-green-400' : 'text-red-400'}`}>{r.success ? '✓' : '✗'}</span>
                  <span className="text-white/30 text-xs ml-2">{r.file_size_mb?.toFixed(1)}MB</span>
                </div>
              </div>
            )) ?? <EmptyState />}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatLogForCopy(log: LogItem): string {
  const lines: string[] = [
    `[${new Date(log.created_at).toLocaleString('tr')}] ${log.error_type?.toUpperCase()} — ${log.error_message}`,
    `Cihaz: ${log.hostname ?? '-'}  |  OS: ${log.os ?? '-'}  |  App: ${log.app_version ?? '-'}`,
    `yt-dlp: ${log.ytdlp_version ?? '-'}  |  ffmpeg: ${log.ffmpeg ?? '-'}  |  Tor: ${log.tor_enabled ?? '-'}  |  Format: ${log.format ?? '-'}`,
  ]
  if (log.url)         lines.push(`URL: ${log.url}`)
  if (log.stack_trace) lines.push(`Teknik Detay:\n${log.stack_trace}`)
  return lines.join('\n')
}

function CopyBtn({ text, small }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false)
  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  if (small) {
    return (
      <button onClick={handleCopy} title="Kopyala"
        className="px-2 py-1 rounded-lg bg-white/8 hover:bg-white/14 text-white/40 hover:text-white transition-colors text-xs shrink-0">
        {copied ? '✓' : '⎘'}
      </button>
    )
  }
  return (
    <button onClick={handleCopy}
      className="px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-white/50 hover:text-white transition-colors text-xs">
      {copied ? '✓ Kopyalandı' : 'Tümünü Kopyala'}
    </button>
  )
}

function LogsTab({ logs, logCount, logPage, setLogPage, expandedLog, setExpandedLog, bridgeState }: {
  logs: LogItem[]; logCount: number; logPage: number; setLogPage: (p: number) => void
  expandedLog: string | null; setExpandedLog: (id: string | null) => void
  bridgeState: BridgeState
}) {
  const totalPages = Math.ceil(logCount / 50)
  const allText = logs.map(formatLogForCopy).join('\n\n' + '─'.repeat(60) + '\n\n')

  return (
    <div className="space-y-2">
      {logs.length > 0 && (
        <div className="flex justify-end pb-1">
          <CopyBtn text={allText} />
        </div>
      )}
      {logs.length === 0 && <EmptyState message={bridgeState === 'unavailable' ? 'Yerel uygulama bağlı değil; log alınamadı' : 'Henüz log yok'} />}
      {logs.map(log => (
        <div key={log.id} className="bg-white/5 border border-white/8 rounded-xl overflow-hidden">
          <div
            className="flex items-center gap-4 p-4 cursor-pointer hover:bg-white/3 transition-colors"
            onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
          >
            <span className={`text-xs px-2 py-1 rounded-lg font-medium shrink-0 ${
              log.error_type === 'crash'        ? 'bg-red-500/20 text-red-400' :
              log.error_type === 'download'     ? 'bg-orange-500/20 text-orange-400' :
              log.error_type === 'download_ok'  ? 'bg-green-500/20 text-green-400' :
              log.error_type === 'warning'      ? 'bg-amber-500/20 text-amber-400' :
              log.error_type === 'app_open'     ? 'bg-purple-500/20 text-purple-400' :
              log.error_type === 'clipboard' || log.error_type === 'settings' ? 'bg-blue-500/20 text-blue-400' :
              'bg-white/10 text-white/50'
            }`}>{log.error_type}</span>
            <span className="text-white/70 text-sm flex-1 truncate">{log.error_message}</span>
            <span className="text-white/30 text-xs shrink-0">{log.hostname}</span>
            <span className="text-white/30 text-xs shrink-0">{new Date(log.created_at).toLocaleString('tr')}</span>
            <CopyBtn text={formatLogForCopy(log)} small />
          </div>
          {expandedLog === log.id && (
            <div className="border-t border-white/8 p-4 space-y-3">
              <Grid items={[
                ['Cihaz', log.hostname], ['OS', log.os], ['App', log.app_version],
                ['yt-dlp', log.ytdlp_version], ['ffmpeg', log.ffmpeg === undefined ? undefined : String(log.ffmpeg)],
                ['Tor', log.tor_enabled === undefined ? undefined : String(log.tor_enabled)], ['Format', log.format]
              ]} />
              {log.url && <div><p className="text-white/30 text-xs mb-1">URL</p><p className="text-blue-400 text-xs break-all">{log.url}</p></div>}
              {log.stack_trace && (
                <div>
                  <p className="text-white/30 text-xs mb-1">Teknik Detay</p>
                  <pre className="text-red-300/80 text-xs bg-black/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{log.stack_trace}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 pt-4">
          <button onClick={() => setLogPage(Math.max(1, logPage - 1))} disabled={logPage === 1} className="px-3 py-1.5 rounded-lg bg-white/8 text-white/50 disabled:opacity-30 text-sm">←</button>
          <span className="px-3 py-1.5 text-white/40 text-sm">{logPage} / {totalPages}</span>
          <button onClick={() => setLogPage(Math.min(totalPages, logPage + 1))} disabled={logPage === totalPages} className="px-3 py-1.5 rounded-lg bg-white/8 text-white/50 disabled:opacity-30 text-sm">→</button>
        </div>
      )}
    </div>
  )
}

function StatsTab({ stats }: { stats: StatsData | null }) {
  const barData = stats ? Object.entries(stats.platforms).map(([name, value]) => ({ name, value })) : []
  return (
    <div className="space-y-6">
      <div className="bg-white/5 rounded-2xl p-5 border border-white/8">
        <h3 className="text-white/70 text-sm font-medium mb-4">Platform Bazlı İndirme Sayısı</h3>
        {barData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }} />
              <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }} />
              <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
              <Bar dataKey="value" fill="#7c3aed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState />}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Aktif Cihaz" value={stats?.devices.length ?? 0} unit="" />
        <StatCard label="Toplam İndirme" value={stats?.total ?? 0} unit="" />
        <StatCard label="Toplam Veri" value={stats?.totalMb ?? 0} unit="MB" />
      </div>
    </div>
  )
}

function StatCard({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-5">
      <p className="text-white/40 text-xs mb-2">{label}</p>
      <p className="text-2xl font-bold text-white">{value}{unit && <span className="text-sm text-white/40 ml-1">{unit}</span>}</p>
    </div>
  )
}

function Grid({ items }: { items: [string, string?][] }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}>
          <p className="text-white/30 text-xs">{k}</p>
          <p className="text-white/70 text-xs mt-0.5">{v}</p>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ message = 'Veri yok' }: { message?: string }) {
  return <p className="text-white/20 text-sm text-center py-8">{message}</p>
}
