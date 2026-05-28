import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { supabase } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const device = searchParams.get('device')

  // Genel özet
  const baseQuery = device
    ? supabase.from('stats').select('*').eq('device_id', device)
    : supabase.from('stats').select('*')

  const [
    { data: all },
    { data: devices },
    { data: platforms },
    { data: recent }
  ] = await Promise.all([
    baseQuery.eq('success', true),
    supabase.from('stats').select('device_id, hostname').order('created_at', { ascending: false }),
    supabase.from('stats').select('platform').eq('success', true),
    supabase.from('stats').select('*').order('created_at', { ascending: false }).limit(100)
  ])

  // Platform dağılımı
  const platformCounts: Record<string, number> = {}
  for (const r of platforms ?? []) {
    const p = r.platform ?? 'other'
    platformCounts[p] = (platformCounts[p] ?? 0) + 1
  }

  // Cihaz listesi (tekil)
  const deviceMap = new Map<string, string>()
  for (const d of devices ?? []) deviceMap.set(d.device_id, d.hostname ?? d.device_id)
  const deviceList = [...deviceMap.entries()].map(([id, name]) => ({ id, name }))

  const totalMb   = (all ?? []).reduce((s, r) => s + (r.file_size_mb ?? 0), 0)
  const avgSpeed  = (all ?? []).filter(r => r.download_ms && r.file_size_mb)
    .reduce((s, r, _, a) => s + r.file_size_mb / (r.download_ms / 1000) / a.length, 0)

  return NextResponse.json({
    total:         all?.length ?? 0,
    totalMb:       Math.round(totalMb * 10) / 10,
    avgSpeedMbps:  Math.round(avgSpeed * 10) / 10,
    platforms:     platformCounts,
    devices:       deviceList,
    recent:        recent ?? []
  })
}
