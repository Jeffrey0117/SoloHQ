# solohq

Solo founder command center — commit-style activity graph + daily task engine + content matrix + revenue tracking + a project wall that auto-cards every repo in your `code/` folder.

## Stack
- Node.js, built-in `http` (no web framework), `'use strict'` CommonJS
- Zero npm dependencies in this package; persistence via shared CloudPipe DB SDK at `../../sdk/database` (better-sqlite3 local mode, Selfize REST fallback)
- Static frontend: vanilla JS + multi-page HTML in `public/` (no build step)
- AI features shell out to the local `claude` CLI in headless mode (`claude -p`)

## Directory structure
```
server.js        ← HTTP server, all API/page handlers, DB init, graceful shutdown
router.js        ← matchRoute() + flat route table (method/path → handler key)
engine.js        ← Daily task generator: scores brands (revenue × cooldown), rotates task templates
projects.js      ← Project Wall: scans CODE_DIR, builds cached "identity cards" per repo (fs only)
summarizer.js    ← analyze(dir): asks claude CLI to categorize + write a 1-line zh-TW intro
public/          ← index/do/matrix/revenue/brands/projects .html + app.js + theme.js
data/solohq.db   ← SQLite (created by the SDK)
```
Generated cache files (gitignored-style, written at runtime): `projects-cache.json`, `projects-overrides.json`, `projects-summaries.json`.

## Key concepts
- **Collections**: `brands`, `topics`, `content_cells`, `daily_tasks`, `daily_logs`, `revenue_logs`, `goals` — all via `db.collection(name)` with `findAll/getById/create/update/remove`.
- **Task engine** (`engine.js`): generates ≤4 tasks/day, idempotent per date (returns existing if already generated). ~70% from revenue-earning brands, ~30% from new brands; task type rotates deterministically by day number; completing a task stamps `brand.last_action_at` and updates that date's `daily_logs`.
- **Activity graph**: 365-day grid built from `daily_logs.tasks_done` → level 0–3 (1/2/4+ tasks).
- **Content matrix**: a topic auto-spawns 7 `content_cells` (`article, yt, reel1-3, thread1-2`); cell PUT toggles `empty`↔`done`.
- **Revenue**: creating/deleting a `revenue_logs` entry recalculates `brand.revenue_total` from the sum.
- **Project Wall** (`projects.js`): scans `SOLOHQ_CODE_DIR` (default `../../`, i.e. the parent `code/`). Detects type/stack/language/repo-status/completeness from files only — never runs a project. Cheap mtime fingerprint enables instant incremental rescans. AI intro/category fill in via `summarizer.js`; manual overrides persist in `projects-overrides.json`.
- **Aggregate endpoint**: `GET /api/dashboard` returns brands + today's tasks + graph + stats in one call (stats logic is inlined there, duplicating `/api/stats`).
- **Auth**: optional bearer token via `SOLOHQ_TOKEN`; if unset, all routes open. Pages and `/api/health` skip auth.
- **Open-in-machine**: `POST /api/projects/:id/open` spawns `explorer.exe` or `code` — assumes the server runs locally on Windows.

## Commands
```
npm start                 # node server.js  (PORT env, default 4028)
node server.js            # same
```
No tests, lint, or build configured.

## Env vars
- `PORT` (default 4028)
- `SOLOHQ_TOKEN` — bearer token; unset = no auth
- `SOLOHQ_CODE_DIR` — root folder for the project wall (default `../../`)
- `SOLOHQ_GH_USER` — your GitHub handle; repos owned by anyone else are flagged `isClone` (default `Jeffrey0117`)
- `SELFIZE_PORT` / `SELFIZE_TOKEN` — used by the DB SDK in remote mode

## Coding rules
- `'use strict'`, CommonJS modules, immutable updates (spread, never mutate).
- Validate request bodies and return JSON `{ error }` with the right status.
- `readBody` caps payloads (default 64KB). Use the route table in `router.js` + handler keys in `server.js` rather than ad-hoc routing.
- Keep the no-dependency, no-build-step constraint for this package.
