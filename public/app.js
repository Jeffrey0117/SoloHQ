'use strict'

// ── Config ───────────────────────────────────────────────

const API_BASE = ''
const TOKEN = localStorage.getItem('solohq_token') || ''

// ── HTTP helpers ─────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, opts)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Formatting ───────────────────────────────────────────

function formatNTD(amount) {
  return 'NT$' + Number(amount || 0).toLocaleString()
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  return dateStr.slice(0, 10)
}

function daysSince(dateStr) {
  if (!dateStr) return 999
  return Math.floor((new Date() - new Date(dateStr)) / 86400000)
}

function cooldownColor(days) {
  if (days <= 1) return 'var(--green)'
  if (days <= 3) return 'var(--yellow)'
  return 'var(--red)'
}

function cooldownLabel(days) {
  if (days === 0) return '今天'
  if (days >= 999) return '從未'
  return `${days}天前`
}

// ── DOM helpers ──────────────────────────────────────────

function $(sel) { return document.querySelector(sel) }
function $$(sel) { return document.querySelectorAll(sel) }

function el(tag, attrs, children) {
  const e = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v
      else if (k === 'textContent') e.textContent = v
      else if (k === 'innerHTML') e.innerHTML = v
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v)
      else e.setAttribute(k, v)
    }
  }
  if (children) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'string') e.appendChild(document.createTextNode(child))
      else if (child) e.appendChild(child)
    }
  }
  return e
}

// ── Auth setup ───────────────────────────────────────────

function setupAuth() {
  const saved = localStorage.getItem('solohq_token')
  if (saved) return
  const params = new URLSearchParams(location.search)
  const token = params.get('token')
  if (token) {
    localStorage.setItem('solohq_token', token)
    location.search = ''
  }
}

// ── Commit Graph renderer ────────────────────────────────

function renderGraph(container, data) {
  container.innerHTML = ''

  const CELL = 18
  const GAP = 4
  const SIZE = CELL + GAP
  const LABEL_W = 36
  const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

  // Organize data into weeks (columns), starting from Sunday
  // Find the first Sunday in data to align properly
  const firstDate = new Date(data[0].date)
  const firstDay = firstDate.getDay()
  const padBefore = firstDay // days to skip in first week

  const weeks = []
  let currentWeek = new Array(padBefore).fill(null)

  for (let i = 0; i < data.length; i++) {
    currentWeek.push(data[i])
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }
  if (currentWeek.length > 0) weeks.push(currentWeek)

  const WEEKS = weeks.length
  const width = LABEL_W + WEEKS * SIZE + 4
  const height = 7 * SIZE + 28

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.style.width = '100%'
  svg.style.height = 'auto'
  svg.style.display = 'block'

  const colors = ['#1b1f27', '#0e4429', '#006d32', '#26a641', '#39d353']

  // Day labels (left side)
  for (let d = 0; d < 7; d++) {
    if (DAY_LABELS[d]) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', 0)
      text.setAttribute('y', d * SIZE + CELL * 0.8)
      text.setAttribute('fill', '#484f58')
      text.setAttribute('font-size', '11')
      text.setAttribute('font-family', 'var(--font-mono)')
      text.textContent = DAY_LABELS[d]
      svg.appendChild(text)
    }
  }

  // Month labels (top)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  let lastMonth = -1

  for (let w = 0; w < weeks.length; w++) {
    const firstInWeek = weeks[w].find(d => d !== null)
    if (!firstInWeek) continue
    const date = new Date(firstInWeek.date)
    const month = date.getMonth()
    if (month !== lastMonth) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', LABEL_W + w * SIZE)
      text.setAttribute('y', height - 6)
      text.setAttribute('fill', '#484f58')
      text.setAttribute('font-size', '11')
      text.setAttribute('font-family', 'var(--font-mono)')
      text.textContent = months[month]
      svg.appendChild(text)
      lastMonth = month
    }

    for (let d = 0; d < weeks[w].length; d++) {
      const entry = weeks[w][d]
      if (!entry) continue

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', LABEL_W + w * SIZE)
      rect.setAttribute('y', d * SIZE)
      rect.setAttribute('width', CELL)
      rect.setAttribute('height', CELL)
      rect.setAttribute('rx', 3)
      rect.setAttribute('fill', colors[entry.level] || colors[0])

      if (entry.level > 0) {
        rect.style.filter = `drop-shadow(0 0 ${entry.level * 2}px ${colors[entry.level]}40)`
      }

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = `${entry.date}: ${entry.count} 件完成`
      rect.appendChild(title)
      svg.appendChild(rect)
    }
  }

  container.appendChild(svg)
}

// ── Brand list renderer ──────────────────────────────────

function renderBrandList(container, brands) {
  container.innerHTML = ''

  if (brands.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無品牌 — <a href="/brands">前往新增</a></div>'
    return
  }

  for (const brand of brands) {
    const days = daysSince(brand.last_action_at)
    const row = el('div', { className: 'brand-row' }, [
      el('span', { className: 'indicator', style: { backgroundColor: cooldownColor(days) } }),
      el('span', { className: 'brand-name', textContent: brand.name }),
      el('span', { className: 'brand-cooldown', textContent: cooldownLabel(days), style: { color: cooldownColor(days) } }),
      el('span', { className: 'brand-revenue', textContent: formatNTD(brand.revenue_total) }),
    ])
    container.appendChild(row)
  }
}

// ── Task list renderer ───────────────────────────────────

function renderTaskList(container, tasks, options) {
  container.innerHTML = ''
  const interactive = options && options.interactive

  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">今日無任務</div>'
    return
  }

  for (const task of tasks) {
    const isDone = task.status === 'done'
    const isSkipped = task.status === 'skipped'
    const cls = `task-row${isDone ? ' done' : ''}${isSkipped ? ' skipped' : ''}`
    const row = el('div', { className: cls })

    if (interactive) {
      row.appendChild(el('button', {
        className: `task-btn${isDone ? ' active' : ''}`,
        innerHTML: isDone ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>' : '',
        onClick: async () => {
          if (isDone) return
          await api('PUT', `/api/tasks/${task.id}`, { status: 'done' })
          if (options.onUpdate) options.onUpdate()
        },
      }))
      row.appendChild(el('span', { className: 'task-desc', textContent: task.description }))
      if (!isDone && !isSkipped) {
        row.appendChild(el('button', {
          className: 'task-skip',
          textContent: '跳過',
          onClick: async () => {
            const reason = prompt('跳過原因 (可留空)')
            await api('PUT', `/api/tasks/${task.id}`, { status: 'skipped', skipped_reason: reason || '' })
            if (options.onUpdate) options.onUpdate()
          },
        }))
      }
      if (isSkipped && task.skipped_reason) {
        row.appendChild(el('span', { className: 'skip-reason', textContent: task.skipped_reason }))
      }
    } else {
      const icon = isDone ? '✓' : isSkipped ? '—' : '○'
      row.appendChild(el('span', { className: `task-icon${isDone ? ' done' : ''}`, textContent: icon }))
      row.appendChild(el('span', { className: 'task-desc', textContent: task.description }))
    }

    container.appendChild(row)
  }
}

// ── Revenue progress bar ─────────────────────────────────

function renderRevenueBar(container, current, goal) {
  container.innerHTML = ''
  const pct = Math.min(100, Math.round((current / goal) * 100))
  const bar = el('div', { className: 'revenue-bar' }, [
    el('div', { className: 'revenue-bar__labels' }, [
      el('span', { innerHTML: `累計 <strong>${formatNTD(current)}</strong>` }),
      el('span', { textContent: `目標 ${formatNTD(goal)}` }),
    ]),
    el('div', { className: 'revenue-bar__track' }, [
      el('div', { className: 'revenue-bar__fill', style: { width: `${pct}%` } }),
      el('span', { className: 'revenue-bar__pct', textContent: `${pct}%` }),
    ]),
  ])
  container.appendChild(bar)
}

// ── Stats row renderer ───────────────────────────────────

function renderStats(container, stats) {
  container.innerHTML = ''
  const items = [
    { label: '行動天數', value: `${stats.active_days}/${stats.days_in_year}`, sub: `${stats.active_rate}%` },
    { label: '目前連續', value: `${stats.current_streak}`, sub: '天' },
    { label: '最長連續', value: `${stats.longest_streak}`, sub: '天' },
    { label: '完成率', value: `${stats.completion_rate}%`, sub: `${stats.total_done} 件` },
  ]
  for (const item of items) {
    container.appendChild(el('div', { className: 'stat-card' }, [
      el('div', { className: 'stat-card__label', textContent: item.label }),
      el('div', { className: 'stat-card__value', textContent: item.value }),
      el('div', { className: 'stat-card__sub', textContent: item.sub }),
    ]))
  }
}

// ── Export ────────────────────────────────────────────────

window.SoloHQ = {
  api, formatNTD, formatDate, daysSince, cooldownColor, cooldownLabel,
  $, $$, el, setupAuth,
  renderGraph, renderBrandList, renderTaskList, renderRevenueBar, renderStats,
}
