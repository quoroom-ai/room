import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { Goal, GoalUpdate, Worker } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success-bg text-status-success',
  in_progress: 'bg-interactive-bg text-interactive',
  completed: 'bg-status-success-bg text-status-success',
  abandoned: 'bg-surface-tertiary text-text-muted',
  blocked: 'bg-status-error-bg text-status-error',
}

function toPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  const normalized = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, normalized))
}

function buildTree(goals: Goal[]): Array<Goal & { depth: number }> {
  const byParent = new Map<number | null, Goal[]>()
  for (const g of goals) {
    const key = g.parentGoalId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(g)
  }
  const result: Array<Goal & { depth: number }> = []
  function walk(parentId: number | null, depth: number): void {
    for (const g of byParent.get(parentId) ?? []) {
      result.push({ ...g, depth })
      walk(g.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

interface GoalsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function GoalsPanel({ roomId, autonomyMode }: GoalsPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'

  const { data: goals, refresh } = usePolling<Goal[]>(
    () => roomId ? api.goals.list(roomId) : Promise.resolve([]),
    5000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 30000)

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [updatesCache, setUpdatesCache] = useState<Record<number, GoalUpdate[]>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  // Create form
  const [createDesc, setCreateDesc] = useState('')
  const [createParentId, setCreateParentId] = useState<number | ''>('')
  const [createWorkerId, setCreateWorkerId] = useState<number | ''>('')

  // Add update form
  const [updateObs, setUpdateObs] = useState('')
  const [updateMetric, setUpdateMetric] = useState('')

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  async function handleCreate(): Promise<void> {
    if (!createDesc.trim() || roomId === null) return
    await api.goals.create(
      roomId,
      createDesc.trim(),
      createParentId || undefined,
      createWorkerId || undefined
    )
    setCreateDesc('')
    setCreateParentId('')
    setCreateWorkerId('')
    setShowCreate(false)
    refresh()
  }

  async function toggleExpand(goalId: number): Promise<void> {
    if (expandedId === goalId) {
      setExpandedId(null)
      return
    }
    setExpandedId(goalId)
    if (!updatesCache[goalId]) {
      const updates = await api.goals.getUpdates(goalId, 20)
      setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
    }
  }

  async function handleAddUpdate(goalId: number): Promise<void> {
    if (!updateObs.trim()) return
    const rawMetric = updateMetric ? Number(updateMetric) : undefined
    const metricValue = rawMetric != null && Number.isFinite(rawMetric)
      ? (rawMetric > 1 ? rawMetric / 100 : rawMetric)
      : undefined
    await api.goals.addUpdate(goalId, updateObs.trim(), metricValue)
    setUpdateObs('')
    setUpdateMetric('')
    const updates = await api.goals.getUpdates(goalId, 20)
    setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
    refresh()
  }

  async function handleStatusChange(goalId: number, status: string): Promise<void> {
    await api.goals.update(goalId, { status })
    refresh()
  }

  async function handleDelete(goalId: number): Promise<void> {
    if (confirmDeleteId !== goalId) {
      setConfirmDeleteId(goalId)
      return
    }
    await api.goals.delete(goalId)
    if (expandedId === goalId) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  const tree = goals ? buildTree(goals) : []
  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">
            {goals ? `${goals.length} goal(s)` : 'Loading...'}
          </span>
          {!roomId && (
            <span className="text-sm text-text-muted">Select a room</span>
          )}
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Goal'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <textarea
            placeholder="Goal description..."
            value={createDesc}
            onChange={(e) => setCreateDesc(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted resize-y"
          />
          <div className="flex gap-2">
            <Select
              value={String(createParentId)}
              onChange={(v) => setCreateParentId(v ? Number(v) : '')}
              className="flex-1"
              placeholder="No parent (top-level)"
              options={[
                { value: '', label: 'No parent (top-level)' },
                ...(goals ?? []).map(g => ({ value: String(g.id), label: g.description.slice(0, 60) }))
              ]}
            />
            <Select
              value={String(createWorkerId)}
              onChange={(v) => setCreateWorkerId(v ? Number(v) : '')}
              className="flex-1"
              placeholder="Unassigned"
              options={[
                { value: '', label: 'Unassigned' },
                ...(workers ?? []).map(w => ({ value: String(w.id), label: w.name }))
              ]}
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={!createDesc.trim()}
            className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create Goal
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">Select a room to view goals.</div>
        ) : tree.length === 0 && goals ? (
          <div className="p-4 text-sm text-text-muted">No goals yet.{semi ? ' Create one to get started.' : ' Goals are created by agents.'}</div>
        ) : (
          <div className="divide-y divide-border-primary">
            {tree.map(goal => {
              const progressPct = toPercent(goal.progress)
              return (
                <div key={goal.id}>
                  <div
                    className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
                    style={{ paddingLeft: `${12 + Math.min(goal.depth, 5) * 16}px` }}
                    onClick={() => toggleExpand(goal.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text-primary">{goal.description}</span>
                        <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium shrink-0 ${STATUS_COLORS[goal.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                          {goal.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 bg-surface-tertiary rounded-full max-w-[120px]">
                          <div
                            className="h-full bg-interactive rounded-full transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                        <span className="text-xs text-text-muted">{Math.round(progressPct)}%</span>
                        {goal.assignedWorkerId && workerMap.has(goal.assignedWorkerId) && (
                          <span className="text-xs text-text-muted">
                            {workerMap.get(goal.assignedWorkerId)!.name}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm text-text-muted">{expandedId === goal.id ? '\u25BC' : '\u25B6'}</span>
                  </div>

                  {expandedId === goal.id && (
                    <div className="px-3 pb-3 bg-surface-secondary space-y-2" style={{ paddingLeft: `${12 + Math.min(goal.depth, 5) * 16}px` }}>
                      {/* Status actions */}
                      {semi && (
                        <div className="flex gap-2 flex-wrap">
                          {goal.status !== 'completed' && (
                            <button onClick={() => handleStatusChange(goal.id, 'completed')} className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-emerald-200 text-status-success hover:bg-emerald-50">
                              Complete
                            </button>
                          )}
                          {goal.status !== 'in_progress' && goal.status !== 'completed' && (
                            <button onClick={() => handleStatusChange(goal.id, 'in_progress')} className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-interactive text-interactive hover:bg-interactive-bg">
                              Start
                            </button>
                          )}
                          {goal.status !== 'blocked' && goal.status !== 'completed' && (
                            <button onClick={() => handleStatusChange(goal.id, 'blocked')} className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-red-200 text-status-error hover:bg-red-50">
                              Block
                            </button>
                          )}
                          {goal.status !== 'abandoned' && (
                            <button onClick={() => handleStatusChange(goal.id, 'abandoned')} className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-border-primary text-text-muted hover:bg-surface-hover">
                              Abandon
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(goal.id)}
                            onBlur={() => setConfirmDeleteId(null)}
                            className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-red-200 text-status-error hover:text-red-600"
                          >
                            {confirmDeleteId === goal.id ? 'Confirm?' : 'Delete'}
                          </button>
                        </div>
                      )}

                      {/* Add update */}
                      {semi && (
                        <div className="flex gap-2">
                          <input
                            value={updateObs}
                            onChange={(e) => setUpdateObs(e.target.value)}
                            placeholder="Log an update..."
                            className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
                          />
                          <input
                            value={updateMetric}
                            onChange={(e) => setUpdateMetric(e.target.value)}
                            placeholder="%"
                            className="w-12 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted text-center"
                          />
                          <button
                            onClick={() => handleAddUpdate(goal.id)}
                            disabled={!updateObs.trim()}
                            className="text-sm bg-interactive text-text-invert px-2.5 py-1.5 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
                          >
                            Log
                          </button>
                        </div>
                      )}

                      {/* Updates history */}
                      {updatesCache[goal.id] && updatesCache[goal.id].length > 0 ? (
                        <div className={`space-y-2${semi ? ' pt-1 border-t border-border-primary' : ''}`}>
                          <div className="text-xs font-medium text-text-muted">Updates</div>
                          {updatesCache[goal.id].map(u => (
                            <div key={u.id} className="text-sm text-text-muted flex gap-2">
                              <span className="text-text-muted shrink-0">{formatRelativeTime(u.createdAt)}</span>
                              <span>{u.observation}</span>
                              {u.metricValue !== null && u.metricValue !== undefined && (
                                <span className="text-interactive shrink-0">{Math.round(toPercent(u.metricValue))}%</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-text-muted">No updates yet</div>
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
