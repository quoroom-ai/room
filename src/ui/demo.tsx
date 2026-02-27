import React from 'react'
import ReactDOM from 'react-dom/client'
import { SwarmPanel } from './components/SwarmPanel'
import type { Room, Worker, Station, RevenueSummary, OnChainBalance } from '@shared/types'
import './styles/globals.css'

// Auto-enable ?demo flag so useSwarmEvents fires simulated event bubbles
if (!new URLSearchParams(window.location.search).has('demo')) {
  const url = new URL(window.location.href)
  url.searchParams.set('demo', '')
  window.history.replaceState({}, '', url.toString())
}

// ─── Demo data ────────────────────────────────────────────

const now = new Date().toISOString()

const cfg = {
  threshold: 'majority' as const, timeoutMinutes: 30,
  tieBreaker: 'queen' as const, autoApprove: [] as string[], minCycleGapMs: 5000, minVoters: 2,
  sealedBallot: false, voterHealth: true, voterHealthThreshold: 0.5,
}

function r(id: number, name: string, goal: string, model: string, status: 'active' | 'paused' = 'active'): Room {
  return {
    id, name, queenWorkerId: id * 100, goal, status, visibility: 'public',
    autonomyMode: 'semi', maxConcurrentTasks: 3, workerModel: model,
    queenCycleGapMs: 10000, queenMaxTurns: 20, queenQuietFrom: null, queenQuietUntil: null,
    config: cfg, queenNickname: null, chatSessionId: null,
    referredByCode: null, allowedTools: null, webhookToken: null,
    createdAt: now, updatedAt: now,
  }
}

function w(id: number, roomId: number, name: string, state: string): Worker {
  return {
    id, name, role: null, systemPrompt: '', description: null, model: null,
    isDefault: false, taskCount: 5 + id % 15,
    cycleGapMs: null, maxTurns: null, roomId, agentState: state as Worker['agentState'],
    votesCast: 10 + id % 40, votesMissed: id % 4,
    createdAt: now, updatedAt: now,
  }
}

function s(id: number, roomId: number, name: string, status: string, tier: string): Station {
  return {
    id, roomId, name, provider: 'flyio' as Station['provider'],
    externalId: null, tier: tier as Station['tier'], region: 'iad',
    status: status as Station['status'], monthlyCost: tier === 'micro' ? 5 : tier === 'small' ? 15 : 35,
    config: null, createdAt: now, updatedAt: now,
  }
}

const ROOMS: Room[] = [
  r(901, 'hustle', 'Make money. Find opportunities, execute, and grow revenue autonomously...', 'claude-sonnet-4-20250514'),
  r(902, 'trading', 'Trade crypto markets: analyze trends, execute trades, manage risk...', 'claude-opus-4-20250514'),
  r(903, 'freelance', 'Find freelance dev jobs on Upwork, write proposals, land contracts, deliver code...', 'claude-sonnet-4-20250514'),
  r(904, 'saas', 'Build and sell micro-SaaS products. Find niches, ship MVPs, acquire users...', 'claude-haiku-4-20250414'),
  r(905, 'bounties', 'Monitor bounty platforms, pick up bug bounties and coding challenges for pay...', 'claude-sonnet-4-20250514', 'paused'),
  r(906, 'content', 'Run a content agency: find clients, write copy, invoice, collect payments...', 'claude-sonnet-4-20250514'),
]

const WORKERS: Worker[] = [
  w(9001, 901, 'Ada', 'thinking'), w(9002, 901, 'John', 'acting'),
  w(9003, 901, 'Eve', 'idle'), w(9004, 901, 'Max', 'voting'),
  w(9005, 902, 'Atlas', 'acting'), w(9006, 902, 'Bolt', 'thinking'),
  w(9007, 903, 'Sage', 'thinking'), w(9008, 903, 'Nova', 'idle'), w(9009, 903, 'Aria', 'acting'),
  w(9010, 904, 'Kai', 'acting'), w(9011, 904, 'Luna', 'thinking'),
  w(9012, 904, 'Orion', 'rate_limited'), w(9013, 904, 'Pixel', 'idle'), w(9014, 904, 'Quinn', 'idle'),
  w(9015, 905, 'Linter', 'idle'), w(9016, 905, 'Critic', 'thinking'), w(9017, 905, 'Fixer', 'idle'),
  w(9018, 906, 'Deploy', 'acting'), w(9019, 906, 'Monitor', 'thinking'),
  w(9020, 906, 'Incident', 'idle'), w(9021, 906, 'Scale', 'blocked'),
]

const STATIONS: Record<number, Station[]> = {
  901: [s(8001, 901, 'web-server', 'active', 'small'), s(8002, 901, 'scraper', 'active', 'micro')],
  902: [s(8003, 902, 'monitor', 'active', 'small'), s(8004, 902, 'executor', 'active', 'medium')],
  903: [s(8005, 903, 'workbench', 'active', 'small')],
  904: [s(8006, 904, 'publisher', 'active', 'micro')],
  905: [],
  906: [s(8007, 906, 'ci-runner', 'active', 'medium'), s(8008, 906, 'staging', 'pending', 'small')],
}

const REVENUE: Record<number, RevenueSummary> = {
  901: { totalIncome: 2847.50, totalExpenses: 312.40, netProfit: 2535.10, stationCosts: 20, transactionCount: 48 },
  902: { totalIncome: 15420, totalExpenses: 1240, netProfit: 14180, stationCosts: 50, transactionCount: 156 },
  903: { totalIncome: 1230, totalExpenses: 180, netProfit: 1050, stationCosts: 15, transactionCount: 22 },
  904: { totalIncome: 580.25, totalExpenses: 95.50, netProfit: 484.75, stationCosts: 5, transactionCount: 14 },
  905: { totalIncome: 340, totalExpenses: 42, netProfit: 298, stationCosts: 0, transactionCount: 9 },
  906: { totalIncome: 920, totalExpenses: 210, netProfit: 710, stationCosts: 50, transactionCount: 31 },
}

const BALANCES: Record<number, OnChainBalance> = {
  901: { totalBalance: 1842.30, byChain: { ethereum: { usdc: 1842.30, usdt: 0, total: 1842.30 } }, address: '0xdemo1', fetchedAt: now },
  902: { totalBalance: 8450, byChain: { ethereum: { usdc: 8450, usdt: 0, total: 8450 } }, address: '0xdemo2', fetchedAt: now },
}

const QUEEN_RUNNING: Record<number, boolean> = {
  901: true, 902: true, 903: true, 904: true, 905: false, 906: true,
}

// ─── Render ───────────────────────────────────────────────

function Demo(): React.JSX.Element {
  return (
    <div className="h-screen bg-surface-primary flex flex-col">
      <SwarmPanel
        rooms={ROOMS}
        queenRunning={QUEEN_RUNNING}
        onNavigateToRoom={() => {}}
        demoData={{ workers: WORKERS, stations: STATIONS, revenue: REVENUE, balances: BALANCES }}
      />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>
)
