import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import type { Worker } from '@shared/types'
import { WORKER_TEMPLATES, type WorkerTemplatePreset } from '@shared/worker-templates'
import { WORKER_ROLE_PRESETS } from '@shared/constants'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'

interface WorkersPanelProps {
  roomId?: number | null
  autonomyMode: 'auto' | 'semi'
}

export function WorkersPanel({ roomId, autonomyMode }: WorkersPanelProps): React.JSX.Element {
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)

  const { data: workers, refresh } = usePolling(
    () => roomId ? api.workers.listForRoom(roomId) : api.workers.list(),
    30000
  )
  const { data: room } = usePolling(
    () => roomId ? api.rooms.get(roomId) : Promise.resolve(null),
    60000
  )
  const workerEvent = useWebSocket('workers')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createRole, setCreateRole] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createPrompt, setCreatePrompt] = useState('')
  const [createCycleGapMs, setCreateCycleGapMs] = useState('')
  const [createMaxTurns, setCreateMaxTurns] = useState('')
  const [createUseDefaultCycleGap, setCreateUseDefaultCycleGap] = useState(true)
  const [createUseDefaultMaxTurns, setCreateUseDefaultMaxTurns] = useState(true)

  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [editCycleGapMs, setEditCycleGapMs] = useState('')
  const [editMaxTurns, setEditMaxTurns] = useState('')
  const [editUseDefaultCycleGap, setEditUseDefaultCycleGap] = useState(true)
  const [editUseDefaultMaxTurns, setEditUseDefaultMaxTurns] = useState(true)

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const roomDefaults = room ? {
    queenCycleGapMs: room.queenCycleGapMs,
    queenMaxTurns: room.queenMaxTurns,
  } : null

  useEffect(() => {
    if (workerEvent) refresh()
  }, [workerEvent, refresh])

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  useEffect(() => {
    if (!showCreate || !roomDefaults) return
    if (createUseDefaultCycleGap) {
      setCreateCycleGapMs(String(roomDefaults.queenCycleGapMs))
    }
    if (createUseDefaultMaxTurns) {
      setCreateMaxTurns(String(roomDefaults.queenMaxTurns))
    }
  }, [
    showCreate,
    roomDefaults?.queenCycleGapMs,
    roomDefaults?.queenMaxTurns,
    createUseDefaultCycleGap,
    createUseDefaultMaxTurns,
  ])

  useEffect(() => {
    if (expandedId === null || !roomDefaults) return
    if (editUseDefaultCycleGap) {
      setEditCycleGapMs(String(roomDefaults.queenCycleGapMs))
    }
    if (editUseDefaultMaxTurns) {
      setEditMaxTurns(String(roomDefaults.queenMaxTurns))
    }
  }, [
    expandedId,
    roomDefaults?.queenCycleGapMs,
    roomDefaults?.queenMaxTurns,
    editUseDefaultCycleGap,
    editUseDefaultMaxTurns,
  ])

  function formatCycleGap(ms: number): string {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
    if (ms % 60_000 === 0) return `${ms / 60_000}m`
    if (ms % 1_000 === 0) return `${ms / 1_000}s`
    return `${ms}ms`
  }

  async function handleCreate(): Promise<void> {
    if (!createName.trim() || !createPrompt.trim()) return
    const role = createRole.trim() || undefined
    const preset = role ? WORKER_ROLE_PRESETS[role.toLowerCase()] : undefined
    const cycleGapMsRaw = createCycleGapMs.trim()
    const maxTurnsRaw = createMaxTurns.trim()
    // Default toggle keeps inheritance (null). Otherwise explicit input/preset sets override.
    const cycleGapMs = (createUseDefaultCycleGap && roomDefaults)
      ? null
      : (cycleGapMsRaw ? Number(cycleGapMsRaw) : (preset?.cycleGapMs ?? null))
    const maxTurns = (createUseDefaultMaxTurns && roomDefaults)
      ? null
      : (maxTurnsRaw ? Number(maxTurnsRaw) : (preset?.maxTurns ?? null))
    await api.workers.create({
      name: createName.trim(),
      role,
      systemPrompt: createPrompt.trim(),
      description: createDesc.trim() || undefined,
      cycleGapMs: cycleGapMs ?? undefined,
      maxTurns: maxTurns ?? undefined,
      roomId: roomId ?? undefined
    })
    setCreateName('')
    setCreateRole('')
    setCreateDesc('')
    setCreatePrompt('')
    setCreateCycleGapMs('')
    setCreateMaxTurns('')
    setCreateUseDefaultCycleGap(true)
    setCreateUseDefaultMaxTurns(true)
    setShowCreate(false)
    refresh()
  }

  function toggleExpand(worker: Worker): void {
    if (expandedId === worker.id) {
      setExpandedId(null)
      setConfirmDeleteId(null)
      return
    }
    setExpandedId(worker.id)
    setConfirmDeleteId(null)
    setEditName(worker.name)
    setEditRole(worker.role ?? '')
    setEditDesc(worker.description ?? '')
    setEditPrompt(worker.systemPrompt)
    const useDefaultCycleGap = worker.cycleGapMs == null
    const useDefaultMaxTurns = worker.maxTurns == null
    setEditUseDefaultCycleGap(useDefaultCycleGap)
    setEditUseDefaultMaxTurns(useDefaultMaxTurns)
    setEditCycleGapMs(useDefaultCycleGap
      ? String(roomDefaults?.queenCycleGapMs ?? '')
      : String(worker.cycleGapMs))
    setEditMaxTurns(useDefaultMaxTurns
      ? String(roomDefaults?.queenMaxTurns ?? '')
      : String(worker.maxTurns))
  }

  async function handleSave(id: number): Promise<void> {
    const cycleGapMsRaw = editCycleGapMs.trim()
    const maxTurnsRaw = editMaxTurns.trim()
    await api.workers.update(id, {
      name: editName.trim(),
      role: editRole.trim() || undefined,
      description: editDesc.trim() || undefined,
      systemPrompt: editPrompt.trim(),
      cycleGapMs: (editUseDefaultCycleGap && roomDefaults) ? null : (cycleGapMsRaw ? Number(cycleGapMsRaw) : null),
      maxTurns: (editUseDefaultMaxTurns && roomDefaults) ? null : (maxTurnsRaw ? Number(maxTurnsRaw) : null)
    })
    refresh()
  }

  async function handleSetDefault(id: number): Promise<void> {
    await api.workers.update(id, { isDefault: true })
    refresh()
  }

  async function handleDelete(id: number): Promise<void> {
    await api.workers.delete(id)
    if (expandedId === id) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  function useTemplate(t: WorkerTemplatePreset): void {
    setCreateName(t.name)
    setCreateRole(t.role)
    setCreateDesc(t.description)
    setCreatePrompt(t.systemPrompt)
    setShowCreate(true)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">Workers</h2>
        <span className="text-xs text-text-muted">
          {workers ? `${workers.length} total` : 'Loading...'}
        </span>
        <button
          onClick={() => guard(() => setShowCreate(!showCreate))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreate ? 'Cancel' : '+ New Worker'}
        </button>
      </div>

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <input type="text" placeholder="Name (e.g. John, Ada)" value={createName} onChange={(e) => setCreateName(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" />
          <input type="text" placeholder="Role (optional, e.g. guardian · analyst · writer · Chief of Staff)" value={createRole} onChange={(e) => setCreateRole(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" />
          {(() => {
            const preset = createRole.trim() ? WORKER_ROLE_PRESETS[createRole.trim().toLowerCase()] : undefined
            return preset ? (
              <div className="text-xs text-text-muted px-1">
                Preset: {[preset.cycleGapMs ? `${preset.cycleGapMs / 1000}s cycle` : '', preset.maxTurns ? `${preset.maxTurns} turns` : ''].filter(Boolean).join(', ')}{roomDefaults ? ' — uncheck "Use room default" to apply preset' : ' — applied unless overridden below'}
              </div>
            ) : null
          })()}
          <div className="grid grid-cols-2 gap-2">
            <div>
              {roomDefaults && (
                <label className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={createUseDefaultCycleGap}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setCreateUseDefaultCycleGap(checked)
                      if (checked) setCreateCycleGapMs(String(roomDefaults.queenCycleGapMs))
                    }}
                  />
                  Use room default
                </label>
              )}
              <input type="number" min={1000} placeholder="Cycle gap ms (optional)" value={createCycleGapMs} onChange={(e) => setCreateCycleGapMs(e.target.value)} disabled={!!roomDefaults && createUseDefaultCycleGap} className="w-full px-2.5 py-1.5 pr-8 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70 disabled:cursor-not-allowed" />
              {roomDefaults && createUseDefaultCycleGap && (
                <div className="px-1 pt-1 text-[11px] text-text-muted">
                  Using room default: {formatCycleGap(roomDefaults.queenCycleGapMs)}
                </div>
              )}
            </div>
            <div>
              {roomDefaults && (
                <label className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={createUseDefaultMaxTurns}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setCreateUseDefaultMaxTurns(checked)
                      if (checked) setCreateMaxTurns(String(roomDefaults.queenMaxTurns))
                    }}
                  />
                  Use room default
                </label>
              )}
              <input type="number" min={1} placeholder="Max turns (optional)" value={createMaxTurns} onChange={(e) => setCreateMaxTurns(e.target.value)} disabled={!!roomDefaults && createUseDefaultMaxTurns} className="w-full px-2.5 py-1.5 pr-8 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70 disabled:cursor-not-allowed" />
              {roomDefaults && createUseDefaultMaxTurns && (
                <div className="px-1 pt-1 text-[11px] text-text-muted">
                  Using room default: {roomDefaults.queenMaxTurns} turns
                </div>
              )}
            </div>
          </div>
          <input type="text" placeholder="Description (optional)" value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" />
          <textarea placeholder="System prompt — defines personality, capabilities, constraints..." value={createPrompt} onChange={(e) => setCreatePrompt(e.target.value)} rows={12} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted font-mono resize-y" />
          <button onClick={handleCreate} disabled={!createName.trim() || !createPrompt.trim()} className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed">
            Create
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {workers && workers.length === 0 && (
          <div className="p-4 text-sm text-text-muted">
            {semi ? 'No workers yet. Create one above or use a template below.' : 'No workers yet. Workers are created by agents.'}
          </div>
        )}
        {workers && workers.length > 0 && (
          <div className="grid gap-2 p-3 md:grid-cols-2">
            {[...workers].sort((a, b) => (room?.queenWorkerId === b.id ? 1 : 0) - (room?.queenWorkerId === a.id ? 1 : 0)).map((worker: Worker) => (
              <div key={worker.id} className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden">
                <div
                  className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => toggleExpand(worker)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {room?.queenWorkerId === worker.id && <span title="Queen" className="text-interactive">♛</span>}
                      <span className="text-sm font-medium text-text-primary truncate">{worker.name}</span>
                      {worker.isDefault && <span className="px-1 py-0.5 rounded-lg text-xs bg-interactive-bg text-interactive">default</span>}
                    </div>
                    <div className="text-sm text-text-muted">
                      {worker.role && <span>{worker.role} &middot; </span>}
                      {worker.taskCount} task(s)
                      {worker.cycleGapMs != null && <span> &middot; {worker.cycleGapMs / 1000}s cycle</span>}
                      {worker.maxTurns != null && <span> &middot; {worker.maxTurns} turns</span>}
                      {worker.description && <span> &middot; {worker.description}</span>}
                    </div>
                  </div>
                  <span className="text-sm text-text-muted ml-2">{expandedId === worker.id ? '\u25BC' : '\u25B6'}</span>
                </div>

                {expandedId === worker.id && (
                  <div className="px-3 pb-3 pt-2 border-t border-border-primary bg-surface-secondary space-y-2">
                    {semi ? (
                      <>
                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" placeholder="Name" />
                        <input type="text" value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" placeholder="Role (optional)" />
                        <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" placeholder="Description" />
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            {roomDefaults && (
                              <label className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={editUseDefaultCycleGap}
                                  onChange={(e) => {
                                    const checked = e.target.checked
                                    setEditUseDefaultCycleGap(checked)
                                    if (checked) setEditCycleGapMs(String(roomDefaults.queenCycleGapMs))
                                  }}
                                />
                                Use room default
                              </label>
                            )}
                            <input type="number" min={1000} placeholder="Cycle gap ms (room default)" value={editCycleGapMs} onChange={(e) => setEditCycleGapMs(e.target.value)} disabled={!!roomDefaults && editUseDefaultCycleGap} className="w-full px-2.5 py-1.5 pr-8 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70 disabled:cursor-not-allowed" />
                            {roomDefaults && editUseDefaultCycleGap && (
                              <div className="px-1 pt-1 text-[11px] text-text-muted">
                                Using room default: {formatCycleGap(roomDefaults.queenCycleGapMs)}
                              </div>
                            )}
                          </div>
                          <div>
                            {roomDefaults && (
                              <label className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={editUseDefaultMaxTurns}
                                  onChange={(e) => {
                                    const checked = e.target.checked
                                    setEditUseDefaultMaxTurns(checked)
                                    if (checked) setEditMaxTurns(String(roomDefaults.queenMaxTurns))
                                  }}
                                />
                                Use room default
                              </label>
                            )}
                            <input type="number" min={1} placeholder="Max turns (room default)" value={editMaxTurns} onChange={(e) => setEditMaxTurns(e.target.value)} disabled={!!roomDefaults && editUseDefaultMaxTurns} className="w-full px-2.5 py-1.5 pr-8 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70 disabled:cursor-not-allowed" />
                            {roomDefaults && editUseDefaultMaxTurns && (
                              <div className="px-1 pt-1 text-[11px] text-text-muted">
                                Using room default: {roomDefaults.queenMaxTurns} turns
                              </div>
                            )}
                          </div>
                        </div>
                        <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={12} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted font-mono resize-y" placeholder="System prompt" />
                        <div className="flex gap-2">
                          <button onClick={() => handleSave(worker.id)} className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover">Save</button>
                          {!worker.isDefault && (
                            <button
                              onClick={() => handleSetDefault(worker.id)}
                              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover"
                            >
                              Set Default
                            </button>
                          )}
                          {confirmDeleteId === worker.id ? (
                            <>
                              <span className="text-sm text-status-error">Sure?</span>
                              <button onClick={() => handleDelete(worker.id)} className="text-sm text-status-error hover:text-red-800 font-medium">Yes, delete</button>
                              <button onClick={() => setConfirmDeleteId(null)} className="text-sm text-text-muted hover:text-text-secondary">Cancel</button>
                            </>
                          ) : (
                            <button onClick={() => setConfirmDeleteId(worker.id)} className="text-sm text-status-error hover:text-red-600">Delete</button>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        {worker.role && (
                          <div className="text-sm text-text-muted">
                            <span className="text-text-muted">Role:</span> {worker.role}
                          </div>
                        )}
                        {worker.description && (
                          <div className="text-sm text-text-muted">
                            <span className="text-text-muted">Description:</span> {worker.description}
                          </div>
                        )}
                        {(worker.cycleGapMs != null || worker.maxTurns != null) && (
                          <div className="text-sm text-text-muted">
                            {worker.cycleGapMs != null && <span>Cycle: {worker.cycleGapMs / 1000}s</span>}
                            {worker.cycleGapMs != null && worker.maxTurns != null && <span> · </span>}
                            {worker.maxTurns != null && <span>Max turns: {worker.maxTurns}</span>}
                          </div>
                        )}
                        <div className="text-sm text-text-muted">System prompt:</div>
                        <pre className="text-xs text-text-secondary bg-surface-primary border border-border-primary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
                          {worker.systemPrompt}
                        </pre>
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={requestSemiMode}
                            className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                          >
                            Edit
                          </button>
                          {!worker.isDefault && (
                            <button
                              onClick={requestSemiMode}
                              className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                            >
                              Set Default
                            </button>
                          )}
                          <button
                            onClick={requestSemiMode}
                            className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="p-4 space-y-2">
          <div className="text-sm text-text-muted font-medium">Templates</div>
          <div className="grid gap-2 md:grid-cols-4">
            {WORKER_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => guard(() => useTemplate(t))}
                className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${modeAwareButtonClass(
                  semi,
                  'border-border-primary hover:border-interactive hover:bg-interactive-bg',
                  'border-border-primary bg-status-info-bg text-status-info hover:bg-surface-hover'
                )}`}
              >
                <div className="text-sm font-medium text-text-primary">{t.name}</div>
                <div className={`text-xs ${semi ? 'text-text-muted' : 'text-status-info'}`}>{t.role}{t.description ? ` · ${t.description}` : ''}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
