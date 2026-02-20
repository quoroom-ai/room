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
    return <div className="p-4 text-xs text-gray-400">Loading...</div>
  }
  if (!watches) {
    return <div className="p-4 text-xs text-red-500">{error ?? 'Failed to load watches.'}</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs text-gray-500">{watches.length} watch(es)</span>
        {semi && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            {showCreateForm ? 'Cancel' : '+ New Watch'}
          </button>
        )}
      </div>

      {semi && showCreateForm && (
        <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
          <input
            type="text"
            value={path}
            onChange={(e) => { setPath(e.target.value); setCreateError(null) }}
            placeholder="Absolute path (e.g. /Users/me/Downloads)"
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
          />
          <textarea
            value={actionPrompt}
            onChange={(e) => setActionPrompt(e.target.value)}
            rows={3}
            placeholder="Action prompt (optional)"
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y"
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-xs text-red-500 truncate">{createError}</span>}
            <div className="flex-1" />
            <button
              onClick={createWatch}
              disabled={!path.trim()}
              className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add Watch
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 text-xs text-yellow-700 bg-yellow-50">
          Temporary refresh issue: {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
        {watches.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-400">
            {semi ? 'No watches yet.' : 'No watches yet. Watches are created by agents.'}
          </div>
        )}
        {watches.map((watch: Watch) => (
          <div key={watch.id} className={`px-3 py-2 ${watch.status === 'paused' ? 'opacity-60' : ''}`}>
            <div className={semi ? 'flex items-center justify-between gap-2' : ''}>
              <div className={`min-w-0${semi ? ' flex-1' : ''}`}>
                <div className="text-xs font-medium text-gray-800 truncate">
                  {watch.path}
                  {watch.status === 'paused' && (
                    <span className="ml-1.5 text-[10px] font-medium text-yellow-700 bg-yellow-100 px-1 py-0.5 rounded">Paused</span>
                  )}
                </div>
                <div className="text-xs text-gray-400">{watch.description ?? 'No description'}</div>
              </div>
              {semi && (
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => togglePause(watch)} className="text-xs text-yellow-600 hover:text-yellow-800">
                    {watch.status === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={() => deleteWatch(watch.id)}
                    onBlur={() => setConfirmDeleteId(null)}
                    className={`text-xs ${confirmDeleteId === watch.id ? 'text-red-600 font-medium' : 'text-red-400 hover:text-red-600'}`}
                  >
                    {confirmDeleteId === watch.id ? 'Confirm?' : 'Delete'}
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-400">
              Triggered {watch.triggerCount} time(s)
              {watch.lastTriggered && <span> &middot; last {formatRelativeTime(watch.lastTriggered)}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
