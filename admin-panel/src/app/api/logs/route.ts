export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from "@/lib/supabase"
import { readLocalLogRows } from '@/lib/localLogs'

export async function DELETE(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id') // belirli log; yoksa tümünü sil

  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ error: 'Supabase bağlantısı yok' }, { status: 503 })
  }

  if (id) {
    const { error } = await sb.from('error_logs').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await sb.from('error_logs').delete().neq('id', '')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const device    = searchParams.get('device')
  const errorType = searchParams.get('type')
  const page      = parseInt(searchParams.get('page') ?? '1')
  const limit     = 50
  const localRowsForRequest = () => {
    let rows = readLocalLogRows().filter(row => row.error_type)
    if (device) rows = rows.filter(row => row.device_id === device)
    if (errorType) rows = rows.filter(row => row.error_type === errorType)
    return rows
  }

  const localFallback = () => {
    const rows = localRowsForRequest()
    const start = (page - 1) * limit
    return NextResponse.json({
      data: rows.slice(start, start + limit),
      count: rows.length,
      page,
      limit,
      source: 'local'
    })
  }

  let sb
  try {
    sb = getSupabase()
  } catch {
    return localFallback()
  }

  let query = sb
    .from('error_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (device)    query = query.eq('device_id', device)
  if (errorType) query = query.eq('error_type', errorType)

  const { data, count, error } = await query
  if (error) return localFallback()

  const merged = [...(data ?? []), ...localRowsForRequest()]
    .filter((row, index, all) => {
      const key = `${row.created_at}-${row.device_id}-${row.error_type}-${row.error_message}`
      return all.findIndex(other => `${other.created_at}-${other.device_id}-${other.error_type}-${other.error_message}` === key) === index
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  const start = (page - 1) * limit
  return NextResponse.json({
    data: merged.slice(start, start + limit),
    count: Math.max(count ?? 0, merged.length),
    page,
    limit,
    source: merged.length > (data?.length ?? 0) ? 'mixed' : 'supabase'
  })
}
