import type Database from 'better-sqlite3'
import { SCHEMA } from './schema'

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)
  log('Database schema initialized')

  // Migration 25: add autonomy_mode, max_concurrent_tasks per-room (moved from global settings)
  applyMigration(database, 25, (db) => {
    try { db.exec("ALTER TABLE rooms ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'auto'") } catch { /* column exists on fresh DB */ }
    try { db.exec("ALTER TABLE rooms ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 3") } catch { /* column exists on fresh DB */ }

    // Seed existing rooms from global settings
    const autoMode = db.prepare("SELECT value FROM settings WHERE key = 'autonomy_mode'").get() as { value: string } | undefined
    const maxTasks = db.prepare("SELECT value FROM settings WHERE key = 'max_concurrent_tasks'").get() as { value: string } | undefined
    const pubMode = db.prepare("SELECT value FROM settings WHERE key = 'public_mode'").get() as { value: string } | undefined

    if (autoMode?.value) {
      db.prepare('UPDATE rooms SET autonomy_mode = ?').run(autoMode.value)
    }
    if (maxTasks?.value) {
      const n = parseInt(maxTasks.value, 10)
      if (!isNaN(n)) db.prepare('UPDATE rooms SET max_concurrent_tasks = ?').run(n)
    }
    if (pubMode?.value === 'true') {
      db.prepare("UPDATE rooms SET visibility = 'public'").run()
    }
  }, log)

  // Migration 26: add worker_model column to rooms
  applyMigration(database, 26, (db) => {
    try { db.exec("ALTER TABLE rooms ADD COLUMN worker_model TEXT NOT NULL DEFAULT 'claude'") } catch { /* column exists on fresh DB */ }
  }, log)

  // Migration 27: add queen activity safeguard columns to rooms
  applyMigration(database, 27, (db) => {
    try { db.exec('ALTER TABLE rooms ADD COLUMN queen_cycle_gap_ms INTEGER NOT NULL DEFAULT 1800000') } catch { /* column exists on fresh DB */ }
    try { db.exec('ALTER TABLE rooms ADD COLUMN queen_max_turns INTEGER NOT NULL DEFAULT 3') } catch { /* column exists on fresh DB */ }
    try { db.exec('ALTER TABLE rooms ADD COLUMN queen_quiet_from TEXT') } catch { /* column exists on fresh DB */ }
    try { db.exec('ALTER TABLE rooms ADD COLUMN queen_quiet_until TEXT') } catch { /* column exists on fresh DB */ }
  }, log)
}

function applyMigration(
  db: Database.Database,
  version: number,
  fn: (db: Database.Database) => void,
  log: (msg: string) => void
): void {
  const row = db.prepare('SELECT version FROM schema_version WHERE version = ?').get(version)
  if (row) return
  fn(db)
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version)
  log(`Migration ${version} applied`)
}
