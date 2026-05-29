import { createServer, IncomingMessage, ServerResponse } from 'http'
import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'

const PORT = 17389

interface LocalRow {
  id: string
  created_at: string
  ts?: string
  level?: string
  device_id?: string
  hostname?: string
  app_version?: string
  os?: string
  url?: string
  format?: string
  error_type?: string
  error_message?: string
  stack_trace?: string
  ytdlp_version?: string
  ffmpeg?: boolean
  tor_enabled?: boolean
  platform?: string
  file_size_mb?: number
  duration_sec?: number
  download_ms?: number
  success?: boolean
}

let started = false

export function startAdminBridge(): void {
  if (started) return
  started = true

  const server = createServer((req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

    if (url.pathname === '/health') {
      json(res, { ok: true })
      return
    }

    if (url.pathname === '/api/logs') {
      const page = parseInt(url.searchParams.get('page') ?? '1', 10)
      const device = url.searchParams.get('device')
      const type = url.searchParams.get('type')
      const limit = 50
      let rows = readRows().filter(row => row.error_type)
      if (device) rows = rows.filter(row => row.device_id === device)
      if (type) rows = rows.filter(row => row.error_type === type)
      const start = (page - 1) * limit
      json(res, { data: rows.slice(start, start + limit), count: rows.length, page, limit, source: 'local-bridge' })
      return
    }

    if (url.pathname === '/api/stats') {
      const device = url.searchParams.get('device')
      json(res, buildStats(device))
      return
    }

    json(res, { error: 'Not found' }, 404)
  })

  server.on('error', () => {
    started = false
  })

  server.listen(PORT, '127.0.0.1')
  server.unref()
}

function readRows(): LocalRow[] {
  const logFile = join(app.getPath('logs'), 'dropmedia.log')
  if (!existsSync(logFile)) return []

  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        const row = JSON.parse(line) as LocalRow
        return {
          ...row,
          id: `${row.ts ?? index}-${index}`,
          created_at: row.ts ?? new Date(0).toISOString()
        }
      } catch {
        return null
      }
    })
    .filter((row): row is LocalRow => !!row)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

function buildStats(device: string | null) {
  const rows = readRows()
  const statRows = rows.filter(row => row.level === 'stat' && (!device || row.device_id === device))
  const successful = statRows.filter(row => row.success)
  const platforms: Record<string, number> = {}
  const deviceMap = new Map<string, string>()

  for (const row of rows) {
    if (row.device_id) deviceMap.set(row.device_id, row.hostname ?? row.device_id)
  }
  for (const row of successful) {
    const platform = row.platform ?? 'other'
    platforms[platform] = (platforms[platform] ?? 0) + 1
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
    platforms,
    devices: [...deviceMap.entries()].map(([id, name]) => ({ id, name })),
    recent: statRows.slice(0, 100),
    source: 'local-bridge'
  }
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function json(res: ServerResponse, data: object, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
