export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { authenticate, SESSION_TOKEN, SESSION_TTL_SECONDS } from '@/lib/auth'

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 8
const attempts = new Map<string, { count: number; resetAt: number }>()

export async function POST(req: NextRequest) {
  const key = requestKey(req)
  if (isRateLimited(key)) {
    return NextResponse.json({ error: 'Çok fazla başarısız deneme. Biraz bekleyip tekrar deneyin.' }, { status: 429 })
  }

  let password = ''
  try {
    const body = await req.json() as { password?: unknown }
    password = String(body.password ?? '')
  } catch {
    registerFailedAttempt(key)
    return NextResponse.json({ error: 'Geçersiz giriş isteği.' }, { status: 400 })
  }

  const auth = await authenticate(password)
  if (auth.status === 'missing_config') {
    return NextResponse.json({ error: auth.error ?? 'Admin auth ayarı eksik.' }, { status: 503 })
  }
  if (auth.status !== 'ok') {
    registerFailedAttempt(key)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  attempts.delete(key)

  const res = NextResponse.json({
    ok: true,
    token: auth.token,
    expiresAt: auth.expiresAt,
    source: auth.source
  })
  res.cookies.set(SESSION_TOKEN, auth.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(SESSION_TOKEN)
  return res
}

function requestKey(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const realIp = req.headers.get('x-real-ip')?.trim()
  return forwarded || realIp || 'unknown'
}

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) {
    attempts.delete(key)
    return false
  }
  return current.count >= MAX_ATTEMPTS
}

function registerFailedAttempt(key: string): void {
  const now = Date.now()
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS })
    return
  }
  attempts.set(key, { count: current.count + 1, resetAt: current.resetAt })
}
