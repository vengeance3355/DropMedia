import { useState, useEffect } from 'react'
import type { DownloadItem } from '../types/index'

export function useLazyThumbnail(item: DownloadItem): string {
  const [lazy, setLazy] = useState<string>('')

  useEffect(() => {
    setLazy('')

    if (item.localThumbnail?.trim()) {
      setLazy(item.localThumbnail.trim())
      return
    }

    const candidates = [
      item.thumbnailPath?.trim(),
      item.localThumbnailPath?.trim(),
      item.thumbnail?.trim(),
      item.videoInfo?.thumbnail?.trim(),
      item.outputPath?.trim()
    ].filter(Boolean) as string[]
    if (candidates.length === 0) return

    let cancelled = false

    async function loadThumbnail() {
      for (const candidate of candidates) {
        if (/^(data:image\/|https?:\/\/)/i.test(candidate)) {
          if (!cancelled) setLazy(candidate)
          return
        }
        if (!isLikelyMediaPath(candidate)) continue
        try {
          const result = await window.api.getThumbnail(candidate)
          if (cancelled) return
          if (result) {
            setLazy(result)
            return
          }
        } catch {
          // Try next candidate.
        }
      }
    }

    loadThumbnail()

    return () => { cancelled = true }
  }, [item.localThumbnail, item.localThumbnailPath, item.outputPath, item.thumbnail, item.thumbnailPath, item.videoInfo?.thumbnail])

  return lazy
}

function isLikelyMediaPath(path: string): boolean {
  return /\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|wmv|jpg|jpeg|png|webp|gif|bmp)$/i.test(path)
}
