/// <reference types="vite/client" />

import { VideoInfo, UpdateStatus } from './types'

interface DownloadRequest {
  id: string
  url: string
  format: string
  outputDir?: string
  filename?: string
}

interface DownloadProgressData {
  id: string
  percent: number
  totalSize: string
  speed: string
  eta: string
}

interface DownloadCompleteData {
  id: string
  success: boolean
  code: number
}

declare global {
  interface Window {
    api: {
      // Pencere
      minimizeWindow: () => void
      maximizeWindow: () => void
      closeWindow: () => void
      isMaximized: () => Promise<boolean>
      onWindowMaximized: (cb: (maximized: boolean) => void) => void

      // İndirici
      fetchInfo: (url: string) => Promise<VideoInfo>
      startDownload: (req: DownloadRequest) => Promise<{ started: boolean }>
      cancelDownload: (id: string) => Promise<boolean>
      checkYtDlp: () => Promise<string | null>
      updateYtDlp: () => Promise<{ success: boolean; version?: string; error?: string }>
      checkFfmpeg: () => Promise<boolean>

      // Olaylar
      onDownloadProgress: (cb: (data: DownloadProgressData) => void) => void
      onDownloadComplete: (cb: (data: DownloadCompleteData) => void) => void
      onDownloadLog: (cb: (data: { id: string; msg: string }) => void) => void
      offDownloadListeners: () => void

      // Ayarlar
      getSettings: () => Promise<Record<string, unknown>>
      getSetting: (key: string) => Promise<unknown>
      setSetting: (key: string, value: unknown) => Promise<void>

      // Sistem
      selectFolder: () => Promise<string | null>
      getDownloadsFolder: () => Promise<string>
      openFolder: (path: string) => Promise<void>
      getAppVersion: () => Promise<string>

      // Güncelleme
      checkForUpdates: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      onUpdateStatus: (cb: (data: UpdateStatus) => void) => void
    }
  }
}
