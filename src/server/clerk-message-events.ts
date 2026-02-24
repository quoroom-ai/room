import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { eventBus } from './event-bus'
import type { ClerkMessageSource } from '../shared/types'

export function insertClerkMessageAndEmit(
  db: Database.Database,
  role: 'user' | 'assistant' | 'commentary',
  content: string,
  source?: ClerkMessageSource,
): ReturnType<typeof queries.insertClerkMessage> {
  const message = queries.insertClerkMessage(db, role, content, source)
  eventBus.emit('clerk', 'clerk:message', { message })
  return message
}
