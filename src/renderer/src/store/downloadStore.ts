import { useState, useCallback } from 'react'
import { DownloadItem, DownloadStatus, VideoInfo } from '../types'
import { nanoid } from '../utils/nanoid'

export function useDownloadStore() {
  const [items, setItems] = useState<DownloadItem[]>([])

  const addItem = useCallback((url: string, selectedFormat: string, videoInfo?: VideoInfo): string => {
    const id = nanoid()
    setItems((prev) => [
      {
        id,
        url,
        videoInfo,
        selectedFormat,
        status: 'pending',
        progress: 0,
        speed: '',
        eta: '',
        totalSize: ''
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
