import { useEffect, useMemo, useState } from 'react'
import type {
  AiToolState,
  DownloadItem,
  LinkInboxItem,
  PreflightMessage,
  ProductHubState,
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
}

export type ProductHubView = 'links' | 'watch' | 'library' | 'automation' | 'ai' | 'account'
type SyncStatus = { configured: boolean; signedIn: boolean; email?: string; userId?: string; error?: string }

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
  onRepairMediaMetadata
}: Props) {
  const [state, setState] = useState<ProductHubState>(EMPTY)
  const [bulkUrls, setBulkUrls] = useState('')
  const [watchUrl, setWatchUrl] = useState('')
  const [storyUser, setStoryUser] = useState('')
  const [syncEmail, setSyncEmail] = useState('')
  const [syncPassword, setSyncPassword] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ configured: false, signedIn: false })
  const [syncMessage, setSyncMessage] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    window.api.getProductState().then(next => {
      if (mounted) setState(next)
    }).catch(err => setError(cleanError(err)))
    window.api.getSyncStatus().then(next => {
      if (mounted) setSyncStatus(next)
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

  const completed = useMemo(() => historyItems.filter(item => item.status === 'completed'), [historyItems])
  const inboxReady = state.inbox.filter(item => item.status === 'checked' && item.preflight?.ok).length
  const newWatchItems = state.watchItems.filter(item => item.status === 'new').length
  const privateNeedsCookie = state.inbox.some(item => item.preflight?.needsCookies)
  const meta = VIEW_META[view]

  async function refresh() {
    setState(await window.api.getProductState())
  }

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError('')
    setBusy(prev => ({ ...prev, [key]: true }))
    try {
      const result = await fn()
      await refresh().catch(() => {})
      return result
    } catch (err) {
      setError(cleanError(err))
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
      setSyncMessage(mode === 'signin' ? 'Giriş yapıldı.' : 'Kayıt oluşturuldu ve giriş yapıldı.')
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

  async function toggleAi(tool: AiToolState) {
    const enabled = !tool.enabled
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
        <Metric label="Inbox" value={state.inbox.length} sub={`${inboxReady} hazır`} />
        <Metric label="Takip" value={state.watchSources.length} sub={`${newWatchItems} yeni`} />
        <Metric label="Kütüphane" value={completed.length + state.library.length} sub="local kayıt" />
        <Metric label="AI" value={state.aiTools.filter(t => t.enabled).length} sub="opsiyonel local" />
      </div>

      {view === 'account' && <Panel title="Hesap ve Sync" action={syncStatus.configured ? (syncStatus.signedIn ? syncStatus.email : 'Supabase hazır') : 'kapalı'}>
        {syncStatus.configured ? (
          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              {syncStatus.signedIn ? (
                <div>
                  <p className="text-sm text-white/75">Giriş: {syncStatus.email}</p>
                  <p className="text-xs text-white/35">Inbox, takip kaynakları, recipe, AI ayarları ve kütüphane state'i manuel push/pull yapılır.</p>
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
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              {syncStatus.signedIn ? (
                <>
                  <button onClick={syncPush} disabled={busy['sync-push']} className="primary-btn">Supabase'e Yedekle</button>
                  <button onClick={syncPull} disabled={busy['sync-pull']} className="secondary-btn">Geri Yükle</button>
                  <button onClick={syncSignOut} className="danger-btn">Çıkış</button>
                </>
              ) : (
                <>
                  <button onClick={() => syncAuth('signin')} disabled={busy['sync-signin']} className="primary-btn">Giriş</button>
                  <button onClick={() => syncAuth('signup')} disabled={busy['sync-signup']} className="secondary-btn">Kayıt</button>
                </>
              )}
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

      {view === 'automation' && <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Akıllı Profiller" action={`${state.smartProfiles.length} preset`}>
          <div className="space-y-2">
            {state.smartProfiles.map(profile => (
              <div key={profile.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white/85">{profile.name}</p>
                  <span className="rounded-md bg-violet-500/15 px-2 py-1 text-[10px] text-violet-200">{profile.format}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-white/35">{profile.filenameTemplate}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Recipe Zinciri" action={`${state.recipes.length} akış`}>
          <div className="space-y-2">
            {state.recipes.map(recipe => (
              <div key={recipe.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                <p className="text-sm font-medium text-white/85">{recipe.name}</p>
                <p className="mt-1 text-xs text-white/45">{recipe.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {recipe.steps.map(step => <span key={step} className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/45">{step}</span>)}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>}

      {view === 'ai' && <Panel title="Local AI" action="ücretsiz / opsiyonel">
          <div className="space-y-2">
            {state.aiTools.map(tool => (
              <button
                key={tool.id}
                onClick={() => toggleAi(tool)}
                className="w-full rounded-xl border border-white/8 bg-white/[0.03] p-3 text-left transition-colors hover:bg-white/[0.06]"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white/85">{tool.label}</p>
                  <span className={`rounded-full px-2 py-1 text-[10px] ${tool.enabled ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/8 text-white/35'}`}>
                    {tool.enabled ? 'Açık' : 'Kapalı'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/45">{tool.description}</p>
                <p className="mt-1 text-[11px] text-white/30">Model/paket: {tool.sizeHint}</p>
              </button>
            ))}
          </div>
        </Panel>}

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
            <Chip>{source.type}</Chip>
            <Chip>{source.intervalMinutes} dk</Chip>
            <Chip>{source.action}</Chip>
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
      <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] text-white/40 h-fit">{item.status}</span>
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

function Panel({ title, action, children }: { title: string; action?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#16161A]/80 p-4">
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

function relativeTime(ts?: number): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  const mins = Math.max(1, Math.round(diff / 60_000))
  if (mins < 60) return `${mins} dk önce`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} sa önce`
  return `${Math.round(hours / 24)} gün önce`
}
