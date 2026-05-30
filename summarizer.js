'use strict'

/**
 * Generates a one-line project intro by shelling out to the local `claude` CLI
 * in headless mode (`claude -p`, prompt fed via stdin). No API key needed.
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TIMEOUT_MS = 90_000

function findClaude() {
  const appData = process.env.APPDATA || ''
  const candidates = [
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'claude.cmd'),
  ]
  for (const c of candidates) {
    try { fs.accessSync(c); return c } catch { /* keep looking */ }
  }
  return 'claude' // rely on PATH
}

const CLAUDE = findClaude()

function readText(p, max) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, max) } catch { return '' }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

/** Compact, token-light context describing the project. */
function buildContext(dir) {
  const parts = []
  const pkg = readJson(path.join(dir, 'package.json'))
  if (pkg) {
    const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    parts.push(`package.json: name=${pkg.name || ''}; description=${pkg.description || ''}; ` +
      `scripts=${Object.keys(pkg.scripts || {}).join(',')}; deps=${Object.keys(d).slice(0, 18).join(',')}`)
  }
  const readme = ['README.md', 'readme.md', 'Readme.md'].map((n) => readText(path.join(dir, n), 1800)).find(Boolean)
  if (readme) parts.push('README:\n' + readme)
  let entries = []
  try { entries = fs.readdirSync(dir).filter((n) => n !== 'node_modules' && !n.startsWith('.')).slice(0, 30) } catch { /* ignore */ }
  parts.push('top-level files: ' + entries.join(', '))
  return parts.join('\n\n').slice(0, 4000)
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(CLAUDE, ['-p'], { windowsHide: true, shell: CLAUDE === 'claude' })
    } catch (err) {
      return reject(err)
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* */ } reject(new Error('claude timed out')) }, TIMEOUT_MS)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `claude exited ${code}`))
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function clean(text) {
  return String(text)
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] // first non-empty line
    ?.replace(/^["'「『]|["'」』]$/g, '')                    // strip wrapping quotes
    .replace(/^[-*•]\s*/, '')                                 // strip bullet
    .slice(0, 80) || ''
}

/** Returns a one-sentence Traditional-Chinese intro for the project at `dir`. */
async function generateIntro(dir) {
  const context = buildContext(dir)
  const prompt =
    '你是工程助理。根據以下專案資訊,用繁體中文寫「一句話」說明這個專案在做什麼。\n' +
    '規則:直接給結論、≤40字、不要前言、不要 markdown、不要引號、不要句號以外的標點堆疊。\n\n' +
    context
  const raw = await runClaude(prompt)
  const intro = clean(raw)
  if (!intro) throw new Error('empty intro from claude')
  return intro
}

module.exports = { generateIntro, CLAUDE }
