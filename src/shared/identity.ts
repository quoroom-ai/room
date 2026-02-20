/**
 * ERC-8004 On-Chain Identity
 *
 * Registers rooms as on-chain agents via the ERC-8004 Identity Registry on Base.
 * Each room's wallet mints an ERC-721 identity NFT pointing to a metadata URI
 * that describes the room (name, description, workers, services).
 */

import type Database from 'better-sqlite3'
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import * as queries from './db-queries'
import { decryptPrivateKey } from './wallet'
import { ERC8004_IDENTITY_REGISTRY, BASE_CHAIN_CONFIG, BASE_SEPOLIA_CONFIG } from './constants'

// ─── Identity Registry ABI (minimal) ────────────────────────

const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [{ name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' }
    ],
    name: 'setAgentURI',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'agentId', type: 'uint256' },
      { indexed: false, name: 'agentURI', type: 'string' },
      { indexed: true, name: 'owner', type: 'address' }
    ],
    name: 'Registered',
    type: 'event'
  }
] as const

// ─── Chain Helpers ──────────────────────────────────────────

type NetworkName = 'base' | 'base-sepolia'

const CHAINS = {
  base: { chain: base, config: BASE_CHAIN_CONFIG },
  'base-sepolia': { chain: baseSepolia, config: BASE_SEPOLIA_CONFIG }
} as const

function getRegistryAddress(network: NetworkName): Address {
  return ERC8004_IDENTITY_REGISTRY[network] as Address
}

// ─── Registration URI ───────────────────────────────────────

/**
 * Build a data: URI containing the ERC-8004 registration JSON for a room.
 * Describes the room as an agent collective (queen + workers).
 */
export function buildRegistrationURI(db: Database.Database, roomId: number): string {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  const workers = queries.listRoomWorkers(db, roomId)
  const queen = room.queenWorkerId ? queries.getWorker(db, room.queenWorkerId) : null

  const registration = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: room.name,
    description: room.goal ?? `Quoroom room: ${room.name}`,
    services: [] as Array<{ name: string; endpoint: string }>,
    active: room.status === 'active',
    supportedTrust: ['reputation'],
    // Quoroom-specific metadata
    'x-quoroom': {
      architecture: 'collective',
      queen: queen ? queen.name : null,
      workerCount: workers.length,
      visibility: room.visibility,
      threshold: room.config.threshold
    }
  }

  const json = JSON.stringify(registration)
  return `data:application/json;base64,${Buffer.from(json).toString('base64')}`
}

// ─── Register ───────────────────────────────────────────────

export interface IdentityRegistrationResult {
  agentId: string
  txHash: string
}

/**
 * Register a room's wallet as an ERC-8004 on-chain identity.
 * Mints an ERC-721 NFT on the Identity Registry.
 */
export async function registerRoomIdentity(
  db: Database.Database,
  roomId: number,
  encryptionKey: string,
  network: NetworkName = 'base'
): Promise<IdentityRegistrationResult> {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet) throw new Error(`Room ${roomId} has no wallet`)
  if (wallet.erc8004AgentId) throw new Error(`Room ${roomId} already has an on-chain identity (agentId: ${wallet.erc8004AgentId})`)

  const chainInfo = CHAINS[network]
  const registryAddress = getRegistryAddress(network)

  // Build registration metadata
  const agentURI = buildRegistrationURI(db, roomId)

  // Decrypt wallet key
  const privateKey = decryptPrivateKey(wallet.privateKeyEncrypted, encryptionKey)
  const account = privateKeyToAccount(privateKey as `0x${string}`)

  const publicClient = createPublicClient({
    chain: chainInfo.chain,
    transport: http(chainInfo.config.rpcUrl)
  })

  const walletClient = createWalletClient({
    account,
    chain: chainInfo.chain,
    transport: http(chainInfo.config.rpcUrl)
  })

  // Simulate then execute
  const { request } = await publicClient.simulateContract({
    address: registryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI],
    account
  })

  const txHash = await walletClient.writeContract(request)

  // Wait for confirmation and extract agentId from Registered event
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  const logs = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: 'Registered',
    logs: receipt.logs
  })

  if (logs.length === 0) {
    throw new Error('Registration transaction succeeded but no Registered event found')
  }

  const agentId = logs[0].args.agentId.toString()

  // Store in DB
  queries.updateWalletAgentId(db, wallet.id, agentId)

  // Log activity
  queries.logRoomActivity(db, roomId, 'system',
    `ERC-8004 identity registered: agentId ${agentId}`,
    JSON.stringify({ agentId, txHash, network, registry: registryAddress }))

  return { agentId, txHash }
}

// ─── Query ──────────────────────────────────────────────────

export interface RoomIdentity {
  agentId: string
  address: string
  network: string
  registry: string
  agentURI: string | null
}

/**
 * Get a room's on-chain identity. Returns null if not registered.
 */
export async function getRoomIdentity(
  db: Database.Database,
  roomId: number,
  network: NetworkName = 'base'
): Promise<RoomIdentity | null> {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet || !wallet.erc8004AgentId) return null

  const chainInfo = CHAINS[network]
  const registryAddress = getRegistryAddress(network)

  let agentURI: string | null = null
  try {
    const client = createPublicClient({
      chain: chainInfo.chain,
      transport: http(chainInfo.config.rpcUrl)
    })
    agentURI = await client.readContract({
      address: registryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'tokenURI',
      args: [BigInt(wallet.erc8004AgentId)]
    })
  } catch {
    // On-chain read failed — return DB-only data
  }

  return {
    agentId: wallet.erc8004AgentId,
    address: wallet.address,
    network,
    registry: `eip155:${chainInfo.config.chainId}:${registryAddress}`,
    agentURI
  }
}

// ─── Update URI ─────────────────────────────────────────────

/**
 * Update the on-chain registration URI to reflect current room state.
 */
export async function updateRoomIdentityURI(
  db: Database.Database,
  roomId: number,
  encryptionKey: string,
  network: NetworkName = 'base'
): Promise<string> {
  const wallet = queries.getWalletByRoom(db, roomId)
  if (!wallet) throw new Error(`Room ${roomId} has no wallet`)
  if (!wallet.erc8004AgentId) throw new Error(`Room ${roomId} has no on-chain identity`)

  const chainInfo = CHAINS[network]
  const registryAddress = getRegistryAddress(network)

  // Rebuild URI from current room state
  const agentURI = buildRegistrationURI(db, roomId)

  // Decrypt wallet key
  const privateKey = decryptPrivateKey(wallet.privateKeyEncrypted, encryptionKey)
  const account = privateKeyToAccount(privateKey as `0x${string}`)

  const walletClient = createWalletClient({
    account,
    chain: chainInfo.chain,
    transport: http(chainInfo.config.rpcUrl)
  })

  const txHash = await walletClient.writeContract({
    address: registryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentURI',
    args: [BigInt(wallet.erc8004AgentId), agentURI]
  })

  queries.logRoomActivity(db, roomId, 'system',
    `ERC-8004 identity URI updated`,
    JSON.stringify({ agentId: wallet.erc8004AgentId, txHash, network }))

  return txHash
}
