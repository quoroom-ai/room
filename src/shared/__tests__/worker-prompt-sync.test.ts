import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import {
  exportWorkerPrompts,
  getPromptBaseDir,
  importWorkerPrompts,
  resolvePromptRepoRoot,
  safeResolveImportPath,
} from '../worker-prompt-sync'

let db: Database.Database
let rootDir: string
let prevPromptsRoot: string | undefined

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function makePromptFile(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`)
  return `---\n${lines.join('\n')}\n---\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

function setWorkerUpdatedAt(workerId: number, tsExpr: string): void {
  db.prepare(`UPDATE workers SET updated_at = datetime('now','localtime', ?) WHERE id = ?`).run(tsExpr, workerId)
}

beforeEach(() => {
  db = initTestDb()
  rootDir = mkdtempSync(join(tmpdir(), 'worker-prompt-sync-'))
  prevPromptsRoot = process.env.QUOROOM_PROMPTS_ROOT
  process.env.QUOROOM_PROMPTS_ROOT = rootDir
})

afterEach(() => {
  db.close()
  rmSync(rootDir, { recursive: true, force: true })
  if (prevPromptsRoot === undefined) {
    delete process.env.QUOROOM_PROMPTS_ROOT
  } else {
    process.env.QUOROOM_PROMPTS_ROOT = prevPromptsRoot
  }
})

describe('worker-prompt-sync', () => {
  it('export creates canonical markdown with frontmatter and body', () => {
    const room = queries.createRoom(db, 'Export Room')
    const worker = queries.createWorker(db, {
      name: 'Research Assistant',
      role: 'analyst',
      description: 'Find signals',
      systemPrompt: 'You are a focused researcher.\nUse citations.',
      model: 'openai:gpt-4o-mini',
      roomId: room.id,
    })

    const result = exportWorkerPrompts(db, { workerIds: [worker.id] })
    expect(result.summary.written).toBe(1)

    const filePath = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`, `worker-${worker.id}.md`)
    expect(existsSync(filePath)).toBe(true)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('version: 1')
    expect(content).toContain(`worker_id: ${worker.id}`)
    expect(content).toContain(`room_id: ${room.id}`)
    expect(content).toContain('name: "Research Assistant"')
    expect(content).toContain('is_default: false')
    expect(content).toContain('You are a focused researcher.')
  })

  it('export skips when file is newer and force=false', () => {
    const worker = queries.createWorker(db, { name: 'Alpha', systemPrompt: 'alpha' })
    exportWorkerPrompts(db, { workerIds: [worker.id] })

    const filePath = join(getPromptBaseDir(resolvePromptRepoRoot()), 'room-global', `worker-${worker.id}.md`)
    const future = new Date(Date.now() + 120_000)
    utimesSync(filePath, future, future)

    const result = exportWorkerPrompts(db, { workerIds: [worker.id], force: false })
    expect(result.summary.written).toBe(0)
    expect(result.summary.skipped).toBe(1)
    expect(result.results[0].reason).toBe('file_newer_than_db')
  })

  it('export overwrites when force=true', () => {
    const worker = queries.createWorker(db, { name: 'Bravo', systemPrompt: 'bravo' })
    exportWorkerPrompts(db, { workerIds: [worker.id] })

    const filePath = join(getPromptBaseDir(resolvePromptRepoRoot()), 'room-global', `worker-${worker.id}.md`)
    writeFileSync(filePath, makePromptFile({ version: 1, worker_id: worker.id, name: 'Bravo' }, 'stale'), 'utf-8')
    const future = new Date(Date.now() + 120_000)
    utimesSync(filePath, future, future)

    const result = exportWorkerPrompts(db, { workerIds: [worker.id], force: true })
    expect(result.summary.written).toBe(1)
    expect(readFileSync(filePath, 'utf-8')).toContain('bravo')
  })

  it('import updates an existing worker when file is newer', () => {
    const room = queries.createRoom(db, 'Import Room')
    const worker = queries.createWorker(db, {
      name: 'Updater',
      systemPrompt: 'old prompt',
      roomId: room.id,
      description: 'old desc',
    })
    setWorkerUpdatedAt(worker.id, '-2 hours')

    const filePath = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`, 'updater.md')
    mkdirSync(join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`), { recursive: true })
    writeFileSync(filePath, makePromptFile({
      version: 1,
      worker_id: worker.id,
      room_id: room.id,
      description: 'new desc',
    }, 'new prompt text'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [filePath] })
    expect(result.summary.updated).toBe(1)

    const updated = queries.getWorker(db, worker.id)
    expect(updated?.systemPrompt).toBe('new prompt text\n')
    expect(updated?.description).toBe('new desc')
  })

  it('import skips update when DB is newer than file and force=false', () => {
    const worker = queries.createWorker(db, { name: 'Fresh DB', systemPrompt: 'db prompt' })
    const baseDir = join(getPromptBaseDir(resolvePromptRepoRoot()), 'room-global')
    mkdirSync(baseDir, { recursive: true })
    const filePath = join(baseDir, 'fresh-db.md')
    writeFileSync(filePath, makePromptFile({ worker_id: worker.id, name: 'Fresh DB' }, 'file prompt'), 'utf-8')

    queries.updateWorker(db, worker.id, { description: 'db update marker' })
    const old = new Date(Date.now() - 120_000)
    utimesSync(filePath, old, old)

    const result = importWorkerPrompts(db, { paths: [filePath], force: false })
    expect(result.summary.skipped).toBe(1)
    expect(result.results[0].reason).toBe('db_newer_than_file')

    const after = queries.getWorker(db, worker.id)
    expect(after?.systemPrompt).toBe('db prompt')
  })

  it('import creates missing worker from markdown without worker_id', () => {
    const room = queries.createRoom(db, 'Create Room')
    const dir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'new-worker.md')
    writeFileSync(filePath, makePromptFile({
      version: 1,
      room_id: room.id,
      name: 'Created Worker',
      role: 'writer',
      is_default: true,
    }, 'created prompt'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [filePath] })
    expect(result.summary.created).toBe(1)

    const created = queries.listRoomWorkers(db, room.id).find(w => w.name === 'Created Worker')
    expect(created).toBeTruthy()
    expect(created?.systemPrompt).toBe('created prompt\n')
    expect(created?.role).toBe('writer')
    expect(created?.isDefault).toBe(true)
  })

  it('import mapping prioritizes worker_id over room_id+name', () => {
    const room = queries.createRoom(db, 'Priority Room')
    const byName = queries.createWorker(db, {
      name: 'Same Name',
      roomId: room.id,
      systemPrompt: 'name target',
    })
    const byId = queries.createWorker(db, {
      name: 'Different Name',
      roomId: room.id,
      systemPrompt: 'id target',
    })

    const dir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'priority.md')
    writeFileSync(filePath, makePromptFile({
      version: 1,
      worker_id: byId.id,
      room_id: room.id,
      name: byName.name,
    }, 'priority update'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [filePath] })
    expect(result.summary.updated).toBe(1)

    expect(queries.getWorker(db, byId.id)?.systemPrompt).toBe('priority update\n')
    expect(queries.getWorker(db, byName.id)?.systemPrompt).toBe('name target')
  })

  it('safe path resolver rejects traversal outside prompt root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'worker-prompt-outside-'))
    try {
      const outsideFile = join(outside, 'outside.md')
      writeFileSync(outsideFile, 'x', 'utf-8')
      expect(() => safeResolveImportPath(rootDir, outsideFile)).toThrow(/outside prompt root/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('invalid frontmatter yields file-level error while valid files still process', () => {
    const room = queries.createRoom(db, 'Validation Room')
    const base = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(base, { recursive: true })

    const bad = join(base, 'bad.md')
    writeFileSync(bad, makePromptFile({ room_id: 'oops', name: 'Bad Worker' }, 'bad prompt'), 'utf-8')

    const good = join(base, 'good.md')
    writeFileSync(good, makePromptFile({ room_id: room.id, name: 'Good Worker' }, 'good prompt'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [bad, good] })
    expect(result.summary.errors).toBe(1)
    expect(result.summary.created).toBe(1)
    expect(result.results.some(r => r.status === 'error' && (r.reason ?? '').includes('frontmatter.room_id'))).toBe(true)
    expect(queries.listRoomWorkers(db, room.id).some(w => w.name === 'Good Worker')).toBe(true)
  })

  it('export then import is idempotent (no updates on unchanged file)', () => {
    const worker = queries.createWorker(db, {
      name: 'Idempotent',
      systemPrompt: 'same prompt',
      description: 'same desc',
    })

    const exported = exportWorkerPrompts(db, { workerIds: [worker.id] })
    expect(exported.summary.written).toBe(1)

    const filePath = exported.results.find(r => r.status === 'written')?.path
    expect(filePath).toBeTruthy()

    const imported = importWorkerPrompts(db, { paths: [filePath!] })
    expect(imported.summary.updated).toBe(0)
    expect(imported.summary.created).toBe(0)
    expect(imported.summary.skipped).toBeGreaterThanOrEqual(1)
    expect(imported.results[0].reason).toBe('up_to_date')
  })

  it('import discovers markdown files when paths are omitted', () => {
    const room = queries.createRoom(db, 'Autodiscover Room')
    const dir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(dir, { recursive: true })

    writeFileSync(join(dir, 'a.md'), makePromptFile({ room_id: room.id, name: 'Auto A' }, 'prompt A'), 'utf-8')
    writeFileSync(join(dir, 'b.md'), makePromptFile({ room_id: room.id, name: 'Auto B' }, 'prompt B'), 'utf-8')

    const result = importWorkerPrompts(db, { roomId: room.id })
    expect(result.summary.created).toBe(2)
    expect(queries.listRoomWorkers(db, room.id).some(w => w.name === 'Auto A')).toBe(true)
    expect(queries.listRoomWorkers(db, room.id).some(w => w.name === 'Auto B')).toBe(true)
  })

  it('import maps by exact room_id+name when worker_id is absent', () => {
    const room = queries.createRoom(db, 'Room Name Match')
    const worker = queries.createWorker(db, {
      name: 'Exact Match',
      roomId: room.id,
      systemPrompt: 'before',
    })
    setWorkerUpdatedAt(worker.id, '-2 hours')

    const dir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'match.md')
    writeFileSync(filePath, makePromptFile({ room_id: room.id, name: 'Exact Match' }, 'after'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [filePath] })
    expect(result.summary.updated).toBe(1)
    expect(result.summary.created).toBe(0)
    expect(queries.getWorker(db, worker.id)?.systemPrompt).toBe('after\n')
  })

  it('import create uses request roomId fallback when frontmatter room_id is omitted', () => {
    const room = queries.createRoom(db, 'Request Room Fallback')
    const dir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'fallback.md')
    writeFileSync(filePath, makePromptFile({ name: 'Fallback Worker' }, 'fallback prompt'), 'utf-8')

    const result = importWorkerPrompts(db, { paths: [filePath], roomId: room.id })
    expect(result.summary.created).toBe(1)
    const created = queries.listRoomWorkers(db, room.id).find(w => w.name === 'Fallback Worker')
    expect(created?.roomId).toBe(room.id)
  })

  it('import continues when one explicit path is outside root and another is valid', () => {
    const room = queries.createRoom(db, 'Path Batch Room')
    const validDir = join(getPromptBaseDir(resolvePromptRepoRoot()), `room-${room.id}`)
    mkdirSync(validDir, { recursive: true })
    const validPath = join(validDir, 'ok.md')
    writeFileSync(validPath, makePromptFile({ room_id: room.id, name: 'OK Worker' }, 'ok prompt'), 'utf-8')

    const outsideRoot = mkdtempSync(join(tmpdir(), 'worker-path-outside-'))
    const outsidePath = join(outsideRoot, 'outside.md')
    writeFileSync(outsidePath, makePromptFile({ name: 'Outside' }, 'outside prompt'), 'utf-8')

    try {
      const result = importWorkerPrompts(db, { paths: [outsidePath, validPath] })
      expect(result.summary.errors).toBe(1)
      expect(result.summary.created).toBe(1)
      expect(result.results.some(r => r.path === outsidePath && r.status === 'error')).toBe(true)
      expect(queries.listRoomWorkers(db, room.id).some(w => w.name === 'OK Worker')).toBe(true)
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('export reports missing worker ids as errors while exporting existing ones', () => {
    const worker = queries.createWorker(db, { name: 'Exists', systemPrompt: 'exists' })
    const result = exportWorkerPrompts(db, { workerIds: [worker.id, 999999] })

    expect(result.summary.written).toBe(1)
    expect(result.summary.errors).toBe(1)
    expect(result.results.some(r => r.workerId === 999999 && r.status === 'error' && r.reason === 'worker_not_found')).toBe(true)
  })
})
