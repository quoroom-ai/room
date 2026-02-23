import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import type { Task, TaskRun, Worker, ConsoleLogEntry } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { useState, useEffect, useRef } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { wsClient, type WsMessage } from '../lib/ws'
import { Select } from './Select'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'

// Module-level persistence: survives component unmounts during tab switches
let persistedFilter: StatusFilter = 'all'

function statusBadge(task: Task): React.JSX.Element {
  const colors: Record<string, string> = {
    active: 'bg-status-success-bg text-status-success',
    paused: 'bg-status-warning-bg text-status-warning',
    completed: 'bg-interactive-bg text-interactive',
    error: 'bg-status-error-bg text-status-error'
  }
  const cls = colors[task.status] ?? 'bg-surface-tertiary text-text-secondary'
  return (
    <span className={`px-2.5 py-1.5 rounded-lg text-sm ${cls}`}>
      {task.status}
      {task.errorCount > 0 && ` (${task.errorCount})`}
    </span>
  )
}

const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 2 hours', cron: '0 */2 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every morning (9 AM)', cron: '0 9 * * *' },
  { label: 'Every afternoon (2 PM)', cron: '0 14 * * *' },
  { label: 'Every evening (6 PM)', cron: '0 18 * * *' },
  { label: 'Twice a day (9 AM, 6 PM)', cron: '0 9,18 * * *' },
  { label: 'Three times a day (9 AM, 1 PM, 6 PM)', cron: '0 9,13,18 * * *' },
  { label: 'Weekdays at 9 AM', cron: '0 9 * * 1-5' },
  { label: 'Weekdays at 6 PM', cron: '0 18 * * 1-5' },
  { label: 'Every Monday at 9 AM', cron: '0 9 * * 1' },
  { label: 'Every Friday at 5 PM', cron: '0 17 * * 5' },
  { label: 'Weekends at 10 AM', cron: '0 10 * * 0,6' },
  { label: 'Every day at noon', cron: '0 12 * * *' },
  { label: 'Every night (10 PM)', cron: '0 22 * * *' },
  { label: 'Every night (11 PM)', cron: '0 23 * * *' },
  { label: 'Every day at midnight', cron: '0 0 * * *' },
  { label: 'Every night (2 AM)', cron: '0 2 * * *' },
  { label: 'Weeknights at 10 PM', cron: '0 22 * * 1-5' },
  { label: 'Weeknights at midnight', cron: '0 0 * * 2-6' }
]

const CRON_LABELS: Record<string, string> = Object.fromEntries(
  SCHEDULE_PRESETS.map((p) => [p.cron, p.label])
)

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function describeCron(expr: string): string {
  if (CRON_LABELS[expr]) return CRON_LABELS[expr]

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  if (parts.every((p) => p === '*')) return 'Every minute'

  const [min, hour, , , dow] = parts

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '*') {
    return `Daily at ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '1-5') {
    return `Weekdays at ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow.match(/^\d$/)) {
    const day = DAYS[parseInt(dow, 10)] ?? dow
    return `Every ${day} at ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && (dow === '0,6' || dow === '6,0')) {
    return `Weekends at ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '2-6') {
    const h = parseInt(hour, 10)
    const label = h === 0 ? 'midnight' : formatTime(h, parseInt(min, 10))
    return `Weeknights at ${label}`
  }

  if (min.startsWith('*/') && hour === '*') {
    return `Every ${min.slice(2)} minutes`
  }

  if (min === '0' && hour.startsWith('*/')) {
    const n = hour.slice(2)
    return n === '1' ? 'Every hour' : `Every ${n} hours`
  }

  if (min.match(/^\d+$/) && hour.includes(',') && dow === '*') {
    const m = parseInt(min, 10)
    const times = hour.split(',').map((h) => formatTime(parseInt(h, 10), m)).join(', ')
    return `Daily at ${times}`
  }

  if (min.match(/^\d+$/) && hour.includes(',') && dow === '1-5') {
    const m = parseInt(min, 10)
    const times = hour.split(',').map((h) => formatTime(parseInt(h, 10), m)).join(', ')
    return `Weekdays at ${times}`
  }

  return expr
}

function formatTime(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function triggerLabel(task: Task): string {
  if (task.triggerType === 'cron' && task.cronExpression) return describeCron(task.cronExpression)
  if (task.triggerType === 'once' && task.scheduledAt) {
    return `Once: ${new Date(task.scheduledAt).toLocaleString()}`
  }
  if (task.triggerType === 'manual') return 'On-demand'
  return task.triggerType
}

function sourceLabel(task: Task): string | null {
  if (!task.triggerConfig) return null
  try {
    const config = JSON.parse(task.triggerConfig)
    return config.source ?? null
  } catch {
    return null
  }
}

function ProgressBar({ run }: { run: TaskRun }): React.JSX.Element {
  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
          {run.progress != null ? (
            <div
              className="h-full bg-interactive rounded-full transition-all duration-500"
              style={{ width: `${Math.round(run.progress * 100)}%` }}
            />
          ) : (
            <div className="h-full bg-interactive rounded-full animate-pulse w-full" />
          )}
        </div>
      </div>
      {run.progressMessage && (
        <div className="text-sm text-interactive mt-0.5 truncate">
          {run.progressMessage}
        </div>
      )}
    </div>
  )
}

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-console-text',
  result: 'text-blue-400',
  error: 'text-red-400'
}

function ConsoleView({ runId }: { runId: number }): React.JSX.Element {
  const [entries, setEntries] = useState<ConsoleLogEntry[]>([])
  const lastSeqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    lastSeqRef.current = 0
    setEntries([])

    const poll = async (): Promise<void> => {
      if (!mounted) return
      try {
        const newEntries = await api.runs.getLogs(runId, lastSeqRef.current, 50)
        if (newEntries.length > 0 && mounted) {
          lastSeqRef.current = newEntries[newEntries.length - 1].seq
          setEntries(prev => {
            const seen = new Set(prev.map((entry) => entry.seq))
            const merged = [...prev]
            for (const entry of newEntries) {
              if (seen.has(entry.seq)) continue
              seen.add(entry.seq)
              merged.push(entry)
            }
            return merged.slice(-150)
          })
        }
      } catch {
        // non-fatal
      }
    }
    void poll()
    const unsubscribe = wsClient.subscribe(`run:${runId}`, (event: WsMessage) => {
      if (event.type !== 'run:log') return
      const payload = event.data as Partial<ConsoleLogEntry> & { seq?: number; entryType?: string; content?: string }
      if (typeof payload.seq !== 'number' || typeof payload.entryType !== 'string' || typeof payload.content !== 'string') return
      const entry: ConsoleLogEntry = { seq: payload.seq, entryType: payload.entryType, content: payload.content }
      lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
      setEntries(prev => {
        if (prev.some((candidate) => candidate.seq === entry.seq)) return prev
        return [...prev.slice(-149), entry]
      })
    })
    const timer = setInterval(() => { void poll() }, 10000)
    return () => { mounted = false; unsubscribe(); clearInterval(timer) }
  }, [runId])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [entries])

  return (
    <div
      ref={scrollRef}
      className="max-h-48 overflow-y-auto bg-console-bg rounded-lg p-3 mt-1 font-mono text-sm leading-relaxed"
    >
      {entries.map((e) => (
        <div key={e.seq} className={CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-console-text'}>
          {e.content}
        </div>
      ))}
      {entries.length === 0 && (
        <div className="text-text-muted">Waiting for output...</div>
      )}
    </div>
  )
}

function CreateTaskForm({ workers, onCreated, roomId }: { workers: Worker[] | null; onCreated: () => void; roomId?: number | null }): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'preset' | 'custom'>('manual')
  const [selectedPreset, setSelectedPreset] = useState(0)
  const [customCron, setCustomCron] = useState('')
  const [workerId, setWorkerId] = useState<number | ''>('')
  const [maxRuns, setMaxRuns] = useState<string>('')
  const [createError, setCreateError] = useState<string | null>(null)

  function getResolvedCron(): string | undefined {
    if (scheduleMode === 'preset') return SCHEDULE_PRESETS[selectedPreset].cron
    if (scheduleMode === 'custom') return customCron.trim() || undefined
    return undefined
  }

  async function handleCreate(): Promise<void> {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      setCreateError('Prompt is required.')
      return
    }
    setCreateError(null)
    try {
      const parsedMaxRuns = maxRuns.trim() ? parseInt(maxRuns.trim(), 10) : undefined
      await api.tasks.create({
        name: name.trim() || trimmedPrompt.slice(0, 40),
        prompt: trimmedPrompt,
        cronExpression: getResolvedCron(),
        workerId: workerId || undefined,
        maxRuns: parsedMaxRuns && parsedMaxRuns > 0 ? parsedMaxRuns : undefined,
        roomId: roomId ?? undefined
      })
      setPrompt('')
      setName('')
      setScheduleMode('manual')
      setSelectedPreset(0)
      setCustomCron('')
      setWorkerId('')
      setMaxRuns('')
      onCreated()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create task')
    }
  }

  return (
    <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); setCreateError(null) }}
        rows={3}
        placeholder="Task prompt (what should the agent do?)"
        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted resize-y"
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted"
      />
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Schedule:</span>
          {(['manual', 'preset', 'custom'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setScheduleMode(mode)}
              className={`text-xs font-medium px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${
                scheduleMode === mode
                  ? 'bg-surface-invert text-text-invert'
                  : 'bg-surface-tertiary text-text-muted hover:bg-surface-hover'
              }`}
            >
              {mode === 'manual' ? 'On-demand' : mode === 'preset' ? 'Schedule' : 'Custom'}
            </button>
          ))}
        </div>
        {scheduleMode === 'preset' && (
          <Select
            value={String(selectedPreset)}
            onChange={(v) => setSelectedPreset(Number(v))}
            className="w-full"
            options={SCHEDULE_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
          />
        )}
        {scheduleMode === 'custom' && (
          <input
            type="text"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="Cron expression (e.g. 0 9 * * 1-5 = weekdays 9 AM)"
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted"
          />
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {workers && workers.length > 0 && (
          <Select
            value={String(workerId)}
            onChange={(v) => setWorkerId(v ? Number(v) : '')}
            placeholder="No worker"
            options={[
              { value: '', label: 'No worker' },
              ...workers.map(w => ({ value: String(w.id), label: `${w.name}${w.isDefault ? ' (default)' : ''}` }))
            ]}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Runs:</span>
          <input
            type="text"
            inputMode="numeric"
            value={maxRuns}
            onChange={(e) => {
              const v = e.target.value
              if (v === '' || /^\d+$/.test(v)) setMaxRuns(v)
            }}
            placeholder="No limit"
            className="w-16 bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary text-center focus:outline-none focus:border-text-muted"
          />
        </div>
        <div className="flex-1" />
        {createError && (
          <span className="text-sm text-status-error truncate">{createError}</span>
        )}
        <button
          onClick={handleCreate}
          disabled={!prompt.trim()}
          className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create Task
        </button>
      </div>
    </div>
  )
}

export function TasksPanel({ roomId, autonomyMode }: { roomId?: number | null; autonomyMode: 'auto' | 'semi' }): React.JSX.Element {
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [filter, setFilter] = useState<StatusFilter>(persistedFilter)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(new Set())
  const [consoleTaskId, setConsoleTaskId] = useState<number | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const { data: tasks, refresh, error: tasksError, isLoading } = usePolling(() => api.tasks.list(roomId ?? undefined), 30000)
  const { data: runningRuns, refresh: refreshRuns } = usePolling(
    () => api.runs.list(20, { status: 'running' }),
    30000
  )
  const { data: workers } = usePolling(() => api.workers.list(), 60000)
  const taskEvent = useWebSocket('tasks')
  const runsEvent = useWebSocket('runs')

  useEffect(() => {
    if (taskEvent) refresh()
  }, [refresh, taskEvent])

  useEffect(() => {
    if (!runsEvent) return
    refreshRuns()
    refresh()
  }, [refresh, refreshRuns, runsEvent])

  function updateFilter(next: StatusFilter): void {
    persistedFilter = next
    setFilter(next)
  }

  const workerMap = new Map<number, Worker>()
  if (workers) {
    for (const w of workers) workerMap.set(w.id, w)
  }

  const runningByTaskId = new Map<number, TaskRun>()
  if (runningRuns) {
    for (const run of runningRuns) {
      if (!runningByTaskId.has(run.taskId)) {
        runningByTaskId.set(run.taskId, run)
      }
    }
  }

  async function togglePause(task: Task): Promise<void> {
    setActionError(null)
    try {
      if (task.status === 'paused') {
        await api.tasks.resume(task.id)
      } else {
        await api.tasks.pause(task.id)
      }
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update task status')
    }
  }

  async function deleteTask(id: number): Promise<void> {
    setActionError(null)
    try {
      await api.tasks.delete(id)
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete task')
    }
  }

  async function runNow(id: number): Promise<void> {
    setActionError(null)
    setPendingRuns((prev) => new Set(prev).add(id))
    try {
      await api.tasks.run(id)
      refresh()
    } catch (err) {
      setPendingRuns((prev) => { const next = new Set(prev); next.delete(id); return next })
      setActionError(err instanceof Error ? err.message : 'Failed to run task')
    }
  }

  // Clear pending flags once polling detects the actual running run
  useEffect(() => {
    if (pendingRuns.size === 0) return
    const confirmed = new Set<number>()
    for (const id of pendingRuns) {
      if (runningByTaskId.has(id)) confirmed.add(id)
    }
    if (confirmed.size > 0) {
      setPendingRuns((prev) => {
        const next = new Set(prev)
        for (const id of confirmed) next.delete(id)
        return next
      })
    }
  }, [runningRuns])

  // Safety timeout: clear stale pending runs that never materialized into actual runs
  useEffect(() => {
    if (pendingRuns.size === 0) return
    const timer = setTimeout(() => {
      setPendingRuns((prev) => {
        const next = new Set<number>()
        for (const id of prev) {
          if (runningByTaskId.has(id)) next.add(id)
        }
        return next.size === prev.size ? prev : next
      })
    }, 15000)
    return () => clearTimeout(timer)
  }, [pendingRuns.size])

  async function assignWorker(taskId: number, newWorkerId: number | null): Promise<void> {
    setActionError(null)
    try {
      await api.tasks.update(taskId, { workerId: newWorkerId })
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to assign worker')
    }
  }

  if (isLoading && !tasks) {
    return <div className="p-4 flex-1 flex items-center justify-center text-base text-text-muted">Loading...</div>
  }
  if (!tasks) {
    return <div className="p-4 text-sm text-status-error">{tasksError ?? 'Failed to load tasks.'}</div>
  }

  const taskCounts = {
    all: tasks.length,
    active: tasks.filter((t) => t.status === 'active').length,
    paused: tasks.filter((t) => t.status === 'paused').length,
    completed: tasks.filter((t) => t.status === 'completed').length
  }
  const isFiltering = filter !== 'all'
  const filteredTasks = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">Tasks</h2>
        <span className="text-xs text-text-muted">{tasks.length} total</span>
        <button
          onClick={() => guard(() => setShowCreateForm(!showCreateForm))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreateForm ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {semi && showCreateForm && (
        <CreateTaskForm
          workers={workers ?? null}
          onCreated={() => { refresh(); setShowCreateForm(false) }}
          roomId={roomId}
        />
      )}

      <div className="px-3 py-2 border-b border-border-primary">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Filters</div>
          {isFiltering && (
            <button
              onClick={() => updateFilter('all')}
              className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => updateFilter('all')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'all'
                ? 'bg-interactive-bg text-interactive border-interactive/30'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            All ({taskCounts.all})
          </button>
          <button
            onClick={() => updateFilter('active')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'active'
                ? 'bg-status-success-bg text-status-success border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            Active ({taskCounts.active})
          </button>
          <button
            onClick={() => updateFilter('paused')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'paused'
                ? 'bg-status-warning-bg text-status-warning border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            Paused ({taskCounts.paused})
          </button>
          <button
            onClick={() => updateFilter('completed')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'completed'
                ? 'bg-interactive-bg text-interactive border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            Done ({taskCounts.completed})
          </button>
        </div>
      </div>

      {tasksError && (
        <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg">
          Temporary refresh issue: {tasksError}
        </div>
      )}
      {actionError && (
        <div className="px-3 py-2 text-sm text-status-error bg-status-error-bg">
          Action failed: {actionError}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto">
      {filteredTasks.length === 0 ? (
        <div className="p-4 text-center text-sm text-text-muted">
          {filter !== 'all' ? (
            <>
              No tasks match filter.{' '}
              <button
                onClick={() => updateFilter('all')}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
              >
                Clear filter
              </button>
            </>
          ) : semi ? (
            'No tasks yet. Create one above or use the MCP tools.'
          ) : (
            'No tasks yet. Tasks are created by agents.'
          )}
        </div>
      ) : (
        <div className={`grid gap-2 p-3 ${wide ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {filteredTasks.map((task) => {
            const activeRun = runningByTaskId.get(task.id)
            const busy = !!activeRun || pendingRuns.has(task.id)
            const source = sourceLabel(task)
            const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
            return (
              <div key={task.id} className="bg-surface-secondary border border-border-primary rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-text-primary truncate">{task.name}</span>
                  {statusBadge(task)}
                </div>
                <div className="text-sm text-text-muted mb-1">
                  {triggerLabel(task)}
                  {task.maxRuns != null && (
                    <span className="ml-1.5 text-text-muted">{task.runCount}/{task.maxRuns} runs</span>
                  )}
                </div>
                <div className="text-sm text-text-muted mb-1.5">
                  Last run: {formatRelativeTime(task.lastRun)}
                  {source && <span className="ml-1.5">via {source}</span>}
                  {worker && <span className="ml-1.5 text-purple-400">{worker.name}</span>}
                  {task.sessionContinuity && (
                    <span className="ml-1.5 px-1 py-0.5 rounded-lg bg-violet-100 text-violet-600">continuous</span>
                  )}
                </div>
                {activeRun && <ProgressBar run={activeRun} />}
                {activeRun && consoleTaskId === task.id && (
                  <ConsoleView runId={activeRun.id} />
                )}
                <div className="flex flex-wrap gap-2 items-center mt-2">
                  <button
                    onClick={() => guard(() => { void runNow(task.id) })}
                    disabled={semi && busy}
                    className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
                  >
                    {busy ? 'Running' : 'Run'}
                  </button>
                  {task.status !== 'completed' && (
                    <button
                      onClick={() => guard(() => { void togglePause(task) })}
                      disabled={semi && busy}
                      className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-status-warning-bg text-status-warning hover:bg-status-warning-bg')}`}
                    >
                      {task.status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  )}
                  <button
                    onClick={() => guard(() => { void deleteTask(task.id) })}
                    disabled={semi && busy}
                    className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-status-error-bg text-status-error hover:bg-status-error-bg')}`}
                  >
                    Delete
                  </button>
                  {activeRun && (
                    <button
                      onClick={() => setConsoleTaskId(consoleTaskId === task.id ? null : task.id)}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover"
                    >
                      {consoleTaskId === task.id ? 'Hide Console' : 'Console'}
                    </button>
                  )}
                  {workers && workers.length > 0 && (
                    <div className="ml-auto min-w-[160px]">
                      {semi ? (
                        <Select
                          value={String(task.workerId ?? '')}
                          onChange={(v) => { void assignWorker(task.id, v ? Number(v) : null) }}
                          variant="inline"
                          className="text-purple-400"
                          placeholder="No worker"
                          options={[
                            { value: '', label: 'No worker' },
                            ...workers.map(w => ({ value: String(w.id), label: `${w.name}${w.isDefault ? ' (default)' : ''}` }))
                          ]}
                        />
                      ) : (
                        <button
                          onClick={requestSemiMode}
                          className={`text-xs px-2.5 py-1.5 rounded-lg w-full text-left ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                        >
                          Assign Worker
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
