import crypto from 'node:crypto'
import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { createPublicClient, http, type Chain } from 'viem'
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains'
import { getOnChainBalance, sendToken, type NetworkName } from '../../shared/wallet'
import { SUPPORTED_CHAINS, SUPPORTED_TOKENS, CHAIN_CONFIGS } from '../../shared/constants'
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
    let anySuccess = false
    for (const { chain, token, result } of results) {
      if (!byChain[chain]) byChain[chain] = { usdc: 0, usdt: 0, total: 0 }
      if (result.ok) {
        anySuccess = true
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
    // Only cache if at least one RPC call succeeded; otherwise stale cache is better
    if (anySuccess) {
      balanceCache.set(roomId, { data, fetchedAt: Date.now() })
    }
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
      // If all RPCs timed out (totalBalance=0, no chains succeeded) and we have stale cache, prefer stale
      if (data.totalBalance === 0 && Object.keys(data.byChain).length === 0 && cached && cached.data.totalBalance > 0) {
        return { data: { ...cached.data, fetchedAt: new Date().toISOString() } }
      }
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

  router.post('/api/rooms/:roomId/wallet/withdraw', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    const wallet = queries.getWalletByRoom(ctx.db, roomId)
    if (!wallet) return { status: 400, error: 'Room has no wallet' }

    const { to: rawTo, amount: rawAmount, chain, token } = ctx.body as {
      to: string; amount: string; chain?: string; token?: string
    }
    const to = rawTo?.trim()
    const amount = rawAmount?.trim()
    if (!to || !amount) return { status: 400, error: 'Missing required fields: to, amount' }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { status: 400, error: 'Invalid address' }
    const parsed = parseFloat(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) return { status: 400, error: 'Invalid amount' }

    const selectedChain = (chain ?? 'base') as NetworkName
    const selectedToken = token ?? 'usdc'

    const chainConfig = CHAIN_CONFIGS[selectedChain]
    if (!chainConfig) return { status: 400, error: `Unsupported chain: ${selectedChain}` }
    const tokenConfig = chainConfig.tokens[selectedToken]
    if (!tokenConfig) return { status: 400, error: `Token ${selectedToken} not available on ${selectedChain}` }

    const encryptionKey = crypto.createHash('sha256')
      .update(`quoroom-wallet-${room.id}-${room.name}`)
      .digest('hex')

    // Approximate gas needed per chain (ERC-20 transfer ≈ 65k gas)
    const GAS_TIPS: Record<string, { token: string; amount: string }> = {
      base:     { token: 'ETH', amount: '0.0001 ETH (~$0.25)' },
      arbitrum: { token: 'ETH', amount: '0.0001 ETH (~$0.25)' },
      optimism: { token: 'ETH', amount: '0.0001 ETH (~$0.25)' },
      ethereum: { token: 'ETH', amount: '0.002 ETH (~$5)' },
      polygon:  { token: 'POL', amount: '0.1 POL (~$0.05)' },
    }
    const gasTip = GAS_TIPS[selectedChain] ?? { token: 'ETH', amount: '0.001 ETH' }

    // Check native gas balance before attempting transfer
    const VIEM_CHAINS: Record<string, Chain> = {
      base, ethereum: mainnet, arbitrum, optimism, polygon,
    }
    try {
      const viemChain = VIEM_CHAINS[selectedChain]
      if (viemChain) {
        const publicClient = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) })
        const gasBalance = await publicClient.getBalance({ address: wallet.address as `0x${string}` })
        if (gasBalance === 0n) {
          return { status: 400, error: `No ${gasTip.token} for gas fees. Send at least ${gasTip.amount} to ${wallet.address} on ${chainConfig.name} to cover the transaction.` }
        }
      }
    } catch {
      // Non-fatal — proceed with the transfer attempt
    }

    try {
      const txHash = await sendToken(
        ctx.db, roomId, to,
        amount, encryptionKey,
        selectedChain, tokenConfig.address, tokenConfig.decimals
      )
      // Invalidate balance cache after withdrawal
      balanceCache.delete(roomId)
      return { data: { txHash } }
    } catch (e) {
      const msg = (e as Error).message || 'Unknown error'
      // Provide friendlier message for common gas errors
      if (msg.includes('gas') || msg.includes('insufficient funds')) {
        return { status: 400, error: `Insufficient ${gasTip.token} for gas fees on ${chainConfig.name}. Send at least ${gasTip.amount} to your wallet address to cover the transaction.` }
      }
      return { status: 400, error: `Withdraw failed: ${msg.split('\n')[0]}` }
    }
  })
}
