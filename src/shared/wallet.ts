/**
 * Wallet Engine
 *
 * EVM wallet management for rooms — key generation, encryption, USDC operations.
 * Adapted from Automaton's identity/wallet.ts + conway/x402.ts
 */

import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, type Address, type Chain } from 'viem'
import { base, baseSepolia, mainnet, arbitrum, optimism, polygon } from 'viem/chains'
import type { Wallet, WalletTransaction } from './types'
import * as queries from './db-queries'
import { CHAIN_CONFIGS } from './constants'

// ─── USDC ABI (minimal — balanceOf + transfer) ─────────────

const USDC_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

// ─── Chain Config ───────────────────────────────────────────

const VIEM_CHAINS: Record<string, Chain> = {
  base, ethereum: mainnet, arbitrum, optimism, polygon, 'base-sepolia': baseSepolia
}

export type NetworkName = 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | 'base-sepolia'

// ─── Encryption (AES-256-GCM) ──────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

/**
 * Encrypt a private key with AES-256-GCM.
 * encryptionKey must be 32 bytes (256 bits). If a string is provided, it's hashed with SHA-256.
 */
export function encryptPrivateKey(privateKey: string, encryptionKey: string | Buffer): string {
  const key = typeof encryptionKey === 'string'
    ? crypto.createHash('sha256').update(encryptionKey).digest()
    : encryptionKey
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt a private key encrypted with encryptPrivateKey.
 */
export function decryptPrivateKey(encrypted: string, encryptionKey: string | Buffer): string {
  const key = typeof encryptionKey === 'string'
    ? crypto.createHash('sha256').update(encryptionKey).digest()
    : encryptionKey
  const parts = encrypted.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted key format')
  const iv = Buffer.from(parts[0], 'hex')
  const tag = Buffer.from(parts[1], 'hex')
  const ciphertext = Buffer.from(parts[2], 'hex')
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// ─── Wallet Lifecycle ───────────────────────────────────────

/**
 * Create a new EVM wallet for a room.
 * Generates a random private key, encrypts it, and stores in the wallets table.
 */
export function createRoomWallet(db: Database.Database, roomId: number, encryptionKey: string): Wallet {
  // Check room exists
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  // Check no wallet exists for this room
  const existing = queries.getWalletByRoom(db, roomId)
  if (existing) throw new Error(`Room ${roomId} already has a wallet`)

  // Generate key pair (adapted from Automaton's wallet.ts)
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  // Encrypt and store
  const encrypted = encryptPrivateKey(privateKey, encryptionKey)
  const wallet = queries.createWallet(db, roomId, account.address, encrypted)

  // Log activity
  queries.logRoomActivity(db, roomId, 'financial',
    `Wallet created: ${account.address}`,
    JSON.stringify({ address: account.address, chain: 'base' }))

  return wallet
}

/**
 * Get the wallet address for a room (no decryption needed).
 */
export function getWalletAddress(db: Database.Database, roomId: number): string {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet) throw new Error(`Room ${roomId} has no wallet`)
  return wallet.address
}

// ─── USDC Operations ────────────────────────────────────────

export interface UsdcBalanceResult {
  balance: number
  balanceRaw: string
  network: string
  ok: boolean
  error?: string
}

/**
 * Get on-chain token balance for an address.
 * Supports any chain/token in CHAIN_CONFIGS.
 */
export async function getOnChainBalance(
  address: string,
  network: NetworkName = 'base',
  token: string = 'usdc'
): Promise<UsdcBalanceResult> {
  const chainConfig = CHAIN_CONFIGS[network]
  const viemChain = VIEM_CHAINS[network]
  if (!chainConfig || !viemChain) {
    return { balance: 0, balanceRaw: '0', network, ok: false, error: `Unsupported network: ${network}` }
  }

  const tokenConfig = chainConfig.tokens[token]
  if (!tokenConfig) {
    return { balance: 0, balanceRaw: '0', network, ok: false, error: `Token ${token} not available on ${network}` }
  }

  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(chainConfig.rpcUrl)
    })

    const balance = await client.readContract({
      address: tokenConfig.address as Address,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [address as Address]
    })

    return {
      balance: Number(balance) / 10 ** tokenConfig.decimals,
      balanceRaw: balance.toString(),
      network,
      ok: true
    }
  } catch (err: unknown) {
    return {
      balance: 0,
      balanceRaw: '0',
      network,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Send an ERC-20 token from room wallet to an address on any supported chain.
 */
export async function sendToken(
  db: Database.Database,
  roomId: number,
  to: string,
  amount: string,
  encryptionKey: string,
  network: NetworkName = 'base',
  tokenAddress: string,
  decimals: number
): Promise<string> {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet) throw new Error(`Room ${roomId} has no wallet`)

  const chainConfig = CHAIN_CONFIGS[network]
  const viemChain = VIEM_CHAINS[network]
  if (!chainConfig || !viemChain) throw new Error(`Unsupported network: ${network}`)

  // Decrypt private key
  const privateKey = decryptPrivateKey(wallet.privateKeyEncrypted, encryptionKey)
  const account = privateKeyToAccount(privateKey as `0x${string}`)

  // Create wallet client
  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(chainConfig.rpcUrl)
  })

  // Convert amount to smallest unit
  const amountRaw = BigInt(Math.round(parseFloat(amount) * 10 ** decimals))

  // Send ERC-20 transfer
  const txHash = await walletClient.writeContract({
    address: tokenAddress as Address,
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [to as Address, amountRaw]
  })

  // Log transaction
  queries.logWalletTransaction(db, wallet.id, 'send', amount, {
    counterparty: to,
    txHash,
    description: `Send ${amount} tokens to ${to}`
  })

  // Log room activity
  queries.logRoomActivity(db, roomId, 'financial',
    `Sent ${amount} tokens to ${to.slice(0, 8)}...${to.slice(-4)}`,
    JSON.stringify({ to, amount, txHash, network, tokenAddress }))

  return txHash
}

/**
 * Send USDC from room wallet to an address.
 * Convenience wrapper around sendToken for backward compatibility.
 */
export async function sendUSDC(
  db: Database.Database,
  roomId: number,
  to: string,
  amount: string,
  encryptionKey: string,
  network: NetworkName = 'base'
): Promise<string> {
  const chainConfig = CHAIN_CONFIGS[network]
  if (!chainConfig) throw new Error(`Unsupported network: ${network}`)
  const usdc = chainConfig.tokens.usdc
  if (!usdc) throw new Error(`USDC not available on ${network}`)
  return sendToken(db, roomId, to, amount, encryptionKey, network, usdc.address, usdc.decimals)
}

/**
 * Get transaction history for a room's wallet.
 */
export function getTransactionHistory(db: Database.Database, roomId: number, limit: number = 50): WalletTransaction[] {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet) throw new Error(`Room ${roomId} has no wallet`)
  return queries.listWalletTransactions(db, wallet.id, limit)
}
