import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoomWallet } from '../wallet'

let db: Database.Database
let roomId: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Revenue Test Room', 'test goal')
  roomId = room.id
})

describe('getRevenueSummary', () => {
  it('returns zeros when no wallet exists for room', () => {
    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.totalIncome).toBe(0)
    expect(summary.totalExpenses).toBe(0)
    expect(summary.netProfit).toBe(0)
    expect(summary.stationCosts).toBe(0)
    expect(summary.transactionCount).toBe(0)
  })

  it('returns zeros when wallet has no transactions', () => {
    createRoomWallet(db, roomId, 'test-key')
    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.totalIncome).toBe(0)
    expect(summary.totalExpenses).toBe(0)
    expect(summary.netProfit).toBe(0)
    expect(summary.transactionCount).toBe(0)
  })

  it('calculates totalIncome from receive + fund transactions', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'receive', '50.00')
    queries.logWalletTransaction(db, wallet.id, 'fund', '25.50')

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.totalIncome).toBe(75.5)
  })

  it('calculates totalExpenses from send + purchase transactions', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'send', '10.00')
    queries.logWalletTransaction(db, wallet.id, 'purchase', '5.25')

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.totalExpenses).toBe(15.25)
  })

  it('calculates netProfit correctly (income - expenses)', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'receive', '100.00')
    queries.logWalletTransaction(db, wallet.id, 'send', '40.00')

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.netProfit).toBe(60)
  })

  it('tracks stationCosts from category=station_cost', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'send', '15.00', { category: 'station_cost' })
    queries.logWalletTransaction(db, wallet.id, 'send', '5.00', { category: 'station_cost' })
    queries.logWalletTransaction(db, wallet.id, 'send', '10.00') // no category

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.stationCosts).toBe(20)
    expect(summary.totalExpenses).toBe(30)
  })

  it('returns correct transactionCount', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'receive', '100.00')
    queries.logWalletTransaction(db, wallet.id, 'send', '30.00')
    queries.logWalletTransaction(db, wallet.id, 'fund', '50.00')

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.transactionCount).toBe(3)
  })

  it('handles mixed transaction types correctly', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    queries.logWalletTransaction(db, wallet.id, 'receive', '200.00', { category: 'revenue' })
    queries.logWalletTransaction(db, wallet.id, 'fund', '50.00')
    queries.logWalletTransaction(db, wallet.id, 'send', '75.00', { category: 'expense' })
    queries.logWalletTransaction(db, wallet.id, 'purchase', '25.00', { category: 'station_cost' })

    const summary = queries.getRevenueSummary(db, roomId)
    expect(summary.totalIncome).toBe(250)
    expect(summary.totalExpenses).toBe(100)
    expect(summary.netProfit).toBe(150)
    expect(summary.stationCosts).toBe(25)
    expect(summary.transactionCount).toBe(4)
  })

  it('logWalletTransaction stores category correctly', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key')
    const tx = queries.logWalletTransaction(db, wallet.id, 'send', '10.00', { category: 'station_cost' })

    expect(tx.category).toBe('station_cost')

    const txNoCat = queries.logWalletTransaction(db, wallet.id, 'receive', '5.00')
    expect(txNoCat.category).toBeNull()
  })
})
