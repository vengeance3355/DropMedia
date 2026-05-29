import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface LocalLogRow {
  id: string
  created_at: string
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
  level?: string
  platform?: string
  file_size_mb?: number
  duration_sec?: number
  download_ms?: number
  success?: boolean
}

export function readLocalLogRows(): LocalLogRow[] {
  const logFile = process.env.DROPMEDIA_LOCAL_LOG_PATH
    ?? join(homedir(), '.config/drop-media/logs/dropmedia.log')

  if (!existsSync(logFile)) return []

  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        const row = JSON.parse(line) as LocalLogRow & { ts?: string }
        return {
          ...row,
          id: `${row.ts ?? index}-${index}`,
          created_at: row.ts ?? new Date(0).toISOString()
        }
      } catch {
        return null
      }
    })
    .filter((row): row is LocalLogRow => !!row)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}
