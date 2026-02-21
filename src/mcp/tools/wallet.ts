import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import { createRoomWallet, getWalletAddress, getOnChainBalance, sendToken, getTransactionHistory } from '../../shared/wallet'
import { CHAIN_CONFIGS } from '../../shared/constants'
import { recordPaymentAudit, formatPaymentAuditSuffix } from './payment-audit'
import * as queries from '../../shared/db-queries'
import { getRoomCloudId, ensureCloudRoomToken, getCloudOnrampUrl } from '../../shared/cloud-sync'

export function registerWalletTools(server: McpServer): void {
  server.registerTool(
    'quoroom_wallet_create',
    {
      title: 'Create Wallet',
      description: 'Create an EVM wallet for a room. Works on all supported chains (Base, Ethereum, Arbitrum, Optimism, Polygon). '
        + 'Each room can have one wallet. RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID to create a wallet for'),
        encryptionKey: z.string().min(1).describe('Encryption key to protect the private key. Keep this safe — needed for sending.')
      }
    },
    async ({ roomId, encryptionKey }) => {
      const db = getMcpDatabase()
      try {
        const wallet = createRoomWallet(db, roomId, encryptionKey)
        return {
          content: [{ type: 'text' as const, text: `Wallet created for room ${roomId}: ${wallet.address}` }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_wallet_address',
    {
      title: 'Wallet Address',
      description: 'Get the wallet address for a room. Use this to receive stablecoins (USDC/USDT) on any EVM chain.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      const db = getMcpDatabase()
      try {
        const address = getWalletAddress(db, roomId)
        return { content: [{ type: 'text' as const, text: address }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_wallet_balance',
    {
      title: 'Wallet Balance',
      description: 'Get the on-chain token balance for a room\'s wallet. '
        + 'Supports USDC and USDT on Base, Ethereum, Arbitrum, Optimism, Polygon.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        network: z.enum(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'base-sepolia']).optional()
          .describe('Network (default: base)'),
        token: z.enum(['usdc', 'usdt']).optional().describe('Token (default: usdc)')
      }
    },
    async ({ roomId, network, token }) => {
      const db = getMcpDatabase()
      try {
        const address = getWalletAddress(db, roomId)
        const selectedNetwork = (network ?? 'base') as Parameters<typeof getOnChainBalance>[1]
        const selectedToken = token ?? 'usdc'
        const result = await getOnChainBalance(address, selectedNetwork, selectedToken)
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Balance check failed: ${result.error}` }], isError: true }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ address, balance: result.balance, token: selectedToken, network: result.network }, null, 2)
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_wallet_send',
    {
      title: 'Send Token',
      description: 'Send USDC or USDT from the room\'s wallet to an address. '
        + 'Supports Base, Ethereum, Arbitrum, Optimism, Polygon. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        to: z.string().min(1).describe('Recipient address (0x...)'),
        amount: z.string().min(1).describe('Amount (e.g., "10.50")'),
        encryptionKey: z.string().min(1).describe('Encryption key used when creating the wallet'),
        network: z.enum(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'base-sepolia']).optional()
          .describe('Network (default: base)'),
        token: z.enum(['usdc', 'usdt']).optional().describe('Token to send (default: usdc)')
      }
    },
    async ({ roomId, to, amount, encryptionKey, network, token }) => {
      const db = getMcpDatabase()
      const selectedNetwork = network ?? 'base'
      const selectedToken = token ?? 'usdc'
      try {
        const chainConfig = CHAIN_CONFIGS[selectedNetwork]
        if (!chainConfig) {
          return { content: [{ type: 'text' as const, text: `Unsupported network: ${selectedNetwork}` }], isError: true }
        }
        const tokenConfig = chainConfig.tokens[selectedToken]
        if (!tokenConfig) {
          return { content: [{ type: 'text' as const, text: `Token ${selectedToken} not available on ${selectedNetwork}` }], isError: true }
        }
        const txHash = await sendToken(db, roomId, to, amount, encryptionKey, selectedNetwork, tokenConfig.address, tokenConfig.decimals)
        const audit = recordPaymentAudit(
          db,
          roomId,
          `Wallet payment: sent ${amount} ${selectedToken.toUpperCase()} on ${selectedNetwork} to ${to}, tx: ${txHash}`
        )
        return {
          content: [{
            type: 'text' as const,
            text: `Sent ${amount} ${selectedToken.toUpperCase()} to ${to} on ${selectedNetwork}. TX: ${txHash}${formatPaymentAuditSuffix(audit)}`
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_wallet_history',
    {
      title: 'Wallet History',
      description: 'Get transaction history for a room\'s wallet.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        limit: z.number().int().positive().max(100).optional().describe('Max transactions to return (default: 50)')
      }
    },
    async ({ roomId, limit }) => {
      const db = getMcpDatabase()
      try {
        const transactions = getTransactionHistory(db, roomId, limit ?? 50)
        if (transactions.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No transactions yet.' }] }
        }
        const list = transactions.map(tx => ({
          id: tx.id, type: tx.type, amount: tx.amount,
          counterparty: tx.counterparty, txHash: tx.txHash,
          description: tx.description, status: tx.status, createdAt: tx.createdAt
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_wallet_topup',
    {
      title: 'Wallet Top-Up URL',
      description: 'Get a Coinbase On-Ramp URL for the keeper to top up the room wallet with a credit card. '
        + 'USDC arrives on Base with 0% fees. Share this URL with the keeper via escalation if the room needs funding.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        amount: z.number().positive().optional().describe('Suggested top-up amount in USD')
      }
    },
    async ({ roomId, amount }) => {
      const db = getMcpDatabase()
      try {
        const room = queries.getRoom(db, roomId)
        if (!room) return { content: [{ type: 'text' as const, text: 'Room not found' }], isError: true }
        const address = getWalletAddress(db, roomId)
        const cloudRoomId = getRoomCloudId(roomId)
        await ensureCloudRoomToken({
          roomId: cloudRoomId,
          name: room.name,
          goal: room.goal ?? null,
          visibility: room.visibility,
        })
        const result = await getCloudOnrampUrl(cloudRoomId, address, amount)
        if (!result) {
          return { content: [{ type: 'text' as const, text: 'On-ramp unavailable. The keeper can send USDC/USDT directly to: ' + address }] }
        }
        return { content: [{ type: 'text' as const, text: result.onrampUrl }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )
}
