import { useState } from 'react'
import type { Watch } from '@shared/types'
import { usePolling } from '../hooks/usePolling'
import { formatRelativeTime } from '../utils/time'
import { api } from '../lib/client'

interface WatchesPanelProps {
  roomId?: number | null
  autonomyMode: 'auto' | 'semi'
}

export function WatchesPanel({ roomId, autonomyMode }: WatchesPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'
  const { data: watches, error, isLoading, refresh } = usePolling(() => api.watches.list(roomId ?? undefined), 5000)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  const [actionPrompt, setActionPrompt] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  function validatePath(p: string): string | null {
    const trimmed = p.trim()
    if (!trimmed) return 'Path is required.'
    if (!trimmed.startsWith('/')) return 'Path must be absolute (start with /).'
    return null
  }

  async function createWatch(): Promise<void> {
    const pathError = validatePath(path)
    if (pathError) {
      setCreateError(pathError)
      return
    }
    setCreateError(null)
    try {
      await api.watches.create(path.trim(), description || undefined, actionPrompt || undefined, roomId ?? undefined)
      setPath('')
      setDescription('')
      setActionPrompt('')
      setShowCreateForm(false)
      refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create watch'
      setCreateError(message)
    }
  }

  async function togglePause(watch: Watch): Promise<void> {
    try {
      if (watch.status === 'paused') {
        await api.watches.resume(watch.id)
      } else {
        await api.watches.pause(watch.id)
      }
      refresh()
    } catch {
      // ignore; polling will refresh state
    }
  }

  async function deleteWatch(id: number): Promise<void> {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    setConfirmDeleteId(null)
    try {
      await api.watches.delete(id)
      refresh()
    } catch {
      // ignore; polling will refresh state
    }
  }

  if (isLoading && !watches) {
    return <div className="p-4 text-sm text-text-muted">Loading...</div>
  }
  if (!watches) {
    return <div className="p-4 text-sm text-status-error">{error ?? 'Failed to load watches.'}</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center justify-between">
        <span className="text-sm text-text-muted">{watches.length} watch(es)</span>
        {semi && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium"
          >
            {showCreateForm ? 'Cancel' : '+ New Watch'}
          </button>
        )}
      </div>

      {semi && showCreateForm && (
        <div className="p-4 border-b-2 border-blue-300 bg-interactive-bg/50 space-y-2">
          <input
            type="text"
            value={path}
            onChange={(e) => { setPath(e.target.value); setCreateError(null) }}
            placeholder="Absolute path (e.g. /Users/me/Downloads)"
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-gray-500 bg-surface-primary"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-gray-500 bg-surface-primary"
          />
          <textarea
            value={actionPrompt}
            onChange={(e) => setActionPrompt(e.target.value)}
            rows={3}
            placeholder="Action prompt (optional)"
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-gray-500 bg-surface-primary resize-y"
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-sm text-status-error truncate">{createError}</span>}
            <div className="flex-1" />
            <button
              onClick={createWatch}
              disabled={!path.trim()}
              className="text-sm bg-interactive text-white px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add Watch
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 text-sm text-status-warning bg-status-warning-bg">
          Temporary refresh issue: {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-border-primary">
        {watches.length === 0 && (
          <div className="p-4 text-center text-sm text-text-muted">
            {semi ? 'No watches yet.' : 'No watches yet. Watches are created by agents.'}
          </div>
        )}
        {watches.map((watch: Watch) => (
          <div key={watch.id} className={`px-4 py-2 ${watch.status === 'paused' ? 'opacity-60' : ''}`}>
            <div className={semi ? 'flex items-center justify-between gap-2' : ''}>
              <div className={`min-w-0${semi ? ' flex-1' : ''}`}>
                <div className="text-sm font-medium text-text-primary truncate">
                  {watch.path}
                  {watch.status === 'paused' && (
                    <span className="ml-1.5 text-xs font-medium text-status-warning bg-status-warning-bg px-1 py-0.5 rounded">Paused</span>
                  )}
                </div>
                <div className="text-sm text-text-muted">{watch.description ?? 'No description'}</div>
              </div>
              {semi && (
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => togglePause(watch)} className="text-sm text-status-warning hover:text-yellow-800">
                    {watch.status === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={() => deleteWatch(watch.id)}
                    onBlur={() => setConfirmDeleteId(null)}
                    className={`text-sm ${confirmDeleteId === watch.id ? 'text-red-600 font-medium' : 'text-status-error hover:text-red-600'}`}
                  >
                    {confirmDeleteId === watch.id ? 'Confirm?' : 'Delete'}
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1 text-sm text-text-muted">
              Triggered {watch.triggerCount} time(s)
              {watch.lastTriggered && <span> &middot; last {formatRelativeTime(watch.lastTriggered)}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
