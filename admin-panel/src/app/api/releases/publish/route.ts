export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'

const OWNER    = 'vengeance3355'
const REPO     = 'DropMedia'
const WORKFLOW = 'release.yml'
const REF      = 'main'

export async function POST(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) {
    return NextResponse.json({ error: 'GITHUB_RELEASE_TOKEN tanımlanmamış.', code: 'missing_env' }, { status: 503 })
  }

  let version = '', notes = ''
  try {
    const body = await req.json() as { version?: string; notes?: string }
    version = body.version?.trim().replace(/^v/i, '') ?? ''
    notes   = body.notes?.slice(0, 50_000) ?? ''
  } catch {
    return NextResponse.json({ error: 'Geçersiz veri.' }, { status: 400 })
  }

  if (version && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return NextResponse.json({ error: 'Geçersiz surum. Ornek: 1.2.3' }, { status: 400 })
  }

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'dropmedia-admin'
      },
      body: JSON.stringify({
        ref: REF,
        inputs: { bump: 'patch', version, notes, draft: 'false', prerelease: 'false' }
      })
    }
  )

  if (res.status !== 204) {
    const body = await res.text().catch(() => '')
    return NextResponse.json({ error: parseError(body) || `GitHub ${res.status}` }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    workflow: WORKFLOW,
    ref: REF,
    target: version || 'patch bump',
    workflow_url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`
  })
}

function parseError(body: string): string {
  try {
    const p = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string }> }
    return [p.message, ...(p.errors ?? []).map(e => e.message)].filter(Boolean).join(' ')
  } catch { return body.slice(0, 300) }
}
