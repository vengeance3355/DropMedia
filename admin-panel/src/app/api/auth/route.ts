export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { authenticate, SESSION_TOKEN } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  const auth = await authenticate(password)
  if (auth === 'missing_config') {
    return NextResponse.json({ error: 'ADMIN_PASSWORD env tanımlı değil veya boş.' }, { status: 503 })
  }
  if (auth !== 'ok') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_TOKEN, password, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7   // 7 gün
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(SESSION_TOKEN)
  return res
}
