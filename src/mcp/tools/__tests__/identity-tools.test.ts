import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'
import { createRoomWallet } from '../../../shared/wallet'

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const toolHandlers = new Map<string, ToolHandler>()

const mockServer = {
  registerTool: (_name: string, _opts: unknown, handler: ToolHandler) => {
    toolHandlers.set(_name, handler)
  }
}

let db: Database.Database
vi.mock('../../db', () => ({
  getMcpDatabase: () => db
}))

// Mock the on-chain functions from identity.ts
vi.mock('../../../shared/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/identity')>()
  return {
    ...actual,
    registerRoomIdentity: vi.fn().mockResolvedValue({ agentId: '42', txHash: '0xabc123' }),
    getRoomIdentity: vi.fn().mockImplementation(async (_db, roomId) => {
      const wallet = queries.getWalletByRoom(_db, roomId)
      if (!wallet || !wallet.erc8004AgentId) return null
      return {
        agentId: wallet.erc8004AgentId,
        address: wallet.address,
        network: 'base-sepolia',
        registry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e',
        agentURI: 'data:application/json;base64,eyJ0eXBlIjoidGVzdCJ9'
      }
    }),
    updateRoomIdentityURI: vi.fn().mockResolvedValue('0xdef456')
  }
})

let roomId: number

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  const room = queries.createRoom(db, 'Identity Test Room', 'test')
  roomId = room.id

  const { registerIdentityTools } = await import('../identity')
  registerIdentityTools(mockServer as never)
})

afterEach(() => {
  db.close()
})

function getResponseText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

describe('tool registration', () => {
  it('registers all 3 identity tools', () => {
    expect(toolHandlers.has('quoroom_identity_register')).toBe(true)
    expect(toolHandlers.has('quoroom_identity_get')).toBe(true)
    expect(toolHandlers.has('quoroom_identity_update')).toBe(true)
  })
})

describe('quoroom_identity_register', () => {
  it('registers identity for a room with wallet', async () => {
    createRoomWallet(db, roomId, 'test-key')
    const handler = toolHandlers.get('quoroom_identity_register')!
    const result = await handler({ roomId, encryptionKey: 'test-key' })
    expect(result.isError).toBeUndefined()
    const text = getResponseText(result)
    expect(text).toContain('Identity registered')
    expect(text).toContain('agentId 42')
  })
})

describe('quoroom_identity_get', () => {
  it('returns null-ish for room without identity', async () => {
    createRoomWallet(db, roomId, 'test-key')
    const handler = toolHandlers.get('quoroom_identity_get')!
    const result = await handler({ roomId })
    expect(getResponseText(result)).toContain('No on-chain identity')
  })

  it('returns identity details after registration', async () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.updateWalletAgentId(db, wallet.id, '42')

    const handler = toolHandlers.get('quoroom_identity_get')!
    const result = await handler({ roomId })
    const identity = JSON.parse(getResponseText(result))
    expect(identity.agentId).toBe('42')
    expect(identity.registry).toContain('eip155:')
  })
})

describe('quoroom_identity_update', () => {
  it('updates identity URI', async () => {
    createRoomWallet(db, roomId, 'test-key')
    const handler = toolHandlers.get('quoroom_identity_update')!
    const result = await handler({ roomId, encryptionKey: 'test-key' })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('metadata updated')
  })
})
