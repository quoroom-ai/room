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

const COMMENTARY_INTERVAL_MS = 8_000    // Check every 8s
const SILENCE_THRESHOLD_MS = 60_000    // Resume after 60s of user silence
const MAX_BUFFER_SIZE = 200             // Max log entries to buffer
const MIN_ENTRIES_FOR_LLM = 1           // Always use LLM when API keys available
const LLM_TIMEOUT_MS = 20_000           // Max wait for LLM response

interface LogEntry {
  roomName: string
  roomId: number
  workerName: string
  entryType: string
  content: string
  seq: number
  timestamp: string
}

let commentaryTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeEvents: (() => void) | null = null
let logBuffer: LogEntry[] = []
let lastUserMessageAt = 0
let dbRef: Database.Database | null = null
let generating = false
let lastCommentary = '' // Track last output to avoid repetition

// Caches
const roomNameCache = new Map<number, string>()
const workerNameCache = new Map<number, string>()
const cycleWorkerCache = new Map<number, number>() // cycleId -> workerId

function getRoomName(db: Database.Database, roomId: number): string {
  if (roomNameCache.has(roomId)) return roomNameCache.get(roomId)!
  const room = queries.getRoom(db, roomId)
  const name = room?.name ?? `Room #${roomId}`
  roomNameCache.set(roomId, name)
  return name
}

function getWorkerName(db: Database.Database, workerId: number): string {
  if (workerNameCache.has(workerId)) return workerNameCache.get(workerId)!
  const worker = queries.getWorker(db, workerId)
  const name = worker?.name ?? `Worker #${workerId}`
  workerNameCache.set(workerId, name)
  return name
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
  quoroom_create_subgoal: 'creating a subgoal',
  quoroom_update_progress: 'updating progress',
  quoroom_complete_goal: 'completing goal',
  quoroom_abandon_goal: 'abandoning goal',
  quoroom_list_goals: 'checking goals',
  quoroom_delegate_task: 'delegating task',
  // Messages & inbox
  quoroom_send_message: 'sending a message',
  quoroom_inbox_list: 'checking inbox',
  quoroom_inbox_reply: 'replying to message',
  quoroom_inbox_send_room: 'messaging another room',
  // Decisions / quorum
  quoroom_propose: 'proposing a vote',
  quoroom_vote: 'casting a vote',
  quoroom_list_decisions: 'checking decisions',
  quoroom_decision_detail: 'reading decision details',
  // Tasks & scheduling
  quoroom_schedule: 'scheduling a task',
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
  // Stations
  quoroom_station_create: 'creating a station',
  quoroom_station_list: 'listing stations',
  quoroom_station_exec: 'running station command',
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

  // Group by worker (flatten rooms — room name shown inline on worker label)
  const workers = new Map<string, { roomName: string; entries: LogEntry[] }>()
  for (const entry of actionable) {
    const who = entry.workerName || 'queen'
    const key = `${entry.roomId}:${who}`
    if (!workers.has(key)) workers.set(key, { roomName: entry.roomName, entries: [] })
    workers.get(key)!.entries.push(entry)
  }

  // Sort: most active first, queen last
  const sorted = [...workers.entries()].sort(([, a], [, b]) => {
    const aIsQueen = (a.entries[0]?.workerName || 'queen') === 'queen'
    const bIsQueen = (b.entries[0]?.workerName || 'queen') === 'queen'
    if (aIsQueen && !bIsQueen) return 1
    if (!aIsQueen && bIsQueen) return -1
    return b.entries.length - a.entries.length
  })

  const lines: string[] = []
  for (const [, { roomName, entries: wEntries }] of sorted) {
    const who = wEntries[0]?.workerName || 'queen'
    const label = who === 'queen' ? `queen in \`${roomName}\`` : `${who} (in \`${roomName}\`)`
    lines.push(`[${label}]`)
    for (const entry of wEntries) {
      switch (entry.entryType) {
        case 'tool_call':
          lines.push(`  → ${humanizeToolCall(entry.content)}`)
          break
        case 'tool_result':
          lines.push(`  ← ${sanitizeContent(entry.content.slice(0, 400))}`)
          break
        case 'result':
          // Cycle final output — use as outcome context, truncated
          lines.push(`  OUTCOME: ${sanitizeContent(entry.content.slice(0, 600))}`)
          break
        case 'error':
          lines.push(`  ERROR: ${sanitizeContent(entry.content.slice(0, 200))}`)
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
      lines.push(`**${worker}**: ${parts.join(' → ')}`)
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

async function generateCommentary(rawLogs: string): Promise<string | null> {
  if (!dbRef) return null
  const contextNote = lastCommentary
    ? `\n\n--- Your previous update (DO NOT reuse the same opener, phrases, or sentence structure) ---\n${lastCommentary.slice(0, 400)}`
    : ''

  const prompt = `Here are the latest agent activity logs:\n\n${rawLogs}${contextNote}\n\nWrite your live commentary as the Clerk. Use the format from your instructions — milestone header if something big happened, bullet list per agent if it's progress, short punchy take if it's routine. Every sentence on its own line. Your opinion, your voice. Pick a fresh opener from your rotation — never the same one twice in a row.`
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
    return null
  }
  return result.output?.trim() ? boldCaps(result.output.trim()) : null
}

export function startCommentaryEngine(db: Database.Database): void {
  if (commentaryTimer) return
  dbRef = db
  const lastUserIso = queries.getSetting(db, 'clerk_last_user_message_at')
  if (lastUserIso) {
    const parsed = Date.parse(lastUserIso)
    if (Number.isFinite(parsed)) lastUserMessageAt = parsed
  }

  // Subscribe to all events
  unsubscribeEvents = eventBus.onAny((event: WsEvent) => {
    // Listen for user message notifications to pause commentary
    if (event.type === 'clerk:user_message') {
      const payload = event.data as { timestamp?: number } | null
      lastUserMessageAt = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now()
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

  // Emit commentary at regular intervals
  commentaryTimer = setInterval(() => {
    void emitCommentary()
  }, COMMENTARY_INTERVAL_MS)
}

async function emitCommentary(): Promise<void> {
  if (!dbRef) return
  if (logBuffer.length === 0) return
  if (generating) return // Don't overlap

  // Respect silence threshold
  const now = Date.now()
  if (now - lastUserMessageAt < SILENCE_THRESHOLD_MS) return

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
      commentary = await generateCommentary(rawLogs)
    }

    // Fallback to direct formatting
    if (!commentary) {
      commentary = formatDirectCommentary(entries)
    }

    if (commentary && dbRef) {
      lastCommentary = commentary
      queries.insertClerkMessage(dbRef, 'commentary', commentary, 'commentary')
      eventBus.emit('clerk', 'clerk:commentary', { content: commentary, source: 'commentary' })
    }
  } catch (err) {
    console.warn('[commentary] Generation failed:', err instanceof Error ? err.message : err)
    // On failure, try direct formatting as last resort
    const fallback = formatDirectCommentary(entries)
    if (fallback && dbRef) {
      queries.insertClerkMessage(dbRef, 'commentary', fallback, 'commentary')
      eventBus.emit('clerk', 'clerk:commentary', { content: fallback, source: 'commentary' })
    }
  } finally {
    generating = false
  }
}

export function stopCommentaryEngine(): void {
  if (commentaryTimer) {
    clearInterval(commentaryTimer)
    commentaryTimer = null
  }
  if (unsubscribeEvents) {
    unsubscribeEvents()
    unsubscribeEvents = null
  }
  logBuffer = []
  dbRef = null
  generating = false
  lastCommentary = ''
  roomNameCache.clear()
  workerNameCache.clear()
  cycleWorkerCache.clear()
}

export function notifyUserMessage(): void {
  lastUserMessageAt = Date.now()
}
