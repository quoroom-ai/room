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

  it('preserves existing ollama models in workers and room defaults', () => {
    db.prepare('INSERT INTO rooms (name, worker_model) VALUES (?, ?)').run('ollamaroom', 'ollama:qwen3-coder:30b')
    const room = db.prepare('SELECT id FROM rooms WHERE name = ?').get('ollamaroom') as { id: number }
    db.prepare('INSERT INTO workers (name, system_prompt, room_id, model) VALUES (?, ?, ?, ?)')
      .run('ollama worker', 'prompt', room.id, 'ollama:qwen3-coder:30b')

    runMigrations(db, () => {})

    const roomModel = db.prepare('SELECT worker_model AS workerModel FROM rooms WHERE id = ?').get(room.id) as {
      workerModel: string
    }
    const workerModel = db.prepare('SELECT model FROM workers WHERE room_id = ?').get(room.id) as {
      model: string
    }

    expect(roomModel.workerModel).toBe('ollama:qwen3-coder:30b')
    expect(workerModel.model).toBe('ollama:qwen3-coder:30b')
  })
})
