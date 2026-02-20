/**
 * Database initialization for the HTTP server.
 * Same pattern as src/mcp/db.ts — singleton, WAL mode, sqlite-vec, migrations.
 */

import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { runMigrations } from '../shared/db-migrations'
import { cleanupAllRunningRuns } from '../shared/db-queries'
import { loadSqliteVec } from '../shared/embeddings'

let db: Database.Database | null = null

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', homedir())
  }
  return p
}

function getDefaultDataDir(): string {
  return join(homedir(), '.quoroom')
}

export function getDataDir(): string {
  const raw = process.env.QUOROOM_DATA_DIR || getDefaultDataDir()
  return expandTilde(raw)
}

export function getServerDatabase(): Database.Database {
  if (db) return db

  const dataDir = getDataDir()
  mkdirSync(dataDir, { recursive: true })

  const rawPath = process.env.QUOROOM_DB_PATH || join(dataDir, 'data.db')
  const dbPath = expandTilde(rawPath)

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  loadSqliteVec(db)
  runMigrations(db, (msg) => console.error(`API server: ${msg}`))

  const cleaned = cleanupAllRunningRuns(db)
  if (cleaned > 0) {
    console.error(`API server: Cleaned up ${cleaned} stale task run(s)`)
  }

  return db
}

export function closeServerDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
