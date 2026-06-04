import { cookies } from 'next/headers'

const SESSION_TOKEN = 'dm_admin_session'

export function getAdminPassword(): string {
  return (process.env.ADMIN_PASSWORD ?? '').trim()
}

export function getAuthSetupError(): string | null {
  return getAdminPassword() ? null : 'ADMIN_PASSWORD env tanımlı değil veya boş.'
}

export async function isAuthenticated(): Promise<boolean> {
  const password = getAdminPassword()
  if (!password) return false

  const store = await cookies()
  return store.get(SESSION_TOKEN)?.value === password
}

export async function authenticate(password: string): Promise<'ok' | 'missing_config' | 'invalid'> {
  const adminPassword = getAdminPassword()
  if (!adminPassword) return 'missing_config'
  return password === adminPassword ? 'ok' : 'invalid'
}

export { SESSION_TOKEN }
