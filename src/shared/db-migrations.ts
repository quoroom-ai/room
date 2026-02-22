import type Database from 'better-sqlite3'
import { SCHEMA } from './schema'

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)

  // Add invite_code column to rooms (for existing databases)
  const cols = database.pragma('table_info(rooms)') as Array<{ name: string }>
  if (!cols.some(c => c.name === 'invite_code')) {
    database.exec('ALTER TABLE rooms ADD COLUMN invite_code TEXT')
  }

  log('Database schema initialized')
}
