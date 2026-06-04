export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from '@/lib/supabase'

interface ReleasePayload {
  version: string
  channel?: string
  title?: string
  notes?: string
  github_tag?: string
  appimage_url?: string
  deb_url?: string
  latest_yml_url?: string
  mandatory?: boolean
  published?: boolean
}

export async function GET() {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ data: [], count: 0, source: 'none' })
  }

  const { data, count, error } = await sb
    .from('app_releases')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ data: [], count: 0, source: 'error', error: error.message })
  return NextResponse.json({ data: data ?? [], count: count ?? 0, source: 'supabase' })
}

export async function POST(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let payload: Partial<ReleasePayload>
  try {
    payload = normalizePayload(await req.json())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Geçersiz veri' }, { status: 400 })
  }

  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ error: 'Supabase bağlantısı yok' }, { status: 503 })
  }

  const { data, error } = await sb
    .from('app_releases')
    .upsert(payload, { onConflict: 'version' })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id gerekli' }, { status: 400 })

  let payload: Partial<ReleasePayload>
  try {
    payload = normalizePayload(await req.json(), true)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Geçersiz veri' }, { status: 400 })
  }
  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ error: 'Supabase bağlantısı yok' }, { status: 503 })
  }

  const { data, error } = await sb
    .from('app_releases')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

function normalizePayload(input: Partial<ReleasePayload>, patch = false): Partial<ReleasePayload> {
  const version = input.version?.trim().replace(/^v/i, '')
  if (!patch && !version) throw new Error('version gerekli')
  return {
    ...(version ? { version } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.github_tag !== undefined ? { github_tag: input.github_tag } : {}),
    ...(input.appimage_url !== undefined ? { appimage_url: input.appimage_url } : {}),
    ...(input.deb_url !== undefined ? { deb_url: input.deb_url } : {}),
    ...(input.latest_yml_url !== undefined ? { latest_yml_url: input.latest_yml_url } : {}),
    ...(input.mandatory !== undefined ? { mandatory: !!input.mandatory } : {}),
    ...(input.published !== undefined ? { published: !!input.published } : {})
  }
}
