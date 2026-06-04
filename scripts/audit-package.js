#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const asarPath = path.join(root, 'release/linux-unpacked/resources/app.asar')

const blockedRoots = new Set([
  '.env',
  '.git',
  '.claude',
  '.codex',
  '.codex-delegations',
  '.remember',
  'admin-panel',
  'backups',
  'release',
  'src',
  'supabase',
  'CLAUDE.md',
  'CLAUDE.md.bak',
  'electron.vite.config.ts'
])

const secretPatterns = [
  { name: 'github_token', pattern: /gh[opsu]_[A-Za-z0-9_]{20,}/ },
  { name: 'service_role_key', pattern: /SUPABASE_SERVICE_ROLE_KEY|service_role/i },
  { name: 'admin_password', pattern: /ADMIN_PASSWORD/ },
  { name: 'raw_cookie', pattern: /(^|[^A-Za-z])cookies?\s*[:=]\s*["'][^"']{12,}/i },
  { name: 'raw_password', pattern: /(^|[^A-Za-z])password\s*[:=]\s*["'][^"']{6,}/i },
  { name: 'private_key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
]

function fail(message, details) {
  console.error(`Package audit failed: ${message}`)
  if (details?.length) {
    for (const item of details.slice(0, 80)) console.error(` - ${item}`)
    if (details.length > 80) console.error(` - ... ${details.length - 80} more`)
  }
  process.exit(1)
}

if (!fs.existsSync(asarPath)) {
  fail(`missing asar at ${asarPath}`)
}

const files = asar.listPackage(asarPath)
const blocked = files.filter((file) => {
  const rootName = file.split('/')[1]
  return blockedRoots.has(rootName)
})

if (blocked.length) fail('blocked root files are packaged', blocked)

const textFiles = files.filter(file => /\.(js|json|html|css|yml|yaml|txt)$/i.test(file))
const hits = []

for (const file of textFiles) {
  if (file.startsWith('/node_modules/')) continue
  let content = ''
  try {
    content = asar.extractFile(asarPath, file.slice(1)).toString('utf8')
  } catch {
    continue
  }
  for (const rule of secretPatterns) {
    if (rule.pattern.test(content)) hits.push(`${rule.name}: ${file}`)
  }
}

if (hits.length) fail('secret-like content found', hits)

const stats = fs.statSync(asarPath)
console.log(JSON.stringify({
  ok: true,
  asar: path.relative(root, asarPath),
  fileCount: files.length,
  sizeMb: Math.round((stats.size / 1024 / 1024) * 10) / 10
}, null, 2))
