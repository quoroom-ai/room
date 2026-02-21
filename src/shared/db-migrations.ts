import type Database from 'better-sqlite3'
import { SCHEMA } from './schema'

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)
  log('Database schema initialized')
}
