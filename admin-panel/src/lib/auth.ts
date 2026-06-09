import { cookies, headers } from 'next/headers'
import { createHmac, timingSafeEqual } from 'crypto'
import { getSupabase, getSupabaseEnv } from '@/lib/supabase'
import { hashPassword, verifyPassword } from '@/lib/password'

const SESSION_TOKEN = 'dm_admin_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

type AuthResult =
  | { status: 'ok'; token: string; expiresAt: number; source: 'supabase' | 'legacy' }
  | { status: 'missing_config' | 'invalid'; error?: string }

type AdminCredential =
  | { kind: 'supabase'; id: string; passwordHash: string }
  | { kind: 'legacy'; password: string; canMigrate: boolean }
  | { kind: 'missing'; error: string }

interface SessionPayload {
  sub: string
  role: 'owner'
  iat: number
  exp: number
}

export function getAuthSetupError(): string | null {
  if (!getSessionSecret()) return 'ADMIN_SESSION_SECRET veya SUPABASE_SERVICE_ROLE_KEY tanımlı değil.'
  return null
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await readRequestToken()
  return !!token && verifySessionToken(token)
}

export async function authenticate(password: string): Promise<AuthResult> {
  const input = String(password ?? '')
  if (!input) return { status: 'invalid' }
  if (!getSessionSecret()) return { status: 'missing_config', error: getAuthSetupError() ?? undefined }

  const credential = await readAdminCredential()
  if (credential.kind === 'missing') return { status: 'missing_config', error: credential.error }

  const ok = credential.kind === 'supabase'
    ? await verifyPassword(input, credential.passwordHash)
    : safeCompare(input, credential.password)

  if (!ok) return { status: 'invalid' }

  if (credential.kind === 'legacy' && credential.canMigrate) {
    await migrateLegacyPassword(input).catch(() => {})
  }
  if (credential.kind === 'supabase') {
    await updateLastLogin(credential.id).catch(() => {})
  }

  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_TTL_SECONDS
  return {
    status: 'ok',
    token: signSession({ sub: 'dropmedia-admin', role: 'owner', iat: now, exp: expiresAt }),
    expiresAt,
    source: credential.kind === 'supabase' ? 'supabase' : 'legacy'
  }
}

async function readRequestToken(): Promise<string | undefined> {
  const headerStore = await headers()
  const auth = headerStore.get('authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()

  const cookieStore = await cookies()
  return cookieStore.get(SESSION_TOKEN)?.value
}

async function readAdminCredential(): Promise<AdminCredential> {
  const legacyPassword = (process.env.ADMIN_PASSWORD ?? '').trim()

  try {
    const sb = getSupabase()
    const { data, error } = await sb
      .from('admin_users')
      .select('id,password_hash')
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) {
      if (legacyPassword) return { kind: 'legacy', password: legacyPassword, canMigrate: false }
      return { kind: 'missing', error: `admin_users okunamadı: ${error.message}` }
    }

    if (data?.password_hash) {
      return { kind: 'supabase', id: data.id, passwordHash: data.password_hash }
    }

    if (legacyPassword) return { kind: 'legacy', password: legacyPassword, canMigrate: true }
    return { kind: 'missing', error: 'Supabase admin_users tablosunda aktif admin yok.' }
  } catch (err) {
    if (legacyPassword) return { kind: 'legacy', password: legacyPassword, canMigrate: false }
    return {
      kind: 'missing',
      error: err instanceof Error ? err.message : 'Supabase admin ayarı eksik.'
    }
  }
}

async function migrateLegacyPassword(password: string): Promise<void> {
  const sb = getSupabase()
  const password_hash = await hashPassword(password)
  await sb.from('admin_users').insert({
    label: 'Owner',
    role: 'owner',
    password_hash,
    active: true,
    last_login_at: new Date().toISOString()
  })
}

async function updateLastLogin(id: string): Promise<void> {
  await getSupabase()
    .from('admin_users')
    .update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
}

function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', getSessionSecret()).update(body).digest('base64url')
  return `dm1.${body}.${signature}`
}

function verifySessionToken(token: string): boolean {
  const [, body, signature] = token.split('.')
  if (!token.startsWith('dm1.') || !body || !signature) return false

  const expected = createHmac('sha256', getSessionSecret()).update(body).digest('base64url')
  if (!safeCompare(signature, expected)) return false

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    return payload.role === 'owner' && payload.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

function getSessionSecret(): string {
  return (
    process.env.ADMIN_SESSION_SECRET ??
    getSupabaseEnv().serviceRoleKey ??
    ''
  ).trim()
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export { SESSION_TOKEN, SESSION_TTL_SECONDS }
