import { getToken, clearToken, API_BASE } from './auth'
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
  Wallet, WalletTransaction, RevenueSummary, OnChainBalance, CryptoPricing,
  Credential,
  Station,
  RoomMessage,
} from '@shared/types'

async function makeRequest(method: string, path: string, token: string, payload?: string): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: payload
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const retryDelays = [150, 450, 1000]
  let token = await getToken()
  let res: Response | null = null
  let networkErr: unknown = null

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    try {
      res = await makeRequest(method, path, token, payload)
    } catch (err) {
      networkErr = err
      clearToken()
      if (attempt < retryDelays.length - 1) {
        await sleep(retryDelays[attempt])
        token = await getToken({ forceRefresh: true })
        continue
      }
      throw err
    }

    if (res.status !== 401) break

    clearToken()
    if (attempt < retryDelays.length - 1) {
      await sleep(retryDelays[attempt])
      token = await getToken({ forceRefresh: true })
      res = null
      continue
    }
    break
  }

  if (!res) {
    throw networkErr instanceof Error ? networkErr : new Error('Failed to fetch')
  }

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

type ProviderName = 'codex' | 'claude'
type ProviderSessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'

interface ProviderSessionLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

interface ProviderAuthSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  verificationUrl: string | null
  deviceCode: string | null
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderInstallSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderStatusEntry {
  installed: boolean
  version?: string
  connected: boolean | null
  requestedAt: string | null
  disconnectedAt: string | null
  authSession: ProviderAuthSession | null
  installRequestedAt: string | null
  installSession: ProviderInstallSession | null
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
    list: (limit?: number, opts?: { status?: string; includeResult?: boolean }) =>
      request<TaskRun[]>('GET', `/api/runs${qs({ limit, status: opts?.status, includeResult: opts?.includeResult ? 1 : undefined })}`),
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
      request<{
        workerId: number
        name: string
        agentState: string
        running: boolean
        model: string | null
        auth: {
          provider: 'claude_subscription' | 'codex_subscription' | 'openai_api' | 'anthropic_api' | 'ollama'
          mode: 'subscription' | 'api'
          credentialName: string | null
          envVar: string | null
          hasCredential: boolean
          hasEnvKey: boolean
          ready: boolean
        }
      }>('GET', `/api/rooms/${id}/queen`),
    queenStart: (id: number) =>
      request<{ ok: true; running: boolean }>('POST', `/api/rooms/${id}/queen/start`),
    queenStop: (id: number) =>
      request<{ ok: true; running: boolean }>('POST', `/api/rooms/${id}/queen/stop`),
    cloudId: (id: number) =>
      request<{ cloudId: string }>('GET', `/api/rooms/${id}/cloud-id`).then(d => d.cloudId),
    network: (id: number) =>
      request<Array<{
        roomId: string; visibility: 'public' | 'private'; name?: string; goal?: string;
        workerCount?: number; taskCount?: number; earnings?: string; queenModel?: string | null;
        workers?: Array<{ name: string; state: string }>; stations?: Array<{ name: string; status: string; tier: string }>;
        online?: boolean; registeredAt?: string;
      }>>('GET', `/api/rooms/${id}/network`),
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
    keeperVote: (id: number, vote: string) =>
      request<QuorumDecision>('POST', `/api/decisions/${id}/keeper-vote`, { vote }),
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
        codex: { available: boolean; version?: string }
        ollama: { available: boolean; models: Array<{ name: string; size: number }> }
        resources: { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number }
        deploymentMode?: 'local' | 'cloud'
        updateInfo?: { latestVersion: string; releaseUrl: string; assets: { mac: string | null; windows: string | null; linux: string | null } } | null
      }>('GET', '/api/status'),
    checkUpdate: () =>
      request<{
        updateInfo: { latestVersion: string; releaseUrl: string; assets: { mac: string | null; windows: string | null; linux: string | null } } | null
      }>('POST', '/api/status/check-update'),
  },

  // ─── Providers (cloud subscription auth helpers) ───────
  providers: {
    status: () =>
      request<{ codex: ProviderStatusEntry; claude: ProviderStatusEntry }>('GET', '/api/providers/status'),
    connect: (provider: ProviderName) =>
      request<{
        ok: true
        provider: ProviderName
        status: 'pending'
        requestedAt: string
        reused: boolean
        session: ProviderAuthSession
        channel: string
      }>('POST', `/api/providers/${provider}/connect`),
    install: (provider: ProviderName) =>
      request<{
        ok: true
        provider: ProviderName
        status: 'pending' | 'already_installed'
        requestedAt?: string
        reused?: boolean
        installed?: { installed: true; version?: string }
        session: ProviderInstallSession | null
        channel?: string
      }>('POST', `/api/providers/${provider}/install`),
    disconnect: (provider: ProviderName) =>
      request<{
        ok: true
        provider: ProviderName
        status: 'disconnected'
        disconnectedAt: string
        command: string
        commandResult: 'ok' | 'unknown'
      }>('POST', `/api/providers/${provider}/disconnect`),
    latestSession: (provider: ProviderName) =>
      request<{
        session: ProviderAuthSession | null
      }>('GET', `/api/providers/${provider}/session`),
    latestInstallSession: (provider: ProviderName) =>
      request<{ session: ProviderInstallSession | null }>('GET', `/api/providers/${provider}/install-session`),
    session: (sessionId: string) =>
      request<{ session: ProviderAuthSession }>('GET', `/api/providers/sessions/${encodeURIComponent(sessionId)}`),
    cancelSession: (sessionId: string) =>
      request<{
        ok: true
        session: ProviderAuthSession
      }>('POST', `/api/providers/sessions/${encodeURIComponent(sessionId)}/cancel`),
    installSession: (sessionId: string) =>
      request<{ session: ProviderInstallSession }>('GET', `/api/providers/install-sessions/${encodeURIComponent(sessionId)}`),
    cancelInstallSession: (sessionId: string) =>
      request<{
        ok: true
        session: ProviderInstallSession
      }>('POST', `/api/providers/install-sessions/${encodeURIComponent(sessionId)}/cancel`),
  },

  // ─── Ollama ──────────────────────────────────────────
  ollama: {
    start: () =>
      request<{ available: boolean; status: 'running' | 'install_failed' | 'start_failed' }>('POST', '/api/ollama/start'),
    ensureModel: (model: string) =>
      request<{ ok: true; status: 'ready' | 'pulled'; model: string }>('POST', '/api/ollama/ensure-model', { model }),
  },

  // ─── Wallet ───────────────────────────────────────────
  wallet: {
    get: (roomId: number) =>
      request<Wallet>('GET', `/api/rooms/${roomId}/wallet`),
    transactions: (roomId: number, limit?: number) =>
      request<WalletTransaction[]>('GET', `/api/rooms/${roomId}/wallet/transactions${qs({ limit })}`),
    summary: (roomId: number) =>
      request<RevenueSummary>('GET', `/api/rooms/${roomId}/wallet/summary`),
    balance: (roomId: number) =>
      request<OnChainBalance>('GET', `/api/rooms/${roomId}/wallet/balance`),
    onrampUrl: (roomId: number, amount?: number) =>
      request<{ onrampUrl: string }>('GET', `/api/rooms/${roomId}/wallet/onramp-url${qs({ amount })}`),
  },

  // ─── Credentials ──────────────────────────────────────
  credentials: {
    list: (roomId: number) =>
      request<Credential[]>('GET', `/api/rooms/${roomId}/credentials`),
    get: (id: number) =>
      request<Credential>('GET', `/api/credentials/${id}`),
    validate: (roomId: number, name: string, value: string) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/credentials/validate`, { name, value }),
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
    payments: (roomId: number) =>
      request<Array<{ id: string; sourceName: string; status: string; amount: number; currency: string; date: string; paymentMethod: string; cryptoTxHash?: string; cryptoChain?: string }>>('GET', `/api/rooms/${roomId}/cloud-station-payments`),
    cryptoPrices: (roomId: number) =>
      request<CryptoPricing>('GET', `/api/rooms/${roomId}/cloud-stations/crypto-prices`),
    cryptoCheckout: (roomId: number, body: {
      tier: string; name: string
      chain?: string; token?: string
    }) =>
      request<{ ok: boolean; txHash: string; subscriptionId?: number; currentPeriodEnd?: string }>(
        'POST', `/api/rooms/${roomId}/cloud-stations/crypto-checkout`, body
      ),
  },

  // ─── Room Messages (inter-room) ───────────────────────
  roomMessages: {
    list: (roomId: number, status?: string) =>
      request<RoomMessage[]>('GET', `/api/rooms/${roomId}/messages${qs({ status })}`),
    markRead: (roomId: number, messageId: number) =>
      request<{ ok: true }>('POST', `/api/rooms/${roomId}/messages/${messageId}/read`),
    reply: (messageId: number, body: string, subject?: string, toRoomId?: string) =>
      request<RoomMessage>('POST', `/api/messages/${messageId}/reply`, { body, subject, toRoomId }),
  },
}
