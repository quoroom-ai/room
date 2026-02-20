import Database from 'better-sqlite3'
import { homedir } from 'os'
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

export function getMcpDatabase(): Database.Database {
  if (db) return db

  const rawPath = process.env.QUOROOM_DB_PATH
  if (!rawPath) {
    throw new Error('QUOROOM_DB_PATH environment variable is not set')
  }

  const dbPath = expandTilde(rawPath)
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  loadSqliteVec(db)
  runMigrations(db, (msg) => console.error(`MCP server: ${msg}`))

  const cleaned = cleanupAllRunningRuns(db)
  if (cleaned > 0) {
    console.error(`MCP server: Cleaned up ${cleaned} stale task run(s)`)
  }

  return db
}

export function closeMcpDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
