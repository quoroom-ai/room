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
  })

  describe('user role — semi mode (room-level)', () => {
    beforeEach(() => {
      const result = createRoomFull(db, { name: 'Semi Room' })
      updateRoom(db, result.room.id, { autonomyMode: 'semi' })
    })

    it('allows all methods and paths', () => {
      expect(isAllowedForRole('user', 'POST', '/api/tasks', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/workers', db)).toBe(true)
      expect(isAllowedForRole('user', 'DELETE', '/api/tasks/1', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/skills', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/watches', db)).toBe(true)
    })
  })
})
