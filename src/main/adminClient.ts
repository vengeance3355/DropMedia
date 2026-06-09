import { IpcMain, net, safeStorage } from 'electron'
import Store from 'electron-store'
import { logError } from './logger'

const store = new Store()
const SESSION_KEY = 'admin.session'
const DEFAULT_ADMIN_URL = 'https://admin-panel-xi-orpin.vercel.app'
let memorySession: AdminSession | null = null

interface AdminSession {
  token: string
  expiresAt?: number
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE'
  body?: object
  auth?: boolean
}

export function setupAdminClientHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('admin-status', () => getAdminStatus())
  ipcMain.handle('admin-login', (_e, password: string) => adminLogin(password))
  ipcMain.handle('admin-logout', () => adminLogout())
  ipcMain.handle('admin-releases-list', () => adminRequest('/api/releases', { method: 'GET', auth: true }))
  ipcMain.handle('admin-release-save', (_e, payload: object) => adminRequest('/api/releases', { method: 'POST', auth: true, body: payload }))
  ipcMain.handle('admin-release-publish', (_e, payload: object) => adminRequest('/api/releases/publish', { method: 'POST', auth: true, body: payload }))
}

async function getAdminStatus() {
  const session = readSession()
  return {
    configured: !!getAdminBaseUrl(),
    signedIn: !!session,
    baseUrl: getAdminBaseUrl(),
    expiresAt: session?.expiresAt
  }
}

async function adminLogin(password: string) {
  const result = await adminRequest<{ token?: string; expiresAt?: number }>('/api/auth', {
    method: 'POST',
    body: { password }
  })
  if (!result.token) throw new Error('Admin token alınamadı.')
  writeSession({ token: result.token, expiresAt: result.expiresAt })
  return getAdminStatus()
}

async function adminLogout() {
  memorySession = null
  store.delete(SESSION_KEY)
  await adminRequest('/api/auth', { method: 'DELETE' }).catch(() => {})
  return getAdminStatus()
}

async function adminRequest<T = unknown>(path: string, opts: RequestOptions): Promise<T> {
  const base = getAdminBaseUrl()
  const session = opts.auth ? requireSession() : null
  const url = `${base}${path}`

  return await new Promise<T>((resolve, reject) => {
    const req = net.request({ method: opts.method, url })
    req.setHeader('Accept', 'application/json')
    req.setHeader('Content-Type', 'application/json')
    if (session) req.setHeader('Authorization', `Bearer ${session.token}`)

    req.on('response', (res) => {
      let raw = ''
      res.on('data', chunk => { raw += chunk.toString() })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const parsed = parseJson(raw)
        if (status >= 400) {
          const message = parseError(parsed, raw)
          void logError({
            errorType: 'settings',
            errorMessage: 'Admin isteği başarısız.',
            operation: 'admin-client-request',
            details: { statusCode: status, path, message }
          })
          reject(new Error(message || 'Admin isteği başarısız.'))
          return
        }
        resolve((parsed ?? {}) as T)
      })
    })
    req.on('error', err => {
      void logError({
        errorType: 'settings',
        errorMessage: 'Admin paneline bağlanılamadı.',
        operation: 'admin-client-network',
        stackTrace: err.stack,
        details: { path }
      })
      reject(err)
    })
    if (opts.body) req.write(JSON.stringify(opts.body))
    req.end()
  })
}

function getAdminBaseUrl(): string {
  return (process.env.ADMIN_PANEL_URL ?? process.env.DROPMEDIA_ADMIN_URL ?? DEFAULT_ADMIN_URL).trim().replace(/\/+$/, '')
}

function requireSession(): AdminSession {
  const session = readSession()
  if (!session?.token) throw new Error('Admin menüsü için önce giriş yapın.')
  return session
}

function readSession(): AdminSession | null {
  if (memorySession && isSessionFresh(memorySession)) return memorySession
  memorySession = null

  const stored = store.get(SESSION_KEY) as string | undefined
  if (!stored) return null
  try {
    const session = JSON.parse(decrypt(stored)) as AdminSession
    if (!session.token) return null
    if (!isSessionFresh(session)) {
      store.delete(SESSION_KEY)
      return null
    }
    return session
  } catch {
    store.delete(SESSION_KEY)
    return null
  }
}

function writeSession(session: AdminSession): void {
  if (safeStorage.isEncryptionAvailable()) {
    memorySession = null
    store.set(SESSION_KEY, `safe:${safeStorage.encryptString(JSON.stringify(session)).toString('base64')}`)
    return
  }

  memorySession = session
  store.delete(SESSION_KEY)
}

function isSessionFresh(session: AdminSession): boolean {
  return !session.expiresAt || session.expiresAt > Math.floor(Date.now() / 1000)
}

function decrypt(value: string): string {
  if (value.startsWith('safe:')) return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
  throw new Error('Admin oturumu şifreli saklanmamış.')
}

function parseJson(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

function parseError(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const data = parsed as { error?: unknown; code?: unknown; configuration?: unknown }
    const value = data.error
    if (data.code === 'missing_env' && typeof value === 'string') {
      const detail = typeof data.configuration === 'string' ? ` ${data.configuration}` : ''
      return `${value}${detail}`
    }
    if (typeof value === 'string') return value
  }
  return raw.slice(0, 300)
}
