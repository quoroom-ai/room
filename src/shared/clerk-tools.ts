import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { createRoom, pauseRoom, restartRoom, deleteRoom } from './room'
import { pauseAgent, triggerAgent } from './agent-loop'
import type { ToolDef } from './queen-tools'
import { getRoomCloudId } from './cloud-sync'

export type ClerkToolArgs = Record<string, unknown>

export interface ClerkToolResult {
  content: string
  isError?: boolean
}

export const CLERK_TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'quoroom_list_rooms',
      description: 'List rooms and their current state.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Optional room status filter: active, paused, or stopped' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_create_room',
      description: 'Create a new room with sensible defaults. Only objective is required; name can be auto-generated.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional single-word room name. Auto-generated from objective if omitted.' },
          goal: { type: 'string', description: 'Room objective' },
          objective: { type: 'string', description: 'Alias for goal' },
          model: { type: 'string', description: 'Optional default room model (claude, codex, openai:..., anthropic:...)' },
          autonomyMode: { type: 'string', description: 'Optional autonomy mode: auto or semi' },
          visibility: { type: 'string', description: 'Optional visibility: private or public' },
          queenCycleGapMs: { type: 'number', description: 'Optional queen cycle gap in milliseconds' },
          queenMaxTurns: { type: 'number', description: 'Optional queen max turns per cycle' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_update_room',
      description: 'Update room settings and control parameters.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' },
          goal: { type: 'string', description: 'Objective text' },
          workerModel: { type: 'string', description: 'Default worker model' },
          autonomyMode: { type: 'string', description: 'auto or semi' },
          visibility: { type: 'string', description: 'private or public' },
          queenCycleGapMs: { type: 'number', description: 'Queen cycle gap in milliseconds' },
          queenMaxTurns: { type: 'number', description: 'Queen max turns per cycle' },
          queenQuietFrom: { type: 'string', description: 'Quiet hours start (HH:mm) or null to clear' },
          queenQuietUntil: { type: 'string', description: 'Quiet hours end (HH:mm) or null to clear' },
          maxConcurrentTasks: { type: 'number', description: 'Max concurrent tasks (1-10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_pause_room',
      description: 'Pause a room (stop its workers).',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_restart_room',
      description: 'Restart a room and optionally set a new goal.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' },
          goal: { type: 'string', description: 'Optional new room objective' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_delete_room',
      description: 'Delete a room and all its data.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_start_queen',
      description: 'Start queen loop for a room.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_stop_queen',
      description: 'Stop queen loop for a room.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_message_room',
      description: 'Send a keeper message to a specific local room (delivered as an escalation to that room\'s queen).',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Target room ID' },
          roomName: { type: 'string', description: 'Target room name (alternative to roomId)' },
          message: { type: 'string', description: 'Message content from keeper' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_message_other_room',
      description: 'Send an inter-room message on behalf of keeper from one local room to another room (local or cloud).',
      parameters: {
        type: 'object',
        properties: {
          fromRoomId: { type: 'number', description: 'Source local room ID (optional; defaults to first active room)' },
          fromRoomName: { type: 'string', description: 'Source local room name (alternative to fromRoomId)' },
          toRoomId: { type: 'string', description: 'Target cloud room ID' },
          toRoomName: { type: 'string', description: 'Target local room name (converted to cloud ID automatically)' },
          subject: { type: 'string', description: 'Message subject' },
          body: { type: 'string', description: 'Message body' }
        },
        required: ['body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_list_tasks',
      description: 'List scheduled or manual tasks across rooms.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Optional room ID filter' },
          roomName: { type: 'string', description: 'Optional room name filter (alternative to roomId)' },
          status: { type: 'string', description: 'Optional status filter: active, paused, completed' },
          limit: { type: 'number', description: 'Optional max tasks to return (1-100, default 20)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_create_task',
      description: 'Create a task for a room (or global). Supports manual, one-time, or cron scheduling.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Task name' },
          prompt: { type: 'string', description: 'Task execution prompt' },
          description: { type: 'string', description: 'Optional task description' },
          roomId: { type: 'number', description: 'Optional room ID' },
          roomName: { type: 'string', description: 'Optional room name (alternative to roomId)' },
          workerId: { type: 'number', description: 'Optional worker ID to assign task to' },
          cronExpression: { type: 'string', description: 'Cron expression for recurring schedule' },
          scheduledAt: { type: 'string', description: 'One-time schedule time (ISO or parseable datetime)' },
          maxTurns: { type: 'number', description: 'Optional per-run max turns' },
          timeoutMinutes: { type: 'number', description: 'Optional timeout minutes per run' }
        },
        required: ['name', 'prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_remind_keeper',
      description: 'Schedule a one-time reminder message to the keeper at a specific time.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Reminder text to deliver to the keeper' },
          scheduledAt: { type: 'string', description: 'When to remind (ISO or parseable datetime)' },
          roomId: { type: 'number', description: 'Optional room context for this reminder' },
          roomName: { type: 'string', description: 'Optional room context (alternative to roomId)' },
          name: { type: 'string', description: 'Optional reminder task name' }
        },
        required: ['message', 'scheduledAt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_send_email',
      description: 'Send an email from your own clerk address. Use "admin" as the to address to reach the keeper/developer.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address, or "admin" to send to the keeper' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text' }
        },
        required: ['to', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_get_setting',
      description: 'Read any global setting by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_set_setting',
      description: 'Write any global setting key/value.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key' },
          value: { type: 'string', description: 'Setting value' }
        },
        required: ['key', 'value']
      }
    }
  },
]

function parseRoomIdArg(args: ClerkToolArgs): number | null {
  const raw = args.roomId ?? args.id
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function resolveRoom(db: Database.Database, args: ClerkToolArgs): ReturnType<typeof queries.getRoom> {
  const byId = parseRoomIdArg(args)
  if (byId != null) return queries.getRoom(db, byId)

  const roomName = String(args.roomName ?? args.name ?? '').trim().toLowerCase()
  if (!roomName) return null
  return queries.listRooms(db).find((room) => room.name.toLowerCase() === roomName) ?? null
}

function resolveFromRoom(db: Database.Database, args: ClerkToolArgs): ReturnType<typeof queries.getRoom> {
  const fromArgs: ClerkToolArgs = {
    roomId: args.fromRoomId,
    roomName: args.fromRoomName
  }
  const explicit = resolveRoom(db, fromArgs)
  if (explicit) return explicit

  const active = queries.listRooms(db).find((room) => room.status === 'active')
  if (active) return active
  return queries.listRooms(db)[0] ?? null
}

function normalizeRoomName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function toSingleWordName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

function buildRoomNameFromObjective(objective: string, existingNames: Set<string>): string {
  const tokens = objective
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !['the', 'and', 'for', 'with', 'from', 'into', 'room', 'new'].includes(token))
  const rawBase = tokens[0] ?? 'room'
  const base = toSingleWordName(rawBase) || 'room'
  if (!existingNames.has(base)) return base
  for (let i = 2; i <= 9999; i++) {
    const candidate = `${base}${i}`
    if (!existingNames.has(candidate)) return candidate
  }
  return `room${Date.now()}`
}

function hasExplicitRoomSelector(args: ClerkToolArgs): boolean {
  if (args.roomId !== undefined && args.roomId !== null && String(args.roomId).trim() !== '') return true
  return typeof args.roomName === 'string' && args.roomName.trim().length > 0
}

function parseIntArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toSqliteLocalDateTime(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function parseScheduledAt(value: unknown): { scheduledAt: string | null; error?: string } {
  if (value === undefined || value === null) return { scheduledAt: null }

  let timestampMs: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    timestampMs = value < 1_000_000_000_000 ? value * 1000 : value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return { scheduledAt: null }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) timestampMs = parsed
  }

  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return { scheduledAt: null, error: 'Error: scheduledAt must be a valid datetime (for example: "2026-03-01T09:00:00-05:00").' }
  }
  return { scheduledAt: toSqliteLocalDateTime(new Date(timestampMs)) }
}

export interface ClerkToolContext {
  sendEmail?: (to: string, content: string, subject?: string) => Promise<boolean>
}

export async function executeClerkTool(
  db: Database.Database,
  toolName: string,
  args: ClerkToolArgs,
  ctx?: ClerkToolContext
): Promise<ClerkToolResult> {
  try {
    switch (toolName) {
      case 'quoroom_list_rooms': {
        const statusRaw = String(args.status ?? '').trim()
        const status = statusRaw ? statusRaw : undefined
        const rooms = queries.listRooms(db, status)
        if (rooms.length === 0) return { content: 'No rooms found.' }
        const lines = rooms.map((room) =>
          `#${room.id} ${room.name} (${room.status}) mode=${room.autonomyMode} visibility=${room.visibility} goal=${room.goal ?? '-'}`
        )
        return { content: lines.join('\n') }
      }

      case 'quoroom_create_room': {
        const goal = String(args.goal ?? args.objective ?? '').trim()
        if (!goal) {
          return { content: 'Error: objective is required. Tell me what this room should achieve.', isError: true }
        }

        const existingRooms = queries.listRooms(db)
        const existingNames = new Set(existingRooms.map((room) => room.name.toLowerCase()))

        const requestedName = normalizeRoomName(args.name)
        const name = requestedName
          ? (toSingleWordName(requestedName) || buildRoomNameFromObjective(goal, existingNames))
          : buildRoomNameFromObjective(goal, existingNames)

        if (existingNames.has(name)) {
          return { content: `Error: room "${name}" already exists.`, isError: true }
        }

        const result = createRoom(db, { name, goal })
        const updates: Parameters<typeof queries.updateRoom>[2] = {
          workerModel: 'queen'
        }
        if (typeof args.model === 'string' && args.model.trim()) {
          queries.updateWorker(db, result.queen.id, { model: args.model.trim() })
        }
        if (typeof args.autonomyMode === 'string' && (args.autonomyMode === 'auto' || args.autonomyMode === 'semi')) {
          updates.autonomyMode = args.autonomyMode
        }
        if (typeof args.visibility === 'string' && (args.visibility === 'private' || args.visibility === 'public')) {
          updates.visibility = args.visibility
        }
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(1_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (Object.keys(updates).length > 0) queries.updateRoom(db, result.room.id, updates)
        return { content: `Created room "${name}" (#${result.room.id}).` }
      }

      case 'quoroom_update_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const updates: Parameters<typeof queries.updateRoom>[2] = {}
        if (args.goal !== undefined) updates.goal = String(args.goal ?? '').trim() || null
        if (typeof args.workerModel === 'string' && args.workerModel.trim()) updates.workerModel = args.workerModel.trim()
        if (typeof args.autonomyMode === 'string' && (args.autonomyMode === 'auto' || args.autonomyMode === 'semi')) {
          updates.autonomyMode = args.autonomyMode
        }
        if (typeof args.visibility === 'string' && (args.visibility === 'private' || args.visibility === 'public')) {
          updates.visibility = args.visibility
        }
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(1_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (args.maxConcurrentTasks != null) updates.maxConcurrentTasks = Math.max(1, Math.min(10, Number(args.maxConcurrentTasks)))
        if (args.queenQuietFrom !== undefined) {
          const from = args.queenQuietFrom === null ? null : String(args.queenQuietFrom).trim()
          updates.queenQuietFrom = from || null
        }
        if (args.queenQuietUntil !== undefined) {
          const until = args.queenQuietUntil === null ? null : String(args.queenQuietUntil).trim()
          updates.queenQuietUntil = until || null
        }
        if (Object.keys(updates).length === 0) return { content: 'No room updates provided.' }
        queries.updateRoom(db, room.id, updates)
        return { content: `Updated room "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_pause_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        pauseRoom(db, room.id)
        for (const worker of queries.listRoomWorkers(db, room.id)) pauseAgent(db, worker.id)
        return { content: `Paused room "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_restart_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const goal = String(args.goal ?? '').trim() || undefined
        restartRoom(db, room.id, goal)
        return { content: `Restarted room "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_delete_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        for (const worker of queries.listRoomWorkers(db, room.id)) pauseAgent(db, worker.id)
        deleteRoom(db, room.id)
        return { content: `Deleted room "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_start_queen': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        if (!room.queenWorkerId) return { content: `Error: room "${room.name}" has no queen worker.`, isError: true }
        if (room.status !== 'active') return { content: `Error: room "${room.name}" is not active.`, isError: true }
        triggerAgent(db, room.id, room.queenWorkerId)
        return { content: `Started queen in "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_stop_queen': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        if (!room.queenWorkerId) return { content: `Error: room "${room.name}" has no queen worker.`, isError: true }
        pauseAgent(db, room.queenWorkerId)
        return { content: `Stopped queen in "${room.name}" (#${room.id}).` }
      }

      case 'quoroom_message_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const message = String(args.message ?? '').trim()
        if (!message) return { content: 'Error: message is required.', isError: true }
        const toAgentId = room.queenWorkerId ?? undefined
        const escalation = queries.createEscalation(db, room.id, null, message, toAgentId)
        if (room.status === 'active' && room.queenWorkerId) {
          try { triggerAgent(db, room.id, room.queenWorkerId) } catch { /* non-fatal */ }
        }
        return { content: `Sent keeper message to "${room.name}" (#${room.id}) as escalation #${escalation.id}.` }
      }

      case 'quoroom_message_other_room': {
        const sourceRoom = resolveFromRoom(db, args)
        if (!sourceRoom) return { content: 'Error: no source room available.', isError: true }

        const body = String(args.body ?? '').trim()
        if (!body) return { content: 'Error: body is required.', isError: true }
        const subject = String(args.subject ?? 'Message from Keeper').trim() || 'Message from Keeper'

        let targetRoomId = String(args.toRoomId ?? '').trim()
        if (!targetRoomId) {
          const targetByName = String(args.toRoomName ?? '').trim().toLowerCase()
          if (!targetByName) {
            return { content: 'Error: toRoomId or toRoomName is required.', isError: true }
          }
          const localTarget = queries.listRooms(db).find((room) => room.name.toLowerCase() === targetByName)
          if (!localTarget) return { content: `Error: target room "${targetByName}" not found.`, isError: true }
          targetRoomId = getRoomCloudId(localTarget.id)
        }

        const message = queries.createRoomMessage(
          db,
          sourceRoom.id,
          'outbound',
          subject,
          body,
          { toRoomId: targetRoomId }
        )
        return {
          content: `Queued inter-room message #${message.id} from "${sourceRoom.name}" (#${sourceRoom.id}) to ${targetRoomId}.`
        }
      }

      case 'quoroom_list_tasks': {
        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const statusRaw = String(args.status ?? '').trim()
        const status = statusRaw || undefined
        const limitRaw = parseIntArg(args.limit)
        const limit = limitRaw != null ? Math.max(1, Math.min(100, limitRaw)) : 20

        const tasks = queries.listTasks(db, room?.id, status).slice(0, limit)
        if (tasks.length === 0) return { content: 'No tasks found.' }

        const lines = tasks.map((task) => {
          const roomLabel = task.roomId != null
            ? (queries.getRoom(db, task.roomId)?.name ?? `#${task.roomId}`)
            : 'global'
          const schedule = task.triggerType === 'cron'
            ? `cron=${task.cronExpression ?? '-'}`
            : task.triggerType === 'once'
              ? `at=${task.scheduledAt ?? '-'}`
              : 'manual'
          return `#${task.id} ${task.name} (${task.status}) ${schedule} executor=${task.executor} room=${roomLabel}`
        })
        return { content: lines.join('\n') }
      }

      case 'quoroom_create_task': {
        const name = String(args.name ?? '').trim()
        const prompt = String(args.prompt ?? '').trim()
        if (!name) return { content: 'Error: name is required.', isError: true }
        if (!prompt) return { content: 'Error: prompt is required.', isError: true }

        const cronExpression = String(args.cronExpression ?? '').trim() || undefined
        const parsedScheduled = parseScheduledAt(args.scheduledAt)
        if (parsedScheduled.error) return { content: parsedScheduled.error, isError: true }
        const scheduledAt = parsedScheduled.scheduledAt || undefined
        if (cronExpression && scheduledAt) {
          return { content: 'Error: provide either cronExpression or scheduledAt, not both.', isError: true }
        }
        const triggerType: 'cron' | 'once' | 'manual' = cronExpression ? 'cron' : scheduledAt ? 'once' : 'manual'

        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const workerId = parseIntArg(args.workerId)
        if (args.workerId !== undefined && workerId == null) {
          return { content: 'Error: workerId must be a valid integer.', isError: true }
        }
        if (workerId != null) {
          const worker = queries.getWorker(db, workerId)
          if (!worker) return { content: `Error: worker #${workerId} not found.`, isError: true }
          if (room && worker.roomId !== room.id) {
            return { content: `Error: worker #${workerId} does not belong to room "${room.name}".`, isError: true }
          }
        }

        let maxTurns: number | undefined
        if (args.maxTurns !== undefined) {
          const parsed = Number(args.maxTurns)
          if (!Number.isFinite(parsed) || parsed < 1) {
            return { content: 'Error: maxTurns must be a positive number.', isError: true }
          }
          maxTurns = Math.trunc(parsed)
        }

        let timeoutMinutes: number | undefined
        if (args.timeoutMinutes !== undefined) {
          const parsed = Number(args.timeoutMinutes)
          if (!Number.isFinite(parsed) || parsed < 1) {
            return { content: 'Error: timeoutMinutes must be a positive number.', isError: true }
          }
          timeoutMinutes = Math.trunc(parsed)
        }

        const description = String(args.description ?? '').trim() || undefined
        const task = queries.createTask(db, {
          name,
          prompt,
          description,
          triggerType,
          cronExpression,
          scheduledAt,
          workerId: workerId ?? undefined,
          maxTurns,
          timeoutMinutes,
          roomId: room?.id ?? undefined,
          executor: 'claude_code',
          triggerConfig: JSON.stringify({ source: 'clerk' })
        })

        const scheduleLabel = triggerType === 'cron'
          ? `cron ${cronExpression}`
          : triggerType === 'once'
            ? `at ${scheduledAt}`
            : 'manual'
        return { content: `Created task "${task.name}" (#${task.id}, ${scheduleLabel}).` }
      }

      case 'quoroom_remind_keeper': {
        const message = String(args.message ?? '').trim()
        if (!message) return { content: 'Error: message is required.', isError: true }

        const parsedScheduled = parseScheduledAt(args.scheduledAt)
        if (parsedScheduled.error) return { content: parsedScheduled.error, isError: true }
        const scheduledAt = parsedScheduled.scheduledAt
        if (!scheduledAt) return { content: 'Error: scheduledAt is required.', isError: true }

        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const customName = String(args.name ?? '').trim()
        const fallback = message.length > 48 ? `${message.slice(0, 48)}...` : message
        const name = customName || `Reminder: ${fallback}`

        const task = queries.createTask(db, {
          name,
          prompt: message,
          description: 'Keeper reminder scheduled by Clerk',
          triggerType: 'once',
          scheduledAt,
          roomId: room?.id ?? undefined,
          executor: 'keeper_reminder',
          maxRuns: 1,
          triggerConfig: JSON.stringify({ source: 'clerk', kind: 'keeper_reminder' })
        })
        const roomNote = room ? ` for room "${room.name}"` : ''
        return { content: `Scheduled keeper reminder #${task.id}${roomNote} at ${scheduledAt}.` }
      }

      case 'quoroom_send_email': {
        const to = String(args.to ?? '').trim()
        if (!to) return { content: 'Error: to is required.', isError: true }
        const body = String(args.body ?? '').trim()
        if (!body) return { content: 'Error: body is required.', isError: true }
        if (!ctx?.sendEmail) return { content: 'Error: email sending is not available in this context.', isError: true }
        const subject = String(args.subject ?? '').trim() || undefined
        const sent = await ctx.sendEmail(to, body, subject)
        if (!sent) return { content: 'Failed to send email. Cloud relay unavailable or no rooms connected.', isError: true }
        return { content: `Email sent to ${to}.` }
      }

      case 'quoroom_get_setting': {
        const key = String(args.key ?? '').trim()
        if (!key) return { content: 'Error: key is required.', isError: true }
        const value = queries.getSetting(db, key)
        return { content: `${key}=${value ?? ''}` }
      }

      case 'quoroom_set_setting': {
        const key = String(args.key ?? '').trim()
        if (!key) return { content: 'Error: key is required.', isError: true }
        const value = String(args.value ?? '')
        queries.setSetting(db, key, value)
        return { content: `Setting "${key}" updated.` }
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
