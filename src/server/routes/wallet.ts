import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}

export function registerWalletRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/wallet', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { status: 404, error: 'No wallet for this room' }
    return { data: { id: wallet.id, roomId: wallet.roomId, address: wallet.address, chain: wallet.chain, erc8004AgentId: wallet.erc8004AgentId, createdAt: wallet.createdAt } }
  })

  router.get('/api/rooms/:roomId/wallet/transactions', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const limit = parseLimit(ctx.query.limit, 50, 500)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { status: 404, error: 'No wallet for this room' }
    return { data: queries.listWalletTransactions(ctx.db, wallet.id, limit) }
  })

  router.get('/api/rooms/:roomId/wallet/summary', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    return { data: queries.getRevenueSummary(ctx.db, roomId) }
  })
}
