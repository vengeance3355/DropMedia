import { useEffect, useState } from 'react'
import type { AdminReleasePublishInput, AdminStatus } from '../types'

const emptyPublish: AdminReleasePublishInput = {
  bump: 'patch',
  version: '',
  notes: '',
  draft: false,
  prerelease: false,
  ref: 'feat/windows-compat'
}

export function AdminPanel() {
  const [status,      setStatus]      = useState<AdminStatus | null>(null)
  const [password,    setPassword]    = useState('')
  const [form,        setForm]        = useState<AdminReleasePublishInput>(emptyPublish)
  const [busy,        setBusy]        = useState('')
  const [message,     setMessage]     = useState<{ text: string; ok: boolean } | null>(null)
  const [workflowUrl, setWorkflowUrl] = useState('')

  useEffect(() => { void loadStatus() }, [])

  async function loadStatus() {
    const s = await window.api.getAdminStatus()
    setStatus(s)
  }

  async function login() {
    setBusy('login'); setMessage(null)
    try {
      const s = await window.api.loginAdmin(password)
      setStatus(s)
      setPassword('')
      setMessage({ text: 'Giriş başarılı.', ok: true })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Giriş başarısız.', ok: false })
    } finally { setBusy('') }
  }

  async function logout() {
    const s = await window.api.logoutAdmin()
    setStatus(s)
    setMessage(null)
    setWorkflowUrl('')
  }

  async function publish() {
    const target = form.version?.trim() || `${form.bump} bump`
    const ok = window.confirm(
      `GitHub Actions tetiklenecek.\n\nHedef: ${target}\nBranch: ${form.ref || 'main'}\n\nOnaylıyor musun?`
    )
    if (!ok) return

    setBusy('publish'); setMessage(null); setWorkflowUrl('')
    try {
      const result = await window.api.publishAdminRelease({
        ...form,
        version: form.version?.trim() || undefined,
        notes:   form.notes?.trim()   || undefined,
        ref:     form.ref?.trim()     || 'main'
      })
      setWorkflowUrl(result.workflow_url || result.runs_url || '')
      setMessage({ text: `Release workflow başladı — ${target}`, ok: true })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Workflow başlatılamadı.', ok: false })
    } finally { setBusy('') }
  }

  // ── Login ekranı ────────────────────────────────────────────────────────────
  if (!status) {
    return <div className="py-12 text-center text-sm text-zinc-500">Yükleniyor...</div>
  }

  if (!status.signedIn) {
    return (
      <div className="mx-auto max-w-sm rounded-2xl border border-white/8 bg-white/[0.04] p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300/70 mb-1">DropMedia</p>
        <h2 className="text-2xl font-semibold text-white mb-4">Admin Girişi</h2>
        <div className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && password && login()}
            placeholder="Admin şifresi"
            className="w-full rounded-xl border border-white/8 bg-black/30 px-3 py-3 text-sm text-white outline-none focus:border-violet-500/50"
          />
          {message && <p className={`text-xs ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>}
          <button
            onClick={login}
            disabled={!password || busy === 'login'}
            className="w-full rounded-xl bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40 transition-colors"
          >
            {busy === 'login' ? 'Giriş yapılıyor...' : 'Giriş Yap'}
          </button>
        </div>
      </div>
    )
  }

  // ── Ana ekran ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 animate-fade-in max-w-xl">

      {/* Header */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300/70">Admin</p>
          <h2 className="mt-1 text-xl font-semibold text-white">Release Yönetimi</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Yeni sürüm yayınla → GitHub Actions build eder, zip + version.json upload eder, release açıklamasını günceller.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => window.api.openUrl('https://github.com/vengeance3355/DropMedia/releases/tag/stable')}
            className="rounded-lg bg-white/8 px-3 py-2 text-xs text-zinc-300 hover:bg-white/12"
          >
            Releases
          </button>
          <button
            onClick={logout}
            className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 hover:bg-red-500/20"
          >
            Çıkış
          </button>
        </div>
      </div>

      {/* Yayınla formu */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Yeni Sürüm Yayınla</h3>
          <span className="rounded-md bg-blue-500/15 px-2 py-1 text-[11px] text-blue-300">GitHub Actions</span>
        </div>

        {/* Bump */}
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Sürüm artışı</label>
          <div className="flex gap-2">
            {(['patch', 'minor', 'major'] as const).map(b => (
              <button
                key={b}
                onClick={() => setForm(f => ({ ...f, bump: b }))}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                  form.bump === b
                    ? 'bg-violet-600 text-white'
                    : 'bg-white/8 text-zinc-400 hover:bg-white/12'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        {/* Exact version */}
        <Field
          label="Tam sürüm (opsiyonel)"
          value={form.version ?? ''}
          onChange={v => setForm(f => ({ ...f, version: v }))}
          placeholder="Örn: 1.2.0  —  boşsa bump kullanılır"
        />

        {/* Notes */}
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Release notları</label>
          <textarea
            value={form.notes ?? ''}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder={"- Yeni özellik\n- Hata düzeltmesi\n\nBoşsa git log otomatik kullanılır."}
            rows={5}
            className="w-full resize-none rounded-xl border border-white/8 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
          />
        </div>

        {/* Branch */}
        <Field
          label="Branch"
          value={form.ref ?? 'main'}
          onChange={v => setForm(f => ({ ...f, ref: v }))}
          placeholder="main"
        />

        {/* Flags */}
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.draft} onChange={e => setForm(f => ({ ...f, draft: e.target.checked }))}/>
            Draft
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.prerelease} onChange={e => setForm(f => ({ ...f, prerelease: e.target.checked }))}/>
            Prerelease
          </label>
        </div>

        {/* Mesaj */}
        {message && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${
            message.ok
              ? 'text-green-300 bg-green-500/10 border-green-500/20'
              : 'text-red-300 bg-red-500/10 border-red-500/20'
          }`}>
            {message.text}
          </p>
        )}

        {workflowUrl && (
          <button
            onClick={() => window.api.openUrl(workflowUrl)}
            className="w-full text-xs text-blue-400 hover:text-blue-300 text-left underline"
          >
            Workflow durumunu GitHub'da görüntüle →
          </button>
        )}

        {/* Yayınla */}
        <button
          onClick={publish}
          disabled={busy === 'publish'}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
        >
          {busy === 'publish' ? 'Başlatılıyor...' : 'GitHub Release İşini Başlat'}
        </button>
      </div>

    </div>
  )
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs text-zinc-500 block mb-1">{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-white/8 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
      />
    </div>
  )
}
