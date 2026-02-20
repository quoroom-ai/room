import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { Goal, GoalUpdate, Worker } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  abandoned: 'bg-gray-100 text-gray-500',
  blocked: 'bg-red-100 text-red-700',
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
    await api.goals.addUpdate(goalId, updateObs.trim(), updateMetric ? Number(updateMetric) : undefined)
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
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {goals ? `${goals.length} goal(s)` : 'Loading...'}
          </span>
          {!roomId && (
            <span className="text-xs text-gray-400">Select a room</span>
          )}
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Goal'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
          <textarea
            placeholder="Goal description..."
            value={createDesc}
            onChange={(e) => setCreateDesc(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y"
          />
          <div className="flex gap-2">
            <select
              value={createParentId}
              onChange={(e) => setCreateParentId(e.target.value ? Number(e.target.value) : '')}
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
            >
              <option value="">No parent (top-level)</option>
              {(goals ?? []).map(g => <option key={g.id} value={g.id}>{g.description.slice(0, 60)}</option>)}
            </select>
            <select
              value={createWorkerId}
              onChange={(e) => setCreateWorkerId(e.target.value ? Number(e.target.value) : '')}
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
            >
              <option value="">Unassigned</option>
              {(workers ?? []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <button
            onClick={handleCreate}
            disabled={!createDesc.trim()}
            className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create Goal
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-xs text-gray-400">Select a room to view goals.</div>
        ) : tree.length === 0 && goals ? (
          <div className="p-4 text-xs text-gray-400">No goals yet.{semi ? ' Create one to get started.' : ' Goals are created by agents.'}</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {tree.map(goal => (
              <div key={goal.id}>
                <div
                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                  style={{ paddingLeft: `${12 + Math.min(goal.depth, 5) * 16}px` }}
                  onClick={() => toggleExpand(goal.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-800">{goal.description}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${STATUS_COLORS[goal.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {goal.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1.5 bg-gray-200 rounded-full max-w-[120px]">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${goal.progress}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-400">{goal.progress}%</span>
                      {goal.assignedWorkerId && workerMap.has(goal.assignedWorkerId) && (
                        <span className="text-[10px] text-gray-400">
                          {workerMap.get(goal.assignedWorkerId)!.name}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-gray-300">{expandedId === goal.id ? '\u25BC' : '\u25B6'}</span>
                </div>

                {expandedId === goal.id && (
                  <div className="px-3 pb-3 bg-gray-50 space-y-2" style={{ paddingLeft: `${12 + Math.min(goal.depth, 5) * 16}px` }}>
                    {/* Status actions */}
                    {semi && (
                      <div className="flex gap-1.5 flex-wrap">
                        {goal.status !== 'completed' && (
                          <button onClick={() => handleStatusChange(goal.id, 'completed')} className="text-[10px] px-2 py-0.5 rounded border border-emerald-200 text-emerald-600 hover:bg-emerald-50">
                            Complete
                          </button>
                        )}
                        {goal.status !== 'in_progress' && goal.status !== 'completed' && (
                          <button onClick={() => handleStatusChange(goal.id, 'in_progress')} className="text-[10px] px-2 py-0.5 rounded border border-blue-200 text-blue-600 hover:bg-blue-50">
                            Start
                          </button>
                        )}
                        {goal.status !== 'blocked' && goal.status !== 'completed' && (
                          <button onClick={() => handleStatusChange(goal.id, 'blocked')} className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50">
                            Block
                          </button>
                        )}
                        {goal.status !== 'abandoned' && (
                          <button onClick={() => handleStatusChange(goal.id, 'abandoned')} className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100">
                            Abandon
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(goal.id)}
                          onBlur={() => setConfirmDeleteId(null)}
                          className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-400 hover:text-red-600"
                        >
                          {confirmDeleteId === goal.id ? 'Confirm?' : 'Delete'}
                        </button>
                      </div>
                    )}

                    {/* Add update */}
                    {semi && (
                      <div className="flex gap-1.5">
                        <input
                          value={updateObs}
                          onChange={(e) => setUpdateObs(e.target.value)}
                          placeholder="Log an update..."
                          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
                        />
                        <input
                          value={updateMetric}
                          onChange={(e) => setUpdateMetric(e.target.value)}
                          placeholder="%"
                          className="w-12 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white text-center"
                        />
                        <button
                          onClick={() => handleAddUpdate(goal.id)}
                          disabled={!updateObs.trim()}
                          className="text-xs bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 disabled:opacity-50"
                        >
                          Log
                        </button>
                      </div>
                    )}

                    {/* Updates history */}
                    {updatesCache[goal.id] && updatesCache[goal.id].length > 0 ? (
                      <div className={`space-y-1${semi ? ' pt-1 border-t border-gray-200' : ''}`}>
                        <div className="text-[10px] font-medium text-gray-500">Updates</div>
                        {updatesCache[goal.id].map(u => (
                          <div key={u.id} className="text-xs text-gray-500 flex gap-2">
                            <span className="text-gray-300 shrink-0">{formatRelativeTime(u.createdAt)}</span>
                            <span>{u.observation}</span>
                            {u.metricValue !== null && u.metricValue !== undefined && (
                              <span className="text-blue-500 shrink-0">{u.metricValue}%</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-400">No updates yet</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
