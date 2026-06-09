const DIRECT_MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|mpeg|mpg|mp3|m4a|aac|wav|flac|ogg|opus|m3u8|mpd)(?:$|[?#])/i

export function isLikelyVideoUrl(value: string): boolean {
  const candidate = value.trim()
  if (!candidate || /\s/.test(candidate)) return false

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (DIRECT_MEDIA_EXT.test(url.pathname)) return true

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase()
  const path = url.pathname.toLowerCase()

  if (host === 'youtu.be') return path.length > 1
  if (host.endsWith('youtube.com')) {
    return (path === '/watch' && !!url.searchParams.get('v')) ||
      path.startsWith('/shorts/') ||
      path.startsWith('/live/') ||
      path.startsWith('/embed/') ||
      path === '/playlist'
  }
  if (host.endsWith('instagram.com')) {
    return path.startsWith('/reel/') ||
      path.startsWith('/p/') ||
      path.startsWith('/tv/') ||
      path.startsWith('/stories/') ||
      path.startsWith('/stories/highlights/')
  }
  if (host.endsWith('tiktok.com')) return path.includes('/video/') || path.startsWith('/@') || path.startsWith('/t/')
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return /\/status\/\d+/.test(path)
  if (host.endsWith('vimeo.com') || host.endsWith('dailymotion.com') || host === 'dai.ly') return path.length > 1
  if (host.endsWith('twitch.tv')) return path.startsWith('/videos/') || path.startsWith('/clip/') || path.includes('/clip/')
  if (host.endsWith('facebook.com') || host === 'fb.watch') return path.includes('/videos/') || path.includes('/reel/') || path === '/watch'
  if (host.endsWith('reddit.com')) return path.includes('/comments/') || path.includes('/video/')
  if (host.endsWith('soundcloud.com')) return path.split('/').filter(Boolean).length >= 2

  return false
}
