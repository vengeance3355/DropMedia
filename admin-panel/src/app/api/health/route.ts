export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from '@/lib/supabase'
import { readLocalLogRows } from '@/lib/localLogs'

interface HealthRow {
  device_id?: string
  hostname?: string
  app_version?: string
  os?: string
  error_type?: string
  created_at: string
  ytdlp_version?: string
  ffmpeg?: boolean
}

export async function GET() {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const local = readLocalLogRows() as HealthRow[]
  let remote: HealthRow[] = []
  let source: 'local' | 'mixed' | 'supabase' = 'local'

  try {
    const sb = getSupabase()
    const { data, error } = await sb
      .from('error_logs')
      .select('device_id, hostname, app_version, os, error_type, created_at, ytdlp_version, ffmpeg')
      .order('created_at', { ascending: false })
      .limit(500)
    if (!error) {
      remote = data ?? []
      source = local.length ? 'mixed' : 'supabase'
    }
  } catch {
    source = 'local'
  }

  const rows = [...remote, ...local].filter(row => row.device_id)
  const devices = new Map<string, {
    id: string
    name: string
    appVersion?: string
    os?: string
    ytdlpVersion?: string
    ffmpeg?: boolean
    lastSeen: string
    errors24h: number
    warnings24h: number
    crashes24h: number
  }>()

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  for (const row of rows) {
    const id = row.device_id!
    const created = new Date(row.created_at).getTime()
    const existing = devices.get(id)
    if (!existing || created > new Date(existing.lastSeen).getTime()) {
      devices.set(id, {
        id,
        name: row.hostname ?? id,
        appVersion: row.app_version,
        os: row.os,
        ytdlpVersion: row.ytdlp_version,
        ffmpeg: row.ffmpeg,
        lastSeen: row.created_at,
        errors24h: existing?.errors24h ?? 0,
        warnings24h: existing?.warnings24h ?? 0,
        crashes24h: existing?.crashes24h ?? 0
      })
    }
    const item = devices.get(id)!
    if (created >= dayAgo) {
      if (row.error_type === 'warning') item.warnings24h += 1
      else if (row.error_type === 'crash') item.crashes24h += 1
      else if (row.error_type && row.error_type !== 'download_ok' && row.error_type !== 'app_open') item.errors24h += 1
    }
  }

  const list = [...devices.values()].sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
  return NextResponse.json({
    source,
    devices: list,
    summary: {
      devices: list.length,
      errors24h: list.reduce((sum, device) => sum + device.errors24h, 0),
      warnings24h: list.reduce((sum, device) => sum + device.warnings24h, 0),
      crashes24h: list.reduce((sum, device) => sum + device.crashes24h, 0)
    }
  })
}
