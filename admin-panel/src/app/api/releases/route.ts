export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'

const OWNER = 'vengeance3355'
const REPO  = 'DropMedia'

interface GithubRelease {
  id: number
  tag_name: string
  name?: string
  body?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string
  assets?: Array<{ name: string; browser_download_url: string }>
}

export async function GET() {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dropmedia-admin', ...authHeader() },
    cache: 'no-store'
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return NextResponse.json({ data: [], error: parseError(body) || `GitHub ${res.status}` })
  }
  const releases = await res.json() as GithubRelease[]
  const data = releases.filter(r => !r.draft).map(mapRelease)
  return NextResponse.json({ data, count: data.length, source: 'github' })
}

export async function DELETE(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) return NextResponse.json({ error: 'GITHUB_RELEASE_TOKEN tanımlanmamış.' }, { status: 503 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id gerekli' }, { status: 400 })

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${id}`, {
    method: 'DELETE',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'dropmedia-admin' }
  })
  if (res.status !== 204) {
    const body = await res.text().catch(() => '')
    return NextResponse.json({ error: parseError(body) || `GitHub ${res.status}` }, { status: 502 })
  }
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) return NextResponse.json({ error: 'GITHUB_RELEASE_TOKEN tanımlanmamış.' }, { status: 503 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id gerekli' }, { status: 400 })

  const payload = await req.json().catch(() => ({})) as { notes?: string }
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${id}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dropmedia-admin'
    },
    body: JSON.stringify({ body: payload.notes ?? '' })
  })
  if (!res.ok) {
    const b = await res.text().catch(() => '')
    return NextResponse.json({ error: parseError(b) || `GitHub ${res.status}` }, { status: 502 })
  }
  const updated = await res.json() as GithubRelease
  return NextResponse.json({ ok: true, data: mapRelease(updated) })
}

function authHeader(): Record<string, string> {
  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function mapRelease(r: GithubRelease) {
  const version = r.tag_name.replace(/^v/i, '')
  const exe      = r.assets?.find(a => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name))
  const blockmap = r.assets?.find(a => /\.exe\.blockmap$/i.test(a.name))
  const yml      = r.assets?.find(a => a.name === 'latest.yml')
  return {
    github_id:            r.id,
    version,
    title:                r.name ?? `DropMedia v${version}`,
    notes:                r.body ?? '',
    github_tag:           r.tag_name,
    windows_exe_url:      exe?.browser_download_url,
    windows_blockmap_url: blockmap?.browser_download_url,
    latest_yml_url:       yml?.browser_download_url,
    asset_names:          r.assets?.map(a => a.name) ?? [],
    created_at:           r.published_at,
    prerelease:           r.prerelease ?? false
  }
}

function parseError(body: string): string {
  try {
    const p = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string }> }
    return [p.message, ...(p.errors ?? []).map(e => e.message)].filter(Boolean).join(' ')
  } catch { return body.slice(0, 300) }
}
