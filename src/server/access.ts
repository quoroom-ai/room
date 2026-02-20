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
import { listRooms } from '../shared/db-queries'

/** Endpoints the user can call even in auto mode (beyond GET). */
const AUTO_MODE_USER_WHITELIST = [
  /^POST \/api\/rooms$/,                         // create room
  /^POST \/api\/decisions\/\d+\/vote$/,         // cast vote
  /^POST \/api\/messages\/\d+\/reply$/,          // reply to message
  /^POST \/api\/rooms\/\d+\/chat$/,              // chat with queen
  /^POST \/api\/rooms\/\d+\/chat\/reset$/,       // reset chat
  /^PATCH \/api\/rooms\/\d+$/,                   // update room (visibility, name)
  /^POST \/api\/rooms\/\d+\/queen\/start$/,      // start queen agent
  /^POST \/api\/rooms\/\d+\/queen\/stop$/,       // stop queen agent
  /^PUT \/api\/settings\/.+$/,                   // change settings
  /^POST \/api\/settings\/.+$/,                  // change settings
  /^POST \/api\/rooms\/\d+\/credentials$/,       // manage credentials
  /^DELETE \/api\/credentials\/\d+$/,            // delete credential
]

export function isAllowedForRole(
  role: TokenRole,
  method: string,
  pathname: string,
  db: Database.Database
): boolean {
  // Agent always has full access
  if (role === 'agent') return true

  // GET requests always allowed for user
  if (method === 'GET') return true

  // In semi mode, user has full access — if any active room is semi, grant access
  const rooms = listRooms(db, 'active')
  const hasSemi = rooms.length > 0 ? rooms.some(r => r.autonomyMode === 'semi') : false
  if (hasSemi) return true

  // In auto mode (default), only whitelisted writes
  const key = `${method} ${pathname}`
  return AUTO_MODE_USER_WHITELIST.some(pattern => pattern.test(key))
}
