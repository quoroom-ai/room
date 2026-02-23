/**
 * Webhook receiver — token-authenticated HTTP triggers for tasks and queen wake.
 *
 * Two endpoints (handled before Bearer auth in index.ts):
 *   POST /api/hooks/task/:token  — trigger a specific task by its webhook token
 *   POST /api/hooks/queen/:token — inject a message and immediately wake the queen
 */

import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { runTaskNow } from './runtime'
import { triggerAgent } from '../shared/agent-loop'
import { eventBus } from './event-bus'

// ─── Per-token rate limiter (30 req/min, in-memory) ────────────────────────
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60_000

interface RateBucket { count: number; resetAt: number }
const rateBuckets = new Map<string, RateBucket>()

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key)
  }
}, 120_000).unref()

function checkWebhookRateLimit(token: string): boolean {
  const now = Date.now()
  let bucket = rateBuckets.get(token)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    rateBuckets.set(token, bucket)
  }
  bucket.count++
  return bucket.count <= RATE_LIMIT_MAX
}

// ─── Webhook request dispatcher ────────────────────────────────────────────

export async function handleWebhookRequest(
  pathname: string,
  body: unknown,
  db: Database.Database
): Promise<{ status: number; data: unknown }> {

  // POST /api/hooks/task/:token
  const taskMatch = pathname.match(/^\/api\/hooks\/task\/([a-f0-9]{32})$/)
  if (taskMatch) {
    const token = taskMatch[1]

    if (!checkWebhookRateLimit(token)) {
      return { status: 429, data: { error: 'Too many requests' } }
    }

    const task = queries.getTaskByWebhookToken(db, token)
    if (!task) {
      return { status: 401, data: { error: 'Invalid webhook token' } }
    }

    if (task.status === 'paused') {
      return { status: 409, data: { error: 'Task is paused' } }
    }

    const result = runTaskNow(db, task.id)
    if (!result.started) {
      return { status: 409, data: { error: result.reason ?? 'Task is already running' } }
    }

    eventBus.emit('tasks', 'task:webhook_triggered', { id: task.id })
    return { status: 202, data: { ok: true, taskId: task.id } }
  }

  // POST /api/hooks/queen/:token
  const queenMatch = pathname.match(/^\/api\/hooks\/queen\/([a-f0-9]{32})$/)
  if (queenMatch) {
    const token = queenMatch[1]

    if (!checkWebhookRateLimit(token)) {
      return { status: 429, data: { error: 'Too many requests' } }
    }

    const room = queries.getRoomByWebhookToken(db, token)
    if (!room) {
      return { status: 401, data: { error: 'Invalid webhook token' } }
    }

    if (room.status === 'paused' || room.status === 'stopped') {
      return { status: 409, data: { error: `Room is ${room.status}` } }
    }

    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Webhook triggered'

    queries.insertChatMessage(db, room.id, 'user', message)

    if (room.queenWorkerId) {
      triggerAgent(db, room.id, room.queenWorkerId)
    }

    eventBus.emit('rooms', 'room:webhook_triggered', { id: room.id })
    return { status: 202, data: { ok: true, roomId: room.id } }
  }

  return { status: 404, data: { error: 'Not found' } }
}
