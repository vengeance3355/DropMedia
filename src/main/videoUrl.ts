const DIRECT_MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|mpeg|mpg|mp3|m4a|aac|wav|flac|ogg|opus|m3u8|mpd)(?:$|[?#])/i

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}

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
  if (matchesDomain(host, 'youtube.com')) {
    return (path === '/watch' && !!url.searchParams.get('v')) ||
      path.startsWith('/shorts/') ||
      path.startsWith('/live/') ||
      path.startsWith('/embed/') ||
      path === '/playlist'
  }
  if (matchesDomain(host, 'instagram.com')) {
    return path.startsWith('/reel/') ||
      path.startsWith('/p/') ||
      path.startsWith('/tv/') ||
      path.startsWith('/stories/') ||
      path.startsWith('/stories/highlights/')
  }
  if (matchesDomain(host, 'tiktok.com')) return path.includes('/video/') || path.startsWith('/@') || path.startsWith('/t/')
  if (host === 'x.com' || host === 'twitter.com' || matchesDomain(host, 'twitter.com')) return /\/status\/\d+/.test(path)
  if (matchesDomain(host, 'vimeo.com') || matchesDomain(host, 'dailymotion.com') || host === 'dai.ly') return path.length > 1
  if (matchesDomain(host, 'twitch.tv')) return path.startsWith('/videos/') || path.startsWith('/clip/') || path.includes('/clip/')
  if (matchesDomain(host, 'facebook.com') || host === 'fb.watch') return path.includes('/videos/') || path.includes('/reel/') || path === '/watch'
  if (matchesDomain(host, 'reddit.com')) return path.includes('/comments/') || path.includes('/video/')
  if (matchesDomain(host, 'soundcloud.com')) return path.split('/').filter(Boolean).length >= 2

  return false
}
