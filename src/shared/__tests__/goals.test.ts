import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { setRoomObjective, decomposeGoal, updateGoalProgress, completeGoal, abandonGoal, getGoalTree } from '../goals'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

function createTestRoom(): number {
  const room = queries.createRoom(db, 'Test Room', 'Make money')
  return room.id
}

describe('setRoomObjective', () => {
  it('creates a top-level goal', () => {
    const roomId = createTestRoom()
    const goal = setRoomObjective(db, roomId, 'Build a SaaS product')
    expect(goal.description).toBe('Build a SaaS product')
    expect(goal.roomId).toBe(roomId)
    expect(goal.parentGoalId).toBeNull()
    expect(goal.status).toBe('active')
    expect(goal.progress).toBe(0)
  })
})

describe('decomposeGoal', () => {
  it('creates sub-goals under a parent', () => {
    const roomId = createTestRoom()
    const root = setRoomObjective(db, roomId, 'Build SaaS')
    const subs = decomposeGoal(db, root.id, ['Research market', 'Build MVP', 'Launch'])

    expect(subs).toHaveLength(3)
    expect(subs[0].parentGoalId).toBe(root.id)
    expect(subs[1].parentGoalId).toBe(root.id)
    expect(subs[2].parentGoalId).toBe(root.id)
    expect(subs[0].description).toBe('Research market')

    // Parent should be marked in_progress
    const updated = queries.getGoal(db, root.id)!
    expect(updated.status).toBe('in_progress')
  })

  it('throws for completed goal', () => {
    const roomId = createTestRoom()
    const root = setRoomObjective(db, roomId, 'Done goal')
    completeGoal(db, root.id)
    expect(() => decomposeGoal(db, root.id, ['sub'])).toThrow("Cannot decompose goal with status 'completed'")
  })

  it('throws for nonexistent goal', () => {
    expect(() => decomposeGoal(db, 999, ['sub'])).toThrow('Goal 999 not found')
  })
})

describe('updateGoalProgress', () => {
  it('logs an update and sets leaf goal progress', () => {
    const roomId = createTestRoom()
    const goal = setRoomObjective(db, roomId, 'Test')
    const update = updateGoalProgress(db, goal.id, 'Started work', 0.5)

    expect(update.observation).toBe('Started work')
    expect(update.metricValue).toBe(0.5)

    const refreshed = queries.getGoal(db, goal.id)!
    expect(refreshed.progress).toBe(0.5)
  })

  it('clamps progress to 0-1', () => {
    const roomId = createTestRoom()
    const goal = setRoomObjective(db, roomId, 'Test')

    updateGoalProgress(db, goal.id, 'Over', 1.5)
    expect(queries.getGoal(db, goal.id)!.progress).toBe(1)

    updateGoalProgress(db, goal.id, 'Under', -0.5)
    expect(queries.getGoal(db, goal.id)!.progress).toBe(0)
  })

  it('recalculates parent progress from sub-goals', () => {
    const roomId = createTestRoom()
    const root = setRoomObjective(db, roomId, 'Root')
    const subs = decomposeGoal(db, root.id, ['A', 'B'])

    updateGoalProgress(db, subs[0].id, 'Done', 1.0)
    updateGoalProgress(db, subs[1].id, 'Half', 0.5)

    const refreshed = queries.getGoal(db, root.id)!
    expect(refreshed.progress).toBe(0.75)
  })
})

describe('completeGoal', () => {
  it('sets status to completed and progress to 1.0', () => {
    const roomId = createTestRoom()
    const goal = setRoomObjective(db, roomId, 'Test')
    completeGoal(db, goal.id)

    const refreshed = queries.getGoal(db, goal.id)!
    expect(refreshed.status).toBe('completed')
    expect(refreshed.progress).toBe(1.0)
  })

  it('recalculates parent on completion', () => {
    const roomId = createTestRoom()
    const root = setRoomObjective(db, roomId, 'Root')
    const subs = decomposeGoal(db, root.id, ['A', 'B'])

    completeGoal(db, subs[0].id)
    const afterOne = queries.getGoal(db, root.id)!
    expect(afterOne.progress).toBe(0.5)

    completeGoal(db, subs[1].id)
    const afterBoth = queries.getGoal(db, root.id)!
    expect(afterBoth.progress).toBe(1.0)
  })
})

describe('abandonGoal', () => {
  it('sets status to abandoned and logs reason', () => {
    const roomId = createTestRoom()
    const goal = setRoomObjective(db, roomId, 'Test')
    abandonGoal(db, goal.id, 'Not viable')

    const refreshed = queries.getGoal(db, goal.id)!
    expect(refreshed.status).toBe('abandoned')

    const updates = queries.getGoalUpdates(db, goal.id)
    expect(updates[0].observation).toBe('Abandoned: Not viable')
  })
})

describe('getGoalTree', () => {
  it('returns hierarchical tree', () => {
    const roomId = createTestRoom()
    const root = setRoomObjective(db, roomId, 'Root')
    const subs = decomposeGoal(db, root.id, ['A', 'B'])
    decomposeGoal(db, subs[0].id, ['A1', 'A2'])

    const tree = getGoalTree(db, roomId)
    expect(tree).toHaveLength(1)
    expect(tree[0].description).toBe('Root')
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children[0].description).toBe('A')
    expect(tree[0].children[0].children).toHaveLength(2)
    expect(tree[0].children[0].children[0].description).toBe('A1')
    expect(tree[0].children[1].description).toBe('B')
    expect(tree[0].children[1].children).toHaveLength(0)
  })

  it('returns empty array for room with no goals', () => {
    const roomId = createTestRoom()
    expect(getGoalTree(db, roomId)).toEqual([])
  })
})
