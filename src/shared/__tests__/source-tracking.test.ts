import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as queries from '../db-queries'
import { initTestDb } from './helpers/test-db'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

afterEach(() => {
  db.close()
})

// ─── Source Tracking via triggerConfig ──────────────────────────

describe('task source tracking', () => {
  it('stores claude-code source in triggerConfig', () => {
    const task = queries.createTask(db, {
      name: 'CC Task',
      prompt: 'Do something',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-code' })
    })

    const fetched = queries.getTask(db, task.id)
    expect(fetched).not.toBeNull()
    const config = JSON.parse(fetched!.triggerConfig!)
    expect(config.source).toBe('claude-code')
  })

  it('stores claude-desktop source in triggerConfig', () => {
    const task = queries.createTask(db, {
      name: 'CD Task',
      prompt: 'Do something',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-desktop' })
    })

    const fetched = queries.getTask(db, task.id)
    const config = JSON.parse(fetched!.triggerConfig!)
    expect(config.source).toBe('claude-desktop')
  })

  it('stores quoroom UI source in triggerConfig', () => {
    const task = queries.createTask(db, {
      name: 'UI Task',
      prompt: 'Do something',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'quoroom' })
    })

    const fetched = queries.getTask(db, task.id)
    const config = JSON.parse(fetched!.triggerConfig!)
    expect(config.source).toBe('quoroom')
  })

  it('triggerConfig is null when not provided', () => {
    const task = queries.createTask(db, {
      name: 'No Source',
      prompt: 'Do something',
      triggerType: 'manual'
    })

    const fetched = queries.getTask(db, task.id)
    expect(fetched!.triggerConfig).toBeNull()
  })

  it('preserves triggerConfig through task lifecycle', () => {
    const task = queries.createTask(db, {
      name: 'Lifecycle Task',
      prompt: 'Do something',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-code' })
    })

    // Pause and resume
    queries.pauseTask(db, task.id)
    queries.resumeTask(db, task.id)

    // Update other fields
    queries.updateTask(db, task.id, { name: 'Renamed Task' })

    const fetched = queries.getTask(db, task.id)
    const config = JSON.parse(fetched!.triggerConfig!)
    expect(config.source).toBe('claude-code')
    expect(fetched!.name).toBe('Renamed Task')
  })

  it('lists tasks with different sources', () => {
    queries.createTask(db, {
      name: 'From CC',
      prompt: 'p1',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-code' })
    })
    queries.createTask(db, {
      name: 'From CD',
      prompt: 'p2',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-desktop' })
    })
    queries.createTask(db, {
      name: 'From UI',
      prompt: 'p3',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'quoroom' })
    })

    const tasks = queries.listTasks(db)
    expect(tasks.length).toBe(3)

    const sources = tasks.map(t => {
      if (!t.triggerConfig) return null
      return JSON.parse(t.triggerConfig).source
    })
    expect(sources).toContain('claude-code')
    expect(sources).toContain('claude-desktop')
    expect(sources).toContain('quoroom')
  })
})

// ─── Task Creation with All Trigger Types ──────────────────────

describe('task creation modes', () => {
  it('creates on-demand task with source', () => {
    const task = queries.createTask(db, {
      name: 'On Demand',
      prompt: 'Do it',
      triggerType: 'manual',
      triggerConfig: JSON.stringify({ source: 'claude-code' })
    })

    const fetched = queries.getTask(db, task.id)
    expect(fetched!.triggerType).toBe('manual')
    expect(JSON.parse(fetched!.triggerConfig!).source).toBe('claude-code')
  })

  it('creates cron task with source', () => {
    const task = queries.createTask(db, {
      name: 'Cron Job',
      prompt: 'Check stuff',
      triggerType: 'cron',
      cronExpression: '0 9 * * *',
      triggerConfig: JSON.stringify({ source: 'claude-desktop' })
    })

    const fetched = queries.getTask(db, task.id)
    expect(fetched!.triggerType).toBe('cron')
    expect(fetched!.cronExpression).toBe('0 9 * * *')
    expect(JSON.parse(fetched!.triggerConfig!).source).toBe('claude-desktop')
  })

  it('creates one-time task with source', () => {
    const scheduledAt = new Date(Date.now() + 3600000).toISOString()
    const task = queries.createTask(db, {
      name: 'One Time',
      prompt: 'Run once',
      triggerType: 'once',
      scheduledAt,
      triggerConfig: JSON.stringify({ source: 'quoroom' })
    })

    const fetched = queries.getTask(db, task.id)
    expect(fetched!.triggerType).toBe('once')
    expect(fetched!.scheduledAt).toBe(scheduledAt)
    expect(JSON.parse(fetched!.triggerConfig!).source).toBe('quoroom')
  })
})
