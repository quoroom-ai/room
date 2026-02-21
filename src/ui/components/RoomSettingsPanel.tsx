import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import type { Room, Wallet, RevenueSummary } from '@shared/types'

interface RoomSettingsPanelProps {
  roomId: number | null
}

interface QueenStatus {
  running: boolean
  model: string | null
  auth: {
    provider: 'claude_subscription' | 'codex_subscription' | 'openai_api' | 'anthropic_api' | 'ollama'
    mode: 'subscription' | 'api'
    credentialName: string | null
    envVar: string | null
    hasCredential: boolean
    hasEnvKey: boolean
    ready: boolean
  }
}

export function RoomSettingsPanel({ roomId }: RoomSettingsPanelProps): React.JSX.Element {
  const { data: rooms, refresh } = usePolling<Room[]>(() => api.rooms.list(), 10000)
  const { data: wallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    10000
  )
  const { data: revenueSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const [queenModel, setQueenModel] = useState<Record<number, string | null>>({})
  const [queenAuth, setQueenAuth] = useState<Record<number, QueenStatus['auth'] | null>>({})
  usePolling(async () => {
    if (!rooms || rooms.length === 0) return {}
    const entries = await Promise.all(
      rooms.map(async r => {
        const q = await api.rooms.queenStatus(r.id).catch(() => null)
        return [r.id, q] as const
      })
    )
    setQueenRunning(Object.fromEntries(entries.map(([id, q]) => [id, q?.running ?? false])))
    setQueenModel(Object.fromEntries(entries.map(([id, q]) => [id, q?.model ?? null])))
    setQueenAuth(Object.fromEntries(entries.map(([id, q]) => [id, q?.auth ?? null])))
    return {}
  }, 5000)

  const [roomOverrides, setRoomOverrides] = useState<Record<number, Partial<Room>>>({})
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle')

  function optimistic(id: number, patch: Partial<Room>): void {
    setRoomOverrides(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
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
      optimistic(room.id, { autonomyMode: room.autonomyMode })
    }
  }

  async function handleChangeMaxTasks(room: Room, delta: number): Promise<void> {
    const next = Math.max(1, Math.min(10, room.maxConcurrentTasks + delta))
    if (next === room.maxConcurrentTasks) return
    optimistic(room.id, { maxConcurrentTasks: next })
    await api.rooms.update(room.id, { maxConcurrentTasks: next })
    refresh()
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

  async function handleSetQuietHours(room: Room, from: string | null, until: string | null): Promise<void> {
    optimistic(room.id, { queenQuietFrom: from, queenQuietUntil: until })
    await api.rooms.update(room.id, { queenQuietFrom: from, queenQuietUntil: until })
    refresh()
  }

  async function handleToggleQuietHours(room: Room): Promise<void> {
    if (room.queenQuietFrom !== null) {
      await handleSetQuietHours(room, null, null)
    } else {
      await handleSetQuietHours(room, '22:00', '08:00')
    }
  }

  async function handleSetWorkerModel(room: Room, useOllama: boolean): Promise<void> {
    const workerModel = useOllama ? 'ollama:llama3.2' : 'claude'
    optimistic(room.id, { workerModel })
    try {
      await api.rooms.update(room.id, { workerModel })
      refresh()
    } catch (e) {
      console.error('Failed to update worker model:', e)
      optimistic(room.id, { workerModel: room.workerModel })
    }
  }

  async function handleSetQueenModel(room: Room, model: string): Promise<void> {
    if (!room.queenWorkerId) return
    const dbModel = model === 'claude' ? null : model
    setQueenModel(prev => ({ ...prev, [room.id]: dbModel }))
    try {
      await api.workers.update(room.queenWorkerId, { model: dbModel })
      const q = await api.rooms.queenStatus(room.id).catch(() => null)
      if (q) {
        setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
      }
    } catch (e) {
      console.error('Failed to update queen model:', e)
    }
  }

  async function handleSetQueenApiKey(room: Room, auth: QueenStatus['auth'] | null): Promise<void> {
    if (!auth || auth.mode !== 'api' || !auth.credentialName) return
    const providerName = auth.credentialName === 'openai_api_key' ? 'OpenAI' : 'Anthropic'
    const entered = window.prompt(`Enter ${providerName} API key for this room:`)
    if (!entered) return
    const value = entered.trim()
    if (!value) return
    await api.credentials.create(room.id, auth.credentialName, value, 'api_key')
    const q = await api.rooms.queenStatus(room.id).catch(() => null)
    if (q) {
      setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
    }
  }

  async function handleQueenStart(roomId: number): Promise<void> {
    await api.rooms.queenStart(roomId)
    setQueenRunning(prev => ({ ...prev, [roomId]: true }))
  }

  async function handleQueenStop(roomId: number): Promise<void> {
    await api.rooms.queenStop(roomId)
    setQueenRunning(prev => ({ ...prev, [roomId]: false }))
  }

  async function copyWalletAddress(address: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        const input = document.createElement('textarea')
        input.value = address
        input.setAttribute('readonly', '')
        input.style.position = 'absolute'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        document.body.removeChild(input)
      }
      setCopyState('ok')
    } catch {
      setCopyState('error')
    }

    window.setTimeout(() => setCopyState('idle'), 1200)
  }

  if (roomId === null) {
    return <p className="p-4 text-xs text-gray-400">Select a room to view its settings.</p>
  }

  const rawRoom = rooms?.find(r => r.id === roomId)
  if (!rawRoom) {
    return <p className="p-4 text-xs text-gray-400">Loading...</p>
  }

  const room = { ...rawRoom, ...roomOverrides[rawRoom.id] }
  const quietEnabled = room.queenQuietFrom !== null
  const activeQueenAuth = queenAuth[room.id] ?? null

  function row(label: string, children: React.ReactNode): React.JSX.Element {
    return (
      <div className="flex items-center justify-between text-xs py-1.5">
        <span className="text-gray-600">{label}</span>
        <div>{children}</div>
      </div>
    )
  }

  function toggleRow(label: string, value: boolean, onChange: () => void, description?: string): React.JSX.Element {
    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-600">{label}</span>
          <button
            onClick={onChange}
            className={`w-8 h-4 rounded-full transition-colors relative ${value ? 'bg-green-500' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${value ? 'left-4' : 'left-0.5'}`} />
          </button>
        </div>
        {description && <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{description}</p>}
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="space-y-4">
          {/* Queen */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-1">Queen</h3>
            <div className="bg-gray-50 rounded-lg p-2 divide-y divide-gray-100">

              {/* Autonomy mode */}
              {row('Control',
                <div className="flex rounded overflow-hidden border border-gray-200">
                  <button
                    onClick={() => handleSetAutonomy(room, 'auto')}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      room.autonomyMode === 'auto' ? 'bg-amber-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'
                    }`}
                  >Auto</button>
                  <button
                    onClick={() => handleSetAutonomy(room, 'semi')}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      room.autonomyMode === 'semi' ? 'bg-blue-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'
                    }`}
                  >Semi</button>
                </div>
              )}

              {/* Queen model */}
              {row('Model',
                <select
                  value={queenModel[room.id] ?? 'claude'}
                  onChange={(e) => handleSetQueenModel(room, e.target.value)}
                  className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600"
                >
                  <option value="claude">Claude Code (subscription)</option>
                  <option value="claude-opus-4-6">Opus</option>
                  <option value="claude-sonnet-4-6">Sonnet</option>
                  <option value="claude-haiku-4-5-20251001">Haiku</option>
                  <option value="codex">Codex (ChatGPT subscription)</option>
                  <option value="openai:gpt-4o-mini">OpenAI API</option>
                  <option value="anthropic:claude-3-5-sonnet-latest">Claude API</option>
                </select>
              )}

              {activeQueenAuth?.mode === 'api' && (
                row('API key',
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] ${activeQueenAuth.ready ? 'text-green-600' : 'text-amber-600'}`}>
                      {activeQueenAuth.ready
                        ? activeQueenAuth.hasCredential ? 'Saved' : `Env (${activeQueenAuth.envVar ?? 'set'})`
                        : 'Missing'}
                    </span>
                    <button
                      onClick={() => handleSetQueenApiKey(room, activeQueenAuth)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-100"
                    >
                      {activeQueenAuth.hasCredential ? 'Update' : 'Set'}
                    </button>
                  </div>
                )
              )}

              {/* Sessions */}
              {row('Queen sessions',
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleChangeMaxTasks(room, -1)}
                    disabled={room.maxConcurrentTasks <= 1}
                    className="w-5 h-5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-xs font-medium text-gray-600"
                  >-</button>
                  <span className="w-5 text-center text-xs tabular-nums">{room.maxConcurrentTasks}</span>
                  <button
                    onClick={() => handleChangeMaxTasks(room, 1)}
                    disabled={room.maxConcurrentTasks >= 10}
                    className="w-5 h-5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-xs font-medium text-gray-600"
                  >+</button>
                </div>
              )}

              {/* Cycle gap */}
              {row('Cycle gap',
                <select
                  value={room.queenCycleGapMs}
                  onChange={(e) => handleSetCycleGap(room, Number(e.target.value))}
                  className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600"
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
              )}

              {/* Max turns */}
              {row('Max turns',
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleSetMaxTurns(room, -1)}
                    disabled={room.queenMaxTurns <= 1}
                    className="w-5 h-5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-xs font-medium text-gray-600"
                  >-</button>
                  <span className="w-5 text-center text-xs tabular-nums">{room.queenMaxTurns}</span>
                  <button
                    onClick={() => handleSetMaxTurns(room, 1)}
                    disabled={room.queenMaxTurns >= 50}
                    className="w-5 h-5 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-30 text-xs font-medium text-gray-600"
                  >+</button>
                </div>
              )}

              {/* Quiet hours */}
              <div className="py-1.5 space-y-1">
                {toggleRow('Quiet hours', quietEnabled, () => handleToggleQuietHours(room), 'Pause the queen during off-hours')}
                {quietEnabled && (
                  <div className="flex items-center gap-2 pl-0">
                    <input
                      type="time"
                      value={room.queenQuietFrom ?? '22:00'}
                      onChange={(e) => handleSetQuietHours(room, e.target.value, room.queenQuietUntil ?? '08:00')}
                      className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600"
                    />
                    <span className="text-gray-400 text-xs">–</span>
                    <input
                      type="time"
                      value={room.queenQuietUntil ?? '08:00'}
                      onChange={(e) => handleSetQuietHours(room, room.queenQuietFrom ?? '22:00', e.target.value)}
                      className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600"
                    />
                  </div>
                )}
              </div>

              {/* Queen start/stop */}
              <div className="pt-1.5 flex gap-1.5">
                {room.status === 'active' && (
                  queenRunning[room.id] ? (
                    <button
                      onClick={() => handleQueenStop(room.id)}
                      className="text-xs px-2 py-1 rounded border text-orange-600 border-orange-200 hover:border-orange-300 transition-colors"
                    >Stop Queen</button>
                  ) : (
                    <button
                      onClick={() => handleQueenStart(room.id)}
                      className="text-xs px-2 py-1 rounded border text-green-600 border-green-200 hover:border-green-300 transition-colors"
                    >Start Queen</button>
                  )
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {/* Wallet */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-1">Wallet</h3>
            <div className="bg-gray-50 rounded-lg p-2">
              {!wallet ? (
                <p className="text-[11px] text-gray-400 py-1">Wallet not found for this room.</p>
              ) : (
                <div className="space-y-1.5">
                  {row('Chain', <span className="text-[11px] text-gray-500">{wallet.chain}</span>)}
                  <div className="py-1">
                    <p className="text-xs text-gray-600 mb-1">Address</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[10px] text-gray-500 bg-white border border-gray-200 rounded px-1.5 py-1 truncate flex-1" title={wallet.address}>
                        {wallet.address}
                      </code>
                      <button
                        onClick={() => copyWalletAddress(wallet.address)}
                        className="text-[10px] px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                    {copyState === 'ok' && (
                      <p className="text-[10px] text-green-600 mt-1">Copied.</p>
                    )}
                    {copyState === 'error' && (
                      <p className="text-[10px] text-red-500 mt-1">Copy failed.</p>
                    )}
                    {revenueSummary && (
                      <div className="flex gap-3 text-xs mt-1">
                        <span className="text-green-600">+${revenueSummary.totalIncome.toFixed(2)}</span>
                        <span className="text-red-500">-${revenueSummary.totalExpenses.toFixed(2)}</span>
                        <span className={revenueSummary.netProfit >= 0 ? 'text-blue-600' : 'text-amber-600'}>
                          net ${revenueSummary.netProfit.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Workers */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-1">Workers</h3>
            <div className="bg-gray-50 rounded-lg p-2 space-y-1">
              {row('Model',
                <div className="flex rounded overflow-hidden border border-gray-200">
                  <button
                    onClick={() => handleSetWorkerModel(room, false)}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      !(room.workerModel ?? 'claude').startsWith('ollama:') ? 'bg-blue-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'
                    }`}
                  >Claude</button>
                  <button
                    onClick={() => handleSetWorkerModel(room, true)}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      (room.workerModel ?? 'claude').startsWith('ollama:') ? 'bg-green-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'
                    }`}
                  >Ollama</button>
                </div>
              )}
              {(room.workerModel ?? 'claude').startsWith('ollama:') && (
                <p className="text-[10px] text-green-600 leading-tight pl-0">
                  Free local LLM — model: {room.workerModel.replace('ollama:', '')}. Requires Ollama running locally.
                </p>
              )}
            </div>
          </div>

          {/* Visibility */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-1">Visibility</h3>
            <div className="bg-gray-50 rounded-lg p-2">
              <div className="flex items-center justify-between text-xs py-1">
                <div>
                  <span className="text-gray-600">Public room</span>
                  <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">Visible on the public leaderboard at quoroom.ai</p>
                </div>
                <button
                  onClick={() => handleToggleVisibility(room)}
                  className={`w-8 h-4 rounded-full transition-colors relative ml-3 flex-shrink-0 ${
                    room.visibility === 'public' ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                    room.visibility === 'public' ? 'left-4' : 'left-0.5'
                  }`} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
