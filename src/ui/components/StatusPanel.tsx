import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { LiveConsoleSection } from './LiveConsoleSection'
import { QueenChat } from './QueenChat'
import { api } from '../lib/client'
import type { Task, TaskRun, RoomActivityEntry, Worker, Wallet, RevenueSummary } from '@shared/types'
import { formatRelativeTime } from '../utils/time'

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

  const runningRuns = (await api.runs.list(20)).filter(r => r.status === 'running')

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
  'w-full text-left p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer'

const EVENT_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-blue-100 text-blue-700',
  milestone: 'bg-amber-100 text-amber-700',
  financial: 'bg-green-100 text-green-700',
  deployment: 'bg-purple-100 text-purple-700',
  worker: 'bg-orange-100 text-orange-700',
  error: 'bg-red-100 text-red-700',
  system: 'bg-gray-100 text-gray-500',
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

  const [viewMode, setViewMode] = useState<'activity' | 'console' | 'chat'>('activity')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [expandedActivityId, setExpandedActivityId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  if (isLoading && !data) {
    return <div ref={containerRef} className="p-4 text-xs text-gray-400">Loading...</div>
  }
  if (!data) {
    return (
      <div ref={containerRef} className="p-4 text-xs text-red-500">
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
        <span className="text-xs font-medium text-gray-600">Memory</span>
        <span className="text-xs text-gray-500">{data.entityCount} entities</span>
      </div>
    </button>
  ) : null

  const workersCard = (
    <button key="workers" className={cardClass} onClick={() => onNavigate?.('workers')}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600">Workers</span>
        <span className="text-xs text-gray-500">{data.workerCount} configured</span>
      </div>
    </button>
  )

  const tasksCard = (
    <button key="tasks" className={cardClass} onClick={() => onNavigate?.('tasks')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-600">Tasks</span>
        <span className="text-xs text-gray-500">{data.tasks.length} total</span>
      </div>
      <div className="flex gap-3 text-xs text-gray-500">
        <span className="text-green-600">{activeTasks.length} active</span>
        {pausedTasks.length > 0 && <span className="text-yellow-600">{pausedTasks.length} paused</span>}
        {completedTasks.length > 0 && <span className="text-blue-600">{completedTasks.length} completed</span>}
      </div>
    </button>
  )

  const watchesCard = advancedMode ? (
    <button key="watches" className={cardClass} onClick={() => onNavigate?.('watches')}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600">Watches</span>
        <span className="text-xs text-gray-500">{data.watchCount} active</span>
      </div>
    </button>
  ) : null

  const lastRunCard = (
    <button key="lastrun" className={cardClass} onClick={() => onNavigate?.('results')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-600">Last Run</span>
      </div>
      {data.latestRun ? (
        <div className="text-xs text-gray-500">
          <span className={data.latestRun.status === 'completed' ? 'text-green-600' : data.latestRun.status === 'running' ? 'text-blue-600' : 'text-red-500'}>
            {data.latestRun.status}
          </span>
          {' — '}
          {formatRelativeTime(data.latestRun.startedAt)}
          {data.latestRun.durationMs != null && (
            <span className="text-gray-400"> ({(data.latestRun.durationMs / 1000).toFixed(1)}s)</span>
          )}
        </div>
      ) : (
        <span className="text-xs text-gray-400">No runs yet</span>
      )}
    </button>
  )

  const walletCard = wallet ? (
    <button key="wallet" className={cardClass} onClick={() => onNavigate?.('transactions')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-600">Wallet</span>
        <span className="text-xs text-gray-400">{wallet.chain}</span>
      </div>
      <div className="font-mono text-[10px] text-gray-500 truncate">{wallet.address}</div>
      {revenueSummary && (
        <div className="flex gap-3 text-xs mt-1">
          <span className="text-green-600">+${revenueSummary.totalIncome.toFixed(2)}</span>
          <span className="text-red-500">-${revenueSummary.totalExpenses.toFixed(2)}</span>
          <span className={revenueSummary.netProfit >= 0 ? 'text-blue-600' : 'text-amber-600'}>
            net ${revenueSummary.netProfit.toFixed(2)}
          </span>
        </div>
      )}
    </button>
  ) : null

  const runningSection =
    data.runningRuns.length > 0 ? (
      <div className="p-3 bg-blue-50 rounded-lg">
        <div className="text-xs font-medium text-blue-700 mb-1">Running ({data.runningRuns.length})</div>
        {data.runningRuns.map((run) => (
          <div key={run.id} className="mb-1 last:mb-0">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-blue-200 rounded-full overflow-hidden">
                {run.progress != null ? (
                  <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(run.progress * 100)}%` }} />
                ) : (
                  <div className="h-full bg-blue-400 rounded-full animate-pulse w-full" />
                )}
              </div>
            </div>
            {run.progressMessage && <div className="text-xs text-blue-600 mt-0.5 truncate">{run.progressMessage}</div>}
          </div>
        ))}
      </div>
    ) : null

  const taskNames: Record<number, string> = {}
  for (const t of data.tasks) taskNames[t.id] = t.name

  const consoleSection = <LiveConsoleSection runningRuns={data.runningRuns} taskNames={taskNames} />

  const errorAlert = error ? (
    <div className="px-3 py-2 text-xs text-yellow-700 bg-yellow-50 rounded-lg">Temporary data refresh issue: {error}</div>
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
    <div className="bg-gray-50 rounded-lg p-3 flex-1 flex flex-col min-h-0">
      {/* Filter chips */}
      {presentTypes.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2 shrink-0">
          {presentTypes.map(type => (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                activeFilters.size === 0 || activeFilters.has(type)
                  ? EVENT_TYPE_COLORS[type] ?? 'bg-gray-100 text-gray-500'
                  : 'bg-gray-100 text-gray-300'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      {filteredActivity.length === 0 ? (
        <div className="text-xs text-gray-400">
          {allActivity.length === 0 ? 'No room activity yet.' : 'No matching events.'}
        </div>
      ) : (
        <div className="space-y-1 flex-1 overflow-y-auto">
          {filteredActivity.map(entry => (
            <div
              key={entry.id}
              className="cursor-pointer hover:bg-white rounded px-1.5 py-1 -mx-1.5 transition-colors"
              onClick={() => setExpandedActivityId(expandedActivityId === entry.id ? null : entry.id)}
            >
              <div className="flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${EVENT_TYPE_COLORS[entry.eventType] ?? 'bg-gray-100 text-gray-500'}`}>
                  {entry.eventType}
                </span>
                <span className="text-xs text-gray-700 truncate flex-1">{entry.summary}</span>
                <span className="text-[10px] text-gray-400 shrink-0">{formatRelativeTime(entry.createdAt)}</span>
              </div>
              {expandedActivityId === entry.id && (
                <div className="mt-1 ml-1 space-y-0.5">
                  {entry.actorId && (
                    <div className="text-[10px] text-gray-500">
                      by {workerMap.get(entry.actorId)?.name ?? `Worker #${entry.actorId}`}
                    </div>
                  )}
                  {entry.details && (
                    <div className="text-[10px] text-gray-500 whitespace-pre-wrap">{entry.details}</div>
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
    <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 self-start shrink-0">
      <button
        onClick={() => setViewMode('activity')}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          activeView === 'activity' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        Activity
      </button>
      <button
        onClick={() => setViewMode('console')}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          activeView === 'console' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        Console
      </button>
      <button
        onClick={() => setViewMode('chat')}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          activeView === 'chat' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        Chat
      </button>
    </div>
  ) : null

  const chatSection = <QueenChat roomId={roomId ?? null} />

  if (!wide) {
    return (
      <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full">
        {errorAlert}
        {memoryCard}
        {workersCard}
        {tasksCard}
        {watchesCard}
        {runningSection}
        {lastRunCard}
        {walletCard}
        {toggleBar}
        {activeView === 'activity' ? activitySection : activeView === 'console' ? consoleSection : chatSection}
      </div>
    )
  }

  const cards = [memoryCard, workersCard, tasksCard, watchesCard, lastRunCard, walletCard].filter(Boolean)

  return (
    <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full">
      {errorAlert}
      <div className="grid grid-cols-2 gap-3">{cards}</div>
      {runningSection}
      {toggleBar}
      {activeView === 'activity' ? activitySection : activeView === 'console' ? consoleSection : chatSection}
    </div>
  )
}
