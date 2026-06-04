import { useState, useCallback, useEffect } from 'react'
import { nanoid } from '../utils/nanoid'
import { SubtitleStyle } from '../types'

export type MediaJobKind = 'convert' | 'subtitle'
export type MediaJobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface MediaJob {
  id: string
  kind: MediaJobKind
  title: string
  status: MediaJobStatus
  percent: number | null   // null = indeterminate (total duration unknown)
  message: string
  outputPath?: string
  error?: string
  createdAt: number
}

export interface ConvertedRecord {
  id: string
  inputName: string
  outputPath: string
  format: string
  title: string
  convertedAt: number
}

export interface SubtitleRecord {
  id: string
  inputName: string
  outputPath: string
  title: string
  subtitledAt: number
}

function loadConverted(): ConvertedRecord[] {
  try { return JSON.parse(localStorage.getItem('dropmedia.converted') ?? '[]') } catch { return [] }
}

function saveConverted(records: ConvertedRecord[]): void {
  try { localStorage.setItem('dropmedia.converted', JSON.stringify(records.slice(0, 100))) } catch { /* best-effort */ }
}

function loadSubtitled(): SubtitleRecord[] {
  try { return JSON.parse(localStorage.getItem('dropmedia.subtitled') ?? '[]') } catch { return [] }
}

function saveSubtitled(records: SubtitleRecord[]): void {
  try { localStorage.setItem('dropmedia.subtitled', JSON.stringify(records.slice(0, 100))) } catch { /* best-effort */ }
}

interface ConvertOpts { inputPath: string; outputFormat: string; outputPath: string; title: string }
interface SubtitleOpts {
  inputPath: string
  outputPath: string
  mode: 'burn' | 'soft' | 'save'
  style: SubtitleStyle
  url?: string
  subtitlePath?: string
  lang?: string
  cookieBrowser?: string
  replaceOriginal?: boolean
  title?: string
}

// Owns background ffmpeg/yt-dlp jobs. Lives once at App level so jobs and their
// progress survive tab switches (the tab components mount/unmount, this does not).
export function useMediaJobs() {
  const [jobs, setJobs] = useState<MediaJob[]>([])
  const [convertedRecords, setConvertedRecords] = useState<ConvertedRecord[]>(loadConverted)
  const [subtitleRecords, setSubtitleRecords] = useState<SubtitleRecord[]>(loadSubtitled)

  useEffect(() => {
    window.api.onMediaJobProgress((d) => {
      const p = d as { id: string; kind: MediaJobKind; title: string; percent: number | null; message: string }
      setJobs(prev => {
        const exists = prev.some(j => j.id === p.id)
        if (exists) {
          return prev.map(j => j.id === p.id ? { ...j, percent: p.percent, message: p.message, status: 'running' as const } : j)
        }
        return [{ id: p.id, kind: p.kind, title: p.title, status: 'running', percent: p.percent, message: p.message, createdAt: Date.now() }, ...prev]
      })
    })

    window.api.onMediaJobComplete((d) => {
      const c = d as { id: string; kind: MediaJobKind; title: string; success: boolean; outputPath?: string; error?: string; cancelled?: boolean }
      setJobs(prev => prev.map(j => j.id === c.id ? {
        ...j,
        status: c.cancelled ? 'cancelled' : c.success ? 'done' : 'error',
        percent: c.success ? 100 : j.percent,
        outputPath: c.outputPath,
        error: c.error,
        message: ''
      } : j))

      if (c.kind === 'convert' && c.success && c.outputPath) {
        setConvertedRecords(prev => {
          const ext = c.outputPath!.split('.').pop()?.toUpperCase() ?? ''
          const record: ConvertedRecord = {
            id: c.id,
            inputName: c.title,
            outputPath: c.outputPath!,
            format: ext,
            title: c.title,
            convertedAt: Date.now()
          }
          const next = [record, ...prev.filter(r => r.id !== c.id)]
          saveConverted(next)
          return next
        })
      }

      if (c.kind === 'subtitle' && c.success && c.outputPath) {
        setSubtitleRecords(prev => {
          const record: SubtitleRecord = {
            id: c.id,
            inputName: c.title,
            outputPath: c.outputPath!,
            title: c.title,
            subtitledAt: Date.now()
          }
          const next = [record, ...prev.filter(r => r.id !== c.id)]
          saveSubtitled(next)
          return next
        })
      }
    })

    return () => window.api.offMediaJobListeners()
  }, [])

  const startConvert = useCallback(async (opts: ConvertOpts): Promise<string> => {
    const jobId = nanoid()
    setJobs(prev => [{ id: jobId, kind: 'convert', title: opts.title, status: 'running', percent: null, message: 'Hazırlanıyor…', createdAt: Date.now() }, ...prev])
    await window.api.startConvert({ ...opts, jobId })
    return jobId
  }, [])

  const startSubtitle = useCallback(async (opts: SubtitleOpts): Promise<string> => {
    const jobId = nanoid()
    const title = opts.title ?? 'Altyazı'
    setJobs(prev => [{ id: jobId, kind: 'subtitle', title, status: 'running', percent: null, message: 'Hazırlanıyor…', createdAt: Date.now() }, ...prev])
    await window.api.startSubtitleJob({ ...opts, jobId })
    return jobId
  }, [])

  const cancelJob = useCallback((id: string) => { window.api.cancelMediaJob(id).catch(() => {}) }, [])
  const dismissJob = useCallback((id: string) => setJobs(prev => prev.filter(j => j.id !== id)), [])

  const removeConverted = useCallback((id: string) => {
    setConvertedRecords(prev => {
      const next = prev.filter(r => r.id !== id)
      saveConverted(next)
      return next
    })
  }, [])

  const removeSubtitle = useCallback((id: string) => {
    setSubtitleRecords(prev => {
      const next = prev.filter(r => r.id !== id)
      saveSubtitled(next)
      return next
    })
  }, [])

  const convertActive  = jobs.some(j => j.kind === 'convert' && j.status === 'running')
  const subtitleActive = jobs.some(j => j.kind === 'subtitle' && j.status === 'running')

  return { jobs, convertedRecords, subtitleRecords, startConvert, startSubtitle, cancelJob, dismissJob, removeConverted, removeSubtitle, convertActive, subtitleActive }
}
