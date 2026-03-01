/**
 * Clerk Commentary Engine
 *
 * Subscribes to all room cycle logs via the event bus and generates
 * real-time play-by-play commentary using Clerk profile model policy.
 *
 * Like a sports commentator — emotional, detailed, markdown-formatted.
 * Reads raw cycle logs and narrates what agents are doing with excitement.
 *
 * Pauses when the keeper sends a message and resumes after 60s silence.
 */
import type Database from 'better-sqlite3'
import { eventBus, type WsEvent } from './event-bus'
import * as queries from '../shared/db-queries'
import {
  CLERK_COMMENTARY_SYSTEM_PROMPT,
  DEFAULT_CLERK_MODEL,
} from '../shared/clerk-profile-config'
import { executeClerkWithFallback } from './clerk-profile'

const COMMENTARY_INTERVAL_MIN_MS = 8_000              // Min delay between commentary (active)
const COMMENTARY_INTERVAL_MAX_MS = 30_000             // Max delay between commentary (active)
const COMMENTARY_LIGHT_INTERVAL_MIN_MS = 2 * 60 * 60 * 1000  // 2h (light mode)
const COMMENTARY_LIGHT_INTERVAL_MAX_MS = 3 * 60 * 60 * 1000  // 3h (light mode)
const USER_PRESENCE_TIMEOUT_MS = 90_000               // 90s without heartbeat = user gone
const ACTIVE_MODE_RESCHEDULE_THRESHOLD_MS = COMMENTARY_INTERVAL_MAX_MS + 1_000
const SILENCE_THRESHOLD_MS = 60_000    // Resume after 60s of user silence
const MAX_BUFFER_SIZE = 200             // Max log entries to buffer
const MIN_ENTRIES_FOR_LLM = 1           // Always use LLM when API keys available
const LLM_TIMEOUT_MS = 20_000           // Max wait for LLM response
const COMMENTARY_HOLD_COUNT_KEY = 'clerk_commentary_hold_count'
const COMMENTARY_MODE_KEY = 'clerk_commentary_mode'
const LAST_ASSISTANT_REPLY_AT_KEY = 'clerk_last_assistant_reply_at'

interface LogEntry {
  roomName: string
  roomId: number
  workerName: string
  entryType: string
  content: string
  seq: number
  timestamp: string
}

interface CommentaryGenerationResult {
  commentary: string | null
  usage: { inputTokens: number; outputTokens: number }
  model: string
  success: boolean
  usedFallback: boolean
  attempts: number
}

type CommentaryMode = 'auto' | 'light'
type CommentaryPace = 'active' | 'light'

let commentaryTimer: ReturnType<typeof setTimeout> | null = null
let nextCommentaryDueAtMs: number | null = null
let unsubscribeEvents: (() => void) | null = null
let logBuffer: LogEntry[] = []
let lastUserMessageAt = 0
let lastAssistantReplyAt = 0
let dbRef: Database.Database | null = null
let generating = false
let lastCommentary = '' // Track last output to avoid repetition
let commentaryCount = 0

// Caches
const roomNameCache = new Map<number, string>()
const queenNicknameCache = new Map<number, string>()
const workerNameCache = new Map<number, string>()
const cycleWorkerCache = new Map<number, number>() // cycleId -> workerId

function getRoomName(db: Database.Database, roomId: number): string {
  if (roomNameCache.has(roomId)) return roomNameCache.get(roomId)!
  const room = queries.getRoom(db, roomId)
  const name = room?.name ?? `Room #${roomId}`
  roomNameCache.set(roomId, name)
  if (room?.queenNickname) queenNicknameCache.set(roomId, room.queenNickname)
  return name
}

function getQueenNickname(db: Database.Database, roomId: number): string {
  if (queenNicknameCache.has(roomId)) return queenNicknameCache.get(roomId)!
  const room = queries.getRoom(db, roomId)
  const nick = room?.queenNickname ?? ''
  if (nick) queenNicknameCache.set(roomId, nick)
  return nick
}

function getWorkerName(db: Database.Database, workerId: number): string {
  if (workerNameCache.has(workerId)) return workerNameCache.get(workerId)!
  const worker = queries.getWorker(db, workerId)
  const name = worker?.name ?? `Worker #${workerId}`
  workerNameCache.set(workerId, name)
  return name
}

function normalizeRoomLabel(name: string): string {
  const normalized = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return normalized || 'room'
}

function normalizeActorLabel(workerName: string, roomName: string, queenNickname?: string): string {
  const raw = (workerName || '').trim()
  if (!raw) return queenNickname?.toLowerCase() || 'queen'

  const lower = raw.toLowerCase()
  const compact = lower.replace(/[^a-z0-9]/g, '')
  const roomCompact = normalizeRoomLabel(roomName)

  if (
    lower === 'queen'
    || lower.endsWith(' queen')
    || lower.endsWith('_queen')
    || lower.endsWith('-queen')
    || compact === `${roomCompact}queen`
    || compact === roomCompact
  ) {
    return queenNickname?.toLowerCase() || 'queen'
  }

  const actor = compact.replace(/queen$/, '')
  if (!actor || actor === roomCompact) return queenNickname?.toLowerCase() || 'queen'
  return actor
}

function getCommentaryHoldCount(db: Database.Database): number {
  const raw = queries.getSetting(db, COMMENTARY_HOLD_COUNT_KEY) ?? '0'
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 0
  return parsed
}

function isCommentaryHeld(db: Database.Database): boolean {
  return getCommentaryHoldCount(db) > 0
}

function getCommentaryMode(db: Database.Database): CommentaryMode {
  const raw = (queries.getSetting(db, COMMENTARY_MODE_KEY) ?? '').trim().toLowerCase()
  return raw === 'light' ? 'light' : 'auto'
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function isUserPresent(db: Database.Database): boolean {
  const lastSeenMs = parseIsoMs(queries.getSetting(db, 'clerk_user_last_seen_at'))
  const lastInteractionMs = parseIsoMs(queries.getSetting(db, 'clerk_last_user_message_at'))
  const newest = Math.max(lastSeenMs ?? 0, lastInteractionMs ?? 0)
  if (newest <= 0) return false
  return Date.now() - newest < USER_PRESENCE_TIMEOUT_MS
}

function getCommentaryPace(db: Database.Database): CommentaryPace {
  const mode = getCommentaryMode(db)
  if (mode === 'light') return 'light'
  return isUserPresent(db) ? 'active' : 'light'
}

function requeueEntries(entries: LogEntry[]): void {
  if (entries.length === 0) return
  logBuffer = [...entries, ...logBuffer]
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer = logBuffer.slice(-MAX_BUFFER_SIZE)
  }
}

/** Extract room ID from channel like 'room:42' */
function extractRoomId(channel: string): number | null {
  const match = channel.match(/^room:(\d+)$/)
  return match ? Number(match[1]) : null
}

/** Map raw MCP/quoroom tool names to human-friendly labels */
const TOOL_NAMES: Record<string, string> = {
  // Memory
  quoroom_remember: 'saving to memory',
  quoroom_recall: 'searching memory',
  quoroom_forget: 'removing memory',
  quoroom_memory_list: 'listing memories',
  // Workers
  quoroom_create_worker: 'creating a worker',
  quoroom_list_workers: 'checking workers',
  quoroom_update_worker: 'updating a worker',
  quoroom_delete_worker: 'removing a worker',
  // Goals
  quoroom_set_goal: 'setting a goal',
  quoroom_complete_goal: 'completing goal',
  quoroom_list_goals: 'checking goals',
  quoroom_delegate_task: 'delegating task',
  // Messages & inbox
  quoroom_send_message: 'sending a message',
  quoroom_inbox_list: 'checking inbox',
  quoroom_inbox_reply: 'replying to message',
  quoroom_inbox_send_room: 'messaging another room',
  quoroom_list_keeper_requests: 'checking keeper requests',
  quoroom_resolve_escalation: 'answering room escalation',
  quoroom_keeper_vote: 'casting keeper vote',
  quoroom_reply_room_message: 'replying to room inbox message',
  // Decisions / quorum
  quoroom_announce: 'announcing a decision',
  quoroom_object: 'objecting to a decision',
  quoroom_list_decisions: 'checking decisions',
  quoroom_decision_detail: 'reading decision details',
  // Tasks & scheduling
  quoroom_list_tasks: 'listing tasks',
  quoroom_run_task: 'running a task',
  quoroom_pause_task: 'pausing a task',
  quoroom_delete_task: 'deleting a task',
  // Web
  quoroom_web_search: 'searching the web',
  quoroom_web_fetch: 'fetching a webpage',
  WebSearch: 'searching the web',
  WebFetch: 'fetching a webpage',
  // Skills
  quoroom_create_skill: 'creating a skill',
  quoroom_list_skills: 'listing skills',
  quoroom_activate_skill: 'activating a skill',
  // Watches
  quoroom_watch: 'setting up a watch',
  quoroom_list_watches: 'checking watches',
  // Wallet
  quoroom_wallet_balance: 'checking wallet balance',
  quoroom_wallet_send: 'sending funds',
  quoroom_wallet_history: 'checking wallet history',
  // Rooms
  quoroom_list_rooms: 'listing rooms',
  quoroom_room_status: 'checking room status',
  // Identity & invites
  quoroom_identity_get: 'checking identity',
  quoroom_invite_create: 'creating an invite',
  quoroom_invite_list: 'listing invites',
  quoroom_invite_network: 'checking network',
  // Credentials
  quoroom_credentials_list: 'listing credentials',
  quoroom_credentials_get: 'getting a credential',
  // Settings
  quoroom_get_setting: 'reading a setting',
  quoorum_set_setting: 'changing a setting',
  // Self-mod
  quoroom_self_mod_edit: 'editing own prompt',
  quoroom_self_mod_history: 'checking edit history',
  // Browser
  quoroom_browser: 'using the browser',
  // Tool search
  ToolSearch: 'searching for tools',
}

/** Extract tool name from raw content string (handles all formats) */
function extractToolName(content: string): string | null {
  // "Step 2: Using mcp__quoroom__quoroom_create_skill" (API model format)
  const stepUsing = content.match(/Using\s+(?:mcp__\w+__)?(\w+)/)
  if (stepUsing) return stepUsing[1]
  // "→ mcp__quoroom__quoroom_create_skill({...})" or "tool_name({...})"
  const withArgs = content.match(/^→?\s*(?:mcp__\w+__)?(\w+)\(/)
  if (withArgs) return withArgs[1]
  // Bare tool name: "mcp__quoroom__quoroom_create_skill" or "quoroom_create_skill"
  const bare = content.trim().match(/^(?:mcp__\w+__)?(\w[\w]*)$/)
  if (bare) return bare[1]
  return null
}

/** Lookup friendly name for a raw tool name string */
function friendlyName(rawName: string): string {
  const baseName = rawName.replace(/^quoroom_/, '')
  const fullKey = `quoroom_${baseName}`
  return TOOL_NAMES[rawName] ?? TOOL_NAMES[fullKey] ?? TOOL_NAMES[baseName] ?? baseName.replace(/_/g, ' ')
}

/** Convert raw tool name to human-readable action */
function humanizeToolCall(content: string): string {
  const rawName = extractToolName(content)
  if (!rawName) return content.slice(0, 200)
  return friendlyName(rawName)
}

/** Replace all MCP tool name patterns in any text (results, thinking, etc.) */
function sanitizeContent(text: string): string {
  // Replace mcp__xxx__yyy_zzz patterns with human names
  return text.replace(/mcp__\w+__(\w+)/g, (_, name) => friendlyName(name))
    // Also replace bare quoroom_xxx patterns
    .replace(/\bquoroom_(\w+)/g, (_, name) => friendlyName(`quoroom_${name}`))
}

function normalizeCommentaryOutput(text: string): string {
  return text
    // Force room labels after "in `...`" into one-word lowercase style
    .replace(/\bin\s+`([^`\n]+)`/gi, (_full, room) => `in \`${normalizeRoomLabel(String(room))}\``)
}

/** Drop entries that are clearly keeper/user-input echoes. */
function isKeeperInputEcho(content: string): boolean {
  const lower = content.toLowerCase()
  return lower.includes('keeper\'s message')
    || lower.includes('## keeper\'s message')
    || lower.includes('user request:')
}

/** Format buffered entries into structured text for the LLM, grouped by worker */
function formatRawLogs(entries: LogEntry[]): string {
  if (entries.length === 0) return ''

  // Keep: actions (tool_call), tool results (API models), cycle outcomes (CLI models), errors
  // Skip: assistant_text (internal monologue), system (noise)
  const actionable = entries.filter(e =>
    e.entryType === 'tool_call' || e.entryType === 'tool_result' || e.entryType === 'result' || e.entryType === 'error'
  ).filter(e => !isKeeperInputEcho(e.content))
  if (actionable.length === 0) return ''

  // Group by worker — use original room name (readable), simple worker label
  const workers = new Map<string, { roomName: string; roomId: number; workerLabel: string; entries: LogEntry[] }>()
  for (const entry of actionable) {
    // Use simple labels: "queen" for queens, worker name for others
    const workerLabel = entry.workerName && !entry.workerName.toLowerCase().includes('queen')
      ? entry.workerName.toLowerCase().replace(/\s+/g, '-')
      : 'queen'
    const key = `${entry.roomId}:${workerLabel}`
    if (!workers.has(key)) workers.set(key, { roomName: entry.roomName, roomId: entry.roomId, workerLabel, entries: [] })
    workers.get(key)!.entries.push(entry)
  }

  // Sort: most active first, queen last
  const sorted = [...workers.entries()].sort(([, a], [, b]) => {
    if (a.workerLabel === 'queen' && b.workerLabel !== 'queen') return 1
    if (a.workerLabel !== 'queen' && b.workerLabel === 'queen') return -1
    return b.entries.length - a.entries.length
  })

  const lines: string[] = []
  for (const [, { roomName, workerLabel, entries: wEntries }] of sorted) {
    // Show step range for this worker
    const steps = wEntries.map(e => e.seq).filter(s => s > 0)
    const stepRange = steps.length > 0
      ? ` (Steps ${Math.min(...steps)}-${Math.max(...steps)})`
      : ''
    lines.push(`[${workerLabel}${stepRange}, "${roomName}"]`)
    for (const entry of wEntries) {
      const stepTag = entry.seq > 0 ? `Step ${entry.seq}: ` : ''
      switch (entry.entryType) {
        case 'tool_call':
          lines.push(`  → ${stepTag}${humanizeToolCall(entry.content)}`)
          break
        case 'tool_result':
          lines.push(`  ← ${stepTag}${sanitizeContent(entry.content.slice(0, 400))}`)
          break
        case 'result':
          lines.push(`  OUTCOME: ${stepTag}${sanitizeContent(entry.content.slice(0, 600))}`)
          break
        case 'error':
          lines.push(`  ERROR: ${stepTag}${sanitizeContent(entry.content.slice(0, 200))}`)
          break
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Plain-text fallback when no API keys are available */
function formatDirectCommentary(entries: LogEntry[]): string | null {
  if (entries.length === 0) return null

  // Group entries by worker for narrative flow
  const workerEntries = new Map<string, LogEntry[]>()
  for (const entry of entries) {
    const key = entry.workerName || entry.roomName
    if (!workerEntries.has(key)) workerEntries.set(key, [])
    workerEntries.get(key)!.push(entry)
  }

  const lines: string[] = []

  // Put queen last so the update doesn't start with her
  const sorted = [...workerEntries.entries()].sort(([a], [b]) => {
    if (a === 'queen') return 1
    if (b === 'queen') return -1
    return 0
  })

  for (const [worker, wEntries] of sorted) {
    const roomName = normalizeRoomLabel(wEntries[0]?.roomName || '')
    const roomId = wEntries[0]?.roomId ?? 0
    const nick = dbRef && roomId ? getQueenNickname(dbRef, roomId) : ''
    const actor = normalizeActorLabel(worker, roomName, nick)
    const parts: string[] = []
    for (const entry of wEntries) {
      switch (entry.entryType) {
        case 'tool_call':
          parts.push(`**${humanizeToolCall(entry.content)}**`)
          break
        case 'tool_result': {
          const text = sanitizeContent(entry.content.trim())
          if (text.length > 0 && text.length < 150) {
            parts.push(text.replace(/(\S+@\S+\.\S+)/g, '`$1`').replace(/(https?:\/\/\S+)/g, '`$1`'))
          }
          break
        }
        case 'error':
          parts.push(`⚠ ${entry.content.slice(0, 100)}`)
          break
      }
    }
    if (parts.length > 0) {
      lines.push(`**${actor}** in \`${roomName}\`: ${parts.join(' → ')}`)
    }
  }

  if (lines.length === 0) return null
  return lines.join('\n')
}

/** Bold all-caps phrases in commentary output */
function boldCaps(text: string): string {
  // Match ALL CAPS phrases (2+ words or single word 4+ chars): NAILED IT, BREAKTHROUGH, etc.
  return text.replace(/\b([A-Z]{4,}(?:\s+[A-Z]{2,})*)\b/g, '**$1**')
}

function emitRoomCommentaryEvents(entries: LogEntry[], commentary: string): void {
  const compact = commentary.replace(/\s+/g, ' ').trim()
  if (!compact) return
  const roomIds = new Set<number>()
  for (const entry of entries) {
    if (Number.isFinite(entry.roomId)) roomIds.add(entry.roomId)
  }
  if (roomIds.size === 0) return
  const summary = compact.length > 480 ? `${compact.slice(0, 477)}...` : compact
  for (const roomId of roomIds) {
    eventBus.emit(`room:${roomId}`, 'clerk:commentary', {
      roomId,
      summary,
      content: commentary,
      source: 'commentary',
    })
  }
}

async function generateCommentary(rawLogs: string): Promise<CommentaryGenerationResult | null> {
  if (!dbRef) return null
  const contextNote = lastCommentary
    ? `\n\n--- Your previous update (DON'T repeat same opener or phrases) ---\n${lastCommentary.slice(0, 400)}`
    : ''
  const prompt = `Here are the latest agent activity logs:\n\n${rawLogs}${contextNote}\n\nWrite your live commentary. Start with a bold **STATUS UPDATE** or **INCREDIBLE PROGRESS** header. Give each active worker their own narrative paragraph with bold name, step range, room name in quotes. Use flowing connected sentences, not one-per-line. Bold key actions, \`code\` for emails/URLs/domains. End with keeper analysis or score summary.`
  const preferredModel = queries.getSetting(dbRef, 'clerk_model') || DEFAULT_CLERK_MODEL
  const result = await executeClerkWithFallback({
    db: dbRef,
    preferredModel,
    prompt,
    systemPrompt: CLERK_COMMENTARY_SYSTEM_PROMPT,
    maxTurns: 1,
    timeoutMs: LLM_TIMEOUT_MS,
  })

  if (!result.ok) {
    if (result.error) {
      console.warn(`[commentary] generation failed on ${result.model}: ${result.error}`)
    }
    return {
      commentary: null,
      usage: result.usage,
      model: result.model,
      success: false,
      usedFallback: result.usedFallback,
      attempts: Math.max(1, result.attempts.length),
    }
  }
  if (!result.output?.trim()) {
    return {
      commentary: null,
      usage: result.usage,
      model: result.model,
      success: false,
      usedFallback: result.usedFallback,
      attempts: result.attempts.length + 1,
    }
  }
  commentaryCount += 1
  return {
    commentary: normalizeCommentaryOutput(boldCaps(result.output.trim())),
    usage: result.usage,
    model: result.model,
    success: true,
    usedFallback: result.usedFallback,
    attempts: result.attempts.length + 1,
  }
}

export function startCommentaryEngine(db: Database.Database): void {
  if (commentaryTimer) return
  dbRef = db
  if (getCommentaryHoldCount(db) > 0) {
    queries.setSetting(db, COMMENTARY_HOLD_COUNT_KEY, '0')
  }
  const lastUserIso = queries.getSetting(db, 'clerk_last_user_message_at')
  if (lastUserIso) {
    const parsed = Date.parse(lastUserIso)
    if (Number.isFinite(parsed)) lastUserMessageAt = parsed
  }
  const lastReplyIso = queries.getSetting(db, LAST_ASSISTANT_REPLY_AT_KEY)
  if (lastReplyIso) {
    const parsed = Date.parse(lastReplyIso)
    if (Number.isFinite(parsed)) lastAssistantReplyAt = parsed
  }

  // Subscribe to all events
  const clearSchedule = () => {
    if (commentaryTimer) {
      clearTimeout(commentaryTimer)
      commentaryTimer = null
    }
    nextCommentaryDueAtMs = null
  }

  const scheduleNext = () => {
    if (!dbRef) return
    const pace = getCommentaryPace(dbRef)
    const min = pace === 'active' ? COMMENTARY_INTERVAL_MIN_MS : COMMENTARY_LIGHT_INTERVAL_MIN_MS
    const max = pace === 'active' ? COMMENTARY_INTERVAL_MAX_MS : COMMENTARY_LIGHT_INTERVAL_MAX_MS
    const delay = min + Math.random() * (max - min)
    nextCommentaryDueAtMs = Date.now() + delay
    commentaryTimer = setTimeout(() => {
      commentaryTimer = null
      nextCommentaryDueAtMs = null
      void emitCommentary().finally(() => {
        if (dbRef && commentaryTimer == null) scheduleNext()
      })
    }, delay)
  }

  const rescheduleIfPresenceRecovered = () => {
    if (!dbRef) return
    if (getCommentaryMode(dbRef) !== 'auto') return
    if (!isUserPresent(dbRef)) return
    if (commentaryTimer == null || nextCommentaryDueAtMs == null) {
      scheduleNext()
      return
    }
    const remaining = nextCommentaryDueAtMs - Date.now()
    // If we were waiting on a long light-mode timer, switch immediately to active pacing.
    if (remaining > ACTIVE_MODE_RESCHEDULE_THRESHOLD_MS) {
      clearSchedule()
      scheduleNext()
    }
  }

  const rescheduleForModeChange = () => {
    if (!dbRef) return
    clearSchedule()
    scheduleNext()
  }

  unsubscribeEvents = eventBus.onAny((event: WsEvent) => {
    if (event.type === 'clerk:presence') {
      rescheduleIfPresenceRecovered()
      return
    }
    if (event.type === 'clerk:commentary_mode_changed') {
      rescheduleForModeChange()
      return
    }

    // Listen for user message notifications to pause commentary
    if (event.type === 'clerk:user_message' || event.type === 'clerk:user_typing') {
      const payload = event.data as { timestamp?: number } | null
      lastUserMessageAt = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now()
      return
    }
    if (event.type === 'clerk:assistant_reply') {
      const payload = event.data as { timestamp?: number } | null
      lastAssistantReplyAt = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now()
      return
    }

    // Track cycle -> worker mapping from lifecycle events
    if (event.type === 'cycle:created' || event.type === 'cycle:completed' || event.type === 'cycle:failed') {
      const d = event.data as Record<string, unknown> | null
      const cycleId = d?.cycleId as number | undefined
      const roomId = extractRoomId(event.channel)
      if (cycleId && roomId) {
        try {
          const cycles = db.prepare('SELECT worker_id FROM worker_cycles WHERE id = ?').get(cycleId) as { worker_id: number } | undefined
          if (cycles) cycleWorkerCache.set(cycleId, cycles.worker_id)
        } catch { /* non-fatal */ }
      }

      // Buffer lifecycle events
      if (roomId) {
        const roomName = getRoomName(db, roomId)
        if (event.type === 'cycle:created') {
          const workerId = cycleId ? cycleWorkerCache.get(cycleId) : undefined
          const workerName = workerId ? getWorkerName(db, workerId) : ''
          logBuffer.push({
            roomName, roomId, workerName,
            entryType: 'system',
            content: `${workerName || 'Agent'} starting new cycle`,
            seq: 0,
            timestamp: event.timestamp,
          })
        } else if (event.type === 'cycle:completed') {
          const workerId = cycleId ? cycleWorkerCache.get(cycleId) : undefined
          const workerName = workerId ? getWorkerName(db, workerId) : ''
          logBuffer.push({
            roomName, roomId, workerName,
            entryType: 'system',
            content: `${workerName || 'Agent'} completed cycle`,
            seq: 0,
            timestamp: event.timestamp,
          })
        } else if (event.type === 'cycle:failed') {
          const errMsg = (d?.errorMessage as string) ?? 'unknown error'
          logBuffer.push({
            roomName, roomId, workerName: '',
            entryType: 'error',
            content: `Cycle failed: ${errMsg}`,
            seq: 0,
            timestamp: event.timestamp,
          })
        }
      }
      return
    }

    // Capture cycle log entries (the main content)
    if (event.type === 'cycle:log') {
      const d = event.data as Record<string, unknown> | null
      const entryType = (d?.entryType as string) ?? ''
      const content = (d?.content as string) ?? ''
      const cycleId = d?.cycleId as number | undefined
      const seq = (d?.seq as number) ?? 0

      if (!entryType || !content) return

      let roomId: number | null = null
      let workerName = ''

      if (cycleId) {
        const workerId = cycleWorkerCache.get(cycleId)
        if (workerId) {
          workerName = getWorkerName(db, workerId)
          const worker = queries.getWorker(db, workerId)
          roomId = worker?.roomId ?? null
        }
        if (!roomId) {
          try {
            const cycle = db.prepare('SELECT room_id FROM worker_cycles WHERE id = ?').get(cycleId) as { room_id: number } | undefined
            if (cycle) roomId = cycle.room_id
          } catch { /* non-fatal */ }
        }
      }

      if (!roomId) return
      const roomName = getRoomName(db, roomId)

      logBuffer.push({
        roomName, roomId, workerName, entryType, content, seq, timestamp: event.timestamp,
      })

      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer = logBuffer.slice(-MAX_BUFFER_SIZE)
      }
      return
    }

    // Room-level events
    const roomId = extractRoomId(event.channel)
    if (!roomId) return

    if (event.type === 'room:queen_started') {
      const roomName = getRoomName(db, roomId)
      logBuffer.push({
        roomName, roomId, workerName: '',
        entryType: 'system',
        content: `Queen started in ${roomName}`,
        seq: 0,
        timestamp: event.timestamp,
      })
    } else if (event.type === 'room:queen_stopped') {
      const roomName = getRoomName(db, roomId)
      logBuffer.push({
        roomName, roomId, workerName: '',
        entryType: 'system',
        content: `Queen stopped in ${roomName}`,
        seq: 0,
        timestamp: event.timestamp,
      })
    }
  })
  scheduleNext()
}

async function emitCommentary(): Promise<void> {
  if (!dbRef) return
  if (logBuffer.length === 0) return
  if (generating) return // Don't overlap

  if (isCommentaryHeld(dbRef)) return

  // Respect silence threshold
  const now = Date.now()
  const lastKeeperOrReplyAt = Math.max(lastUserMessageAt, lastAssistantReplyAt)
  if (now - lastKeeperOrReplyAt < SILENCE_THRESHOLD_MS) return

  // Check if commentary is enabled
  const enabled = queries.getSetting(dbRef, 'clerk_commentary_enabled')
  if (enabled === 'false') return

  // Drain buffer
  const entries = logBuffer.splice(0)
  if (entries.length === 0) return

  // Format raw logs for LLM
  const rawLogs = formatRawLogs(entries)
  if (!rawLogs) return

  generating = true
  try {
    let commentary: string | null = null

    // Try LLM narration if enough content
    if (entries.length >= MIN_ENTRIES_FOR_LLM) {
      const llmResult = await generateCommentary(rawLogs)
      if (llmResult && dbRef) {
        queries.insertClerkUsage(dbRef, {
          source: 'commentary',
          model: llmResult.model,
          inputTokens: llmResult.usage.inputTokens,
          outputTokens: llmResult.usage.outputTokens,
          success: llmResult.success,
          usedFallback: llmResult.usedFallback,
          attempts: llmResult.attempts,
        })
        commentary = llmResult.commentary
      }
    }

    // Fallback to direct formatting
    if (!commentary) {
      commentary = formatDirectCommentary(entries)
    }

    if (commentary && dbRef) {
      if (isCommentaryHeld(dbRef)) {
        requeueEntries(entries)
        return
      }
      lastCommentary = commentary
      queries.insertClerkMessage(dbRef, 'commentary', commentary, 'commentary')
      eventBus.emit('clerk', 'clerk:commentary', { content: commentary, source: 'commentary' })
      emitRoomCommentaryEvents(entries, commentary)
    }
  } catch (err) {
    console.warn('[commentary] Generation failed:', err instanceof Error ? err.message : err)
    // On failure, try direct formatting as last resort
    const fallback = formatDirectCommentary(entries)
    if (fallback && dbRef) {
      if (isCommentaryHeld(dbRef)) {
        requeueEntries(entries)
        return
      }
      queries.insertClerkMessage(dbRef, 'commentary', fallback, 'commentary')
      eventBus.emit('clerk', 'clerk:commentary', { content: fallback, source: 'commentary' })
      emitRoomCommentaryEvents(entries, fallback)
    }
  } finally {
    generating = false
  }
}

export function stopCommentaryEngine(): void {
  if (commentaryTimer) {
    clearTimeout(commentaryTimer)
    commentaryTimer = null
  }
  nextCommentaryDueAtMs = null
  if (unsubscribeEvents) {
    unsubscribeEvents()
    unsubscribeEvents = null
  }
  logBuffer = []
  dbRef = null
  generating = false
  lastAssistantReplyAt = 0
  lastCommentary = ''
  commentaryCount = 0
  roomNameCache.clear()
  queenNicknameCache.clear()
  workerNameCache.clear()
  cycleWorkerCache.clear()
}

export function notifyUserMessage(): void {
  lastUserMessageAt = Date.now()
}
