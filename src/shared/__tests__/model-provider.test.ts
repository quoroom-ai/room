import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as q from '../db-queries'
import { getModelAuthStatus, getModelProvider, resolveApiKeyForModel } from '../model-provider'

let db: Database.Database
let roomId: number

describe('model-provider', () => {
  beforeEach(() => {
    db = initTestDb()
    const room = q.createRoom(db, 'Provider Test Room')
    roomId = room.id
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
  })

  it('detects provider type from model string', () => {
    expect(getModelProvider('claude')).toBe('claude_subscription')
    expect(getModelProvider('codex')).toBe('codex_subscription')
    expect(getModelProvider('openai:gpt-4o-mini')).toBe('openai_api')
    expect(getModelProvider('anthropic:claude-3-5-sonnet-latest')).toBe('anthropic_api')
    expect(getModelProvider('claude-api:claude-3-5-sonnet-latest')).toBe('anthropic_api')
  })

  it('returns api auth readiness from room credentials', async () => {
    q.createCredential(db, roomId, 'openai_api_key', 'api_key', 'sk-room')
    const status = await getModelAuthStatus(db, roomId, 'openai:gpt-4o-mini')
    expect(status.mode).toBe('api')
    expect(status.hasCredential).toBe(true)
    expect(status.ready).toBe(true)
    expect(resolveApiKeyForModel(db, roomId, 'openai:gpt-4o-mini')).toBe('sk-room')
  })

  it('falls back to env key when room credential is missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'ak-env'
    const status = await getModelAuthStatus(db, roomId, 'anthropic:claude-3-5-sonnet-latest')
    expect(status.hasCredential).toBe(false)
    expect(status.hasEnvKey).toBe(true)
    expect(status.ready).toBe(true)
    expect(resolveApiKeyForModel(db, roomId, 'anthropic:claude-3-5-sonnet-latest')).toBe('ak-env')
  })

  it('prefers room credential over env key', () => {
    process.env.OPENAI_API_KEY = 'sk-env'
    q.createCredential(db, roomId, 'openai_api_key', 'api_key', 'sk-room')

    expect(resolveApiKeyForModel(db, roomId, 'openai:gpt-4o-mini')).toBe('sk-room')
  })

  it('codex_subscription returns subscription mode with ready based on CLI availability', async () => {
    const status = await getModelAuthStatus(db, roomId, 'codex')
    expect(status.provider).toBe('codex_subscription')
    expect(status.mode).toBe('subscription')
    expect(status.credentialName).toBeNull()
    expect(status.envVar).toBeNull()
    // ready depends on whether codex CLI is installed — the checkCodexCliAvailable
    // function uses codex.cmd on Windows and codex on Unix, which may or may not
    // be installed in the test environment. Just verify it returns a boolean.
    expect(typeof status.ready).toBe('boolean')
  })

  it('claude_subscription returns subscription mode', async () => {
    const status = await getModelAuthStatus(db, roomId, 'claude')
    expect(status.provider).toBe('claude_subscription')
    expect(status.mode).toBe('subscription')
    expect(typeof status.ready).toBe('boolean')
  })
})
