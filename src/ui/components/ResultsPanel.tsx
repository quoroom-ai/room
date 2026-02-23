import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTick } from '../hooks/useTick'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { wsClient, type WsMessage } from '../lib/ws'
import type { TaskRun, Task, ConsoleLogEntry, SelfModAuditEntry, Worker } from '@shared/types'
import { formatDateTimeShort, formatRelativeTime } from '../utils/time'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-console-text',
  result: 'text-blue-400',
  error: 'text-red-400'
}

function ConsoleLogHistory({ runId }: { runId: number }): React.JSX.Element {
  const [entries, setEntries] = useState<ConsoleLogEntry[] | null>(null)
  const [showConsole, setShowConsole] = useState(false)

  useEffect(() => {
    if (!showConsole) return
    api.runs.getLogs(runId, 0, 200).then(setEntries).catch(() => setEntries([]))
  }, [runId, showConsole])

  if (!showConsole) {
    return (
      <button onClick={() => setShowConsole(true)} className="text-sm text-text-muted hover:text-text-secondary mt-1">
        Show console log
      </button>
    )
  }

  if (!entries) {
    return <div className="text-sm text-text-muted mt-1">Loading...</div>
  }

  if (entries.length === 0) {
    return <div className="text-sm text-text-muted mt-1">No console logs for this run.</div>
  }

  return (
    <div className="mt-1">
      <button onClick={() => setShowConsole(false)} className="text-sm text-text-muted hover:text-text-secondary mb-1">
        Hide console log
      </button>
      <div className="max-h-48 overflow-y-auto bg-console-bg rounded-lg p-3 font-mono text-sm leading-relaxed">
        {entries.map((e) => (
          <div key={e.seq} className={CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-console-text'}>
            {e.content}
          </div>
        ))}
      </div>
    </div>
  )
}

function SelfModSection({ roomId, semi, onLockedControl }: { roomId: number | null; semi: boolean; onLockedControl: () => void }): React.JSX.Element {
  const { data: entries, refresh } = usePolling<SelfModAuditEntry[]>(
    () => roomId ? api.selfMod.list(roomId) : Promise.resolve([]),
    30000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 60000)

  const [confirmRevertId, setConfirmRevertId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (event.type === 'self_mod:reverted' || event.type === 'self_mod:edited') {
        void refresh()
      }
    })
  }, [refresh, roomId])

  async function handleRevert(id: number): Promise<void> {
    await api.selfMod.revert(id)
    setConfirmRevertId(null)
    refresh()
  }

  if (!entries || entries.length === 0) return <></>

  return (
    <div className="mt-4">
      <div className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wide bg-surface-secondary border-y border-border-primary">
        Code Modifications
      </div>
      <div className="grid gap-2 mt-2 md:grid-cols-2">
        {entries.map(entry => (
          <div key={entry.id} className="px-3 py-2 bg-surface-secondary border border-border-primary rounded-lg">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-sm font-mono text-text-secondary truncate flex-1">{entry.filePath}</span>
              <span className={`px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 ${
                entry.reverted ? 'bg-surface-tertiary text-text-muted' : 'bg-status-success-bg text-status-success'
              }`}>
                {entry.reverted ? 'reverted' : 'active'}
              </span>
              {!entry.reverted && (
                semi ? (
                  confirmRevertId === entry.id ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { void handleRevert(entry.id) }}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-status-error-bg text-status-error hover:bg-status-error-bg"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmRevertId(null)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-muted hover:bg-surface-hover"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmRevertId(entry.id)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-status-warning-bg text-status-warning hover:bg-status-warning-bg shrink-0"
                    >
                      Revert
                    </button>
                  )
                ) : (
                  <button
                    onClick={onLockedControl}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                  >
                    Revert
                  </button>
                )
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span>{formatRelativeTime(entry.createdAt)}</span>
              {entry.workerId && (
                <span>by {workerMap.get(entry.workerId)?.name ?? `Worker #${entry.workerId}`}</span>
              )}
            </div>
            {entry.reason && (
              <div className="text-sm text-text-muted mt-0.5">{entry.reason}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

interface ResultsPanelProps {
  roomId?: number | null
  autonomyMode: 'auto' | 'semi'
}

export function ResultsPanel({ roomId, autonomyMode }: ResultsPanelProps): React.JSX.Element {
  useTick()
  const { semi, showLockModal, closeLockModal, requestSemiMode } = useAutonomyControlGate(autonomyMode)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [runDetails, setRunDetails] = useState<Record<number, TaskRun>>({})
  const [runDetailsLoading, setRunDetailsLoading] = useState<Record<number, boolean>>({})
  const [taskNames, setTaskNames] = useState<Record<number, string>>({})
  const { data: runs, error, isLoading, refresh } = usePolling(() => api.runs.list(30, { includeResult: false }), 30000)
  const runsEvent = useWebSocket('runs')

  useEffect(() => {
    if (runsEvent) refresh()
  }, [refresh, runsEvent])

  useEffect(() => {
    api.tasks.list().then((tasks: Task[]) => {
      const map: Record<number, string> = {}
      for (const t of tasks) map[t.id] = t.name
      setTaskNames(map)
    })
  }, [])

  async function ensureRunDetail(runId: number): Promise<void> {
    if (runDetails[runId] || runDetailsLoading[runId]) return
    setRunDetailsLoading(prev => ({ ...prev, [runId]: true }))
    try {
      const detail = await api.runs.get(runId)
      setRunDetails(prev => ({ ...prev, [runId]: detail }))
    } catch {
      // ignore; summary row still renders
    } finally {
      setRunDetailsLoading(prev => {
        const next = { ...prev }
        delete next[runId]
        return next
      })
    }
  }

  useEffect(() => {
    if (expandedId == null) return
    void ensureRunDetail(expandedId)
  }, [expandedId])

  useEffect(() => {
    if (!wide || !runs || runs.length === 0) return
    const prefetched = runs.slice(0, 2)
    for (const run of prefetched) {
      void ensureRunDetail(run.id)
    }
  }, [runs, wide])

  if (isLoading && !runs) {
    return <div className="p-4 flex-1 flex items-center justify-center text-base text-text-muted">Loading...</div>
  }
  if (!runs) {
    return <div className="p-4 text-sm text-status-error">{error ?? 'Failed to load runs.'}</div>
  }

  function renderRun(run: TaskRun, index: number): React.JSX.Element {
    const wideAutoExpand = wide && index < 2
    const detail = runDetails[run.id] ?? run
    const detailLoading = runDetailsLoading[run.id] === true
    return (
      <div key={run.id} className="border border-border-primary rounded-lg overflow-hidden bg-surface-secondary">
        <div
          className="px-3 py-2 hover:bg-surface-hover cursor-pointer"
          onClick={() => {
            const next = expandedId === run.id ? null : run.id
            setExpandedId(next)
            if (next !== null) {
              void ensureRunDetail(next)
            }
          }}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-sm font-medium text-text-primary truncate">
              {taskNames[run.taskId] ?? `Task #${run.taskId}`}
            </span>
            <span className={`text-sm ${run.status === 'completed' ? 'text-status-success' : run.status === 'running' ? 'text-interactive' : 'text-status-error'}`}>
              {run.status}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <span>{formatDateTimeShort(run.startedAt)}</span>
            {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
          </div>
        </div>

        {(wideAutoExpand || expandedId === run.id) && (
          <div className="px-3 pb-2 bg-surface-secondary">
            {detailLoading && (
              <div className="text-sm text-text-muted py-1">Loading details...</div>
            )}
            {detail.errorMessage && (
              <div className="text-sm text-status-error mb-1 p-1.5 bg-status-error-bg rounded-lg selectable">{detail.errorMessage}</div>
            )}
            {detail.result && (
              <div className="text-sm text-text-secondary p-1.5 bg-surface-primary rounded-lg max-h-40 overflow-y-auto selectable whitespace-pre-wrap">{detail.result}</div>
            )}
            {!detail.result && !detail.errorMessage && !detailLoading && (
              <div className="text-sm text-text-muted py-1">No output</div>
            )}
            <ConsoleLogHistory runId={run.id} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      {error && (
        <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg">Temporary refresh issue: {error}</div>
      )}
      {runs.length === 0 ? (
        <div className="p-4 text-center text-sm text-text-muted">No task runs yet.</div>
      ) : (
        <div className={`grid gap-3 p-4 ${wide ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {runs.map((run: TaskRun, i: number) => renderRun(run, i))}
        </div>
      )}
      <SelfModSection roomId={roomId ?? null} semi={semi} onLockedControl={requestSemiMode} />
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
