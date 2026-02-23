import { useState, useEffect, useRef, useCallback } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { LiveConsoleSection } from './LiveConsoleSection'
import { api } from '../lib/client'
import {
  ROOM_BALANCE_EVENT_TYPES,
  ROOM_NETWORK_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import type { Task, TaskRun, RoomActivityEntry, Worker, Wallet, RevenueSummary, OnChainBalance } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { CopyAddressButton } from './CopyAddressButton'

interface StatusData {
  entityCount: number
  tasks: Task[]
  latestRun: TaskRun | null
  runningRuns: TaskRun[]
  workerCount: number
  watchCount: number
}


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const cardClass =
  'w-full text-left p-3 bg-surface-secondary rounded-lg shadow-sm hover:bg-surface-hover transition-colors cursor-pointer'

const EVENT_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-interactive-bg text-interactive',
  milestone: 'bg-status-warning-bg text-status-warning',
  financial: 'bg-status-success-bg text-status-success',
  deployment: 'bg-status-info-bg text-status-info',
  worker: 'bg-brand-100 text-brand-700',
  error: 'bg-status-error-bg text-status-error',
  system: 'bg-surface-tertiary text-text-muted',
  self_mod: 'bg-interactive-bg text-interactive',
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  decision: 'Decisions',
  milestone: 'Milestones',
  financial: 'Financial',
  deployment: 'Deployment',
  worker: 'Workers',
  error: 'Errors',
  system: 'System',
  self_mod: 'Self-Mod',
}

interface StatusPanelProps {
  onNavigate?: (tab: string) => void
  advancedMode: boolean
  roomId?: number | null
}

export function StatusPanel({ onNavigate, advancedMode, roomId }: StatusPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600

  const fetchStatus = useCallback(async (): Promise<StatusData> => {
    const [stats, tasks, runs, workers, watches, runningRuns] = await Promise.all([
      api.memory.getStats(),
      api.tasks.list(roomId ?? undefined),
      api.runs.list(1),
      api.workers.list(),
      api.watches.list(),
      api.runs.list(20, { status: 'running' }),
    ])
    return {
      entityCount: stats.entityCount,
      tasks,
      latestRun: runs[0] ?? null,
      runningRuns,
      workerCount: workers.length,
      watchCount: watches.length
    }
  }, [roomId])

  const { data, error, isLoading, refresh: refreshStatus } = usePolling(fetchStatus, 60000)
  const refreshStatusTimeoutRef = useRef<number | null>(null)

  // Refresh immediately when room changes
  useEffect(() => { refreshStatus() }, [roomId, refreshStatus])
  const taskEvent = useWebSocket('tasks')
  const runsEvent = useWebSocket('runs')
  const workersEvent = useWebSocket('workers')
  const memoryEvent = useWebSocket('memory')
  const watchesEvent = useWebSocket('watches')

  useEffect(() => {
    if (!taskEvent && !runsEvent && !workersEvent && !memoryEvent && !watchesEvent) return
    if (refreshStatusTimeoutRef.current) return
    refreshStatusTimeoutRef.current = window.setTimeout(() => {
      refreshStatusTimeoutRef.current = null
      void refreshStatus()
    }, 250)
  }, [memoryEvent, refreshStatus, runsEvent, taskEvent, watchesEvent, workersEvent])

  useEffect(() => () => {
    if (refreshStatusTimeoutRef.current) {
      window.clearTimeout(refreshStatusTimeoutRef.current)
      refreshStatusTimeoutRef.current = null
    }
  }, [])

  // Queen status
  const { data: queenStatus, refresh: refreshQueenStatus } = usePolling<{
    workerId: number
    agentState: string
    running: boolean
    name: string
  } | null>(
    () => roomId ? api.rooms.queenStatus(roomId).catch(() => null) : Promise.resolve(null),
    5000
  )
  const queenRunning = queenStatus?.running === true
  const queenActive = queenRunning && queenStatus?.agentState !== 'idle'

  // Room activity — poll faster when queen is actively running
  const { data: activity, refresh: refreshActivity } = usePolling<RoomActivityEntry[]>(
    () => roomId ? api.rooms.getActivity(roomId, 30) : Promise.resolve([]),
    queenActive ? 5000 : 30000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 60000)
  useEffect(() => { refreshActivity() }, [roomId, refreshActivity])

  // Wallet info
  const { data: wallet, refresh: refreshWallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )
  const { data: revenueSummary, refresh: refreshRevenueSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )
  const { data: onChainBalance, refresh: refreshOnChainBalance } = usePolling<OnChainBalance | null>(
    () => roomId && wallet ? api.wallet.balance(roomId).catch(() => null) : Promise.resolve(null),
    120000
  )
  useEffect(() => {
    if (wallet) refreshOnChainBalance()
  }, [wallet, refreshOnChainBalance])

  const { data: networkCount, refresh: refreshNetworkCount } = usePolling<number>(
    () => roomId
      ? api.rooms.network(roomId).then(r => r.length).catch(() => 0)
      : Promise.resolve(0),
    120000
  )

  const { data: tokenUsage, refresh: refreshTokenUsage } = usePolling<{
    total: { inputTokens: number; outputTokens: number; cycles: number }
    today: { inputTokens: number; outputTokens: number; cycles: number }
  } | null>(
    () => roomId ? api.rooms.usage(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      void refreshActivity()
      void refreshQueenStatus()
      void refreshTokenUsage()
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void refreshWallet()
        void refreshRevenueSummary()
        void refreshOnChainBalance()
      }
      if (ROOM_NETWORK_EVENT_TYPES.has(event.type)) {
        void refreshNetworkCount()
      }
    })
  }, [
    refreshActivity,
    refreshNetworkCount,
    refreshOnChainBalance,
    refreshQueenStatus,
    refreshRevenueSummary,
    refreshTokenUsage,
    refreshWallet,
    roomId,
  ])

  const [viewMode, setViewMode] = useState<'activity' | 'console'>('activity')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [expandedActivityId, setExpandedActivityId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  if (isLoading && !data) {
    return <div ref={containerRef} className="p-4 flex-1 flex items-center justify-center text-base text-text-muted">Loading...</div>
  }
  if (!data) {
    return (
      <div ref={containerRef} className="p-4 text-sm text-status-error">
        {error ?? 'Failed to load status.'}
      </div>
    )
  }

  const activeTasks = data.tasks.filter((t) => t.status === 'active')
  const pausedTasks = data.tasks.filter((t) => t.status === 'paused')
  const completedTasks = data.tasks.filter((t) => t.status === 'completed')

  const memoryCard = advancedMode ? (
    <button key="memory" className={cardClass} onClick={() => onNavigate?.('memory')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">Memory</span>
        <span className="text-sm text-text-muted">{data.entityCount} entities</span>
      </div>
    </button>
  ) : null

  const workersCard = (
    <button key="workers" className={cardClass} onClick={() => onNavigate?.('workers')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">Workers</span>
        <span className="text-sm text-text-muted">{data.workerCount} configured</span>
      </div>
    </button>
  )

  const tasksCard = (
    <button key="tasks" className={cardClass} onClick={() => onNavigate?.('tasks')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">Tasks</span>
        <span className="text-sm text-text-muted">{data.tasks.length} total</span>
      </div>
      <div className="flex gap-3 text-sm text-text-muted">
        <span className="text-status-success">{activeTasks.length} active</span>
        {pausedTasks.length > 0 && <span className="text-status-warning">{pausedTasks.length} paused</span>}
        {completedTasks.length > 0 && <span className="text-interactive">{completedTasks.length} completed</span>}
      </div>
    </button>
  )

  const watchesCard = advancedMode ? (
    <button key="watches" className={cardClass} onClick={() => onNavigate?.('watches')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">Watches</span>
        <span className="text-sm text-text-muted">{data.watchCount} active</span>
      </div>
    </button>
  ) : null

  const lastRunCard = (
    <button key="lastrun" className={cardClass} onClick={() => onNavigate?.('results')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">Last Run</span>
      </div>
      {data.latestRun ? (
        <div className="text-sm text-text-muted">
          <span className={data.latestRun.status === 'completed' ? 'text-status-success' : data.latestRun.status === 'running' ? 'text-interactive' : 'text-status-error'}>
            {data.latestRun.status}
          </span>
          {' — '}
          {formatRelativeTime(data.latestRun.startedAt)}
          {data.latestRun.durationMs != null && (
            <span className="text-text-muted"> ({(data.latestRun.durationMs / 1000).toFixed(1)}s)</span>
          )}
        </div>
      ) : (
        <span className="text-sm text-text-muted">No runs yet</span>
      )}
    </button>
  )

  const walletCard = wallet ? (
    <button key="wallet" className={cardClass} onClick={() => onNavigate?.('transactions')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">Wallet</span>
        <span className="text-sm text-text-muted">EVM</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="font-mono text-xs text-text-muted truncate">{wallet.address}</div>
        <CopyAddressButton address={wallet.address} />
      </div>
      {onChainBalance && onChainBalance.totalBalance > 0 && (
        <div className="text-sm mt-1">
          <span className="text-interactive font-medium">${onChainBalance.totalBalance.toFixed(2)}</span>
          <span className="text-text-muted"> on-chain</span>
        </div>
      )}
      {revenueSummary && (
        <div className="flex gap-3 text-sm mt-1">
          <span className="text-status-success">+${revenueSummary.totalIncome.toFixed(2)}</span>
          <span className="text-status-error">-${revenueSummary.totalExpenses.toFixed(2)}</span>
          <span className={revenueSummary.netProfit >= 0 ? 'text-interactive' : 'text-status-warning'}>
            net ${revenueSummary.netProfit.toFixed(2)}
          </span>
        </div>
      )}
    </button>
  ) : null

  const networkCard = (networkCount ?? 0) > 0 ? (
    <button key="network" className={cardClass} onClick={() => onNavigate?.('swarm')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">Network</span>
        <span className="text-sm text-text-muted">{networkCount} referred</span>
      </div>
    </button>
  ) : null

  const AGENT_STATE_LABELS: Record<string, { label: string; color: string }> = {
    thinking: { label: 'Thinking', color: 'text-interactive' },
    acting: { label: 'Acting', color: 'text-status-warning' },
    idle: { label: 'Idle', color: 'text-text-muted' },
    rate_limited: { label: 'Rate limited', color: 'text-status-error' },
  }

  const queenCard = roomId && queenStatus ? (
    <button key="queen" className={cardClass} onClick={() => onNavigate?.('settings')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">Queen</span>
        <span className={`text-sm ${queenRunning ? 'text-status-success' : 'text-text-muted'}`}>
          {queenRunning ? 'Running' : 'Stopped'}
        </span>
      </div>
      {queenRunning && (
        <div className="text-sm">
          <span className={AGENT_STATE_LABELS[queenStatus.agentState]?.color ?? 'text-text-muted'}>
            {AGENT_STATE_LABELS[queenStatus.agentState]?.label ?? queenStatus.agentState}
          </span>
        </div>
      )}
    </button>
  ) : null

  const runningSection =
    data.runningRuns.length > 0 ? (
      <div className="p-3 bg-interactive-bg rounded-lg shadow-sm">
        <div className="text-sm font-medium text-interactive mb-1">Running ({data.runningRuns.length})</div>
        {data.runningRuns.map((run) => (
          <div key={run.id} className="mb-1 last:mb-0">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-interactive-bg rounded-full overflow-hidden">
                {run.progress != null ? (
                  <div className="h-full bg-interactive rounded-full transition-all duration-500" style={{ width: `${Math.round(run.progress * 100)}%` }} />
                ) : (
                  <div className="h-full bg-interactive rounded-full animate-pulse w-full" />
                )}
              </div>
            </div>
            {run.progressMessage && <div className="text-sm text-interactive mt-0.5 truncate">{run.progressMessage}</div>}
          </div>
        ))}
      </div>
    ) : null

  const consoleSection = <LiveConsoleSection isActive={viewMode === 'console' && !!roomId} tasks={data.tasks} roomId={roomId} workers={workers ?? []} queenWorkerId={queenStatus?.workerId ?? null} />

  const errorAlert = error ? (
    <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg rounded-lg">Temporary data refresh issue: {error}</div>
  ) : null

  // Activity timeline
  const allActivity = [...(activity ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  const presentTypes = [...new Set(allActivity.map(a => a.eventType))]
  const isFiltering = activeFilters.size > 0
  const filteredActivity = !isFiltering
    ? allActivity
    : allActivity.filter(a => activeFilters.has(a.eventType))

  function toggleFilter(eventType: string): void {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(eventType)) {
        next.delete(eventType)
      } else {
        next.add(eventType)
      }
      return next
    })
  }

  function clearFilters(): void {
    setActiveFilters(new Set())
  }

  const activitySection = roomId ? (
    <div className="bg-surface-secondary rounded-lg p-4 shadow-sm flex-1 flex flex-col min-h-0 overflow-x-hidden">
      {/* Filter bar */}
      {presentTypes.length > 1 && (
        <div className="mb-3 shrink-0 border-b border-border-primary pb-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Filters</div>
            {isFiltering && (
              <button
                onClick={clearFilters}
                className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={clearFilters}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                !isFiltering
                  ? 'bg-interactive-bg text-interactive border-interactive/30'
                  : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              All
            </button>
          {presentTypes.map(type => (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                activeFilters.has(type)
                  ? `${EVENT_TYPE_COLORS[type] ?? 'bg-surface-tertiary text-text-secondary'} border-transparent`
                  : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              {EVENT_TYPE_LABELS[type] ?? type}
            </button>
          ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {filteredActivity.length === 0 ? (
        <div className="text-sm text-text-muted">
          {allActivity.length === 0 ? 'No room activity yet.' : 'No matching events.'}
        </div>
      ) : (
        <div className="space-y-2 flex-1 overflow-y-auto overflow-x-hidden">
          {filteredActivity.map(entry => (
            <div
              key={entry.id}
              className="cursor-pointer hover:bg-surface-primary rounded-lg px-2.5 py-1.5 transition-colors"
              onClick={() => setExpandedActivityId(expandedActivityId === entry.id ? null : entry.id)}
            >
              <div className="flex items-center gap-1.5">
                <span className={`px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 ${EVENT_TYPE_COLORS[entry.eventType] ?? 'bg-surface-tertiary text-text-muted'}`}>
                  {entry.eventType}
                </span>
                <span className="text-sm text-text-secondary truncate flex-1">{entry.summary}</span>
                <span className="text-xs text-text-muted shrink-0">{formatRelativeTime(entry.createdAt)}</span>
              </div>
              {expandedActivityId === entry.id && (
                <div className="mt-1 ml-1 space-y-0.5">
                  {entry.actorId && (
                    <div className="text-xs text-text-muted">
                      by {workerMap.get(entry.actorId)?.name ?? `Worker #${entry.actorId}`}
                    </div>
                  )}
                  {entry.details && (
                    <div className="text-xs text-text-muted whitespace-pre-wrap break-words">{entry.details}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null

  const showToggle = !!roomId
  const activeView = showToggle ? viewMode : 'console'

  const toggleBar = showToggle ? (
    <div className="inline-flex gap-1 bg-interactive-bg rounded-lg p-0.5 self-start shrink-0">
      <button
        onClick={() => setViewMode('activity')}
        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          activeView === 'activity'
            ? 'bg-interactive text-text-invert shadow-sm'
            : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
        }`}
      >
        Timeline
      </button>
      <button
        onClick={() => setViewMode('console')}
        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          activeView === 'console'
            ? 'bg-interactive text-text-invert shadow-sm'
            : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
        }`}
      >
        Console
      </button>
    </div>
  ) : null

  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <h2 className="text-base font-semibold text-text-primary">Status</h2>
    </div>
  )

  function renderMainSection(): React.JSX.Element {
    const content = activeView === 'activity'
      ? (activitySection ?? consoleSection)
      : consoleSection

    if (!showToggle || !toggleBar) return content

    return (
      <div className="space-y-2">
        {toggleBar}
        {content}
      </div>
    )
  }

  if (!wide) {
    return (
      <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
        {header}
        {errorAlert}
        {queenCard}
        {memoryCard}
        {workersCard}
        {tasksCard}
        {watchesCard}
        {runningSection}
        {lastRunCard}
        {walletCard}
        {networkCard}
        {usageCard}
        {renderMainSection()}
      </div>
    )
  }

  const usage = tokenUsage ?? { total: { inputTokens: 0, outputTokens: 0, cycles: 0 }, today: { inputTokens: 0, outputTokens: 0, cycles: 0 }, isApiModel: false }
  const hasTokenData = usage.total.inputTokens > 0 || usage.total.outputTokens > 0
  const usageCard = (
    <div key="usage" className={cardClass}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">Token Usage</span>
        <span className="text-sm text-text-muted">{usage.isApiModel ? 'API' : 'Subscription'}</span>
      </div>
      {!usage.isApiModel && !hasTokenData ? (
        <div className="text-sm text-text-muted">Tracked by provider</div>
      ) : (
        <>
          {usage.today.inputTokens > 0 || usage.today.outputTokens > 0 ? (
            <div className="text-sm text-text-muted mb-0.5">
              <span className="text-text-secondary">Today:</span>{' '}
              <span className="text-interactive">{formatTokens(usage.today.inputTokens)}</span> in{' / '}
              <span className="text-interactive">{formatTokens(usage.today.outputTokens)}</span> out
            </div>
          ) : null}
          <div className="text-sm text-text-muted">
            {formatTokens(usage.total.inputTokens)} in{' / '}
            {formatTokens(usage.total.outputTokens)} out
            <span className="text-text-muted ml-1">({usage.total.cycles} cycles)</span>
          </div>
        </>
      )}
    </div>
  )

  const cards = [queenCard, memoryCard, workersCard, tasksCard, watchesCard, lastRunCard, walletCard, networkCard, usageCard].filter(Boolean)

  return (
    <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
      {header}
      {errorAlert}
      <div className="grid grid-cols-3 gap-3">{cards}</div>
      {runningSection}
      {renderMainSection()}
    </div>
  )
}
