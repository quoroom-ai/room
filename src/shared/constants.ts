export const APP_NAME = 'Quoroom'
export const APP_ID = 'ai.quoroom.room'

export const DEFAULTS = {
  EXECUTOR: 'claude_code',
  TRIGGER_TYPE: 'cron',
  OBSERVATION_SOURCE: 'claude',
  ENTITY_TYPE: 'fact',
  WINDOW_WIDTH: 480,
  WINDOW_HEIGHT: 600,
  WINDOW_WIDTH_LARGE: 960,
  WINDOW_HEIGHT_LARGE: 1200,
  PROGRESS_THROTTLE_MS: 2000
} as const

export const TRIGGER_TYPES = {
  CRON: 'cron',
  ONCE: 'once',
  MANUAL: 'manual'
} as const

export const TASK_STATUSES = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed'
} as const

export const SETTINGS = {
  NOTIFICATIONS_ENABLED: 'notifications_enabled',
  LARGE_WINDOW_ENABLED: 'large_window_enabled'
} as const

export const ROOM_STATUSES = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  STOPPED: 'stopped'
} as const

export const AGENT_STATES = {
  IDLE: 'idle',
  THINKING: 'thinking',
  ACTING: 'acting',
  VOTING: 'voting',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'blocked'
} as const

export const DECISION_TYPES = {
  STRATEGY: 'strategy',
  RESOURCE: 'resource',
  PERSONNEL: 'personnel',
  RULE_CHANGE: 'rule_change',
  LOW_IMPACT: 'low_impact'
} as const

export const GOAL_STATUSES = {
  ACTIVE: 'active',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  BLOCKED: 'blocked'
} as const

export const STATION_STATUSES = {
  PROVISIONING: 'provisioning',
  RUNNING: 'running',
  STOPPED: 'stopped',
  ERROR: 'error',
  DELETED: 'deleted'
} as const

export const STATION_TIERS = {
  MICRO: 'micro',
  SMALL: 'small',
  MEDIUM: 'medium',
  LARGE: 'large',
  EPHEMERAL: 'ephemeral',
  GPU: 'gpu'
} as const

export const STATION_PROVIDERS = {
  FLYIO: 'flyio',
  E2B: 'e2b',
  MODAL: 'modal',
  MOCK: 'mock'
} as const

export const WALLET_TX_TYPES = {
  SEND: 'send',
  RECEIVE: 'receive',
  FUND: 'fund',
  PURCHASE: 'purchase'
} as const

export const BASE_CHAIN_CONFIG = {
  chainId: 8453,
  name: 'Base',
  rpcUrl: 'https://mainnet.base.org',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  usdcDecimals: 6
}

export const BASE_SEPOLIA_CONFIG = {
  chainId: 84532,
  name: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
  usdcDecimals: 6
}

export const ERC8004_IDENTITY_REGISTRY = {
  base: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const,
  'base-sepolia': '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const
}

export const ERC8004_REPUTATION_REGISTRY = {
  base: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const,
  'base-sepolia': '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const
}

export const QUEEN_DEFAULTS_BY_PLAN = {
  none: { queenCycleGapMs: 30 * 60 * 1000, queenMaxTurns: 3  }, // 30 min gap, 3 turns (safe default)
  pro:  { queenCycleGapMs: 15 * 60 * 1000, queenMaxTurns: 5  }, // 15 min gap, 5 turns
  max:  { queenCycleGapMs:  1 * 60 * 1000, queenMaxTurns: 10 }, // 1 min gap, 10 turns
  api:  { queenCycleGapMs:  5 * 60 * 1000, queenMaxTurns: 10 }, // 5 min gap, 10 turns
} as const
export type ClaudePlan = keyof typeof QUEEN_DEFAULTS_BY_PLAN

export const DEFAULT_ROOM_CONFIG = {
  threshold: 'majority' as const,
  timeoutMinutes: 60,
  keeperWeight: 'dynamic' as const,
  tieBreaker: 'queen' as const,
  autoApprove: ['low_impact'],
  minCycleGapMs: 1_000
}
