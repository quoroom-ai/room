import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { LiveConsoleSection } from './LiveConsoleSection'
import { api } from '../lib/client'
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

async function fetchStatus(): Promise<StatusData> {
  const [stats, tasks, runs, workers, watches] = await Promise.all([
    api.memory.getStats(),
    api.tasks.list(),
    api.runs.list(1),
    api.workers.list(),
    api.watches.list()
  ])

  const runningRuns = await api.runs.list(20, { status: 'running' })

  return {
    entityCount: stats.entityCount,
    tasks,
    latestRun: runs[0] ?? null,
    runningRuns,
    workerCount: workers.length,
    watchCount: watches.length
  }
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
}

interface StatusPanelProps {
  onNavigate?: (tab: string) => void
  advancedMode: boolean
  roomId?: number | null
}

export function StatusPanel({ onNavigate, advancedMode, roomId }: StatusPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const { data, error, isLoading } = usePolling(fetchStatus, 10000)

  // Room activity
  const { data: activity, refresh: refreshActivity } = usePolling<RoomActivityEntry[]>(
    () => roomId ? api.rooms.getActivity(roomId, 30) : Promise.resolve([]),
    5000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 30000)
  const wsEvent = useWebSocket(roomId ? `room:${roomId}` : '')
  useEffect(() => { if (wsEvent) refreshActivity() }, [wsEvent, refreshActivity])
  useEffect(() => { refreshActivity() }, [roomId, refreshActivity])

  // Wallet info
  const { data: wallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )
  const { data: revenueSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )
  const { data: onChainBalance } = usePolling<OnChainBalance | null>(
    () => roomId && wallet ? api.wallet.balance(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )

  const [viewMode, setViewMode] = useState<'activity' | 'console'>('activity')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [expandedActivityId, setExpandedActivityId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  if (isLoading && !data) {
    return <div ref={containerRef} className="p-4 text-sm text-text-muted">Loading...</div>
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

  const taskNames: Record<number, string> = {}
  for (const t of data.tasks) taskNames[t.id] = t.name

  const consoleSection = <LiveConsoleSection runningRuns={data.runningRuns} taskNames={taskNames} />

  const errorAlert = error ? (
    <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg rounded-lg">Temporary data refresh issue: {error}</div>
  ) : null

  // Activity timeline
  const allActivity = activity ?? []
  const presentTypes = [...new Set(allActivity.map(a => a.eventType))]
  const filteredActivity = activeFilters.size === 0
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

  const activitySection = roomId ? (
    <div className="bg-surface-secondary rounded-lg p-4 shadow-sm flex-1 flex flex-col min-h-0 overflow-x-hidden">
      {/* Filter chips */}
      {presentTypes.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-2 shrink-0">
          {presentTypes.map(type => (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeFilters.size === 0 || activeFilters.has(type)
                  ? EVENT_TYPE_COLORS[type] ?? 'bg-surface-tertiary text-text-muted'
                  : 'bg-surface-tertiary text-text-muted'
              }`}
            >
              {type}
            </button>
          ))}
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
    <div className="flex gap-2 bg-surface-tertiary rounded-lg p-0.5 self-start shrink-0">
      <button
        onClick={() => setViewMode('activity')}
        className={`px-2.5 py-1 rounded-md text-sm font-medium transition-colors ${
          activeView === 'activity' ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
        }`}
      >
        Timeline
      </button>
      <button
        onClick={() => setViewMode('console')}
        className={`px-2.5 py-1 rounded-md text-sm font-medium transition-colors ${
          activeView === 'console' ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
        }`}
      >
        Console
      </button>
    </div>
  ) : null

  function renderMainSection(): React.JSX.Element {
    if (activeView === 'activity') {
      return activitySection ?? <LiveConsoleSection runningRuns={data.runningRuns} taskNames={taskNames} />
    }
    return consoleSection
  }

  if (!wide) {
    return (
      <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
        {errorAlert}
        {memoryCard}
        {workersCard}
        {tasksCard}
        {watchesCard}
        {runningSection}
        {lastRunCard}
        {walletCard}
        {toggleBar}
        {renderMainSection()}
      </div>
    )
  }

  const cards = [memoryCard, workersCard, tasksCard, watchesCard, lastRunCard, walletCard].filter(Boolean)

  return (
    <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
      {errorAlert}
      <div className="grid grid-cols-2 gap-3">{cards}</div>
      {runningSection}
      {toggleBar}
      {renderMainSection()}
    </div>
  )
}
