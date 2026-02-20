import { usePolling } from '../hooks/usePolling'
import type { Task, TaskRun, Worker, ConsoleLogEntry } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { useState, useEffect, useRef } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'

// Module-level persistence: survives component unmounts during tab switches
let persistedFilter: StatusFilter = 'all'

function FilterPill({
  label,
  active,
  onClick,
  colorClass
}: {
  label: string
  active: boolean
  onClick: () => void
  colorClass?: string
}): React.JSX.Element {
  const base = 'px-1.5 py-0.5 rounded text-xs cursor-pointer transition-colors'
  const activeStyle = colorClass ?? 'bg-gray-700 text-white'
  const inactiveStyle = 'bg-gray-100 text-gray-500 hover:bg-gray-200'
  return (
    <button
      onClick={onClick}
      className={`${base} ${active ? activeStyle : inactiveStyle}`}
    >
      {label}
    </button>
  )
}

function statusBadge(task: Task): React.JSX.Element {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-blue-100 text-blue-700',
    error: 'bg-red-100 text-red-700'
  }
  const cls = colors[task.status] ?? 'bg-gray-100 text-gray-600'
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${cls}`}>
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
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          {run.progress != null ? (
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.round(run.progress * 100)}%` }}
            />
          ) : (
            <div className="h-full bg-blue-400 rounded-full animate-pulse w-full" />
          )}
        </div>
      </div>
      {run.progressMessage && (
        <div className="text-xs text-blue-500 mt-0.5 truncate">
          {run.progressMessage}
        </div>
      )}
    </div>
  )
}

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-gray-400',
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
          setEntries(prev => [...prev.slice(-150), ...newEntries])
        }
      } catch {
        // non-fatal
      }
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => { mounted = false; clearInterval(timer) }
  }, [runId])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [entries])

  return (
    <div
      ref={scrollRef}
      className="max-h-48 overflow-y-auto bg-gray-900 rounded p-2 mt-1 font-mono text-xs leading-relaxed"
    >
      {entries.map((e) => (
        <div key={e.seq} className={CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-gray-300'}>
          {e.content}
        </div>
      ))}
      {entries.length === 0 && (
        <div className="text-gray-500">Waiting for output...</div>
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
    <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); setCreateError(null) }}
        rows={3}
        placeholder="Task prompt (what should the agent do?)"
        className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y"
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
      />
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400">Schedule:</span>
          {(['manual', 'preset', 'custom'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setScheduleMode(mode)}
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                scheduleMode === mode
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {mode === 'manual' ? 'On-demand' : mode === 'preset' ? 'Schedule' : 'Custom'}
            </button>
          ))}
        </div>
        {scheduleMode === 'preset' && (
          <select
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(Number(e.target.value))}
            className="w-full text-xs border border-gray-300 rounded px-2.5 py-1.5 bg-white focus:outline-none focus:border-gray-500"
          >
            {SCHEDULE_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
          </select>
        )}
        {scheduleMode === 'custom' && (
          <input
            type="text"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="Cron expression (e.g. 0 9 * * 1-5 = weekdays 9 AM)"
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
          />
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {workers && workers.length > 0 && (
          <select
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : '')}
            className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:border-gray-500"
          >
            <option value="">No worker</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400">Runs:</span>
          <input
            type="text"
            inputMode="numeric"
            value={maxRuns}
            onChange={(e) => {
              const v = e.target.value
              if (v === '' || /^\d+$/.test(v)) setMaxRuns(v)
            }}
            placeholder="No limit"
            className="w-16 text-xs text-center border border-gray-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-gray-500"
          />
        </div>
        <div className="flex-1" />
        {createError && (
          <span className="text-xs text-red-500 truncate">{createError}</span>
        )}
        <button
          onClick={handleCreate}
          disabled={!prompt.trim()}
          className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create Task
        </button>
      </div>
    </div>
  )
}

export function TasksPanel({ roomId, autonomyMode }: { roomId?: number | null; autonomyMode: 'auto' | 'semi' }): React.JSX.Element {
  const semi = autonomyMode === 'semi'
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [filter, setFilter] = useState<StatusFilter>(persistedFilter)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(new Set())
  const [consoleTaskId, setConsoleTaskId] = useState<number | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const { data: tasks, refresh, error: tasksError, isLoading } = usePolling(() => api.tasks.list(roomId ?? undefined), 10000)
  const { data: runningRuns } = usePolling(
    async () => (await api.runs.list(20)).filter(r => r.status === 'running'),
    5000
  )
  const { data: workers } = usePolling(() => api.workers.list(), 30000)

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
    return <div className="p-4 text-xs text-gray-400">Loading...</div>
  }
  if (!tasks) {
    return <div className="p-4 text-xs text-red-500">{tasksError ?? 'Failed to load tasks.'}</div>
  }

  const taskCounts = {
    all: tasks.length,
    active: tasks.filter((t) => t.status === 'active').length,
    paused: tasks.filter((t) => t.status === 'paused').length,
    completed: tasks.filter((t) => t.status === 'completed').length
  }
  const filteredTasks = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs text-gray-500">
          {tasks.length} task(s)
        </span>
        {semi && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            {showCreateForm ? 'Cancel' : '+ New Task'}
          </button>
        )}
      </div>

      {semi && showCreateForm && (
        <CreateTaskForm
          workers={workers ?? null}
          onCreated={() => { refresh(); setShowCreateForm(false) }}
          roomId={roomId}
        />
      )}

      <div className="px-3 py-2 border-b border-gray-200">
        <div className="flex items-center gap-1">
          <FilterPill
            label={`All (${taskCounts.all})`}
            active={filter === 'all'}
            onClick={() => updateFilter('all')}
          />
          <FilterPill
            label={`Active (${taskCounts.active})`}
            active={filter === 'active'}
            onClick={() => updateFilter('active')}
            colorClass="bg-green-100 text-green-700"
          />
          <FilterPill
            label={`Paused (${taskCounts.paused})`}
            active={filter === 'paused'}
            onClick={() => updateFilter('paused')}
            colorClass="bg-yellow-100 text-yellow-700"
          />
          <FilterPill
            label={`Done (${taskCounts.completed})`}
            active={filter === 'completed'}
            onClick={() => updateFilter('completed')}
            colorClass="bg-blue-100 text-blue-700"
          />
        </div>
      </div>

      {tasksError && (
        <div className="px-3 py-2 text-xs text-yellow-700 bg-yellow-50">
          Temporary refresh issue: {tasksError}
        </div>
      )}
      {actionError && (
        <div className="px-3 py-2 text-xs text-red-500 bg-red-50">
          Action failed: {actionError}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto">
      {filteredTasks.length === 0 ? (
        <div className="p-4 text-center text-xs text-gray-400">
          {filter !== 'all' ? (
            <>
              No tasks match filter.{' '}
              <button
                onClick={() => updateFilter('all')}
                className="text-blue-500 hover:text-blue-700"
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
      ) : wide ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wider border-b border-gray-200">
              <th className="px-3 py-1.5 font-medium">Name</th>
              <th className="px-3 py-1.5 font-medium">Schedule</th>
              <th className="px-3 py-1.5 font-medium">Last Run</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              {semi && <th className="px-3 py-1.5 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
          {filteredTasks.map((task) => {
            const activeRun = runningByTaskId.get(task.id)
            const busy = !!activeRun || pendingRuns.has(task.id)
            const source = sourceLabel(task)
            const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
            return (
              <tr key={task.id} className="group border-b border-gray-50 hover:bg-gray-50/50">
                <td className="px-3 py-2 max-w-[200px]">
                  <div className="font-medium text-gray-800 truncate">{task.name}</div>
                  <div className="text-[10px] text-gray-400 flex items-center gap-1 mt-0.5">
                    {source && <span>via {source}</span>}
                    {semi && workers && workers.length > 0 ? (
                      <select
                        value={task.workerId ?? ''}
                        onChange={(e) => assignWorker(task.id, e.target.value ? Number(e.target.value) : null)}
                        className="text-[10px] text-purple-400 bg-transparent border-none p-0 cursor-pointer focus:outline-none"
                      >
                        <option value="">No worker</option>
                        {workers.map((w) => (
                          <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
                        ))}
                      </select>
                    ) : (
                      worker && <span className="text-purple-400">{worker.name}</span>
                    )}
                    {task.sessionContinuity && (
                      <span className="px-1 py-0.5 rounded bg-violet-100 text-violet-600 leading-none">cont</span>
                    )}
                  </div>
                  {activeRun && <ProgressBar run={activeRun} />}
                  {activeRun && consoleTaskId === task.id && (
                    <ConsoleView runId={activeRun.id} />
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                  {triggerLabel(task)}
                  {task.maxRuns != null && (
                    <div className="text-[10px] text-gray-400">{task.runCount}/{task.maxRuns} runs</div>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                  {formatRelativeTime(task.lastRun)}
                </td>
                <td className="px-3 py-2">{statusBadge(task)}</td>
                {semi && (
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      {activeRun && (
                        <button
                          onClick={() => setConsoleTaskId(consoleTaskId === task.id ? null : task.id)}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          {consoleTaskId === task.id ? 'Hide' : 'Console'}
                        </button>
                      )}
                      <button
                        onClick={() => runNow(task.id)}
                        disabled={busy}
                        className="text-xs text-blue-500 hover:text-blue-700 disabled:text-blue-300 disabled:cursor-not-allowed"
                      >
                        {busy ? 'Running' : 'Run'}
                      </button>
                      {task.status !== 'completed' && (
                        <button
                          onClick={() => togglePause(task)}
                          disabled={busy}
                          className="text-xs text-yellow-600 hover:text-yellow-800 disabled:text-yellow-300 disabled:cursor-not-allowed"
                        >
                          {task.status === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                      )}
                      <button
                        onClick={() => deleteTask(task.id)}
                        disabled={busy}
                        className="text-xs text-red-400 hover:text-red-600 disabled:text-red-200 disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
          </tbody>
        </table>
      ) : (
        <div className="divide-y divide-gray-100">
        {filteredTasks.map((task) => {
          const activeRun = runningByTaskId.get(task.id)
          const busy = !!activeRun || pendingRuns.has(task.id)
          const source = sourceLabel(task)
          const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
          return (
            <div key={task.id} className="px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-800 truncate">{task.name}</span>
                {statusBadge(task)}
              </div>
              <div className="text-xs text-gray-400 mb-1">
                {triggerLabel(task)}
                {task.maxRuns != null && (
                  <span className="ml-1.5 text-gray-500">{task.runCount}/{task.maxRuns} runs</span>
                )}
                {source && <span className="ml-1.5 text-gray-300">via {source}</span>}
                {worker && <span className="ml-1.5 text-purple-400">{worker.name}</span>}
                {task.sessionContinuity && (
                  <span className="ml-1.5 px-1 py-0.5 rounded bg-violet-100 text-violet-600">continuous</span>
                )}
              </div>
              <div className="text-xs text-gray-400 mb-1.5">
                Last run: {formatRelativeTime(task.lastRun)}
              </div>
              {activeRun && <ProgressBar run={activeRun} />}
              {activeRun && consoleTaskId === task.id && (
                <ConsoleView runId={activeRun.id} />
              )}
              {semi && (
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => runNow(task.id)}
                    disabled={busy}
                    className="text-xs text-blue-500 hover:text-blue-700 disabled:text-blue-300 disabled:cursor-not-allowed"
                  >
                    {busy ? 'Running' : 'Run Now'}
                  </button>
                  {task.status !== 'completed' && (
                    <button
                      onClick={() => togglePause(task)}
                      disabled={busy}
                      className="text-xs text-yellow-600 hover:text-yellow-800 disabled:text-yellow-300 disabled:cursor-not-allowed"
                    >
                      {task.status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  )}
                  <button
                    onClick={() => deleteTask(task.id)}
                    disabled={busy}
                    className="text-xs text-red-400 hover:text-red-600 disabled:text-red-200 disabled:cursor-not-allowed"
                  >
                    Delete
                  </button>
                  {activeRun && (
                    <button
                      onClick={() => setConsoleTaskId(consoleTaskId === task.id ? null : task.id)}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      {consoleTaskId === task.id ? 'Hide Console' : 'Console'}
                    </button>
                  )}
                  {semi && workers && workers.length > 0 && (
                    <div className="ml-auto flex items-center gap-1">
                      <select
                        value={task.workerId ?? ''}
                        onChange={(e) => assignWorker(task.id, e.target.value ? Number(e.target.value) : null)}
                        className="text-[10px] text-purple-400 bg-transparent border border-gray-200 rounded px-1 py-0.5 cursor-pointer focus:outline-none"
                      >
                        <option value="">No worker</option>
                        {workers.map((w) => (
                          <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        </div>
      )}
      </div>
    </div>
  )
}
