import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'
import { checkExpiredDecisions } from '../../../shared/quorum'

// Capture tool handlers by mocking McpServer
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const toolHandlers = new Map<string, ToolHandler>()

const mockServer = {
  registerTool: (_name: string, _opts: unknown, handler: ToolHandler) => {
    toolHandlers.set(_name, handler)
  }
}

// Mock getMcpDatabase to return our test DB
let db: Database.Database
vi.mock('../../db', () => ({
  getMcpDatabase: () => db
}))

// Mock task-runner to avoid spawning real processes
vi.mock('../../../shared/task-runner', () => ({
  executeTask: vi.fn().mockResolvedValue({
    success: true,
    output: 'Task output here',
    durationMs: 1234,
    errorMessage: null
  }),
  isTaskRunning: vi.fn().mockReturnValue(false)
}))

// Mock embeddings for memory tools
vi.mock('../../../shared/embeddings', () => ({
  embed: vi.fn(),
  isEngineReady: () => false,
  cosineSimilarity: vi.fn(),
  blobToVector: vi.fn(),
  initEngine: vi.fn().mockResolvedValue(undefined)
}))

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  // Dynamically import and register all tools
  const { registerSchedulerTools } = await import('../scheduler')
  const { registerMemoryTools } = await import('../memory')
  const { registerWorkerTools } = await import('../workers')
  const { registerWatcherTools } = await import('../watcher')
  const { registerRoomTools } = await import('../room')
  const { registerQuorumTools } = await import('../quorum')
  const { registerGoalTools } = await import('../goals')
  const { registerSkillTools } = await import('../skills')
  const { registerSelfModTools } = await import('../self-mod')

  registerSchedulerTools(mockServer as never)
  registerMemoryTools(mockServer as never)
  registerWorkerTools(mockServer as never)
  registerWatcherTools(mockServer as never)
  registerRoomTools(mockServer as never)
  registerQuorumTools(mockServer as never)
  registerGoalTools(mockServer as never)
  registerSkillTools(mockServer as never)
  registerSelfModTools(mockServer as never)
})

afterEach(() => {
  db.close()
})

function getResponseText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

// ─── Response format rules ────────────────────────────────────
// Every confirmation response must:
//   1. NOT contain task/entity IDs like "(id: 5)"
//   2. NOT contain cron expressions like "0 9 * * *"
//   3. NOT contain "session continuity"
//   4. NOT contain "Worker:" or worker details
//   5. NOT contain "Timeout:" or timeout details
//   6. NOT contain "quoroom_run_task" or other tool names
//   7. NOT contain "Electron"
//   8. NOT contain "[IMPORTANT:" or other prompt instructions

const FORBIDDEN_PATTERNS = [
  /\(id:\s*\d+\)/i,
  /schedule:\s*[\d*]/i,
  /session continuity/i,
  /\bWorker:/i,
  /\bTimeout:/i,
  /quoroom_\w+/i,
  /\bElectron\b/i,
  /\[IMPORTANT:/i,
  /RESPONSE STYLE/i,
]

function assertCleanResponse(text: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    expect(text, `Response leaked forbidden pattern ${pattern}: "${text}"`).not.toMatch(pattern)
  }
}

// ─── Scheduler tools ──────────────────────────────────────────

describe('quoroom_schedule responses', () => {
  it('cron task: clean, no implementation details', async () => {
    const handler = toolHandlers.get('quoroom_schedule')!
    const result = await handler({
      name: 'Morning Digest',
      prompt: 'Summarize HN stories',
      cronExpression: '0 9 * * 1-5',
      sessionContinuity: true,
      timeout: 60
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Morning Digest')
    expect(text).not.toContain('0 9 * * 1-5')
    expect(text).not.toContain('session')
    expect(text).not.toContain('60')
  })

  it('one-time task: clean, no implementation details', async () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString()
    const handler = toolHandlers.get('quoroom_schedule')!
    const result = await handler({
      name: 'One-off Report',
      prompt: 'Generate a report',
      scheduledAt: futureDate,
      timeout: 120
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('One-off Report')
    expect(text).not.toContain('120')
  })

  it('manual task: clean, no implementation details', async () => {
    const handler = toolHandlers.get('quoroom_schedule')!
    const result = await handler({
      name: 'Ad-hoc Task',
      prompt: 'Do something on demand'
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Ad-hoc Task')
    expect(text).not.toContain('quoroom_run_task')
  })

  it('task with worker: does not expose worker details', async () => {
    const worker = queries.createWorker(db, {
      name: 'Researcher',
      systemPrompt: 'You are a researcher.',
      description: 'Research worker'
    })
    const handler = toolHandlers.get('quoroom_schedule')!
    const result = await handler({
      name: 'Research Task',
      prompt: 'Research AI trends',
      cronExpression: '0 10 * * *',
      workerId: worker.id
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).not.toContain('Researcher')
    expect(text).not.toContain('Worker')
  })
})

describe('quoroom_pause_task response', () => {
  it('clean confirmation, no ID', async () => {
    const task = queries.createTask(db, {
      name: 'My Task',
      prompt: 'do stuff',
      triggerType: 'manual',
      executor: 'claude_code'
    })
    const handler = toolHandlers.get('quoroom_pause_task')!
    const result = await handler({ id: task.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('My Task')
  })
})

describe('quoroom_resume_task response', () => {
  it('clean confirmation, no ID', async () => {
    const task = queries.createTask(db, {
      name: 'My Task',
      prompt: 'do stuff',
      triggerType: 'manual',
      executor: 'claude_code'
    })
    queries.pauseTask(db, task.id)
    const handler = toolHandlers.get('quoroom_resume_task')!
    const result = await handler({ id: task.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('My Task')
  })
})

describe('quoroom_delete_task response', () => {
  it('clean confirmation, no ID', async () => {
    const task = queries.createTask(db, {
      name: 'My Task',
      prompt: 'do stuff',
      triggerType: 'manual',
      executor: 'claude_code'
    })
    const handler = toolHandlers.get('quoroom_delete_task')!
    const result = await handler({ id: task.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('My Task')
  })
})

describe('quoroom_reset_session response', () => {
  it('clean confirmation, no ID', async () => {
    const task = queries.createTask(db, {
      name: 'Session Task',
      prompt: 'do stuff',
      triggerType: 'manual',
      executor: 'claude_code',
      sessionContinuity: true
    })
    const handler = toolHandlers.get('quoroom_reset_session')!
    const result = await handler({ id: task.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Session Task')
  })
})

// ─── Memory tools ─────────────────────────────────────────────

describe('quoroom_remember response', () => {
  it('clean confirmation, no ID or category', async () => {
    const handler = toolHandlers.get('quoroom_remember')!
    const result = await handler({
      name: 'favorite color',
      content: 'Blue is their favorite color',
      type: 'preference',
      category: 'personal'
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('favorite color')
    expect(text).not.toContain('personal')
    expect(text).not.toContain('category')
  })
})

describe('quoroom_forget response', () => {
  it('clean confirmation, no ID', async () => {
    const entity = queries.createEntity(db, 'old memory', 'fact', 'work')
    const handler = toolHandlers.get('quoroom_forget')!
    const result = await handler({ id: entity.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('old memory')
  })
})

// ─── Worker tools ─────────────────────────────────────────────

describe('quoroom_create_worker response', () => {
  it('clean confirmation, no ID or default note', async () => {
    const handler = toolHandlers.get('quoroom_create_worker')!
    const result = await handler({
      name: 'News Curator',
      systemPrompt: 'You curate news.',
      isDefault: true
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('News Curator')
    expect(text).not.toContain('default')
  })

  it('includes role in response when provided', async () => {
    const handler = toolHandlers.get('quoroom_create_worker')!
    const result = await handler({
      name: 'Morgan',
      role: 'Chief of Staff',
      systemPrompt: 'You are a chief of staff.'
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Morgan')
    expect(text).toContain('Chief of Staff')
  })

  it('omits role from response when not provided', async () => {
    const handler = toolHandlers.get('quoroom_create_worker')!
    const result = await handler({
      name: 'Solo Worker',
      systemPrompt: 'You work alone.'
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Solo Worker')
    expect(text).not.toContain('(')
  })
})

describe('quoroom_update_worker response', () => {
  it('clean confirmation, no ID', async () => {
    const worker = queries.createWorker(db, {
      name: 'Old Name',
      systemPrompt: 'prompt'
    })
    const handler = toolHandlers.get('quoroom_update_worker')!
    const result = await handler({ id: worker.id, name: 'New Name' })
    const text = getResponseText(result)
    assertCleanResponse(text)
  })

  it('updates role field', async () => {
    const worker = queries.createWorker(db, {
      name: 'Morgan',
      systemPrompt: 'prompt'
    })
    const handler = toolHandlers.get('quoroom_update_worker')!
    await handler({ id: worker.id, role: 'Chief of Staff' })
    const updated = queries.getWorker(db, worker.id)!
    expect(updated.role).toBe('Chief of Staff')
  })
})

describe('quoroom_list_workers response', () => {
  it('includes role for each worker', async () => {
    queries.createWorker(db, { name: 'Morgan', role: 'Chief of Staff', systemPrompt: 'p' })
    queries.createWorker(db, { name: 'Ada', systemPrompt: 'p' })
    const handler = toolHandlers.get('quoroom_list_workers')!
    const result = await handler({})
    const text = getResponseText(result)
    const data = JSON.parse(text)
    expect(data).toHaveLength(2)
    const morgan = data.find((w: Record<string, unknown>) => w.name === 'Morgan')
    const ada = data.find((w: Record<string, unknown>) => w.name === 'Ada')
    expect(morgan.role).toBe('Chief of Staff')
    expect(ada.role).toBeNull()
  })
})

describe('quoroom_delete_worker response', () => {
  it('clean confirmation, no ID', async () => {
    const worker = queries.createWorker(db, {
      name: 'Doomed Worker',
      systemPrompt: 'prompt'
    })
    const handler = toolHandlers.get('quoroom_delete_worker')!
    const result = await handler({ id: worker.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('Doomed Worker')
  })
})

// ─── Watcher tools ────────────────────────────────────────────

describe('quoroom_watch response', () => {
  it('clean confirmation, no ID', async () => {
    const testPath = join(homedir(), 'test-downloads')
    const handler = toolHandlers.get('quoroom_watch')!
    const result = await handler({
      path: testPath,
      actionPrompt: 'Process new files'
    })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('test-downloads')
  })
})

describe('quoroom_unwatch response', () => {
  it('clean confirmation, no ID', async () => {
    const watch = queries.createWatch(db, '/Users/test/docs', 'test watch', 'do stuff')
    const handler = toolHandlers.get('quoroom_unwatch')!
    const result = await handler({ id: watch.id })
    const text = getResponseText(result)
    assertCleanResponse(text)
    expect(text).toContain('/Users/test/docs')
  })
})

// ─── Room tools ──────────────────────────────────────────────

describe('quoroom_create_room', () => {
  it('creates room with goal', async () => {
    const handler = toolHandlers.get('quoroom_create_room')!
    const result = await handler({ name: 'saasbuilder', goal: 'Build micro-SaaS products' })
    const text = getResponseText(result)
    expect(text).toContain('saasbuilder')
    expect(text).toContain('Build micro-SaaS products')
  })

  it('creates room without goal', async () => {
    const handler = toolHandlers.get('quoroom_create_room')!
    const result = await handler({ name: 'emptyroom' })
    const text = getResponseText(result)
    expect(text).toContain('emptyroom')
  })

  it('applies plan-aware cycle gap defaults', async () => {
    queries.setSetting(db, 'claude_plan', 'max')
    const handler = toolHandlers.get('quoroom_create_room')!
    await handler({ name: 'planroom' })
    const room = queries.listRooms(db).find(r => r.name === 'planroom')!
    expect(room.queenCycleGapMs).toBe(30_000)   // max plan → 30s
    expect(room.queenMaxTurns).toBe(30)
  })

  it('falls back to none plan defaults when no plan set', async () => {
    const handler = toolHandlers.get('quoroom_create_room')!
    await handler({ name: 'noplan' })
    const room = queries.listRooms(db).find(r => r.name === 'noplan')!
    expect(room.queenCycleGapMs).toBe(600_000)  // none plan → 10 min
    expect(room.queenMaxTurns).toBe(30)
  })
})

describe('quoroom_list_rooms', () => {
  it('returns empty when no rooms', async () => {
    const handler = toolHandlers.get('quoroom_list_rooms')!
    const result = await handler({})
    expect(getResponseText(result)).toContain('No rooms')
  })

  it('lists rooms after creation', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'rooma' })
    const handler = toolHandlers.get('quoroom_list_rooms')!
    const result = await handler({})
    const text = getResponseText(result)
    const data = JSON.parse(text)
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('rooma')
  })

  it('filters by status', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'activeroom' })
    const handler = toolHandlers.get('quoroom_list_rooms')!
    const result = await handler({ status: 'paused' })
    expect(getResponseText(result)).toContain('No rooms')
  })
})

describe('quoroom_pause_room', () => {
  it('pauses an active room', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'room' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_pause_room')!
    const result = await handler({ id: rooms[0].id })
    expect(getResponseText(result)).toContain('paused')
  })

  it('returns error for non-existent room', async () => {
    const handler = toolHandlers.get('quoroom_pause_room')!
    const result = await handler({ id: 999 })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_restart_room', () => {
  it('restarts with new goal', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'room', goal: 'Old goal' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_restart_room')!
    const result = await handler({ id: rooms[0].id, newGoal: 'New goal' })
    expect(getResponseText(result)).toContain('New goal')
  })
})

describe('quoroom_delete_room', () => {
  it('deletes a room', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'Doomed' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_delete_room')!
    const result = await handler({ id: rooms[0].id })
    expect(getResponseText(result)).toContain('deleted')
    expect(queries.listRooms(db)).toHaveLength(0)
  })
})

describe('quoroom_room_status', () => {
  it('returns room status with workers and goals', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'testroom', goal: 'Make money' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_room_status')!
    const result = await handler({ id: rooms[0].id })
    const data = JSON.parse(getResponseText(result))
    expect(data.room.name).toBe('testroom')
    expect(data.workers.length).toBeGreaterThan(0)
    expect(data.activeGoals.length).toBeGreaterThan(0)
  })

  it('returns error for non-existent room', async () => {
    const handler = toolHandlers.get('quoroom_room_status')!
    const result = await handler({ id: 999 })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_room_activity', () => {
  it('returns activity feed', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'activeroom' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_room_activity')!
    const result = await handler({ id: rooms[0].id })
    const data = JSON.parse(getResponseText(result))
    expect(data.length).toBeGreaterThan(0)
    // First entry is most recent (wallet creation = financial), room creation = system
    expect(data.some((d: any) => d.eventType === 'system')).toBe(true)
  })

  it('returns no activity message for empty room', async () => {
    const room = queries.createRoom(db, 'Empty', null, { threshold: 'majority', timeoutMinutes: 60, tieBreaker: 'queen', autoApprove: ['low_impact'], minCycleGapMs: 1000 })
    const handler = toolHandlers.get('quoroom_room_activity')!
    const result = await handler({ id: room.id })
    expect(getResponseText(result)).toContain('No activity')
  })
})

// ─── Quorum tools ────────────────────────────────────────────

describe('quoroom_propose', () => {
  let roomId: number
  let queenId: number

  beforeEach(async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'voteroom', goal: 'test' })
    const rooms = queries.listRooms(db)
    roomId = rooms[0].id
    queenId = rooms[0].queenWorkerId!
  })

  it('creates a voting proposal', async () => {
    const handler = toolHandlers.get('quoroom_propose')!
    const result = await handler({
      roomId, proposerId: queenId,
      proposal: 'Build a SaaS product', decisionType: 'strategy'
    })
    const text = getResponseText(result)
    expect(text).toContain('Build a SaaS product')
  })

  it('auto-approves low_impact decisions', async () => {
    const handler = toolHandlers.get('quoroom_propose')!
    const result = await handler({
      roomId, proposerId: queenId,
      proposal: 'Minor tweak', decisionType: 'low_impact'
    })
    expect(getResponseText(result)).toContain('auto-approved')
  })
})

describe('quoroom_vote', () => {
  it('records objection when voting no on an announced decision', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'ObjRoom', goal: 'test' })
    const rooms = queries.listRooms(db)
    const roomId = rooms[0].id
    const queenId = rooms[0].queenWorkerId!
    const worker = queries.createWorker(db, { name: 'Worker A', systemPrompt: 'w', roomId })

    await toolHandlers.get('quoroom_propose')!({
      roomId, proposerId: queenId,
      proposal: 'Switch infra provider', decisionType: 'strategy'
    })
    const decision = queries.listDecisions(db, roomId, 'announced')[0]

    const handler = toolHandlers.get('quoroom_vote')!
    const result = await handler({
      decisionId: decision.id, workerId: worker.id, vote: 'no', reasoning: 'Too risky now'
    })
    expect(getResponseText(result)).toContain('Objection recorded')
    expect(queries.getDecision(db, decision.id)!.status).toBe('objected')
  })

  it('casts a vote and resolves decision', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'VR', goal: 'test' })
    const rooms = queries.listRooms(db)
    const roomId = rooms[0].id
    const queenId = rooms[0].queenWorkerId!

    // Create a proposal
    const decision = queries.createDecision(db, roomId, queenId, 'Test proposal?', 'strategy')

    const handler = toolHandlers.get('quoroom_vote')!
    const result = await handler({
      decisionId: decision.id, workerId: queenId,
      vote: 'yes', reasoning: 'Makes sense'
    })
    const text = getResponseText(result)
    expect(text).toContain('Vote')
  })

  it('keeps announced decisions effective when no objection is raised before expiry sweep', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'EffRoom', goal: 'test' })
    const rooms = queries.listRooms(db)
    const roomId = rooms[0].id
    const queenId = rooms[0].queenWorkerId!

    await toolHandlers.get('quoroom_propose')!({
      roomId, proposerId: queenId,
      proposal: 'Adopt weekly delivery cadence', decisionType: 'strategy'
    })
    const decision = queries.listDecisions(db, roomId, 'announced')[0]
    const past = new Date(Date.now() - 60_000)
    const localTimeStr = [
      past.getFullYear(),
      String(past.getMonth() + 1).padStart(2, '0'),
      String(past.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(past.getHours()).padStart(2, '0'),
      String(past.getMinutes()).padStart(2, '0'),
      String(past.getSeconds()).padStart(2, '0')
    ].join(':')
    db.prepare('UPDATE quorum_decisions SET effective_at = ? WHERE id = ?').run(localTimeStr, decision.id)

    const updatedCount = checkExpiredDecisions(db)
    expect(updatedCount).toBe(1)
    expect(queries.getDecision(db, decision.id)!.status).toBe('effective')
  })

  it('returns error for invalid decision', async () => {
    const handler = toolHandlers.get('quoroom_vote')!
    const result = await handler({
      decisionId: 999, workerId: 1, vote: 'yes'
    })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_list_decisions', () => {
  it('returns no decisions message', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'DR' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_list_decisions')!
    const result = await handler({ roomId: rooms[0].id })
    expect(getResponseText(result)).toContain('No decisions')
  })
})

describe('quoroom_decision_detail', () => {
  it('returns decision with votes', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'DD' })
    const rooms = queries.listRooms(db)
    const decision = queries.createDecision(db, rooms[0].id, rooms[0].queenWorkerId!, 'Test?', 'strategy')

    const handler = toolHandlers.get('quoroom_decision_detail')!
    const result = await handler({ id: decision.id })
    const data = JSON.parse(getResponseText(result))
    expect(data.proposal).toBe('Test?')
    expect(data.votes).toEqual([])
  })

  it('returns error for non-existent decision', async () => {
    const handler = toolHandlers.get('quoroom_decision_detail')!
    const result = await handler({ id: 999 })
    expect(result.isError).toBe(true)
  })
})

// ─── Goal tools ──────────────────────────────────────────────

describe('quoroom_set_goal', () => {
  it('sets room objective', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'GR' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_set_goal')!
    const result = await handler({ roomId: rooms[0].id, description: 'Make $10k MRR' })
    expect(getResponseText(result)).toContain('Make $10k MRR')
  })
})

describe('quoroom_create_subgoal', () => {
  it('decomposes goal into sub-goals', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'SG', goal: 'Main' })
    const rooms = queries.listRooms(db)
    const goals = queries.listGoals(db, rooms[0].id)
    const rootGoal = goals[0]

    const handler = toolHandlers.get('quoroom_create_subgoal')!
    const result = await handler({ goalId: rootGoal.id, descriptions: ['Sub A', 'Sub B'] })
    expect(getResponseText(result)).toContain('2 sub-goal')
  })

  it('returns error for non-existent parent', async () => {
    const handler = toolHandlers.get('quoroom_create_subgoal')!
    const result = await handler({ goalId: 999, descriptions: ['Nope'] })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_update_progress', () => {
  it('logs progress observation', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'PR', goal: 'Build' })
    const rooms = queries.listRooms(db)
    const goals = queries.listGoals(db, rooms[0].id)

    const handler = toolHandlers.get('quoroom_update_progress')!
    const result = await handler({ goalId: goals[0].id, observation: 'Made progress', metricValue: 0.5 })
    expect(getResponseText(result)).toContain('logged')
  })
})

describe('quoroom_complete_goal', () => {
  it('marks goal as completed', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'CG', goal: 'Do' })
    const rooms = queries.listRooms(db)
    const goals = queries.listGoals(db, rooms[0].id)

    const handler = toolHandlers.get('quoroom_complete_goal')!
    const result = await handler({ goalId: goals[0].id })
    expect(getResponseText(result)).toContain('completed')
  })
})

describe('quoroom_abandon_goal', () => {
  it('marks goal as abandoned with reason', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'AG', goal: 'Bad idea' })
    const rooms = queries.listRooms(db)
    const goals = queries.listGoals(db, rooms[0].id)

    const handler = toolHandlers.get('quoroom_abandon_goal')!
    const result = await handler({ goalId: goals[0].id, reason: 'Market changed' })
    expect(getResponseText(result)).toContain('Market changed')
  })
})

describe('quoroom_list_goals', () => {
  it('returns tree format', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'LG', goal: 'Root goal' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_list_goals')!
    const result = await handler({ roomId: rooms[0].id })
    expect(getResponseText(result)).toContain('Root goal')
  })

  it('returns no goals message', async () => {
    const room = queries.createRoom(db, 'No Goals', null, { threshold: 'majority', timeoutMinutes: 60, tieBreaker: 'queen', autoApprove: ['low_impact'], minCycleGapMs: 1000 })
    const handler = toolHandlers.get('quoroom_list_goals')!
    const result = await handler({ roomId: room.id })
    expect(getResponseText(result)).toContain('No goals')
  })
})

// ─── Skill tools ─────────────────────────────────────────────

describe('quoroom_create_skill', () => {
  let roomId: number

  beforeEach(async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'SR' })
    roomId = queries.listRooms(db)[0].id
  })

  it('creates a skill without worker', async () => {
    const handler = toolHandlers.get('quoroom_create_skill')!
    const result = await handler({
      roomId, name: 'Web Scraping', content: 'Scrape websites safely.',
      activationContext: ['scraping', 'crawling'], autoActivate: true
    })
    expect(getResponseText(result)).toContain('Web Scraping')
  })

  it('creates an agent-created skill', async () => {
    const queen = queries.listRooms(db)[0].queenWorkerId!
    const handler = toolHandlers.get('quoroom_create_skill')!
    const result = await handler({
      roomId, name: 'Agent Skill', content: 'Learned this.',
      workerId: queen
    })
    expect(getResponseText(result)).toContain('Agent Skill')
    const skills = queries.listSkills(db, roomId)
    expect(skills.some(s => s.agentCreated)).toBe(true)
  })
})

describe('quoroom_edit_skill', () => {
  it('updates content and increments version', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'ES' })
    const roomId = queries.listRooms(db)[0].id
    const skill = queries.createSkill(db, roomId, 'Skill', 'v1 content', {})

    const handler = toolHandlers.get('quoroom_edit_skill')!
    const result = await handler({ skillId: skill.id, content: 'v2 content' })
    expect(getResponseText(result)).toContain('v2')

    const updated = queries.getSkill(db, skill.id)!
    expect(updated.content).toBe('v2 content')
    expect(updated.version).toBe(2)
  })

  it('returns error for non-existent skill', async () => {
    const handler = toolHandlers.get('quoroom_edit_skill')!
    const result = await handler({ skillId: 999, content: 'nope' })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_list_skills', () => {
  it('returns no skills message', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'LS' })
    const roomId = queries.listRooms(db)[0].id
    const handler = toolHandlers.get('quoroom_list_skills')!
    const result = await handler({ roomId })
    expect(getResponseText(result)).toContain('No skills')
  })
})

describe('quoroom_activate_skill', () => {
  it('activates a deactivated skill', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'AS' })
    const roomId = queries.listRooms(db)[0].id
    const skill = queries.createSkill(db, roomId, 'Sk', 'c', { autoActivate: false })

    const handler = toolHandlers.get('quoroom_activate_skill')!
    const result = await handler({ skillId: skill.id })
    expect(getResponseText(result)).toContain('activated')
    expect(queries.getSkill(db, skill.id)!.autoActivate).toBe(true)
  })

  it('returns error for non-existent skill', async () => {
    const handler = toolHandlers.get('quoroom_activate_skill')!
    const result = await handler({ skillId: 999 })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_deactivate_skill', () => {
  it('deactivates a skill', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'DS' })
    const roomId = queries.listRooms(db)[0].id
    const skill = queries.createSkill(db, roomId, 'Sk', 'c', { autoActivate: true })

    const handler = toolHandlers.get('quoroom_deactivate_skill')!
    const result = await handler({ skillId: skill.id })
    expect(getResponseText(result)).toContain('deactivated')
    expect(queries.getSkill(db, skill.id)!.autoActivate).toBe(false)
  })
})

describe('quoroom_delete_skill', () => {
  it('deletes a skill', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'DLS' })
    const roomId = queries.listRooms(db)[0].id
    const skill = queries.createSkill(db, roomId, 'Dead Skill', 'c', {})

    const handler = toolHandlers.get('quoroom_delete_skill')!
    const result = await handler({ skillId: skill.id })
    expect(getResponseText(result)).toContain('Dead Skill')
    expect(getResponseText(result)).toContain('deleted')
    expect(queries.getSkill(db, skill.id)).toBeNull()
  })

  it('returns error for non-existent skill', async () => {
    const handler = toolHandlers.get('quoroom_delete_skill')!
    const result = await handler({ skillId: 999 })
    expect(result.isError).toBe(true)
  })
})

// ─── Self-mod tools ──────────────────────────────────────────

describe('quoroom_self_mod_edit', () => {
  let roomId: number
  let queenId: number

  beforeEach(async () => {
    const { _resetRateLimit } = await import('../../../shared/self-mod')
    _resetRateLimit()
    await toolHandlers.get('quoroom_create_room')!({ name: 'SM' })
    const rooms = queries.listRooms(db)
    roomId = rooms[0].id
    queenId = rooms[0].queenWorkerId!
  })

  it('logs a general modification', async () => {
    const handler = toolHandlers.get('quoroom_self_mod_edit')!
    const result = await handler({
      roomId, workerId: queenId,
      filePath: '/skills/test.md', newContent: 'new content', reason: 'Improving skill'
    })
    expect(getResponseText(result)).toContain('Improving skill')
  })

  it('edits a skill and increments version', async () => {
    const skill = queries.createSkill(db, roomId, 'Editable', 'old content', {})
    const handler = toolHandlers.get('quoroom_self_mod_edit')!
    const result = await handler({
      roomId, workerId: queenId, skillId: skill.id,
      filePath: '/skills/editable.md', newContent: 'new content', reason: 'Better instructions'
    })
    expect(getResponseText(result)).toContain('Editable')
    const updated = queries.getSkill(db, skill.id)!
    expect(updated.content).toBe('new content')
    expect(updated.version).toBe(2)
  })

  it('returns error for forbidden path', async () => {
    const handler = toolHandlers.get('quoroom_self_mod_edit')!
    const result = await handler({
      roomId, workerId: queenId,
      filePath: '.env', newContent: 'secret', reason: 'hack'
    })
    expect(result.isError).toBe(true)
  })

  it('returns error for non-existent skill', async () => {
    const handler = toolHandlers.get('quoroom_self_mod_edit')!
    const result = await handler({
      roomId, workerId: queenId, skillId: 999,
      filePath: '/skills/nope.md', newContent: 'c', reason: 'r'
    })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_self_mod_revert', () => {
  it('reverts a modification', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'RV' })
    const rooms = queries.listRooms(db)
    const entry = queries.logSelfMod(db, rooms[0].id, rooms[0].queenWorkerId!, '/test.md', 'a', 'b', 'test')
    const handler = toolHandlers.get('quoroom_self_mod_revert')!
    const result = await handler({ auditId: entry.id })
    expect(getResponseText(result)).toContain('reverted')
  })
})

describe('quoroom_self_mod_history', () => {
  it('returns no modifications message', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'HI' })
    const rooms = queries.listRooms(db)
    const handler = toolHandlers.get('quoroom_self_mod_history')!
    const result = await handler({ roomId: rooms[0].id })
    expect(getResponseText(result)).toContain('No modifications')
  })

  it('returns modification history', async () => {
    await toolHandlers.get('quoroom_create_room')!({ name: 'HI2' })
    const rooms = queries.listRooms(db)
    queries.logSelfMod(db, rooms[0].id, rooms[0].queenWorkerId!, '/test.md', 'a', 'b', 'reason here')
    const handler = toolHandlers.get('quoroom_self_mod_history')!
    const result = await handler({ roomId: rooms[0].id })
    const data = JSON.parse(getResponseText(result))
    expect(data.length).toBeGreaterThan(0)
    expect(data[0].reason).toBe('reason here')
  })
})
