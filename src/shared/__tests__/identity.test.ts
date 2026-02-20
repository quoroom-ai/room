import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import { buildRegistrationURI } from '../identity'
import { createRoomWallet } from '../wallet'
import * as queries from '../db-queries'

let db: Database.Database
let roomId: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Identity Test Room', 'build the future')
  roomId = room.id
})

// ─── buildRegistrationURI ───────────────────────────────────

describe('buildRegistrationURI', () => {
  it('returns a data: URI with valid JSON', () => {
    const uri = buildRegistrationURI(db, roomId)
    expect(uri).toMatch(/^data:application\/json;base64,/)

    // Decode and parse
    const base64 = uri.replace('data:application/json;base64,', '')
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    expect(json.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1')
    expect(json.name).toBe('Identity Test Room')
    expect(json.description).toBe('build the future')
    expect(json.active).toBe(true)
    expect(json.supportedTrust).toEqual(['reputation'])
  })

  it('includes quoroom metadata', () => {
    const uri = buildRegistrationURI(db, roomId)
    const base64 = uri.replace('data:application/json;base64,', '')
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))

    expect(json['x-quoroom']).toBeDefined()
    expect(json['x-quoroom'].architecture).toBe('collective')
    expect(json['x-quoroom'].workerCount).toBe(0)
    expect(json['x-quoroom'].visibility).toBe('private')
    expect(json['x-quoroom'].threshold).toBe('majority')
  })

  it('reflects queen and workers', () => {
    // Create workers for this room
    const worker = queries.createWorker(db, {
      name: 'Scout',
      systemPrompt: 'You are a scout.',
      roomId
    })
    const queen = queries.createWorker(db, {
      name: 'Regina',
      systemPrompt: 'You are the queen.',
      roomId
    })
    queries.updateRoom(db, roomId, { queenWorkerId: queen.id })

    const uri = buildRegistrationURI(db, roomId)
    const base64 = uri.replace('data:application/json;base64,', '')
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))

    expect(json['x-quoroom'].queen).toBe('Regina')
    expect(json['x-quoroom'].workerCount).toBe(2) // Scout + Regina
  })

  it('uses fallback description when room has no goal', () => {
    const room2 = queries.createRoom(db, 'No Goal Room')
    const uri = buildRegistrationURI(db, room2.id)
    const base64 = uri.replace('data:application/json;base64,', '')
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    expect(json.description).toBe('Quoroom room: No Goal Room')
  })

  it('throws for nonexistent room', () => {
    expect(() => buildRegistrationURI(db, 9999)).toThrow('Room 9999 not found')
  })
})

// ─── Wallet erc8004AgentId column ───────────────────────────

describe('wallet erc8004AgentId', () => {
  it('new wallet has null agentId', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    expect(wallet.erc8004AgentId).toBeNull()
  })

  it('updateWalletAgentId stores the value', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    queries.updateWalletAgentId(db, wallet.id, '42')

    const updated = queries.getWalletByRoom(db, roomId)!
    expect(updated.erc8004AgentId).toBe('42')
  })

  it('stores large uint256 values as strings', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    const bigId = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    queries.updateWalletAgentId(db, wallet.id, bigId)

    const updated = queries.getWalletByRoom(db, roomId)!
    expect(updated.erc8004AgentId).toBe(bigId)
  })
})
