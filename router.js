'use strict'

/**
 * Route matching — returns { handler, params } or null
 */
function matchRoute(method, pathname, routes) {
  for (const route of routes) {
    if (route.method !== method) continue

    const routeParts = route.path.split('/')
    const pathParts = pathname.split('/')

    if (routeParts.length !== pathParts.length) continue

    const params = {}
    let matched = true

    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = pathParts[i]
      } else if (routeParts[i] !== pathParts[i]) {
        matched = false
        break
      }
    }

    if (matched) {
      return { handler: route.handler, params }
    }
  }

  return null
}

const routes = [
  // Pages
  { method: 'GET', path: '/', handler: 'page:dashboard' },
  { method: 'GET', path: '/do', handler: 'page:do' },
  { method: 'GET', path: '/matrix', handler: 'page:matrix' },
  { method: 'GET', path: '/revenue', handler: 'page:revenue' },
  { method: 'GET', path: '/brands', handler: 'page:brands' },

  // Health
  { method: 'GET', path: '/api/health', handler: 'api:health' },

  // Dashboard aggregate
  { method: 'GET', path: '/api/dashboard', handler: 'api:dashboard' },

  // Brands
  { method: 'GET', path: '/api/brands', handler: 'api:brands:list' },
  { method: 'POST', path: '/api/brands', handler: 'api:brands:create' },
  { method: 'PUT', path: '/api/brands/:id', handler: 'api:brands:update' },
  { method: 'DELETE', path: '/api/brands/:id', handler: 'api:brands:delete' },

  // Topics
  { method: 'GET', path: '/api/topics/:brandId', handler: 'api:topics:list' },
  { method: 'POST', path: '/api/topics', handler: 'api:topics:create' },
  { method: 'PUT', path: '/api/topics/:id', handler: 'api:topics:update' },
  { method: 'DELETE', path: '/api/topics/:id', handler: 'api:topics:delete' },

  // Cells
  { method: 'PUT', path: '/api/cells/:id', handler: 'api:cells:update' },

  // Tasks
  { method: 'GET', path: '/api/tasks/today', handler: 'api:tasks:today' },
  { method: 'PUT', path: '/api/tasks/:id', handler: 'api:tasks:complete' },

  // Revenue
  { method: 'GET', path: '/api/revenue', handler: 'api:revenue:list' },
  { method: 'POST', path: '/api/revenue', handler: 'api:revenue:create' },
  { method: 'DELETE', path: '/api/revenue/:id', handler: 'api:revenue:delete' },

  // Graph + Stats
  { method: 'GET', path: '/api/graph', handler: 'api:graph' },
  { method: 'GET', path: '/api/stats', handler: 'api:stats' },

  // Goals
  { method: 'GET', path: '/api/goals', handler: 'api:goals:list' },
  { method: 'PUT', path: '/api/goals/:id', handler: 'api:goals:update' },

  // Projects wall
  { method: 'GET', path: '/projects', handler: 'page:projects' },
  { method: 'GET', path: '/api/projects', handler: 'api:projects:list' },
  { method: 'POST', path: '/api/projects/scan', handler: 'api:projects:scan' },
  { method: 'PUT', path: '/api/projects/:id', handler: 'api:projects:update' },
]

module.exports = { matchRoute, routes }
