import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { getOnChainBalance, type NetworkName } from '../../shared/wallet'
import { SUPPORTED_CHAINS, SUPPORTED_TOKENS } from '../../shared/constants'
import type { OnChainBalance } from '../../shared/types'
import { getRoomCloudId, getCloudOnrampUrl } from '../../shared/cloud-sync'

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}

// Simple in-memory cache for on-chain balance (30s TTL)
const balanceCache = new Map<number, { data: OnChainBalance; fetchedAt: number }>()
const CACHE_TTL_MS = 30_000
const BALANCE_RPC_TIMEOUT_MS = 2_500
const pendingBalanceRequests = new Map<number, Promise<OnChainBalance>>()

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ])
}

async function fetchRoomBalance(roomId: number, address: string): Promise<OnChainBalance> {
  const existing = pendingBalanceRequests.get(roomId)
  if (existing) return existing

  const request = (async () => {
    const results = await Promise.all(
      SUPPORTED_CHAINS.flatMap(chain =>
        SUPPORTED_TOKENS.map(async token => ({
          chain,
          token,
          result: await withTimeout(
            getOnChainBalance(address, chain as NetworkName, token),
            BALANCE_RPC_TIMEOUT_MS,
            { balance: 0, balanceRaw: '0', network: chain, ok: false, error: 'timeout' }
          )
        }))
      )
    )

    const byChain: Record<string, { usdc: number; usdt: number; total: number }> = {}
    let totalBalance = 0
    for (const { chain, token, result } of results) {
      if (!byChain[chain]) byChain[chain] = { usdc: 0, usdt: 0, total: 0 }
      if (result.ok) {
        byChain[chain][token as 'usdc' | 'usdt'] = result.balance
        byChain[chain].total += result.balance
        totalBalance += result.balance
      }
    }

    const data: OnChainBalance = {
      totalBalance,
      byChain,
      address,
      fetchedAt: new Date().toISOString()
    }
    balanceCache.set(roomId, { data, fetchedAt: Date.now() })
    return data
  })()

  pendingBalanceRequests.set(roomId, request)
  request.finally(() => {
    pendingBalanceRequests.delete(roomId)
  })
  return request
}

export function registerWalletRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/wallet', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { data: null }
    return { data: { id: wallet.id, roomId: wallet.roomId, address: wallet.address, chain: wallet.chain, erc8004AgentId: wallet.erc8004AgentId, createdAt: wallet.createdAt } }
  })

  router.get('/api/rooms/:roomId/wallet/transactions', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const limit = parseLimit(ctx.query.limit, 50, 500)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { data: [] }
    return { data: queries.listWalletTransactions(ctx.db, wallet.id, limit) }
  })

  router.get('/api/rooms/:roomId/wallet/summary', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    return { data: queries.getRevenueSummary(ctx.db, roomId) }
  })

  router.get('/api/rooms/:roomId/wallet/balance', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { data: null }

    // Check cache
    const cached = balanceCache.get(roomId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { data: cached.data }
    }

    try {
      const data = await fetchRoomBalance(roomId, wallet.address)
      return { data }
    } catch {
      // Return stale cache rather than surfacing transient upstream RPC failures.
      if (cached) {
        return { data: { ...cached.data, fetchedAt: new Date().toISOString() } }
      }
      return {
        data: {
          totalBalance: 0,
          byChain: {},
          address: wallet.address,
          fetchedAt: new Date().toISOString()
        } satisfies OnChainBalance
      }
    }
  })

  // Server-side redirect — browser <a> tag navigates here, gets 302 to Coinbase
  router.get('/api/rooms/:roomId/wallet/onramp-redirect', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { status: 400, error: 'Room has no wallet' }

    const cloudRoomId = getRoomCloudId(roomId)
    const amount = ctx.query.amount ? Number(ctx.query.amount) : undefined
    const result = await getCloudOnrampUrl(cloudRoomId, wallet.address, amount)
    if (!result) return { status: 503, error: 'On-ramp service unavailable' }
    return { redirect: result.onrampUrl }
  })

  router.get('/api/rooms/:roomId/wallet/onramp-url', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { status: 400, error: 'Room has no wallet' }

    const cloudRoomId = getRoomCloudId(roomId)
    const amount = ctx.query.amount ? Number(ctx.query.amount) : undefined
    const result = await getCloudOnrampUrl(cloudRoomId, wallet.address, amount)
    if (!result) return { status: 503, error: 'On-ramp unavailable' }
    return { data: result }
  })
}
