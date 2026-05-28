export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const device    = searchParams.get('device')
  const errorType = searchParams.get('type')
  const page      = parseInt(searchParams.get('page') ?? '1')
  const limit     = 50
  const sb        = getSupabase()

  let query = sb
    .from('error_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (device)    query = query.eq('device_id', device)
  if (errorType) query = query.eq('error_type', errorType)

  const { data, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data, count, page, limit })
}
