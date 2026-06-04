import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import http from 'http'
import https from 'https'
import { join } from 'path'
import { app } from 'electron'

let chain: Promise<unknown> = Promise.resolve()

export function generateThumbnail(filePath: string): Promise<string | null> {
  const next = chain.then(() => generateThumbnailNow(filePath), () => generateThumbnailNow(filePath))
  chain = next
  return next
}

export function generateThumbnailForItem(filePath: string, itemId: string): Promise<string | null> {
  const next = chain.then(() => generateThumbnailNow(filePath, itemId), () => generateThumbnailNow(filePath, itemId))
  chain = next
  return next
}

export function downloadRemoteThumbnail(imageUrl: string): Promise<string | null> {
  const next = chain.then(() => downloadRemoteThumbnailNow(imageUrl), () => downloadRemoteThumbnailNow(imageUrl))
  chain = next
  return next
}

export function downloadRemoteThumbnailForItem(imageUrl: string, itemId: string): Promise<string | null> {
  const next = chain.then(() => downloadRemoteThumbnailNow(imageUrl, itemId), () => downloadRemoteThumbnailNow(imageUrl, itemId))
  chain = next
  return next
}

export function pathToDataUrl(filePath: string): string | null {
  if (!filePath || !existsSync(filePath)) return null
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'jpg'
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`
}

async function downloadRemoteThumbnailNow(imageUrl: string, itemId?: string): Promise<string | null> {
  try {
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null

    const cacheDir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(cacheDir, { recursive: true })
    const key = createHash('sha1').update(imageUrl).digest('hex')
    const name = itemId ? itemId.replace(/[^a-z0-9_-]/gi, '') || key : key
    const outPath = join(cacheDir, `${name}.jpg`)
    if (existsSync(outPath)) return outPath

    await new Promise<void>((resolve, reject) => {
      const proto = imageUrl.startsWith('https') ? https : http
      const file = createWriteStream(outPath)
      proto.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) {
          file.close()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
      }).on('error', reject)
    })
    return existsSync(outPath) ? outPath : null
  } catch {
    return null
  }
}

async function generateThumbnailNow(filePath: string, itemId?: string): Promise<string | null> {
  try {
    if (!filePath || !existsSync(filePath)) return null
    if (isImagePath(filePath)) return filePath
    if (!isVideoPath(filePath)) return null

    const cacheDir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(cacheDir, { recursive: true })
    const key = createHash('sha1')
      .update(filePath)
      .update(String(statSync(filePath).mtimeMs))
      .digest('hex')
    const name = itemId ? itemId.replace(/[^a-z0-9_-]/gi, '') || key : key
    const outPath = join(cacheDir, `${name}.jpg`)
    if (existsSync(outPath)) return outPath

    await runFfmpeg(filePath, outPath)
    return existsSync(outPath) ? outPath : null
  } catch {
    return null
  }
}

function runFfmpeg(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), [
      '-ss', '00:00:01',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=320:-1',
      '-y',
      outPath
    ])
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('thumbnail timeout'))
    }, 10_000)
    proc.on('close', code => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))
    })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function isVideoPath(filePath: string): boolean {
  return /\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|wmv)$/i.test(filePath)
}

function isImagePath(filePath: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filePath)
}

function getFfmpegPath(): string {
  const candidates = [
    `${process.env.HOME}/.local/bin/ffmpeg`,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg'
  ]
  return candidates.find(p => existsSync(p)) ?? 'ffmpeg'
}
