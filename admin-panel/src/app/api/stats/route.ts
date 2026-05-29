export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from '@/lib/supabase'
import { readLocalLogRows } from '@/lib/localLogs'

export async function GET(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const device = searchParams.get('device')
  const localStats = () => {
    const rows = readLocalLogRows()
    const statRows = rows.filter(row => row.level === 'stat' && (!device || row.device_id === device))
    const successful = statRows.filter(row => row.success)
    const platformCounts: Record<string, number> = {}
    for (const row of successful) {
      const platform = row.platform ?? 'other'
      platformCounts[platform] = (platformCounts[platform] ?? 0) + 1
    }

    const deviceMap = new Map<string, string>()
    for (const row of rows) {
      if (row.device_id) deviceMap.set(row.device_id, row.hostname ?? row.device_id)
    }

    const totalMb = successful.reduce((sum, row) => sum + (row.file_size_mb ?? 0), 0)
    const withSpeed = successful.filter(row => row.download_ms && row.file_size_mb)
    const avgSpeed = withSpeed.length
      ? withSpeed.reduce((sum, row) => sum + ((row.file_size_mb ?? 0) / ((row.download_ms ?? 1) / 1000)), 0) / withSpeed.length
      : 0

    return {
      total: successful.length,
      totalMb: Math.round(totalMb * 10) / 10,
      avgSpeedMbps: Math.round(avgSpeed * 10) / 10,
      platforms: platformCounts,
      devices: [...deviceMap.entries()].map(([id, name]) => ({ id, name })),
      recent: statRows.slice(0, 100),
      source: 'local'
    }
  }

  const localFallback = () => NextResponse.json(localStats())

  let sb
  try {
    sb = getSupabase()
  } catch {
    return localFallback()
  }

  const [
    allResult,
    statDevicesResult,
    logDevicesResult,
    platformsResult,
    recentResult
  ] = await Promise.all([
    device
      ? sb.from('stats').select('*').eq('device_id', device).eq('success', true)
      : sb.from('stats').select('*').eq('success', true),
    sb.from('stats').select('device_id, hostname').order('created_at', { ascending: false }),
    sb.from('error_logs').select('device_id, hostname').order('created_at', { ascending: false }),
    sb.from('stats').select('platform').eq('success', true),
    sb.from('stats').select('*').order('created_at', { ascending: false }).limit(100)
  ])

  if (allResult.error || statDevicesResult.error || logDevicesResult.error || platformsResult.error || recentResult.error) {
    return localFallback()
  }

  const all = allResult.data
  const statDevices = statDevicesResult.data
  const logDevices = logDevicesResult.data
  const platforms = platformsResult.data
  const recent = recentResult.data

  const platformCounts: Record<string, number> = {}
  for (const r of platforms ?? []) {
    const p = r.platform ?? 'other'
    platformCounts[p] = (platformCounts[p] ?? 0) + 1
  }

  const local = localStats()
  for (const [platform, value] of Object.entries(local.platforms)) {
    platformCounts[platform] = (platformCounts[platform] ?? 0) + value
  }

  const deviceMap = new Map<string, string>()
  for (const d of [...(statDevices ?? []), ...(logDevices ?? [])]) {
    deviceMap.set(d.device_id, d.hostname ?? d.device_id)
  }
  for (const d of local.devices) {
    deviceMap.set(d.id, d.name)
  }
  const deviceList = [...deviceMap.entries()].map(([id, name]) => ({ id, name }))

  const totalMb  = (all ?? []).reduce((s, r) => s + (r.file_size_mb ?? 0), 0)
  const withSpeed = (all ?? []).filter(r => r.download_ms && r.file_size_mb)
  const avgSpeed = withSpeed.length
    ? withSpeed.reduce((s, r) => s + r.file_size_mb / (r.download_ms / 1000), 0) / withSpeed.length
    : 0

  return NextResponse.json({
    total:        (all?.length ?? 0) + local.total,
    totalMb:      Math.round((totalMb + local.totalMb) * 10) / 10,
    avgSpeedMbps: Math.round(avgSpeed * 10) / 10,
    platforms:    platformCounts,
    devices:      deviceList,
    recent:       [...(recent ?? []), ...local.recent].slice(0, 100),
    source:       local.total > 0 || local.devices.length > 0 ? 'mixed' : 'supabase'
  })
}
