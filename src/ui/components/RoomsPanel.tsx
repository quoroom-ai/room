import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { Room, Wallet } from '@shared/types'
import { ROOM_TEMPLATES } from '@shared/room-templates'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  stopped: 'bg-gray-100 text-gray-500',
}

interface RoomsPanelProps {
  selectedRoomId: number | null
  onSelectRoom: (roomId: number | null) => void
}

export function RoomsPanel({ selectedRoomId, onSelectRoom }: RoomsPanelProps): React.JSX.Element {
  const { data: rooms, refresh } = usePolling<Room[]>(() => api.rooms.list(), 10000)
  const { data: wallets } = usePolling<Record<number, Wallet>>(async () => {
    if (!rooms || rooms.length === 0) return {}
    const entries = await Promise.all(
      rooms.map(async r => {
        const w = await api.wallet.get(r.id).catch(() => null)
        return [r.id, w] as const
      })
    )
    return Object.fromEntries(entries.filter(([, w]) => w !== null))
  }, 30000)
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  usePolling(async () => {
    if (!rooms || rooms.length === 0) return {}
    const entries = await Promise.all(
      rooms.map(async r => {
        const q = await api.rooms.queenStatus(r.id).catch(() => null)
        return [r.id, q?.running ?? false] as const
      })
    )
    setQueenRunning(Object.fromEntries(entries))
    return {}
  }, 5000)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const isWide = containerWidth > 500

  // Optimistic state: immediate UI overrides before the next API poll confirms
  const [roomOverrides, setRoomOverrides] = useState<Record<number, Partial<Room>>>({})

  function optimistic(id: number, patch: Partial<Room>): void {
    setRoomOverrides(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createGoal, setCreateGoal] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)

  // Inline editing
  const [editingGoalId, setEditingGoalId] = useState<number | null>(null)
  const [editGoalText, setEditGoalText] = useState('')

  // Confirm actions
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [confirmStopId, setConfirmStopId] = useState<number | null>(null)

  async function handleCreate(): Promise<void> {
    if (!createName.trim()) return
    await api.rooms.create({ name: createName.trim(), goal: createGoal.trim() || undefined })
    setCreateName('')
    setCreateGoal('')
    setShowCreate(false)
    refresh()
  }

  async function handleSaveGoal(roomId: number): Promise<void> {
    await api.rooms.update(roomId, { goal: editGoalText.trim() || null })
    setEditingGoalId(null)
    refresh()
  }

  async function handlePause(roomId: number): Promise<void> {
    if (confirmStopId !== roomId) {
      setConfirmStopId(roomId)
      return
    }
    await api.rooms.pause(roomId)
    setConfirmStopId(null)
    refresh()
  }

  async function handleRestart(roomId: number): Promise<void> {
    await api.rooms.restart(roomId)
    refresh()
  }

  async function handleDelete(roomId: number): Promise<void> {
    if (confirmDeleteId !== roomId) {
      setConfirmDeleteId(roomId)
      return
    }
    await api.rooms.delete(roomId)
    setConfirmDeleteId(null)
    if (selectedRoomId === roomId) onSelectRoom(null)
    refresh()
  }

  async function handleToggleVisibility(room: Room): Promise<void> {
    const next = room.visibility === 'public' ? 'private' : 'public'
    optimistic(room.id, { visibility: next })
    await api.rooms.update(room.id, { visibility: next })
    refresh()
  }

  async function handleSetAutonomy(room: Room, mode: 'auto' | 'semi'): Promise<void> {
    optimistic(room.id, { autonomyMode: mode })
    try {
      await api.rooms.update(room.id, { autonomyMode: mode })
      refresh()
    } catch (e) {
      console.error('Failed to update autonomy mode:', e)
      optimistic(room.id, { autonomyMode: room.autonomyMode }) // revert
    }
  }

  async function handleChangeMaxTasks(room: Room, delta: number): Promise<void> {
    const next = Math.max(1, Math.min(10, room.maxConcurrentTasks + delta))
    if (next === room.maxConcurrentTasks) return
    optimistic(room.id, { maxConcurrentTasks: next })
    await api.rooms.update(room.id, { maxConcurrentTasks: next })
    refresh()
  }

  async function handleSetWorkerModel(room: Room, useOllama: boolean): Promise<void> {
    const workerModel = useOllama ? 'ollama:llama3.2' : 'claude'
    optimistic(room.id, { workerModel })
    try {
      await api.rooms.update(room.id, { workerModel })
      refresh()
    } catch (e) {
      console.error('Failed to update worker model:', e)
      optimistic(room.id, { workerModel: room.workerModel }) // revert
    }
  }

  async function handleSetCycleGap(room: Room, ms: number): Promise<void> {
    optimistic(room.id, { queenCycleGapMs: ms })
    await api.rooms.update(room.id, { queenCycleGapMs: ms })
    refresh()
  }

  async function handleSetMaxTurns(room: Room, delta: number): Promise<void> {
    const next = Math.max(1, Math.min(50, room.queenMaxTurns + delta))
    if (next === room.queenMaxTurns) return
    optimistic(room.id, { queenMaxTurns: next })
    await api.rooms.update(room.id, { queenMaxTurns: next })
    refresh()
  }

  async function handleSetQuietHours(room: Room, from: string, until: string): Promise<void> {
    if (!from || !until) {
      optimistic(room.id, { queenQuietFrom: null, queenQuietUntil: null })
      await api.rooms.update(room.id, { queenQuietFrom: null, queenQuietUntil: null })
    } else {
      optimistic(room.id, { queenQuietFrom: from, queenQuietUntil: until })
      await api.rooms.update(room.id, { queenQuietFrom: from, queenQuietUntil: until })
    }
    refresh()
  }

  async function handleQueenStart(roomId: number): Promise<void> {
    await api.rooms.queenStart(roomId)
    setQueenRunning(prev => ({ ...prev, [roomId]: true }))
  }

  async function handleQueenStop(roomId: number): Promise<void> {
    await api.rooms.queenStop(roomId)
    setQueenRunning(prev => ({ ...prev, [roomId]: false }))
  }

  return (
    <div ref={containerRef} className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-700">Rooms</h3>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          {showCreate ? 'Cancel' : '+ New Room'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-gray-50 rounded-lg p-3 space-y-2">
          <select
            value={selectedTemplate ?? ''}
            onChange={(e) => {
              const id = e.target.value || null
              setSelectedTemplate(id)
              const tpl = ROOM_TEMPLATES.find(t => t.id === id)
              if (tpl) {
                setCreateName(tpl.name)
                setCreateGoal(tpl.goal)
              } else {
                setCreateName('')
                setCreateGoal('')
              }
            }}
            className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs text-gray-600"
          >
            <option value="">Custom room...</option>
            {ROOM_TEMPLATES.map(t => (
              <option key={t.id} value={t.id}>{t.name} — {t.description.slice(0, 60)}</option>
            ))}
          </select>
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Room name..."
            className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs text-gray-700"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <input
            value={createGoal}
            onChange={(e) => setCreateGoal(e.target.value)}
            placeholder="Goal (optional)..."
            className="w-full bg-white border border-gray-200 rounded px-2 py-1 text-xs text-gray-400"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={!createName.trim()}
            className="text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      )}

      {/* Room list */}
      {!rooms || rooms.length === 0 ? (
        <p className="text-xs text-gray-400 py-4 text-center">No rooms yet. Create one to get started.</p>
      ) : (
        <div className={isWide ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
          {rooms.map(rawRoom => {
            const room = { ...rawRoom, ...roomOverrides[rawRoom.id] }
            const isSelected = selectedRoomId === room.id
            return (
              <div
                key={room.id}
                className={`rounded-lg p-3 border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-blue-300 bg-blue-50'
                    : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}
                onClick={() => onSelectRoom(isSelected ? null : room.id)}
              >
                {/* Room header */}
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-700 truncate">{room.name}</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      title={queenRunning[room.id] ? 'Queen running' : 'Queen stopped'}
                      className={`w-1.5 h-1.5 rounded-full ${queenRunning[room.id] ? 'bg-green-400' : 'bg-gray-300'}`}
                    />
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[room.status] || 'bg-gray-100 text-gray-500'}`}>
                      {room.status}
                    </span>
                  </div>
                </div>

                {/* Goal */}
                <div className="text-xs mb-2" onClick={(e) => e.stopPropagation()}>
                  <span className="text-gray-500">Goal: </span>
                  {editingGoalId === room.id ? (
                    <div className="mt-1 flex gap-1">
                      <input
                        value={editGoalText}
                        onChange={(e) => setEditGoalText(e.target.value)}
                        className="flex-1 bg-white border border-gray-200 rounded px-1.5 py-0.5 text-xs text-gray-600"
                        placeholder="Set room goal..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveGoal(room.id)
                          if (e.key === 'Escape') setEditingGoalId(null)
                        }}
                        autoFocus
                      />
                      <button onClick={() => handleSaveGoal(room.id)} className="text-blue-500 hover:text-blue-700 text-xs">Save</button>
                      <button onClick={() => setEditingGoalId(null)} className="text-gray-400 hover:text-gray-600 text-xs">Cancel</button>
                    </div>
                  ) : (
                    <span
                      className="text-gray-400 cursor-pointer hover:text-gray-600"
                      onClick={() => { setEditingGoalId(room.id); setEditGoalText(room.goal || '') }}
                    >
                      {room.goal || 'Click to set...'}
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div className="text-[10px] text-gray-400 mb-2">
                  Created {formatRelativeTime(room.createdAt)}
                  {wallets?.[room.id] && (
                    <span className="ml-2 font-mono text-gray-500" title={wallets[room.id].address}>
                      {wallets[room.id].chain} {wallets[room.id].address.slice(0, 6)}...{wallets[room.id].address.slice(-4)}
                    </span>
                  )}
                </div>

                {/* Room settings */}
                <div className="mb-2 pt-2 border-t border-gray-200 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                  {/* Public toggle */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Public</span>
                    <button
                      onClick={() => handleToggleVisibility(room)}
                      className={`w-7 h-3.5 rounded-full relative transition-colors ${
                        room.visibility === 'public' ? 'bg-green-500' : 'bg-gray-300'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform ${
                        room.visibility === 'public' ? 'left-3.5' : 'left-0.5'
                      }`} />
                    </button>
                  </div>

                  {/* Autonomy mode */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Control</span>
                    <div className="flex rounded overflow-hidden border border-gray-200">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSetAutonomy(room, 'auto') }}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          room.autonomyMode === 'auto'
                            ? 'bg-amber-500 text-white'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >Auto</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSetAutonomy(room, 'semi') }}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          room.autonomyMode === 'semi'
                            ? 'bg-blue-500 text-white'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >Semi</button>
                    </div>
                  </div>

                  {/* Queen sessions */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Queen sessions</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleChangeMaxTasks(room, -1)}
                        disabled={room.maxConcurrentTasks <= 1}
                        className="w-4 h-4 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-[10px] font-medium text-gray-600"
                      >-</button>
                      <span className="w-4 text-center text-xs tabular-nums">{room.maxConcurrentTasks}</span>
                      <button
                        onClick={() => handleChangeMaxTasks(room, 1)}
                        disabled={room.maxConcurrentTasks >= 10}
                        className="w-4 h-4 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-[10px] font-medium text-gray-600"
                      >+</button>
                    </div>
                  </div>

                  {/* Cycle gap */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Cycle gap</span>
                    <select
                      value={room.queenCycleGapMs}
                      onChange={(e) => handleSetCycleGap(room, Number(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-600"
                    >
                      <option value={10000}>10s</option>
                      <option value={30000}>30s</option>
                      <option value={60000}>1 min</option>
                      <option value={300000}>5 min</option>
                      <option value={900000}>15 min</option>
                      <option value={1800000}>30 min</option>
                      <option value={3600000}>1 hr</option>
                      <option value={7200000}>2 hr</option>
                    </select>
                  </div>

                  {/* Max turns */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Max turns</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleSetMaxTurns(room, -1)}
                        disabled={room.queenMaxTurns <= 1}
                        className="w-4 h-4 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-[10px] font-medium text-gray-600"
                      >-</button>
                      <span className="w-5 text-center text-xs tabular-nums">{room.queenMaxTurns}</span>
                      <button
                        onClick={() => handleSetMaxTurns(room, 1)}
                        disabled={room.queenMaxTurns >= 50}
                        className="w-4 h-4 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-[10px] font-medium text-gray-600"
                      >+</button>
                    </div>
                  </div>

                  {/* Quiet hours */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Quiet hours</span>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="time"
                        value={room.queenQuietFrom ?? ''}
                        onChange={(e) => handleSetQuietHours(room, e.target.value, room.queenQuietUntil ?? '')}
                        className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-600 w-20"
                      />
                      <span className="text-gray-400">–</span>
                      <input
                        type="time"
                        value={room.queenQuietUntil ?? ''}
                        onChange={(e) => handleSetQuietHours(room, room.queenQuietFrom ?? '', e.target.value)}
                        className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white text-gray-600 w-20"
                      />
                    </div>
                  </div>

                  {/* Worker model */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Workers use</span>
                    <div className="flex rounded overflow-hidden border border-gray-200">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSetWorkerModel(room, false) }}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          !(room.workerModel ?? 'claude').startsWith('ollama:')
                            ? 'bg-blue-500 text-white'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >Claude</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSetWorkerModel(room, true) }}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          (room.workerModel ?? 'claude').startsWith('ollama:')
                            ? 'bg-green-500 text-white'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >Ollama</button>
                    </div>
                  </div>
                  {(room.workerModel ?? 'claude').startsWith('ollama:') && (
                    <p className="text-[10px] text-green-600 leading-tight">
                      Free local LLM — model: {room.workerModel.replace('ollama:', '')}. Requires Ollama running locally.
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {room.status === 'active' ? (
                    <>
                      {queenRunning[room.id] ? (
                        <button
                          onClick={() => handleQueenStop(room.id)}
                          className="text-xs px-2 py-0.5 rounded border text-orange-600 border-orange-200 hover:border-orange-300 transition-colors"
                        >
                          Stop Queen
                        </button>
                      ) : (
                        <button
                          onClick={() => handleQueenStart(room.id)}
                          className="text-xs px-2 py-0.5 rounded border text-green-600 border-green-200 hover:border-green-300 transition-colors"
                        >
                          Start Queen
                        </button>
                      )}
                      <button
                        onClick={() => handlePause(room.id)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                          confirmStopId === room.id
                            ? 'text-red-600 border-red-300 bg-red-50 hover:bg-red-100'
                            : 'text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                        }`}
                      >
                        {confirmStopId === room.id ? 'Confirm Pause' : 'Pause'}
                      </button>
                    </>
                  ) : room.status === 'paused' ? (
                    <button
                      onClick={() => handleRestart(room.id)}
                      className="text-xs px-2 py-0.5 rounded border text-blue-600 border-blue-200 hover:border-blue-300 transition-colors"
                    >
                      Restart
                    </button>
                  ) : null}

                  <button
                    onClick={() => handleDelete(room.id)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                      confirmDeleteId === room.id
                        ? 'text-red-600 border-red-300 bg-red-50 hover:bg-red-100'
                        : 'text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                    }`}
                  >
                    {confirmDeleteId === room.id ? 'Confirm Delete' : 'Delete'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
