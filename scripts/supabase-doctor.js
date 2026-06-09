#!/usr/bin/env node
const { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } = require('fs')
const { lookup } = require('dns').promises
const { resolve, join } = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { tmpdir } = require('os')

const REQUIRED_TABLES = [
  'error_logs',
  'stats',
  'user_settings',
  'download_library',
  'watch_sources',
  'watch_items',
  'admin_users'
]
const ROOT = process.cwd()
const AUTO = process.argv.includes('--auto')
const SYNC_VERCEL = process.argv.includes('--sync-vercel')

main().catch(err => {
  console.error(`fail ${err.message}`)
  process.exit(1)
})

async function main() {
  const envPath = resolve(ROOT, '.env')
  const env = { ...readEnv(envPath), ...readProcessEnv() }

  if (AUTO) {
    const discovered = await autoDiscover(env)
    if (discovered.changed) {
      const nextEnv = { ...readEnv(envPath), ...discovered.values }
      writeEnv(envPath, nextEnv)
      Object.assign(env, discovered.values)
      console.log(`env updated source=${discovered.source}`)
    } else {
      console.log(`env unchanged source=${discovered.source}`)
    }
    if (SYNC_VERCEL && discovered.values) syncVercelEnv(discovered.values)
  }

  const url = env.SUPABASE_URL
  const anonKey = env.SUPABASE_ANON_KEY

  if (!url) throw new Error('SUPABASE_URL missing')
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY missing')
  if (anonKey.length < 20) throw new Error('SUPABASE_ANON_KEY too short')

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('SUPABASE_URL must use https')
  if (!parsed.hostname.endsWith('.supabase.co')) throw new Error('SUPABASE_URL must be a supabase.co project URL')

  console.log(`env ok host=${parsed.hostname} anon_len=${anonKey.length}`)

  try {
    const result = await lookup(parsed.hostname)
    console.log(`dns ok address=${result.address}`)
  } catch (err) {
    throw new Error(`DNS cannot resolve ${parsed.hostname}: ${err.code || err.message}`)
  }

  const rows = []
  for (const table of REQUIRED_TABLES) rows.push(await checkTable(url, anonKey, table))
  for (const row of rows) console.log(`${row.table} ${row.http} ${row.status}`)

  const bad = rows.filter(row => row.status !== 'ok')
  if (bad.length) {
    throw new Error(`Supabase not ready: ${bad.map(row => `${row.table}:${row.status}`).join(', ')}`)
  }

  console.log('supabase ready')
}

async function autoDiscover(currentEnv) {
  const values = {}
  const vercelEnv = pullVercelEnv()
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PROJECT_REF']) {
    if (vercelEnv[key]) values[key] = vercelEnv[key]
  }
  if (values.SUPABASE_URL && values.SUPABASE_ANON_KEY) {
    return { changed: shouldUpdate(currentEnv, values), source: 'vercel', values }
  }

  const accessToken = currentEnv.SUPABASE_ACCESS_TOKEN || vercelEnv.SUPABASE_ACCESS_TOKEN || ''
  const project = findProject(accessToken, currentEnv.SUPABASE_PROJECT_REF || currentEnv.SUPABASE_URL)
  if (!project?.id) {
    return { changed: false, source: accessToken ? 'supabase:no_project_match' : 'supabase_cli:not_logged_in_or_no_project_match', values: {} }
  }

  const keys = getProjectApiKeys(accessToken, project.id)
  const anonKey = findApiKey(keys, 'anon') || findApiKey(keys, 'publishable')
  const serviceRoleKey = findApiKey(keys, 'service_role') || findApiKey(keys, 'secret')
  if (!anonKey) return { changed: false, source: 'supabase:no_anon_key', values: {} }

  values.SUPABASE_PROJECT_REF = project.id
  values.SUPABASE_URL = `https://${project.id}.supabase.co`
  values.NEXT_PUBLIC_SUPABASE_URL = values.SUPABASE_URL
  values.SUPABASE_ANON_KEY = anonKey
  if (serviceRoleKey) values.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey

  return { changed: shouldUpdate(currentEnv, values), source: accessToken ? 'supabase_access_token' : 'supabase_cli_profile', values }
}

function pullVercelEnv() {
  const adminDir = resolve(ROOT, 'admin-panel')
  if (!existsSync(resolve(adminDir, '.vercel'))) return {}

  const dir = mkdtempSync(join(tmpdir(), 'dropmedia-vercel-env-'))
  const path = join(dir, 'production.env')
  try {
    execFileSync('vercel', ['env', 'pull', path, '--environment=production', '--yes'], {
      cwd: adminDir,
      stdio: 'ignore'
    })
    return readEnv(path)
  } catch {
    return {}
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function findProject(accessToken, preferred) {
  const projects = runSupabaseJson(['projects', 'list', '--output', 'json'], accessToken)
  const list = Array.isArray(projects) ? projects : projects?.projects
  if (!Array.isArray(list) || list.length === 0) return null

  const preferredRef = extractProjectRef(preferred)
  if (preferredRef) {
    const exact = list.find(project => project.id === preferredRef || project.ref === preferredRef)
    if (exact) return normalizeProject(exact)
  }

  const active = list.map(normalizeProject).filter(project => project.id && !/inactive|deleted/i.test(project.status || ''))
  if (active.length === 1) return active[0]
  return null
}

function getProjectApiKeys(accessToken, projectRef) {
  const result = runSupabaseJson(['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json'], accessToken)
  return Array.isArray(result) ? result : (result?.api_keys || result?.keys || [])
}

function runSupabaseJson(args, accessToken) {
  const env = { ...process.env }
  if (accessToken) env.SUPABASE_ACCESS_TOKEN = accessToken
  const result = spawnSync('npx', ['supabase@latest', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`Supabase CLI failed: ${(result.stderr || result.stdout).trim()}`)
  const raw = result.stdout.trim()
  return raw ? JSON.parse(trimToJson(raw)) : null
}

function findApiKey(keys, role) {
  const item = keys.find(key => {
    const text = `${key.name || ''} ${key.role || ''} ${key.type || ''}`.toLowerCase()
    return text.includes(role)
  })
  return item?.api_key || item?.key || item?.value
}

function trimToJson(raw) {
  const arrayIndex = raw.indexOf('[')
  const objectIndex = raw.indexOf('{')
  const indexes = [arrayIndex, objectIndex].filter(index => index >= 0)
  if (!indexes.length) return raw
  return raw.slice(Math.min(...indexes))
}

function normalizeProject(project) {
  return {
    id: project.id || project.ref || project.project_ref,
    name: project.name,
    status: project.status
  }
}

function extractProjectRef(value) {
  if (!value) return ''
  try {
    return new URL(value).hostname.split('.')[0]
  } catch {
    return value
  }
}

function shouldUpdate(current, values) {
  return Object.entries(values).some(([key, value]) => value && current[key] !== value)
}

function syncVercelEnv(values) {
  const adminDir = resolve(ROOT, 'admin-panel')
  if (!existsSync(resolve(adminDir, '.vercel'))) return

  for (const [key, value] of Object.entries(values)) {
    if (!value || key === 'SUPABASE_PROJECT_REF') continue
    spawnSync('vercel', ['env', 'rm', key, 'production', '--yes'], { cwd: adminDir, stdio: 'ignore' })
    const add = spawnSync('vercel', ['env', 'add', key, 'production'], {
      cwd: adminDir,
      input: `${value}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore']
    })
    if (add.status !== 0) console.log(`vercel ${key} update failed`)
    else console.log(`vercel ${key} updated`)
  }
}

async function checkTable(baseUrl, anonKey, table) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/rest/v1/${table}?select=*&limit=1`
  try {
    const res = await fetch(endpoint, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`
      }
    })
    const text = await res.text()
    if (res.status >= 400) {
      const status = /Could not find the table|schema cache|PGRST205/i.test(text) ? 'missing' : 'error'
      return { table, http: res.status, status }
    }
    return { table, http: res.status, status: 'ok' }
  } catch (err) {
    return { table, http: 0, status: err.code || 'network_error' }
  }
}

function readEnv(path) {
  if (!existsSync(path)) return {}

  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index === -1) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    env[key] = value
  }
  return env
}

function readProcessEnv() {
  const env = {}
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function writeEnv(path, env) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const managed = new Set(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PROJECT_REF'])
  const seen = new Set()
  const lines = existing.map(line => {
    const index = line.indexOf('=')
    if (index === -1) return line
    const key = line.slice(0, index).trim()
    if (!managed.has(key) || env[key] === undefined) return line
    seen.add(key)
    return `${key}=${env[key]}`
  })
  for (const key of managed) {
    if (!seen.has(key) && env[key] !== undefined) lines.push(`${key}=${env[key]}`)
  }
  writeFileSync(path, `${lines.join('\n').replace(/\n*$/, '')}\n`)
}
