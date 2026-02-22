import type Database from 'better-sqlite3'
import { SCHEMA } from './schema'

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)

  // Add invite_code column to rooms (for existing databases)
  const cols = database.pragma('table_info(rooms)') as Array<{ name: string }>
  if (!cols.some(c => c.name === 'invite_code')) {
    database.exec('ALTER TABLE rooms ADD COLUMN invite_code TEXT')
  }

  // Add quorum hardening columns to quorum_decisions (for existing databases)
  const decCols = database.pragma('table_info(quorum_decisions)') as Array<{ name: string }>
  if (!decCols.some(c => c.name === 'min_voters')) {
    database.exec('ALTER TABLE quorum_decisions ADD COLUMN min_voters INTEGER NOT NULL DEFAULT 0')
  }
  if (!decCols.some(c => c.name === 'sealed')) {
    database.exec('ALTER TABLE quorum_decisions ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0')
  }

  // Add voter health columns to workers (for existing databases)
  const workerCols = database.pragma('table_info(workers)') as Array<{ name: string }>
  if (!workerCols.some(c => c.name === 'votes_cast')) {
    database.exec('ALTER TABLE workers ADD COLUMN votes_cast INTEGER NOT NULL DEFAULT 0')
  }
  if (!workerCols.some(c => c.name === 'votes_missed')) {
    database.exec('ALTER TABLE workers ADD COLUMN votes_missed INTEGER NOT NULL DEFAULT 0')
  }

  log('Database schema initialized')
}
