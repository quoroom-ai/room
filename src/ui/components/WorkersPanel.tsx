import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import type { Worker } from '@shared/types'
import { WORKER_TEMPLATES, type WorkerTemplatePreset } from '@shared/worker-templates'
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
  const workerEvent = useWebSocket('workers')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createRole, setCreateRole] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createPrompt, setCreatePrompt] = useState('')

  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPrompt, setEditPrompt] = useState('')

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  useEffect(() => {
    if (workerEvent) refresh()
  }, [workerEvent, refresh])

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  async function handleCreate(): Promise<void> {
    if (!createName.trim() || !createPrompt.trim()) return
    await api.workers.create({
      name: createName.trim(),
      role: createRole.trim() || undefined,
      systemPrompt: createPrompt.trim(),
      description: createDesc.trim() || undefined,
      roomId: roomId ?? undefined
    })
    setCreateName('')
    setCreateRole('')
    setCreateDesc('')
    setCreatePrompt('')
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
  }

  async function handleSave(id: number): Promise<void> {
    await api.workers.update(id, {
      name: editName.trim(),
      role: editRole.trim() || undefined,
      description: editDesc.trim() || undefined,
      systemPrompt: editPrompt.trim()
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
          <input type="text" placeholder="Role (optional, e.g. Chief of Staff)" value={createRole} onChange={(e) => setCreateRole(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted" />
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
          <div className="grid gap-2 p-3 md:grid-cols-4">
            {workers.map((worker: Worker) => (
              <div key={worker.id} className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden">
                <div
                  className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => toggleExpand(worker)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary truncate">{worker.name}</span>
                      {worker.isDefault && <span className="px-1 py-0.5 rounded-lg text-xs bg-interactive-bg text-interactive">default</span>}
                    </div>
                    <div className="text-sm text-text-muted">
                      {worker.role && <span>{worker.role} &middot; </span>}
                      {worker.taskCount} task(s)
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
                <div className="text-sm font-medium">{t.name} <span className="font-normal">— {t.role}</span></div>
                <div className={semi ? 'text-sm text-text-muted' : 'text-sm text-status-info'}>{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
