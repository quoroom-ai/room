import { useState, useEffect, useRef, useCallback } from 'react'
import { useDocumentVisible } from '../hooks/useDocumentVisible'
import { api } from '../lib/client'
import type { TaskRun, ConsoleLogEntry } from '@shared/types'

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-console-muted',
  result: 'text-blue-400',
  error: 'text-red-400'
}

const POLL_INTERVAL_MS = 2000
const MAX_ENTRIES_PER_RUN = 200

interface LiveConsoleSectionProps {
  runningRuns: TaskRun[]
  taskNames: Record<number, string>
}

export function LiveConsoleSection({
  runningRuns,
  taskNames
}: LiveConsoleSectionProps): React.JSX.Element {
  const isVisible = useDocumentVisible()
  const [logsByRunId, setLogsByRunId] = useState<Map<number, ConsoleLogEntry[]>>(new Map())
  const lastSeqByRunId = useRef<Map<number, number>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const runningRunsRef = useRef(runningRuns)
  runningRunsRef.current = runningRuns

  const runIdsKey = runningRuns.map((r) => r.id).sort().join(',')

  useEffect(() => {
    if (!isVisible || runningRuns.length === 0) return

    let mounted = true

    async function poll(): Promise<void> {
      if (!mounted) return
      const runs = runningRunsRef.current
      const updates = new Map<number, ConsoleLogEntry[]>()

      await Promise.all(
        runs.map(async (run) => {
          try {
            const afterSeq = lastSeqByRunId.current.get(run.id) ?? 0
            const newEntries = await api.runs.getLogs(run.id, afterSeq, 50)
            if (newEntries.length > 0) {
              lastSeqByRunId.current.set(run.id, newEntries[newEntries.length - 1].seq)
              updates.set(run.id, newEntries)
            }
          } catch {
            // non-fatal
          }
        })
      )

      if (!mounted || updates.size === 0) return

      setLogsByRunId((prev) => {
        const next = new Map(prev)
        for (const [runId, newEntries] of updates) {
          const existing = next.get(runId) ?? []
          const combined = [...existing, ...newEntries].slice(-MAX_ENTRIES_PER_RUN)
          next.set(runId, combined)
        }
        return next
      })
    }

    poll()
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [isVisible, runIdsKey])

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logsByRunId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    autoScrollRef.current = atBottom
  }, [])

  return (
    <div className="bg-surface-secondary rounded-lg overflow-hidden flex-1 flex flex-col min-h-0 shadow-sm">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden bg-console-bg m-3 rounded-lg p-3 font-mono text-sm leading-relaxed min-h-[4rem]"
      >
        {runningRuns.length === 0 ? (
          <div className="text-console-muted">No tasks running</div>
        ) : (
          runningRuns.map((run) => {
            const entries = logsByRunId.get(run.id) ?? []
            const taskName = taskNames[run.taskId] ?? `Task #${run.taskId}`
            return (
              <div key={run.id} className="mb-2 last:mb-0">
                {runningRuns.length > 1 && (
                  <div className="text-blue-400 font-semibold mb-0.5 sticky top-0 bg-console-bg py-0.5">
                    {taskName}
                  </div>
                )}
                {entries.length === 0 ? (
                  <div className="text-console-muted">Waiting for output...</div>
                ) : (
                  entries.map((e) => (
                    <div
                      key={`${run.id}-${e.seq}`}
                      className={`${CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-console-text'} whitespace-pre-wrap break-words`}
                    >
                      {e.content}
                    </div>
                  ))
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
