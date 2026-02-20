import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import { createRoomWallet, getWalletAddress, getOnChainBalance, sendUSDC, getTransactionHistory } from '../../shared/wallet'

export function registerWalletTools(server: McpServer): void {
  server.registerTool(
    'quoroom_wallet_create',
    {
      title: 'Create Wallet',
      description: 'Create an EVM wallet (USDC on Base L2) for a room. Each room can have one wallet. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
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
      description: 'Get the wallet address for a room. Use this to receive USDC.',
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
      description: 'Get the on-chain USDC balance for a room\'s wallet on Base L2.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, network }) => {
      const db = getMcpDatabase()
      try {
        const address = getWalletAddress(db, roomId)
        const result = await getOnChainBalance(address, network as 'base' | 'base-sepolia' | undefined)
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Balance check failed: ${result.error}` }], isError: true }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ address, balance: result.balance, network: result.network }, null, 2)
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
      title: 'Send USDC',
      description: 'Send USDC from the room\'s wallet to an address on Base L2. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        to: z.string().min(1).describe('Recipient address (0x...)'),
        amount: z.string().min(1).describe('Amount in USDC (e.g., "10.50")'),
        encryptionKey: z.string().min(1).describe('Encryption key used when creating the wallet'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, to, amount, encryptionKey, network }) => {
      const db = getMcpDatabase()
      try {
        const txHash = await sendUSDC(db, roomId, to, amount, encryptionKey, network as 'base' | 'base-sepolia' | undefined)
        return {
          content: [{ type: 'text' as const, text: `Sent ${amount} USDC to ${to}. TX: ${txHash}` }]
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
}
