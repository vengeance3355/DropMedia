import { cookies } from 'next/headers'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!
const SESSION_TOKEN  = 'dm_admin_session'

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies()
  return store.get(SESSION_TOKEN)?.value === ADMIN_PASSWORD
}

export async function authenticate(password: string): Promise<boolean> {
  return password === ADMIN_PASSWORD
}

export { SESSION_TOKEN }
