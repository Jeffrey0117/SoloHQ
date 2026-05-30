'use strict'

/**
 * Project Wall — scans the local code directory and builds a cached "identity
 * card" per project. Pure filesystem (no project is ever run). Incremental:
 * a cheap fingerprint (newest mtime of dir / .git/HEAD / package.json / README)
 * lets us skip rebuilding unchanged projects, so the wall opens instantly.
 */

const fs = require('fs')
const path = require('path')

// Directory that holds all projects. Defaults to the parent `code/` folder
// (solohq lives at code/workhub/solohq → ../../ === code/). Override with env.
const CODE_DIR = process.env.SOLOHQ_CODE_DIR || path.resolve(__dirname, '../../')
const CACHE_FILE = path.join(__dirname, 'projects-cache.json')
const OVERRIDES_FILE = path.join(__dirname, 'projects-overrides.json')
const SUMMARIES_FILE = path.join(__dirname, 'projects-summaries.json')

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage'])
// A directory counts as a "project" if it has at least one of these markers.
const PROJECT_MARKERS = ['package.json', '.git', 'index.html', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod']

// ── tiny fs helpers ──────────────────────────────────────

function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}

function statSafe(p) {
  try { return fs.statSync(p) } catch { return null }
}

function readText(p, max) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, max || 4096) } catch { return '' }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

function firstExisting(dir, names) {
  for (const n of names) if (exists(path.join(dir, n))) return n
  return null
}

// ── detection ────────────────────────────────────────────

function readPackageJson(dir) {
  return readJson(path.join(dir, 'package.json'))
}

function deps(pkg) {
  if (!pkg) return {}
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
}

function detectType(dir, pkg) {
  const d = deps(pkg)
  if (exists(path.join(dir, 'src-tauri'))) return 'desktop'
  if (d.electron || exists(path.join(dir, 'forge.config.ts')) || exists(path.join(dir, 'forge.config.js'))) return 'desktop'
  if (d.telegraf || d['discord.js'] || /(^|[-_])bot([-_]|$)/i.test(path.basename(dir))) return 'bot'
  if (d.next || d.vite || d.react || d.vue || d.svelte || d['@sveltejs/kit'] || d.astro) return 'web'
  if (pkg && pkg.bin) return 'cli'
  if (exists(path.join(dir, 'requirements.txt')) || exists(path.join(dir, 'pyproject.toml')) || exists(path.join(dir, 'Pipfile'))) return 'python'
  if (exists(path.join(dir, 'Cargo.toml'))) return 'rust'
  if (exists(path.join(dir, 'go.mod'))) return 'go'
  if (pkg && (pkg.main || pkg.exports) && !(pkg.scripts && (pkg.scripts.dev || pkg.scripts.start))) return 'library'
  if (exists(path.join(dir, 'index.html'))) return 'web'
  if (pkg) return 'node'
  return 'unknown'
}

function detectStack(dir, pkg) {
  const d = deps(pkg)
  const tags = []
  const map = {
    next: 'Next.js', vite: 'Vite', react: 'React', vue: 'Vue', svelte: 'Svelte',
    '@sveltejs/kit': 'SvelteKit', astro: 'Astro', express: 'Express', fastify: 'Fastify',
    electron: 'Electron', telegraf: 'Telegraf', tailwindcss: 'Tailwind', zustand: 'Zustand',
  }
  for (const key of Object.keys(map)) if (d[key]) tags.push(map[key])
  if (exists(path.join(dir, 'src-tauri'))) tags.push('Tauri')
  if (exists(path.join(dir, 'requirements.txt')) || exists(path.join(dir, 'pyproject.toml'))) tags.push('Python')
  if (exists(path.join(dir, 'Cargo.toml'))) tags.push('Rust')
  if (exists(path.join(dir, 'go.mod'))) tags.push('Go')
  return tags.slice(0, 4)
}

function detectLanguage(dir, pkg) {
  if (exists(path.join(dir, 'tsconfig.json'))) return 'TypeScript'
  if (exists(path.join(dir, 'requirements.txt')) || exists(path.join(dir, 'pyproject.toml')) || exists(path.join(dir, 'Pipfile'))) return 'Python'
  if (exists(path.join(dir, 'Cargo.toml'))) return 'Rust'
  if (exists(path.join(dir, 'go.mod'))) return 'Go'
  if (pkg) return 'JavaScript'
  return 'unknown'
}

function getSummary(dir, pkg) {
  if (pkg && typeof pkg.description === 'string' && pkg.description.trim()) {
    return pkg.description.trim().slice(0, 160)
  }
  const readmeName = firstExisting(dir, ['README.md', 'readme.md', 'Readme.md', 'README.MD'])
  if (readmeName) {
    const text = readText(path.join(dir, readmeName), 4096)
    const lines = text.split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('#')) continue        // skip the H1 title
      if (line.startsWith('![') || line.startsWith('<')) continue // skip badges/html
      if (line.startsWith('```')) continue
      return line.replace(/[*_`>]/g, '').slice(0, 160)
    }
  }
  return ''
}

function getGitRemote(dir) {
  const cfg = readText(path.join(dir, '.git', 'config'), 8192)
  if (!cfg) return null
  const m = cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/)
  return m ? m[1].trim() : null
}

// Your GitHub handle — anything NOT owned by this is treated as a clone/fork.
const OWNER = (process.env.SOLOHQ_GH_USER || 'Jeffrey0117').toLowerCase()

function parseRemote(url) {
  const known = url.match(/(github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (known) return { host: known[1].toLowerCase(), owner: known[2], name: known[3] }
  const generic = url.match(/[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (generic) return { host: 'git', owner: generic[1], name: generic[2] }
  return null
}

/** Repo status: none (no .git) / local (.git, no remote) / remote (+ owner, isClone). */
function getRepo(dir) {
  if (!exists(path.join(dir, '.git'))) {
    return { status: 'none', host: null, owner: null, name: null, isClone: false, url: null, visibility: null }
  }
  const url = getGitRemote(dir)
  if (!url) {
    return { status: 'local', host: null, owner: null, name: null, isClone: false, url: null, visibility: null }
  }
  const p = parseRemote(url)
  const owner = p ? p.owner : null
  return {
    status: 'remote',
    host: p ? p.host : null,
    owner,
    name: p ? p.name : null,
    isClone: Boolean(owner) && owner.toLowerCase() !== OWNER,
    url,
    visibility: null, // filled later by an optional GitHub lookup
  }
}

function getCompleteness(dir, pkg) {
  const scripts = (pkg && pkg.scripts) || {}
  const testScript = typeof scripts.test === 'string' && !/no test specified/i.test(scripts.test)

  const readme = Boolean(firstExisting(dir, ['README.md', 'readme.md', 'Readme.md']))
  const logo = Boolean(firstExisting(dir, [
    'logo.png', 'logo.svg', 'logo.jpg',
    path.join('public', 'logo.png'), path.join('public', 'logo.svg'),
    path.join('assets', 'logo.png'), path.join('src', 'assets', 'logo.png'),
  ]))
  const license = Boolean(firstExisting(dir, ['LICENSE', 'LICENSE.md', 'license', 'LICENSE.txt'])) || Boolean(pkg && pkg.license)
  const favicon = Boolean(firstExisting(dir, [
    'favicon.ico', path.join('public', 'favicon.ico'), path.join('public', 'favicon.png'), path.join('public', 'favicon.svg'),
  ]))
  const deploy = Boolean(
    firstExisting(dir, ['vercel.json', 'netlify.toml', 'Dockerfile', 'fly.toml', 'render.yaml', path.join('.github', 'workflows')]) ||
    (pkg && pkg.homepage) || (scripts.deploy),
  )
  const tests = Boolean(
    firstExisting(dir, ['__tests__', 'test', 'tests', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js']) ||
    testScript,
  )
  const git = Boolean(getGitRemote(dir))

  return { readme, logo, license, favicon, deploy, tests, git }
}

function guessCategory(card) {
  const c = card.completeness
  const name = card.name.toLowerCase()
  if (c.deploy) return 'product'
  if (card.type === 'cli' || card.type === 'library' || card.type === 'bot') return 'infra'
  if (/(sdk|kit|cli|setup|tool|gateway|infra|template|boilerplate|starter)/.test(name)) return 'infra'
  if (!c.readme && !c.git) return 'practice'
  return 'uncategorized'
}

// ── fingerprint + lastModified (cheap, top-level only) ───

function cheapFingerprint(dir) {
  let newest = 0
  for (const rel of ['', '.git/HEAD', 'package.json', 'README.md']) {
    const st = statSafe(path.join(dir, rel))
    if (st && st.mtimeMs > newest) newest = st.mtimeMs
  }
  return Math.round(newest)
}

function lastModified(dir) {
  let newest = 0
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue
    const st = statSafe(path.join(dir, name))
    if (st && st.mtimeMs > newest) newest = st.mtimeMs
  }
  return newest ? new Date(newest).toISOString() : null
}

// ── card builder ─────────────────────────────────────────

function isProject(dir) {
  return PROJECT_MARKERS.some((m) => exists(path.join(dir, m)))
}

function buildCard(dir) {
  const name = path.basename(dir)
  const pkg = readPackageJson(dir)
  const completeness = getCompleteness(dir, pkg)
  const repo = getRepo(dir)

  const card = {
    id: name,
    name,
    path: dir,
    summary: getSummary(dir, pkg),
    type: detectType(dir, pkg),
    stack: detectStack(dir, pkg),
    language: detectLanguage(dir, pkg),
    lastModified: lastModified(dir),
    repo,
    gitRemote: repo.url,
    pushed: repo.status === 'remote',
    completeness,
    score: Object.values(completeness).filter(Boolean).length,
    fingerprint: cheapFingerprint(dir),
  }
  card.category = guessCategory(card)
  card.categorySource = 'auto'
  card.summarySource = card.summary ? 'auto' : null
  return card
}

// ── cache + overrides ────────────────────────────────────

function loadCache() {
  const c = readJson(CACHE_FILE)
  return c && typeof c === 'object' ? c : {}
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8') } catch { /* ignore */ }
}

function loadOverrides() {
  const o = readJson(OVERRIDES_FILE)
  return o && typeof o === 'object' ? o : {}
}

function saveOverrides(o) {
  try { fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(o, null, 2), 'utf-8') } catch { /* ignore */ }
}

function applyOverride(card, override) {
  if (!override) return card
  const merged = { ...card }
  if (typeof override.category === 'string') {
    merged.category = override.category
    merged.categorySource = 'manual'
  }
  if (typeof override.hidden === 'boolean') merged.hidden = override.hidden
  if (typeof override.note === 'string') merged.note = override.note
  return merged
}

function loadSummaries() {
  const s = readJson(SUMMARIES_FILE)
  return s && typeof s === 'object' ? s : {}
}

function saveSummaries(s) {
  try { fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(s, null, 2), 'utf-8') } catch { /* ignore */ }
}

// Fill in an AI-generated intro only when the project has no README/package summary.
function applySummary(card, summary) {
  if (card.summary || !summary || !summary.intro) return card
  return { ...card, summary: summary.intro, summarySource: 'ai' }
}

function decorate(card, override, summary) {
  return applySummary(applyOverride(card, override), summary)
}

// ── public API ───────────────────────────────────────────

/**
 * Scan CODE_DIR. Reuses cached cards whose fingerprint is unchanged unless
 * { force } is set. Returns cards (with overrides applied), newest first.
 */
function scan(opts) {
  const force = Boolean(opts && opts.force)
  const cache = loadCache()
  const overrides = loadOverrides()
  const summaries = loadSummaries()
  const nextCache = {}
  const cards = []

  let dirs = []
  try { dirs = fs.readdirSync(CODE_DIR, { withFileTypes: true }) } catch { dirs = [] }

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue
    if (dirent.name.startsWith('.') || IGNORE_DIRS.has(dirent.name)) continue
    const full = path.join(CODE_DIR, dirent.name)
    if (!isProject(full)) continue

    const fp = cheapFingerprint(full)
    const cached = cache[dirent.name]
    let card
    if (!force && cached && cached.fingerprint === fp && cached.repo) {
      card = cached            // unchanged → reuse (the fast path); cached.repo guards old-schema cards
    } else {
      card = buildCard(full)
    }
    nextCache[dirent.name] = card
    cards.push(decorate(card, overrides[dirent.name], summaries[dirent.name]))
  }

  saveCache(nextCache)
  cards.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')))
  return cards
}

/** Read cards from cache without rescanning; scans on first run. */
function getCards() {
  const cache = loadCache()
  if (!cache || Object.keys(cache).length === 0) return scan({ force: false })
  const overrides = loadOverrides()
  const summaries = loadSummaries()
  return Object.values(cache)
    .map((card) => decorate(card, overrides[card.id], summaries[card.id]))
    .sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')))
}

/** Generate (and cache) an AI intro for one project via the local claude CLI. */
async function generateIntroFor(id) {
  const cache = loadCache()
  const card = cache[id]
  if (!card) return null
  const { generateIntro } = require('./summarizer')
  const intro = await generateIntro(card.path)
  const summaries = loadSummaries()
  summaries[id] = { intro, source: 'ai', at: new Date().toISOString() }
  saveSummaries(summaries)
  const overrides = loadOverrides()
  return decorate(card, overrides[id], summaries[id])
}

/** Persist a manual override (category / hidden / note) for one project. */
function setOverride(id, patch) {
  const overrides = loadOverrides()
  const current = overrides[id] || {}
  const next = { ...current }
  if (typeof patch.category === 'string') next.category = patch.category
  if (typeof patch.hidden === 'boolean') next.hidden = patch.hidden
  if (typeof patch.note === 'string') next.note = patch.note
  overrides[id] = next
  saveOverrides(overrides)
  const cache = loadCache()
  const card = cache[id] ? applyOverride(cache[id], next) : null
  return card
}

module.exports = { scan, getCards, setOverride, generateIntroFor, CODE_DIR }
