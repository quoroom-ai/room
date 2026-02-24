import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import { insertClerkMessageAndEmit } from '../clerk-message-events'
import { eventBus, type WsEvent } from '../event-bus'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
  eventBus.clear()
})

afterEach(() => {
  eventBus.clear()
  db.close()
})

describe('insertClerkMessageAndEmit', () => {
  it('writes clerk message and emits clerk:message event with payload', () => {
    const events: WsEvent[] = []
    const unsub = eventBus.on('clerk', (event) => events.push(event))

    const inserted = insertClerkMessageAndEmit(db, 'assistant', 'Live relay ready', 'task')
    unsub()

    const log = queries.listClerkMessages(db)
    expect(log).toHaveLength(1)
    expect(log[0].id).toBe(inserted.id)
    expect(log[0].content).toBe('Live relay ready')
    expect(log[0].source).toBe('task')

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('clerk:message')
    expect(events[0].channel).toBe('clerk')

    const payload = events[0].data as { message?: ReturnType<typeof queries.insertClerkMessage> }
    expect(payload.message?.id).toBe(inserted.id)
    expect(payload.message?.role).toBe('assistant')
    expect(payload.message?.source).toBe('task')
  })
})
