/**
 * Role-based API access control.
 *
 * Agent token → full access always.
 * User token  → full access (semi mode only).
 * Member token → read-only plus limited collaboration endpoints.
 */

import type Database from 'better-sqlite3'
import type { TokenRole } from './auth'

/** Sensitive read endpoints blocked for member tokens. */
const MEMBER_GET_DENYLIST = [
  /^\/api\/credentials\/\d+$/, // full credential details
]

/** Cloud member token: collaborative access, no destructive control paths. */
const MEMBER_ROLE_WRITE_WHITELIST = [
  /^POST \/api\/decisions\/\d+\/vote$/, // quorum participation
  /^POST \/api\/decisions\/\d+\/keeper-vote$/, // quorum participation
  /^POST \/api\/escalations\/\d+\/resolve$/, // resolve/reply escalation
  /^POST \/api\/messages\/\d+\/reply$/, // reply to room message
  /^POST \/api\/rooms\/\d+\/messages\/\d+\/read$/, // inbox hygiene
]

export interface AccessContext {
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

export function isAllowedForRole(
  role: TokenRole,
  method: string,
  pathname: string,
  _db: Database.Database,
  _context?: AccessContext
): boolean {
  // Agent and keeper both have full control.
  if (role === 'agent' || role === 'user') return true

  // Cloud member role: read-only plus limited collaboration endpoints.
  if (method === 'GET') {
    return !MEMBER_GET_DENYLIST.some(pattern => pattern.test(pathname))
  }
  const key = `${method} ${pathname}`
  return MEMBER_ROLE_WRITE_WHITELIST.some(pattern => pattern.test(key))
}
