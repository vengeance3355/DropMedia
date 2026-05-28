export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const device = searchParams.get('device')
  const sb = getSupabase()

  const [
    { data: all },
    { data: devices },
    { data: platforms },
    { data: recent }
  ] = await Promise.all([
    device
      ? sb.from('stats').select('*').eq('device_id', device).eq('success', true)
      : sb.from('stats').select('*').eq('success', true),
    sb.from('stats').select('device_id, hostname').order('created_at', { ascending: false }),
    sb.from('stats').select('platform').eq('success', true),
    sb.from('stats').select('*').order('created_at', { ascending: false }).limit(100)
  ])

  const platformCounts: Record<string, number> = {}
  for (const r of platforms ?? []) {
    const p = r.platform ?? 'other'
    platformCounts[p] = (platformCounts[p] ?? 0) + 1
  }

  const deviceMap = new Map<string, string>()
  for (const d of devices ?? []) deviceMap.set(d.device_id, d.hostname ?? d.device_id)
  const deviceList = [...deviceMap.entries()].map(([id, name]) => ({ id, name }))

  const totalMb  = (all ?? []).reduce((s, r) => s + (r.file_size_mb ?? 0), 0)
  const withSpeed = (all ?? []).filter(r => r.download_ms && r.file_size_mb)
  const avgSpeed = withSpeed.length
    ? withSpeed.reduce((s, r) => s + r.file_size_mb / (r.download_ms / 1000), 0) / withSpeed.length
    : 0

  return NextResponse.json({
    total:        all?.length ?? 0,
    totalMb:      Math.round(totalMb * 10) / 10,
    avgSpeedMbps: Math.round(avgSpeed * 10) / 10,
    platforms:    platformCounts,
    devices:      deviceList,
    recent:       recent ?? []
  })
}
