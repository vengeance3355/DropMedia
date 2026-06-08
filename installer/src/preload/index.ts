import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getInfo:        () => ipcRenderer.invoke('installer-info'),
  selectDir:      () => ipcRenderer.invoke('installer-select-dir'),
  start:          (targetDir?: string) => ipcRenderer.invoke('installer-start', targetDir),
  launchAndQuit:  () => ipcRenderer.invoke('installer-launch-and-quit'),
  quit:           () => ipcRenderer.send('window-close'),

  onProgress: (cb: (d: { pct: number; status: string }) => void) =>
    ipcRenderer.on('installer-progress', (_e, d) => cb(d)),
  onDone: (cb: (d: { success: boolean; error?: string }) => void) =>
    ipcRenderer.on('installer-done', (_e, d) => cb(d))
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (e) { console.error(e) }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
