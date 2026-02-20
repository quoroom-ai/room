import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

afterEach(() => {
  db.close()
})

// ─── Settings ──────────────────────────────────────────────────

describe('settings', () => {
  function getSetting(key: string): string | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  function setSetting(key: string, value: string): void {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now','localtime')`
    ).run(key, value, value)
  }

  function getAllSettings(): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) result[row.key] = row.value
    return result
  }

  it('returns null for non-existent setting', () => {
    expect(getSetting('unknown')).toBeNull()
  })

  it('sets and gets a setting', () => {
    setSetting('theme', 'dark')
    expect(getSetting('theme')).toBe('dark')
  })

  it('overwrites existing setting', () => {
    setSetting('theme', 'dark')
    setSetting('theme', 'light')
    expect(getSetting('theme')).toBe('light')
  })

  it('getAllSettings returns all key-value pairs', () => {
    setSetting('a', '1')
    setSetting('b', '2')
    const all = getAllSettings()
    expect(all).toEqual({ a: '1', b: '2' })
  })

  it('getAllSettings returns empty object when no settings', () => {
    expect(getAllSettings()).toEqual({})
  })
})

// ─── Watches ───────────────────────────────────────────────────

describe('watches', () => {
  interface Watch {
    id: number
    path: string
    description: string | null
    actionPrompt: string | null
    status: string
    lastTriggered: string | null
    triggerCount: number
    createdAt: string
  }

  function mapWatchRow(row: Record<string, unknown>): Watch {
    return {
      id: row.id as number,
      path: row.path as string,
      description: row.description as string | null,
      actionPrompt: row.action_prompt as string | null,
      status: row.status as string,
      lastTriggered: row.last_triggered as string | null,
      triggerCount: row.trigger_count as number,
      createdAt: row.created_at as string
    }
  }

  function createWatch(path: string, description?: string, actionPrompt?: string): Watch {
    const result = db
      .prepare('INSERT INTO watches (path, description, action_prompt) VALUES (?, ?, ?)')
      .run(path, description ?? null, actionPrompt ?? null)
    const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
    return mapWatchRow(row)
  }

  function listWatches(status?: string): Watch[] {
    const rows = status
      ? db.prepare('SELECT * FROM watches WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all()
    return (rows as Record<string, unknown>[]).map(mapWatchRow)
  }

  function deleteWatch(id: number): void {
    db.prepare('DELETE FROM watches WHERE id = ?').run(id)
  }

  it('creates a watch with all fields', () => {
    const watch = createWatch('/home/user/docs', 'Watch docs folder', 'Summarize new files')
    expect(watch.id).toBe(1)
    expect(watch.path).toBe('/home/user/docs')
    expect(watch.description).toBe('Watch docs folder')
    expect(watch.actionPrompt).toBe('Summarize new files')
    expect(watch.status).toBe('active')
    expect(watch.triggerCount).toBe(0)
    expect(watch.lastTriggered).toBeNull()
  })

  it('creates a watch with minimal fields', () => {
    const watch = createWatch('/tmp')
    expect(watch.path).toBe('/tmp')
    expect(watch.description).toBeNull()
    expect(watch.actionPrompt).toBeNull()
  })

  it('lists all watches', () => {
    createWatch('/a')
    createWatch('/b')
    expect(listWatches()).toHaveLength(2)
  })

  it('lists watches by status', () => {
    createWatch('/a')
    createWatch('/b')
    expect(listWatches('active')).toHaveLength(2)
    expect(listWatches('inactive')).toHaveLength(0)
  })

  it('deletes a watch', () => {
    const watch = createWatch('/a')
    deleteWatch(watch.id)
    expect(listWatches()).toHaveLength(0)
  })

  function pauseWatch(id: number): void {
    db.prepare("UPDATE watches SET status = 'paused' WHERE id = ?").run(id)
  }

  function resumeWatch(id: number): void {
    db.prepare("UPDATE watches SET status = 'active' WHERE id = ?").run(id)
  }

  it('pauses a watch', () => {
    const watch = createWatch('/a')
    expect(watch.status).toBe('active')
    pauseWatch(watch.id)
    const watches = listWatches()
    expect(watches[0].status).toBe('paused')
  })

  it('resumes a paused watch', () => {
    const watch = createWatch('/a')
    pauseWatch(watch.id)
    resumeWatch(watch.id)
    const watches = listWatches()
    expect(watches[0].status).toBe('active')
  })

  it('paused watches are excluded from active filter', () => {
    createWatch('/a')
    const watch2 = createWatch('/b')
    pauseWatch(watch2.id)
    expect(listWatches('active')).toHaveLength(1)
    expect(listWatches('paused')).toHaveLength(1)
    expect(listWatches()).toHaveLength(2)
  })
})
