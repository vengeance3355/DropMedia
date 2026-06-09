import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SUBTITLE_STYLE } from '../types'
import type {
  AiChatModel,
  AiChatSession,
  AiJob,
  AiJobKind,
  AiBenchmarkResult,
  AiSystemReport,
  AiToolState,
  DownloadItem,
  LinkInboxItem,
  PostProcessRecipe,
  PreflightMessage,
  ProductHubState,
  SmartProfile,
  SubtitleStyle,
  WatchItem,
  WatchSource
} from '../types'
import { formatDuration } from '../utils/platform'
import { DownloadQueue } from './DownloadQueue'

interface Props {
  view: ProductHubView
  historyItems: DownloadItem[]
  onUseUrl: (url: string) => void
  onOpenSettings: () => void
  onCancel: (id: string) => void
  onPause: (id: string) => void
  onResume: (item: DownloadItem) => void
  onRedownload: (item: DownloadItem) => void
  onRemove: (id: string) => void
  onClearCompleted: () => void
  onShowItemInFolder: (item: DownloadItem) => void
  onConvertDone?: (id: string, newPath: string) => void
  onRepairMediaMetadata?: (id: string) => Promise<void>
  onStartConvert?: (opts: { inputPath: string; outputFormat: string; outputPath: string; title: string }) => Promise<string>
  onStartNormalize?: (opts: { inputPath: string; outputPath: string; title: string }) => Promise<string>
  onStartSubtitle?: (opts: {
    inputPath: string
    outputPath: string
    mode: 'burn' | 'soft' | 'save'
    style: SubtitleStyle
    url?: string
    subtitlePath?: string
    lang?: string
    cookieBrowser?: string
    replaceOriginal?: boolean
    title?: string
  }) => Promise<string>
}

export type ProductHubView = 'links' | 'watch' | 'library' | 'automation' | 'ai' | 'ai-chat' | 'account'
type SyncStatus = {
  configured: boolean
  signedIn: boolean
  email?: string
  userId?: string
  error?: string
  notice?: string
  emailConfirmationRequired?: boolean
  health?: {
    ok: boolean
    status: 'ready' | 'misconfigured' | 'unreachable' | 'schema_missing'
    message?: string
    missingTables?: string[]
    checkedAt: number
  }
}
type AiActionKind = Exclude<AiJobKind, 'install' | 'repair' | 'remove' | 'benchmark'>
const NEW_AI_CHAT_ID = '__new_ai_chat__'

const pendingAiChatIds = new Set<string>()
const aiChatPendingSubscribers = new Set<(ids: Set<string>) => void>()

function subscribeAiChatPending(listener: (ids: Set<string>) => void): () => void {
  listener(new Set(pendingAiChatIds))
  aiChatPendingSubscribers.add(listener)
  return () => aiChatPendingSubscribers.delete(listener)
}

function setAiChatPending(ids: string[], pending: boolean): void {
  let changed = false
  for (const id of ids.filter(Boolean)) {
    const had = pendingAiChatIds.has(id)
    if (pending && !had) {
      pendingAiChatIds.add(id)
      changed = true
    } else if (!pending && had) {
      pendingAiChatIds.delete(id)
      changed = true
    }
  }
  if (changed) {
    const next = new Set(pendingAiChatIds)
    aiChatPendingSubscribers.forEach(listener => listener(next))
  }
}

const VIEW_META: Record<ProductHubView, { title: string; description: string }> = {
  links: {
    title: 'Linkler',
    description: 'URL inbox, preflight kontrolü, cookie uyarıları ve Instagram story/highlight kısayolları.'
  },
  watch: {
    title: 'Takip',
    description: 'YouTube, Instagram, X/Twitter ve playlist kaynaklarını izleyip yeni içerikleri yakalar.'
  },
  library: {
    title: 'Kütüphane',
    description: 'Tamamlanan indirmeler, local kayıtlar ve dosya konumu aksiyonları.'
  },
  automation: {
    title: 'Otomasyon',
    description: 'Akıllı profiller, dosya adlandırma presetleri ve post-process recipe zincirleri.'
  },
  ai: {
    title: 'Local AI',
    description: 'Tamamen opsiyonel ücretsiz local model özellikleri; kullanıcı onayı olmadan model indirmez.'
  },
  'ai-chat': {
    title: 'AI Chat',
    description: 'Local modellerle sohbet et, dosya bağla, transcript/özet/çeviri işlerini konuşarak başlat.'
  },
  account: {
    title: 'Hesap',
    description: 'Supabase Auth, cloud sync, manuel yedekleme ve geri yükleme.'
  }
}

const EMPTY: ProductHubState = {
  inbox: [],
  watchSources: [],
  watchItems: [],
  smartProfiles: [],
  recipes: [],
  library: [],
  aiTools: []
}

export function ProductHub({
  view,
  historyItems,
  onUseUrl,
  onOpenSettings,
  onCancel,
  onPause,
  onResume,
  onRedownload,
  onRemove,
  onClearCompleted,
  onShowItemInFolder,
  onConvertDone,
  onRepairMediaMetadata,
  onStartConvert,
  onStartNormalize,
  onStartSubtitle
}: Props) {
  const [state, setState] = useState<ProductHubState>(EMPTY)
  const [bulkUrls, setBulkUrls] = useState('')
  const [watchUrl, setWatchUrl] = useState('')
  const [storyUser, setStoryUser] = useState('')
  const [syncEmail, setSyncEmail] = useState('')
  const [syncPassword, setSyncPassword] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ configured: false, signedIn: false })
  const [syncMessage, setSyncMessage] = useState('')
  const [aiJobs, setAiJobs] = useState<AiJob[]>([])
  const [selectedAiItemId, setSelectedAiItemId] = useState('')
  const [selectedAutomationItemId, setSelectedAutomationItemId] = useState('')
  const [selectedRecipeId, setSelectedRecipeId] = useState('')
  const [automationMessage, setAutomationMessage] = useState('')
  const [autoRecipeEnabled, setAutoRecipeEnabled] = useState(false)
  const [autoRecipeId, setAutoRecipeId] = useState('')
  const [aiMessage, setAiMessage] = useState('')
  const [aiSystemReport, setAiSystemReport] = useState<AiSystemReport | null>(null)
  const [aiBenchmarks, setAiBenchmarks] = useState<Record<string, AiBenchmarkResult>>({})
  const [showAiSystemPanel, setShowAiSystemPanel] = useState(false)
  const [aiChatModels, setAiChatModels] = useState<AiChatModel[]>([])
  const [aiChatSessions, setAiChatSessions] = useState<AiChatSession[]>([])
  const [selectedAiChatId, setSelectedAiChatId] = useState('')
  const [aiChatInput, setAiChatInput] = useState('')
  const [aiChatModel, setAiChatModel] = useState('qwen2.5:7b')
  const [activeAiModel, setActiveAiModel] = useState<string | null>(null)
  const [chatAttachment, setChatAttachment] = useState<{ path: string; title: string } | null>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [streamingBySession, setStreamingBySession] = useState<Record<string, string>>({})
  const streamAliasRef = useRef<Map<string, string>>(new Map())
  const pendingStreamDisplayRef = useRef<string[]>([])
  const [activeAiChatPendingIds, setActiveAiChatPendingIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')

  useEffect(() => subscribeAiChatPending(setActiveAiChatPendingIds), [])

  useEffect(() => {
    let mounted = true
    window.api.getProductState().then(next => {
      if (mounted) setState(next)
    }).catch(err => setError(cleanError(err)))
    window.api.getSyncStatus().then(next => {
      if (mounted) setSyncStatus(next)
    }).catch(() => {})
    window.api.getSetting('automationAutoRecipe').then(value => {
      if (mounted) setAutoRecipeEnabled(Boolean(value))
    }).catch(() => {})
    window.api.getSetting('automationAutoRecipeId').then(value => {
      if (mounted) setAutoRecipeId(typeof value === 'string' ? value : '')
    }).catch(() => {})

    window.api.onProductStateUpdated(setState)
    window.api.onWatchItemsFound(({ source, items }) => {
      if (!items.length) return
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('DropMedia takip bildirimi', {
          body: `${source.label}: ${items.length} yeni içerik bulundu.`
        })
      }
    })
    return () => {
      mounted = false
      window.api.offProductListeners()
    }
  }, [])

  useEffect(() => {
    window.api.listAiJobs().then(setAiJobs).catch(() => {})
    const upsert = (job: AiJob) => {
      setAiJobs(prev => upsertAiJobStable(prev, job))
      if (job.kind === 'install' && job.status === 'done') {
        setAiMessage(`${job.title} tamamlandı.`)
        refreshAiStatus().catch(() => {})
      } else if (job.kind === 'install' && job.status === 'error') {
        setAiMessage(`${job.title} tamamlanamadı. Hata job geçmişine ve log sistemine yazıldı.`)
      } else if (job.kind === 'remove' && job.status === 'done') {
        setAiMessage(`${job.title} tamamlandı.`)
        refreshAiStatus().catch(() => {})
      } else if (job.kind === 'remove' && job.status === 'error') {
        setAiMessage(`${job.title} tamamlanamadı. Hata job geçmişine ve log sistemine yazıldı.`)
      }
    }
    window.api.onAiJobProgress(upsert)
    window.api.onAiJobComplete(upsert)
    return () => window.api.offAiJobListeners()
  }, [])

  useEffect(() => {
    if (view === 'ai') {
      refreshAiStatus().catch(() => {})
      refreshAiSystemReport().catch(() => {})
      loadActiveAiModel().catch(() => {})
    }
    if (view === 'ai-chat') {
      refreshAiStatus().catch(() => {})
      refreshAiChat().catch(err => setError(userFriendlyError(err, 'ai-chat-load')))
      loadActiveAiModel().catch(() => {})
    }
  }, [view])

  // Keep latest sessions readable inside the (mount-once) stream listener
  // without re-subscribing on every change (avoids dropping tokens mid-stream).
  const sessionsRef = useRef<AiChatSession[]>([])
  useEffect(() => { sessionsRef.current = aiChatSessions }, [aiChatSessions])

  // Claude-like live token streaming for the in-progress assistant bubble.
  useEffect(() => {
    const resolveDisplayId = (sessionId: string): string => {
      const alias = streamAliasRef.current.get(sessionId)
      if (alias) return alias
      // New chat: real session id is unknown at send time. Bind the first
      // unmatched stream to the oldest pending optimistic (draft) bubble.
      const known = sessionsRef.current.some(session => session.id === sessionId)
      if (!known) {
        const pending = pendingStreamDisplayRef.current.shift()
        if (pending) {
          streamAliasRef.current.set(sessionId, pending)
          return pending
        }
      }
      streamAliasRef.current.set(sessionId, sessionId)
      return sessionId
    }
    window.api.onAiChatToken(({ sessionId, delta }) => {
      const displayId = resolveDisplayId(sessionId)
      setStreamingBySession(prev => ({ ...prev, [displayId]: (prev[displayId] ?? '') + delta }))
    })
    // Streamed text stays visible until sendAiChat resolves and swaps in the
    // persisted session (it clears the entry after listAiChatSessions()).
    window.api.onAiChatDone(() => {})
    return () => window.api.offAiChatStream()
  }, [])

  const completed = useMemo(() => historyItems.filter(item => item.status === 'completed'), [historyItems])
  const completedWithFiles = useMemo(() => completed.filter(item => !!item.outputPath), [completed])
  const selectedAiItem = useMemo(
    () => completedWithFiles.find(item => item.id === selectedAiItemId) ?? completedWithFiles[0],
    [completedWithFiles, selectedAiItemId]
  )
  const selectedAutomationItem = useMemo(
    () => completedWithFiles.find(item => item.id === selectedAutomationItemId) ?? completedWithFiles[0],
    [completedWithFiles, selectedAutomationItemId]
  )
  const selectedAiChatModelInfo = useMemo(
    () => aiChatModels.find(model => model.id === aiChatModel),
    [aiChatModels, aiChatModel]
  )
  const selectedRecipe = useMemo(
    () => state.recipes.find(recipe => recipe.id === selectedRecipeId) ?? state.recipes[0],
    [state.recipes, selectedRecipeId]
  )
  const recipeById = useMemo(
    () => new Map(state.recipes.map(recipe => [recipe.id, recipe])),
    [state.recipes]
  )
  const activeAiJobs = useMemo(
    () => aiJobs.filter(job => job.status === 'running' || job.status === 'paused'),
    [aiJobs]
  )
  const activeInstallByTool = useMemo(
    () => activeToolJobMap(activeAiJobs, 'install'),
    [activeAiJobs]
  )
  const activeRepairByTool = useMemo(
    () => activeToolJobMap(activeAiJobs, 'repair'),
    [activeAiJobs]
  )
  const activeRemoveByTool = useMemo(
    () => activeToolJobMap(activeAiJobs, 'remove'),
    [activeAiJobs]
  )
  const activeBenchmarkByTool = useMemo(
    () => activeToolJobMap(activeAiJobs, 'benchmark'),
    [activeAiJobs]
  )
  const activeInstallJobs = useMemo(
    () => activeAiJobs
      .filter(job => job.kind === 'install' || job.kind === 'repair')
      .sort((a, b) => a.createdAt - b.createdAt),
    [activeAiJobs]
  )
  const historyAiJobs = useMemo(
    () => aiJobs.filter(job => !((job.kind === 'install' || job.kind === 'repair') && (job.status === 'running' || job.status === 'paused'))),
    [aiJobs]
  )
  const selectedAiChat = useMemo(
    () => selectedAiChatId && selectedAiChatId !== NEW_AI_CHAT_ID
      ? aiChatSessions.find(session => session.id === selectedAiChatId)
      : undefined,
    [aiChatSessions, selectedAiChatId]
  )
  const selectedAiChatBusy = selectedAiChat ? activeAiChatPendingIds.has(selectedAiChat.id) : activeAiChatPendingIds.has(selectedAiChatId)
  // Merge any live-streamed delta into the last assistant bubble for rendering.
  const selectedAiChatMessages = useMemo(() => {
    const base = selectedAiChat?.messages ?? []
    const streamed = selectedAiChat ? streamingBySession[selectedAiChat.id] : undefined
    if (streamed === undefined) return base
    const last = base[base.length - 1]
    if (last && last.role === 'assistant') {
      return [...base.slice(0, -1), { ...last, content: streamed || last.content }]
    }
    return base
  }, [selectedAiChat, streamingBySession])
  // Downloaded library videos that have a local file path, for @-mention RAG.
  const mentionItems = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase()
    const items = completedWithFiles.filter(item => !!item.outputPath)
    if (!query) return items.slice(0, 8)
    return items.filter(item => itemTitle(item).toLowerCase().includes(query)).slice(0, 8)
  }, [completedWithFiles, mentionQuery])
  const inboxReady = state.inbox.filter(item => item.status === 'checked' && item.preflight?.ok).length
  const newWatchItems = state.watchItems.filter(item => item.status === 'new').length
  const privateNeedsCookie = state.inbox.some(item => item.preflight?.needsCookies)
  const meta = VIEW_META[view]
  const syncReady = syncStatus.configured && (syncStatus.health?.ok ?? true)
  const syncAction = !syncStatus.configured
    ? 'kapalı'
    : syncStatus.signedIn
      ? syncStatus.email
      : syncStatus.health?.ok === false
        ? syncStatus.health.status === 'schema_missing' ? 'schema eksik' : 'bağlantı yok'
        : 'Supabase hazır'

  async function refresh() {
    setState(await window.api.getProductState())
  }

  async function refreshSyncStatus() {
    const result = await run('sync-status', () => window.api.getSyncStatus())
    if (result) setSyncStatus(result)
  }

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError('')
    setBusy(prev => ({ ...prev, [key]: true }))
    try {
      const result = await fn()
      await refresh().catch(() => {})
      return result
    } catch (err) {
      const friendly = userFriendlyError(err, key)
      setError(friendly)
      logClientError(err, key, friendly)
      return undefined
    } finally {
      setBusy(prev => ({ ...prev, [key]: false }))
    }
  }

  async function addInbox() {
    const urls = splitUrls(bulkUrls)
    if (!urls.length) {
      setError('En az bir URL girin.')
      return
    }
    const added = await run('inbox-add', () => window.api.addInboxUrls(urls, 'manual'))
    if (added) setBulkUrls('')
  }

  async function syncAuth(mode: 'signin' | 'signup') {
    setSyncMessage('')
    const result = await run(`sync-${mode}`, () => mode === 'signin'
      ? window.api.signInSync(syncEmail.trim(), syncPassword)
      : window.api.signUpSync(syncEmail.trim(), syncPassword))
    if (result) {
      setSyncStatus(result)
      setSyncPassword('')
      setSyncMessage(result.notice ?? (mode === 'signin' ? 'Giriş yapıldı.' : 'Kayıt oluşturuldu ve giriş yapıldı.'))
    }
  }

  async function syncPush() {
    setSyncMessage('')
    const result = await run('sync-push', () => window.api.pushProductState(state))
    if (result) setSyncMessage(`Yedeklendi: ${new Date(result.syncedAt).toLocaleString('tr-TR')}`)
  }

  async function syncPull() {
    setSyncMessage('')
    const result = await run('sync-pull', () => window.api.pullProductState())
    if (!result?.data) {
      setSyncMessage('Supabase tarafında kayıtlı merkez verisi yok.')
      return
    }
    const imported = await run('sync-import', () => window.api.importProductState(result.data!))
    if (imported) {
      setState(imported)
      setSyncMessage(`Geri yüklendi${result.syncedAt ? `: ${new Date(result.syncedAt).toLocaleString('tr-TR')}` : '.'}`)
    }
  }

  async function syncSignOut() {
    const result = await run('sync-signout', () => window.api.signOutSync())
    if (result) {
      setSyncStatus(result)
      setSyncMessage('Çıkış yapıldı.')
    }
  }

  async function addStoryShortcut() {
    const user = storyUser.trim().replace(/^@/, '').replace(/\/+$/, '')
    if (!user) {
      setError('Instagram kullanıcı adı girin.')
      return
    }
    await run('story-add', () => window.api.addInboxUrls(`https://www.instagram.com/stories/${user}/`, 'manual'))
    setStoryUser('')
  }

  async function checkInbox(item: LinkInboxItem) {
    await run(`inbox-check-${item.id}`, () => window.api.checkInboxItem(item.id))
  }

  async function queueInbox(item: LinkInboxItem) {
    await run(`inbox-queue-${item.id}`, () => window.api.updateInboxItem(item.id, { status: 'queued' }))
    onUseUrl(item.url)
  }

  async function addWatch() {
    const url = watchUrl.trim()
    if (!url) {
      setError('Takip kaynağı için URL veya @kullanıcı girin.')
      return
    }
    const source = await run('watch-add', () => window.api.addWatchSource({
      url,
      intervalMinutes: 30,
      action: 'notify',
      defaultFormat: 'best'
    }))
    if (source) setWatchUrl('')
  }

  async function checkWatch(source: WatchSource) {
    await run(`watch-check-${source.id}`, () => window.api.checkWatchSource(source.id))
  }

  async function refreshAiStatus() {
    const statuses = await window.api.getAiToolsStatus()
    const statusById = new Map(statuses.map(status => [status.id, status]))
    const current = await window.api.getProductState()
    const nextTools = current.aiTools.map(tool => {
      const status = statusById.get(tool.id)
      return status ? { ...tool, installed: status.installed, statusDetail: status.detail, statusVersion: status.version } : tool
    })
    const changed = nextTools.some((tool, index) => tool.installed !== current.aiTools[index]?.installed)
    if (changed) await window.api.setAiTools(nextTools)
    setState({ ...current, aiTools: nextTools })
  }

  async function refreshAiSystemReport() {
    const report = await window.api.getAiSystemReport()
    setAiSystemReport(report)
  }

  async function refreshAiChat() {
    const [models, sessions] = await Promise.all([
      window.api.listAiChatModels(),
      window.api.listAiChatSessions()
    ])
    setAiChatModels(models)
    setAiChatSessions(sessions)
    const active = await window.api.getActiveAiModel().catch(() => null)
    setActiveAiModel(active)
    const preferred = aiChatModel && models.some(model => model.id === aiChatModel)
      ? aiChatModel
      : (active && models.some(model => model.id === active) ? active : models[0]?.id)
    if (preferred && preferred !== aiChatModel) setAiChatModel(preferred)
    if (selectedAiChatId !== NEW_AI_CHAT_ID && sessions.length && !sessions.some(session => session.id === selectedAiChatId)) setSelectedAiChatId(sessions[0].id)
    if (selectedAiChatId !== NEW_AI_CHAT_ID && !sessions.length) setSelectedAiChatId('')
  }

  async function loadActiveAiModel() {
    const active = await window.api.getActiveAiModel().catch(() => null)
    setActiveAiModel(active)
    if (active && (!aiChatModel || aiChatModel === 'qwen2.5:7b')) setAiChatModel(active)
  }

  async function chooseActiveAiModel(id: string) {
    if (!id) return
    const previous = activeAiModel
    setActiveAiModel(id)
    setAiChatModel(id)
    try {
      const confirmed = await window.api.setActiveAiModel(id)
      setActiveAiModel(confirmed)
      setAiChatModel(confirmed)
      setAiMessage(`Aktif model: ${modelLabelById(aiChatModels, confirmed)}`)
    } catch (err) {
      setActiveAiModel(previous)
      const friendly = userFriendlyError(err, 'ai-active-model-set')
      setError(friendly)
      logClientError(err, 'ai-active-model-set', friendly)
    }
  }

  async function benchmarkAiTool(tool: AiToolState) {
    const result = await run(`ai-benchmark-${tool.id}`, () => window.api.benchmarkAiTool(tool.id))
    if (!result) return
    setAiBenchmarks(prev => ({ ...prev, [tool.id]: result }))
    setAiMessage(result.ok
      ? `${tool.label} benchmark: ${result.rating} · ${formatMs(result.elapsedMs)}`
      : `${tool.label} benchmark tamamlanamadı: ${result.message}`)
  }

  async function installAiTool(tool: AiToolState, mode: 'install' | 'repair' = 'install') {
    if (isManagedInstallUnavailable(tool)) {
      const message = managedInstallUnavailableMessage(tool)
      setError(message)
      setAiMessage(message)
      return
    }

    const existing = activeInstallByTool.get(tool.id) ?? activeRepairByTool.get(tool.id)
    if (existing) {
      setAiMessage(`${tool.label} işlemi zaten çalışıyor. Mevcut job takip ediliyor.`)
      setAiJobs(prev => mergeAiJobs([existing], prev))
      return
    }

    setAiMessage(mode === 'repair' ? `${tool.label} onarımı başlatılıyor...` : `${tool.label} kurulumu başlatılıyor...`)
    const result = await run(`ai-install-${tool.id}`, () => window.api.installAiTool(tool.id))
    if (!result) return

    setAiMessage(result.existing ? `${tool.label} işlemi zaten çalışıyor. Mevcut job takip ediliyor.` : `${tool.label} ${mode === 'repair' ? 'onarımı' : 'kurulumu'} çalışıyor. İlerleme aşağıdaki job panelinde görünecek.`)
    await window.api.listAiJobs().then(next => {
      setAiJobs(prev => mergeAiJobs(next, prev.filter(job => job.id !== result.jobId)))
    }).catch(() => {})
  }

  async function installAiModel(model: AiChatModel) {
    const tool = state.aiTools.find(item => item.id === 'ollama')
    const existing = activeInstallByTool.get('ollama') ?? activeRepairByTool.get('ollama')
    if (existing) {
      setAiMessage(`Ollama işlemi zaten çalışıyor. Mevcut job takip ediliyor.`)
      setAiJobs(prev => mergeAiJobs([existing], prev))
      return
    }
    if (model.installed) {
      setAiMessage(`${model.id} modeli zaten kurulu.`)
      return
    }

    setAiMessage(`${model.id} modeli indiriliyor...`)
    const result = await run(`ai-model-install-${model.id}`, () => window.api.installAiModel(model.id))
    if (!result) return
    if (tool && !tool.enabled) {
      await window.api.setAiTools(state.aiTools.map(item => item.id === 'ollama' ? { ...item, enabled: true, installApproved: true } : item)).catch(() => state.aiTools)
    }
    setAiMessage(result.existing ? 'Ollama kurulumu zaten çalışıyor. Mevcut job takip ediliyor.' : `${model.id} kurulumu çalışıyor. İlerleme job panelinde görünecek.`)
    await Promise.all([
      window.api.listAiJobs().then(next => setAiJobs(prev => mergeAiJobs(next, prev))).catch(() => {}),
      refreshAiStatus().catch(() => {}),
      refreshAiChat().catch(() => {})
    ])
  }

  async function installAllAiModels() {
    const existing = activeInstallByTool.get('ollama') ?? activeRepairByTool.get('ollama')
    if (existing) {
      setAiMessage('Ollama işlemi zaten çalışıyor. Mevcut job takip ediliyor.')
      setAiJobs(prev => mergeAiJobs([existing], prev))
      return
    }

    setAiMessage('Tüm Ollama modelleri indiriliyor...')
    const result = await run('ai-model-install-all', () => window.api.installAllAiModels())
    if (!result) return
    setAiMessage(result.existing ? 'Ollama kurulumu zaten çalışıyor. Mevcut job takip ediliyor.' : 'Tüm model kurulumu çalışıyor. İlerleme job panelinde görünecek.')
    await Promise.all([
      window.api.listAiJobs().then(next => setAiJobs(prev => mergeAiJobs(next, prev))).catch(() => {}),
      refreshAiStatus().catch(() => {}),
      refreshAiChat().catch(() => {})
    ])
  }

  async function repairAiTool(tool: AiToolState) {
    if (isManagedInstallUnavailable(tool)) {
      const message = managedInstallUnavailableMessage(tool)
      setError(message)
      setAiMessage(message)
      return
    }

    const existing = activeRepairByTool.get(tool.id) ?? activeInstallByTool.get(tool.id)
    if (existing) {
      setAiMessage(`${tool.label} onarımı zaten çalışıyor. Mevcut job takip ediliyor.`)
      setAiJobs(prev => mergeAiJobs([existing], prev))
      return
    }

    setAiMessage(`${tool.label} teşhis ve onarım başlatılıyor...`)
    const result = await run(`ai-repair-${tool.id}`, () => window.api.repairAiTool(tool.id))
    if (result) {
      setAiMessage(result.existing ? `${tool.label} işlemi zaten çalışıyor. Mevcut job takip ediliyor.` : `${tool.label} onarımı çalışıyor. Eksik/bozuk parça varsa sadece o parça düzeltilecek.`)
      await window.api.listAiJobs().then(next => setAiJobs(prev => mergeAiJobs(next, prev))).catch(() => {})
    }
  }

  async function removeAiTool(tool: AiToolState) {
    const existing = activeRemoveByTool.get(tool.id)
    if (existing) {
      setAiMessage(`${tool.label} model kaldırma zaten çalışıyor. Mevcut job takip ediliyor.`)
      setAiJobs(prev => mergeAiJobs([existing], prev))
      return
    }

    const ok = window.confirm(`${tool.label} model verileri kaldırılacak. Araç daha sonra tekrar indirilebilir. Devam edilsin mi?`)
    if (!ok) return

    setAiMessage(`${tool.label} model kaldırma başlatılıyor...`)
    const pendingId = `pending-remove-${tool.id}-${Date.now()}`
    const pendingJob: AiJob = {
      id: pendingId,
      kind: 'remove',
      title: `${tool.label} model kaldırma`,
      status: 'running',
      percent: null,
      message: 'Main process job başlatılıyor...',
      toolId: tool.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setAiJobs(prev => [pendingJob, ...prev].slice(0, 80))

    const result = await run(`ai-remove-${tool.id}`, () => window.api.removeAiTool(tool.id))
    if (result) {
      setAiMessage(result.existing ? `${tool.label} model kaldırma zaten çalışıyor. Mevcut job takip ediliyor.` : `${tool.label} model kaldırma çalışıyor. İlerleme job panelinde görünecek.`)
      await window.api.listAiJobs().then(next => {
        setAiJobs(prev => mergeAiJobs(next, prev.filter(job => job.id !== pendingId && job.id !== result.jobId)))
      }).catch(() => {})
      return
    }

    setAiJobs(prev => prev.map(job => job.id === pendingId ? {
      ...job,
      status: 'error',
      message: '',
      error: 'Model kaldırma job’u başlatılamadı. Üstteki hata mesajını kontrol edin.',
      updatedAt: Date.now()
    } : job))
  }

  async function pauseAiJob(job: AiJob) {
    await run(`ai-pause-${job.id}`, () => window.api.pauseAiJob(job.id))
  }

  async function resumeAiJob(job: AiJob) {
    await run(`ai-resume-${job.id}`, () => window.api.resumeAiJob(job.id))
  }

  async function toggleAi(tool: AiToolState) {
    const enabled = !tool.enabled
    if (enabled && isManagedInstallUnavailable(tool)) {
      const message = managedInstallUnavailableMessage(tool)
      setError(message)
      setAiMessage(message)
      return
    }

    const nextTool = { ...tool, enabled }
    if (enabled && !tool.installApproved) {
      const ok = window.confirm(`${tool.label} ücretsiz local çalışır ama model/paket indirir (${tool.sizeHint}). Şimdi izin vermezsen AI özellikleri kapalı kalır; sonra buradan açabilirsin.`)
      if (!ok) {
        window.alert('AI özellikleri kapalı kaldı. İstediğin zaman AI bölümünden açabilirsin.')
        return
      }
      nextTool.installApproved = true
    }
    const next = state.aiTools.map(item => item.id === tool.id ? nextTool : item)
    await run(`ai-${tool.id}`, () => window.api.setAiTools(next))
    if (enabled && !tool.installed) await installAiTool(nextTool)
  }

  async function startAiAction(kind: AiActionKind) {
    if (!selectedAiItem?.outputPath) {
      setError('AI işlemi için tamamlanmış local dosya seçin.')
      return
    }
    await run(`ai-job-${kind}`, () => window.api.startAiJob({
      kind,
      inputPath: selectedAiItem.outputPath!,
      title: itemTitle(selectedAiItem)
    }))
  }

  async function sendAiChat(override?: { message?: string; sessionId?: string }) {
    const message = (override?.message ?? aiChatInput).trim()
    const targetSession = override?.sessionId
      ? aiChatSessions.find(session => session.id === override.sessionId)
      : selectedAiChat
    const targetBusy = targetSession ? activeAiChatPendingIds.has(targetSession.id) : selectedAiChatBusy
    if (!message || targetBusy) return
    const model = aiChatModel || activeAiModel || aiChatModels[0]?.id || 'qwen2.5:7b'
    const requestSessionId = targetSession?.id
    const optimisticId = requestSessionId ?? `draft-chat-${Date.now()}`
    const now = Date.now()
    // Attachment: @-mention selection takes priority, then any sticky session attachment.
    const attachmentPath = chatAttachment?.path ?? targetSession?.attachmentPath
    const attachmentTitle = chatAttachment?.title ?? targetSession?.attachmentTitle
    const userMessage: AiChatSession['messages'][number] = {
      id: `draft-user-${now}`,
      role: 'user',
      content: message,
      createdAt: now,
      model
    }
    const pendingMessage: AiChatSession['messages'][number] = {
      id: `draft-assistant-${now}`,
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      model
    }
    const optimisticSession: AiChatSession = {
      id: optimisticId,
      title: targetSession?.title ?? (message.slice(0, 48) || 'Yeni Sohbet'),
      model,
      attachmentPath,
      attachmentTitle,
      messages: [...(targetSession?.messages ?? []), userMessage, pendingMessage],
      createdAt: targetSession?.createdAt ?? now,
      updatedAt: now
    }

    // Route streamed tokens into this bubble. Existing session -> alias by real
    // id; new chat -> queue the draft id, bound when the first token arrives.
    if (requestSessionId) streamAliasRef.current.set(requestSessionId, optimisticId)
    else pendingStreamDisplayRef.current.push(optimisticId)
    setStreamingBySession(prev => ({ ...prev, [optimisticId]: '' }))

    setAiChatPending([optimisticId, requestSessionId ?? ''], true)
    setError('')
    setAiChatInput('')
    setMentionOpen(false)
    setSelectedAiChatId(optimisticId)
    setAiChatSessions(prev => upsertChatSessionStable(prev, optimisticSession))
    try {
      const result = await window.api.sendAiChatMessage({
        sessionId: requestSessionId,
        message,
        model,
        attachmentPath,
        attachmentTitle
      })
      if (result.removed) {
        const sessions = await window.api.listAiChatSessions()
        setAiChatSessions(sessions)
        return
      }
      setSelectedAiChatId(result.session.id)
      const sessions = await window.api.listAiChatSessions()
      setAiChatSessions(sessions)
      // Persisted answer is now in the session list; drop the live stream copy.
      setStreamingBySession(prev => {
        const next = { ...prev }
        delete next[optimisticId]
        delete next[result.session.id]
        return next
      })
      if (result.action) {
        await window.api.listAiJobs().then(setAiJobs).catch(() => {})
      }
    } catch (err) {
      const friendly = userFriendlyError(err, 'ai-chat-send')
      setError(friendly)
      // Read the latest streamed text (functional updater avoids a stale closure),
      // keep any partial answer, then drop the live copy.
      setStreamingBySession(prev => {
        const streamed = (prev[optimisticId] ?? '').trim()
        setAiChatSessions(sessions => upsertChatSessionStable(sessions, {
          ...optimisticSession,
          messages: [
            ...optimisticSession.messages.slice(0, -1),
            { ...pendingMessage, content: streamed ? `${streamed}\n\n${friendly}` : friendly }
          ],
          updatedAt: Date.now()
        }))
        const next = { ...prev }
        delete next[optimisticId]
        return next
      })
      logClientError(err, 'ai-chat-send', friendly)
    } finally {
      setAiChatPending([optimisticId, requestSessionId ?? ''], false)
      setChatAttachment(null)
      // Drop alias entries bound to this send so a later message in the same
      // (now-persisted) session is not routed to a stale draft bubble id.
      for (const [key, value] of streamAliasRef.current) {
        if (value === optimisticId) streamAliasRef.current.delete(key)
      }
      pendingStreamDisplayRef.current = pendingStreamDisplayRef.current.filter(id => id !== optimisticId)
    }
  }

  async function stopAiChat() {
    const sessionId = selectedAiChat?.id ?? selectedAiChatId
    try {
      // draft-* (henüz sunucuya kaydolmamış yeni sohbet) id'leri sunucu job key'iyle
      // eşleşmez; bu durumda undefined geçip sunucunun "tüm chat'leri durdur" dalına düş.
      const persisted = sessionId && sessionId !== NEW_AI_CHAT_ID && !sessionId.startsWith('draft-')
      await window.api.stopAiChat(persisted ? sessionId : undefined)
    } catch (err) {
      logClientError(err, 'ai-chat-stop', cleanError(err))
    }
  }

  async function regenerateAiChat() {
    const session = selectedAiChat
    if (!session || activeAiChatPendingIds.has(session.id)) return
    const lastUser = [...session.messages].reverse().find(msg => msg.role === 'user')
    if (!lastUser) return
    // Drop the trailing assistant reply (if any) optimistically before re-asking.
    const trimmed = session.messages[session.messages.length - 1]?.role === 'assistant'
      ? session.messages.slice(0, -1)
      : session.messages
    setAiChatSessions(prev => upsertChatSessionStable(prev, { ...session, messages: trimmed.slice(0, -1), updatedAt: Date.now() }))
    await sendAiChat({ message: lastUser.content, sessionId: session.id })
  }

  function handleChatInputChange(value: string) {
    setAiChatInput(value)
    const token = activeMentionToken(value)
    if (token === null) {
      if (mentionOpen) setMentionOpen(false)
      return
    }
    setMentionQuery(token)
    setMentionOpen(true)
  }

  function selectMention(item: DownloadItem) {
    const title = itemTitle(item)
    if (item.outputPath) setChatAttachment({ path: item.outputPath, title })
    // Replace the trailing "@query" fragment with a readable @mention label.
    setAiChatInput(prev => prev.replace(/@[^\s@]*$/, `@${title} `))
    setMentionOpen(false)
    setMentionQuery('')
  }

  async function newAiChat() {
    setSelectedAiChatId(NEW_AI_CHAT_ID)
    setAiChatInput('')
    setChatAttachment(null)
    setMentionOpen(false)
  }

  async function deleteAiChat(sessionId: string) {
    const next = await run(`ai-chat-delete-${sessionId}`, () => window.api.deleteAiChatSession(sessionId))
    if (!next) return
    setAiChatSessions(next)
    if (selectedAiChatId === sessionId) setSelectedAiChatId(next[0]?.id ?? NEW_AI_CHAT_ID)
  }

  async function clearAiChat() {
    const next = await run('ai-chat-clear', () => window.api.clearAiChatSessions())
    if (!next) return
    setAiChatSessions(next)
    setSelectedAiChatId(NEW_AI_CHAT_ID)
    setAiChatInput('')
  }

  async function retryAiJob(job: AiJob) {
    if (job.kind === 'install' && job.toolId) {
      const tool = state.aiTools.find(item => item.id === job.toolId)
      if (tool) await installAiTool(tool)
      return
    }
    if (job.kind === 'repair' && job.toolId) {
      const tool = state.aiTools.find(item => item.id === job.toolId)
      if (tool) await repairAiTool(tool)
      return
    }
    if (job.kind === 'remove' && job.toolId) {
      const tool = state.aiTools.find(item => item.id === job.toolId)
      if (tool) await removeAiTool(tool)
      return
    }
    if (!job.inputPath || !isAiActionKind(job.kind)) return
    const kind = job.kind
    await run(`ai-retry-${job.id}`, () => window.api.startAiJob({
      kind,
      inputPath: job.inputPath!,
      title: job.title
    }))
  }

  async function runRecipe() {
    if (!selectedAutomationItem?.outputPath || !selectedRecipe) {
      setError('Otomasyon için tamamlanmış bir dosya ve iş akışı seçin.')
      return
    }

    const result = await run('recipe-run', async () => {
      const started: PostProcessRecipe['steps'] = []
      const skipped: PostProcessRecipe['steps'] = []

      for (const step of selectedRecipe.steps) {
        const ok = await runRecipeStep(step, selectedRecipe, selectedAutomationItem, started, skipped)
        if (!ok) skipped.push(step)
      }

      return { started, skipped }
    })

    if (result) {
      const startedText = result.started.length ? `Başlatıldı: ${result.started.map(recipeStepLabel).join(', ')}` : 'Başlatılan adım yok.'
      const skippedText = result.skipped.length ? ` Atlandı: ${Array.from(new Set(result.skipped)).map(recipeStepLabel).join(', ')}` : ''
      setAutomationMessage(startedText + skippedText)
    }
  }

  async function deleteAiJob(job: AiJob) {
    if (!hasAiHistoryApi('deleteAiJob')) {
      setError('AI geçmişi silme servisi henüz yüklenmemiş. DropMedia uygulamasını tamamen kapatıp yeniden açın, sonra tekrar deneyin.')
      return
    }
    setBusy(prev => ({ ...prev, [`ai-delete-${job.id}`]: true }))
    setError('')
    try {
      const next = await window.api.deleteAiJob(job.id)
      setAiJobs(next)
      setAiMessage('AI job kaydı silindi.')
    } catch (err) {
      const friendly = userFriendlyError(err, `ai-delete-${job.id}`)
      setError(friendly)
      logClientError(err, `ai-delete-${job.id}`, friendly)
    } finally {
      setBusy(prev => ({ ...prev, [`ai-delete-${job.id}`]: false }))
    }
  }

  async function clearAiJobs() {
    if (!hasAiHistoryApi('clearAiJobs')) {
      setError('AI geçmişi temizleme servisi henüz yüklenmemiş. DropMedia uygulamasını tamamen kapatıp yeniden açın, sonra tekrar deneyin.')
      return
    }
    setBusy(prev => ({ ...prev, 'ai-clear-jobs': true }))
    setError('')
    try {
      const next = await window.api.clearAiJobs()
      setAiJobs(next)
      setAiMessage(next.length ? 'Biten AI job kayıtları temizlendi; çalışan işler korundu.' : 'AI job geçmişi temizlendi.')
    } catch (err) {
      const friendly = userFriendlyError(err, 'ai-clear-jobs')
      setError(friendly)
      logClientError(err, 'ai-clear-jobs', friendly)
    } finally {
      setBusy(prev => ({ ...prev, 'ai-clear-jobs': false }))
    }
  }

  async function runRecipeStep(
    step: PostProcessRecipe['steps'][number],
    recipe: PostProcessRecipe,
    item: DownloadItem,
    started: string[],
    skipped: string[]
  ): Promise<boolean> {
    const inputPath = item.outputPath
    if (!inputPath) return false
    const title = itemTitle(item)

    if (step === 'metadata' || step === 'thumbnail') {
      if (!onRepairMediaMetadata) return false
      await onRepairMediaMetadata(item.id)
      started.push(step)
      return true
    }

    if (step === 'transcript') {
      await window.api.startAiJob({ kind: 'transcript', inputPath, title })
      started.push(step)
      return true
    }

    if (step === 'compress') {
      if (!onStartConvert) return false
      await onStartConvert({
        inputPath,
        outputPath: derivativePath(inputPath, 'compressed', 'mp4'),
        outputFormat: recipe.format ?? 'mp4',
        title
      })
      started.push(step)
      return true
    }

    if (step === 'subtitle-save' || step === 'subtitle-soft' || step === 'subtitle-burn') {
      if (!onStartSubtitle) return false
      const mode = step === 'subtitle-save' ? 'save' : step === 'subtitle-soft' ? 'soft' : 'burn'
      const ext = mode === 'save' ? 'srt' : 'mp4'
      const suffix = mode === 'save' ? 'subs' : mode === 'soft' ? 'softsubs' : 'burnedsubs'
      const cookieBrowser = await window.api.getSetting('cookieBrowser').catch(() => undefined) as string | undefined
      await onStartSubtitle({
        inputPath,
        outputPath: derivativePath(inputPath, suffix, ext),
        mode,
        style: DEFAULT_SUBTITLE_STYLE,
        url: item.url,
        lang: 'auto',
        cookieBrowser,
        title
      })
      started.push(step)
      return true
    }

    if (step === 'audio-normalize') {
      if (!onStartNormalize) return false
      await onStartNormalize({
        inputPath,
        outputPath: derivativePath(inputPath, 'normalized', outputExtension(inputPath, recipe.format)),
        title
      })
      started.push(step)
      return true
    }

    return false
  }

  async function setAutoRecipe(enabled: boolean) {
    setAutoRecipeEnabled(enabled)
    await run('automation-auto-toggle', () => window.api.setSetting('automationAutoRecipe', enabled))
  }

  async function setAutoRecipeSelection(recipeId: string) {
    setAutoRecipeId(recipeId)
    await run('automation-auto-recipe', () => window.api.setSetting('automationAutoRecipeId', recipeId))
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {error && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-200/70">DropMedia</p>
        <h1 className="mt-1 text-2xl font-bold text-white">{meta.title}</h1>
        <p className="mt-1 text-sm text-white/45">{meta.description}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Linkler" value={state.inbox.length} sub={`${inboxReady} hazır`} />
        <Metric label="Takip" value={state.watchSources.length} sub={`${newWatchItems} yeni`} />
        <Metric label="Kütüphane" value={completed.length + state.library.length} sub="local kayıt" />
        <Metric label="AI" value={state.aiTools.filter(t => t.enabled).length} sub="opsiyonel local" />
      </div>

      {view === 'account' && <Panel title="Hesap ve Sync" action={syncAction}>
        {syncStatus.configured ? (
          <div className="space-y-3">
            {syncStatus.health?.ok === false && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {syncStatus.health.message ?? syncStatus.error ?? 'Supabase bağlantısı doğrulanamadı.'}
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              {syncStatus.signedIn ? (
                <div>
                  <p className="text-sm text-white/75">Giriş: {syncStatus.email}</p>
                  <p className="text-xs text-white/35">Linkler, takip kaynakları, otomasyon akışları, AI ayarları ve kütüphane kayıtları manuel yedeklenip geri alınır.</p>
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  <input
                    value={syncEmail}
                    onChange={(event) => setSyncEmail(event.target.value)}
                    placeholder="e-posta"
                    className="rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-500/50"
                  />
                  <input
                    value={syncPassword}
                    onChange={(event) => setSyncPassword(event.target.value)}
                    type="password"
                    placeholder="şifre"
                    className="rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-500/50"
                  />
                </div>
              )}
              {syncMessage && <p className="text-xs text-emerald-300/80">{syncMessage}</p>}
              {syncStatus.emailConfirmationRequired && (
                <p className="text-xs text-amber-200/80">E-posta onayı tamamlanmadan giriş yapılamaz.</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <button onClick={refreshSyncStatus} disabled={busy['sync-status']} className="secondary-btn">Kontrol Et</button>
              {syncStatus.signedIn ? (
                <>
                  <button onClick={syncPush} disabled={busy['sync-push'] || !syncReady} className="primary-btn">Supabase'e Yedekle</button>
                  <button onClick={syncPull} disabled={busy['sync-pull'] || !syncReady} className="secondary-btn">Geri Yükle</button>
                  <button onClick={syncSignOut} className="danger-btn">Çıkış</button>
                </>
              ) : (
                <>
                  <button onClick={() => syncAuth('signin')} disabled={busy['sync-signin'] || !syncReady} className="primary-btn">Giriş</button>
                  <button onClick={() => syncAuth('signup')} disabled={busy['sync-signup'] || !syncReady} className="secondary-btn">Kayıt</button>
                </>
              )}
            </div>
          </div>
          </div>
        ) : (
          <p className="text-sm text-white/45">Supabase env yok. Sync, hesap ve cloud ayar yedekleme devre dışı.</p>
        )}
      </Panel>}

      {view === 'links' && privateNeedsCookie && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-amber-100">Cookie gerekli özel bağlantı var</p>
            <p className="text-xs text-amber-200/60">Instagram gizli reel, highlight veya story için giriş yaptığın tarayıcı profilini seç.</p>
          </div>
          <button onClick={onOpenSettings} className="shrink-0 rounded-lg bg-amber-400/15 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/25">
            Gizlilik Ayarları
          </button>
        </div>
      )}

      {view === 'links' && <section className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
        <Panel title="Link Inbox" action={`${state.inbox.length} kayıt`}>
          <div className="space-y-3">
            <textarea
              value={bulkUrls}
              onChange={(event) => setBulkUrls(event.target.value)}
              placeholder="Bir veya çoklu URL yapıştır..."
              className="h-24 w-full resize-none rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-500/50"
            />
            <div className="flex flex-wrap gap-2">
              <button onClick={addInbox} disabled={busy['inbox-add']} className="primary-btn">
                Inbox'a Ekle
              </button>
              <button
                onClick={() => state.inbox.filter(i => i.status === 'new' || i.status === 'error').slice(0, 10).forEach(checkInbox)}
                className="secondary-btn"
              >
                İlk 10'u Kontrol Et
              </button>
            </div>

            <div className="space-y-2">
              {state.inbox.slice(0, 8).map(item => (
                <InboxRow
                  key={item.id}
                  item={item}
                  busy={!!busy[`inbox-check-${item.id}`] || !!busy[`inbox-queue-${item.id}`]}
                  onCheck={() => checkInbox(item)}
                  onQueue={() => queueInbox(item)}
                  onIgnore={() => run(`inbox-ignore-${item.id}`, () => window.api.updateInboxItem(item.id, { status: 'ignored' }))}
                  onRemove={() => run(`inbox-remove-${item.id}`, () => window.api.removeInboxItem(item.id))}
                />
              ))}
              {state.inbox.length === 0 && <Empty text="Inbox boş. URL yapıştırarak preflight ve tek tık kuyruk başlat." />}
            </div>
          </div>
        </Panel>

        <Panel title="Instagram Story / Highlight" action="cookie destekli">
          <div className="space-y-3">
            <p className="text-sm text-white/55">
              Highlight URL'leri direkt çalışır. 24 saatlik story için varsa tam story URL'sini inbox'a ekle; sadece kullanıcı adı biliyorsan aşağıdaki kısayol story endpoint'ini dener.
            </p>
            <div className="flex gap-2">
              <input
                value={storyUser}
                onChange={(event) => setStoryUser(event.target.value)}
                placeholder="@kullanici"
                className="min-w-0 flex-1 rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-500/50"
              />
              <button onClick={addStoryShortcut} className="secondary-btn">Dene</button>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-xs text-white/40">
              Gizli hesaplarda bu bölüm cookie olmadan bilinçli olarak başarısız olur; bu doğru güvenlik davranışı.
            </div>
          </div>
        </Panel>
      </section>}

      {view === 'watch' && <section className="grid gap-4 lg:grid-cols-[.95fr_1.05fr]">
        <Panel title="Takip Merkezi" action={`${state.watchSources.length} kaynak`}>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                value={watchUrl}
                onChange={(event) => setWatchUrl(event.target.value)}
                placeholder="YouTube playlist, Instagram highlight, X/Twitter URL veya @instagram"
                className="min-w-0 flex-1 rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-500/50"
              />
              <button onClick={addWatch} disabled={busy['watch-add']} className="primary-btn">Takibe Al</button>
            </div>

            <div className="space-y-2">
              {state.watchSources.map(source => (
                <WatchSourceRow
                  key={source.id}
                  source={source}
                  busy={!!busy[`watch-check-${source.id}`]}
                  onCheck={() => checkWatch(source)}
                  onToggle={() => run(`watch-toggle-${source.id}`, () => window.api.updateWatchSource(source.id, { enabled: !source.enabled }))}
                  onAction={(action) => run(`watch-action-${source.id}`, () => window.api.updateWatchSource(source.id, { action }))}
                  onRemove={() => run(`watch-remove-${source.id}`, () => window.api.removeWatchSource(source.id))}
                />
              ))}
              {state.watchSources.length === 0 && <Empty text="Kaynak ekle; yeni tweet, video, story/highlight veya playlist item geldiğinde panelden gör." />}
            </div>
          </div>
        </Panel>

        <Panel title="Yeni İçerikler" action={`${state.watchItems.length} keşif`}>
          <div className="space-y-2">
            {state.watchItems.slice(0, 10).map(item => (
              <WatchItemRow
                key={item.id}
                item={item}
                source={state.watchSources.find(source => source.id === item.sourceId)}
                onQueue={() => {
                  onUseUrl(item.url)
                  run(`watch-item-${item.id}`, () => window.api.updateWatchItem(item.id, { status: 'queued' }))
                }}
                onIgnore={() => run(`watch-item-ignore-${item.id}`, () => window.api.updateWatchItem(item.id, { status: 'ignored' }))}
              />
            ))}
            {state.watchItems.length === 0 && <Empty text="Takip edilen kaynaklardan yeni içerik bulununca burada listelenir." />}
          </div>
        </Panel>
      </section>}

      {view === 'automation' && <section className="grid gap-4 xl:grid-cols-[.85fr_.9fr_1.15fr]">
        <Panel title="Akıllı Profiller" action={`${state.smartProfiles.length} preset`}>
          <div className="space-y-2">
            {state.smartProfiles.map(profile => (
              <div key={profile.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white/85">{profile.name}</p>
                  <span className="rounded-md bg-violet-500/15 px-2 py-1 text-[10px] text-violet-200">{formatLabel(profile.format)}</span>
                </div>
                <p className="mt-1 text-xs text-white/45">{smartProfileSummary(profile, recipeById.get(profile.recipeId ?? ''))}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Chip>{platformLabel(profile.platform)}</Chip>
                  <Chip>{subtitleModeLabel(profile.subtitleMode)}</Chip>
                  {profile.recipeId && <Chip>{recipeById.get(profile.recipeId)?.name ?? 'İş akışı'}</Chip>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Hazır İş Akışları" action={`${state.recipes.length} otomasyon`}>
          <div className="space-y-2">
            {state.recipes.map(recipe => (
              <div key={recipe.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                <p className="text-sm font-medium text-white/85">{recipe.name}</p>
                <p className="mt-1 text-xs text-white/45">{recipe.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {recipe.steps.map(step => <span key={step} className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/45">{recipeStepLabel(step)}</span>)}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Otomasyonu Çalıştır" action={completedWithFiles.length ? `${completedWithFiles.length} dosya` : 'dosya yok'}>
          <div className="space-y-3">
            <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium text-white/80">İndirme bitince otomatik işlem yap</span>
                  <span className="mt-1 block text-xs text-white/35">Kapalıysa işlemler sadece buradan manuel başlatılır.</span>
                </span>
                <input
                  type="checkbox"
                  checked={autoRecipeEnabled}
                  onChange={(event) => setAutoRecipe(event.target.checked)}
                  className="h-4 w-4 accent-violet-500"
                />
              </label>
              <select
                value={autoRecipeId}
                onChange={(event) => setAutoRecipeSelection(event.target.value)}
                className="mt-3 w-full rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
              >
                <option value="">Dosyanın akıllı profiline göre seç</option>
                {state.recipes.map(recipe => (
                  <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
                ))}
              </select>
            </div>
            <select
              value={selectedAutomationItem?.id ?? ''}
              onChange={(event) => setSelectedAutomationItemId(event.target.value)}
              className="w-full rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
            >
              {completedWithFiles.map(item => (
                <option key={item.id} value={item.id}>{itemTitle(item)}</option>
              ))}
            </select>
            <select
              value={selectedRecipe?.id ?? ''}
              onChange={(event) => setSelectedRecipeId(event.target.value)}
              className="w-full rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
            >
              {state.recipes.map(recipe => (
                <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
              ))}
            </select>
            {selectedRecipe && (
              <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                <p className="text-xs text-white/45">{selectedRecipe.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {selectedRecipe.steps.map(step => <Chip key={step}>{recipeStepLabel(step)}</Chip>)}
                </div>
              </div>
            )}
            <button
              onClick={runRecipe}
              disabled={!selectedAutomationItem || !selectedRecipe || busy['recipe-run']}
              className="primary-btn w-full"
            >
              İş Akışını Başlat
            </button>
            {automationMessage && <p className="text-xs text-emerald-300/80">{automationMessage}</p>}
            <p className="text-[11px] leading-relaxed text-white/30">
              Seçilen iş akışı dosyayı paylaşmaya veya arşive hazır hale getirmek için kapak/süre onarımı, altyazı, sıkıştırma, ses düzeltme veya transcript işlemlerini sırayla başlatır.
            </p>
          </div>
        </Panel>
      </section>}

      {view === 'ai' && <section className="grid gap-4 xl:grid-cols-[minmax(320px,1.1fr)_minmax(300px,1fr)_minmax(360px,1fr)]">
        <Panel title="Local AI Araçları" action="ücretsiz / opsiyonel">
          <div className="space-y-2">
            {aiMessage && (
              <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100">
                {aiMessage}
              </div>
            )}
            {activeInstallJobs.length > 0 && (
              <div className="space-y-2 rounded-xl border border-violet-500/20 bg-[#111116] p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-violet-200/80">Aktif Kurulum / Onarım</p>
                {activeInstallJobs.map(job => (
                  <InlineAiProgress
                    key={job.id}
                    job={job}
                    onCancel={() => window.api.cancelAiJob(job.id).catch(() => {})}
                    onPause={() => pauseAiJob(job)}
                    onResume={() => resumeAiJob(job)}
                  />
                ))}
              </div>
            )}

            <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-white/55">Aktif Sohbet Modeli</p>
                <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/35">
                  {activeAiModel ? modelLabelById(aiChatModels, activeAiModel) : 'seçili değil'}
                </span>
              </div>
              <select
                value={activeAiModel ?? ''}
                onChange={(event) => chooseActiveAiModel(event.target.value)}
                className="w-full rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
              >
                <option value="" disabled>Model seç</option>
                {aiChatModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.label}{model.installed ? '' : ' · indirilecek'}
                  </option>
                ))}
                {aiChatModels.length === 0 && <option value="" disabled>Model bulunamadı</option>}
              </select>
              <p className="mt-2 text-[11px] text-white/30">Sohbet ve hızlı işlerde varsayılan olarak bu model kullanılır.</p>
            </div>

            <div className="space-y-2 rounded-xl border border-white/8 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-white/55">Modeller</p>
                <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/35">{aiChatModels.length} model</span>
              </div>
              {aiChatModels.map(model => (
                <AiModelRow
                  key={model.id}
                  model={model}
                  active={activeAiModel === model.id}
                  installBusy={!!busy[`ai-model-install-${model.id}`] || activeInstallByTool.has('ollama') || activeRepairByTool.has('ollama')}
                  removeBusy={!!busy['ai-remove-ollama'] || activeRemoveByTool.has('ollama')}
                  onInstall={() => installAiModel(model)}
                  onActivate={() => chooseActiveAiModel(model.id)}
                />
              ))}
              {aiChatModels.length === 0 && <Empty text="Model kataloğu yüklenemedi. Ollama'yı kurup yenileyin." />}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={installAllAiModels}
                  disabled={busy['ai-model-install-all'] || activeInstallByTool.has('ollama') || activeRepairByTool.has('ollama')}
                  className="secondary-btn py-1 text-[11px]"
                >
                  Tüm Modelleri İndir
                </button>
                <button
                  onClick={() => removeAiTool(state.aiTools.find(t => t.id === 'ollama') ?? state.aiTools[0])}
                  disabled={!state.aiTools.some(t => t.id === 'ollama') || busy['ai-remove-ollama'] || activeRemoveByTool.has('ollama')}
                  className="danger-btn py-1 text-[11px]"
                >
                  {activeRemoveByTool.has('ollama') ? 'Kaldırılıyor' : 'Modelleri Kaldır'}
                </button>
              </div>
            </div>

            {state.aiTools.map(tool => (
              <div
                key={tool.id}
                className="rounded-xl border border-white/8 bg-white/[0.03] p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white/85">{tool.label}</p>
                  <div className="flex gap-1">
                    <span className={`rounded-full px-2 py-1 text-[10px] ${tool.installed ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-100'}`}>
                      {tool.installed ? 'Kurulu' : 'Kurulu değil'}
                    </span>
                    <span className={`rounded-full px-2 py-1 text-[10px] ${tool.enabled ? 'bg-violet-500/15 text-violet-200' : 'bg-white/8 text-white/35'}`}>
                      {tool.enabled ? 'Açık' : 'Kapalı'}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-white/45">{tool.description}</p>
                <p className="mt-1 text-[11px] text-white/30">Model/paket: {tool.sizeHint}</p>
                {tool.statusDetail && <p className="mt-1 text-[11px] text-white/35">Durum: {tool.statusDetail}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => toggleAi(tool)} disabled={busy[`ai-${tool.id}`] || busy[`ai-install-${tool.id}`] || activeInstallByTool.has(tool.id) || activeRepairByTool.has(tool.id)} className="secondary-btn">
                    {tool.enabled ? 'Kapat' : 'Aç'}
                  </button>
                  <button onClick={() => installAiTool(tool)} disabled={tool.installed || busy[`ai-install-${tool.id}`] || activeInstallByTool.has(tool.id) || activeRepairByTool.has(tool.id)} className="primary-btn">
                    {activeInstallByTool.has(tool.id) ? 'Kuruluyor' : activeRepairByTool.has(tool.id) ? 'Onarılıyor' : 'Kur / Hazırla'}
                  </button>
                  <button onClick={() => repairAiTool(tool)} disabled={busy[`ai-repair-${tool.id}`] || activeInstallByTool.has(tool.id) || activeRepairByTool.has(tool.id)} className="secondary-btn">
                    {activeRepairByTool.has(tool.id) ? 'Onarılıyor' : activeInstallByTool.has(tool.id) ? 'Çalışıyor' : 'Onar'}
                  </button>
                  <button onClick={() => removeAiTool(tool)} disabled={busy[`ai-remove-${tool.id}`] || activeRemoveByTool.has(tool.id)} className="danger-btn">
                    {activeRemoveByTool.has(tool.id) ? 'Kaldırılıyor' : 'Modeli Kaldır'}
                  </button>
                </div>
              </div>
            ))}
            <button onClick={refreshAiStatus} className="secondary-btn w-full">Kurulum Durumunu Yenile</button>
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel title="Dosya Aksiyonları" action={selectedAiItem ? 'hazır' : 'dosya yok'}>
            <div className="space-y-3">
              <select
                value={selectedAiItem?.id ?? ''}
                onChange={(event) => setSelectedAiItemId(event.target.value)}
                className="w-full rounded-xl border border-white/8 bg-[#111116] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
              >
                {completedWithFiles.map(item => (
                  <option key={item.id} value={item.id}>{itemTitle(item)}</option>
                ))}
              </select>
              <div className="grid gap-2 sm:grid-cols-2">
                <button onClick={() => startAiAction('transcript')} disabled={!selectedAiItem || busy['ai-job-transcript']} className="primary-btn">Transcript</button>
                <button onClick={() => startAiAction('summary')} disabled={!selectedAiItem || busy['ai-job-summary']} className="secondary-btn">Özet</button>
                <button onClick={() => startAiAction('titles')} disabled={!selectedAiItem || busy['ai-job-titles']} className="secondary-btn">Başlık / Etiket</button>
                <button onClick={() => startAiAction('translate')} disabled={!selectedAiItem || busy['ai-job-translate']} className="secondary-btn">TR Çeviri</button>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-xs leading-relaxed text-white/40">
                Özet, başlık ve çeviri için önce transcript gerekir. Çıktılar indirilen dosyanın yanına `.transcript.txt`, `.summary.md`, `.titles.md` veya `.tr.txt` olarak yazılır.
              </div>
            </div>
          </Panel>

          <Panel
            title="AI Job Geçmişi"
            action={
              historyAiJobs.length > 0
                ? <button onClick={clearAiJobs} disabled={busy['ai-clear-jobs']} className="secondary-btn py-1 text-[11px]">Geçmişi Temizle</button>
                : '0 kayıt'
            }
          >
            <div className="max-h-[460px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
              {historyAiJobs.map(job => (
                <AiJobRow
                  key={job.id}
                  job={job}
                  onCancel={() => window.api.cancelAiJob(job.id).catch(() => {})}
                  onPause={() => pauseAiJob(job)}
                  onResume={() => resumeAiJob(job)}
                  onRetry={() => retryAiJob(job)}
                  onShow={() => job.outputPath && window.api.showItemInFolder(job.outputPath)}
                  onDelete={() => deleteAiJob(job)}
                />
              ))}
              {historyAiJobs.length === 0 && <Empty text="Biten, iptal edilen veya hata alan AI işleri burada görünür. Aktif kurulumlar soldaki panelde takip edilir." />}
            </div>
          </Panel>
        </div>

        <Panel
          title="Önerilen Sistem"
          action={
            <button
              onClick={() => {
                setShowAiSystemPanel(true)
                refreshAiSystemReport().catch(err => setError(userFriendlyError(err, 'ai-system-report')))
              }}
              className="secondary-btn py-1 text-[11px]"
            >
              Yanıt Testi
            </button>
          }
        >
          <HardwareRequirementsPanel report={aiSystemReport} />
        </Panel>
      </section>}

      {view === 'ai-chat' && <section className="grid min-h-[620px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Panel
          title="Sohbetler"
          action={
            <button onClick={newAiChat} className="text-white/70 transition hover:text-white">Yeni</button>
          }
        >
          <div className="space-y-3">
            <button onClick={newAiChat} className="primary-btn w-full">Yeni Sohbet</button>
            <div className="max-h-[500px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
              {aiChatSessions.map(session => (
                <button
                  key={session.id}
                  onClick={() => setSelectedAiChatId(session.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${selectedAiChat?.id === session.id ? 'border-violet-500/35 bg-violet-500/10' : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.05]'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium text-white/85">{session.title}</p>
                    <span className="shrink-0 rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/35">{session.messages.length}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-white/35">{chatPreview(session)}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-white/25">
                    <span className="truncate">{session.model}</span>
                    <span>{relativeTime(session.updatedAt)}</span>
                  </div>
                </button>
              ))}
              {aiChatSessions.length === 0 && <Empty text="Henüz sohbet yok. Mesaj yazınca ilk kayıt oluşur." />}
            </div>
            {aiChatSessions.length > 0 && (
              <button onClick={clearAiChat} disabled={busy['ai-chat-clear']} className="danger-btn w-full">
                Sohbetleri Temizle
              </button>
            )}
          </div>
        </Panel>

        <div className="min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-[#111116]">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-violet-200/70">Local AI Chat</p>
              <h2 className="mt-1 truncate text-lg font-semibold text-white">{selectedAiChat?.title ?? 'Yeni Sohbet'}</h2>
            </div>
            {selectedAiChat && (
              <button onClick={() => deleteAiChat(selectedAiChat.id)} className="danger-btn shrink-0 py-1 text-[11px]">
                Sil
              </button>
            )}
          </div>

          <div className="grid min-h-[560px] grid-rows-[1fr_auto]">
            <div className="space-y-4 overflow-y-auto p-4 scrollbar-thin">
              {selectedAiChatMessages.map((message, index) => {
                const isLast = index === selectedAiChatMessages.length - 1
                const streaming = selectedAiChatBusy && isLast && message.role === 'assistant'
                return <AiChatBubble key={message.id} message={message} streaming={streaming} />
              })}
              {!selectedAiChatMessages.length && (
                <div className="mx-auto flex min-h-[320px] max-w-xl flex-col items-center justify-center text-center">
                  <div className="rounded-2xl border border-violet-500/20 bg-violet-500/10 px-4 py-3">
                    <p className="text-sm font-medium text-white/85">Local modelle sohbet et</p>
                    <p className="mt-1 text-xs leading-relaxed text-white/40">
                      Genel soru sorabilir, bir kütüphane videosunu <span className="text-violet-200">@</span> ile bağlayıp içeriği hakkında sorabilir veya transcript/özet/başlık/çeviri işlerini chat komutuyla başlatabilirsin.
                    </p>
                  </div>
                  <div className="mt-4 grid w-full gap-2 sm:grid-cols-2">
                    {[
                      ['Transcript', 'Bu dosyanın transcriptini çıkar.'],
                      ['Özet', 'Bu dosyayı özetle.'],
                      ['Başlık', 'Bu dosya için başlık ve etiket üret.'],
                      ['TR Çeviri', 'Bu dosyayı Türkçeye çevir.']
                    ].map(([label, prompt]) => (
                      <button
                        key={label}
                        onClick={() => setAiChatInput(prompt)}
                        className="rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 text-sm text-white/70 transition hover:bg-white/[0.07] hover:text-white"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-white/8 bg-[#0F0F12]/95 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">Model</span>
                  <select
                    value={aiChatModel}
                    onChange={(event) => chooseActiveAiModel(event.target.value)}
                    className="min-w-0 max-w-[260px] rounded-xl border border-white/8 bg-[#16161A] px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
                  >
                    {aiChatModels.map(model => (
                      <option key={model.id} value={model.id}>{model.label}{model.installed ? '' : ' · indirilecek'}</option>
                    ))}
                    {aiChatModels.length === 0 && <option value={aiChatModel}>{aiChatModel}</option>}
                  </select>
                </div>
                {selectedAiChat && (
                  <button
                    onClick={regenerateAiChat}
                    disabled={selectedAiChatBusy || !selectedAiChat.messages.some(m => m.role === 'user')}
                    className="secondary-btn py-1 text-[11px]"
                  >
                    Yeniden Üret
                  </button>
                )}
              </div>

              {selectedAiChatModelInfo && !selectedAiChatModelInfo.installed && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/85">
                  <span className="min-w-0 flex-1">{selectedAiChatModelInfo.label} henüz kurulu değil. İlk mesajda indirilebilir veya şimdi indir.</span>
                  <button
                    onClick={() => installAiModel(selectedAiChatModelInfo)}
                    disabled={busy[`ai-model-install-${selectedAiChatModelInfo.id}`] || activeInstallByTool.has('ollama') || activeRepairByTool.has('ollama')}
                    className="primary-btn py-1 text-[11px]"
                  >
                    İndir
                  </button>
                </div>
              )}

              {chatAttachment && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs text-violet-100/85">
                  <span className="min-w-0 truncate">@ {chatAttachment.title} — sonraki soru bu videonun transcripti üzerinden yanıtlanır</span>
                  <button onClick={() => setChatAttachment(null)} className="shrink-0 text-violet-200/70 transition hover:text-white">Kaldır</button>
                </div>
              )}

              <div className="relative rounded-2xl border border-white/8 bg-[#16161A] p-2">
                {mentionOpen && (
                  <div className="absolute bottom-full left-2 right-2 z-20 mb-2 max-h-60 overflow-y-auto rounded-xl border border-white/10 bg-[#16161A] p-1 shadow-2xl shadow-black/50 scrollbar-thin">
                    <p className="px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-white/30">Kütüphane videoları</p>
                    {mentionItems.map(item => (
                      <button
                        key={item.id}
                        onMouseDown={(event) => { event.preventDefault(); selectMention(item) }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-white/75 transition hover:bg-white/[0.06]"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-[11px] text-violet-200">@</span>
                        <span className="min-w-0 flex-1 truncate">{itemTitle(item)}</span>
                      </button>
                    ))}
                    {mentionItems.length === 0 && (
                      <p className="px-2 py-3 text-center text-xs text-white/30">Eşleşen indirilmiş video yok.</p>
                    )}
                  </div>
                )}
                <textarea
                  value={aiChatInput}
                  onChange={(event) => handleChatInputChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && mentionOpen) {
                      setMentionOpen(false)
                      return
                    }
                    if (event.key === 'Enter' && !event.shiftKey && !mentionOpen) {
                      event.preventDefault()
                      sendAiChat()
                    }
                  }}
                  placeholder="Mesaj yaz... @ ile kütüphane videosu bağla, sonra içeriği hakkında sor."
                  className="min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-white/25"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-2">
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setAiChatInput('Bu dosyanın transcriptini çıkar.')} className="secondary-btn py-1 text-[11px]">Transcript</button>
                    <button onClick={() => setAiChatInput('Bu dosyayı özetle.')} className="secondary-btn py-1 text-[11px]">Özet</button>
                    <button onClick={() => setAiChatInput('Bu dosya için başlık ve etiket üret.')} className="secondary-btn py-1 text-[11px]">Başlık</button>
                    <button onClick={() => setAiChatInput('Bu dosyayı Türkçeye çevir.')} className="secondary-btn py-1 text-[11px]">Çeviri</button>
                  </div>
                  {selectedAiChatBusy ? (
                    <button onClick={stopAiChat} className="danger-btn min-w-24">Durdur</button>
                  ) : (
                    <button onClick={() => sendAiChat()} disabled={!aiChatInput.trim()} className="primary-btn min-w-24">
                      Gönder
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>}

      {showAiSystemPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
          <button
            aria-label="Kapat"
            onClick={() => setShowAiSystemPanel(false)}
            className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-md"
          />
          <div className="relative flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F0F12]/95 shadow-2xl shadow-black/40 animate-slide-up">
            <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300/70">Local AI</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Önerilen Sistem ve Yanıt Testi</h2>
                <p className="mt-1 text-xs text-white/35">Akıcı kullanım beklentisi, kurulum riski ve kurulu modeller için kısa performans testi.</p>
              </div>
              <button
                onClick={() => setShowAiSystemPanel(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/8 text-white/45 transition hover:bg-white/12 hover:text-white"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
              <SystemRequirementsPanel
                report={aiSystemReport}
                tools={state.aiTools}
                benchmarks={aiBenchmarks}
                activeBenchmarkByTool={activeBenchmarkByTool}
                busy={busy}
                onRefresh={() => refreshAiSystemReport().catch(err => setError(userFriendlyError(err, 'ai-system-report')))}
                onBenchmark={benchmarkAiTool}
              />
            </div>
          </div>
        </div>
      )}

      {view === 'library' && (
        <DownloadQueue
          items={historyItems}
          onCancel={onCancel}
          onPause={onPause}
          onResume={onResume}
          onRedownload={onRedownload}
          onRemove={onRemove}
          onClearCompleted={onClearCompleted}
          onShowItemInFolder={onShowItemInFolder}
          onConvertDone={onConvertDone}
          onUrlDrop={onUseUrl}
          onRepairMediaMetadata={onRepairMediaMetadata}
        />
      )}
    </div>
  )
}

function InboxRow({ item, busy, onCheck, onQueue, onIgnore, onRemove }: {
  item: LinkInboxItem
  busy: boolean
  onCheck: () => void
  onQueue: () => void
  onIgnore: () => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
      <div className="flex items-start gap-3">
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-white/70">{item.url}</p>
          {item.preflight ? (
            <div className="mt-2 space-y-1">
              <p className="truncate text-sm font-medium text-white/85">{item.preflight.title || item.preflight.platform}</p>
              <div className="flex flex-wrap gap-1">
                <Chip>{item.preflight.platform}</Chip>
                {item.preflight.duration !== undefined && <Chip>{formatDuration(item.preflight.duration)}</Chip>}
                {item.preflight.recommendedFormat && <Chip>{item.preflight.recommendedFormat}</Chip>}
                {item.preflight.hasCookies && <Chip>cookie</Chip>}
              </div>
              <MessageList messages={item.preflight.messages} />
            </div>
          ) : (
            <p className="mt-1 text-xs text-white/35">Henüz kontrol edilmedi.</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-5">
        <button onClick={onCheck} disabled={busy} className="secondary-btn">Kontrol</button>
        <button onClick={onQueue} disabled={busy} className="primary-btn">Kuyruğa Al</button>
        <button onClick={onIgnore} className="secondary-btn">Yoksay</button>
        <button onClick={onRemove} className="danger-btn">Sil</button>
      </div>
    </div>
  )
}

function WatchSourceRow({ source, busy, onCheck, onToggle, onAction, onRemove }: {
  source: WatchSource
  busy: boolean
  onCheck: () => void
  onToggle: () => void
  onAction: (action: WatchSource['action']) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white/85">{source.label}</p>
          <p className="truncate font-mono text-[11px] text-white/35">{source.url}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Chip>{watchTypeLabel(source.type)}</Chip>
            <Chip>{source.intervalMinutes} dk</Chip>
            <Chip>{watchActionLabel(source.action)}</Chip>
            {source.lastError && <Chip tone="bad">hata</Chip>}
          </div>
          {source.lastError && <p className="mt-2 text-xs text-red-300/80">{source.lastError}</p>}
        </div>
        <button onClick={onToggle} className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${source.enabled ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/8 text-white/35'}`}>
          {source.enabled ? 'Aktif' : 'Pasif'}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={onCheck} disabled={busy} className="primary-btn">Şimdi Kontrol</button>
        <button onClick={() => onAction(source.action === 'notify' ? 'queue' : 'notify')} className="secondary-btn">
          {source.action === 'notify' ? 'Bulunca Inbox' : 'Sadece Bildir'}
        </button>
        <button onClick={onRemove} className="danger-btn">Sil</button>
      </div>
    </div>
  )
}

function WatchItemRow({ item, source, onQueue, onIgnore }: {
  item: WatchItem
  source?: WatchSource
  onQueue: () => void
  onIgnore: () => void
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-3">
      <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-white/8">
        {item.thumbnail ? <img src={item.thumbnail} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium text-white/85">{item.title}</p>
        <p className="mt-1 truncate text-xs text-white/35">{source?.label ?? item.platform} · {relativeTime(item.discoveredAt)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={onQueue} className="primary-btn">İndir</button>
          <button onClick={onIgnore} className="secondary-btn">Yoksay</button>
        </div>
      </div>
      <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/40 h-fit">{watchItemStatusLabel(item.status)}</span>
    </div>
  )
}

function AiChatBubble({ message, streaming = false }: { message: AiChatSession['messages'][number]; streaming?: boolean }) {
  const user = message.role === 'user'
  const empty = !message.content.trim()
  return (
    <div className={`flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[82%] rounded-2xl border px-4 py-3 ${user ? 'border-violet-500/25 bg-violet-500/15' : 'border-white/8 bg-white/[0.04]'}`}>
        <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-white/30">
          <span className="font-semibold uppercase tracking-[0.08em]">{user ? 'Sen' : message.model ?? 'AI'}</span>
          <span>{formatChatTime(message.createdAt)}</span>
        </div>
        {streaming && empty
          ? <TypingDots />
          : <MarkdownText text={message.content} />}
        {streaming && !empty && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-violet-300/80 align-middle" />}
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 150, 300].map(delay => (
        <span key={delay} className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/45" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </div>
  )
}

// Minimal, dependency-free markdown for chat: fenced code blocks, inline code,
// **bold**, *italic*. Everything else renders as plain text with line breaks.
function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => splitCodeBlocks(text), [text])
  return (
    <div className="space-y-2 text-sm leading-relaxed text-white/80">
      {blocks.map((block, index) => block.type === 'code' ? (
        <pre key={index} className="overflow-x-auto rounded-xl border border-white/8 bg-black/30 p-3 scrollbar-thin">
          {block.lang && <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-white/30">{block.lang}</div>}
          <code className="whitespace-pre font-mono text-[12px] text-white/85">{block.content}</code>
        </pre>
      ) : (
        <p key={index} className="whitespace-pre-wrap break-words">{renderInlineMarkdown(block.content)}</p>
      ))}
    </div>
  )
}

function splitCodeBlocks(text: string): Array<{ type: 'text' | 'code'; content: string; lang?: string }> {
  const out: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = []
  const regex = /```([\w-]*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) out.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    out.push({ type: 'code', content: match[2].replace(/\n$/, ''), lang: match[1] || undefined })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) out.push({ type: 'text', content: text.slice(lastIndex) })
  if (!out.length) out.push({ type: 'text', content: text })
  return out
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px] text-violet-100">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++} className="font-semibold text-white">{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={key++} className="italic text-white/90">{token.slice(1, -1)}</em>)
    }
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function chatPreview(session: AiChatSession): string {
  const last = session.messages[session.messages.length - 1]
  if (!last) return session.attachmentTitle ? `Dosya: ${session.attachmentTitle}` : 'Boş sohbet'
  return last.content.replace(/\s+/g, ' ').trim()
}

// Returns the @-mention query the caret is currently inside (text after the
// trailing "@" with no whitespace), or null when no open mention token exists.
function activeMentionToken(value: string): string | null {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/)
  return match ? match[1] : null
}

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
}

function SystemRequirementsPanel({
  report,
  tools,
  benchmarks,
  activeBenchmarkByTool,
  busy,
  onRefresh,
  onBenchmark
}: {
  report: AiSystemReport | null
  tools: AiToolState[]
  benchmarks: Record<string, AiBenchmarkResult>
  activeBenchmarkByTool: Map<string, AiJob>
  busy: Record<string, boolean>
  onRefresh: () => void
  onBenchmark: (tool: AiToolState) => void
}) {
  const toolById = new Map(tools.map(tool => [tool.id, tool]))
  return (
    <div className="space-y-3 rounded-xl border border-white/8 bg-[#111116] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-white/55">Önerilen Sistem</p>
          <p className="mt-1 text-[11px] text-white/35">Akıcı local AI kullanımı için kısa uygunluk kontrolü.</p>
        </div>
        <button onClick={onRefresh} className="secondary-btn py-1 text-[11px]">Yenile</button>
      </div>

      {report ? (
        <>
          <div className="grid gap-1 text-[10px] text-white/35 sm:grid-cols-2">
            <span className="rounded-md bg-white/[0.04] px-2 py-1">CPU: {report.specs.cpuThreads} thread</span>
            <span className="rounded-md bg-white/[0.04] px-2 py-1">RAM: {formatBytes(report.specs.totalMemoryBytes)}</span>
            <span className="rounded-md bg-white/[0.04] px-2 py-1">Boş RAM: {formatBytes(report.specs.freeMemoryBytes)}</span>
            <span className="rounded-md bg-white/[0.04] px-2 py-1">Boş Disk: {formatBytes(report.specs.diskFreeBytes)}</span>
          </div>

          <div className="space-y-2">
            {report.tools.map(item => {
              const tool = toolById.get(item.toolId)
              const benchmark = benchmarks[item.toolId]
              const activeBenchmark = activeBenchmarkByTool.get(item.toolId)
              const failed = item.checks.some(check => !check.ok)
              return (
                <div key={item.toolId} className="rounded-lg border border-white/8 bg-white/[0.03] p-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-white/80">{item.label}</p>
                      <p className={`mt-0.5 text-[10px] ${failed ? 'text-amber-200/75' : 'text-emerald-200/75'}`}>{item.summary}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${failed ? 'bg-amber-500/15 text-amber-100' : 'bg-emerald-500/15 text-emerald-200'}`}>
                      {failed ? 'risk' : 'uygun'}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
                    {item.checks.map(check => (
                      <span key={check.key} title={check.detail ?? ''} className="rounded-md bg-white/[0.04] px-2 py-1 text-white/35">
                        <span className={check.ok ? 'text-emerald-300' : 'text-red-300'}>{check.ok ? '✓' : '×'}</span>
                        <span className="ml-1 text-white/45">{check.label}</span>
                        <span className="ml-1">{check.actual} / önerilen {check.required}</span>
                      </span>
                    ))}
                  </div>
                  {activeBenchmark && (
                    <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/10 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-violet-200/80">Aktif Yanıt Testi</span>
                        <span className="text-[10px] text-white/35">{activeBenchmark.percent == null ? 'çalışıyor' : `%${activeBenchmark.percent}`}</span>
                      </div>
                      <AiProgressDetails job={activeBenchmark} compact />
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => tool && onBenchmark(tool)}
                      disabled={!tool?.installed || busy[`ai-benchmark-${item.toolId}`] || !!activeBenchmark}
                      className="secondary-btn py-1 text-[11px]"
                    >
                      {busy[`ai-benchmark-${item.toolId}`] || activeBenchmark ? 'Test ediliyor' : 'Yanıt Testi'}
                    </button>
                    {benchmark ? (
                      <span className="text-[10px] text-white/40">
                        {benchmark.rating} · {formatMs(benchmark.elapsedMs)} · {relativeTime(benchmark.createdAt)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-white/25">{tool?.installed ? 'Kurulumdan sonra yanıt süresi test edilebilir.' : 'Benchmark için önce kurulmalı.'}</span>
                    )}
                  </div>
                  {benchmark?.message && <p className="mt-1 text-[10px] text-white/35">{benchmark.message}</p>}
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-white/8 px-3 py-4 text-center text-xs text-white/30">Sistem bilgisi yükleniyor...</p>
      )}
    </div>
  )
}

function AiJobRow({ job, onCancel, onPause, onResume, onRetry, onShow, onDelete }: {
  job: AiJob
  onCancel: () => void
  onPause: () => void
  onResume: () => void
  onRetry: () => void
  onShow: () => void
  onDelete: () => void
}) {
  const running = job.status === 'running'
  const paused = job.status === 'paused'
  const failed = job.status === 'error' || job.status === 'cancelled'
  const completedMessage = !running && !paused && job.status === 'done' && job.message
  const pauseSupported = canPauseAiJob(job)
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white/85">{job.title}</p>
          <p className="mt-1 text-xs text-white/35">{aiJobLabel(job.kind)} · {relativeTime(job.createdAt)}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${aiStatusClass(job.status)}`}>
          {aiStatusLabel(job.status)}
        </span>
      </div>
      {(running || paused) && (
        <div className="mt-3">
          <AiProgressDetails job={job} />
        </div>
      )}
      {completedMessage && <p className="mt-2 text-xs text-white/45">{formatAiMessage(job.message)}</p>}
      {job.benchmark && <BenchmarkStatsBlock stats={job.benchmark} />}
      {job.outputPath && <p className="mt-2 truncate font-mono text-[11px] text-white/35">{job.outputPath}</p>}
      {job.error && <p className="mt-2 line-clamp-2 text-xs text-red-300/80">{job.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {running && pauseSupported && <button onClick={onPause} className="secondary-btn">Duraklat</button>}
        {paused && pauseSupported && <button onClick={onResume} className="primary-btn">Devam Et</button>}
        {(running || paused) && <button onClick={onCancel} className="danger-btn">İptal</button>}
        {failed && <button onClick={onRetry} className="secondary-btn">Tekrar Dene</button>}
        {job.outputPath && <button onClick={onShow} className="secondary-btn">Dosyada Göster</button>}
        {!running && !paused && <button onClick={onDelete} className="danger-btn">Sil</button>}
      </div>
    </div>
  )
}

function BenchmarkStatsBlock({ stats }: { stats: NonNullable<AiJob['benchmark']> }) {
  const rows = [
    stats.model ? { label: 'Model', value: stats.model } : null,
    stats.mode ? { label: 'Test', value: stats.mode } : null,
    { label: 'Uygulama Süresi', value: formatMs(stats.elapsedMs) },
    { label: 'Sonuç', value: stats.rating },
    stats.totalDurationMs != null ? { label: 'API Toplam', value: formatMs(stats.totalDurationMs) } : null,
    stats.loadDurationMs != null ? { label: 'Model Yükleme', value: formatMs(stats.loadDurationMs) } : null,
    stats.firstTokenMs != null ? { label: 'İlk Token', value: formatMs(stats.firstTokenMs) } : null,
    stats.evalTokensPerSecond != null ? { label: 'Token/sn', value: formatTokensPerSecond(stats.evalTokensPerSecond) } : null,
    stats.promptTokensPerSecond != null ? { label: 'Prompt Token/sn', value: formatTokensPerSecond(stats.promptTokensPerSecond) } : null,
    stats.evalCount != null && stats.evalDurationMs != null ? { label: 'Üretim', value: `${stats.evalCount} token / ${formatMs(stats.evalDurationMs)}` } : null,
    stats.promptEvalCount != null && stats.promptEvalDurationMs != null ? { label: 'Prompt', value: `${stats.promptEvalCount} token / ${formatMs(stats.promptEvalDurationMs)}` } : null,
    stats.outputChars != null ? { label: 'Çıktı', value: `${stats.outputChars} karakter` } : null,
    stats.timeoutMs != null ? { label: 'Limit', value: formatMs(stats.timeoutMs) } : null,
    stats.response ? { label: 'Yanıt', value: stats.response } : null
  ].filter((row): row is { label: string; value: string } => Boolean(row))

  return (
    <div className="mt-3 rounded-lg border border-white/8 bg-black/10 p-2">
      <div className="grid gap-1 text-[10px] text-white/40 sm:grid-cols-2">
        {rows.map(row => (
          <span key={row.label} className="rounded-md bg-white/[0.04] px-2 py-1">
            <span className="text-white/25">{row.label}: </span>{row.value}
          </span>
        ))}
      </div>
      {stats.note && <p className="mt-2 text-[10px] text-white/35">{stats.note}</p>}
    </div>
  )
}

function modelLabelById(models: AiChatModel[], id: string | null): string {
  if (!id) return '-'
  return models.find(model => model.id === id)?.label ?? id
}

function AiModelRow({ model, active, installBusy, removeBusy, onInstall, onActivate }: {
  model: AiChatModel
  active: boolean
  installBusy: boolean
  removeBusy: boolean
  onInstall: () => void
  onActivate: () => void
}) {
  return (
    <div className={`rounded-xl border p-3 ${active ? 'border-violet-500/35 bg-violet-500/10' : 'border-white/8 bg-white/[0.03]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-white/85">{model.label}</p>
            {model.recommended && <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-violet-200">önerilen</span>}
            {active && <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-emerald-200">aktif</span>}
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-white/30">{model.id}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${model.installed ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-100'}`}>
          {model.installed ? 'kurulu' : 'kurulu değil'}
        </span>
      </div>
      {(model.description || model.sizeHint) && (
        <p className="mt-1 line-clamp-2 text-[11px] text-white/40">
          {model.description}{model.sizeHint ? `${model.description ? ' · ' : ''}${model.sizeHint}` : ''}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {model.installed ? (
          <button onClick={onActivate} disabled={active} className="secondary-btn py-1 text-[11px]">
            {active ? 'Aktif Model' : 'Aktif Yap'}
          </button>
        ) : (
          <button onClick={onInstall} disabled={installBusy} className="primary-btn py-1 text-[11px]">
            {installBusy ? 'İndiriliyor' : 'İndir'}
          </button>
        )}
        {model.installed && !active && (
          <button onClick={onInstall} disabled={installBusy} className="secondary-btn py-1 text-[11px]">
            {installBusy ? 'İşleniyor' : 'Yeniden İndir'}
          </button>
        )}
      </div>
      {removeBusy && <p className="mt-2 text-[10px] text-white/35">Model verileri kaldırılıyor...</p>}
    </div>
  )
}

// Hardware "Önerilen Sistem": shows PC specs (incl. GPU) and, per tool, whether
// the machine meets the requirements for fast local responses.
function HardwareRequirementsPanel({ report }: { report: AiSystemReport | null }) {
  if (!report) {
    return <p className="rounded-lg border border-dashed border-white/8 px-3 py-6 text-center text-xs text-white/30">Sistem bilgisi yükleniyor...</p>
  }
  const specs = report.specs
  return (
    <div className="space-y-3">
      <div className="grid gap-1 text-[10px] text-white/40 sm:grid-cols-2">
        <span className="rounded-md bg-white/[0.04] px-2 py-1">CPU: {specs.cpuThreads} thread</span>
        <span className="rounded-md bg-white/[0.04] px-2 py-1">RAM: {formatBytes(specs.totalMemoryBytes)}</span>
        <span className="rounded-md bg-white/[0.04] px-2 py-1">Boş RAM: {formatBytes(specs.freeMemoryBytes)}</span>
        <span className="rounded-md bg-white/[0.04] px-2 py-1">Boş Disk: {formatBytes(specs.diskFreeBytes)}</span>
        <span className="rounded-md bg-white/[0.04] px-2 py-1 sm:col-span-2">GPU: {specs.gpu ?? 'algılanamadı (CPU modu)'}</span>
      </div>

      <div className="space-y-2">
        {report.tools.map(item => {
          const failed = item.checks.some(check => !check.ok)
          return (
            <div key={item.toolId} className="rounded-lg border border-white/8 bg-white/[0.03] p-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white/80">{item.label}</p>
                  <p className={`mt-0.5 text-[10px] ${failed ? 'text-amber-200/75' : 'text-emerald-200/75'}`}>{item.summary}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${failed ? 'bg-amber-500/15 text-amber-100' : 'bg-emerald-500/15 text-emerald-200'}`}>
                  {failed ? 'risk' : 'uygun'}
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
                {item.checks.map(check => (
                  <span key={check.key} title={check.detail ?? ''} className="rounded-md bg-white/[0.04] px-2 py-1 text-white/35">
                    <span className={check.ok ? 'text-emerald-300' : 'text-red-300'}>{check.ok ? '✓' : '×'}</span>
                    <span className="ml-1 text-white/45">{check.label}</span>
                    <span className="ml-1">{check.actual} / önerilen {check.required}</span>
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-white/30">Hızlı yanıt için RAM ve GPU en kritik etkenlerdir. Detaylı yanıt testi için üstteki butonu kullanın.</p>
    </div>
  )
}

function InlineAiProgress({ job, onCancel, onPause, onResume }: { job: AiJob; onCancel: () => void; onPause: () => void; onResume: () => void }) {
  const paused = job.status === 'paused'
  const running = job.status === 'running'
  const progressPercent = job.install?.percent ?? job.percent
  const pauseSupported = canPauseAiJob(job)
  return (
    <div className="rounded-lg bg-white/[0.04] p-2">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs font-medium text-white/75">{job.title}</p>
        <span className="shrink-0 text-[10px] text-white/35">{paused ? 'duraklatıldı' : progressPercent == null ? 'çalışıyor' : `%${progressPercent}`}</span>
      </div>
      <AiProgressDetails job={job} compact />
      {job.error && <p className="mt-2 line-clamp-2 text-[11px] text-red-300/80">{job.error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {running && pauseSupported && <button onClick={onPause} className="secondary-btn">Duraklat</button>}
        {paused && pauseSupported && <button onClick={onResume} className="primary-btn">Devam Et</button>}
        {(running || paused) && <button onClick={onCancel} className="danger-btn">İptal</button>}
      </div>
    </div>
  )
}

function canPauseAiJob(job: AiJob): boolean {
  return job.kind !== 'summary' && job.kind !== 'titles' && job.kind !== 'benchmark'
}

function AiProgressDetails({ job, compact = false }: { job: AiJob; compact?: boolean }) {
  const paused = job.status === 'paused'
  const progressPercent = job.install?.percent ?? job.percent
  const stats = aiProgressStats(job)
  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div
          className={`h-full rounded-full ${paused ? 'bg-amber-300' : 'bg-violet-400'} ${progressPercent == null && !paused ? 'w-1/3 animate-pulse' : ''}`}
          style={progressPercent == null ? undefined : { width: `${progressPercent}%` }}
        />
      </div>
      {job.install && (
        <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-white/40">
          <span>{formatInstallStage(job.install.stage)}</span>
          <span>{job.install.percent != null ? `%${job.install.percent} toplam` : `${job.install.completedItems}/${job.install.totalItems} paket`}</span>
        </div>
      )}
      <p className={`${compact ? 'text-[11px]' : 'text-xs'} mt-2 line-clamp-2 text-white/40`}>
        {formatAiMessage(job.message || (paused ? 'Duraklatıldı.' : 'Çalışıyor...'))}
      </p>
      {stats.length > 0 && (
        <div className="mt-2 grid gap-1 text-[10px] text-white/35 sm:grid-cols-2">
          {stats.map(stat => (
            <span key={stat.label} className="rounded-md bg-white/[0.04] px-2 py-1">
              <span className="text-white/25">{stat.label}: </span>{stat.value}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function MessageList({ messages }: { messages: PreflightMessage[] }) {
  return (
    <div className="mt-2 space-y-1">
      {messages.map(message => (
        <p key={`${message.code}-${message.message}`} className={`text-xs ${message.severity === 'error' ? 'text-red-300' : message.severity === 'warning' ? 'text-amber-200' : 'text-white/40'}`}>
          {message.message}
        </p>
      ))}
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/8 bg-[#16161A]/80 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-white/55">{title}</h2>
        {action && <span className="rounded-lg bg-white/8 px-2 py-1 text-[11px] text-white/35">{action}</span>}
      </div>
      {children}
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
      <p className="text-xs text-white/40">{label}</p>
      <p className="mt-1 text-3xl font-bold text-white">{value}</p>
      <p className="mt-1 text-xs text-white/30">{sub}</p>
    </div>
  )
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <span className={`rounded-md px-2 py-1 text-[10px] ${tone === 'bad' ? 'bg-red-500/15 text-red-200' : 'bg-white/8 text-white/45'}`}>
      {children}
    </span>
  )
}

function StatusDot({ status }: { status: LinkInboxItem['status'] }) {
  const cls = status === 'checked' ? 'bg-emerald-400'
    : status === 'error' ? 'bg-red-400'
      : status === 'queued' ? 'bg-violet-400'
        : status === 'ignored' ? 'bg-white/25'
          : 'bg-amber-300'
  return <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-white/8 px-4 py-6 text-center text-sm text-white/25">{text}</p>
}

function splitUrls(value: string): string[] {
  return value
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || 'İşlem tamamlanamadı.'))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function userFriendlyError(error: unknown, operation: string): string {
  const message = cleanError(error)
  const lower = message.toLowerCase()

  if (lower.includes('window.api.clearaijobs is not a function') || lower.includes('window.api.deleteaijob is not a function')) {
    return 'AI geçmişi silme servisi henüz yüklenmemiş. DropMedia uygulamasını tamamen kapatıp yeniden açın, sonra tekrar deneyin.'
  }
  if (lower.includes('no handler registered') && lower.includes('ai-jobs-clear')) {
    return 'AI geçmişi temizleme servisi ana süreçte henüz yüklenmemiş. DropMedia uygulamasını tamamen kapatıp yeniden açın, sonra tekrar deneyin.'
  }
  if (lower.includes('no handler registered') && lower.includes('ai-job-delete')) {
    return 'AI geçmişi silme servisi ana süreçte henüz yüklenmemiş. DropMedia uygulamasını tamamen kapatıp yeniden açın, sonra tekrar deneyin.'
  }
  if (lower.includes('otomatik pip onarımı') || lower.includes('no module named pip')) {
    return 'Python pip otomatik onarılamadı. İnternet bağlantısı veya Python venv/ensurepip desteği engel olmuş olabilir. Teknik detay admin loguna kaydedildi.'
  }
  if (lower.includes('no module named')) {
    return 'Gerekli AI paketi hazır değil. İlgili araç için "Onar" veya "Kur / Hazırla" butonunu çalıştırıp tekrar deneyin. Teknik detay admin loguna kaydedildi.'
  }
  if (lower.includes('metin kaynağı bulunamadı')) {
    return 'Bu işlem için önce transcript gerekiyor. Transcript çıkarıp tekrar deneyin.'
  }
  if (lower.includes('bu komut için tamamlanmış local dosya seçin')) {
    return 'Bu chat komutu için alttan tamamlanmış bir dosya seçin. Genel sohbet için dosya seçmeden normal mesaj yazabilirsin.'
  }
  if (lower.includes('ollama_chat_timeout')) {
    return 'AI Chat yanıtı zaman aşımına uğradı. Model ilk yanıtta yavaş açılmış olabilir; kısa bir mesajla tekrar deneyin.'
  }
  if (lower.includes('ollama otomatik kurulumu')) {
    return 'Ollama otomatik kurulumu tamamlanamadı. İnternet bağlantısını ve Windows izinlerini kontrol edip Kur / Hazırla veya seçili model indirmeyi tekrar deneyin.'
  }
  if (lower.includes('ollama hazır değil') || lower.includes('ollama komutu bulunamadı')) {
    return 'Ollama hazır değil. AI bölümünden Ollama için Kur / Hazırla veya Onar çalıştırıp tekrar deneyin.'
  }
  if (lower.includes('unauthorized') || lower.includes('401')) {
    return 'Bu işlem için yetki gerekli. Hesap/admin girişini kontrol edip tekrar deneyin.'
  }
  if (lower.includes('network') || lower.includes('err_name_not_resolved') || lower.includes('enotfound')) {
    return 'Bağlantı kurulamadı. İnterneti/VPN-DNS ayarlarını kontrol edip tekrar deneyin. Teknik detay admin loguna kaydedildi.'
  }
  if (lower.includes('supabase') && (lower.includes('schema') || lower.includes('table'))) {
    return 'Supabase tablo yapısı hazır görünmüyor. Admin/Supabase kurulum kontrolünü çalıştırıp tekrar deneyin.'
  }

  if (operation.startsWith('ai-')) {
    return 'AI işlemi tamamlanamadı. Model/kurulum durumunu kontrol edip tekrar deneyin. Teknik detay admin loguna kaydedildi.'
  }
  return 'İşlem tamamlanamadı. Tekrar deneyin; devam ederse teknik detay admin logundan incelenebilir.'
}

function isManagedInstallUnavailable(tool: AiToolState): boolean {
  return tool.id === 'ollama' &&
    !tool.installed &&
    (tool.statusDetail ?? '').toLowerCase().includes('desteklenmiyor')
}

function managedInstallUnavailableMessage(tool: AiToolState): string {
  return tool.statusDetail ||
    'Ollama otomatik kurulumu bu platformda desteklenmiyor. Ollama’yı sistemden kurup Kurulum Durumunu Yenile’ye basın.'
}

function logClientError(error: unknown, operation: string, userMessage: string): void {
  const api = window.api as typeof window.api & {
    logClientError?: (payload: { message?: string; stack?: string; operation?: string; details?: Record<string, unknown> }) => Promise<{ ok: true }>
  }
  if (typeof api.logClientError !== 'function') return

  const message = cleanError(error)
  const stack = error instanceof Error ? error.stack : undefined
  api.logClientError({
    message,
    stack,
    operation,
    details: { userMessage }
  }).catch(() => {})
}

function hasAiHistoryApi(name: 'clearAiJobs' | 'deleteAiJob'): boolean {
  return typeof (window.api as unknown as Record<string, unknown>)[name] === 'function'
}

function itemTitle(item: DownloadItem): string {
  return item.videoInfo?.title || item.outputPath?.split(/[\\/]/).pop() || item.url
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

function aiJobLabel(kind: AiJobKind): string {
  if (kind === 'install') return 'kurulum'
  if (kind === 'repair') return 'onarım'
  if (kind === 'remove') return 'kaldırma'
  if (kind === 'transcript') return 'transcript'
  if (kind === 'summary') return 'özet'
  if (kind === 'translate') return 'çeviri'
  if (kind === 'benchmark') return 'yanıt testi'
  return 'başlık/etiket'
}

function isAiActionKind(kind: AiJobKind): kind is AiActionKind {
  return kind === 'transcript' || kind === 'summary' || kind === 'translate' || kind === 'titles'
}

function recipeStepLabel(step: PostProcessRecipe['steps'][number]): string {
  if (step === 'metadata') return 'Kapak/süre onarımı'
  if (step === 'thumbnail') return 'Kapak hazırlığı'
  if (step === 'subtitle-save') return 'Altyazı dosyası'
  if (step === 'subtitle-soft') return 'Seçilebilir altyazı'
  if (step === 'subtitle-burn') return 'Gömülü altyazı'
  if (step === 'audio-normalize') return 'Ses düzeltme'
  if (step === 'compress') return 'MP4 sıkıştırma'
  return 'Transcript'
}

function smartProfileSummary(profile: SmartProfile, recipe?: PostProcessRecipe): string {
  const format = formatLabel(profile.format)
  if (profile.mode === 'music') return `${format} ses dosyası, kapak ve metadata için hazırlanır.`
  if (profile.mode === 'course') return `${platformLabel(profile.platform)} dersleri altyazı ve transcript ile arşivlenir.`
  if (profile.mode === 'social') return `${platformLabel(profile.platform)} içerikleri paylaşmaya uygun MP4 akışına girer.`
  if (profile.mode === 'edit') return `${format} çıktı düzenleme akışına hazırlanır.`
  return recipe ? `${recipe.name} iş akışına uygun arşiv düzeni kullanılır.` : 'Uzun süreli arşiv için düzenli dosya yapısı kullanılır.'
}

function formatLabel(format: string): string {
  const lower = format.toLowerCase()
  if (lower === 'best') return 'En iyi kalite'
  if (lower === 'mp3') return 'MP3'
  if (lower === 'mp4') return 'MP4'
  return format.toUpperCase()
}

function platformLabel(platform: string): string {
  const lower = platform.toLowerCase()
  if (lower === 'all') return 'Tüm platformlar'
  if (lower === 'youtube') return 'YouTube'
  if (lower === 'instagram') return 'Instagram'
  if (lower === 'twitter' || lower === 'x') return 'X/Twitter'
  return platform
}

function subtitleModeLabel(mode: SmartProfile['subtitleMode']): string {
  if (mode === 'save') return 'Altyazı dosyası'
  if (mode === 'soft') return 'Seçilebilir altyazı'
  if (mode === 'burn') return 'Gömülü altyazı'
  return 'Altyazı yok'
}

function watchTypeLabel(type: WatchSource['type']): string {
  if (type === 'youtube-channel') return 'YouTube kanal'
  if (type === 'youtube-playlist') return 'YouTube playlist'
  if (type === 'instagram-profile') return 'Instagram profil'
  if (type === 'instagram-story') return 'Instagram story'
  if (type === 'instagram-highlight') return 'Instagram highlight'
  if (type === 'x-profile') return 'X/Twitter profil'
  if (type === 'tiktok-profile') return 'TikTok profil'
  return 'Genel kaynak'
}

function watchActionLabel(action: WatchSource['action']): string {
  if (action === 'download') return 'Otomatik indir'
  if (action === 'queue') return 'Bulunca inbox'
  return 'Sadece bildir'
}

function watchItemStatusLabel(status: WatchItem['status']): string {
  if (status === 'queued') return 'inbox'
  if (status === 'downloaded') return 'indirildi'
  if (status === 'ignored') return 'yoksayıldı'
  return 'yeni'
}

function aiStatusClass(status: AiJob['status']): string {
  if (status === 'done') return 'bg-emerald-500/15 text-emerald-200'
  if (status === 'error') return 'bg-red-500/15 text-red-200'
  if (status === 'paused') return 'bg-amber-500/15 text-amber-100'
  if (status === 'cancelled') return 'bg-white/8 text-white/35'
  return 'bg-violet-500/15 text-violet-200'
}

function aiStatusLabel(status: AiJob['status']): string {
  if (status === 'done') return 'tamamlandı'
  if (status === 'error') return 'hata'
  if (status === 'paused') return 'duraklatıldı'
  if (status === 'cancelled') return 'iptal'
  return 'çalışıyor'
}

function formatAiMessage(message: string): string {
  const clean = message
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[\?\d+[hl]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[▏▎▍▌▋▊▉█]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const ollama = clean.match(/pulling\s+[a-f0-9]{8,}[^:]*:\s*(\d+)%\s+([\d.]+\s+[KMG]B)\/([\d.]+\s+[KMG]B)\s+([\d.]+\s+[KMG]B\/s)\s+(\S+)/i)
  if (ollama) {
    return `Model indiriliyor: %${ollama[1]} · ${ollama[2]} / ${ollama[3]} · ${ollama[4]} · kalan ${ollama[5]}`
  }

  return clean.replace(/pulling\s+[a-f0-9]{8,}[^:]*:\s*/i, 'Model indiriliyor: ')
}

function aiProgressStats(job: AiJob): Array<{ label: string; value: string }> {
  const stats: Array<{ label: string; value: string }> = []
  const install = job.install
  if (install?.totalItems) {
    if (install.percent != null) stats.push({ label: 'Toplam', value: `%${install.percent}` })
    stats.push({
      label: 'Paket',
      value: `${install.completedItems}/${install.totalItems} hazır${install.cachedItems ? ` · ${install.cachedItems} cache` : ''}`
    })
    if (install.activeItems || install.waitingItems || install.queuedItems) {
      const downloading = Math.max(0, install.activeItems - install.waitingItems)
      stats.push({
        label: 'Paralel',
        value: `${downloading} iniyor · ${install.waitingItems} bekliyor · ${install.queuedItems} sırada`
      })
    }
    if (install.transferredBytes != null && install.totalBytes != null) {
      const known = install.knownBytesItems === install.totalItems ? '' : ` · ${install.knownBytesItems}/${install.totalItems} dosya biliniyor`
      stats.push({ label: 'İndirilen', value: `${formatBytes(install.transferredBytes)} / ${formatBytes(install.totalBytes)}${known}` })
    }
    if (install.remainingBytes != null) {
      stats.push({ label: install.knownBytesItems === install.totalItems ? 'Kalan Boyut' : 'Bilinen Kalan', value: formatBytes(install.remainingBytes) })
    }
    if (install.bytesPerSecond != null) stats.push({ label: 'Toplam Hız', value: `${formatBytes(install.bytesPerSecond)}/s` })
    if (install.etaSeconds != null) stats.push({ label: 'Tahmini Süre', value: `${formatAiDuration(install.etaSeconds)} kaldı` })
    if (install.currentLabel) stats.push({ label: 'Aktif Dosya', value: trimMiddle(install.currentLabel, 34) })
    stats.push({ label: 'Aşama', value: formatInstallStage(install.stage) })
  }

  const download = job.download
  if (!install && download?.label) stats.push({ label: 'Paket', value: trimMiddle(download.label, 34) })
  if (!install && download?.transferredBytes != null && download.totalBytes != null) {
    const remaining = Math.max(0, download.totalBytes - download.transferredBytes)
    stats.push({ label: 'Boyut', value: `${formatBytes(remaining)} kaldı / ${formatBytes(download.totalBytes)}` })
  } else if (!install && download?.transferredBytes != null) {
    stats.push({ label: 'İndirilen', value: formatBytes(download.transferredBytes) })
  } else if (!install && download?.totalBytes != null) {
    stats.push({ label: 'Boyut', value: `${formatBytes(download.totalBytes)} toplam` })
  }
  if (!install && download?.bytesPerSecond != null) stats.push({ label: 'Hız', value: `${formatBytes(download.bytesPerSecond)}/s` })
  if (!install && download?.etaSeconds != null) stats.push({ label: 'Süre', value: `${formatAiDuration(download.etaSeconds)} kaldı` })
  if (!install && !download && job.runtime) {
    stats.push({ label: 'İşlem', value: job.runtime.label })
    stats.push({ label: 'Geçen', value: formatMs(job.runtime.elapsedMs) })
    if (job.runtime.outputChars != null) stats.push({ label: 'Çıktı', value: `${job.runtime.outputChars} karakter` })
    if (job.runtime.tokens != null) {
      const speed = job.runtime.tokensPerSecond ? ` · ${formatTokensPerSecond(job.runtime.tokensPerSecond)}` : ''
      stats.push({ label: 'Üretim', value: `${job.runtime.tokens} parça${speed}` })
    }
    if (job.runtime.note) stats.push({ label: 'Durum', value: job.runtime.note })
  }
  if (job.status === 'running' || job.status === 'paused') {
    const hasElapsed = stats.some(stat => stat.label === 'Geçen')
    if (!hasElapsed) stats.push({ label: 'Geçen', value: formatAiDuration(Math.max(0, Math.round((Date.now() - job.createdAt) / 1000))) })
  }
  return stats
}

function formatInstallStage(stage: NonNullable<AiJob['install']>['stage']): string {
  if (stage === 'planning') return 'Bağımlılıklar hesaplanıyor'
  if (stage === 'downloading') return 'Paketler hazırlanıyor'
  if (stage === 'installing') return 'Local kurulum yapılıyor'
  return 'Tamamlandı'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const decimals = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${units[unit]}`
}

function formatAiDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '-'
  const sec = Math.max(0, Math.round(seconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}s ${m}dk`
  if (m > 0) return `${m}dk ${s}sn`
  return `${s}sn`
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} sn`
}

function formatTokensPerSecond(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-'
  return `${value.toFixed(value >= 10 ? 1 : 2)} token/sn`
}

function trimMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const keep = Math.max(4, Math.floor((max - 1) / 2))
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`
}

function mergeAiJobs(primary: AiJob[], secondary: AiJob[]): AiJob[] {
  const byId = new Map<string, AiJob>()
  for (const job of [...primary, ...secondary]) {
    if (!byId.has(job.id)) byId.set(job.id, job)
  }
  return Array.from(byId.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 80)
}

function upsertAiJobStable(jobs: AiJob[], job: AiJob): AiJob[] {
  const withoutPending = jobs.filter(item => !(
    item.id.startsWith('pending-') &&
    item.kind === job.kind &&
    item.toolId &&
    item.toolId === job.toolId
  ))
  const index = withoutPending.findIndex(item => item.id === job.id)
  if (index === -1) return [job, ...withoutPending].slice(0, 80)
  const next = [...withoutPending]
  next[index] = job
  return next.slice(0, 80)
}

function upsertChatSessionStable(sessions: AiChatSession[], session: AiChatSession): AiChatSession[] {
  const next = [session, ...sessions.filter(item => item.id !== session.id)]
  return next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
}

function activeToolJobMap(jobs: AiJob[], kind: 'install' | 'repair' | 'remove' | 'benchmark'): Map<string, AiJob> {
  const byTool = new Map<string, AiJob>()
  for (const job of jobs) {
    if (job.kind !== kind || !job.toolId) continue
    const current = byTool.get(job.toolId)
    if (!current || job.createdAt > current.createdAt) byTool.set(job.toolId, job)
  }
  return byTool
}

function relativeTime(ts?: number): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  const mins = Math.max(1, Math.round(diff / 60_000))
  if (mins < 60) return `${mins} dk önce`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} sa önce`
  return `${Math.round(hours / 24)} gün önce`
}
