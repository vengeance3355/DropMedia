export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { isAuthenticated } from '@/lib/auth'

const OWNER = 'vengeance3355'
const REPO = 'DropMedia'
const WORKFLOW = 'release.yml'

interface GithubRun {
  id: number
  run_number?: number
  name?: string
  display_title?: string
  status: string
  conclusion?: string | null
  event?: string
  head_branch?: string
  head_sha?: string
  html_url?: string
  created_at?: string
  updated_at?: string
  run_started_at?: string
}

export async function GET() {
  if (!await isAuthenticated()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=10`, {
    headers: githubHeaders(),
    cache: 'no-store'
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return NextResponse.json({
      data: [],
      count: 0,
      error: parseGithubError(body) || `GitHub ${res.status}`
    })
  }

  const body = await res.json() as { total_count?: number; workflow_runs?: GithubRun[] }
  const data = (body.workflow_runs ?? []).map(run => ({
    id: run.id,
    run_number: run.run_number,
    name: run.name,
    display_title: run.display_title,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
    run_started_at: run.run_started_at
  }))

  return NextResponse.json({
    data,
    count: body.total_count ?? data.length,
    workflow: WORKFLOW,
    repo: `${OWNER}/${REPO}`
  })
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_RELEASE_TOKEN ?? process.env.GITHUB_TOKEN
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dropmedia-admin',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
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
