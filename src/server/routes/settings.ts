import { randomBytes } from 'node:crypto'
import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

function ensureKeeperReferralCode(db: Parameters<typeof queries.getSetting>[0]): string {
  const existing = queries.getSetting(db, 'keeper_referral_code')?.trim()
  if (existing) return existing
  const generated = randomBytes(6).toString('base64url').slice(0, 10)
  queries.setSetting(db, 'keeper_referral_code', generated)
  return generated
}

export function registerSettingRoutes(router: Router): void {
  router.get('/api/settings', (ctx) => {
    const settings = queries.getAllSettings(ctx.db)
    return { data: settings }
  })

  router.get('/api/settings/referral', (ctx) => {
    const code = ensureKeeperReferralCode(ctx.db)
    return {
      data: {
        code,
        inviteUrl: `https://quoroom.ai/invite/${encodeURIComponent(code)}`,
        shareUrl: `https://quoroom.ai/share/v2/${encodeURIComponent(code)}`
      }
    }
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
