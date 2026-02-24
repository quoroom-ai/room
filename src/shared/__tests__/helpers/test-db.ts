import Database from 'better-sqlite3'
import { SCHEMA } from '../../schema'

export function initTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}
