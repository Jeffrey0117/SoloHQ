'use strict'

const crypto = require('crypto')

const TASK_TEMPLATES = {
  reel:    (brand) => `[${brand.name}] 發一支 Reel`,
  article: (brand) => `[${brand.name}] 寫一篇文章`,
  reply:   (brand) => `[${brand.name}] 回覆用戶問題/留言`,
  update:  (brand) => `[${brand.name}] 更新產品或修 bug`,
  record:  (brand) => `[${brand.name}] 錄一段教學影片`,
  thread:  (brand) => `[${brand.name}] 發一則 Thread`,
  yt:      (brand) => `[${brand.name}] 製作 YT 影片`,
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function daysBetween(dateStr, today) {
  const d1 = new Date(dateStr)
  const d2 = new Date(today)
  return Math.max(0, Math.floor((d2 - d1) / 86400000))
}

/**
 * Pick the next task type for a brand, rotating through its task_types array.
 * Uses dateStr to deterministically rotate.
 */
function pickTaskType(brand, dateStr, offset) {
  const types = brand.task_types || ['reel', 'article', 'update']
  const dayNum = Math.floor(new Date(dateStr).getTime() / 86400000)
  const idx = (dayNum + offset) % types.length
  return types[idx]
}

/**
 * Generate daily tasks for a given date.
 *
 * @param {object} collections - { brands, daily_tasks }
 * @param {string} [date] - defaults to today
 * @returns {Promise<object[]>} generated tasks
 */
async function generateTasks(collections, date) {
  const today = date || todayStr()

  // Check if already generated
  const existing = await collections.daily_tasks.findAll({
    where: { date: today },
  })
  if (existing.length > 0) return existing

  // Get active brands
  const allBrands = await collections.brands.findAll({
    where: { status: 'active' },
  })
  if (allBrands.length === 0) return []

  // Score brands: revenue * cooldown weight
  const scored = allBrands.map((b) => {
    const cooldown = b.last_action_at
      ? daysBetween(b.last_action_at, today)
      : 999
    const revenue = b.revenue_total || 0
    return {
      ...b,
      cooldown,
      score: (revenue + 1) * (cooldown + 1),
    }
  })

  // Sort by score descending
  const sorted = [...scored].sort((a, b) => b.score - a.score)

  // Split: revenue brands (have earned) vs new brands (no revenue)
  const revenueBrands = sorted.filter((b) => (b.revenue_total || 0) > 0)
  const newBrands = sorted.filter((b) => (b.revenue_total || 0) === 0)

  const tasks = []
  const MAX_TASKS = 4

  // 70%: up to 3 tasks from revenue brands
  const revenueSlots = Math.min(3, revenueBrands.length)
  for (let i = 0; i < revenueSlots && tasks.length < MAX_TASKS; i++) {
    const brand = revenueBrands[i]
    const taskType = pickTaskType(brand, today, i)
    const templateFn = TASK_TEMPLATES[taskType] || TASK_TEMPLATES.update
    tasks.push({
      id: `dt_${today.replace(/-/g, '')}_${tasks.length + 1}`,
      brand_id: brand.id,
      description: templateFn(brand),
      task_type: taskType,
      date: today,
      status: 'pending',
      skipped_reason: null,
      completed_at: null,
    })
  }

  // 30%: 1 task from new/planning brands
  if (tasks.length < MAX_TASKS && newBrands.length > 0) {
    const brand = newBrands[0]
    const taskType = pickTaskType(brand, today, 0)
    const templateFn = TASK_TEMPLATES[taskType] || TASK_TEMPLATES.update
    tasks.push({
      id: `dt_${today.replace(/-/g, '')}_${tasks.length + 1}`,
      brand_id: brand.id,
      description: templateFn(brand),
      task_type: taskType,
      date: today,
      status: 'pending',
      skipped_reason: null,
      completed_at: null,
    })
  }

  // If still room and we have more revenue brands, fill
  for (
    let i = revenueSlots;
    i < revenueBrands.length && tasks.length < MAX_TASKS;
    i++
  ) {
    const brand = revenueBrands[i]
    const taskType = pickTaskType(brand, today, i)
    const templateFn = TASK_TEMPLATES[taskType] || TASK_TEMPLATES.update
    tasks.push({
      id: `dt_${today.replace(/-/g, '')}_${tasks.length + 1}`,
      brand_id: brand.id,
      description: templateFn(brand),
      task_type: taskType,
      date: today,
      status: 'pending',
      skipped_reason: null,
      completed_at: null,
    })
  }

  // Persist
  for (const task of tasks) {
    await collections.daily_tasks.create(task)
  }

  return tasks
}

module.exports = { generateTasks, todayStr, TASK_TEMPLATES }
