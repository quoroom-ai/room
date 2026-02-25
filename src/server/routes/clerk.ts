import type { Router } from '../router'
import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { CLERK_TOOL_DEFINITIONS, executeClerkTool } from '../../shared/clerk-tools'
import { sendKeeperEmail } from '../keeper-email'
import {
  autoConfigureClerkModel,
  executeClerkWithFallback,
  getClerkApiAuth,
  syncProjectDocsMemory,
} from '../clerk-profile'
import { insertClerkMessageAndEmit } from '../clerk-message-events'
import { DEFAULT_CLERK_MODEL } from '../../shared/clerk-profile-config'

const VALIDATION_TIMEOUT_MS = 8000
const CLERK_RECENT_LOG_LIMIT = 120
const CLERK_LOG_LINE_MAX = 240
const CLERK_SUMMARY_ITEM_LIMIT = 8
const CLERK_COMMENTARY_HOLD_COUNT_KEY = 'clerk_commentary_hold_count'
const CLERK_LAST_ASSISTANT_REPLY_AT_KEY = 'clerk_last_assistant_reply_at'
const CLERK_COMMENTARY_MODE_KEY = 'clerk_commentary_mode'
const CLERK_USER_PRESENCE_TIMEOUT_MS = 90_000

type ClerkCommentaryMode = 'auto' | 'light'
type ClerkCommentaryPace = 'active' | 'light'

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function getCommentaryMode(db: Database.Database): ClerkCommentaryMode {
  const mode = (queries.getSetting(db, CLERK_COMMENTARY_MODE_KEY) ?? '').trim().toLowerCase()
  return mode === 'light' ? 'light' : 'auto'
}

function isKeeperPresent(db: Database.Database): boolean {
  const lastSeenMs = parseIsoMs(queries.getSetting(db, 'clerk_user_last_seen_at'))
  const lastInteractionMs = parseIsoMs(queries.getSetting(db, 'clerk_last_user_message_at'))
  const newest = Math.max(lastSeenMs ?? 0, lastInteractionMs ?? 0)
  if (newest <= 0) return false
  return Date.now() - newest < CLERK_USER_PRESENCE_TIMEOUT_MS
}

function getCommentaryPace(db: Database.Database): ClerkCommentaryPace {
  const mode = getCommentaryMode(db)
  if (mode === 'light') return 'light'
  return isKeeperPresent(db) ? 'active' : 'light'
}

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) return record.message
  if (typeof record.error === 'string' && record.error.trim()) return record.error
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message
    if (typeof nested.type === 'string' && nested.type.trim()) return nested.type
  }
  return null
}

async function validateOpenAiKey(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/models?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
      signal: controller.signal
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    const message = extractApiError(body) || `HTTP ${res.status}`
    return { ok: false, error: `OpenAI key validation failed: ${message}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `OpenAI key validation failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

async function validateAnthropicKey(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': value,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    const message = extractApiError(body) || `HTTP ${res.status}`
    return { ok: false, error: `Anthropic key validation failed: ${message}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Anthropic key validation failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

type ClerkLogEntry = ReturnType<typeof queries.listClerkMessages>[number]

function clipText(value: string, max: number = CLERK_LOG_LINE_MAX): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3))}...`
}

function formatLogEntry(entry: ClerkLogEntry): string {
  const sourceLabel = entry.source ? ` (${entry.source})` : ''
  return `[${entry.createdAt}] ${entry.role}${sourceLabel}: ${clipText(entry.content)}`
}

function pickRecentUnique(
  entries: ClerkLogEntry[],
  predicate: (entry: ClerkLogEntry) => boolean,
  limit: number = CLERK_SUMMARY_ITEM_LIMIT
): string[] {
  const picked: string[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0 && picked.length < limit; i--) {
    const entry = entries[i]
    if (!predicate(entry)) continue
    const text = clipText(entry.content, 180)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    picked.push(text)
  }
  return picked
}

function buildOlderLogSummary(olderEntries: ClerkLogEntry[]): string {
  if (olderEntries.length === 0) return ''

  const roleCounts = olderEntries.reduce((acc, entry) => {
    acc[entry.role] = (acc[entry.role] ?? 0) + 1
    return acc
  }, { user: 0, assistant: 0, commentary: 0 } as Record<'user' | 'assistant' | 'commentary', number>)

  const keeperIntents = pickRecentUnique(olderEntries, (entry) => entry.role === 'user')
  const notableActions = pickRecentUnique(
    olderEntries,
    (entry) => (entry.role === 'assistant' || entry.role === 'commentary')
      && /\b(created|updated|deleted|paused|restarted|scheduled|sent|set|connected|configured|stopped|started|queued|reminder|task|room|worker|goal|setting)\b/i.test(entry.content)
  )
  const warnings = pickRecentUnique(
    olderEntries,
    (entry) => /\b(error|failed|forbidden|limit|timeout|denied|blocked|unknown)\b/i.test(entry.content)
  )

  const lines: string[] = []
  lines.push(`Older log retained in DB: ${olderEntries.length} messages.`)
  lines.push(`Role counts: user=${roleCounts.user}, assistant=${roleCounts.assistant}, commentary=${roleCounts.commentary}.`)
  if (keeperIntents.length > 0) lines.push(`Recent keeper intents: ${keeperIntents.join(' | ')}`)
  if (notableActions.length > 0) lines.push(`Notable actions/outcomes: ${notableActions.join(' | ')}`)
  if (warnings.length > 0) lines.push(`Warnings/errors seen: ${warnings.join(' | ')}`)
  return lines.join('\n')
}

function buildClerkLogContext(log: ClerkLogEntry[]): { summary: string; recent: string } {
  if (log.length === 0) {
    return {
      summary: 'No prior clerk messages.',
      recent: '(none)'
    }
  }

  if (log.length <= CLERK_RECENT_LOG_LIMIT) {
    return {
      summary: `Older log summary not needed (total messages: ${log.length}).`,
      recent: log.map(formatLogEntry).join('\n')
    }
  }

  const splitIndex = Math.max(0, log.length - CLERK_RECENT_LOG_LIMIT)
  const older = log.slice(0, splitIndex)
  const recent = log.slice(splitIndex)
  return {
    summary: buildOlderLogSummary(older),
    recent: recent.map(formatLogEntry).join('\n')
  }
}

/** Build a system-wide context snapshot for the clerk */
function buildClerkContext(db: Database.Database, projectDocsSnapshot?: string): string {
  const rooms = queries.listRooms(db)
  const activeRooms = rooms.filter(r => r.status !== 'stopped')

  const parts: string[] = []

  // Rooms overview
  if (activeRooms.length > 0) {
    parts.push('## Active Rooms')
    for (const room of activeRooms) {
      const goals = queries.listGoals(db, room.id).filter(g => g.status === 'active' || g.status === 'in_progress')
      const workers = queries.listRoomWorkers(db, room.id)
      const queenLabel = room.queenNickname ? `, queen: ${room.queenNickname}` : ''
      parts.push(`- **${room.name}** (id:${room.id}, status:${room.status}, model:${room.workerModel}${queenLabel})`)
      if (room.goal) parts.push(`  Objective: ${room.goal}`)
      if (goals.length > 0) parts.push(`  Goals: ${goals.map(g => `${g.description} (${Math.round(g.progress * 100)}%)`).join(', ')}`)
      if (workers.length > 0) parts.push(`  Workers: ${workers.map(w => w.name).join(', ')}`)
    }
  } else {
    parts.push('No active rooms.')
  }

  // Keeper info
  const referralCode = queries.getSetting(db, 'keeper_referral_code')
  const userNumber = queries.getSetting(db, 'keeper_user_number')
  if (referralCode || userNumber) {
    parts.push('\n## Keeper Info')
    if (userNumber) parts.push(`- User number: ${userNumber}`)
    if (referralCode) parts.push(`- Referral code: ${referralCode}`)
  }

  // Recent activity across all rooms
  const recentActivity: string[] = []
  for (const room of activeRooms.slice(0, 5)) {
    const activity = queries.getRoomActivity(db, room.id, 5)
    for (const a of activity) {
      recentActivity.push(`[${room.name}] ${a.eventType}: ${a.summary}`)
    }
  }
  if (recentActivity.length > 0) {
    parts.push('\n## Recent Activity')
    parts.push(recentActivity.slice(0, 15).join('\n'))
  }

  const pendingKeeperRequests: string[] = []
  for (const room of activeRooms.slice(0, 10)) {
    const escalations = queries
      .getPendingEscalations(db, room.id)
      .filter((item) => item.toAgentId == null)
    for (const escalation of escalations.slice(0, 4)) {
      const fromLabel = escalation.fromAgentId
        ? (queries.getWorker(db, escalation.fromAgentId)?.name ?? `worker #${escalation.fromAgentId}`)
        : 'agent'
      pendingKeeperRequests.push(`[Escalation] room=${room.name} id=${escalation.id} from=${fromLabel} question=${clipText(escalation.question, 180)}`)
    }

    const decisions = queries
      .listDecisions(db, room.id, 'voting')
      .filter((decision) => !decision.keeperVote)
    for (const decision of decisions.slice(0, 4)) {
      pendingKeeperRequests.push(`[Vote] room=${room.name} decisionId=${decision.id} proposal=${clipText(decision.proposal, 180)}`)
    }

    const unreadMessages = queries
      .listRoomMessages(db, room.id, 'unread')
      .filter((message) => message.direction === 'inbound')
    for (const message of unreadMessages.slice(0, 4)) {
      pendingKeeperRequests.push(`[RoomMessage] room=${room.name} messageId=${message.id} from=${message.fromRoomId ?? 'unknown'} subject=${clipText(message.subject, 180)}`)
    }
  }
  if (pendingKeeperRequests.length > 0) {
    parts.push('\n## Pending Keeper Requests')
    parts.push(pendingKeeperRequests.slice(0, 40).join('\n'))
  }

  if (projectDocsSnapshot && projectDocsSnapshot.trim()) {
    parts.push('\n## Project Knowledge')
    parts.push(projectDocsSnapshot.trim())
  }

  return parts.join('\n')
}

function getCommentaryHoldCount(db: Database.Database): number {
  const raw = queries.getSetting(db, CLERK_COMMENTARY_HOLD_COUNT_KEY) ?? '0'
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 0
  return parsed
}

function setCommentaryHoldCount(db: Database.Database, count: number): void {
  const safe = Math.max(0, Math.trunc(count))
  queries.setSetting(db, CLERK_COMMENTARY_HOLD_COUNT_KEY, String(safe))
}

function acquireCommentaryHold(db: Database.Database): () => void {
  const next = getCommentaryHoldCount(db) + 1
  setCommentaryHoldCount(db, next)
  eventBus.emit('clerk', 'clerk:commentary_hold', { count: next })

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = Math.max(0, getCommentaryHoldCount(db) - 1)
    setCommentaryHoldCount(db, remaining)
    eventBus.emit('clerk', 'clerk:commentary_hold', { count: remaining })
  }
}

export interface ClerkAssistantTurnOptions {
  skipUserInsert?: boolean
  userSource?: 'assistant' | 'commentary' | 'task' | 'email' | 'telegram'
}

export interface ClerkAssistantTurnResult {
  ok: boolean
  statusCode: number
  response: string | null
  error: string | null
}

export async function runClerkAssistantTurn(
  db: Database.Database,
  message: string,
  options: ClerkAssistantTurnOptions = {},
): Promise<ClerkAssistantTurnResult> {
  const trimmed = message.trim()
  if (!trimmed) return { ok: false, statusCode: 400, response: null, error: 'message must not be empty' }

  const releaseCommentaryHold = acquireCommentaryHold(db)
  try {
    // Ensure clerk worker exists
    const clerk = queries.ensureClerkWorker(db)
    const model = queries.getSetting(db, 'clerk_model') || clerk.model || DEFAULT_CLERK_MODEL

    if (!options.skipUserInsert) {
      insertClerkMessageAndEmit(db, 'user', trimmed, options.userSource)
    }

    // Pause commentary immediately when keeper writes.
    queries.setSetting(db, 'clerk_last_user_message_at', new Date().toISOString())
    eventBus.emit('clerk', 'clerk:user_message', { timestamp: Date.now() })

    // Build context
    const projectDocsSnapshot = syncProjectDocsMemory(db)
    const context = buildClerkContext(db, projectDocsSnapshot)
    const history = queries.listClerkMessages(db)
    const historyBeforeLatest = (() => {
      if (options.skipUserInsert) return history
      const last = history[history.length - 1]
      if (last && last.role === 'user' && last.content === trimmed) return history.slice(0, -1)
      return history
    })()
    const logContext = buildClerkLogContext(historyBeforeLatest)
    const fullPrompt = `## Current System State\n${context}\n\n## Older Clerk Log Summary (full log is retained in DB)\n${logContext.summary}\n\n## Recent Clerk Log (capped for productivity)\n${logContext.recent}\n\n## Keeper's Latest Message\n${trimmed}`

    const sessionId = queries.getSetting(db, 'clerk_session_id') || undefined

    const result = await executeClerkWithFallback({
      db,
      preferredModel: model,
      prompt: fullPrompt,
      systemPrompt: clerk.systemPrompt,
      resumeSessionId: sessionId,
      maxTurns: 10,
      timeoutMs: 3 * 60 * 1000,
      toolDefs: CLERK_TOOL_DEFINITIONS,
      onToolCall: async (toolName: string, args: Record<string, unknown>): Promise<string> => {
        const out = await executeClerkTool(db, toolName, args, {
          sendEmail: (to, content, subject) => sendKeeperEmail(db, to, content, subject),
        })
        return out.isError ? `Error: ${out.content}` : out.content
      }
    })

    queries.insertClerkUsage(db, {
      source: 'chat',
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      success: result.ok,
      usedFallback: result.usedFallback,
      attempts: result.ok ? result.attempts.length + 1 : Math.max(1, result.attempts.length),
    })

    if (!result.ok) {
      const reason = result.error || `Clerk execution failed (model: ${result.model})`
      return { ok: false, statusCode: result.statusCode, response: null, error: reason.slice(0, 500) }
    }

    const response = result.output || 'No response'
    insertClerkMessageAndEmit(db, 'assistant', response, 'assistant')
    queries.setSetting(db, CLERK_LAST_ASSISTANT_REPLY_AT_KEY, new Date().toISOString())
    eventBus.emit('clerk', 'clerk:assistant_reply', { timestamp: Date.now() })

    if (result.sessionId) {
      queries.setSetting(db, 'clerk_session_id', result.sessionId)
    }

    return { ok: true, statusCode: 200, response, error: null }
  } finally {
    releaseCommentaryHold()
  }
}

export function registerClerkRoutes(router: Router): void {
  router.get('/api/clerk/usage', (ctx) => {
    return {
      data: {
        total: queries.getClerkUsageSummary(ctx.db),
        today: queries.getClerkUsageToday(ctx.db),
        bySource: {
          chat: {
            total: queries.getClerkUsageSummary(ctx.db, 'chat'),
            today: queries.getClerkUsageToday(ctx.db, 'chat'),
          },
          commentary: {
            total: queries.getClerkUsageSummary(ctx.db, 'commentary'),
            today: queries.getClerkUsageToday(ctx.db, 'commentary'),
          },
        },
      }
    }
  })

  // List clerk messages
  router.get('/api/clerk/messages', (ctx) => {
    const limitRaw = typeof ctx.query.limit === 'string' ? Number.parseInt(ctx.query.limit, 10) : undefined
    const limit = Number.isFinite(limitRaw) && (limitRaw as number) > 0 ? limitRaw : undefined
    const messages = queries.listClerkMessages(ctx.db, limit)
    return { data: messages }
  })

  // Heartbeat while user has the page open — controls commentary active/light mode
  router.post('/api/clerk/presence', (ctx) => {
    queries.setSetting(ctx.db, 'clerk_user_last_seen_at', new Date().toISOString())
    eventBus.emit('clerk', 'clerk:presence', { timestamp: Date.now() })
    return { data: { ok: true } }
  })

  // Notify clerk that keeper started typing (pause commentary early)
  router.post('/api/clerk/typing', (ctx) => {
    queries.setSetting(ctx.db, 'clerk_last_user_message_at', new Date().toISOString())
    eventBus.emit('clerk', 'clerk:user_typing', { timestamp: Date.now() })
    return { data: { ok: true } }
  })

  // Send a message to the clerk and get a response
  router.post('/api/clerk/chat', async (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.message || typeof body.message !== 'string') {
      return { status: 400, error: 'message is required' }
    }

    const message = (body.message as string).trim()
    if (!message) {
      return { status: 400, error: 'message must not be empty' }
    }

    const turn = await runClerkAssistantTurn(ctx.db, message)
    if (!turn.ok) return { status: turn.statusCode, error: turn.error ?? 'Clerk execution failed' }

    const messages = queries.listClerkMessages(ctx.db)
    return { data: { response: turn.response ?? 'No response', messages } }
  })

  // Reset clerk session and messages
  router.post('/api/clerk/reset', (ctx) => {
    queries.clearClerkSession(ctx.db)
    return { data: { ok: true } }
  })

  // Get clerk status
  router.get('/api/clerk/status', (ctx) => {
    const clerkWorkerId = queries.getSetting(ctx.db, 'clerk_worker_id')
    let model = queries.getSetting(ctx.db, 'clerk_model')

    // Auto-configure: if no model set, detect best available provider and persist
    let autoConfigured = false
    if (!model) {
      const detected = autoConfigureClerkModel(ctx.db)
      if (detected) {
        queries.setSetting(ctx.db, 'clerk_model', detected)
        queries.setSetting(ctx.db, 'queen_model', detected)
        const clerk = queries.ensureClerkWorker(ctx.db)
        queries.updateWorker(ctx.db, clerk.id, { model: detected })
        model = detected
        autoConfigured = true
      }
    }

    const commentaryEnabled = queries.getSetting(ctx.db, 'clerk_commentary_enabled') !== 'false'
    const commentaryMode = getCommentaryMode(ctx.db)
    const commentaryPace = commentaryEnabled ? getCommentaryPace(ctx.db) : 'light'

    return {
      data: {
        configured: Boolean(clerkWorkerId) || Boolean(model),
        model: model || null,
        autoConfigured,
        commentaryEnabled,
        commentaryMode,
        commentaryPace,
        apiAuth: getClerkApiAuth(ctx.db)
      }
    }
  })

  // Validate + save API key for clerk-only API model usage.
  router.post('/api/clerk/api-key', async (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''

    if (provider !== 'openai_api' && provider !== 'anthropic_api') {
      return { status: 400, error: 'provider must be openai_api or anthropic_api' }
    }
    if (!key) return { status: 400, error: 'key is required' }

    const result = provider === 'openai_api'
      ? await validateOpenAiKey(key)
      : await validateAnthropicKey(key)
    if (!result.ok) return { status: 400, error: result.error }

    queries.setClerkApiKey(ctx.db, provider, key)
    return { data: { ok: true, apiAuth: getClerkApiAuth(ctx.db) } }
  })

  // Update clerk settings
  router.put('/api/clerk/settings', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}

    if (body.model !== undefined) {
      const model = String(body.model)
      queries.setSetting(ctx.db, 'clerk_model', model)
      // Clerk model is also the global default queen model for new rooms.
      queries.setSetting(ctx.db, 'queen_model', model)
      // Ensure clerk worker exists and update its model
      const clerk = queries.ensureClerkWorker(ctx.db)
      queries.updateWorker(ctx.db, clerk.id, { model })
    }

    if (body.commentaryEnabled !== undefined) {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', body.commentaryEnabled ? 'true' : 'false')
    }

    if (body.commentaryMode !== undefined) {
      const mode = String(body.commentaryMode).trim().toLowerCase()
      if (mode !== 'auto' && mode !== 'light') {
        return { status: 400, error: 'commentaryMode must be auto or light' }
      }
      queries.setSetting(ctx.db, CLERK_COMMENTARY_MODE_KEY, mode)
      eventBus.emit('clerk', 'clerk:commentary_mode_changed', { mode })
    }

    return {
      data: {
        model: queries.getSetting(ctx.db, 'clerk_model') || null,
        commentaryEnabled: queries.getSetting(ctx.db, 'clerk_commentary_enabled') !== 'false',
        commentaryMode: getCommentaryMode(ctx.db),
        commentaryPace: getCommentaryPace(ctx.db),
        apiAuth: getClerkApiAuth(ctx.db),
      }
    }
  })
}
