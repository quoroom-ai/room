import { describe, it, expect, beforeEach } from 'vitest'
import { isAllowedForRole } from '../access'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import { createRoom as createRoomFull } from '../../shared/room'
import { updateRoom } from '../../shared/db-queries'
import type Database from 'better-sqlite3'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

describe('isAllowedForRole', () => {
  describe('agent role', () => {
    it('allows all methods and paths', () => {
      expect(isAllowedForRole('agent', 'GET', '/api/rooms', db)).toBe(true)
      expect(isAllowedForRole('agent', 'POST', '/api/tasks', db)).toBe(true)
      expect(isAllowedForRole('agent', 'DELETE', '/api/workers/1', db)).toBe(true)
    })
  })

  describe('user role — auto mode (default)', () => {
    it('allows GET requests', () => {
      expect(isAllowedForRole('user', 'GET', '/api/rooms', db)).toBe(true)
      expect(isAllowedForRole('user', 'GET', '/api/tasks', db)).toBe(true)
    })

    it('blocks sensitive credential detail reads', () => {
      expect(isAllowedForRole('user', 'GET', '/api/credentials/1', db)).toBe(false)
    })

    it('allows voting', () => {
      expect(isAllowedForRole('user', 'POST', '/api/decisions/1/vote', db)).toBe(true)
    })

    it('allows replying to messages', () => {
      expect(isAllowedForRole('user', 'POST', '/api/messages/42/reply', db)).toBe(true)
    })

    it('allows updating room settings', () => {
      expect(isAllowedForRole('user', 'PATCH', '/api/rooms/1', db)).toBe(true)
    })

    it('allows changing settings', () => {
      expect(isAllowedForRole('user', 'PUT', '/api/settings/autonomy_mode', db)).toBe(true)
    })

    it('blocks creating tasks', () => {
      expect(isAllowedForRole('user', 'POST', '/api/tasks', db)).toBe(false)
    })

    it('blocks creating workers', () => {
      expect(isAllowedForRole('user', 'POST', '/api/workers', db)).toBe(false)
    })

    it('blocks deleting resources', () => {
      expect(isAllowedForRole('user', 'DELETE', '/api/tasks/1', db)).toBe(false)
      expect(isAllowedForRole('user', 'DELETE', '/api/workers/1', db)).toBe(false)
    })

    it('blocks creating skills', () => {
      expect(isAllowedForRole('user', 'POST', '/api/skills', db)).toBe(false)
    })

    it('blocks creating watches', () => {
      expect(isAllowedForRole('user', 'POST', '/api/watches', db)).toBe(false)
    })

    it('allows creating credentials', () => {
      expect(isAllowedForRole('user', 'POST', '/api/rooms/1/credentials', db)).toBe(true)
    })

    it('allows deleting credentials', () => {
      expect(isAllowedForRole('user', 'DELETE', '/api/credentials/1', db)).toBe(true)
    })

    it('allows provider auth flow operations', () => {
      expect(isAllowedForRole('user', 'POST', '/api/providers/codex/connect', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/providers/codex/install', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/providers/claude/disconnect', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/providers/sessions/abc123/cancel', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/providers/install-sessions/abc123/cancel', db)).toBe(true)
    })

    it('allows clerk control endpoints', () => {
      expect(isAllowedForRole('user', 'POST', '/api/clerk/chat', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/clerk/presence', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/clerk/typing', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/clerk/reset', db)).toBe(true)
      expect(isAllowedForRole('user', 'PUT', '/api/clerk/settings', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/clerk/api-key', db)).toBe(true)
    })
  })

  describe('user role — semi mode (room-level)', () => {
    let semiRoomId: number

    beforeEach(() => {
      const result = createRoomFull(db, { name: 'Semi Room' })
      updateRoom(db, result.room.id, { autonomyMode: 'semi' })
      semiRoomId = result.room.id
    })

    it('allows write requests scoped to the semi room', () => {
      expect(isAllowedForRole('user', 'POST', '/api/tasks', db, { body: { roomId: semiRoomId } })).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/workers', db, { body: { roomId: semiRoomId } })).toBe(true)
      expect(isAllowedForRole('user', 'POST', `/api/rooms/${semiRoomId}/pause`, db)).toBe(true)
    })

    it('does not grant blanket write access to unrelated auto rooms', () => {
      const autoRoom = createRoomFull(db, { name: 'Auto Room' })
      updateRoom(db, autoRoom.room.id, { autonomyMode: 'auto' })

      expect(isAllowedForRole('user', 'POST', `/api/rooms/${autoRoom.room.id}/pause`, db)).toBe(false)
      expect(isAllowedForRole('user', 'POST', '/api/tasks', db)).toBe(false)
    })
  })

  describe('member role', () => {
    it('allows read-only GET requests', () => {
      expect(isAllowedForRole('member', 'GET', '/api/rooms', db)).toBe(true)
      expect(isAllowedForRole('member', 'GET', '/api/tasks', db)).toBe(true)
    })

    it('allows collaboration writes only', () => {
      expect(isAllowedForRole('member', 'POST', '/api/decisions/1/vote', db)).toBe(true)
      expect(isAllowedForRole('member', 'POST', '/api/rooms/1/chat', db)).toBe(true)
      expect(isAllowedForRole('member', 'POST', '/api/messages/1/reply', db)).toBe(true)
    })

    it('blocks privileged writes', () => {
      expect(isAllowedForRole('member', 'POST', '/api/providers/codex/connect', db)).toBe(false)
      expect(isAllowedForRole('member', 'POST', '/api/tasks', db)).toBe(false)
      expect(isAllowedForRole('member', 'DELETE', '/api/rooms/1', db)).toBe(false)
    })
  })
})
