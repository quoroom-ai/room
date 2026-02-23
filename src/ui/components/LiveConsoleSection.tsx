import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useDocumentVisible } from '../hooks/useDocumentVisible'
import { api } from '../lib/client'
import { wsClient, type WsMessage } from '../lib/ws'
import type { Task, TaskRun, ConsoleLogEntry, Worker, WorkerCycle, CycleLogEntry } from '@shared/types'
import { formatRelativeTime } from '../utils/time'

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-console-muted',
  result: 'text-blue-400',
  error: 'text-red-400',
  system: 'text-cyan-400',
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-interactive',
  completed: 'text-status-success',
  failed: 'text-status-error',
}

const LOG_POLL_MS = 5000
const CYCLES_POLL_MS = 10000
const MAX_ENTRIES = 200
const MAX_ITEMS = 20

// Unified log entry (works for both cycle logs and task run console logs)
interface LogEntry {
  seq: number
  entryType: string
  content: string
}

// Unified console item — either a cycle or a task run
interface ConsoleItem {
  kind: 'cycle' | 'run'
  id: number        // cycle.id or run.id
  startedAt: string
  status: string
  label: string
  badgeLabel: string | null
  badgeStyle: string
  errorMessage?: string | null  // for failed cycles with no logs
}

interface LiveConsoleSectionProps {
  isActive: boolean
  tasks: Task[]
  roomId?: number | null
  workers?: Worker[]
  queenWorkerId?: number | null
}

export function LiveConsoleSection({
  isActive,
  tasks,
  roomId,
  workers = [],
}: LiveConsoleSectionProps): React.JSX.Element {
  const isVisible = useDocumentVisible()
  const active = isActive && isVisible

  // ─── Cycles state ──────────────────────────────────────
  const [cycles, setCycles] = useState<WorkerCycle[]>([])
  const [cyclesLoading, setCyclesLoading] = useState(false)
  const [cycleLogMap, setCycleLogMap] = useState<Map<number, LogEntry[]>>(new Map())
  const lastCycleSeq = useRef<Map<number, number>>(new Map())
  const fetchedCompletedCycles = useRef<Set<number>>(new Set())
  const cycleUnsubsRef = useRef<Map<number, () => void>>(new Map())

  // ─── Task runs state (kept for task output) ────────────
  const [allRuns, setAllRuns] = useState<TaskRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runLogMap, setRunLogMap] = useState<Map<number, LogEntry[]>>(new Map())
  const lastRunSeq = useRef<Map<number, number>>(new Map())
  const fetchedCompletedRuns = useRef<Set<number>>(new Set())
  const runUnsubsRef = useRef<Map<number, () => void>>(new Map())

  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  const workerMap = useMemo(() => new Map(workers.map(w => [w.id, w])), [workers])
  const taskMap = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])

  const roomTaskIds = useMemo(() => {
    if (!roomId) return null
    return new Set(tasks.filter(t => t.roomId === roomId).map(t => t.id))
  }, [tasks, roomId])

  // ─── Merge helper ──────────────────────────────────────
  const mergeEntries = useCallback((existing: LogEntry[], incoming: LogEntry[]): LogEntry[] => {
    if (incoming.length === 0) return existing
    const seen = new Set(existing.map(e => e.seq))
    const next = [...existing]
    for (const entry of incoming) {
      if (seen.has(entry.seq)) continue
      seen.add(entry.seq)
      next.push(entry)
    }
    return next.slice(-MAX_ENTRIES)
  }, [])

  // ─── Fetch cycles for room ─────────────────────────────
  useEffect(() => {
    if (!active || !roomId) {
      setCyclesLoading(false)
      return
    }
    let mounted = true

    async function fetchCycles(): Promise<void> {
      if (!mounted) return
      setCyclesLoading(true)
      try {
        const data = await api.cycles.listByRoom(roomId!, MAX_ITEMS)
        if (mounted) setCycles(data)
      } catch {
        // non-fatal
      } finally {
        if (mounted) setCyclesLoading(false)
      }
    }

    void fetchCycles()
    const timer = setInterval(() => { void fetchCycles() }, CYCLES_POLL_MS)
    return () => { mounted = false; clearInterval(timer) }
  }, [active, roomId])

  // ─── WebSocket: cycle lifecycle triggers re-fetch ──────
  useEffect(() => {
    if (!active || !roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (event.type === 'cycle:created' || event.type === 'cycle:completed' || event.type === 'cycle:failed') {
        void api.cycles.listByRoom(roomId, MAX_ITEMS).then(setCycles).catch(() => {})
      }
    })
  }, [active, roomId])

  // ─── WebSocket: streaming cycle logs ───────────────────
  useEffect(() => {
    if (!active) return
    const runningIds = new Set(cycles.filter(c => c.status === 'running').map(c => c.id))

    // Unsub from cycles that stopped
    for (const [id, unsub] of [...cycleUnsubsRef.current.entries()]) {
      if (!runningIds.has(id)) {
        unsub()
        cycleUnsubsRef.current.delete(id)
      }
    }

    // Sub to new running cycles
    for (const cycle of cycles) {
      if (cycle.status !== 'running') continue
      if (cycleUnsubsRef.current.has(cycle.id)) continue
      const unsub = wsClient.subscribe(`cycle:${cycle.id}`, (event: WsMessage) => {
        if (event.type !== 'cycle:log') return
        const p = event.data as { seq?: number; entryType?: string; content?: string }
        if (typeof p.seq !== 'number' || typeof p.entryType !== 'string' || typeof p.content !== 'string') return
        const entry: LogEntry = { seq: p.seq, entryType: p.entryType, content: p.content }
        lastCycleSeq.current.set(cycle.id, Math.max(lastCycleSeq.current.get(cycle.id) ?? 0, entry.seq))
        setCycleLogMap(prev => {
          const next = new Map(prev)
          next.set(cycle.id, mergeEntries(next.get(cycle.id) ?? [], [entry]))
          return next
        })
      })
      cycleUnsubsRef.current.set(cycle.id, unsub)
    }
  }, [active, cycles, mergeEntries])

  // ─── Polling: cycle logs (fallback + completed) ────────
  useEffect(() => {
    if (!active || cycles.length === 0) return
    let mounted = true
    const cyclesRef = cycles

    async function poll(): Promise<void> {
      if (!mounted) return
      const updates = new Map<number, LogEntry[]>()
      await Promise.all(cyclesRef.map(async (c) => {
        try {
          if (c.status === 'running') {
            const afterSeq = lastCycleSeq.current.get(c.id) ?? 0
            const entries = await api.cycles.getLogs(c.id, afterSeq, 50)
            if (entries.length > 0) {
              lastCycleSeq.current.set(c.id, entries[entries.length - 1].seq)
              updates.set(c.id, entries.map(e => ({ seq: e.seq, entryType: e.entryType, content: e.content })))
            }
          } else if (!fetchedCompletedCycles.current.has(c.id)) {
            fetchedCompletedCycles.current.add(c.id)
            const entries = await api.cycles.getLogs(c.id, 0, MAX_ENTRIES)
            if (entries.length > 0) {
              lastCycleSeq.current.set(c.id, entries[entries.length - 1].seq)
              updates.set(c.id, entries.map(e => ({ seq: e.seq, entryType: e.entryType, content: e.content })))
            }
          }
        } catch { /* non-fatal */ }
      }))
      if (!mounted || updates.size === 0) return
      setCycleLogMap(prev => {
        const next = new Map(prev)
        for (const [id, entries] of updates) {
          next.set(id, mergeEntries(next.get(id) ?? [], entries))
        }
        return next
      })
    }

    void poll()
    const hasRunning = cyclesRef.some(c => c.status === 'running')
    const timer = hasRunning ? setInterval(() => { void poll() }, LOG_POLL_MS) : undefined
    return () => { mounted = false; if (timer) clearInterval(timer) }
  }, [active, cycles, mergeEntries])

  // ─── Fetch task runs ───────────────────────────────────
  useEffect(() => {
    if (!active) {
      setRunsLoading(false)
      return
    }
    let mounted = true

    async function fetchRuns(): Promise<void> {
      if (!mounted) return
      setRunsLoading(true)
      try {
        const runs = await api.runs.list(50, { roomId: roomId ?? undefined })
        if (mounted) setAllRuns(runs)
      } catch {
        // non-fatal
      } finally {
        if (mounted) setRunsLoading(false)
      }
    }

    void fetchRuns()
    const timer = setInterval(() => { void fetchRuns() }, 30000)
    return () => { mounted = false; clearInterval(timer) }
  }, [active, roomId])

  useEffect(() => {
    if (!active) return
    return wsClient.subscribe('runs', (event: WsMessage) => {
      if (event.type === 'run:created' || event.type === 'run:completed' || event.type === 'run:failed') {
        void api.runs.list(50, { roomId: roomId ?? undefined }).then(setAllRuns).catch(() => {})
      }
    })
  }, [active, roomId])

  // ─── WebSocket + polling for run logs ──────────────────
  const filteredRuns = useMemo(() => {
    if (!roomTaskIds) return allRuns.slice(0, 15)
    return allRuns.filter(r => roomTaskIds.has(r.taskId)).slice(0, 15)
  }, [allRuns, roomTaskIds])

  useEffect(() => {
    if (!active) return
    const runningIds = new Set(filteredRuns.filter(r => r.status === 'running').map(r => r.id))

    for (const [id, unsub] of [...runUnsubsRef.current.entries()]) {
      if (!runningIds.has(id)) { unsub(); runUnsubsRef.current.delete(id) }
    }

    for (const run of filteredRuns) {
      if (run.status !== 'running') continue
      if (runUnsubsRef.current.has(run.id)) continue
      const unsub = wsClient.subscribe(`run:${run.id}`, (event: WsMessage) => {
        if (event.type !== 'run:log') return
        const p = event.data as { seq?: number; entryType?: string; content?: string }
        if (typeof p.seq !== 'number' || typeof p.entryType !== 'string' || typeof p.content !== 'string') return
        const entry: LogEntry = { seq: p.seq, entryType: p.entryType, content: p.content }
        lastRunSeq.current.set(run.id, Math.max(lastRunSeq.current.get(run.id) ?? 0, entry.seq))
        setRunLogMap(prev => {
          const next = new Map(prev)
          next.set(run.id, mergeEntries(next.get(run.id) ?? [], [entry]))
          return next
        })
      })
      runUnsubsRef.current.set(run.id, unsub)
    }
  }, [active, filteredRuns, mergeEntries])

  const filteredRunsRef = useRef(filteredRuns)
  filteredRunsRef.current = filteredRuns

  useEffect(() => {
    if (!active || filteredRuns.length === 0) return
    let mounted = true

    async function poll(): Promise<void> {
      if (!mounted) return
      const runs = filteredRunsRef.current
      const updates = new Map<number, LogEntry[]>()
      await Promise.all(runs.map(async (run) => {
        try {
          if (run.status === 'running') {
            const afterSeq = lastRunSeq.current.get(run.id) ?? 0
            const entries = await api.runs.getLogs(run.id, afterSeq, 50)
            if (entries.length > 0) {
              lastRunSeq.current.set(run.id, entries[entries.length - 1].seq)
              updates.set(run.id, entries.map(e => ({ seq: e.seq, entryType: e.entryType, content: e.content })))
            }
          } else if (!fetchedCompletedRuns.current.has(run.id)) {
            fetchedCompletedRuns.current.add(run.id)
            const entries = await api.runs.getLogs(run.id, 0, MAX_ENTRIES)
            if (entries.length > 0) {
              lastRunSeq.current.set(run.id, entries[entries.length - 1].seq)
              updates.set(run.id, entries.map(e => ({ seq: e.seq, entryType: e.entryType, content: e.content })))
            }
          }
        } catch { /* non-fatal */ }
      }))
      if (!mounted || updates.size === 0) return
      setRunLogMap(prev => {
        const next = new Map(prev)
        for (const [id, entries] of updates) {
          next.set(id, mergeEntries(next.get(id) ?? [], entries))
        }
        return next
      })
    }

    void poll()
    const hasRunning = filteredRuns.some(r => r.status === 'running')
    const timer = hasRunning ? setInterval(() => { void poll() }, LOG_POLL_MS) : undefined
    return () => { mounted = false; if (timer) clearInterval(timer) }
  }, [active, filteredRuns, mergeEntries])

  // ─── Cleanup subscriptions on unmount ──────────────────
  useEffect(() => () => {
    for (const unsub of cycleUnsubsRef.current.values()) unsub()
    cycleUnsubsRef.current.clear()
    for (const unsub of runUnsubsRef.current.values()) unsub()
    runUnsubsRef.current.clear()
  }, [])

  // ─── Auto-scroll ───────────────────────────────────────
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [cycleLogMap, runLogMap])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  }, [])

  // ─── Build unified sorted items ────────────────────────
  const consoleItems = useMemo((): ConsoleItem[] => {
    const items: ConsoleItem[] = []

    // Cycles
    for (const c of cycles) {
      const worker = workerMap.get(c.workerId)
      const isQueen = worker?.isDefault === true
      items.push({
        kind: 'cycle',
        id: c.id,
        startedAt: c.startedAt,
        status: c.status,
        label: `${worker?.name ?? 'Worker'} Cycle`,
        badgeLabel: isQueen ? 'Queen' : (worker?.name ?? null),
        badgeStyle: isQueen
          ? 'border-purple-500/40 bg-purple-500/20 text-purple-300'
          : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
        errorMessage: c.errorMessage,
      })
    }

    // Task runs
    for (const r of filteredRuns) {
      const task = taskMap.get(r.taskId)
      const worker = task?.workerId ? workerMap.get(task.workerId) : null
      items.push({
        kind: 'run',
        id: r.id,
        startedAt: r.startedAt,
        status: r.status,
        label: task?.name ?? `Task #${r.taskId}`,
        badgeLabel: worker?.name ?? null,
        badgeStyle: 'border-blue-500/40 bg-blue-500/20 text-blue-300',
      })
    }

    items.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    return items.slice(0, MAX_ITEMS)
  }, [cycles, filteredRuns, workerMap, taskMap])

  const isInitialLoading = active && consoleItems.length === 0 && (runsLoading || cyclesLoading)

  // ─── Render ────────────────────────────────────────────
  return (
    <div className="bg-surface-secondary rounded-lg overflow-hidden flex-1 flex flex-col min-h-0 shadow-sm">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden bg-console-bg m-3 rounded-lg p-3 font-mono text-sm leading-relaxed min-h-[4rem]"
      >
        {consoleItems.length === 0 ? (
          <div className="text-console-muted">{isInitialLoading ? 'Loading...' : 'No recent activity.'}</div>
        ) : (
          consoleItems.map((item) => {
            const entries = item.kind === 'cycle'
              ? (cycleLogMap.get(item.id) ?? [])
              : (runLogMap.get(item.id) ?? [])
            const statusColor = STATUS_COLORS[item.status] ?? 'text-console-muted'

            return (
              <div key={`${item.kind}-${item.id}`} className="mb-3 last:mb-0">
                <div className="flex items-center gap-2 mb-0.5 sticky top-0 bg-console-bg py-0.5">
                  <span className="text-blue-400 font-semibold">{item.label}</span>
                  {item.badgeLabel && (
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${item.badgeStyle}`}>
                      {item.badgeLabel}
                    </span>
                  )}
                  <span className={`text-xs ${statusColor}`}>
                    {item.status === 'running' ? 'running...' : item.status}
                  </span>
                  <span className="text-xs text-console-muted ml-auto">{formatRelativeTime(item.startedAt)}</span>
                </div>
                {entries.length === 0 ? (
                  <div className={item.status === 'failed' && item.errorMessage ? 'text-red-400' : 'text-console-muted'}>
                    {item.status === 'running'
                      ? 'Waiting for output...'
                      : item.errorMessage ?? 'No logs.'}
                  </div>
                ) : (
                  <>
                    {entries.map((entry) => (
                      <div
                        key={`${item.kind}-${item.id}-${entry.seq}`}
                        className={`${CONSOLE_ENTRY_COLORS[entry.entryType] ?? 'text-console-text'} whitespace-pre-wrap break-words`}
                      >
                        {entry.content}
                      </div>
                    ))}
                    {item.status === 'failed' && item.errorMessage && (
                      <div className="text-red-400 text-xs mt-1">↳ {item.errorMessage}</div>
                    )}
                  </>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
