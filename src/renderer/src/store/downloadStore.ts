import { useState, useCallback, useEffect, useRef } from 'react'
import { DownloadItem, DownloadStatus, VideoInfo } from '../types'
import { nanoid } from '../utils/nanoid'

function normalizeLoadedItems(items: DownloadItem[]): DownloadItem[] {
  return items.map(item => {
    if (item.status === 'downloading' || item.status === 'fetching') {
      return {
        ...item,
        status: 'paused',
        speed: '',
        eta: '',
        error: undefined
      }
    }
    return item
  })
}

export function useDownloadStore() {
  const loadedRef = useRef(false)
  const [items, setItems] = useState<DownloadItem[]>(() => {
    try {
      const raw = localStorage.getItem('dropmedia.downloads')
      return raw ? normalizeLoadedItems(JSON.parse(raw) as DownloadItem[]) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    window.api.getSetting('downloadItems').then((stored) => {
      if (Array.isArray(stored)) {
        setItems(normalizeLoadedItems(stored as DownloadItem[]))
      } else if (items.length > 0) {
        window.api.setSetting('downloadItems', items.slice(0, 200)).catch(() => {})
      }
    }).finally(() => {
      loadedRef.current = true
    })
  }, [])

  useEffect(() => {
    const next = items.slice(0, 200)
    try {
      localStorage.setItem('dropmedia.downloads', JSON.stringify(next))
    } catch { /* local history persistence is best-effort */ }
    if (loadedRef.current) {
      window.api.setSetting('downloadItems', next).catch(() => {})
    }
  }, [items])

  const addItem = useCallback((url: string, selectedFormat: string, videoInfo?: VideoInfo, initial?: Partial<DownloadItem>): string => {
    const id = nanoid()
    setItems((prev) => [
      {
        ...initial,
        id,
        url,
        videoInfo,
        selectedFormat,
        status: initial?.status ?? 'pending',
        progress: initial?.progress ?? 0,
        speed: initial?.speed ?? '',
        eta: initial?.eta ?? '',
        totalSize: initial?.totalSize ?? ''
      },
      ...prev
    ])
    return id
  }, [])

  const updateStatus = useCallback((id: string, status: DownloadStatus, extra?: Partial<DownloadItem>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status, ...extra } : item
      )
    )
  }, [])

  const updateProgress = useCallback(
    (id: string, progress: number, speed: string, eta: string, totalSize: string) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, progress, speed, eta, totalSize } : item
        )
      )
    },
    []
  )

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearCompleted = useCallback(() => {
    setItems((prev) => prev.filter((item) => item.status !== 'completed' && item.status !== 'error'))
  }, [])

  return { items, addItem, updateStatus, updateProgress, removeItem, clearCompleted }
}
