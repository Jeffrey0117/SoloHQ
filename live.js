'use strict'

/**
 * Live status for the project wall — joins each card to its CloudPipe
 * registration (public URL, last deploy) and probes whether it answers.
 * Matched by real directory path, so junctions (code/x → workhub/x) resolve.
 * Cached for 60s; concurrent callers share one in-flight refresh.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')

const CONFIG_PATH = process.env.CLOUDPIPE_CONFIG || path.resolve(__dirname, '../../config.json')
const TTL_MS = 60000
const PROBE_TIMEOUT_MS = 1500
const DRIFT_GRACE_MS = 60000

let cache = { at: 0, map: new Map() }
let inflight = null

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) } catch { return null }
}

function realKey(p) {
  try { return fs.realpathSync(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
}

function probe(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(null)
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume()
      resolve(res.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function publicUrl(p, domain) {
  const custom = (p.customDomains || []).find((d) => d && !d.includes('*'))
  if (custom) return `https://${custom}`
  if (domain && p.port) return `https://${p.id}.${domain}`
  return null
}

async function build() {
  const cfg = readConfig()
  if (!cfg || !cfg.serviceToken) throw new Error(`no serviceToken in ${CONFIG_PATH}`)
  // Must be "localhost": CloudPipe routes by Host and treats 127.0.0.1 as an unknown site (404).
  const res = await fetch(`http://localhost:${cfg.port || 8787}/api/_admin/deploy/projects`, {
    headers: { authorization: `Bearer ${cfg.serviceToken}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
  const body = await res.json()
  const list = Array.isArray(body) ? body : (body.projects || [])
  if (!list.length) throw new Error('registry returned no projects')
  const root = path.dirname(CONFIG_PATH)
  const entries = await Promise.all(list.map(async (p) => {
    const dir = realKey(path.resolve(root, p.directory || `../workhub/${p.id}`))
    // "parasite" = served by an external host (Render); the local copy is
    // intentionally stopped, so a dead local port is not an outage.
    const external = p.deployMethod === 'parasite'
    const up = p.suspended || external ? null : await probe(p.port)
    return [dir, {
      id: p.id,
      url: publicUrl(p, cfg.domain),
      up,
      external,
      suspended: Boolean(p.suspended),
      lastDeployAt: p.lastDeployAt || null,
      deployMethod: p.deployMethod || null,
    }]
  }))
  return new Map(entries)
}

async function getLive(opts) {
  const fresh = Boolean(opts && opts.fresh)
  if (!fresh && Date.now() - cache.at < TTL_MS) return cache.map
  if (!inflight) {
    inflight = build()
      .then((map) => { cache = { at: Date.now(), map }; return map })
      .catch((err) => {
        // Keep the last good map and do NOT bump `at` — the next request retries.
        console.error('[solohq] live status failed:', err.message)
        return cache.map
      })
      .finally(() => { inflight = null })
  }
  return inflight
}

/** Returns new card objects with `live` and `drift` attached (inputs untouched). */
function attach(cards, liveMap) {
  return cards.map((card) => {
    const l = liveMap.get(realKey(card.path)) || null
    const commitAt = card.lastCommitAt ? Date.parse(card.lastCommitAt) : 0
    const deployAt = l && l.lastDeployAt ? Date.parse(l.lastDeployAt) : 0
    const driftDays = l && !l.external && commitAt && deployAt && commitAt > deployAt + DRIFT_GRACE_MS
      ? Math.max(1, Math.round((commitAt - deployAt) / 86400000))
      : 0
    return { ...card, live: l, driftDays }
  })
}

module.exports = { getLive, attach }
