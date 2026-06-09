import { IpcMain, safeStorage } from 'electron'
import Store from 'electron-store'
import { logError } from './logger'

const store = new Store()

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''
const AUTH_REDIRECT_URL = process.env.SUPABASE_AUTH_REDIRECT_URL
  ?? 'https://admin-panel-xi-orpin.vercel.app/auth/callback'
const SESSION_KEY = 'sync.session'
const REQUIRED_TABLES = ['user_settings', 'download_library', 'watch_sources', 'watch_items']
const HEALTH_CACHE_MS = 60_000
let healthCache: { checkedAt: number; health: SyncHealth } | null = null

interface SyncSession {
  access_token: string
  refresh_token?: string
  expires_at?: number
  user: {
    id: string
    email?: string
  }
}

interface SyncStatus {
  configured: boolean
  signedIn: boolean
  email?: string
  userId?: string
  error?: string
  notice?: string
  emailConfirmationRequired?: boolean
  health?: SyncHealth
}

interface SyncHealth {
  ok: boolean
  status: 'ready' | 'misconfigured' | 'unreachable' | 'schema_missing'
  message?: string
  missingTables?: string[]
  checkedAt: number
}

interface AuthResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  user?: {
    id: string
    email?: string
  }
  error?: string
  error_description?: string
  msg?: string
}

export function setupSyncHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('sync-status', () => getSyncStatus())
  ipcMain.handle('sync-sign-up', (_e, email: string, password: string) => signUp(email, password))
  ipcMain.handle('sync-sign-in', (_e, email: string, password: string) => signIn(email, password))
  ipcMain.handle('sync-sign-out', () => signOut())
  ipcMain.handle('sync-push-product-state', (_e, state: object) => pushProductState(state))
  ipcMain.handle('sync-pull-product-state', () => pullProductState())
}

async function getSyncStatus(): Promise<SyncStatus> {
  const session = readSession()
  const health = await checkSyncHealth()
  return {
    configured: isConfigured(),
    signedIn: !!session,
    email: session?.user.email,
    userId: session?.user.id,
    error: health.ok ? undefined : health.message,
    health
  }
}

async function signUp(email: string, password: string): Promise<SyncStatus> {
  assertConfigured()
  assertCredentials(email, password)
  await assertSyncReachable()
  const auth = await authRequest(`/auth/v1/signup?redirect_to=${encodeURIComponent(AUTH_REDIRECT_URL)}`, { email, password })
  if (!auth.access_token && auth.user?.id) {
    return {
      ...await getSyncStatus(),
      email: auth.user.email ?? email,
      notice: 'Kayıt oluşturuldu. Giriş yapmadan önce e-posta onayını tamamlayın.',
      emailConfirmationRequired: true
    }
  }
  if (!auth.access_token || !auth.user?.id) {
    throw new Error(authMessage(auth) || 'Kayıt oluşturulduysa e-posta onayı gerekebilir. Onaydan sonra giriş yapın.')
  }
  writeSession(toSession(auth))
  return getSyncStatus()
}

async function signIn(email: string, password: string): Promise<SyncStatus> {
  assertConfigured()
  assertCredentials(email, password)
  await assertSyncReachable()
  const auth = await authRequest('/auth/v1/token?grant_type=password', { email, password })
  if (!auth.access_token || !auth.user?.id) throw new Error(authMessage(auth) || 'Giriş yapılamadı.')
  writeSession(toSession(auth))
  return getSyncStatus()
}

async function signOut(): Promise<SyncStatus> {
  const session = readSession()
  if (session) {
    await restRequest('/auth/v1/logout', {
      method: 'POST',
      token: session.access_token,
      body: {}
    }).catch(() => {})
  }
  store.delete(SESSION_KEY)
  return getSyncStatus()
}

async function pushProductState(state: object): Promise<{ ok: true; syncedAt: number }> {
  const session = requireSession()
  await assertSyncReachable()
  const syncedAt = Date.now()
  await restRequest('/rest/v1/user_settings', {
    method: 'POST',
    token: session.access_token,
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      user_id: session.user.id,
      namespace: 'product_hub',
      data: state,
      updated_at: new Date(syncedAt).toISOString()
    }
  })
  return { ok: true, syncedAt }
}

async function pullProductState(): Promise<{ data: unknown | null; syncedAt?: string }> {
  const session = requireSession()
  await assertSyncReachable()
  const rows = await restRequest<Array<{ data: unknown; updated_at?: string }>>('/rest/v1/user_settings?namespace=eq.product_hub&select=data,updated_at&limit=1', {
    method: 'GET',
    token: session.access_token
  })
  return {
    data: rows[0]?.data ?? null,
    syncedAt: rows[0]?.updated_at
  }
}

function isConfigured(): boolean {
  return /^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20
}

function assertConfigured(): void {
  if (!isConfigured()) throw new Error('Supabase URL/anon key tanımlı değil. Sync kapalı.')
}

async function assertSyncReachable(): Promise<void> {
  const health = await checkSyncHealth(true)
  if (!health.ok) throw new Error(health.message || 'Supabase sync hazır değil.')
}

function assertCredentials(email: string, password: string): void {
  if (!email.includes('@')) throw new Error('Geçerli e-posta girin.')
  if (password.length < 6) throw new Error('Şifre en az 6 karakter olmalı.')
}

function requireSession(): SyncSession {
  assertConfigured()
  const session = readSession()
  if (!session?.access_token) throw new Error('Sync için önce giriş yapın.')
  return session
}

function toSession(auth: AuthResponse): SyncSession {
  return {
    access_token: auth.access_token!,
    refresh_token: auth.refresh_token,
    expires_at: auth.expires_in ? Math.floor(Date.now() / 1000) + auth.expires_in : undefined,
    user: {
      id: auth.user!.id,
      email: auth.user!.email
    }
  }
}

async function authRequest(path: string, body: object): Promise<AuthResponse> {
  return restRequest<AuthResponse>(path, { method: 'POST', body })
}

async function restRequest<T>(path: string, opts: { method: 'GET' | 'POST'; body?: object; token?: string; prefer?: string }): Promise<T> {
  assertConfigured()
  const { net } = await import('electron')
  const url = `${SUPABASE_URL}${path}`

  return await new Promise<T>((resolve, reject) => {
    const req = net.request({ method: opts.method, url })
    req.setHeader('apikey', SUPABASE_ANON_KEY)
    req.setHeader('Authorization', `Bearer ${opts.token ?? SUPABASE_ANON_KEY}`)
    req.setHeader('Content-Type', 'application/json')
    if (opts.prefer) req.setHeader('Prefer', opts.prefer)

    req.on('response', (res) => {
      let raw = ''
      res.on('data', chunk => { raw += chunk.toString() })
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          const message = parseError(raw)
          logError({
            errorType: 'settings',
            errorMessage: 'Sync isteği başarısız.',
            operation: 'sync-request',
            details: { statusCode: res.statusCode, path, message }
          })
          reject(new Error(message || 'Sync isteği başarısız.'))
          return
        }
        try {
          resolve(raw ? JSON.parse(raw) as T : ({} as T))
        } catch {
          resolve({} as T)
        }
      })
    })
    req.on('error', err => reject(normalizeNetworkError(err)))
    if (opts.body) req.write(JSON.stringify(opts.body))
    req.end()
  })
}

async function checkSyncHealth(force = false): Promise<SyncHealth> {
  const now = Date.now()
  if (!force && healthCache && now - healthCache.checkedAt < HEALTH_CACHE_MS) return healthCache.health

  let health: SyncHealth
  if (!isConfigured()) {
    health = {
      ok: false,
      status: 'misconfigured',
      message: 'Supabase URL/anon key tanımlı değil. Sync kapalı.',
      checkedAt: now
    }
  } else {
    try {
      const results = await Promise.all(REQUIRED_TABLES.map(async table => {
        try {
          await healthRequest(`/rest/v1/${table}?select=id&limit=1`)
          return { table, ok: true }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            table,
            ok: false,
            missing: /could not find the table|schema cache|PGRST205/i.test(message),
            message
          }
        }
      }))
      const missingTables = results.filter(item => item.missing).map(item => item.table)
      const failed = results.find(item => !item.ok && !item.missing)

      if (missingTables.length) {
        health = {
          ok: false,
          status: 'schema_missing',
          message: `Supabase tabloları eksik: ${missingTables.join(', ')}. schema.sql tekrar çalıştırılmalı.`,
          missingTables,
          checkedAt: now
        }
      } else if (failed) {
        health = {
          ok: false,
          status: 'unreachable',
          message: failed.message || 'Supabase bağlantısı doğrulanamadı.',
          checkedAt: now
        }
      } else {
        health = { ok: true, status: 'ready', message: 'Supabase hazır.', checkedAt: now }
      }
    } catch (err) {
      health = {
        ok: false,
        status: 'unreachable',
        message: err instanceof Error ? err.message : 'Supabase bağlantısı doğrulanamadı.',
        checkedAt: now
      }
    }
  }

  healthCache = { checkedAt: now, health }
  return health
}

async function healthRequest(path: string): Promise<void> {
  const { net } = await import('electron')
  const url = `${SUPABASE_URL}${path}`

  return await new Promise<void>((resolve, reject) => {
    const req = net.request({ method: 'GET', url })
    req.setHeader('apikey', SUPABASE_ANON_KEY)
    req.setHeader('Authorization', `Bearer ${SUPABASE_ANON_KEY}`)

    req.on('response', (res) => {
      let raw = ''
      res.on('data', chunk => { raw += chunk.toString() })
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(parseError(raw) || `Supabase health HTTP ${res.statusCode}`))
          return
        }
        resolve()
      })
    })
    req.on('error', err => reject(normalizeNetworkError(err)))
    req.end()
  })
}

function normalizeNetworkError(error: Error): Error {
  const message = error.message || ''
  if (message.includes('ERR_NAME_NOT_RESOLVED')) {
    return new Error('Supabase adresi çözümlenemedi. .env içindeki SUPABASE_URL doğru proje URLi olmalı ve DNS/internet erişimi çalışmalı.')
  }
  if (message.includes('ERR_INTERNET_DISCONNECTED')) {
    return new Error('İnternet bağlantısı yok. Hesap ve cloud sync için bağlantı gerekiyor.')
  }
  if (message.includes('ERR_CONNECTION_TIMED_OUT') || message.includes('ERR_CONNECTION_RESET')) {
    return new Error('Supabase bağlantısı zaman aşımına uğradı. İnternet, DNS veya güvenlik duvarını kontrol edin.')
  }
  return error
}

function parseError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { msg?: string; message?: string; error?: string; error_description?: string }
    return parsed.msg ?? parsed.message ?? parsed.error_description ?? parsed.error ?? ''
  } catch {
    return raw.slice(0, 300)
  }
}

function authMessage(auth: AuthResponse): string {
  return auth.error_description ?? auth.msg ?? auth.error ?? ''
}

function readSession(): SyncSession | null {
  const stored = store.get(SESSION_KEY) as string | undefined
  if (!stored) return null
  try {
    const json = decrypt(stored)
    const session = JSON.parse(json) as SyncSession
    if (!session.access_token || !session.user?.id) return null
    return session
  } catch {
    store.delete(SESSION_KEY)
    return null
  }
}

function writeSession(session: SyncSession): void {
  store.set(SESSION_KEY, encrypt(JSON.stringify(session)))
}

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(value).toString('base64')}`
  }
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

function decrypt(value: string): string {
  if (value.startsWith('safe:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
  }
  if (value.startsWith('plain:')) {
    return Buffer.from(value.slice(6), 'base64').toString('utf8')
  }
  return value
}
