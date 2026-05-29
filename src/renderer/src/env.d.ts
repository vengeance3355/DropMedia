/// <reference types="vite/client" />
import { VideoInfo, UpdateStatus } from './types'

declare global {
  interface Window {
    api: {
      // Pencere
      minimizeWindow:    () => void
      maximizeWindow:    () => void
      closeWindow:       () => void
      isMaximized:       () => Promise<boolean>
      onWindowMaximized: (cb: (v: boolean) => void) => void
      openMiniWindow:    () => Promise<void>
      closeMiniWindow:   () => Promise<void>

      // İndirici
      fetchInfo:      (url: string)   => Promise<VideoInfo>
      fetchPlaylist:  (url: string)   => Promise<object[]>
      startDownload:  (req: object)   => Promise<{ started: boolean; error?: string }>
      resumeDownload: (req: object)   => Promise<{ started: boolean; error?: string }>
      pauseDownload:  (id: string)    => Promise<boolean>
      cancelDownload: (id: string)    => Promise<boolean>
      convertFile:    (req: object)   => Promise<{ success: boolean; error?: string }>
      checkYtDlp:     ()              => Promise<string | null>
      checkFfmpeg:    ()              => Promise<boolean>
      updateYtDlp:    ()              => Promise<{ success: boolean; version?: string; error?: string }>
      installFfmpeg:  ()              => Promise<{ success: boolean; error?: string }>
      detectCookieSources: (url?: string) => Promise<Array<{ id: string; label: string; browser: string; profile?: string; hasRelevantCookies: boolean }>>

      // Olaylar
      onDownloadProgress: (cb: (d: object) => void) => void
      onDownloadComplete: (cb: (d: object) => void) => void
      onDownloadPaused:   (cb: (d: object) => void) => void
      onDownloadLog:      (cb: (d: object) => void) => void
      onYtDlpProgress:    (cb: (d: object) => void) => void
      onFfmpegProgress:   (cb: (d: object) => void) => void
      offDownloadListeners: () => void
      offInstallerListeners: () => void

      // Clipboard
      onClipboardUrl:       (cb: (url: string) => void) => void
      onClipboardShortcut:  (cb: (url: string) => void) => void
      offClipboardListeners: () => void
      startClipboardWatch:  () => Promise<void>
      stopClipboardWatch:   () => Promise<void>
      setClipboardShortcut: (s: string) => Promise<void>

      // Ayarlar
      getSettings:    () => Promise<Record<string, unknown>>
      getSetting:     (key: string) => Promise<unknown>
      setSetting:     (key: string, value: unknown) => Promise<void>

      // Sistem
      selectFolder:       () => Promise<string | null>
      selectFile:         (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
      getDownloadsFolder: () => Promise<string>
      openFolder:         (path: string) => Promise<void>
      showItemInFolder:   (path: string) => Promise<void>
      openUrl:            (url: string) => Promise<void>
      openFileInPlayer:   (path: string) => Promise<void>
      startFileDrag:      (path: string) => Promise<{ success: boolean; error?: string }>
      getAppVersion:      () => Promise<string>

      // Güncelleme
      checkForUpdates: () => Promise<void>
      downloadUpdate:  () => Promise<void>
      installUpdate:   () => Promise<void>
      onUpdateStatus:  (cb: (data: object) => void) => void

      // Tray
      updateTrayCount: (n: number) => void
    }
  }
}
