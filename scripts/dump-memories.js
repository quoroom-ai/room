#!/usr/bin/env node
/**
 * Dump memories (entities + observations) from one Quoroom DB to another.
 *
 * Usage:
 *   node scripts/dump-memories.js <source-db> [target-db] [--room <id>]
 *
 * Defaults:
 *   target-db: ~/.quoroom/data.db
 *   room: null (global memories)
 *
 * Examples:
 *   node scripts/dump-memories.js /tmp/quoroom-growth-XXX/data.db
 *   node scripts/dump-memories.js /tmp/quoroom-growth-XXX/data.db --room 1
 *   node scripts/dump-memories.js /tmp/experiment.db ~/.quoroom/data.db --room 2
 */

const Database = require('better-sqlite3')
const { homedir } = require('os')
const path = require('path')

const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--help')) {
  console.log('Usage: node scripts/dump-memories.js <source-db> [target-db] [--room <id>]')
  console.log('Default target: ~/.quoroom/data.db, default room: null (global)')
  process.exit(0)
}

// Parse args
let srcPath = null
let dstPath = path.join(homedir(), '.quoroom', 'data.db')
let targetRoomId = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--room') {
    targetRoomId = parseInt(args[++i])
    if (isNaN(targetRoomId)) { console.error('Invalid --room value'); process.exit(1) }
  } else if (!srcPath) {
    srcPath = args[i]
  } else {
    dstPath = args[i]
  }
}

if (!srcPath) { console.error('Source DB path required'); process.exit(1) }

// Open databases
const srcDb = new Database(srcPath, { readonly: true })
const dstDb = new Database(dstPath)

// Read all entities from source
const entities = srcDb.prepare('SELECT * FROM entities ORDER BY id').all()
console.log(`Source: ${entities.length} entities in ${srcPath}`)

const insertEntity = dstDb.prepare(
  'INSERT INTO entities (name, type, category, room_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
)
const insertObs = dstDb.prepare(
  'INSERT INTO observations (entity_id, content, source, created_at) VALUES (?, ?, ?, ?)'
)
const findExisting = dstDb.prepare(
  'SELECT id FROM entities WHERE name = ? AND (room_id = ? OR (room_id IS NULL AND ? IS NULL))'
)

let imported = 0
let skipped = 0

const tx = dstDb.transaction(() => {
  for (const e of entities) {
    // Skip queen_session_summary (internal)
    if (e.name === 'queen_session_summary') { skipped++; continue }

    // Dedup by name + room
    const existing = findExisting.get(e.name, targetRoomId, targetRoomId)
    if (existing) { skipped++; continue }

    const res = insertEntity.run(
      e.name, e.type, e.category, targetRoomId,
      e.created_at || new Date().toISOString(),
      e.updated_at || new Date().toISOString()
    )
    const newId = res.lastInsertRowid

    // Copy observations
    const observations = srcDb.prepare('SELECT * FROM observations WHERE entity_id = ?').all(e.id)
    for (const o of observations) {
      insertObs.run(newId, o.content, o.source || 'claude', o.created_at || new Date().toISOString())
    }

    imported++
  }
})

tx()

console.log(`Imported: ${imported}, Skipped: ${skipped} (duplicates or internal)`)
console.log(`Target: ${dstPath} (room_id: ${targetRoomId ?? 'NULL (global)'})`)

srcDb.close()
dstDb.close()
