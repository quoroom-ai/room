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
          {rooms.map(room => {
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
