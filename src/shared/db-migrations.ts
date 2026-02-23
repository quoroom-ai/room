import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { SCHEMA } from './schema'

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)

  // Keeper-level referral code (global, one per keeper)
  if (!database.prepare('SELECT value FROM settings WHERE key = ?').get('keeper_referral_code')) {
    const code = randomBytes(6).toString('base64url').slice(0, 10)
    database.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run('keeper_referral_code', code)
  }

  log('Database schema initialized')
}
