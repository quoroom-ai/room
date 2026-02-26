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

  // Add webhook_token to tasks
  const hasTaskWebhookToken = (database.prepare(
    `SELECT name FROM pragma_table_info('tasks') WHERE name='webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasTaskWebhookToken) {
    database.exec(`ALTER TABLE tasks ADD COLUMN webhook_token TEXT`)
    log('Migrated: added webhook_token column to tasks')
  }
  const hasTaskWebhookIndex = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasTaskWebhookIndex) {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_webhook_token ON tasks(webhook_token) WHERE webhook_token IS NOT NULL`)
  }

  // Add webhook_token to rooms
  const hasRoomWebhookToken = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomWebhookToken) {
    database.exec(`ALTER TABLE rooms ADD COLUMN webhook_token TEXT`)
    log('Migrated: added webhook_token column to rooms')
  }
  const hasRoomWebhookIndex = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rooms_webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomWebhookIndex) {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_webhook_token ON rooms(webhook_token) WHERE webhook_token IS NOT NULL`)
  }

  // Add token usage columns to worker_cycles
  const hasCycleInputTokens = (database.prepare(
    `SELECT name FROM pragma_table_info('worker_cycles') WHERE name='input_tokens'`
  ).get() as { name: string } | undefined)?.name
  if (!hasCycleInputTokens) {
    database.exec(`ALTER TABLE worker_cycles ADD COLUMN input_tokens INTEGER`)
    database.exec(`ALTER TABLE worker_cycles ADD COLUMN output_tokens INTEGER`)
    log('Migrated: added token usage columns to worker_cycles')
  }

  // Add cycle_gap_ms and max_turns to workers (per-worker execution profiles)
  const hasWorkerCycleGap = (database.prepare(
    `SELECT name FROM pragma_table_info('workers') WHERE name='cycle_gap_ms'`
  ).get() as { name: string } | undefined)?.name
  if (!hasWorkerCycleGap) {
    database.exec(`ALTER TABLE workers ADD COLUMN cycle_gap_ms INTEGER`)
    database.exec(`ALTER TABLE workers ADD COLUMN max_turns INTEGER`)
    log('Migrated: added cycle_gap_ms and max_turns columns to workers')
  }

  // Add allowed_tools to rooms (tool filtering per room)
  const hasRoomAllowedTools = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='allowed_tools'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomAllowedTools) {
    database.exec(`ALTER TABLE rooms ADD COLUMN allowed_tools TEXT`)
    log('Migrated: added allowed_tools column to rooms')
  }

  // Add wip (work-in-progress) column to workers
  const hasWorkerWip = (database.prepare(
    `SELECT name FROM pragma_table_info('workers') WHERE name='wip'`
  ).get() as { name: string } | undefined)?.name
  if (!hasWorkerWip) {
    database.exec(`ALTER TABLE workers ADD COLUMN wip TEXT`)
    log('Migrated: added wip column to workers')
  }

  // Add effective_at column to quorum_decisions (announce-and-object governance)
  const hasEffectiveAt = (database.prepare(
    `SELECT name FROM pragma_table_info('quorum_decisions') WHERE name='effective_at'`
  ).get() as { name: string } | undefined)?.name
  if (!hasEffectiveAt) {
    database.exec(`ALTER TABLE quorum_decisions ADD COLUMN effective_at DATETIME`)
    log('Migrated: added effective_at column to quorum_decisions')
  }

  // Migrate ollama models → 'claude' (ollama removed in v0.1.12+)
  const ollamaWorkers = database
    .prepare(`SELECT id FROM workers WHERE model LIKE 'ollama:%'`)
    .all() as { id: number }[]
  if (ollamaWorkers.length > 0) {
    database.prepare(`UPDATE workers SET model = 'claude' WHERE model LIKE 'ollama:%'`).run()
    log(`Migrated: reset ${ollamaWorkers.length} ollama worker model(s) to 'claude'`)
  }
  const ollamaRooms = database
    .prepare(`SELECT id FROM rooms WHERE worker_model LIKE 'ollama:%'`)
    .all() as { id: number }[]
  if (ollamaRooms.length > 0) {
    database.prepare(`UPDATE rooms SET worker_model = 'claude' WHERE worker_model LIKE 'ollama:%'`).run()
    log(`Migrated: reset ${ollamaRooms.length} room worker_model(s) to 'claude'`)
  }

  log('Database schema initialized')
}
