'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const db = require('../../sdk/database')
const { matchRoute, routes } = require('./router')
const { generateTasks, todayStr } = require('./engine')
const projects = require('./projects')
const { spawn } = require('child_process')

const PORT = parseInt(process.env.PORT || '4028', 10)
const TOKEN = process.env.SOLOHQ_TOKEN || ''

// ── Init DB ──────────────────────────────────────────────

db.init({ project: 'solohq' })

const collections = {
  brands: db.collection('brands'),
  topics: db.collection('topics'),
  content_cells: db.collection('content_cells'),
  daily_tasks: db.collection('daily_tasks'),
  daily_logs: db.collection('daily_logs'),
  revenue_logs: db.collection('revenue_logs'),
  goals: db.collection('goals'),
}

// ── Helpers ──────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > (limit || 65536)) {
        req.destroy()
        reject(new Error('body too large'))
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function checkAuth(req) {
  if (!TOKEN) return true
  const auth = req.headers.authorization || ''
  return auth === `Bearer ${TOKEN}`
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'
  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'content-type': mime, 'content-length': content.length })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

function servePage(res, filename) {
  serveStatic(res, path.join(__dirname, 'public', filename))
}

// ── Handlers ─────────────────────────────────────────────

const handlers = {}

// Pages
handlers['page:dashboard'] = (req, res) => servePage(res, 'index.html')
handlers['page:do'] = (req, res) => servePage(res, 'do.html')
handlers['page:matrix'] = (req, res) => servePage(res, 'matrix.html')
handlers['page:revenue'] = (req, res) => servePage(res, 'revenue.html')
handlers['page:brands'] = (req, res) => servePage(res, 'brands.html')
handlers['page:projects'] = (req, res) => servePage(res, 'projects.html')

// Health
handlers['api:health'] = (req, res) => json(res, 200, { ok: true })

// ── Projects wall ────────────────────────────────────────

handlers['api:projects:list'] = (req, res) => {
  const url = new URL(req.url, 'http://x')
  const cards = url.searchParams.get('scan') === '1'
    ? projects.scan({ force: false })   // incremental: only changed projects rebuild
    : projects.getCards()               // instant: straight from cache
  json(res, 200, { projects: cards, codeDir: projects.CODE_DIR })
}

handlers['api:projects:scan'] = (req, res) => {
  const cards = projects.scan({ force: true })
  json(res, 200, { projects: cards, codeDir: projects.CODE_DIR })
}

handlers['api:projects:update'] = async (req, res, params) => {
  const body = await readBody(req)
  const card = projects.setOverride(params.id, body || {})
  if (!card) return json(res, 404, { error: 'project not found' })
  json(res, 200, { project: card })
}

handlers['api:projects:intro'] = async (req, res, params) => {
  try {
    const card = await projects.generateIntroFor(params.id)
    if (!card) return json(res, 404, { error: 'project not found' })
    json(res, 200, { project: card })
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : 'intro generation failed' })
  }
}

// Open a project on this machine (server runs locally) — folder or VSCode.
handlers['api:projects:open'] = async (req, res, params) => {
  const body = await readBody(req).catch(() => ({}))
  const action = body && body.action
  const dir = projects.getPath(params.id)
  if (!dir) return json(res, 404, { error: 'project not found' })
  try {
    if (action === 'folder') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
    } else if (action === 'editor') {
      spawn('code', [dir], { detached: true, stdio: 'ignore', shell: true }).unref()
    } else {
      return json(res, 400, { error: 'unknown action' })
    }
    json(res, 200, { ok: true })
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : 'open failed' })
  }
}

// ── Brands ───────────────────────────────────────────────

handlers['api:brands:list'] = async (req, res) => {
  const brands = await collections.brands.findAll({ sort: 'sort_order' })
  json(res, 200, { brands })
}

handlers['api:brands:create'] = async (req, res) => {
  const body = await readBody(req)
  if (!body.name || typeof body.name !== 'string') {
    return json(res, 400, { error: 'name is required (string)' })
  }
  const brand = await collections.brands.create({
    id: body.id || `brand_${crypto.randomUUID().slice(0, 8)}`,
    name: body.name,
    revenue_total: parseInt(body.revenue_total, 10) || 0,
    user_count: body.user_count || 0,
    status: body.status || 'active',
    priority: body.priority || 1,
    last_action_at: null,
    task_types: body.task_types || ['reel', 'article', 'reply', 'update'],
    sort_order: body.sort_order || 0,
  })
  json(res, 201, { brand })
}

handlers['api:brands:update'] = async (req, res, params) => {
  const body = await readBody(req)
  const updated = await collections.brands.update(params.id, body)
  if (!updated) return json(res, 404, { error: 'brand not found' })
  json(res, 200, { brand: updated })
}

handlers['api:brands:delete'] = async (req, res, params) => {
  const removed = await collections.brands.remove(params.id)
  json(res, removed ? 200 : 404, { ok: removed })
}

// ── Topics ───────────────────────────────────────────────

handlers['api:topics:list'] = async (req, res, params) => {
  const [topics, allCells] = await Promise.all([
    collections.topics.findAll({
      where: { brand_id: params.brandId },
      sort: 'sort_order',
    }),
    collections.content_cells.findAll({
      where: { brand_id: params.brandId },
    }),
  ])
  const cellsByTopic = {}
  for (const cell of allCells) {
    const key = cell.topic_id
    cellsByTopic[key] = cellsByTopic[key] || []
    cellsByTopic[key].push(cell)
  }
  const topicsWithCells = topics.map((topic) => ({
    ...topic,
    cells: cellsByTopic[topic.id] || [],
  }))
  json(res, 200, { topics: topicsWithCells })
}

handlers['api:topics:create'] = async (req, res) => {
  const body = await readBody(req)
  if (!body.brand_id || !body.title) {
    return json(res, 400, { error: 'brand_id and title are required' })
  }
  const topicId = `t_${crypto.randomUUID().slice(0, 8)}`
  const topic = await collections.topics.create({
    id: topicId,
    brand_id: body.brand_id,
    title: body.title,
    sort_order: body.sort_order || 0,
  })

  // Auto-create content cells for this topic
  const cellTypes = ['article', 'yt', 'reel1', 'reel2', 'reel3', 'thread1', 'thread2']
  const cells = []
  for (const type of cellTypes) {
    const cell = await collections.content_cells.create({
      id: `cc_${crypto.randomUUID().slice(0, 8)}`,
      topic_id: topicId,
      brand_id: body.brand_id,
      type,
      status: 'empty',
      done_at: null,
    })
    cells.push(cell)
  }

  json(res, 201, { topic: { ...topic, cells } })
}

handlers['api:topics:update'] = async (req, res, params) => {
  const body = await readBody(req)
  const updated = await collections.topics.update(params.id, body)
  if (!updated) return json(res, 404, { error: 'topic not found' })
  json(res, 200, { topic: updated })
}

handlers['api:topics:delete'] = async (req, res, params) => {
  // Delete topic's cells first
  const cells = await collections.content_cells.findAll({
    where: { topic_id: params.id },
  })
  for (const cell of cells) {
    await collections.content_cells.remove(cell.id)
  }
  const removed = await collections.topics.remove(params.id)
  json(res, removed ? 200 : 404, { ok: removed })
}

// ── Cells ────────────────────────────────────────────────

handlers['api:cells:update'] = async (req, res, params) => {
  const body = await readBody(req)
  const cell = await collections.content_cells.getById(params.id)
  if (!cell) return json(res, 404, { error: 'cell not found' })

  const newStatus = body.status || (cell.status === 'done' ? 'empty' : 'done')
  const updates = {
    status: newStatus,
    done_at: newStatus === 'done' ? new Date().toISOString() : null,
  }
  const updated = await collections.content_cells.update(params.id, updates)
  json(res, 200, { cell: updated })
}

// ── Tasks ────────────────────────────────────────────────

handlers['api:tasks:today'] = async (req, res) => {
  const tasks = await generateTasks(collections)
  json(res, 200, { tasks })
}

handlers['api:tasks:complete'] = async (req, res, params) => {
  const body = await readBody(req)
  const task = await collections.daily_tasks.getById(params.id)
  if (!task) return json(res, 404, { error: 'task not found' })

  const status = body.status || 'done'
  const updates = {
    status,
    completed_at: status === 'done' ? new Date().toISOString() : null,
    skipped_reason: body.skipped_reason || null,
  }
  const updated = await collections.daily_tasks.update(params.id, updates)

  // Update brand's last_action_at
  if (status === 'done' && task.brand_id) {
    await collections.brands.update(task.brand_id, {
      last_action_at: new Date().toISOString(),
    })
  }

  // Update daily log
  await updateDailyLog(task.date)

  json(res, 200, { task: updated })
}

async function updateDailyLog(date) {
  const tasks = await collections.daily_tasks.findAll({ where: { date } })
  const total = tasks.length
  const done = tasks.filter((t) => t.status === 'done').length
  const skipped = tasks.filter((t) => t.status === 'skipped').length

  const logId = `dl_${date.replace(/-/g, '')}`
  const existing = await collections.daily_logs.getById(logId)

  const logData = {
    id: logId,
    date,
    tasks_total: total,
    tasks_done: done,
    tasks_skipped: skipped,
  }

  if (existing) {
    await collections.daily_logs.update(logId, logData)
  } else {
    await collections.daily_logs.create(logData)
  }
}

// ── Revenue ──────────────────────────────────────────────

handlers['api:revenue:list'] = async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const brandId = url.searchParams.get('brand_id')
  const opts = { sort: '-date' }
  if (brandId) opts.where = { brand_id: brandId }
  const entries = await collections.revenue_logs.findAll(opts)
  json(res, 200, { entries })
}

handlers['api:revenue:create'] = async (req, res) => {
  const body = await readBody(req)
  const amount = parseInt(body.amount, 10)
  if (!body.brand_id || isNaN(amount) || amount < 0) {
    return json(res, 400, { error: 'brand_id and valid amount are required' })
  }
  const entry = await collections.revenue_logs.create({
    id: `rv_${crypto.randomUUID().slice(0, 8)}`,
    brand_id: body.brand_id,
    amount,
    source: body.source || '',
    note: body.note || '',
    date: body.date || todayStr(),
  })

  // Update brand revenue total
  const brand = await collections.brands.getById(body.brand_id)
  if (brand) {
    const allRevenue = await collections.revenue_logs.findAll({
      where: { brand_id: body.brand_id },
    })
    const total = allRevenue.reduce((sum, r) => {
      const n = parseInt(r.amount, 10)
      return sum + (isNaN(n) ? 0 : n)
    }, 0)
    await collections.brands.update(body.brand_id, { revenue_total: total })
  }

  json(res, 201, { entry })
}

handlers['api:revenue:delete'] = async (req, res, params) => {
  const entry = await collections.revenue_logs.getById(params.id)
  if (!entry) return json(res, 404, { error: 'not found' })

  await collections.revenue_logs.remove(params.id)

  // Recalculate brand total
  if (entry.brand_id) {
    const allRevenue = await collections.revenue_logs.findAll({
      where: { brand_id: entry.brand_id },
    })
    const total = allRevenue.reduce((sum, r) => {
      const n = parseInt(r.amount, 10)
      return sum + (isNaN(n) ? 0 : n)
    }, 0)
    await collections.brands.update(entry.brand_id, { revenue_total: total })
  }

  json(res, 200, { ok: true })
}

// ── Graph ────────────────────────────────────────────────

handlers['api:graph'] = async (req, res) => {
  const today = new Date()
  const days = []

  for (let i = 364; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    days.push(dateStr)
  }

  const logs = await collections.daily_logs.findAll({})
  const logMap = {}
  for (const log of logs) {
    logMap[log.date] = log.tasks_done || 0
  }

  const graph = days.map((date) => {
    const count = logMap[date] || 0
    let level = 0
    if (count >= 4) level = 3
    else if (count >= 2) level = 2
    else if (count >= 1) level = 1
    return { date, count, level }
  })

  json(res, 200, { graph })
}

// ── Stats ────────────────────────────────────────────────

handlers['api:stats'] = async (req, res) => {
  const logs = await collections.daily_logs.findAll({ sort: 'date' })
  const today = todayStr()
  const year = today.slice(0, 4)

  // Year stats
  const yearLogs = logs.filter((l) => l.date.startsWith(year))
  const daysInYear = Math.floor(
    (new Date(today) - new Date(`${year}-01-01`)) / 86400000
  ) + 1
  const activeDays = yearLogs.filter((l) => (l.tasks_done || 0) > 0).length

  // Streak calculation
  let currentStreak = 0
  let longestStreak = 0
  let streak = 0

  const sortedDates = logs
    .filter((l) => (l.tasks_done || 0) > 0)
    .map((l) => l.date)
    .sort()

  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      streak = 1
    } else {
      const prev = new Date(sortedDates[i - 1])
      const curr = new Date(sortedDates[i])
      const diff = (curr - prev) / 86400000
      streak = diff === 1 ? streak + 1 : 1
    }
    if (streak > longestStreak) longestStreak = streak
  }

  // Current streak: count backwards from today
  const todayDate = new Date(today)
  currentStreak = 0
  for (let i = 0; i < 365; i++) {
    const d = new Date(todayDate)
    d.setDate(d.getDate() - i)
    const ds = d.toISOString().slice(0, 10)
    const log = logs.find((l) => l.date === ds)
    if (log && (log.tasks_done || 0) > 0) {
      currentStreak++
    } else if (i === 0) {
      // Today hasn't been logged yet, that's ok
      continue
    } else {
      break
    }
  }

  // Total revenue
  const brands = await collections.brands.findAll({})
  const totalRevenue = brands.reduce((s, b) => s + (b.revenue_total || 0), 0)

  // Total tasks done
  const totalDone = logs.reduce((s, l) => s + (l.tasks_done || 0), 0)

  // Completion rate
  const totalTasks = logs.reduce((s, l) => s + (l.tasks_total || 0), 0)
  const completionRate = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0

  // Goals
  const goals = await collections.goals.findAll({})
  const totalGoal = goals.find((g) => g.type === 'total')

  json(res, 200, {
    year: parseInt(year, 10),
    days_in_year: daysInYear,
    active_days: activeDays,
    active_rate: daysInYear > 0 ? Math.round((activeDays / daysInYear) * 100) : 0,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    total_revenue: totalRevenue,
    total_done: totalDone,
    completion_rate: completionRate,
    revenue_goal: totalGoal ? totalGoal.target : 10000000,
  })
}

// ── Dashboard ────────────────────────────────────────────

handlers['api:dashboard'] = async (req, res) => {
  const [brands, tasksData, graphData, statsData] = await Promise.all([
    collections.brands.findAll({ sort: 'sort_order' }),
    generateTasks(collections),
    (async () => {
      const today = new Date()
      const days = []
      for (let i = 364; i >= 0; i--) {
        const d = new Date(today)
        d.setDate(d.getDate() - i)
        days.push(d.toISOString().slice(0, 10))
      }
      const logs = await collections.daily_logs.findAll({})
      const logMap = {}
      for (const log of logs) logMap[log.date] = log.tasks_done || 0
      return days.map((date) => {
        const count = logMap[date] || 0
        let level = 0
        if (count >= 4) level = 3
        else if (count >= 2) level = 2
        else if (count >= 1) level = 1
        return { date, count, level }
      })
    })(),
    (async () => {
      // Inline stats
      const logs = await collections.daily_logs.findAll({ sort: 'date' })
      const today = todayStr()
      const year = today.slice(0, 4)
      const yearLogs = logs.filter((l) => l.date.startsWith(year))
      const daysInYear = Math.floor((new Date(today) - new Date(`${year}-01-01`)) / 86400000) + 1
      const activeDays = yearLogs.filter((l) => (l.tasks_done || 0) > 0).length

      let currentStreak = 0
      const todayDate = new Date(today)
      for (let i = 0; i < 365; i++) {
        const d = new Date(todayDate)
        d.setDate(d.getDate() - i)
        const ds = d.toISOString().slice(0, 10)
        const log = logs.find((l) => l.date === ds)
        if (log && (log.tasks_done || 0) > 0) {
          currentStreak++
        } else if (i === 0) {
          continue
        } else {
          break
        }
      }

      let longestStreak = 0
      let streak = 0
      const sortedDates = logs.filter((l) => (l.tasks_done || 0) > 0).map((l) => l.date).sort()
      for (let i = 0; i < sortedDates.length; i++) {
        if (i === 0) { streak = 1 } else {
          const diff = (new Date(sortedDates[i]) - new Date(sortedDates[i - 1])) / 86400000
          streak = diff === 1 ? streak + 1 : 1
        }
        if (streak > longestStreak) longestStreak = streak
      }

      const brands = await collections.brands.findAll({})
      const totalRevenue = brands.reduce((s, b) => s + (b.revenue_total || 0), 0)
      const totalDone = logs.reduce((s, l) => s + (l.tasks_done || 0), 0)
      const totalTasks = logs.reduce((s, l) => s + (l.tasks_total || 0), 0)
      const goals = await collections.goals.findAll({})
      const totalGoal = goals.find((g) => g.type === 'total')

      return {
        year: parseInt(year, 10),
        days_in_year: daysInYear,
        active_days: activeDays,
        active_rate: daysInYear > 0 ? Math.round((activeDays / daysInYear) * 100) : 0,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        total_revenue: totalRevenue,
        total_done: totalDone,
        completion_rate: totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0,
        revenue_goal: totalGoal ? totalGoal.target : 10000000,
      }
    })(),
  ])

  json(res, 200, {
    brands,
    tasks: tasksData,
    graph: graphData,
    stats: statsData,
  })
}

// ── Goals ────────────────────────────────────────────────

handlers['api:goals:list'] = async (req, res) => {
  const goals = await collections.goals.findAll({})
  json(res, 200, { goals })
}

handlers['api:goals:update'] = async (req, res, params) => {
  const body = await readBody(req)
  let goal = await collections.goals.getById(params.id)
  if (goal) {
    goal = await collections.goals.update(params.id, body)
  } else {
    goal = await collections.goals.create({ id: params.id, ...body })
  }
  json(res, 200, { goal })
}

// ── Server ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  try {
    const url = new URL(req.url, 'http://x')
    const pathname = decodeURIComponent(url.pathname)

    // Static files
    if (pathname.startsWith('/app.js') || pathname.startsWith('/theme.js') || pathname.startsWith('/favicon')) {
      return serveStatic(res, path.join(__dirname, 'public', pathname.slice(1)))
    }

    const matched = matchRoute(req.method, pathname, routes)

    if (!matched) {
      return json(res, 404, { error: 'not found' })
    }

    // Auth check for API routes (except health and pages)
    if (matched.handler.startsWith('api:') && matched.handler !== 'api:health') {
      if (!checkAuth(req)) {
        return json(res, 401, { error: 'unauthorized' })
      }
    }

    const handler = handlers[matched.handler]
    if (!handler) {
      return json(res, 500, { error: `handler not found: ${matched.handler}` })
    }

    await handler(req, res, matched.params)
  } catch (err) {
    console.error('[solohq]', req.method, req.url, err.message)
    if (!res.headersSent) {
      json(res, err.message === 'invalid JSON' ? 400 : 500, { error: err.message })
    }
  }
})

function shutdown(signal) {
  console.log(`[solohq] ${signal}, shutting down`)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.listen(PORT, () => {
  console.log(`[solohq] listening on http://localhost:${PORT}`)
})
