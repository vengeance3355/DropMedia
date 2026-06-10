import { spawn } from 'child_process'
import { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, globalShortcut, clipboard, net } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, appendFileSync } from 'fs'

function dbgSettings(msg: string) {
  try { appendFileSync(join(tmpdir(), 'dropmedia_settings.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { buildAccessArgs, getYtDlpPath, probeDuration, setupDownloadHandlers } from './downloader'
import { setupAiHandlers } from './ai'
import { setupMediaJobHandlers } from './mediaJobs'
import { setupProductHubHandlers, startProductWatchScheduler, stopProductWatchScheduler } from './productHub'
import { setupSyncHandlers } from './sync'
import { setupAdminClientHandlers } from './adminClient'
import { setupUpdater } from './updater'
import { setupInstallerHandlers, maybeAutoUpdateYtDlp } from './installer'
import { setupInstagramStoryHandlers } from './instagramStories'
import { ensureWindowsAppIdentity, showNotification } from './windowsIdentity'
import { snapshotAllCookies } from './cookies'
import { flushPendingRemoteLogs, logActivity, logError, getLocalLogPath } from './logger'
import { startAdminBridge } from './adminBridge'
import { isLikelyVideoUrl } from './videoUrl'
import { downloadRemoteThumbnail, downloadRemoteThumbnailForItem, generateThumbnail, generateThumbnailForItem, pathToDataUrl } from './thumbnailCache'
import Store from 'electron-store'

const store = new Store()

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let tray: Tray | null = null

// ── Pencere oluşturma ─────────────────────────────────────────────────────────

function createWindow(): void {
  const bounds = store.get('windowBounds') as Electron.Rectangle | undefined

  mainWindow = new BrowserWindow({
    width:  bounds?.width  ?? 1100,
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Pencere boyutunu kaydet
  mainWindow.on('close', () => {
    if (mainWindow) store.set('windowBounds', mainWindow.getBounds())
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window-maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximized', false))
}

function createMiniWindow(): void {
  if (miniWindow) { miniWindow.focus(); return }

  miniWindow = new BrowserWindow({
    width: 360,
    height: 480,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const url = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}?mini=1`
    : join(__dirname, '../renderer/index.html')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mini=1`)
  } else {
    miniWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { mini: '1' } })
  }

  miniWindow.on('closed', () => { miniWindow = null })
}

// ── Sistem tepsisi ────────────────────────────────────────────────────────────

function setupTray(): void {
  // 16x16 minimal PNG icon (base64 embedded — dosya bulunamazsa)
  const iconPath = join(__dirname, '../../resources/tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath).isEmpty()
    ? nativeImage.createEmpty()
    : nativeImage.createFromPath(iconPath)

  tray = new Tray(icon)
  tray.setToolTip('DropMedia')

  const updateMenu = (activeCount = 0) => {
    const menu = Menu.buildFromTemplate([
      { label: activeCount > 0 ? `${activeCount} indirme devam ediyor` : 'DropMedia', enabled: false },
      { type: 'separator' },
      { label: 'Aç',        click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Mini Mod',  click: () => createMiniWindow() },
      { type: 'separator' },
      { label: 'Çıkış',    click: () => app.quit() }
    ])
    tray?.setContextMenu(menu)
  }

  updateMenu(0)
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })

  ipcMain.on('tray-update-count', (_e, count: number) => updateMenu(count))
}

// ── Clipboard izleme ──────────────────────────────────────────────────────────

let clipboardInterval: ReturnType<typeof setInterval> | null = null
let lastClipboard = ''

function sendClipboardUrl(text: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('clipboard-url', text)
}

function startClipboardWatch(): void {
  if (clipboardInterval) return
  try {
    lastClipboard = clipboard.readText().trim()
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    logError({ errorType: 'clipboard', errorMessage: 'Clipboard okunamadı.', stackTrace: e.stack, operation: 'clipboard-watch-start' })
    return
  }

  clipboardInterval = setInterval(() => {
    try {
      const text = clipboard.readText().trim()
      if (text === lastClipboard) return
      lastClipboard = text

      if (isLikelyVideoUrl(text)) {
        sendClipboardUrl(text)
      }
    } catch (err) {
      if (app.isQuiting) {
        stopClipboardWatch()
        return
      }
      const e = err instanceof Error ? err : new Error(String(err))
      logError({ errorType: 'clipboard', errorMessage: 'Clipboard izleme sırasında pano okunamadı.', stackTrace: e.stack, operation: 'clipboard-watch-tick' })
    }
  }, 1000)
}

function stopClipboardWatch(): void {
  if (clipboardInterval) {
    clearInterval(clipboardInterval)
    clipboardInterval = null
  }
}

function registerClipboardShortcut(shortcut: string): void {
  globalShortcut.unregisterAll()
  if (!shortcut) return

  try {
    globalShortcut.register(shortcut, () => {
      try {
        const text = clipboard.readText().trim()
        if (isLikelyVideoUrl(text)) {
          if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
          mainWindow.webContents.send('clipboard-shortcut-url', text)
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        logError({
          errorType: 'clipboard',
          errorMessage: 'Clipboard kısayolu çalıştırılamadı.',
          stackTrace: e.stack,
          operation: 'clipboard-shortcut-run'
        })
      }
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    logError({
      errorType: 'clipboard',
      errorMessage: 'Clipboard kısayolu kaydedilemedi.',
      stackTrace: e.stack,
      operation: 'clipboard-shortcut-register',
      details: { shortcut }
    })
  }
}

// ── Crash koruması ────────────────────────────────────────────────────────────

process.on('uncaughtException',  (err)    => logError({ errorType: 'crash', errorMessage: err.message, stackTrace: err.stack }))
process.on('unhandledRejection', (reason) => logError({ errorType: 'crash', errorMessage: String(reason) }))

// ── App başlatma ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.dropmedia.app')
  // Toast bildirimlerinde "DropMedia" adı + logo göster (ham AUMID yerine).
  void ensureWindowsAppIdentity()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupWindowControls()
  // Çerez snapshot'ını açılışta + periyodik tazele: tarayıcının doğal kapalı
  // anlarını yakalayıp çerezleri kaydet (sonra tarayıcı açıkken de kullanılır).
  void snapshotAllCookies()
  setInterval(() => { void snapshotAllCookies() }, 4 * 60_000)

  // yt-dlp'yi sessizce güncel tut: bayat binary = YouTube format/extractor
  // kırılması. Açılışta (boştayken) + günde bir kez en son sürüme yükseltir.
  setTimeout(() => { void maybeAutoUpdateYtDlp() }, 8000)
  setInterval(() => { void maybeAutoUpdateYtDlp() }, 24 * 60 * 60_000)
  setupDownloadHandlers(ipcMain)
  setupInstagramStoryHandlers(ipcMain)
  // Toast'ları main process'ten gönder (logo + doğru başlık garantisi).
  ipcMain.handle('notify', (_e, payload: { title?: string; body?: string }) => {
    showNotification(payload?.title || 'DropMedia', payload?.body || '')
  })
  setupAiHandlers(ipcMain)
  setupMediaJobHandlers(ipcMain)
  setupProductHubHandlers(ipcMain)
  setupSyncHandlers(ipcMain)
  setupAdminClientHandlers(ipcMain)

  // Thumbnail IPC — video path'ten ffmpeg ile frame çıkar, image path'ten dosyayı oku
  ipcMain.handle('get-thumbnail', async (_e, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) return null

      if (/\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filePath)) {
        return pathToDataUrl(filePath)
      }

      if (/\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|wmv)$/i.test(filePath)) {
        const outPath = await generateThumbnail(filePath)
        return outPath ? pathToDataUrl(outPath) : null
      }
      return null
    } catch { return null }
  })
  ipcMain.handle('repair-media-metadata', async (_e, id?: string) => {
    if (!id) return { success: false, error: 'Tek kayıt id gerekli.' }
    return repairDownloadItem(id)
  })
  ipcMain.handle('repair-thumbnail', async (_e, id: string) => repairDownloadItem(id))
  setupInstallerHandlers(ipcMain)
  setupSettingsHandlers(ipcMain, store)
  setupClipboardHandlers(ipcMain)

  createWindow()
  setupTray()
  setupUpdater(mainWindow!)
  startAdminBridge()
  startProductWatchScheduler()
  flushPendingRemoteLogs()
  const remoteLogRetry = setInterval(() => flushPendingRemoteLogs(), 60_000)
  remoteLogRetry.unref?.()
  logActivity({ eventType: 'app_open', message: 'Uygulama açıldı', details: { windowCount: BrowserWindow.getAllWindows().length } })

  // Clipboard izlemeyi ayara göre başlat
  if (store.get('clipboardWatch')) startClipboardWatch()
  const shortcut = store.get('clipboardShortcut') as string | undefined
  if (shortcut) registerClipboardShortcut(shortcut)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Tray varsa pencere kapatınca çıkma — minimize et
app.on('before-quit', () => {
  app.isQuiting = true
  stopClipboardWatch()
  stopProductWatchScheduler()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Tray yoksa çıkış yap
    if (!tray) app.quit()
  }
})

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function setupWindowControls(): void {
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window-close', () => {
    if (store.get('closeToTray')) {
      mainWindow?.hide()
    } else {
      app.isQuiting = true
      mainWindow?.close()
    }
  })
  ipcMain.handle('window-is-maximized',    () => mainWindow?.isMaximized())
  ipcMain.handle('open-mini-window',       () => createMiniWindow())
  ipcMain.handle('close-mini-window',      () => miniWindow?.close())
  ipcMain.handle('open-file-in-player',    (_e, path: string) => shell.openPath(path))
  ipcMain.handle('copy-file-to-clipboard', (_e, filePath: string) => {
    try {
      clipboard.writeBuffer('text/uri-list', Buffer.from(`file://${filePath}\r\n`))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle('start-file-drag',        async (_e, filePath: string, iconDataUrl?: string) => {
    try {
      if (!filePath || !existsSync(filePath)) {
        await logError({
          errorType: 'general',
          errorMessage: 'Sürüklenmek istenen dosya bulunamadı.',
          operation: 'start-file-drag',
          details: { filePath }
        })
        return { success: false, error: 'Dosya bulunamadı.' }
      }
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { success: false, error: 'Ana pencere hazır değil.' }
      }

      let icon = nativeImage.createEmpty()
      if (iconDataUrl?.startsWith('data:')) {
        icon = nativeImage.createFromDataURL(iconDataUrl)
      } else if (iconDataUrl?.startsWith('file://')) {
        const p = decodeURI(iconDataUrl.replace(/^file:\/\//, ''))
        if (existsSync(p)) icon = nativeImage.createFromPath(p)
      }
      if (icon.isEmpty() && iconDataUrl && (iconDataUrl.startsWith('https://') || iconDataUrl.startsWith('http://'))) {
        try {
          const resp = await net.fetch(iconDataUrl)
          const buf = Buffer.from(await resp.arrayBuffer())
          icon = nativeImage.createFromBuffer(buf)
        } catch { /* fall through */ }
      }
      if (icon.isEmpty()) {
        const iconPath = join(__dirname, '../../resources/icon.png')
        if (existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath)
      }
      if (!icon.isEmpty()) icon = icon.resize({ width: 96, height: 56 })
      mainWindow.webContents.startDrag({ file: filePath, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon })
      return { success: true }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({
        errorType: 'general',
        errorMessage: 'Dosya sürükleme başlatılamadı.',
        stackTrace: e.stack,
        operation: 'start-file-drag',
        details: { filePath }
      })
      return { success: false, error: 'Dosya sürükleme başlatılamadı.' }
    }
  })
}

function setupClipboardHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('clipboard-watch-start',  () => {
    store.set('clipboardWatch', true)
    startClipboardWatch()
  })
  ipcMain.handle('clipboard-watch-stop',   () => {
    store.set('clipboardWatch', false)
    stopClipboardWatch()
  })
  ipcMain.handle('clipboard-shortcut-set', (_e, shortcut: string) => {
    store.set('clipboardShortcut', shortcut)
    registerClipboardShortcut(shortcut)
  })
}

function setupSettingsHandlers(ipcMain: Electron.IpcMain, store: Store): void {
  ipcMain.handle('settings-get',     (_e, key: string)           => store.get(key))
  ipcMain.handle('settings-set',     async (_e, key: string, val: unknown) => {
    dbgSettings(`SET ${key}=${JSON.stringify(val)?.slice(0, 100)}`)
    try {
      store.set(key, val)
      dbgSettings(`SET_OK ${key}`)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      await logError({
        errorType: 'settings',
        errorMessage: 'Ayar kaydedilemedi.',
        stackTrace: e.stack,
        operation: 'settings-set',
        details: { key }
      })
      throw new Error('Ayar kaydedilemedi.')
    }
  })
  ipcMain.handle('settings-get-all', () => {
    const s = store.store
    dbgSettings(`GET_ALL → clipboardWatch=${s['clipboardWatch']} cookieBrowser=${s['cookieBrowser']}`)
    return s
  })

  ipcMain.handle('dialog-select-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog-select-file', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: filters ?? [{ name: 'Medya Dosyaları', extensions: ['mp4','mkv','webm','mov','avi','mp3','m4a','flac','wav','ogg'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('get-downloads-folder', () => app.getPath('downloads'))
  ipcMain.handle('open-folder',          (_e, p: string) => shell.openPath(p))
  ipcMain.handle('show-item-in-folder',  (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('open-url',             (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app-version',          () => app.getVersion())
  ipcMain.handle('get-log-path',         () => getLocalLogPath())
  ipcMain.handle('client-error-log', async (_e, payload: { message?: string; stack?: string; operation?: string; details?: Record<string, unknown> }) => {
    await logError({
      errorType: 'general',
      errorMessage: String(payload?.message || 'Renderer hatası'),
      stackTrace: payload?.stack,
      operation: payload?.operation || 'renderer-error',
      details: payload?.details
    })
    return { ok: true, localLogPath: getLocalLogPath() }
  })
}

async function repairDownloadItem(id: string): Promise<{ success: boolean; item?: DownloadItemRecord; error?: string }> {
  if (!id) return { success: false, error: 'Kayıt bulunamadı.' }

  const items = store.get('downloadItems', []) as DownloadItemRecord[]
  const index = items.findIndex(item => item.id === id)
  if (index < 0) return { success: false, error: 'Kayıt bulunamadı.' }

  const item = { ...items[index] }
  let changed = false
  const existingThumbnail = normalizeFilePath(item.thumbnailPath || item.localThumbnailPath)
  const platform = detectRepairPlatform(item)

  if (existingThumbnail && existsSync(existingThumbnail)) {
    item.thumbnailPath = existingThumbnail
    item.localThumbnailPath = existingThumbnail
    changed = true
  } else if (platform === 'instagram') {
    const remote = await getRemoteThumbnailForRepair(item, true)
    const downloaded = remote ? await downloadRemoteThumbnailForItem(remote, item.id).catch(() => null) : null
    if (downloaded) {
      item.thumbnailPath = downloaded
      item.localThumbnailPath = downloaded
      changed = true
    } else if (item.outputPath && existsSync(normalizeFilePath(item.outputPath))) {
      const generated = await generateThumbnailForItem(normalizeFilePath(item.outputPath), item.id).catch(() => null)
      if (generated) {
        item.thumbnailPath = generated
        item.localThumbnailPath = generated
        changed = true
      }
    }
  } else if (platform === 'discord') {
    if (item.outputPath && existsSync(normalizeFilePath(item.outputPath))) {
      const generated = await generateThumbnailForItem(normalizeFilePath(item.outputPath), item.id).catch(() => null)
      if (generated) {
        item.thumbnailPath = generated
        item.localThumbnailPath = generated
        changed = true
      }
    } else {
      logActivity({
        eventType: 'general',
        message: 'Discord thumbnail repair skipped: missing outputPath',
        details: { id: item.id, outputPath: item.outputPath }
      })
    }
  } else {
    const generated = item.outputPath && existsSync(normalizeFilePath(item.outputPath))
      ? await generateThumbnail(normalizeFilePath(item.outputPath)).catch(() => null)
      : null
    const remote = await getRemoteThumbnailForRepair(item, false)
    const downloaded = generated || (remote ? await downloadRemoteThumbnail(remote).catch(() => null) : null)

    if (downloaded) {
      item.thumbnailPath = downloaded
      item.localThumbnailPath = downloaded
      changed = true
    }
  }

  if (item.outputPath && existsSync(normalizeFilePath(item.outputPath)) && !item.duration) {
    const duration = await probeDuration(normalizeFilePath(item.outputPath)).catch(() => undefined)
    if (duration) {
      item.duration = duration
      changed = true
    }
  }

  if (!changed) return { success: false, item, error: 'Onarılacak kapak veya süre bulunamadı.' }

  items[index] = item
  store.set('downloadItems', items)
  mainWindow?.webContents.send('download-updated', item)
  miniWindow?.webContents.send('download-updated', item)
  mainWindow?.webContents.send('download-items-updated', items)
  miniWindow?.webContents.send('download-items-updated', items)
  return { success: true, item }
}

async function getRemoteThumbnailForRepair(item: DownloadItemRecord, fetchFromSource: boolean): Promise<string | undefined> {
  const direct = [
    item.videoInfo?.remoteThumbnail,
    item.thumbnailUrl,
    item.videoInfo?.thumbnail,
    item.thumbnail
  ].find(isHttpUrlString)
  if (direct) return direct
  if (!fetchFromSource) return undefined
  return fetchSourceThumbnailUrl(item.url)
}

function fetchSourceThumbnailUrl(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve(undefined)
      return
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      resolve(undefined)
      return
    }

    const proc = spawn(getYtDlpPath(), [
      '--ignore-config',
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      ...buildAccessArgs(url),
      '--',
      url
    ])
    let stdout = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve(undefined)
    }, 20_000)

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(undefined)
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { thumbnail?: string; thumbnails?: Array<{ url?: string }> }
        resolve(parsed.thumbnail || parsed.thumbnails?.find(t => isHttpUrlString(t.url))?.url)
      } catch {
        resolve(undefined)
      }
    })
  })
}

function detectRepairPlatform(item: DownloadItemRecord): 'instagram' | 'discord' | 'other' {
  const url = item.url.toLowerCase()
  const platform = (item.videoInfo?.platform || '').toLowerCase()
  if (platform.includes('instagram') || url.includes('instagram.com')) return 'instagram'
  if (platform.includes('discord') || url.includes('discord.com') || url.includes('discordapp.com') || url.includes('cdn.discordapp.com')) return 'discord'
  return 'other'
}

function isHttpUrlString(value?: string): value is string {
  return !!value && /^https?:\/\//i.test(value)
}

function normalizeFilePath(value?: string): string {
  if (!value) return ''
  if (!/^file:\/\//i.test(value)) return value
  try {
    return decodeURI(new URL(value).pathname)
  } catch {
    return value.replace(/^file:\/\//i, '')
  }
}

interface DownloadItemRecord {
  id: string
  url: string
  status: string
  outputPath?: string
  thumbnailPath?: string
  localThumbnailPath?: string
  thumbnailUrl?: string
  thumbnail?: string
  duration?: number
  videoInfo?: {
    thumbnail?: string
    remoteThumbnail?: string
    platform?: string
  }
}

// TypeScript için app genişletme
declare global {
  namespace Electron {
    interface App { isQuiting?: boolean }
  }
}
