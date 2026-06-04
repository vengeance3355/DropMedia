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

function mergeDefined<T extends DownloadItem>(existing: T, update: Partial<DownloadItem>): T {
  const clean = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined)
  ) as Partial<DownloadItem>
  return { ...existing, ...clean }
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
    const api = window.api as typeof window.api & {
      onDownloadUpdated?: (cb: (item: Partial<DownloadItem> & { id: string }) => void) => void
      onDownloadItemsUpdated?: (cb: (items: DownloadItem[]) => void) => void
    }
    api.onDownloadUpdated?.((updated) => {
      setItems(prev => prev.map(item =>
        item.id === updated.id ? mergeDefined(item, updated) : item
      ))
    })
    api.onDownloadItemsUpdated?.((updatedItems) => {
      setItems(prev => {
        const byId = new Map(updatedItems.map(item => [item.id, item]))
        const merged = prev.map(item => {
          const updated = byId.get(item.id)
          return updated ? mergeDefined(item, updated) : item
        })
        const known = new Set(prev.map(item => item.id))
        const added = updatedItems.filter(item => !known.has(item.id))
        return [...merged, ...added]
      })
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
        item.id === id ? mergeDefined(item, { status, ...extra }) : item
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

  const updateLog = useCallback((id: string, log: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, downloadLog: log } : item
    ))
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearCompleted = useCallback(() => {
    setItems((prev) => prev.filter((item) => item.status !== 'completed' && item.status !== 'error' && item.status !== 'cancelled'))
  }, [])

  return { items, addItem, updateStatus, updateProgress, updateLog, removeItem, clearCompleted }
}
