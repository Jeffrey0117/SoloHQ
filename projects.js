'use strict'

/**
 * Project Wall — scans the local code directory and builds a cached "identity
 * card" per project. Pure filesystem (no project is ever run). Incremental:
 * a cheap fingerprint (newest mtime of dir / .git/HEAD / package.json / README)
 * lets us skip rebuilding unchanged projects, so the wall opens instantly.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// Folders that hold projects, `;`-separated. Earlier roots win when two
// different folders share a name — list the deployed (canonical) roots first
// so a stale copy elsewhere never shadows the real project.
const CODE_DIR = process.env.SOLOHQ_CODE_DIR || path.resolve(__dirname, '../../')
const CODE_DIRS = CODE_DIR.split(';').map((s) => s.trim()).filter(Boolean)
const CACHE_FILE = path.join(__dirname, 'projects-cache.json')
const OVERRIDES_FILE = path.join(__dirname, 'projects-overrides.json')
const SUMMARIES_FILE = path.join(__dirname, 'projects-summaries.json')

const CARD_SCHEMA = 2
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage'])
// Deploy leftovers and archived husks — never real projects.
const IGNORE_NAME = /(\.(bak|old|shadow|slot[ab])$)|husk-bak|\.bak[-_]/i
const ACTIVITY_WEEKS = 12
const WEEK_MS = 7 * 86400000
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

// Heuristic fallback only — AI (see generateIntroFor) gives the real categories.
// Must return one of: content-gen | platform | blog | product | infra | other
function guessCategory(card) {
  const name = card.name.toLowerCase()
  const t = card.type
  if (t === 'cli' || t === 'library' || t === 'bot' ||
      /(sdk|kit|cli|setup|tool|gateway|infra|proxy|server|bot|template|boilerplate|starter)/.test(name)) return 'infra'
  if (/(blog|post|article|note|content|writing|evernote|threads|matrix)/.test(name)) return 'blog'
  if (/(shop|store|pay|sell|commerce|market|cart|subscription|paygate|gumroad)/.test(name)) return 'platform'
  if (/(gen|generate|script|reel|video|caption|ocr|maker|creator|capture|shot)/.test(name)) return 'content-gen'
  if (card.completeness && card.completeness.deploy) return 'product'
  return 'other'
}

// ── git activity (what changed lately) ───────────────────

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf-8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/** Recent commits + raw commit times for the activity window (bucketed at read time). */
function getActivity(dir) {
  if (!exists(path.join(dir, '.git'))) return null
  const recent = git(dir, ['log', '-5', '--format=%cI%x09%s'])
    .split('\n').filter(Boolean)
    .map((line) => {
      const [at, ...rest] = line.split('\t')
      return { at, subject: rest.join('\t').slice(0, 140) }
    })
  const times = git(dir, ['log', `--since=${ACTIVITY_WEEKS * 7}.days`, '--format=%ct'])
    .split('\n').filter(Boolean).map(Number).filter(Number.isFinite)
  return { recent, times, lastCommitAt: recent[0] ? recent[0].at : null }
}

/** Derived, time-relative stats — computed on read so they never go stale in cache. */
function activityStats(card) {
  const a = card.activity
  if (!a) return { weeks: [], commits30: 0, lastCommitAt: null, recent: [] }
  const now = Date.now()
  const start = now - ACTIVITY_WEEKS * WEEK_MS
  const weeks = new Array(ACTIVITY_WEEKS).fill(0)
  let commits30 = 0
  for (const t of a.times || []) {
    const ms = t * 1000
    const idx = Math.floor((ms - start) / WEEK_MS)
    if (idx >= 0 && idx < ACTIVITY_WEEKS) weeks[idx] += 1
    if (ms > now - 30 * 86400000) commits30 += 1
  }
  return { weeks, commits30, lastCommitAt: a.lastCommitAt, recent: a.recent || [] }
}

// ── fingerprint + lastModified (cheap, top-level only) ───

function cheapFingerprint(dir) {
  let newest = 0
  // .git/logs/HEAD moves on every commit / pull / reset — HEAD itself rarely does.
  for (const rel of ['', '.git/HEAD', '.git/logs/HEAD', 'package.json', 'README.md']) {
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
    schema: CARD_SCHEMA,
    id: name,
    name,
    path: dir,
    activity: getActivity(dir),
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
  if (typeof override.public === 'boolean') merged.public = override.public
  if (typeof override.pitch === 'string') merged.pitch = override.pitch
  if (typeof override.publicUrl === 'string') merged.publicUrl = override.publicUrl
  if (typeof override.displayName === 'string') merged.displayName = override.displayName
  return merged
}

function loadSummaries() {
  const s = readJson(SUMMARIES_FILE)
  return s && typeof s === 'object' ? s : {}
}

function saveSummaries(s) {
  try { fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(s, null, 2), 'utf-8') } catch { /* ignore */ }
}

// Apply AI analysis: intro fills in only when there's no README/package summary;
// category is used unless the user set a manual override.
function applyAnalysis(card, ai) {
  if (!ai) return card
  const merged = { ...card }
  if (!card.summary && ai.intro) { merged.summary = ai.intro; merged.summarySource = 'ai' }
  if (ai.category && card.categorySource !== 'manual') { merged.category = ai.category; merged.categorySource = 'ai' }
  return merged
}

function decorate(card, override, ai) {
  const merged = applyAnalysis(applyOverride(card, override), ai)
  const { activity, ...rest } = merged
  return { ...rest, ...activityStats(merged) }
}

function byRecency(a, b) {
  return String(b.lastCommitAt || b.lastModified || '').localeCompare(String(a.lastCommitAt || a.lastModified || ''))
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

  for (const root of CODE_DIRS) {
    let dirs = []
    try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { dirs = [] }

    for (const dirent of dirs) {
      // Junctions/symlinks (code/x → workhub/x) report isDirectory() false on some setups.
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      const name = dirent.name
      if (name.startsWith('.') || IGNORE_DIRS.has(name) || IGNORE_NAME.test(name)) continue
      if (nextCache[name]) continue          // an earlier (canonical) root already has it
      const full = path.join(root, name)
      if (!isProject(full)) continue

      const fp = cheapFingerprint(full)
      const cached = cache[name]
      const reusable = !force && cached && cached.schema === CARD_SCHEMA &&
        cached.fingerprint === fp && cached.path === full
      const card = reusable ? cached : buildCard(full)
      nextCache[name] = card
      cards.push(decorate(card, overrides[name], summaries[name]))
    }
  }

  saveCache(nextCache)
  return cards.sort(byRecency)
}

/** Read cards from cache without rescanning; scans on first run. */
function getCards() {
  const cache = loadCache()
  if (!cache || Object.keys(cache).length === 0) return scan({ force: false })
  const overrides = loadOverrides()
  const summaries = loadSummaries()
  const stale = Object.values(cache).some((c) => c.schema !== CARD_SCHEMA)
  if (stale) return scan({ force: false })
  return Object.values(cache)
    .map((card) => decorate(card, overrides[card.id], summaries[card.id]))
    .sort(byRecency)
}

/** Generate (and cache) an AI intro for one project via the local claude CLI. */
async function generateIntroFor(id) {
  const cache = loadCache()
  const card = cache[id]
  if (!card) return null
  const { analyze } = require('./summarizer')
  const { category, intro } = await analyze(card.path)
  const summaries = loadSummaries()
  summaries[id] = { intro, category, source: 'ai', at: new Date().toISOString() }
  saveSummaries(summaries)
  const overrides = loadOverrides()
  return decorate(card, overrides[id], summaries[id])
}

const MAX_TEXT = 200

function cleanText(v) {
  return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TEXT)
}

/** Only http(s) URLs may be shown publicly — anything else is dropped. */
function cleanUrl(v) {
  const s = String(v).trim()
  if (s === '') return ''
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * Persist a manual override for one project:
 * category / hidden / note / public / pitch / publicUrl / displayName.
 */
function setOverride(id, patch) {
  const cache = loadCache()
  if (!cache[id]) return null
  const overrides = loadOverrides()
  const next = { ...(overrides[id] || {}) }
  if (typeof patch.category === 'string') next.category = cleanText(patch.category)
  if (typeof patch.hidden === 'boolean') next.hidden = patch.hidden
  if (typeof patch.note === 'string') next.note = cleanText(patch.note)
  if (typeof patch.public === 'boolean') next.public = patch.public
  if (typeof patch.pitch === 'string') next.pitch = cleanText(patch.pitch)
  if (typeof patch.displayName === 'string') next.displayName = cleanText(patch.displayName)
  if (typeof patch.publicUrl === 'string') {
    const url = cleanUrl(patch.publicUrl)
    if (url === null) throw new Error('publicUrl must be an http(s) URL')
    next.publicUrl = url
  }
  saveOverrides({ ...overrides, [id]: next })
  const summaries = loadSummaries()
  return decorate(cache[id], next, summaries[id])
}

/** Look up a project's absolute path by id (from cache) — for open-in-editor/folder. */
function getPath(id) {
  const cache = loadCache()
  return cache[id] && typeof cache[id].path === 'string' ? cache[id].path : null
}

module.exports = { scan, getCards, setOverride, generateIntroFor, getPath, CODE_DIR }
