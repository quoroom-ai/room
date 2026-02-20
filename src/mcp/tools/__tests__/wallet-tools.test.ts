import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'

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

let roomId: number

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  const room = queries.createRoom(db, 'Wallet Test Room', 'make money')
  roomId = room.id

  const { registerWalletTools } = await import('../wallet')
  registerWalletTools(mockServer as never)
})

afterEach(() => {
  db.close()
})

function getResponseText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

describe('quoroom_wallet_create', () => {
  it('creates a wallet for a room', async () => {
    const handler = toolHandlers.get('quoroom_wallet_create')!
    const result = await handler({ roomId, encryptionKey: 'test-key' })
    expect(result.isError).toBeUndefined()
    const text = getResponseText(result)
    expect(text).toContain('Wallet created')
    expect(text).toContain('0x')
  })

  it('returns error for nonexistent room', async () => {
    const handler = toolHandlers.get('quoroom_wallet_create')!
    const result = await handler({ roomId: 9999, encryptionKey: 'test-key' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('not found')
  })

  it('returns error for duplicate wallet', async () => {
    const handler = toolHandlers.get('quoroom_wallet_create')!
    await handler({ roomId, encryptionKey: 'test-key' })
    const result = await handler({ roomId, encryptionKey: 'test-key' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('already has a wallet')
  })
})

describe('quoroom_wallet_address', () => {
  it('returns wallet address', async () => {
    const createHandler = toolHandlers.get('quoroom_wallet_create')!
    await createHandler({ roomId, encryptionKey: 'test-key' })

    const handler = toolHandlers.get('quoroom_wallet_address')!
    const result = await handler({ roomId })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('returns error for room without wallet', async () => {
    const handler = toolHandlers.get('quoroom_wallet_address')!
    const result = await handler({ roomId })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_wallet_history', () => {
  it('returns empty for no transactions', async () => {
    const createHandler = toolHandlers.get('quoroom_wallet_create')!
    await createHandler({ roomId, encryptionKey: 'test-key' })

    const handler = toolHandlers.get('quoroom_wallet_history')!
    const result = await handler({ roomId })
    expect(getResponseText(result)).toBe('No transactions yet.')
  })

  it('returns transaction list', async () => {
    const createHandler = toolHandlers.get('quoroom_wallet_create')!
    await createHandler({ roomId, encryptionKey: 'test-key' })

    // Add a transaction directly
    const wallet = queries.getWalletByRoom(db, roomId)!
    queries.logWalletTransaction(db, wallet.id, 'fund', '100.00', { description: 'Keeper deposit' })

    const handler = toolHandlers.get('quoroom_wallet_history')!
    const result = await handler({ roomId })
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.length).toBe(1)
    expect(parsed[0].type).toBe('fund')
    expect(parsed[0].amount).toBe('100.00')
  })
})

describe('tool registration', () => {
  it('registers all 5 wallet tools', () => {
    expect(toolHandlers.has('quoroom_wallet_create')).toBe(true)
    expect(toolHandlers.has('quoroom_wallet_address')).toBe(true)
    expect(toolHandlers.has('quoroom_wallet_balance')).toBe(true)
    expect(toolHandlers.has('quoroom_wallet_send')).toBe(true)
    expect(toolHandlers.has('quoroom_wallet_history')).toBe(true)
  })
})
