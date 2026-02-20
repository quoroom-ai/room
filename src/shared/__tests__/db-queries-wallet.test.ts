import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

// ─── Wallets ─────────────────────────────────────────────────

describe('wallet CRUD', () => {
  let roomId: number

  beforeEach(() => {
    const room = queries.createRoom(db, 'Test Room', 'test goal')
    roomId = room.id
  })

  it('creates a wallet', () => {
    const wallet = queries.createWallet(db, roomId, '0xABC123', 'encrypted_key_data', 'base')
    expect(wallet.roomId).toBe(roomId)
    expect(wallet.address).toBe('0xABC123')
    expect(wallet.privateKeyEncrypted).toBe('encrypted_key_data')
    expect(wallet.chain).toBe('base')
    expect(wallet.createdAt).toBeTruthy()
  })

  it('gets wallet by id', () => {
    const created = queries.createWallet(db, roomId, '0xABC', 'enc', 'base')
    const got = queries.getWallet(db, created.id)
    expect(got).not.toBeNull()
    expect(got!.id).toBe(created.id)
  })

  it('returns null for nonexistent wallet', () => {
    expect(queries.getWallet(db, 999)).toBeNull()
  })

  it('gets wallet by room', () => {
    queries.createWallet(db, roomId, '0xABC', 'enc', 'base')
    const wallet = queries.getWalletByRoom(db, roomId)
    expect(wallet).not.toBeNull()
    expect(wallet!.roomId).toBe(roomId)
  })

  it('returns null for room without wallet', () => {
    expect(queries.getWalletByRoom(db, roomId)).toBeNull()
  })

  it('lists all wallets', () => {
    const room2 = queries.createRoom(db, 'Room 2')
    queries.createWallet(db, roomId, '0xA', 'enc1', 'base')
    queries.createWallet(db, room2.id, '0xB', 'enc2', 'base')
    const all = queries.listWallets(db)
    expect(all.length).toBe(2)
  })

  it('deletes a wallet', () => {
    const wallet = queries.createWallet(db, roomId, '0xA', 'enc', 'base')
    queries.deleteWallet(db, wallet.id)
    expect(queries.getWallet(db, wallet.id)).toBeNull()
  })

  it('defaults chain to base', () => {
    const wallet = queries.createWallet(db, roomId, '0xA', 'enc')
    expect(wallet.chain).toBe('base')
  })
})

// ─── Wallet Transactions ────────────────────────────────────

describe('wallet transactions', () => {
  let walletId: number

  beforeEach(() => {
    const room = queries.createRoom(db, 'Test Room')
    const wallet = queries.createWallet(db, room.id, '0xABC', 'enc', 'base')
    walletId = wallet.id
  })

  it('logs a transaction', () => {
    const tx = queries.logWalletTransaction(db, walletId, 'send', '10.50', {
      counterparty: '0xDEF',
      txHash: '0xhash123',
      description: 'Payment for server'
    })
    expect(tx.walletId).toBe(walletId)
    expect(tx.type).toBe('send')
    expect(tx.amount).toBe('10.50')
    expect(tx.counterparty).toBe('0xDEF')
    expect(tx.txHash).toBe('0xhash123')
    expect(tx.description).toBe('Payment for server')
    expect(tx.status).toBe('confirmed')
  })

  it('gets transaction by id', () => {
    const tx = queries.logWalletTransaction(db, walletId, 'receive', '5.00')
    const got = queries.getWalletTransaction(db, tx.id)
    expect(got).not.toBeNull()
    expect(got!.amount).toBe('5.00')
  })

  it('lists transactions for wallet', () => {
    queries.logWalletTransaction(db, walletId, 'fund', '100.00')
    queries.logWalletTransaction(db, walletId, 'send', '25.00')
    queries.logWalletTransaction(db, walletId, 'send', '10.00')
    const txs = queries.listWalletTransactions(db, walletId)
    expect(txs.length).toBe(3)
  })

  it('respects limit on list', () => {
    queries.logWalletTransaction(db, walletId, 'fund', '100.00')
    queries.logWalletTransaction(db, walletId, 'send', '25.00')
    queries.logWalletTransaction(db, walletId, 'send', '10.00')
    const txs = queries.listWalletTransactions(db, walletId, 2)
    expect(txs.length).toBe(2)
  })

  it('calculates transaction summary', () => {
    queries.logWalletTransaction(db, walletId, 'fund', '100.00')
    queries.logWalletTransaction(db, walletId, 'receive', '50.00')
    queries.logWalletTransaction(db, walletId, 'send', '30.00')
    queries.logWalletTransaction(db, walletId, 'purchase', '15.00')
    const summary = queries.getWalletTransactionSummary(db, walletId)
    expect(parseFloat(summary.received)).toBe(150)
    expect(parseFloat(summary.sent)).toBe(45)
  })

  it('returns zero for empty wallet', () => {
    const summary = queries.getWalletTransactionSummary(db, walletId)
    expect(parseFloat(summary.received)).toBe(0)
    expect(parseFloat(summary.sent)).toBe(0)
  })

  it('cascades on wallet delete', () => {
    queries.logWalletTransaction(db, walletId, 'fund', '100.00')
    queries.deleteWallet(db, walletId)
    const txs = queries.listWalletTransactions(db, walletId)
    expect(txs.length).toBe(0)
  })
})

// ─── Stations ───────────────────────────────────────────────

describe('station CRUD', () => {
  let roomId: number

  beforeEach(() => {
    const room = queries.createRoom(db, 'Test Room')
    roomId = room.id
  })

  it('creates a station', () => {
    const station = queries.createStation(db, roomId, 'web-server', 'flyio', 'small', {
      region: 'us-east-1',
      monthlyCost: 15,
      externalId: 'fly-123'
    })
    expect(station.roomId).toBe(roomId)
    expect(station.name).toBe('web-server')
    expect(station.provider).toBe('flyio')
    expect(station.tier).toBe('small')
    expect(station.region).toBe('us-east-1')
    expect(station.monthlyCost).toBe(15)
    expect(station.externalId).toBe('fly-123')
    expect(station.status).toBe('provisioning')
  })

  it('gets station by id', () => {
    const created = queries.createStation(db, roomId, 'test', 'mock', 'micro')
    const got = queries.getStation(db, created.id)
    expect(got).not.toBeNull()
    expect(got!.name).toBe('test')
  })

  it('returns null for nonexistent station', () => {
    expect(queries.getStation(db, 999)).toBeNull()
  })

  it('lists all stations', () => {
    queries.createStation(db, roomId, 's1', 'mock', 'micro')
    queries.createStation(db, roomId, 's2', 'mock', 'small')
    const all = queries.listStations(db)
    expect(all.length).toBe(2)
  })

  it('lists stations by room', () => {
    const room2 = queries.createRoom(db, 'Room 2')
    queries.createStation(db, roomId, 's1', 'mock', 'micro')
    queries.createStation(db, room2.id, 's2', 'mock', 'small')
    const roomStations = queries.listStations(db, roomId)
    expect(roomStations.length).toBe(1)
    expect(roomStations[0].name).toBe('s1')
  })

  it('lists stations by status', () => {
    queries.createStation(db, roomId, 's1', 'mock', 'micro', { status: 'running' })
    queries.createStation(db, roomId, 's2', 'mock', 'small', { status: 'stopped' })
    const running = queries.listStations(db, undefined, 'running')
    expect(running.length).toBe(1)
    expect(running[0].name).toBe('s1')
  })

  it('lists stations by room and status', () => {
    queries.createStation(db, roomId, 's1', 'mock', 'micro', { status: 'running' })
    queries.createStation(db, roomId, 's2', 'mock', 'small', { status: 'stopped' })
    const result = queries.listStations(db, roomId, 'running')
    expect(result.length).toBe(1)
  })

  it('updates station', () => {
    const station = queries.createStation(db, roomId, 'test', 'mock', 'micro')
    const updated = queries.updateStation(db, station.id, {
      status: 'running',
      externalId: 'ext-456',
      monthlyCost: 10
    })
    expect(updated.status).toBe('running')
    expect(updated.externalId).toBe('ext-456')
    expect(updated.monthlyCost).toBe(10)
  })

  it('updates station config as JSON', () => {
    const station = queries.createStation(db, roomId, 'test', 'mock', 'micro')
    const updated = queries.updateStation(db, station.id, {
      config: { cpu: 2, memory: '4GB' }
    })
    expect(updated.config).toEqual({ cpu: 2, memory: '4GB' })
  })

  it('deletes a station', () => {
    const station = queries.createStation(db, roomId, 'test', 'mock', 'micro')
    queries.deleteStation(db, station.id)
    expect(queries.getStation(db, station.id)).toBeNull()
  })

  it('defaults monthlyCost to 0', () => {
    const station = queries.createStation(db, roomId, 'test', 'mock', 'micro')
    expect(station.monthlyCost).toBe(0)
  })
})
