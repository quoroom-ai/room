import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as queries from './db-queries'
import type {
  Worker,
  WorkerPromptExportRequest,
  WorkerPromptExportResponse,
  WorkerPromptExportResult,
  WorkerPromptImportRequest,
  WorkerPromptImportResponse,
  WorkerPromptImportResult,
} from './types'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface ParsedWorkerPromptFile {
  frontmatter: Record<string, unknown>
  presentKeys: Set<string>
  body: string
}

interface ParsedMeta {
  workerId?: number
  roomId?: number | null
  name?: string
  role?: string | null
  description?: string | null
  model?: string | null
  isDefault?: boolean
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function findGitRoot(startDir: string): string | null {
  let current = resolve(startDir)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function isWithinRoot(root: string, maybePath: string): boolean {
  const rel = relative(root, maybePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function parseDbLocalTimestamp(value: string): number | null {
  const sqliteMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/
  )
  if (sqliteMatch) {
    const [, y, m, d, hh, mm, ss] = sqliteMatch
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime()
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function parseYamlQuotedString(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  return raw
}

function parseYamlScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '') return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return parseYamlQuotedString(value)
  }

  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null' || lower === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

function toYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

function parseOptionalInteger(
  obj: Record<string, unknown>,
  key: string,
  present: Set<string>,
  errors: string[],
  opts: { allowNull: boolean }
): number | null | undefined {
  if (!present.has(key)) return undefined
  const value = obj[key]
  if (value === null && opts.allowNull) return null
  const candidate = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN)
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate <= 0) {
    errors.push(`frontmatter.${key} must be a positive integer`)
    return undefined
  }
  return candidate
}

function parseOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  present: Set<string>,
  errors: string[]
): boolean | undefined {
  if (!present.has(key)) return undefined
  const value = obj[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }
  errors.push(`frontmatter.${key} must be boolean`)
  return undefined
}

function parseOptionalString(
  obj: Record<string, unknown>,
  key: string,
  present: Set<string>,
  errors: string[],
  opts: { allowNull: boolean; trim: boolean }
): string | null | undefined {
  if (!present.has(key)) return undefined
  const value = obj[key]
  if (value === null && opts.allowNull) return null
  if (typeof value !== 'string') {
    errors.push(`frontmatter.${key} must be string${opts.allowNull ? ' or null' : ''}`)
    return undefined
  }
  return opts.trim ? value.trim() : value
}

function parseMeta(parsed: ParsedWorkerPromptFile): { meta: ParsedMeta; errors: string[] } {
  const errors: string[] = []
  const { frontmatter, presentKeys } = parsed

  const workerId = parseOptionalInteger(frontmatter, 'worker_id', presentKeys, errors, { allowNull: true })
  const roomId = parseOptionalInteger(frontmatter, 'room_id', presentKeys, errors, { allowNull: true })
  const name = parseOptionalString(frontmatter, 'name', presentKeys, errors, { allowNull: false, trim: true })
  const role = parseOptionalString(frontmatter, 'role', presentKeys, errors, { allowNull: true, trim: false })
  const description = parseOptionalString(frontmatter, 'description', presentKeys, errors, { allowNull: true, trim: false })
  const model = parseOptionalString(frontmatter, 'model', presentKeys, errors, { allowNull: true, trim: false })
  const isDefault = parseOptionalBoolean(frontmatter, 'is_default', presentKeys, errors)

  if (presentKeys.has('name') && typeof name === 'string' && name.length === 0) {
    errors.push('frontmatter.name cannot be empty')
  }

  const meta: ParsedMeta = {}
  if (workerId !== undefined && workerId !== null) meta.workerId = workerId
  if (roomId !== undefined) meta.roomId = roomId
  if (name !== undefined && name !== null) meta.name = name
  if (role !== undefined) meta.role = role
  if (description !== undefined) meta.description = description
  if (model !== undefined) meta.model = model
  if (isDefault !== undefined) meta.isDefault = isDefault

  return { meta, errors }
}

function listMarkdownFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listMarkdownFilesRecursive(abs))
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(abs)
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function workerFilePath(baseDir: string, worker: Worker): string {
  const roomSegment = worker.roomId == null ? 'room-global' : `room-${worker.roomId}`
  return join(baseDir, roomSegment, `worker-${worker.id}.md`)
}

function ensureWorkerMaps(workers: Worker[]): {
  byId: Map<number, Worker>
  byRoomAndName: Map<string, Worker>
} {
  const byId = new Map<number, Worker>()
  const byRoomAndName = new Map<string, Worker>()
  for (const worker of workers) {
    byId.set(worker.id, worker)
    const key = `${worker.roomId ?? 'null'}::${worker.name}`
    byRoomAndName.set(key, worker)
  }
  return { byId, byRoomAndName }
}

function upsertWorkerMaps(
  maps: { byId: Map<number, Worker>; byRoomAndName: Map<string, Worker> },
  worker: Worker
): void {
  maps.byId.set(worker.id, worker)
  maps.byRoomAndName.set(`${worker.roomId ?? 'null'}::${worker.name}`, worker)
}

export function resolvePromptRepoRoot(cwd: string = process.cwd()): string {
  const explicit = process.env.QUOROOM_PROMPTS_ROOT?.trim()
  if (explicit) return resolve(explicit)
  return findGitRoot(cwd) ?? resolve(cwd)
}

export function getPromptBaseDir(root: string): string {
  return join(root, '.quoroom', 'prompts', 'workers')
}

export function safeResolveImportPath(repoRoot: string, inputPath: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new Error('Path is empty')
  }

  const rootResolved = resolve(repoRoot)
  const rootReal = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved
  const raw = inputPath.trim()
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(rootResolved, raw)
  const absReal = existsSync(abs) ? realpathSync(abs) : abs

  if (!isWithinRoot(rootReal, absReal)) {
    throw new Error(`Path is outside prompt root: ${raw}`)
  }

  return absReal
}

export function parsePromptFile(content: string): ParsedWorkerPromptFile {
  const normalized = normalizeLineEndings(content)
  const match = normalized.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error('Missing YAML frontmatter')
  }

  const rawFrontmatter = match[1]
  const body = match[2]
  const frontmatter: Record<string, unknown> = {}
  const presentKeys = new Set<string>()

  const lines = rawFrontmatter.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) {
      throw new Error(`Invalid frontmatter line: ${rawLine}`)
    }
    const key = line.slice(0, idx).trim().toLowerCase()
    const rawValue = line.slice(idx + 1)
    frontmatter[key] = parseYamlScalar(rawValue)
    presentKeys.add(key)
  }

  return {
    frontmatter,
    presentKeys,
    body,
  }
}

export function serializePromptFile(worker: Worker): string {
  const lines = [
    'version: 1',
    `worker_id: ${worker.id}`,
    `room_id: ${toYamlScalar(worker.roomId)}`,
    `name: ${toYamlScalar(worker.name)}`,
    `role: ${toYamlScalar(worker.role)}`,
    `description: ${toYamlScalar(worker.description)}`,
    `model: ${toYamlScalar(worker.model)}`,
    `is_default: ${toYamlScalar(worker.isDefault)}`,
  ]

  const body = normalizeLineEndings(worker.systemPrompt)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export function exportWorkerPrompts(
  db: Database.Database,
  options: WorkerPromptExportRequest = {}
): WorkerPromptExportResponse {
  const repoRoot = resolvePromptRepoRoot()
  const rootDir = getPromptBaseDir(repoRoot)
  mkdirSync(rootDir, { recursive: true })

  const force = options.force === true
  const requestedIds = Array.isArray(options.workerIds)
    ? new Set(options.workerIds.filter((id): id is number => Number.isInteger(id) && id > 0))
    : null

  const workers = options.roomId != null
    ? queries.listRoomWorkers(db, options.roomId)
    : queries.listWorkers(db)

  const matchedWorkers = requestedIds
    ? workers.filter(worker => requestedIds.has(worker.id))
    : workers

  const results: WorkerPromptExportResult[] = []

  if (requestedIds) {
    for (const requestedId of requestedIds) {
      if (!matchedWorkers.some(worker => worker.id === requestedId)) {
        results.push({
          status: 'error',
          workerId: requestedId,
          path: '',
          reason: 'worker_not_found'
        })
      }
    }
  }

  for (const worker of matchedWorkers) {
    const path = workerFilePath(rootDir, worker)
    mkdirSync(dirname(path), { recursive: true })

    try {
      const dbUpdatedMs = parseDbLocalTimestamp(worker.updatedAt) ?? 0
      if (!force && existsSync(path)) {
        const fileUpdatedMs = statSync(path).mtimeMs
        if (fileUpdatedMs > dbUpdatedMs) {
          results.push({
            status: 'skipped',
            workerId: worker.id,
            path,
            reason: 'file_newer_than_db'
          })
          continue
        }
      }

      writeFileSync(path, serializePromptFile(worker), 'utf-8')
      results.push({
        status: 'written',
        workerId: worker.id,
        path,
      })
    } catch (err) {
      results.push({
        status: 'error',
        workerId: worker.id,
        path,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return {
    rootDir,
    summary: {
      written: results.filter(r => r.status === 'written').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
    },
    results
  }
}

export function importWorkerPrompts(
  db: Database.Database,
  options: WorkerPromptImportRequest = {}
): WorkerPromptImportResponse {
  const repoRoot = resolvePromptRepoRoot()
  const rootDir = getPromptBaseDir(repoRoot)
  const force = options.force === true

  const results: WorkerPromptImportResult[] = []
  let candidatePaths: string[] = []
  if (Array.isArray(options.paths) && options.paths.length > 0) {
    const unique = new Set<string>()
    for (const rawPath of options.paths) {
      try {
        unique.add(safeResolveImportPath(repoRoot, rawPath))
      } catch (err) {
        results.push({
          status: 'error',
          path: rawPath,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
    candidatePaths = Array.from(unique)
  } else {
    candidatePaths = listMarkdownFilesRecursive(rootDir)
  }

  const maps = ensureWorkerMaps(queries.listWorkers(db))

  for (const filePath of candidatePaths) {
    try {
      const safePath = safeResolveImportPath(repoRoot, filePath)
      const fileStat = statSync(safePath)
      if (!fileStat.isFile()) {
        results.push({ status: 'error', path: safePath, reason: 'not_a_file' })
        continue
      }

      const parsed = parsePromptFile(readFileSync(safePath, 'utf-8'))
      const { meta, errors } = parseMeta(parsed)
      if (errors.length > 0) {
        results.push({ status: 'error', path: safePath, reason: errors.join('; ') })
        continue
      }

      const prompt = normalizeLineEndings(parsed.body)
      if (prompt.trim().length === 0) {
        results.push({ status: 'error', path: safePath, reason: 'prompt_body_empty' })
        continue
      }

      if (meta.roomId !== undefined && meta.roomId !== null && !queries.getRoom(db, meta.roomId)) {
        results.push({ status: 'error', path: safePath, reason: `invalid_room_id:${meta.roomId}` })
        continue
      }

      let existing: Worker | null = null
      if (meta.workerId !== undefined) {
        existing = maps.byId.get(meta.workerId) ?? null
      } else if (meta.name !== undefined) {
        const mappingRoomId = meta.roomId !== undefined ? meta.roomId : (options.roomId ?? null)
        const key = `${mappingRoomId ?? 'null'}::${meta.name}`
        existing = maps.byRoomAndName.get(key) ?? null
      }

      if (options.roomId != null) {
        if (existing && existing.roomId !== options.roomId) {
          results.push({ status: 'error', path: safePath, reason: 'room_mismatch' })
          continue
        }
        if (!existing && meta.roomId !== undefined && meta.roomId !== options.roomId) {
          results.push({ status: 'error', path: safePath, reason: 'room_mismatch' })
          continue
        }
      }

      if (existing) {
        const dbUpdatedMs = parseDbLocalTimestamp(existing.updatedAt) ?? 0
        if (!force && dbUpdatedMs > fileStat.mtimeMs) {
          results.push({
            status: 'skipped',
            workerId: existing.id,
            path: safePath,
            reason: 'db_newer_than_file'
          })
          continue
        }

        const updates: Record<string, unknown> = { systemPrompt: prompt }
        if (meta.name !== undefined) updates.name = meta.name
        if (meta.role !== undefined) updates.role = meta.role
        if (meta.description !== undefined) updates.description = meta.description
        if (meta.model !== undefined) updates.model = meta.model
        if (meta.isDefault !== undefined) updates.isDefault = meta.isDefault

        const hasChanges =
          prompt !== existing.systemPrompt
          || (meta.name !== undefined && meta.name !== existing.name)
          || (meta.role !== undefined && meta.role !== existing.role)
          || (meta.description !== undefined && meta.description !== existing.description)
          || (meta.model !== undefined && meta.model !== existing.model)
          || (meta.isDefault !== undefined && meta.isDefault !== existing.isDefault)

        if (!hasChanges) {
          results.push({
            status: 'skipped',
            workerId: existing.id,
            path: safePath,
            reason: 'up_to_date'
          })
          continue
        }

        queries.updateWorker(db, existing.id, updates as Parameters<typeof queries.updateWorker>[2])
        const updated = queries.getWorker(db, existing.id)
        if (!updated) {
          results.push({ status: 'error', path: safePath, reason: 'worker_missing_after_update' })
          continue
        }
        upsertWorkerMaps(maps, updated)
        results.push({ status: 'updated', workerId: updated.id, path: safePath })
        continue
      }

      const createRoomId = meta.roomId !== undefined ? meta.roomId : (options.roomId ?? null)
      if (createRoomId !== null && createRoomId !== undefined && !queries.getRoom(db, createRoomId)) {
        results.push({ status: 'error', path: safePath, reason: `invalid_room_id:${createRoomId}` })
        continue
      }

      const name = meta.name?.trim()
      if (!name) {
        results.push({ status: 'error', path: safePath, reason: 'name_required_for_create' })
        continue
      }

      const created = queries.createWorker(db, {
        name,
        role: meta.role ?? undefined,
        systemPrompt: prompt,
        description: meta.description ?? undefined,
        model: meta.model ?? undefined,
        isDefault: meta.isDefault,
        roomId: createRoomId ?? undefined,
      })

      upsertWorkerMaps(maps, created)
      results.push({ status: 'created', workerId: created.id, path: safePath })
    } catch (err) {
      results.push({
        status: 'error',
        path: filePath,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return {
    rootDir,
    summary: {
      updated: results.filter(r => r.status === 'updated').length,
      created: results.filter(r => r.status === 'created').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
    },
    results
  }
}
