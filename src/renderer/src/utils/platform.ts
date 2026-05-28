export function detectPlatform(url: string): { name: string; color: string; icon: string } {
  const u = url.toLowerCase()
  if (u.includes('youtube.com') || u.includes('youtu.be'))
    return { name: 'YouTube', color: '#ff0000', icon: 'yt' }
  if (u.includes('twitter.com') || u.includes('x.com'))
    return { name: 'X (Twitter)', color: '#1da1f2', icon: 'x' }
  if (u.includes('instagram.com'))
    return { name: 'Instagram', color: '#e1306c', icon: 'ig' }
  if (u.includes('tiktok.com'))
    return { name: 'TikTok', color: '#010101', icon: 'tt' }
  if (u.includes('twitch.tv'))
    return { name: 'Twitch', color: '#9146ff', icon: 'twitch' }
  if (u.includes('vimeo.com'))
    return { name: 'Vimeo', color: '#1ab7ea', icon: 'vimeo' }
  if (u.includes('facebook.com') || u.includes('fb.watch'))
    return { name: 'Facebook', color: '#1877f2', icon: 'fb' }
  if (u.includes('reddit.com'))
    return { name: 'Reddit', color: '#ff4500', icon: 'reddit' }
  if (u.includes('dailymotion.com'))
    return { name: 'Dailymotion', color: '#0066DC', icon: 'dm' }
  if (u.includes('bilibili.com'))
    return { name: 'Bilibili', color: '#00a1d6', icon: 'bili' }
  return { name: 'Video', color: '#7c3aed', icon: 'video' }
}

export function formatDuration(seconds: number): string {
  if (!seconds) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
