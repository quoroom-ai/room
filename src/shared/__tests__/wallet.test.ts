import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import { privateKeyToAccount } from 'viem/accounts'
import {
  encryptPrivateKey,
  decryptPrivateKey,
  createRoomWallet,
  getWalletAddress,
  getTransactionHistory
} from '../wallet'
import * as queries from '../db-queries'

let db: Database.Database
let roomId: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Wallet Test Room', 'test goal')
  roomId = room.id
})

// ─── Encryption ─────────────────────────────────────────────

describe('encryptPrivateKey / decryptPrivateKey', () => {
  const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const encKey = 'my-secret-password-for-testing'

  it('encrypts and decrypts a private key', () => {
    const encrypted = encryptPrivateKey(testKey, encKey)
    expect(encrypted).not.toBe(testKey)
    expect(encrypted).toContain(':') // format: iv:tag:ciphertext
    const decrypted = decryptPrivateKey(encrypted, encKey)
    expect(decrypted).toBe(testKey)
  })

  it('produces different ciphertext each time (random IV)', () => {
    const enc1 = encryptPrivateKey(testKey, encKey)
    const enc2 = encryptPrivateKey(testKey, encKey)
    expect(enc1).not.toBe(enc2)
    // Both decrypt to the same value
    expect(decryptPrivateKey(enc1, encKey)).toBe(testKey)
    expect(decryptPrivateKey(enc2, encKey)).toBe(testKey)
  })

  it('fails with wrong encryption key', () => {
    const encrypted = encryptPrivateKey(testKey, encKey)
    expect(() => decryptPrivateKey(encrypted, 'wrong-key')).toThrow()
  })

  it('fails with corrupted ciphertext', () => {
    expect(() => decryptPrivateKey('invalid-format', encKey)).toThrow()
  })

  it('works with Buffer encryption key', () => {
    const bufKey = Buffer.from('a'.repeat(32))
    const encrypted = encryptPrivateKey(testKey, bufKey)
    const decrypted = decryptPrivateKey(encrypted, bufKey)
    expect(decrypted).toBe(testKey)
  })
})

// ─── createRoomWallet ───────────────────────────────────────

describe('createRoomWallet', () => {
  it('creates a wallet with valid address', () => {
    const wallet = createRoomWallet(db, roomId, 'test-password')
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(wallet.roomId).toBe(roomId)
    expect(wallet.chain).toBe('base')
    expect(wallet.privateKeyEncrypted).toBeTruthy()
  })

  it('private key decrypts to a valid key that matches the stored address', () => {
    const wallet = createRoomWallet(db, roomId, 'test-password')
    const privateKey = decryptPrivateKey(wallet.privateKeyEncrypted, 'test-password')
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    expect(account.address.toLowerCase()).toBe(wallet.address.toLowerCase())
  })

  it('throws if room does not exist', () => {
    expect(() => createRoomWallet(db, 9999, 'pw')).toThrow('Room 9999 not found')
  })

  it('throws if room already has a wallet', () => {
    createRoomWallet(db, roomId, 'pw')
    expect(() => createRoomWallet(db, roomId, 'pw')).toThrow('already has a wallet')
  })

  it('logs room activity', () => {
    createRoomWallet(db, roomId, 'pw')
    const activity = queries.getRoomActivity(db, roomId)
    const walletEvent = activity.find(a => a.eventType === 'financial' && a.summary.includes('Wallet created'))
    expect(walletEvent).toBeTruthy()
  })
})

// ─── getWalletAddress ───────────────────────────────────────

describe('getWalletAddress', () => {
  it('returns the address', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    const addr = getWalletAddress(db, roomId)
    expect(addr).toBe(wallet.address)
  })

  it('throws if no wallet', () => {
    expect(() => getWalletAddress(db, roomId)).toThrow('has no wallet')
  })
})

// ─── getTransactionHistory ──────────────────────────────────

describe('getTransactionHistory', () => {
  it('returns transaction history for room wallet', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    queries.logWalletTransaction(db, wallet.id, 'fund', '100.00', { description: 'Initial funding' })
    queries.logWalletTransaction(db, wallet.id, 'send', '25.00', { counterparty: '0xDEF' })
    const history = getTransactionHistory(db, roomId)
    expect(history.length).toBe(2)
  })

  it('throws if no wallet', () => {
    expect(() => getTransactionHistory(db, roomId)).toThrow('has no wallet')
  })

  it('respects limit', () => {
    const wallet = createRoomWallet(db, roomId, 'pw')
    for (let i = 0; i < 5; i++) {
      queries.logWalletTransaction(db, wallet.id, 'fund', `${i}.00`)
    }
    const history = getTransactionHistory(db, roomId, 3)
    expect(history.length).toBe(3)
  })
})
