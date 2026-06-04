import type { DownloadItem, HistoryEntry } from '../types'
import { detectPlatform } from './platform'

export type MediaPlatform = 'instagram' | 'discord' | 'youtube' | 'twitter' | 'generic'

export interface ResolvedMediaThumbnail {
  src: string | null
  platform: MediaPlatform
  fallbackSrc: string
  isPlaceholder: boolean
  label: string
}

export function resolveMediaThumbnail(item: DownloadItem | HistoryEntry): ResolvedMediaThumbnail {
  const platform = getMediaPlatform(item)
  const fallbackSrc = getPlatformPlaceholder(platform)
  const label = getPlatformLabel(platform)
  const local = [
    item.thumbnailPath,
    item.localThumbnailPath,
    item.localThumbnail
  ]

  for (const value of local) {
    const src = toLocalThumbnailSrc(value)
    if (src) return { src, platform, fallbackSrc, isPlaceholder: false, label }
  }

  if (platform === 'instagram' || platform === 'discord') {
    return { src: null, platform, fallbackSrc, isPlaceholder: true, label }
  }

  const remote = [
    item.thumbnailUrl,
    item.thumbnail,
    item.videoInfo?.thumbnail
  ]

  for (const value of remote) {
    const src = toRemoteThumbnailSrc(value)
    if (src) return { src, platform, fallbackSrc, isPlaceholder: false, label }
  }

  return { src: null, platform, fallbackSrc, isPlaceholder: true, label }
}

export function getMediaPlatform(item: DownloadItem | HistoryEntry): MediaPlatform {
  const url = item.url.toLowerCase()
  const platform = (item.videoInfo?.platform || detectPlatform(item.url).name || '').toLowerCase()
  if (platform.includes('instagram') || url.includes('instagram.com')) return 'instagram'
  if (platform.includes('discord') || url.includes('discord.com') || url.includes('discordapp.com') || url.includes('cdn.discordapp.com')) return 'discord'
  if (platform.includes('youtube') || url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (platform.includes('twitter') || platform === 'x' || url.includes('twitter.com') || url.includes('x.com')) return 'twitter'
  return 'generic'
}

function getPlatformLabel(platform: MediaPlatform): string {
  if (platform === 'instagram') return 'IG'
  if (platform === 'discord') return 'DC'
  if (platform === 'youtube') return 'YT'
  if (platform === 'twitter') return 'X'
  return 'DM'
}

function getPlatformPlaceholder(platform: MediaPlatform): string {
  const label = getPlatformLabel(platform)
  if (platform === 'instagram') {
    return svgDataUrl('IG', '#833AB4', '#E1306C', '#FCAF45')
  }
  if (platform === 'discord') {
    return svgDataUrl('DC', '#5865F2', '#404EED', '#111827')
  }
  return svgDataUrl(label, '#7C3AED', '#2563EB', '#111827')
}

function toLocalThumbnailSrc(value?: string): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (/^data:image\//i.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return null
  return toFileUrl(trimmed)
}

function toRemoteThumbnailSrc(value?: string): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (/^data:image\//i.test(trimmed)) return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return null
  if (isBlockedCdnThumbnail(trimmed)) return null
  return trimmed
}

function isBlockedCdnThumbnail(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host.includes('cdninstagram.com')) return true
    const expires = url.searchParams.get('expires') || url.searchParams.get('Expires')
    if (expires) {
      const parsed = Number.parseInt(expires, 10)
      const expiresMs = parsed > 10_000_000_000 ? parsed : parsed * 1000
      if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return true
    }
    return false
  } catch {
    return true
  }
}

function toFileUrl(value: string): string {
  if (/^file:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  const normalized = value.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(prefixed)}`
}

function svgDataUrl(label: string, a: string, b: string, c: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset=".58" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="320" height="180" rx="18" fill="url(#g)"/><circle cx="258" cy="42" r="44" fill="rgba(255,255,255,.10)"/><circle cx="64" cy="142" r="54" fill="rgba(0,0,0,.16)"/><text x="160" y="101" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="44" font-weight="800" fill="white" letter-spacing="2">${label}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
