import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { executeAgent } from '../shared/agent-executor'
import * as queries from '../shared/db-queries'
import { getModelProvider } from '../shared/model-provider'
import { probeProviderConnected, probeProviderInstalled } from './provider-cli'
import type { ToolDef } from '../shared/queen-tools'
import {
  CLERK_FALLBACK_ANTHROPIC_MODEL,
  CLERK_FALLBACK_OPENAI_MODEL,
  CLERK_FALLBACK_SUBSCRIPTION_MODEL,
  CLERK_PROJECT_DOC_CONTENT_MAX,
  CLERK_PROJECT_DOC_SPECS,
  CLERK_PROJECT_DOC_SYNC_MIN_MS,
  DEFAULT_CLERK_MODEL,
  type ClerkProjectDocSpec,
} from '../shared/clerk-profile-config'

export type ClerkApiProvider = 'openai_api' | 'anthropic_api' | 'gemini_api'

export interface ClerkApiAuthState {
  hasRoomCredential: boolean
  hasSavedKey: boolean
  hasEnvKey: boolean
  ready: boolean
  maskedKey: string | null
}

export interface ClerkExecutionOptions {
  db: Database.Database
  preferredModel: string | null | undefined
  prompt: string
  systemPrompt: string
  resumeSessionId?: string
  maxTurns?: number
  timeoutMs?: number
  toolDefs?: ToolDef[]
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>
}

export interface ClerkExecutionOutcome {
  ok: boolean
  model: string
  output: string
  sessionId: string | null
  timedOut: boolean
  usedFallback: boolean
  statusCode: number
  error: string | null
  attempts: Array<{ model: string; error: string }>
  usage: { inputTokens: number; outputTokens: number }
}

let lastProjectDocSyncAt = 0
let lastProjectDocSnapshot = 'Project docs memory not synced yet.'

function findAnyRoomCredential(db: Database.Database, credentialName: 'openai_api_key' | 'anthropic_api_key' | 'gemini_api_key'): string | null {
  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    const credential = queries.getCredentialByName(db, room.id, credentialName)
    if (!credential) continue
    const value = (credential.valueEncrypted || '').trim()
    if (!value || value.startsWith('enc:v1:')) continue
    return value
  }
  return null
}

function maskKey(key: string | null): string | null {
  if (!key) return null
  const trimmed = key.trim()
  if (trimmed.length <= 8) return `${trimmed.slice(0, 3)}...`
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`
}

function getClerkApiAuthState(db: Database.Database, provider: ClerkApiProvider): ClerkApiAuthState {
  const credentialName = provider === 'openai_api' ? 'openai_api_key' : provider === 'gemini_api' ? 'gemini_api_key' : 'anthropic_api_key'
  const envVar = provider === 'openai_api' ? 'OPENAI_API_KEY' : provider === 'gemini_api' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'
  const roomCredential = findAnyRoomCredential(db, credentialName)
  const savedKey = queries.getClerkApiKey(db, provider)
  const envKey = (process.env[envVar] || '').trim() || null
  const activeKey = roomCredential || savedKey || envKey
  return {
    hasRoomCredential: Boolean(roomCredential),
    hasSavedKey: Boolean(savedKey),
    hasEnvKey: Boolean(envKey),
    ready: Boolean(activeKey),
    maskedKey: maskKey(activeKey),
  }
}

export function getClerkApiAuth(db: Database.Database): { openai: ClerkApiAuthState; anthropic: ClerkApiAuthState; gemini: ClerkApiAuthState } {
  return {
    openai: getClerkApiAuthState(db, 'openai_api'),
    anthropic: getClerkApiAuthState(db, 'anthropic_api'),
    gemini: getClerkApiAuthState(db, 'gemini_api'),
  }
}

/**
 * Detect the best available provider and return a model string, or null if nothing usable.
 * Priority: claude CLI → codex CLI → openai API key → anthropic API key.
 */
export function autoConfigureClerkModel(db: Database.Database): string | null {
  if (probeProviderInstalled('claude').installed) return DEFAULT_CLERK_MODEL
  const codex = probeProviderInstalled('codex')
  if (codex.installed && probeProviderConnected('codex') === true) return CLERK_FALLBACK_SUBSCRIPTION_MODEL
  const apiAuth = getClerkApiAuth(db)
  if (apiAuth.openai.ready) return CLERK_FALLBACK_OPENAI_MODEL
  if (apiAuth.anthropic.ready) return CLERK_FALLBACK_ANTHROPIC_MODEL
  return null
}

export function getClerkPreferredModel(db: Database.Database, fallbackModel: string = DEFAULT_CLERK_MODEL): string {
  return queries.getSetting(db, 'clerk_model') || fallbackModel
}

export function resolveClerkApiKey(db: Database.Database, model: string | null | undefined): string | undefined {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return findAnyRoomCredential(db, 'openai_api_key')
      || queries.getClerkApiKey(db, 'openai_api')
      || (process.env.OPENAI_API_KEY || undefined)
  }
  if (provider === 'anthropic_api') {
    return findAnyRoomCredential(db, 'anthropic_api_key')
      || queries.getClerkApiKey(db, 'anthropic_api')
      || (process.env.ANTHROPIC_API_KEY || undefined)
  }
  if (provider === 'gemini_api') {
    return findAnyRoomCredential(db, 'gemini_api_key')
      || queries.getClerkApiKey(db, 'gemini_api')
      || (process.env.GEMINI_API_KEY || undefined)
  }
  return undefined
}

function clipText(value: string, max = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3))}...`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readProjectFile(relPath: string): string | null {
  const abs = resolve(process.cwd(), relPath)
  if (!existsSync(abs)) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function summarizeMarkdown(content: string): string {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
  const headings = lines
    .filter((line) => /^#{1,6}\s+/.test(line))
    .slice(0, 10)
  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line))
    .slice(0, 12)
  const introParagraph = lines
    .filter((line) => !/^#{1,6}\s+/.test(line) && !/^[-*]\s+/.test(line))
    .slice(0, 6)
    .join(' ')

  const parts: string[] = []
  if (headings.length > 0) parts.push(`Headings: ${headings.map((h) => h.replace(/^#{1,6}\s+/, '')).join(' | ')}`)
  if (bullets.length > 0) parts.push(`Key bullets: ${bullets.map((b) => b.replace(/^[-*]\s+/, '')).join(' | ')}`)
  if (introParagraph) parts.push(`Intro: ${clipText(introParagraph, 700)}`)
  return parts.join('\n') || clipText(content, 1200)
}

function summarizeSource(content: string): string {
  const matches = content.matchAll(/'([^'\n]{8,160})'|"([^"\n]{8,160})"|`([^`\n]{8,160})`/g)
  const unique = new Set<string>()
  const picked: string[] = []
  for (const match of matches) {
    const raw = (match[1] || match[2] || match[3] || '').trim()
    if (!raw) continue
    if (raw.includes('${')) continue
    if (!/[a-zA-Z]/.test(raw)) continue
    if (raw.split(/\s+/).length < 2) continue
    if (/^(https?:\/\/|\/api\/|[a-z0-9_.-]+\/[a-z0-9_.-]+)$/i.test(raw)) continue
    const candidate = raw.replace(/\s+/g, ' ')
    const key = candidate.toLowerCase()
    if (unique.has(key)) continue
    unique.add(key)
    picked.push(candidate)
    if (picked.length >= 20) break
  }
  if (picked.length === 0) return clipText(content, 1200)
  return `Key UI strings: ${picked.map((line) => clipText(line, 120)).join(' | ')}`
}

function buildProjectDocSummary(spec: ClerkProjectDocSpec, content: string): string {
  if (spec.kind === 'markdown') return summarizeMarkdown(content)
  return summarizeSource(content)
}

function ensureProjectDocEntity(db: Database.Database, name: string): { id: number; name: string } {
  const existing = queries.listEntities(db, undefined, 'project_context')
    .find((entity) => entity.name === name)
  if (existing) return { id: existing.id, name: existing.name }
  const created = queries.createEntity(db, name, 'project', 'project_context')
  return { id: created.id, name: created.name }
}

function extractSummaryBlock(content: string): string {
  const startMarker = 'Summary:\n'
  const endMarker = '\n\nFullContent:\n'
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker)
  if (start >= 0 && end > start) {
    return content.slice(start + startMarker.length, end).trim()
  }
  return clipText(content, 1200)
}

function buildProjectDocsSnapshot(db: Database.Database): string {
  const scoped = queries.listEntities(db, undefined, 'project_context')
  const lines: string[] = []

  for (const spec of CLERK_PROJECT_DOC_SPECS) {
    const entity = scoped.find((candidate) => candidate.name === spec.entityName)
    if (!entity) continue
    const latest = queries.getObservations(db, entity.id)[0]
    if (!latest) continue
    const summary = extractSummaryBlock(latest.content)
    const sourceDate = latest.created_at
    lines.push(`### ${spec.entityName} (${sourceDate})`)
    lines.push(summary)
  }

  if (lines.length === 0) return 'Project docs memory is empty.'
  return lines.join('\n')
}

export function syncProjectDocsMemory(db: Database.Database): string {
  const now = Date.now()
  if (now - lastProjectDocSyncAt < CLERK_PROJECT_DOC_SYNC_MIN_MS) {
    return lastProjectDocSnapshot
  }

  for (const spec of CLERK_PROJECT_DOC_SPECS) {
    const content = readProjectFile(spec.relPath)
    if (!content) continue
    const normalized = content.trim()
    if (!normalized) continue
    const fullContent = normalized.length > CLERK_PROJECT_DOC_CONTENT_MAX
      ? `${normalized.slice(0, CLERK_PROJECT_DOC_CONTENT_MAX)}\n\n[truncated]`
      : normalized
    const hash = sha256(fullContent)
    const prevHash = queries.getSetting(db, spec.hashSettingKey)?.trim() ?? ''
    if (prevHash === hash) continue

    const entity = ensureProjectDocEntity(db, spec.entityName)
    const summary = buildProjectDocSummary(spec, fullContent)
    const observation = [
      `Source: ${spec.relPath}`,
      `SHA256: ${hash}`,
      'Summary:',
      summary,
      '',
      'FullContent:',
      fullContent
    ].join('\n')
    queries.addObservation(db, entity.id, observation, 'clerk_project_sync')
    queries.setSetting(db, spec.hashSettingKey, hash)
  }

  lastProjectDocSnapshot = buildProjectDocsSnapshot(db)
  lastProjectDocSyncAt = now
  return lastProjectDocSnapshot
}

function uniquePush(target: string[], value: string): void {
  const normalized = value.trim()
  if (!normalized) return
  if (!target.includes(normalized)) target.push(normalized)
}

function buildClerkModelPlan(preferredModel: string): string[] {
  const resolved = preferredModel.trim() || DEFAULT_CLERK_MODEL
  const provider = getModelProvider(resolved)
  const plan: string[] = []
  uniquePush(plan, resolved)

  if (provider === 'claude_subscription') {
    uniquePush(plan, CLERK_FALLBACK_SUBSCRIPTION_MODEL)
    uniquePush(plan, CLERK_FALLBACK_OPENAI_MODEL)
    uniquePush(plan, CLERK_FALLBACK_ANTHROPIC_MODEL)
  } else if (provider === 'codex_subscription') {
    uniquePush(plan, CLERK_FALLBACK_OPENAI_MODEL)
    uniquePush(plan, DEFAULT_CLERK_MODEL)
    uniquePush(plan, CLERK_FALLBACK_ANTHROPIC_MODEL)
  } else if (provider === 'openai_api') {
    uniquePush(plan, CLERK_FALLBACK_SUBSCRIPTION_MODEL)
    uniquePush(plan, DEFAULT_CLERK_MODEL)
    uniquePush(plan, CLERK_FALLBACK_ANTHROPIC_MODEL)
  } else if (provider === 'anthropic_api') {
    uniquePush(plan, CLERK_FALLBACK_SUBSCRIPTION_MODEL)
    uniquePush(plan, CLERK_FALLBACK_OPENAI_MODEL)
    uniquePush(plan, DEFAULT_CLERK_MODEL)
  } else if (provider === 'gemini_api') {
    uniquePush(plan, CLERK_FALLBACK_SUBSCRIPTION_MODEL)
    uniquePush(plan, CLERK_FALLBACK_OPENAI_MODEL)
    uniquePush(plan, DEFAULT_CLERK_MODEL)
    uniquePush(plan, CLERK_FALLBACK_ANTHROPIC_MODEL)
  }

  return plan
}

interface ClerkExecutionCandidate {
  model: string
  apiKey?: string
}

function buildExecutionCandidates(db: Database.Database, preferredModel: string): ClerkExecutionCandidate[] {
  const candidates: ClerkExecutionCandidate[] = []
  for (const model of buildClerkModelPlan(preferredModel)) {
    const provider = getModelProvider(model)
    const apiKey = resolveClerkApiKey(db, model)
    if ((provider === 'openai_api' || provider === 'anthropic_api' || provider === 'gemini_api') && !apiKey) continue
    candidates.push({ model, apiKey })
  }
  if (candidates.length === 0) {
    candidates.push({ model: DEFAULT_CLERK_MODEL })
  }
  return candidates
}

function deriveExecutionFailure(result: { timedOut: boolean; exitCode: number; output: string }, model: string): string {
  const raw = result.output.trim()
  if (result.timedOut) return `Clerk request timed out (model: ${model})`
  if (raw) return raw
  return `Clerk execution failed (model: ${model}, exit code: ${result.exitCode})`
}

export function isRateLimitFailure(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('rate limit')
    || lower.includes('limit reached')
    || lower.includes('too many requests')
    || lower.includes('insufficient_quota')
    || lower.includes('quota')
    || lower.includes('429')
    || (lower.includes('limit') && lower.includes('reset'))
}

function isTransientFailure(message: string, timedOut: boolean): boolean {
  if (timedOut) return true
  if (isRateLimitFailure(message)) return true
  const lower = message.toLowerCase()
  return lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('temporarily unavailable')
    || lower.includes('service unavailable')
    || lower.includes('connection reset')
    || lower.includes('socket hang up')
    || lower.includes('econnreset')
    || lower.includes('etimedout')
    || lower.includes('eai_again')
}

export async function executeClerkWithFallback(options: ClerkExecutionOptions): Promise<ClerkExecutionOutcome> {
  const preferred = options.preferredModel?.trim() || DEFAULT_CLERK_MODEL
  const candidates = buildExecutionCandidates(options.db, preferred)
  const attempts: Array<{ model: string; error: string }> = []
  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const result = await executeAgent({
      model: candidate.model,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      resumeSessionId: options.resumeSessionId,
      apiKey: candidate.apiKey,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
      toolDefs: options.toolDefs,
      onToolCall: options.onToolCall
    })
    totalInputTokens += result.usage?.inputTokens ?? 0
    totalOutputTokens += result.usage?.outputTokens ?? 0

    if (result.exitCode === 0 && !result.timedOut) {
      return {
        ok: true,
        model: candidate.model,
        output: result.output || 'No response',
        sessionId: result.sessionId,
        timedOut: false,
        usedFallback: i > 0,
        statusCode: 200,
        error: null,
        attempts,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
      }
    }

    const error = deriveExecutionFailure(result, candidate.model)
    attempts.push({ model: candidate.model, error })

    const hasMoreCandidates = i < candidates.length - 1
    if (!hasMoreCandidates || !isTransientFailure(error, result.timedOut)) {
      return {
        ok: false,
        model: candidate.model,
        output: '',
        sessionId: result.sessionId,
        timedOut: result.timedOut,
        usedFallback: i > 0,
        statusCode: result.timedOut ? 504 : 502,
        error,
        attempts,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
      }
    }
  }

  return {
    ok: false,
    model: preferred,
    output: '',
    sessionId: null,
    timedOut: false,
    usedFallback: false,
    statusCode: 502,
    error: `Clerk execution failed (model: ${preferred})`,
    attempts,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
  }
}
