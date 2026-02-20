import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import type { TaskRun, Task, ConsoleLogEntry, SelfModAuditEntry, Worker } from '@shared/types'
import { formatDateTimeShort, formatRelativeTime } from '../utils/time'

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-gray-400',
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
      <button onClick={() => setShowConsole(true)} className="text-xs text-gray-400 hover:text-gray-600 mt-1">
        Show console log
      </button>
    )
  }

  if (!entries) {
    return <div className="text-xs text-gray-400 mt-1">Loading...</div>
  }

  if (entries.length === 0) {
    return <div className="text-xs text-gray-400 mt-1">No console logs for this run.</div>
  }

  return (
    <div className="mt-1">
      <button onClick={() => setShowConsole(false)} className="text-xs text-gray-400 hover:text-gray-600 mb-1">
        Hide console log
      </button>
      <div className="max-h-48 overflow-y-auto bg-gray-900 rounded p-2 font-mono text-xs leading-relaxed">
        {entries.map((e) => (
          <div key={e.seq} className={CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-gray-300'}>
            {e.content}
          </div>
        ))}
      </div>
    </div>
  )
}

function SelfModSection({ roomId, semi }: { roomId: number | null; semi: boolean }): React.JSX.Element {
  const { data: entries, refresh } = usePolling<SelfModAuditEntry[]>(
    () => roomId ? api.selfMod.list(roomId) : Promise.resolve([]),
    10000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 30000)

  const [confirmRevertId, setConfirmRevertId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  async function handleRevert(id: number): Promise<void> {
    await api.selfMod.revert(id)
    setConfirmRevertId(null)
    refresh()
  }

  if (!entries || entries.length === 0) return <></>

  return (
    <div className="mt-4">
      <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide bg-gray-50 border-y border-gray-100">
        Code Modifications
      </div>
      <div className="divide-y divide-gray-100">
        {entries.map(entry => (
          <div key={entry.id} className="px-3 py-2">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-xs font-mono text-gray-700 truncate flex-1">{entry.filePath}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                entry.reverted ? 'bg-gray-100 text-gray-400' : 'bg-green-100 text-green-700'
              }`}>
                {entry.reverted ? 'reverted' : 'active'}
              </span>
              {semi && !entry.reverted && (
                confirmRevertId === entry.id ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleRevert(entry.id)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700 hover:bg-red-200"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmRevertId(null)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 hover:bg-gray-200"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmRevertId(entry.id)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-700 hover:bg-yellow-200 shrink-0"
                  >
                    Revert
                  </button>
                )
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-gray-400">
              <span>{formatRelativeTime(entry.createdAt)}</span>
              {entry.workerId && (
                <span>by {workerMap.get(entry.workerId)?.name ?? `Worker #${entry.workerId}`}</span>
              )}
            </div>
            {entry.reason && (
              <div className="text-xs text-gray-500 mt-0.5">{entry.reason}</div>
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
  const semi = autonomyMode === 'semi'
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [taskNames, setTaskNames] = useState<Record<number, string>>({})
  const { data: runs, error, isLoading } = usePolling(() => api.runs.list(30), 5000)

  useEffect(() => {
    api.tasks.list().then((tasks: Task[]) => {
      const map: Record<number, string> = {}
      for (const t of tasks) map[t.id] = t.name
      setTaskNames(map)
    })
  }, [])

  if (isLoading && !runs) {
    return <div className="p-4 text-xs text-gray-400">Loading...</div>
  }
  if (!runs) {
    return <div className="p-4 text-xs text-red-500">{error ?? 'Failed to load runs.'}</div>
  }

  function renderRun(run: TaskRun, index: number): React.JSX.Element {
    const wideAutoExpand = wide && index < 2
    return (
      <div key={run.id} className={wide ? 'border border-gray-200 rounded-lg overflow-hidden' : ''}>
        <div
          className="px-3 py-2 hover:bg-gray-50 cursor-pointer"
          onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-xs font-medium text-gray-800 truncate">
              {taskNames[run.taskId] ?? `Task #${run.taskId}`}
            </span>
            <span className={`text-xs ${run.status === 'completed' ? 'text-green-600' : run.status === 'running' ? 'text-blue-500' : 'text-red-500'}`}>
              {run.status}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>{formatDateTimeShort(run.startedAt)}</span>
            {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
          </div>
        </div>

        {(wideAutoExpand || expandedId === run.id) && (
          <div className="px-3 pb-2 bg-gray-50">
            {run.errorMessage && (
              <div className="text-xs text-red-500 mb-1 p-1.5 bg-red-50 rounded selectable">{run.errorMessage}</div>
            )}
            {run.result && (
              <div className="text-xs text-gray-600 p-1.5 bg-white rounded max-h-40 overflow-y-auto selectable whitespace-pre-wrap">{run.result}</div>
            )}
            {!run.result && !run.errorMessage && (
              <div className="text-xs text-gray-400 py-1">No output</div>
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
        <div className="px-3 py-2 text-xs text-yellow-700 bg-yellow-50">Temporary refresh issue: {error}</div>
      )}
      {runs.length === 0 ? (
        <div className="p-4 text-center text-xs text-gray-400">No task runs yet.</div>
      ) : wide ? (
        <div className="grid grid-cols-2 gap-3 p-3">
          {runs.map((run: TaskRun, i: number) => renderRun(run, i))}
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {runs.map((run: TaskRun, i: number) => renderRun(run, i))}
        </div>
      )}
      <SelfModSection roomId={roomId ?? null} semi={semi} />
    </div>
  )
}
