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
  MANUAL: 'manual',
  WEBHOOK: 'webhook'
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

// ─── Multi-chain token configs ──────────────────────────────

export interface TokenConfig {
  address: string
  decimals: number
}

export interface ChainTokenConfig {
  chainId: number
  name: string
  rpcUrl: string
  tokens: Record<string, TokenConfig>
}

export const CHAIN_CONFIGS: Record<string, ChainTokenConfig> = {
  base: {
    chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org',
    tokens: {
      usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      usdt: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    }
  },
  ethereum: {
    chainId: 1, name: 'Ethereum', rpcUrl: 'https://eth.llamarpc.com',
    tokens: {
      usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      usdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    }
  },
  arbitrum: {
    chainId: 42161, name: 'Arbitrum', rpcUrl: 'https://arb1.arbitrum.io/rpc',
    tokens: {
      usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      usdt: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    }
  },
  optimism: {
    chainId: 10, name: 'Optimism', rpcUrl: 'https://mainnet.optimism.io',
    tokens: {
      usdc: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d53F5C94', decimals: 6 },
      usdt: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    }
  },
  polygon: {
    chainId: 137, name: 'Polygon', rpcUrl: 'https://polygon-rpc.com',
    tokens: {
      usdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      usdt: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    }
  },
  'base-sepolia': {
    chainId: 84532, name: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org',
    tokens: {
      usdc: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
    }
  },
}

export const SUPPORTED_CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon'] as const
export const SUPPORTED_TOKENS = ['usdc', 'usdt'] as const
export type SupportedChain = typeof SUPPORTED_CHAINS[number]
export type SupportedToken = typeof SUPPORTED_TOKENS[number]

export const ERC8004_IDENTITY_REGISTRY = {
  base: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const,
  'base-sepolia': '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const
}

export const ERC8004_REPUTATION_REGISTRY = {
  base: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const,
  'base-sepolia': '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const
}

export const QUEEN_DEFAULTS_BY_PLAN = {
  none: { queenCycleGapMs: 10 * 60 * 1000, queenMaxTurns: 30 }, // 10 min gap, 30 turns
  pro:  { queenCycleGapMs:  5 * 60 * 1000, queenMaxTurns: 30 }, // 5 min gap, 30 turns
  max:  { queenCycleGapMs:      30 * 1000, queenMaxTurns: 30 }, // 30s gap, 30 turns
  api:  { queenCycleGapMs:  2 * 60 * 1000, queenMaxTurns: 30 }, // 2 min gap, 30 turns
} as const
export type ClaudePlan = keyof typeof QUEEN_DEFAULTS_BY_PLAN

export const CHATGPT_DEFAULTS_BY_PLAN = {
  none: { queenCycleGapMs: 10 * 60 * 1000, queenMaxTurns: 30 }, // 10 min gap, 30 turns
  plus: { queenCycleGapMs:  5 * 60 * 1000, queenMaxTurns: 30 }, // 5 min gap, 30 turns
  pro:  { queenCycleGapMs:  2 * 60 * 1000, queenMaxTurns: 30 }, // 2 min gap, 30 turns
  api:  { queenCycleGapMs:  2 * 60 * 1000, queenMaxTurns: 30 }, // 2 min gap, 30 turns
} as const
export type ChatGptPlan = keyof typeof CHATGPT_DEFAULTS_BY_PLAN

export interface WorkerRolePreset {
  cycleGapMs?: number
  maxTurns?: number
  systemPromptPrefix?: string
}

export const WORKER_ROLE_PRESETS: Record<string, WorkerRolePreset> = {
  guardian: {
    cycleGapMs: 30_000,
    maxTurns: 15,
    systemPromptPrefix: 'Monitor and observe. Do not spawn workers or make purchases. Focus on detecting anomalies in tasks, stations, and worker activity.'
  },
  analyst: {
    cycleGapMs: 120_000,
    maxTurns: 30,
    systemPromptPrefix: 'Perform deep analysis. Work to completion on a task, then pause. Prefer depth over frequency.'
  },
  writer: {
    cycleGapMs: 120_000,
    maxTurns: 30,
    systemPromptPrefix: 'Produce high-quality written output. Minimize interruptions between drafting sessions.'
  },
}

export const DEFAULT_ROOM_CONFIG = {
  threshold: 'majority' as const,
  timeoutMinutes: 60,
  keeperWeight: 'dynamic' as const,
  tieBreaker: 'queen' as const,
  autoApprove: ['low_impact'],
  minCycleGapMs: 1_000,
  minVoters: 0,
  sealedBallot: false,
  voterHealth: false,
  voterHealthThreshold: 0.5
}
