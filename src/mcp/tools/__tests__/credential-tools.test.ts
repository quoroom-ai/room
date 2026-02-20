import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'
import { createToolHarness } from './helpers/tool-harness'

const { toolHandlers, mockServer, getResponseText } = createToolHarness()

let db: Database.Database
vi.mock('../../db', () => ({
  getMcpDatabase: () => db
}))

let roomId: number

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  const room = queries.createRoom(db, 'Credential Test Room', 'test credentials')
  roomId = room.id

  const { registerCredentialTools } = await import('../credentials')
  registerCredentialTools(mockServer as never)
})

afterEach(() => {
  db.close()
})

describe('tool registration', () => {
  it('registers both credential tools', () => {
    expect(toolHandlers.has('quoroom_credentials_list')).toBe(true)
    expect(toolHandlers.has('quoroom_credentials_get')).toBe(true)
  })
})

describe('quoroom_credentials_list', () => {
  it('returns no credentials message when empty', async () => {
    const handler = toolHandlers.get('quoroom_credentials_list')!
    const result = await handler({ roomId })
    expect(getResponseText(result)).toContain('No credentials')
  })

  it('lists credentials without exposing values', async () => {
    queries.createCredential(db, roomId, 'OpenAI Key', 'api_key', 'sk-test-123')
    queries.createCredential(db, roomId, 'GitHub Token', 'api_key', 'ghp-abc')

    const handler = toolHandlers.get('quoroom_credentials_list')!
    const result = await handler({ roomId })
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].name).toBeDefined()
    expect(parsed[0].type).toBeDefined()
    expect(getResponseText(result)).not.toContain('sk-test-123')
    expect(getResponseText(result)).not.toContain('ghp-abc')
  })
})

describe('quoroom_credentials_get', () => {
  it('returns credential with unmasked value', async () => {
    queries.createCredential(db, roomId, 'OpenAI Key', 'api_key', 'sk-test-secret-123')

    const handler = toolHandlers.get('quoroom_credentials_get')!
    const result = await handler({ roomId, name: 'OpenAI Key' })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.name).toBe('OpenAI Key')
    expect(parsed.type).toBe('api_key')
    expect(parsed.value).toBe('sk-test-secret-123')
  })

  it('returns error for non-existent credential', async () => {
    const handler = toolHandlers.get('quoroom_credentials_get')!
    const result = await handler({ roomId, name: 'Does Not Exist' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('not found')
  })
})
