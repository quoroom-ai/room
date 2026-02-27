import { describe, it, expect, beforeEach } from 'vitest'
import { isAllowedForRole } from '../access'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
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

  describe('user role', () => {
    it('allows full control on all endpoints', () => {
      expect(isAllowedForRole('user', 'GET', '/api/rooms', db)).toBe(true)
      expect(isAllowedForRole('user', 'GET', '/api/credentials/1', db)).toBe(true)
      expect(isAllowedForRole('user', 'POST', '/api/tasks', db)).toBe(true)
      expect(isAllowedForRole('user', 'PATCH', '/api/rooms/1', db)).toBe(true)
      expect(isAllowedForRole('user', 'DELETE', '/api/rooms/1', db)).toBe(true)
    })
  })

  describe('member role', () => {
    it('allows read-only GET requests except sensitive credential details', () => {
      expect(isAllowedForRole('member', 'GET', '/api/rooms', db)).toBe(true)
      expect(isAllowedForRole('member', 'GET', '/api/tasks', db)).toBe(true)
      expect(isAllowedForRole('member', 'GET', '/api/credentials/1', db)).toBe(false)
    })

    it('allows collaboration writes only', () => {
      expect(isAllowedForRole('member', 'POST', '/api/decisions/1/vote', db)).toBe(true)
      expect(isAllowedForRole('member', 'POST', '/api/messages/1/reply', db)).toBe(true)
      expect(isAllowedForRole('member', 'POST', '/api/escalations/1/resolve', db)).toBe(true)
    })

    it('blocks privileged writes', () => {
      expect(isAllowedForRole('member', 'POST', '/api/providers/codex/connect', db)).toBe(false)
      expect(isAllowedForRole('member', 'POST', '/api/tasks', db)).toBe(false)
      expect(isAllowedForRole('member', 'DELETE', '/api/rooms/1', db)).toBe(false)
    })
  })
})
