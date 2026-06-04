export function formatMediaDuration(seconds: number | string | undefined): string {
  const parsed = parseDurationSeconds(seconds)
  if (parsed === null) return ''
  const total = Math.max(0, Math.floor(parsed))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export const formatDuration = formatMediaDuration

function parseDurationSeconds(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  const raw = value.trim()
  if (!raw) return null

  if (raw.includes(':')) {
    const parts = raw.split(':').map(part => Number.parseFloat(part))
    if (parts.some(part => !Number.isFinite(part))) return null
    return parts.reduce((total, part) => total * 60 + part, 0)
  }

  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : null
}
