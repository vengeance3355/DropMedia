import { useEffect, useState } from 'react'
import type { AdminRelease, AdminStatus } from '../types'

export function AdminPanel() {
  const [status,       setStatus]       = useState<AdminStatus | null>(null)
  const [password,     setPassword]     = useState('')
  const [version,      setVersion]      = useState('')
  const [notes,        setNotes]        = useState('')
  const [releases,     setReleases]     = useState<AdminRelease[]>([])
  const [busy,         setBusy]         = useState('')
  const [message,      setMessage]      = useState<{ text: string; ok: boolean } | null>(null)
  const [workflowUrl,  setWorkflowUrl]  = useState('')
  const [loadingList,  setLoadingList]  = useState(false)
  const [editingId,    setEditingId]    = useState<number | null>(null)
  const [editNotes,    setEditNotes]    = useState('')
  const [expandedId,   setExpandedId]   = useState<number | null>(null)

  useEffect(() => { void loadStatus() }, [])

  async function loadStatus() {
    const s = await window.api.getAdminStatus()
    setStatus(s)
    if (s.signedIn) void loadReleases()
  }

  async function loadReleases() {
    setLoadingList(true)
    try {
      const res = await window.api.listAdminReleases()
      setReleases(res?.data ?? [])
    } catch { /* silent */ }
    finally { setLoadingList(false) }
  }

  async function login() {
    setBusy('login'); setMessage(null)
    try {
      const s = await window.api.loginAdmin(password)
      setStatus(s); setPassword('')
      setMessage({ text: 'Giriş başarılı.', ok: true })
      void loadReleases()
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Giriş başarısız.', ok: false })
    } finally { setBusy('') }
  }

  async function logout() {
    const s = await window.api.logoutAdmin()
    setStatus(s); setMessage(null); setWorkflowUrl(''); setReleases([])
  }

  async function publish() {
    const target = version.trim() || 'patch bump'
    if (!window.confirm(`GitHub Actions tetiklenecek.\n\nHedef: ${target}\n\nOnaylıyor musun?`)) return
    setBusy('publish'); setMessage(null); setWorkflowUrl('')
    try {
      const result = await window.api.publishAdminRelease({
        version: version.trim() || undefined,
        notes:   notes.trim()   || undefined
      })
      setWorkflowUrl(result.workflow_url || '')
      setMessage({ text: `Workflow başladı — ${target}`, ok: true })
      setVersion(''); setNotes('')
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Workflow başlatılamadı.', ok: false })
    } finally { setBusy('') }
  }

  async function deleteRelease(id: number, tag: string) {
    if (!window.confirm(`"${tag}" sürümünü GitHub'dan silmek istediğinden emin misin?`)) return
    setBusy(`del-${id}`)
    try {
      await window.api.deleteAdminRelease(id)
      setReleases(prev => prev.filter(r => r.github_id !== id))
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Silinemedi.', ok: false })
    } finally { setBusy('') }
  }

  async function saveEdit(id: number) {
    setBusy(`edit-${id}`)
    try {
      await window.api.editAdminRelease(id, editNotes)
      setReleases(prev => prev.map(r => r.github_id === id ? { ...r, notes: editNotes } : r))
      setEditingId(null)
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Kaydedilemedi.', ok: false })
    } finally { setBusy('') }
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!status) return <div className="py-12 text-center text-sm text-zinc-500">Yükleniyor...</div>

  if (!status.signedIn) {
    return (
      <div className="mx-auto max-w-sm rounded-2xl border border-white/8 bg-white/[0.04] p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300/70 mb-1">DropMedia</p>
        <h2 className="text-2xl font-semibold text-white mb-4">Admin Girişi</h2>
        <div className="space-y-3">
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && password && login()}
            placeholder="Admin şifresi"
            className="w-full rounded-xl border border-white/8 bg-black/30 px-3 py-3 text-sm text-white outline-none focus:border-violet-500/50"
          />
          {message && <p className={`text-xs ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>}
          <button onClick={login} disabled={!password || busy === 'login'}
            className="w-full rounded-xl bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40 transition-colors">
            {busy === 'login' ? 'Giriş yapılıyor...' : 'Giriş Yap'}
          </button>
        </div>
      </div>
    )
  }

  // ── Ana ekran ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 animate-fade-in max-w-xl">

      {/* Header */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300/70">Admin</p>
          <h2 className="mt-1 text-xl font-semibold text-white">Release Yönetimi</h2>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => window.api.openUrl('https://github.com/vengeance3355/DropMedia/releases')}
            className="rounded-lg bg-white/8 px-3 py-2 text-xs text-zinc-300 hover:bg-white/12"
          >GitHub</button>
          <button onClick={logout} className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 hover:bg-red-500/20">
            Çıkış
          </button>
        </div>
      </div>

      {/* Yeni sürüm yayınla */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Yeni Sürüm Yayınla</h3>
          <span className="rounded-md bg-blue-500/15 px-2 py-1 text-[11px] text-blue-300">GitHub Actions</span>
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1">Sürüm numarası</label>
          <input
            value={version} onChange={e => setVersion(e.target.value)}
            placeholder="Örn: 1.4.0  —  boşsa otomatik artar"
            className="w-full rounded-xl border border-white/8 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
          />
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1">Güncelleme notları</label>
          <textarea
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder={"- Yeni özellik\n- Hata düzeltmesi\n\nBoşsa git log otomatik kullanılır."}
            rows={4}
            className="w-full resize-none rounded-xl border border-white/8 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
          />
        </div>

        {message && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${
            message.ok
              ? 'text-green-300 bg-green-500/10 border-green-500/20'
              : 'text-red-300 bg-red-500/10 border-red-500/20'
          }`}>{message.text}</p>
        )}
        {workflowUrl && (
          <button onClick={() => window.api.openUrl(workflowUrl)}
            className="w-full text-xs text-blue-400 hover:text-blue-300 text-left underline">
            Workflow durumunu GitHub'da görüntüle →
          </button>
        )}

        <button onClick={publish} disabled={busy === 'publish'}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 transition-colors">
          {busy === 'publish' ? 'Başlatılıyor...' : 'Yayınla'}
        </button>
      </div>

      {/* Mevcut sürümler */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Mevcut Sürümler</h3>
          <button onClick={loadReleases} disabled={loadingList}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            {loadingList ? 'Yükleniyor...' : '↻ Yenile'}
          </button>
        </div>

        {releases.length === 0 && !loadingList && (
          <p className="text-xs text-zinc-600 text-center py-4">Sürüm bulunamadı</p>
        )}

        {releases.map(r => (
          <div key={r.github_id} className="rounded-xl border border-white/8 bg-black/20 overflow-hidden">
            {/* Satır başlığı */}
            <div className="flex items-center gap-2 px-4 py-3">
              <button
                onClick={() => setExpandedId(expandedId === r.github_id ? null : r.github_id ?? null)}
                className="flex-1 flex items-center gap-2 text-left min-w-0"
              >
                <span className="text-sm font-semibold text-white">v{r.version}</span>
                {r.prerelease && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">pre</span>
                )}
                <span className="text-xs text-zinc-500 ml-auto shrink-0">
                  {r.created_at ? new Date(r.created_at).toLocaleDateString('tr') : ''}
                </span>
              </button>
              <button
                onClick={() => { setEditingId(r.github_id ?? null); setEditNotes(r.notes ?? ''); setExpandedId(null) }}
                disabled={!!busy}
                title="Notları düzenle"
                className="px-2 py-1.5 rounded-lg bg-white/8 text-xs text-zinc-400 hover:text-white hover:bg-white/12 disabled:opacity-40 transition-colors"
              >✎</button>
              <button
                onClick={() => deleteRelease(r.github_id!, r.github_tag ?? `v${r.version}`)}
                disabled={!!busy}
                title="Sürümü sil"
                className="px-2 py-1.5 rounded-lg bg-red-500/10 text-xs text-red-400/70 hover:text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
              >
                {busy === `del-${r.github_id}` ? '...' : '✕'}
              </button>
            </div>

            {/* Düzenleme modu */}
            {editingId === r.github_id && (
              <div className="border-t border-white/8 px-4 py-3 space-y-2">
                <textarea
                  value={editNotes} onChange={e => setEditNotes(e.target.value)}
                  rows={6}
                  className="w-full resize-none rounded-xl border border-white/8 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-violet-500/50"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setEditingId(null)}
                    className="px-3 py-1.5 rounded-lg bg-white/8 text-xs text-zinc-400 hover:text-white transition-colors">
                    İptal
                  </button>
                  <button onClick={() => saveEdit(r.github_id!)} disabled={busy === `edit-${r.github_id}`}
                    className="px-3 py-1.5 rounded-lg bg-violet-600 text-xs text-white hover:bg-violet-500 disabled:opacity-40 transition-colors">
                    {busy === `edit-${r.github_id}` ? 'Kaydediliyor...' : 'Kaydet'}
                  </button>
                </div>
              </div>
            )}

            {/* Notları göster (expand) */}
            {expandedId === r.github_id && editingId !== r.github_id && r.notes && (
              <div className="border-t border-white/8 px-4 py-3">
                <pre className="text-xs text-zinc-400 whitespace-pre-wrap">{r.notes}</pre>
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  )
}
