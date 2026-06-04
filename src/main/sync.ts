import { IpcMain, safeStorage } from 'electron'
import Store from 'electron-store'
import { logError } from './logger'

const store = new Store()

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''
const SESSION_KEY = 'sync.session'

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

function getSyncStatus(): SyncStatus {
  const session = readSession()
  return {
    configured: isConfigured(),
    signedIn: !!session,
    email: session?.user.email,
    userId: session?.user.id
  }
}

async function signUp(email: string, password: string): Promise<SyncStatus> {
  assertConfigured()
  assertCredentials(email, password)
  const auth = await authRequest('/auth/v1/signup', { email, password })
  if (!auth.access_token || !auth.user?.id) {
    throw new Error(authMessage(auth) || 'Kayıt oluşturulduysa e-posta onayı gerekebilir. Onaydan sonra giriş yapın.')
  }
  writeSession(toSession(auth))
  return getSyncStatus()
}

async function signIn(email: string, password: string): Promise<SyncStatus> {
  assertConfigured()
  assertCredentials(email, password)
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
    req.on('error', err => reject(err))
    if (opts.body) req.write(JSON.stringify(opts.body))
    req.end()
  })
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
