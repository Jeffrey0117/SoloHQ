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
    .replace(/^["'「『]|["'」』]$/g, '') // strip wrapping quotes
    .replace(/^[-*•]\s*/, '')           // strip bullet
    .trim().slice(0, 80)
}

const CATEGORIES = ['content-gen', 'platform', 'blog', 'product', 'infra', 'other']

function parseAnalysis(text) {
  let category = ''
  let intro = ''
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.match(/^\s*CATEGORY\s*[:：]\s*(.+)/i)
    if (c) category = c[1].trim().toLowerCase().replace(/[^a-z-]/g, '')
    const n = line.match(/^\s*INTRO\s*[:：]\s*(.+)/i)
    if (n) intro = clean(n[1])
  }
  if (!CATEGORIES.includes(category)) category = 'other'
  return { category, intro }
}

/**
 * Reads a project and asks claude to BOTH classify it (into one of CATEGORIES)
 * and write a one-line Traditional-Chinese intro. Returns { category, intro }.
 */
async function analyze(dir) {
  const context = buildContext(dir)
  const prompt =
    '你是工程助理。讀以下專案資訊,做兩件事。\n' +
    '1) 判斷它屬於哪一類,只能從這些 id 挑一個:\n' +
    '   content-gen = 內容生成工具(產生短影音腳本/圖文/字幕等)\n' +
    '   platform = 拿來販售的線上平台(電商/訂閱/金流)\n' +
    '   blog = 部落格 / 內容經營網站\n' +
    '   product = 實際給人用的 SaaS 產品(如圖床、英文學習)\n' +
    '   infra = 自用工具 / bot / SDK / 部署 / 基礎設施\n' +
    '   other = 練習、clone、其他\n' +
    '2) 用繁體中文寫一句話介紹(≤40字,直接給結論)。\n\n' +
    '只輸出兩行,嚴格照這個格式(不要其他文字):\n' +
    'CATEGORY: <id>\n' +
    'INTRO: <一句話>\n\n' +
    context
  const raw = await runClaude(prompt)
  return parseAnalysis(raw)
}

module.exports = { analyze, CATEGORIES, CLAUDE }
