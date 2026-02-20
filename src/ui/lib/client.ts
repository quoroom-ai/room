import { getToken, API_BASE } from './auth'
import type {
  Task, CreateTaskInput, TaskRun, ConsoleLogEntry,
  Worker, CreateWorkerInput,
  Entity, Observation, Relation, MemoryStats,
  Watch,
  Room, CreateRoomInput, RoomActivityEntry,
  Goal, GoalUpdate,
  QuorumDecision, QuorumVote,
  Skill,
  Escalation,
  ChatMessage,
  SelfModAuditEntry,
  Wallet, WalletTransaction, RevenueSummary,
  Credential,
  Station,
  RoomMessage,
} from '@shared/types'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken()
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

export const api = {
  // ─── Tasks ───────────────────────────────────────────────
  tasks: {
    list: (roomId?: number, status?: string) =>
      request<Task[]>('GET', `/api/tasks${qs({ roomId, status })}`),
    get: (id: number) =>
      request<Task>('GET', `/api/tasks/${id}`),
    create: (body: CreateTaskInput) =>
      request<Task>('POST', '/api/tasks', body),
    update: (id: number, body: Record<string, unknown>) =>
      request<Task>('PATCH', `/api/tasks/${id}`, body),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/tasks/${id}`),
    pause: (id: number) =>
      request<{ ok: true }>('POST', `/api/tasks/${id}/pause`),
    resume: (id: number) =>
      request<{ ok: true }>('POST', `/api/tasks/${id}/resume`),
    run: (id: number) =>
      request<{ ok: true }>('POST', `/api/tasks/${id}/run`),
    resetSession: (id: number) =>
      request<{ ok: true }>('POST', `/api/tasks/${id}/reset-session`),
    getRuns: (taskId: number, limit?: number) =>
      request<TaskRun[]>('GET', `/api/tasks/${taskId}/runs${qs({ limit })}`),
  },

  // ─── Runs ────────────────────────────────────────────────
  runs: {
    list: (limit?: number) =>
      request<TaskRun[]>('GET', `/api/runs${qs({ limit })}`),
    get: (id: number) =>
      request<TaskRun>('GET', `/api/runs/${id}`),
    getLogs: (runId: number, afterSeq?: number, limit?: number) =>
      request<ConsoleLogEntry[]>('GET', `/api/runs/${runId}/logs${qs({ afterSeq, limit })}`),
  },

  // ─── Workers ─────────────────────────────────────────────
  workers: {
    list: () =>
      request<Worker[]>('GET', '/api/workers'),
    get: (id: number) =>
      request<Worker>('GET', `/api/workers/${id}`),
    create: (body: CreateWorkerInput) =>
      request<Worker>('POST', '/api/workers', body),
    update: (id: number, body: Record<string, unknown>) =>
      request<Worker>('PATCH', `/api/workers/${id}`, body),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/workers/${id}`),
    listForRoom: (roomId: number) =>
      request<Worker[]>('GET', `/api/rooms/${roomId}/workers`),
  },

  // ─── Memory ──────────────────────────────────────────────
  memory: {
    listEntities: (roomId?: number, category?: string) =>
      request<Entity[]>('GET', `/api/memory/entities${qs({ roomId, category })}`),
    getEntity: (id: number) =>
      request<Entity>('GET', `/api/memory/entities/${id}`),
    createEntity: (name: string, type?: string, category?: string, roomId?: number) =>
      request<Entity>('POST', '/api/memory/entities', { name, type, category, roomId }),
    updateEntity: (id: number, body: Record<string, unknown>) =>
      request<Entity>('PATCH', `/api/memory/entities/${id}`, body),
    deleteEntity: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/memory/entities/${id}`),
    searchEntities: (q: string) =>
      request<Entity[]>('GET', `/api/memory/search${qs({ q })}`),
    getStats: () =>
      request<MemoryStats>('GET', '/api/memory/stats'),
    getObservations: (entityId: number) =>
      request<Observation[]>('GET', `/api/memory/entities/${entityId}/observations`),
    addObservation: (entityId: number, content: string, source?: string) =>
      request<Observation>('POST', `/api/memory/entities/${entityId}/observations`, { content, source }),
    deleteObservation: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/memory/observations/${id}`),
    getRelations: (entityId: number) =>
      request<Relation[]>('GET', `/api/memory/entities/${entityId}/relations`),
    addRelation: (fromEntityId: number, toEntityId: number, relationType: string) =>
      request<Relation>('POST', '/api/memory/relations', { fromEntityId, toEntityId, relationType }),
    deleteRelation: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/memory/relations/${id}`),
  },

  // ─── Watches ─────────────────────────────────────────────
  watches: {
    list: (roomId?: number, status?: string) =>
      request<Watch[]>('GET', `/api/watches${qs({ roomId, status })}`),
    get: (id: number) =>
      request<Watch>('GET', `/api/watches/${id}`),
    create: (path: string, description?: string, actionPrompt?: string, roomId?: number) =>
      request<Watch>('POST', '/api/watches', { path, description, actionPrompt, roomId }),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/watches/${id}`),
    pause: (id: number) =>
      request<{ ok: true }>('POST', `/api/watches/${id}/pause`),
    resume: (id: number) =>
      request<{ ok: true }>('POST', `/api/watches/${id}/resume`),
  },

  // ─── Settings ────────────────────────────────────────────
  settings: {
    getAll: () =>
      request<Record<string, string>>('GET', '/api/settings'),
    get: (key: string) =>
      request<{ key: string; value: string | null }>('GET', `/api/settings/${key}`)
        .then(r => r.value),
    set: (key: string, value: string) =>
      request<{ key: string; value: string }>('PUT', `/api/settings/${key}`, { value }),
  },

  // ─── Rooms ───────────────────────────────────────────────
  rooms: {
    list: (status?: string) =>
      request<Room[]>('GET', `/api/rooms${qs({ status })}`),
    get: (id: number) =>
      request<Room>('GET', `/api/rooms/${id}`),
    getStatus: (id: number) =>
      request<unknown>('GET', `/api/rooms/${id}/status`),
    getActivity: (id: number, limit?: number, eventTypes?: string[]) =>
      request<RoomActivityEntry[]>('GET', `/api/rooms/${id}/activity${qs({ limit, eventTypes: eventTypes?.join(',') })}`),
    create: (body: CreateRoomInput) =>
      request<Room>('POST', '/api/rooms', body),
    update: (id: number, body: Record<string, unknown>) =>
      request<Room>('PATCH', `/api/rooms/${id}`, body),
    pause: (id: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${id}/pause`),
    restart: (id: number, goal?: string) =>
      request<{ ok: true }>('POST', `/api/rooms/${id}/restart`, { goal }),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/rooms/${id}`),
    queenStatus: (id: number) =>
      request<{ workerId: number; name: string; agentState: string; running: boolean }>('GET', `/api/rooms/${id}/queen`),
    queenStart: (id: number) =>
      request<{ ok: true; running: boolean }>('POST', `/api/rooms/${id}/queen/start`),
    queenStop: (id: number) =>
      request<{ ok: true; running: boolean }>('POST', `/api/rooms/${id}/queen/stop`),
    cloudId: (id: number) =>
      request<{ cloudId: string }>('GET', `/api/rooms/${id}/cloud-id`).then(d => d.cloudId),
  },

  // ─── Goals ───────────────────────────────────────────────
  goals: {
    list: (roomId: number, status?: string) =>
      request<Goal[]>('GET', `/api/rooms/${roomId}/goals${qs({ status })}`),
    get: (id: number) =>
      request<Goal>('GET', `/api/goals/${id}`),
    getSubgoals: (id: number) =>
      request<Goal[]>('GET', `/api/goals/${id}/subgoals`),
    create: (roomId: number, description: string, parentGoalId?: number, assignedWorkerId?: number) =>
      request<Goal>('POST', `/api/rooms/${roomId}/goals`, { description, parentGoalId, assignedWorkerId }),
    update: (id: number, body: Record<string, unknown>) =>
      request<Goal>('PATCH', `/api/goals/${id}`, body),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/goals/${id}`),
    addUpdate: (id: number, observation: string, metricValue?: number, workerId?: number) =>
      request<GoalUpdate>('POST', `/api/goals/${id}/updates`, { observation, metricValue, workerId }),
    getUpdates: (id: number, limit?: number) =>
      request<GoalUpdate[]>('GET', `/api/goals/${id}/updates${qs({ limit })}`),
  },

  // ─── Decisions ───────────────────────────────────────────
  decisions: {
    list: (roomId: number, status?: string) =>
      request<QuorumDecision[]>('GET', `/api/rooms/${roomId}/decisions${qs({ status })}`),
    get: (id: number) =>
      request<QuorumDecision>('GET', `/api/decisions/${id}`),
    create: (roomId: number, body: Record<string, unknown>) =>
      request<QuorumDecision>('POST', `/api/rooms/${roomId}/decisions`, body),
    resolve: (id: number, status: string, result?: string) =>
      request<QuorumDecision>('POST', `/api/decisions/${id}/resolve`, { status, result }),
    vote: (id: number, workerId: number, vote: string, reasoning?: string) =>
      request<QuorumVote>('POST', `/api/decisions/${id}/vote`, { workerId, vote, reasoning }),
    getVotes: (id: number) =>
      request<QuorumVote[]>('GET', `/api/decisions/${id}/votes`),
  },

  // ─── Skills ──────────────────────────────────────────────
  skills: {
    list: (roomId?: number) =>
      request<Skill[]>('GET', `/api/skills${qs({ roomId })}`),
    get: (id: number) =>
      request<Skill>('GET', `/api/skills/${id}`),
    create: (body: Record<string, unknown>) =>
      request<Skill>('POST', '/api/skills', body),
    update: (id: number, body: Record<string, unknown>) =>
      request<Skill>('PATCH', `/api/skills/${id}`, body),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/skills/${id}`),
  },

  // ─── Escalations ─────────────────────────────────────────
  escalations: {
    list: (roomId: number, toAgentId?: number, status?: string) =>
      request<Escalation[]>('GET', `/api/rooms/${roomId}/escalations${qs({ toAgentId, status })}`),
    create: (roomId: number, fromAgentId: number, question: string, toAgentId?: number) =>
      request<Escalation>('POST', `/api/rooms/${roomId}/escalations`, { fromAgentId, question, toAgentId }),
    resolve: (id: number, answer: string) =>
      request<Escalation>('POST', `/api/escalations/${id}/resolve`, { answer }),
  },

  // ─── Chat ──────────────────────────────────────────────
  chat: {
    messages: (roomId: number) =>
      request<ChatMessage[]>('GET', `/api/rooms/${roomId}/chat/messages`),
    send: (roomId: number, message: string) =>
      request<{ response: string; messages: ChatMessage[] }>('POST', `/api/rooms/${roomId}/chat`, { message }),
    reset: (roomId: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/chat/reset`),
  },

  // ─── Self-Mod ────────────────────────────────────────────
  selfMod: {
    list: (roomId?: number) =>
      request<SelfModAuditEntry[]>('GET', `/api/self-mod/audit${qs({ roomId })}`),
    revert: (id: number) =>
      request<{ ok: true }>('POST', `/api/self-mod/audit/${id}/revert`),
  },

  // ─── Status ────────────────────────────────────────────
  status: {
    get: () =>
      request<{
        version: string
        uptime: number
        dataDir: string
        dbPath: string
        claude: { available: boolean; version?: string }
        ollama: { available: boolean; models: Array<{ name: string; size: number }> }
        resources: { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number }
        updateInfo?: { latestVersion: string; releaseUrl: string; assets: { mac: string | null; windows: string | null; linux: string | null } } | null
      }>('GET', '/api/status'),
  },

  // ─── Wallet ───────────────────────────────────────────
  wallet: {
    get: (roomId: number) =>
      request<Wallet>('GET', `/api/rooms/${roomId}/wallet`),
    transactions: (roomId: number, limit?: number) =>
      request<WalletTransaction[]>('GET', `/api/rooms/${roomId}/wallet/transactions${qs({ limit })}`),
    summary: (roomId: number) =>
      request<RevenueSummary>('GET', `/api/rooms/${roomId}/wallet/summary`),
  },

  // ─── Credentials ──────────────────────────────────────
  credentials: {
    list: (roomId: number) =>
      request<Credential[]>('GET', `/api/rooms/${roomId}/credentials`),
    get: (id: number) =>
      request<Credential>('GET', `/api/credentials/${id}`),
    create: (roomId: number, name: string, value: string, type?: string) =>
      request<Credential>('POST', `/api/rooms/${roomId}/credentials`, { name, value, type }),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/credentials/${id}`),
  },

  // ─── Stations ─────────────────────────────────────────
  stations: {
    list: (roomId: number) =>
      request<Station[]>('GET', `/api/rooms/${roomId}/stations`),
    get: (id: number) =>
      request<Station>('GET', `/api/stations/${id}`),
    create: (roomId: number, body: Record<string, unknown>) =>
      request<Station>('POST', `/api/rooms/${roomId}/stations`, body),
    update: (id: number, body: Record<string, unknown>) =>
      request<Station>('PATCH', `/api/stations/${id}`, body),
    delete: (id: number) =>
      request<{ ok: true }>('DELETE', `/api/stations/${id}`),
  },

  // ─── Cloud Stations (remote control via local proxy) ──────
  cloudStations: {
    list: (roomId: number) =>
      request<Array<Record<string, unknown>>>('GET', `/api/rooms/${roomId}/cloud-stations`),
    start: (roomId: number, id: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/cloud-stations/${id}/start`),
    stop: (roomId: number, id: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/cloud-stations/${id}/stop`),
    cancel: (roomId: number, id: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/cloud-stations/${id}/cancel`),
    delete: (roomId: number, id: number) =>
      request<{ ok: true }>('DELETE', `/api/rooms/${roomId}/cloud-stations/${id}`),
  },

  // ─── Room Messages (inter-room) ───────────────────────
  roomMessages: {
    list: (roomId: number, status?: string) =>
      request<RoomMessage[]>('GET', `/api/rooms/${roomId}/messages${qs({ status })}`),
    markRead: (roomId: number, messageId: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/messages/${messageId}/read`),
  },
}
