import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

export function registerSettingRoutes(router: Router): void {
  router.get('/api/settings', (ctx) => {
    const settings = queries.getAllSettings(ctx.db)
    return { data: settings }
  })

  router.get('/api/settings/:key', (ctx) => {
    const value = queries.getSetting(ctx.db, ctx.params.key)
    return { data: { key: ctx.params.key, value } }
  })

  router.put('/api/settings/:key', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (body.value === undefined) {
      return { status: 400, error: 'value is required' }
    }

    queries.setSetting(ctx.db, ctx.params.key, String(body.value))
    return { data: { key: ctx.params.key, value: String(body.value) } }
  })
}
