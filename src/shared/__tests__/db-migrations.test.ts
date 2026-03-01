import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../db-migrations'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, () => {})
})

afterEach(() => {
  db.close()
})

describe('runMigrations', () => {
  it('upgrades only legacy queen_max_turns fallback values', () => {
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('legacy', 3)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('default30', 30)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('custom70', 70)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const rows = db.prepare('SELECT name, queen_max_turns AS queenMaxTurns FROM rooms').all() as Array<{
      name: string
      queenMaxTurns: number
    }>
    const byName = new Map(rows.map((row) => [row.name, row.queenMaxTurns]))

    expect(byName.get('legacy')).toBe(50)
    expect(byName.get('default30')).toBe(30)
    expect(byName.get('custom70')).toBe(70)
    expect(logs).toContain('Migrated: updated 1 room(s) queen_max_turns from 3 to 50')
  })

  it('does not log legacy queen_max_turns migration when no rooms need update', () => {
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('already50', 50)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('explicit30', 30)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    expect(logs.some((msg) => msg.includes('queen_max_turns from 3 to 50'))).toBe(false)
  })
})
