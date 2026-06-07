export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'
import { getSupabase } from '@/lib/supabase'

interface ReleasePayload {
  version: string
  channel?: string
  title?: string
  notes?: string
  github_tag?: string
  appimage_url?: string
  deb_url?: string
  windows_exe_url?: string
  windows_blockmap_url?: string
  latest_yml_url?: string
  asset_names?: string[]
  mandatory?: boolean
  published?: boolean
}

export async function GET() {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json(await getGithubReleaseFallback('none'))
  }

  const { data: rows, count, error } = await sb
    .from('app_releases')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json(await getGithubReleaseFallback('supabase_error', error.message))
  const github = await getGithubReleaseFallback('supabase_merge')
  const merged = github.data.length ? mergeReleaseRows(rows ?? [], github.data) : (rows ?? [])
  return NextResponse.json({
    data: merged,
    count: merged.length || count || 0,
    source: github.data.length ? 'supabase+github' : 'supabase',
    error: github.data.length ? undefined : github.error
  })
}

export async function POST(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let payload: Partial<ReleasePayload>
  try {
    payload = normalizePayload(await req.json())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Geçersiz veri' }, { status: 400 })
  }

  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ error: 'Supabase bağlantısı yok' }, { status: 503 })
  }

  const { data, error } = await sb
    .from('app_releases')
    .upsert(payload, { onConflict: 'version' })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id gerekli' }, { status: 400 })

  let payload: Partial<ReleasePayload>
  try {
    payload = normalizePayload(await req.json(), true)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Geçersiz veri' }, { status: 400 })
  }
  let sb
  try { sb = getSupabase() } catch {
    return NextResponse.json({ error: 'Supabase bağlantısı yok' }, { status: 503 })
  }

  const { data, error } = await sb
    .from('app_releases')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

function normalizePayload(input: Partial<ReleasePayload>, patch = false): Partial<ReleasePayload> {
  const version = input.version?.trim().replace(/^v/i, '')
  if (!patch && !version) throw new Error('version gerekli')
  return {
    ...(version ? { version } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.github_tag !== undefined ? { github_tag: input.github_tag } : {}),
    ...(input.appimage_url !== undefined ? { appimage_url: input.appimage_url } : {}),
    ...(input.deb_url !== undefined ? { deb_url: input.deb_url } : {}),
    ...(input.latest_yml_url !== undefined ? { latest_yml_url: input.latest_yml_url } : {}),
    ...(input.mandatory !== undefined ? { mandatory: !!input.mandatory } : {}),
    ...(input.published !== undefined ? { published: !!input.published } : {})
  }
}

async function getGithubReleaseFallback(source: string, error?: string) {
  try {
    const res = await fetch('https://api.github.com/repos/vengeance3355/DropMedia/releases?per_page=20', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dropmedia-admin'
      },
      next: { revalidate: 60 }
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)

    const releases = await res.json() as Array<{
      id: number
      tag_name: string
      name?: string
      body?: string
      prerelease?: boolean
      draft?: boolean
      published_at?: string
      assets?: Array<{ name: string; browser_download_url: string }>
    }>

    const data = releases
      .filter(release => !release.draft)
      .map(release => {
        const appImage = release.assets?.find(asset => asset.name.endsWith('.AppImage'))
        const deb = release.assets?.find(asset => asset.name.endsWith('.deb'))
        const winExe = release.assets?.find(asset => /\.exe$/i.test(asset.name))
        const winBlockmap = release.assets?.find(asset => /\.exe\.blockmap$/i.test(asset.name))
        const latest = release.assets?.find(asset => asset.name === 'latest.yml' || asset.name === 'latest-linux.yml')
        const version = release.tag_name.replace(/^v/i, '')

        return {
          id: `github-${release.id}`,
          version,
          channel: release.prerelease ? 'beta' : 'stable',
          title: release.name ?? `DropMedia v${version}`,
          notes: release.body ?? '',
          github_tag: release.tag_name,
          appimage_url: appImage?.browser_download_url,
          deb_url: deb?.browser_download_url,
          windows_exe_url: winExe?.browser_download_url,
          windows_blockmap_url: winBlockmap?.browser_download_url,
          latest_yml_url: latest?.browser_download_url,
          asset_names: release.assets?.map(asset => asset.name) ?? [],
          mandatory: false,
          published: true,
          created_at: release.published_at
        }
      })

    return { data, count: data.length, source: `github_fallback:${source}`, error }
  } catch (err) {
    return {
      data: [],
      count: 0,
      source,
      error: error ?? (err instanceof Error ? err.message : 'GitHub release fallback okunamadı')
    }
  }
}

function mergeReleaseRows(supabaseRows: Array<Record<string, any>>, githubRows: Array<Record<string, any>>) {
  const githubByVersion = new Map(githubRows.map(row => [String(row.version ?? '').replace(/^v/i, ''), row]))
  const merged = supabaseRows.map(row => {
    const version = String(row.version ?? '').replace(/^v/i, '')
    const github = githubByVersion.get(version)
    if (!github) return row
    githubByVersion.delete(version)
    return {
      ...github,
      ...row,
      windows_exe_url: github.windows_exe_url,
      windows_blockmap_url: github.windows_blockmap_url,
      latest_yml_url: github.latest_yml_url ?? row.latest_yml_url,
      asset_names: github.asset_names
    }
  })

  return [...merged, ...githubByVersion.values()]
}
