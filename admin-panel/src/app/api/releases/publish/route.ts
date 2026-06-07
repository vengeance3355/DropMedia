export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'

const OWNER = 'vengeance3355'
const REPO = 'DropMedia'
const WORKFLOW = 'release.yml'

interface PublishPayload {
  bump?: string
  version?: string
  notes?: string
  draft?: boolean
  prerelease?: boolean
  ref?: string
}

export async function POST(req: NextRequest) {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let payload: PublishPayload
  try {
    payload = normalizePayload(await req.json())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'GeÃ§ersiz veri' }, { status: 400 })
  }

  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) {
    return NextResponse.json({
      error: 'GITHUB_RELEASE_TOKEN env tanÄ±mlÄ± deÄŸil.',
      code: 'missing_env',
      configuration: 'Admin release publish iÃ§in Vercel/hosting env iÃ§ine GITHUB_RELEASE_TOKEN veya GITHUB_TOKEN tanÄ±mlanmalÄ±.'
    }, { status: 503 })
  }

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dropmedia-admin'
    },
    body: JSON.stringify({
      ref: payload.ref,
      inputs: {
        bump: payload.bump,
        version: payload.version ?? '',
        notes: payload.notes ?? '',
        draft: String(!!payload.draft),
        prerelease: String(!!payload.prerelease)
      }
    })
  })

  if (res.status !== 204) {
    const body = await res.text().catch(() => '')
    return NextResponse.json({ error: parseGithubError(body) || `GitHub ${res.status}` }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    workflow: WORKFLOW,
    ref: payload.ref,
    target: payload.version ? `v${payload.version}` : payload.bump,
    workflow_url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`,
    runs_url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`
  })
}

function normalizePayload(input: PublishPayload): Required<Pick<PublishPayload, 'bump' | 'ref'>> & PublishPayload {
  const bump = (input.bump ?? 'patch').trim()
  const version = input.version?.trim().replace(/^v/i, '')
  const ref = input.ref?.trim() || 'main'
  const notes = input.notes?.slice(0, 50_000)

  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('bump patch/minor/major olmalÄ±')
  if (version && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('version semver olmalÄ±. Ã–rn: 1.2.3')
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error('ref geÃ§ersiz')

  return {
    bump,
    version,
    notes,
    draft: !!input.draft,
    prerelease: !!input.prerelease,
    ref
  }
}

function parseGithubError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string }> }
    return [parsed.message, ...(parsed.errors ?? []).map(error => error.message)].filter(Boolean).join(' ')
  } catch {
    return body.slice(0, 300)
  }
}
