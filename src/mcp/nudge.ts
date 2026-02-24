/**
 * Fire-and-forget HTTP nudge to wake workers via the API server.
 *
 * MCP tools run in a separate process from the API server, so they can't
 * call triggerAgent() directly. Instead, POST /api/workers/:id/start
 * which calls triggerAgent on the server side.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { request } from 'http'
import { APP_NAME } from '../shared/constants'

function getApiInfo(): { port: number; token: string } | null {
  try {
    const dbPath = process.env.QUOROOM_DB_PATH
    const dataDir = process.env.QUOROOM_DATA_DIR
      || (dbPath ? join(dbPath, '..') : join(homedir(), `.${APP_NAME.toLowerCase()}`))
    const portFile = join(dataDir, 'api.port')
    const tokenFile = join(dataDir, 'api.token')
    if (!existsSync(portFile) || !existsSync(tokenFile)) return null
    const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
    const token = readFileSync(tokenFile, 'utf-8').trim()
    if (!Number.isFinite(port) || port <= 0 || !token) return null
    return { port, token }
  } catch { return null }
}

/** Wake a single worker (fire-and-forget) */
export function nudgeWorker(workerId: number): void {
  const info = getApiInfo()
  if (!info) return
  const req = request({
    hostname: '127.0.0.1',
    port: info.port,
    path: `/api/workers/${workerId}/start`,
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}` },
    timeout: 2000,
  })
  req.on('error', () => {})
  req.end()
}

/** Wake all workers in a room except the sender */
export function nudgeRoomWorkers(roomId: number, excludeWorkerId: number): void {
  // We need the worker list — read from DB
  try {
    const { getMcpDatabase } = require('./db') as typeof import('./db')
    const db = getMcpDatabase()
    const { listRoomWorkers } = require('../shared/db-queries') as typeof import('../shared/db-queries')
    const workers = listRoomWorkers(db, roomId)
    for (const w of workers) {
      if (w.id !== excludeWorkerId) nudgeWorker(w.id)
    }
  } catch { /* non-fatal */ }
}
