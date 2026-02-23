import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { SCHEMA } from './schema'
import { pickQueenNickname } from './db-queries'

function upsertSetting(database: Database.Database, key: string, value: string): void {
  database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value)
}

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)

  // Migrate: drop old ollama_sessions table (replaced by unified agent_sessions)
  const hasOllamaSessions = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='ollama_sessions'`
  ).get() as { name: string } | undefined)?.name
  if (hasOllamaSessions) {
    database.exec('DROP TABLE IF EXISTS ollama_sessions')
    log('Migrated: dropped ollama_sessions (replaced by agent_sessions)')
  }

  // Keeper-level referral code (global, one per keeper)
  if (!database.prepare('SELECT value FROM settings WHERE key = ?').get('keeper_referral_code')) {
    const code = randomBytes(6).toString('base64url').slice(0, 10)
    upsertSetting(database, 'keeper_referral_code', code)
  }

  // Keeper user number (stable 5-digit ID, same across all rooms, used in queen email addresses)
  if (!database.prepare('SELECT value FROM settings WHERE key = ?').get('keeper_user_number')) {
    const num = String(10000 + Math.floor(Math.random() * 90000))
    upsertSetting(database, 'keeper_user_number', num)
    log(`Migrated: assigned keeper_user_number=${num}`)
  }

  // Add queen_nickname column to rooms if missing
  const hasQueenNickname = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='queen_nickname'`
  ).get() as { name: string } | undefined)?.name
  if (!hasQueenNickname) {
    database.exec(`ALTER TABLE rooms ADD COLUMN queen_nickname TEXT`)
    log('Migrated: added queen_nickname column to rooms')
  }

  // Auto-populate queen_nickname for existing rooms that don't have one
  const roomsWithoutNickname = database
    .prepare(`SELECT id FROM rooms WHERE queen_nickname IS NULL OR queen_nickname = ''`)
    .all() as { id: number }[]
  if (roomsWithoutNickname.length > 0) {
    for (const room of roomsWithoutNickname) {
      const nickname = pickQueenNickname(database)
      database.prepare(`UPDATE rooms SET queen_nickname = ? WHERE id = ?`).run(nickname, room.id)
    }
    log(`Migrated: assigned queen nicknames to ${roomsWithoutNickname.length} room(s)`)
  }

  log('Database schema initialized')
}
