import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { ROOMS_QUEEN_STATE_EVENT, ROOMS_UPDATE_EVENT } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { Room, Wallet } from '@shared/types'
import { ROOM_TEMPLATES } from '@shared/room-templates'
import { CopyAddressButton } from './CopyAddressButton'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success-bg text-status-success',
  paused: 'bg-status-warning-bg text-status-warning',
  stopped: 'bg-surface-tertiary text-text-muted',
}

interface RoomsPanelProps {
  selectedRoomId: number | null
  onSelectRoom: (roomId: number | null) => void
}

export function RoomsPanel({ selectedRoomId, onSelectRoom }: RoomsPanelProps): React.JSX.Element {
  const { data: rooms, refresh } = usePolling<Room[]>(() => api.rooms.list(), 60000)
  const { data: wallets, refresh: refreshWallets } = usePolling<Record<number, Wallet>>(async () => {
    if (!rooms || rooms.length === 0) return {}
    const entries = await Promise.all(
      rooms.map(async r => {
        const w = await api.wallet.get(r.id).catch(() => null)
        return [r.id, w] as const
      })
    )
    return Object.fromEntries(entries.filter(([, w]) => w !== null))
  }, 120000)
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const { refresh: refreshQueenRunning } = usePolling(async () => {
    const states = await api.rooms.queenStates().catch(() => ({}))
    setQueenRunning(states)
    return states
  }, 60000)

  useEffect(() => {
    const unsubscribe = wsClient.subscribe('rooms', (event: WsMessage) => {
      if (event.type === ROOMS_QUEEN_STATE_EVENT) {
        const payload = event.data as { roomId?: number; running?: boolean }
        if (typeof payload.roomId === 'number' && typeof payload.running === 'boolean') {
          setQueenRunning(prev => ({ ...prev, [payload.roomId]: payload.running }))
          return
        }
      }
      if (event.type === ROOMS_UPDATE_EVENT) {
        void refresh()
        void refreshWallets()
        void refreshQueenRunning()
      }
    })
    return unsubscribe
  }, [refresh, refreshQueenRunning, refreshWallets])
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

  async function handleStop(roomId: number): Promise<void> {
    if (confirmStopId !== roomId) {
      setConfirmStopId(roomId)
      return
    }
    await api.rooms.stop(roomId)
    setConfirmStopId(null)
    setQueenRunning(prev => ({ ...prev, [roomId]: false }))
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

  async function handleRoomStart(roomId: number): Promise<void> {
    await api.rooms.start(roomId)
    setQueenRunning(prev => ({ ...prev, [roomId]: true }))
  }

  return (
    <div ref={containerRef} className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">Rooms</h2>
        <span className="text-xs text-text-muted">{rooms ? `${rooms.length} total` : 'Loading...'}</span>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-xs px-2.5 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover"
        >
          {showCreate ? 'Cancel' : '+ New Room'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-surface-secondary shadow-sm rounded-lg p-4 space-y-2">
          <Select
            value={selectedTemplate ?? ''}
            onChange={(v) => {
              const id = v || null
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
            className="w-full"
            placeholder="Custom room..."
            options={[
              { value: '', label: 'Custom room...' },
              ...ROOM_TEMPLATES.map(t => ({
                value: t.id,
                label: `${t.name} — ${t.description.slice(0, 60)}`
              }))
            ]}
          />
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value.replace(/\s/g, '').toLowerCase())}
            placeholder="roomname..."
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <input
            value={createGoal}
            onChange={(e) => setCreateGoal(e.target.value)}
            placeholder="Goal (optional)..."
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-muted"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={!createName.trim()}
            className="text-sm px-4 py-2 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-40"
          >
            Create
          </button>
        </div>
      )}

      {/* Room list */}
      {!rooms || rooms.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">No rooms yet. Create one to get started.</p>
      ) : (
        <div className={isWide ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
          {rooms.map(room => {
            const isSelected = selectedRoomId === room.id
            return (
              <div
                key={room.id}
                className={`rounded-lg p-4 border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-interactive bg-interactive-bg'
                    : 'border-border-primary bg-surface-secondary shadow-sm hover:border-border-primary'
                }`}
                onClick={() => onSelectRoom(isSelected ? null : room.id)}
              >
                {/* Room header */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-text-secondary truncate">{room.name}</span>
                  <div className="flex items-center gap-2">
                    <span
                      title={queenRunning[room.id] ? 'Queen running' : 'Queen stopped'}
                      className={`w-1.5 h-1.5 rounded-full ${queenRunning[room.id] ? 'bg-status-success' : 'bg-surface-tertiary'}`}
                    />
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[room.status] || 'bg-surface-tertiary text-text-muted'}`}>
                      {room.status}
                    </span>
                  </div>
                </div>

                {/* Goal */}
                <div className="text-sm mb-2" onClick={(e) => e.stopPropagation()}>
                  <span className="text-text-muted">Goal: </span>
                  {editingGoalId === room.id ? (
                    <div className="mt-1 flex gap-1">
                      <input
                        value={editGoalText}
                        onChange={(e) => setEditGoalText(e.target.value)}
                        className="flex-1 bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-secondary"
                        placeholder="Set room goal..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveGoal(room.id)
                          if (e.key === 'Escape') setEditingGoalId(null)
                        }}
                        autoFocus
                      />
                      <button
                        onClick={() => handleSaveGoal(room.id)}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingGoalId(null)}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span
                      className="text-text-muted cursor-pointer hover:text-text-secondary"
                      onClick={() => { setEditingGoalId(room.id); setEditGoalText(room.goal || '') }}
                    >
                      {room.goal || 'Click to set...'}
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div className="text-xs text-text-muted mb-2">
                  Created {formatRelativeTime(room.createdAt)}
                  {wallets?.[room.id] && (
                    <>
                      <span className="ml-2 font-mono text-text-muted" title={wallets[room.id].address}>
                        {wallets[room.id].address.slice(0, 6)}...{wallets[room.id].address.slice(-4)}
                      </span>
                      <CopyAddressButton address={wallets[room.id].address} />
                    </>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                  {room.status === 'active' ? (
                    <>
                      {queenRunning[room.id] ? (
                        <button
                          onClick={() => handleStop(room.id)}
                          className={`text-sm px-2.5 py-1.5 rounded-lg border transition-colors ${
                            confirmStopId === room.id
                              ? 'text-red-600 border-red-300 bg-red-50 hover:bg-red-100'
                              : 'text-orange-600 border-orange-200 hover:border-orange-300'
                          }`}
                        >
                          {confirmStopId === room.id ? 'Confirm Stop' : 'Stop Room'}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleRoomStart(room.id)}
                          className="text-sm px-2.5 py-1.5 rounded-lg border text-status-success border-green-200 hover:border-green-300 transition-colors"
                        >
                          Start Room
                        </button>
                      )}
                    </>
                  ) : room.status === 'paused' ? (
                    <button
                      onClick={() => handleRoomStart(room.id)}
                      className="text-sm px-2.5 py-1.5 rounded-lg border text-interactive border-border-primary hover:border-interactive transition-colors"
                    >
                      Start Room
                    </button>
                  ) : null}

                  <button
                    onClick={() => handleDelete(room.id)}
                    className={`text-sm px-2.5 py-1.5 rounded-lg border transition-colors ${
                      confirmDeleteId === room.id
                        ? 'text-red-600 border-red-300 bg-red-50 hover:bg-red-100'
                        : 'text-text-muted border-border-primary hover:border-border-primary hover:text-text-secondary'
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
