import type { TRIGGER_TYPES, TASK_STATUSES, ROOM_STATUSES, AGENT_STATES, DECISION_TYPES, GOAL_STATUSES, STATION_STATUSES, STATION_TIERS, STATION_PROVIDERS, WALLET_TX_TYPES } from './constants'

// ─── Derived Union Types ──────────────────────────────────

export type TriggerType = typeof TRIGGER_TYPES[keyof typeof TRIGGER_TYPES]
export type TaskStatus = typeof TASK_STATUSES[keyof typeof TASK_STATUSES]
export type RoomStatus = typeof ROOM_STATUSES[keyof typeof ROOM_STATUSES]
export type AgentState = typeof AGENT_STATES[keyof typeof AGENT_STATES]
export type DecisionType = typeof DECISION_TYPES[keyof typeof DECISION_TYPES]
export type GoalStatus = typeof GOAL_STATUSES[keyof typeof GOAL_STATUSES]
export type DecisionStatus = 'voting' | 'approved' | 'rejected' | 'vetoed' | 'expired'
export type VoteValue = 'yes' | 'no' | 'abstain'
export type ActivityEventType = 'decision' | 'milestone' | 'financial' | 'deployment' | 'worker' | 'error' | 'system' | 'self_mod'
export type EscalationStatus = 'pending' | 'in_progress' | 'resolved'
export type StationStatus = typeof STATION_STATUSES[keyof typeof STATION_STATUSES]
export type StationTier = typeof STATION_TIERS[keyof typeof STATION_TIERS]
export type StationProvider = typeof STATION_PROVIDERS[keyof typeof STATION_PROVIDERS]
export type WalletTransactionType = typeof WALLET_TX_TYPES[keyof typeof WALLET_TX_TYPES]

// ─── Worker Types ──────────────────────────────────────────

export interface Worker {
  id: number
  name: string
  role: string | null
  systemPrompt: string
  description: string | null
  model: string | null
  isDefault: boolean
  taskCount: number
  cycleGapMs: number | null
  maxTurns: number | null
  roomId: number | null
  agentState: AgentState
  votesCast: number
  votesMissed: number
  wip: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateWorkerInput {
  name: string
  role?: string
  systemPrompt: string
  description?: string
  model?: string
  isDefault?: boolean
  cycleGapMs?: number | null
  maxTurns?: number | null
  roomId?: number
  agentState?: AgentState
}

// ─── Memory Types ───────────────────────────────────────────

export interface Entity {
  id: number
  name: string
  type: string
  category: string | null
  roomId: number | null
  created_at: string
  updated_at: string
}

export interface Observation {
  id: number
  entity_id: number
  content: string
  source: string
  created_at: string
}

export interface Relation {
  id: number
  from_entity: number
  to_entity: number
  relation_type: string
  created_at: string
}

// ─── Task Types ─────────────────────────────────────────────

export interface Task {
  id: number
  name: string
  description: string | null
  prompt: string
  cronExpression: string | null
  triggerType: TriggerType
  triggerConfig: string | null
  webhookToken: string | null
  scheduledAt: string | null
  executor: string
  status: TaskStatus
  lastRun: string | null
  lastResult: string | null
  errorCount: number
  maxRuns: number | null
  runCount: number
  memoryEntityId: number | null
  workerId: number | null
  sessionContinuity: boolean
  sessionId: string | null
  timeoutMinutes: number | null
  maxTurns: number | null
  allowedTools: string | null
  disallowedTools: string | null
  learnedContext: string | null
  roomId: number | null
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  name: string
  description?: string
  prompt: string
  cronExpression?: string
  triggerType?: TriggerType
  triggerConfig?: string
  webhookToken?: string
  scheduledAt?: string
  executor?: string
  maxRuns?: number
  workerId?: number
  sessionContinuity?: boolean
  timeoutMinutes?: number
  maxTurns?: number
  allowedTools?: string
  disallowedTools?: string
  roomId?: number
}

export interface TaskRun {
  id: number
  taskId: number
  startedAt: string
  finishedAt: string | null
  status: string
  result: string | null
  resultFile: string | null
  errorMessage: string | null
  durationMs: number | null
  progress: number | null
  progressMessage: string | null
  sessionId: string | null
}

// ─── Console Log Types ──────────────────────────────────────

export interface ConsoleLogEntry {
  id: number
  runId: number
  seq: number
  entryType: string
  content: string
  createdAt: string
}

// ─── Worker Cycle Types ─────────────────────────────────────

export interface WorkerCycle {
  id: number
  workerId: number
  roomId: number
  model: string | null
  startedAt: string
  finishedAt: string | null
  status: string
  errorMessage: string | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface CycleLogEntry {
  id: number
  cycleId: number
  seq: number
  entryType: string
  content: string
  createdAt: string
}

// ─── Watch Types ────────────────────────────────────────────

export interface Watch {
  id: number
  path: string
  description: string | null
  actionPrompt: string | null
  status: string
  lastTriggered: string | null
  triggerCount: number
  roomId: number | null
  createdAt: string
}

// ─── Memory Stats ───────────────────────────────────────────

export interface MemoryStats {
  entityCount: number
  observationCount: number
  relationCount: number
}

// ─── Room Types ─────────────────────────────────────────────

export interface RoomConfig {
  threshold: 'majority' | 'supermajority' | 'unanimous'
  timeoutMinutes: number
  tieBreaker: 'queen' | 'none'
  autoApprove: string[]
  minCycleGapMs: number
  minVoters: number
  sealedBallot: boolean
  voterHealth: boolean
  voterHealthThreshold: number
}

export interface Room {
  id: number
  name: string
  queenWorkerId: number | null
  goal: string | null
  status: RoomStatus
  visibility: 'private' | 'public'
  autonomyMode: 'auto' | 'semi'
  maxConcurrentTasks: number
  workerModel: string
  queenCycleGapMs: number
  queenMaxTurns: number
  queenQuietFrom: string | null
  queenQuietUntil: string | null
  config: RoomConfig
  queenNickname: string | null
  chatSessionId: string | null
  referredByCode: string | null
  allowedTools: string | null
  webhookToken: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateRoomInput {
  name: string
  goal?: string
  queenSystemPrompt?: string
  referredByCode?: string
  config?: Partial<RoomConfig>
}

// ─── Room Activity Types ────────────────────────────────────

export interface RoomActivityEntry {
  id: number
  roomId: number
  eventType: ActivityEventType
  actorId: number | null
  summary: string
  details: string | null
  isPublic: boolean
  createdAt: string
}

// ─── Quorum Types ───────────────────────────────────────────

export interface QuorumDecision {
  id: number
  roomId: number
  proposerId: number | null
  proposal: string
  decisionType: DecisionType
  status: DecisionStatus
  result: string | null
  threshold: string
  timeoutAt: string | null
  keeperVote: VoteValue | null
  minVoters: number
  sealed: boolean
  createdAt: string
  resolvedAt: string | null
}

export interface QuorumVote {
  id: number
  decisionId: number
  workerId: number
  vote: VoteValue
  reasoning: string | null
  createdAt: string
}

// ─── Goal Types ─────────────────────────────────────────────

export interface Goal {
  id: number
  roomId: number
  description: string
  status: GoalStatus
  parentGoalId: number | null
  assignedWorkerId: number | null
  progress: number
  createdAt: string
  updatedAt: string
}

export interface GoalUpdate {
  id: number
  goalId: number
  workerId: number | null
  observation: string
  metricValue: number | null
  createdAt: string
}

// ─── Skill Types ────────────────────────────────────────────

export interface Skill {
  id: number
  roomId: number | null
  name: string
  content: string
  activationContext: string[] | null
  autoActivate: boolean
  agentCreated: boolean
  createdByWorkerId: number | null
  version: number
  createdAt: string
  updatedAt: string
}

// ─── Self-Mod Types ─────────────────────────────────────────

export interface SelfModAuditEntry {
  id: number
  roomId: number | null
  workerId: number | null
  filePath: string
  oldHash: string | null
  newHash: string | null
  reason: string | null
  reversible: boolean
  reverted: boolean
  createdAt: string
}

export interface SelfModSnapshot {
  auditId: number
  targetType: string
  targetId: number | null
  oldContent: string | null
  newContent: string | null
}

// ─── Escalation Types ───────────────────────────────────────

export interface Escalation {
  id: number
  roomId: number
  fromAgentId: number | null
  toAgentId: number | null
  question: string
  answer: string | null
  status: EscalationStatus
  createdAt: string
  resolvedAt: string | null
}

// ─── Chat Types ─────────────────────────────────────────────

export interface ChatMessage {
  id: number
  roomId: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

// ─── Clerk Types ────────────────────────────────────────────

export interface ClerkMessage {
  id: number
  role: 'user' | 'assistant' | 'commentary'
  content: string
  source: ClerkMessageSource | null
  createdAt: string
}

export type ClerkMessageSource = 'assistant' | 'commentary' | 'task' | 'email' | 'telegram'
export type ClerkUsageSource = 'chat' | 'commentary'

export interface ClerkUsageEntry {
  id: number
  source: ClerkUsageSource
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  success: boolean
  usedFallback: boolean
  attempts: number
  createdAt: string
}

export interface ClerkUsageSummary {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

// ─── Credential Types ───────────────────────────────────────

export interface Credential {
  id: number
  roomId: number
  name: string
  type: 'api_key' | 'account' | 'card' | 'other'
  valueEncrypted: string
  providedBy: string
  createdAt: string
}

// ─── Wallet Types ──────────────────────────────────────────

export interface Wallet {
  id: number
  roomId: number
  address: string
  privateKeyEncrypted: string
  chain: string
  erc8004AgentId: string | null
  createdAt: string
}

export type WalletTransactionCategory = 'revenue' | 'expense' | 'transfer' | 'station_cost'

export interface WalletTransaction {
  id: number
  walletId: number
  type: WalletTransactionType
  amount: string
  counterparty: string | null
  txHash: string | null
  description: string | null
  status: string
  category: WalletTransactionCategory | null
  createdAt: string
}

// ─── Station Types ─────────────────────────────────────────

export interface Station {
  id: number
  roomId: number
  name: string
  provider: StationProvider
  externalId: string | null
  tier: StationTier
  region: string | null
  status: StationStatus
  monthlyCost: number
  config: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface CreateStationInput {
  roomId: number
  name: string
  provider: StationProvider
  tier: StationTier
  region?: string
  config?: Record<string, unknown>
}

// ─── Room Message Types ────────────────────────────────────

export type RoomMessageDirection = 'inbound' | 'outbound'
export type RoomMessageStatus = 'unread' | 'read' | 'replied'

export interface RoomMessage {
  id: number
  roomId: number
  direction: RoomMessageDirection
  fromRoomId: string | null
  toRoomId: string | null
  subject: string
  body: string
  status: RoomMessageStatus
  createdAt: string
}

// ─── Revenue Types ─────────────────────────────────────────

export interface RevenueSummary {
  totalIncome: number
  totalExpenses: number
  netProfit: number
  stationCosts: number
  transactionCount: number
}

export interface OnChainBalance {
  totalBalance: number
  byChain: Record<string, { usdc: number; usdt: number; total: number }>
  address: string
  fetchedAt: string
}

export interface CryptoPricing {
  treasuryAddress: string
  chains: string[]
  tokens: string[]
  multiplier: number
  tiers: Array<{ tier: string; stripePrice: number; cryptoPrice: number }>
}
