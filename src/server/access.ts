/**
 * Role-based API access control.
 *
 * Agent token → full access always.
 * User token → depends on autonomy_mode setting:
 *   - "semi": full access (user controls everything)
 *   - "auto" (default): read-only + whitelisted write endpoints
 */

import type Database from 'better-sqlite3'
import type { TokenRole } from './auth'
import {
  getCredential,
  getDecision,
  getEntity,
  getEscalation,
  getGoal,
  getObservation,
  getRelation,
  getRoom,
  getRoomMessage,
  getSkill,
  getStation,
  getTask,
  getTaskRun,
  getWatch,
  getWorker,
  listRooms,
} from '../shared/db-queries'

/** Endpoints the user can call even in auto mode (beyond GET). */
const AUTO_MODE_USER_WHITELIST = [
  /^POST \/api\/rooms$/,                         // create room
  /^POST \/api\/decisions\/\d+\/vote$/,         // cast vote
  /^POST \/api\/decisions\/\d+\/keeper-vote$/,  // keeper vote
  /^POST \/api\/escalations\/\d+\/resolve$/,    // resolve/reply escalation
  /^POST \/api\/messages\/\d+\/reply$/,          // reply to message
  /^POST \/api\/rooms\/\d+\/messages\/\d+\/read$/, // mark message read
  /^POST \/api\/rooms\/\d+\/chat$/,              // chat with queen
  /^POST \/api\/rooms\/\d+\/chat\/reset$/,       // reset chat
  /^PATCH \/api\/rooms\/\d+$/,                   // update room (visibility, name)
  /^PATCH \/api\/workers\/\d+$/,                 // update worker (queen model)
  /^POST \/api\/rooms\/\d+\/queen\/start$/,      // start queen agent
  /^POST \/api\/rooms\/\d+\/queen\/stop$/,       // stop queen agent
  /^PUT \/api\/settings\/.+$/,                   // change settings
  /^POST \/api\/settings\/.+$/,                  // change settings
  /^POST \/api\/rooms\/\d+\/credentials\/validate$/, // validate API credential
  /^POST \/api\/rooms\/\d+\/credentials$/,       // manage credentials
  /^DELETE \/api\/credentials\/\d+$/,            // delete credential
  /^POST \/api\/status\/simulate-update$/,       // dev: simulate update notification
  /^POST \/api\/providers\/(codex|claude)\/connect$/, // request provider auth flow
  /^POST \/api\/providers\/(codex|claude)\/install$/, // install provider CLI
  /^POST \/api\/providers\/(codex|claude)\/disconnect$/, // disconnect provider auth
  /^POST \/api\/providers\/sessions\/[^/]+\/cancel$/, // cancel provider auth session
  /^POST \/api\/providers\/install-sessions\/[^/]+\/cancel$/, // cancel provider install session
  /^POST \/api\/contacts\/email\/start$/,             // start email verification
  /^POST \/api\/contacts\/email\/resend$/,            // resend email verification code
  /^POST \/api\/contacts\/email\/verify$/,            // verify email code
  /^POST \/api\/contacts\/telegram\/start$/,          // start telegram verification
  /^POST \/api\/contacts\/telegram\/check$/,          // poll telegram verification
  /^POST \/api\/contacts\/telegram\/disconnect$/,     // disconnect telegram
  /^DELETE \/api\/rooms\/\d+\/cloud-stations\/\d+$/, // delete cloud station (archive)
  /^POST \/api\/clerk\/chat$/,                        // send message to clerk
  /^POST \/api\/clerk\/reset$/,                       // clear clerk session/messages
  /^PUT \/api\/clerk\/settings$/,                     // configure clerk model/commentary
  /^POST \/api\/clerk\/api-key$/,                     // validate/save clerk API key
]

/** Sensitive read endpoints blocked for user token in auto mode. */
const AUTO_MODE_USER_GET_DENYLIST = [
  /^\/api\/credentials\/\d+$/,                    // full credential details
]

/** Cloud member token: collaborative access, no destructive control paths. */
const MEMBER_ROLE_WRITE_WHITELIST = [
  /^POST \/api\/decisions\/\d+\/vote$/,         // quorum participation
  /^POST \/api\/decisions\/\d+\/keeper-vote$/,  // quorum participation
  /^POST \/api\/escalations\/\d+\/resolve$/,    // resolve/reply escalation
  /^POST \/api\/messages\/\d+\/reply$/,         // reply to room message
  /^POST \/api\/rooms\/\d+\/messages\/\d+\/read$/, // inbox hygiene
  /^POST \/api\/rooms\/\d+\/chat$/,             // chat with queen
]

export interface AccessContext {
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function parseId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractId(pathname: string, pattern: RegExp): number | null {
  const match = pathname.match(pattern)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function resolveRoomId(pathname: string, db: Database.Database, context?: AccessContext): number | null {
  const body = asObject(context?.body)
  const params = context?.params ?? {}
  const query = context?.query ?? {}

  const directRoomId = parseId(params.roomId) ?? parseId(query.roomId)
  if (directRoomId != null) return directRoomId

  const roomFromPath = extractId(pathname, /^\/api\/rooms\/(\d+)(?:\/|$)/)
  if (roomFromPath != null) return roomFromPath

  const roomFromBody = parseId(body.roomId)
  if (roomFromBody != null) return roomFromBody

  const taskId = extractId(pathname, /^\/api\/tasks\/(\d+)(?:\/|$)/)
  if (taskId != null) return getTask(db, taskId)?.roomId ?? null

  const workerId = extractId(pathname, /^\/api\/workers\/(\d+)(?:\/|$)/)
  if (workerId != null) return getWorker(db, workerId)?.roomId ?? null

  const goalId = extractId(pathname, /^\/api\/goals\/(\d+)(?:\/|$)/)
  if (goalId != null) return getGoal(db, goalId)?.roomId ?? null

  const decisionId = extractId(pathname, /^\/api\/decisions\/(\d+)(?:\/|$)/)
  if (decisionId != null) return getDecision(db, decisionId)?.roomId ?? null

  const skillId = extractId(pathname, /^\/api\/skills\/(\d+)(?:\/|$)/)
  if (skillId != null) return getSkill(db, skillId)?.roomId ?? null

  const watchId = extractId(pathname, /^\/api\/watches\/(\d+)(?:\/|$)/)
  if (watchId != null) return getWatch(db, watchId)?.roomId ?? null

  const escalationId = extractId(pathname, /^\/api\/escalations\/(\d+)(?:\/|$)/)
  if (escalationId != null) return getEscalation(db, escalationId)?.roomId ?? null

  const messageId = extractId(pathname, /^\/api\/messages\/(\d+)(?:\/|$)/)
  if (messageId != null) return getRoomMessage(db, messageId)?.roomId ?? null

  const stationId = extractId(pathname, /^\/api\/stations\/(\d+)(?:\/|$)/)
  if (stationId != null) return getStation(db, stationId)?.roomId ?? null

  const credentialId = extractId(pathname, /^\/api\/credentials\/(\d+)(?:\/|$)/)
  if (credentialId != null) return getCredential(db, credentialId)?.roomId ?? null

  const runId = extractId(pathname, /^\/api\/runs\/(\d+)(?:\/|$)/)
  if (runId != null) {
    const run = getTaskRun(db, runId)
    if (!run) return null
    return getTask(db, run.taskId)?.roomId ?? null
  }

  const entityIdFromPath = extractId(pathname, /^\/api\/memory\/entities\/(\d+)(?:\/|$)/)
  if (entityIdFromPath != null) return getEntity(db, entityIdFromPath)?.roomId ?? null

  const entityIdFromBody = parseId(body.entityId) ?? parseId(body.fromEntityId)
  if (entityIdFromBody != null) return getEntity(db, entityIdFromBody)?.roomId ?? null

  const observationId = extractId(pathname, /^\/api\/memory\/observations\/(\d+)(?:\/|$)/)
  if (observationId != null) {
    const observation = getObservation(db, observationId)
    if (!observation) return null
    return getEntity(db, observation.entity_id)?.roomId ?? null
  }

  const relationId = extractId(pathname, /^\/api\/memory\/relations\/(\d+)(?:\/|$)/)
  if (relationId != null) {
    const relation = getRelation(db, relationId)
    if (!relation) return null
    return getEntity(db, relation.from_entity)?.roomId ?? null
  }

  return null
}

export function isAllowedForRole(
  role: TokenRole,
  method: string,
  pathname: string,
  db: Database.Database,
  context?: AccessContext
): boolean {
  // Agent always has full access
  if (role === 'agent') return true

  // Cloud member role: read-only plus limited collaboration endpoints.
  if (role === 'member') {
    if (method === 'GET') {
      return !AUTO_MODE_USER_GET_DENYLIST.some(pattern => pattern.test(pathname))
    }
    const key = `${method} ${pathname}`
    return MEMBER_ROLE_WRITE_WHITELIST.some(pattern => pattern.test(key))
  }

  // If request is tied to a specific room, apply that room's autonomy mode.
  const requestRoomId = resolveRoomId(pathname, db, context)
  if (requestRoomId != null) {
    const room = getRoom(db, requestRoomId)
    if (room?.autonomyMode === 'semi') return true
  } else {
    // Global (non-room-scoped) requests are full-access only when all rooms are semi.
    const rooms = listRooms(db)
    if (rooms.length > 0 && rooms.every((room) => room.autonomyMode === 'semi')) {
      return true
    }
  }

  // In auto mode, GET is allowed except sensitive endpoints.
  if (method === 'GET') {
    return !AUTO_MODE_USER_GET_DENYLIST.some(pattern => pattern.test(pathname))
  }

  // In auto mode (default), only whitelisted writes
  const key = `${method} ${pathname}`
  return AUTO_MODE_USER_WHITELIST.some(pattern => pattern.test(key))
}
