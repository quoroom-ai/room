import { useState, useRef, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { Select } from './Select'
import { CopyAddressButton } from './CopyAddressButton'
import { PromptDialog } from './PromptDialog'
import type { Room, Wallet, RevenueSummary, OnChainBalance } from '@shared/types'

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

type ApiKeyFeedback = {
  kind: 'info' | 'success' | 'error'
  text: string
}

type ApiKeyPromptMode = 'validate' | 'save'

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
  const { data: onChainBalance } = usePolling<OnChainBalance | null>(
    () => roomId && wallet ? api.wallet.balance(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const [queenModel, setQueenModel] = useState<Record<number, string | null>>({})
  const [queenAuth, setQueenAuth] = useState<Record<number, QueenStatus['auth'] | null>>({})
  const pendingModelUpdate = useRef(false)
  const queenStatusLoaded = useRef(false)

  // Fetch queen status for all rooms
  const fetchQueenStatusRef = useRef(async (roomList: Room[]) => {
    const entries = await Promise.all(
      roomList.map(async r => {
        const q = await api.rooms.queenStatus(r.id).catch(() => null)
        return [r.id, q] as const
      })
    )
    setQueenRunning(Object.fromEntries(entries.map(([id, q]) => [id, q?.running ?? false])))
    if (!pendingModelUpdate.current) {
      setQueenModel(Object.fromEntries(entries.map(([id, q]) => [id, q?.model ?? null])))
      setQueenAuth(Object.fromEntries(entries.map(([id, q]) => [id, q?.auth ?? null])))
    }
  })

  // Fetch queen status immediately when rooms first load (no 5s delay)
  useEffect(() => {
    if (!rooms || rooms.length === 0 || queenStatusLoaded.current) return
    queenStatusLoaded.current = true
    void fetchQueenStatusRef.current(rooms)
  }, [rooms])

  usePolling(async () => {
    if (!rooms || rooms.length === 0) return {}
    await fetchQueenStatusRef.current(rooms)
    return {}
  }, 5000)

  const [roomOverrides, setRoomOverrides] = useState<Record<number, Partial<Room>>>({})
  const [apiKeyPrompt, setApiKeyPrompt] = useState<{
    roomId: number
    auth: NonNullable<QueenStatus['auth']>
    mode: ApiKeyPromptMode
  } | null>(null)
  const [apiKeyBusyRoomId, setApiKeyBusyRoomId] = useState<number | null>(null)
  const [apiKeyFeedback, setApiKeyFeedback] = useState<Record<number, ApiKeyFeedback | null>>({})
  const [editingName, setEditingName] = useState('')
  const [editingGoal, setEditingGoal] = useState('')
  const [ollamaBusy, setOllamaBusy] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)

  // Sync editingName/editingGoal when selected room changes
  const currentRoom = rooms?.find(r => r.id === roomId) ?? null
  useEffect(() => {
    if (currentRoom) {
      setEditingName(currentRoom.name)
      setEditingGoal(currentRoom.goal ?? '')
    }
  }, [currentRoom?.name, currentRoom?.goal, currentRoom?.id])

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
    const workerModel = useOllama ? 'ollama:llama3.2' : 'queen'
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
    // Save previous state for rollback on error
    const prevModel = queenModel[room.id] ?? null
    const prevAuth = queenAuth[room.id] ?? null
    setQueenModel(prev => ({ ...prev, [room.id]: dbModel }))
    // Set auth optimistically so API key row appears immediately
    if (model.startsWith('openai:')) {
      setQueenAuth(prev => ({ ...prev, [room.id]: { provider: 'openai_api', mode: 'api', credentialName: 'openai_api_key', envVar: 'OPENAI_API_KEY', hasCredential: false, hasEnvKey: false, ready: false } }))
    } else if (model.startsWith('anthropic:')) {
      setQueenAuth(prev => ({ ...prev, [room.id]: { provider: 'anthropic_api', mode: 'api', credentialName: 'anthropic_api_key', envVar: 'ANTHROPIC_API_KEY', hasCredential: false, hasEnvKey: false, ready: false } }))
    } else if (model.startsWith('ollama:')) {
      setQueenAuth(prev => ({ ...prev, [room.id]: { provider: 'ollama', mode: 'subscription', credentialName: null, envVar: null, hasCredential: false, hasEnvKey: false, ready: false } }))
    } else {
      setQueenAuth(prev => ({ ...prev, [room.id]: { provider: 'claude_subscription', mode: 'subscription', credentialName: null, envVar: null, hasCredential: false, hasEnvKey: false, ready: true } }))
    }
    pendingModelUpdate.current = true
    try {
      await api.workers.update(room.queenWorkerId, { model: dbModel })
      const q = await api.rooms.queenStatus(room.id).catch(() => null)
      if (q) {
        setQueenModel(prev => ({ ...prev, [room.id]: q.model ?? null }))
        setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
      }
    } catch (e) {
      console.error('Failed to update queen model:', e)
      // Revert optimistic state — update didn't persist
      setQueenModel(prev => ({ ...prev, [room.id]: prevModel }))
      setQueenAuth(prev => ({ ...prev, [room.id]: prevAuth }))
    } finally {
      pendingModelUpdate.current = false
    }
  }

  function openApiKeyPrompt(room: Room, auth: QueenStatus['auth'] | null, mode: ApiKeyPromptMode): void {
    if (!auth || auth.mode !== 'api' || !auth.credentialName) return
    setApiKeyPrompt({ roomId: room.id, auth, mode })
    setApiKeyFeedback(prev => ({ ...prev, [room.id]: null }))
  }

  async function submitApiKey(value: string): Promise<void> {
    if (!apiKeyPrompt) return
    const { roomId: targetRoomId, auth, mode } = apiKeyPrompt
    if (apiKeyBusyRoomId === targetRoomId) return
    const providerName = auth.credentialName === 'openai_api_key' ? 'OpenAI' : 'Anthropic'
    const shouldSave = mode === 'save'
    if (shouldSave) pendingModelUpdate.current = true
    setApiKeyBusyRoomId(targetRoomId)
    setApiKeyFeedback(prev => ({ ...prev, [targetRoomId]: { kind: 'info', text: `Validating ${providerName} key...` } }))
    try {
      await api.credentials.validate(targetRoomId, auth.credentialName!, value)
      if (shouldSave) {
        await api.credentials.create(targetRoomId, auth.credentialName!, value, 'api_key')
        setQueenAuth(prev => ({ ...prev, [targetRoomId]: { ...auth, hasCredential: true, ready: true } }))
        const q = await api.rooms.queenStatus(targetRoomId).catch(() => null)
        if (q) {
          setQueenAuth(prev => ({ ...prev, [targetRoomId]: q.auth }))
        }
        setApiKeyFeedback(prev => ({ ...prev, [targetRoomId]: { kind: 'success', text: `${providerName} API key validated and saved.` } }))
      } else {
        setApiKeyFeedback(prev => ({ ...prev, [targetRoomId]: { kind: 'success', text: `${providerName} API key is valid.` } }))
      }
      setApiKeyPrompt(null)
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to validate ${providerName} API key`
      setApiKeyFeedback(prev => ({ ...prev, [targetRoomId]: { kind: 'error', text: message } }))
    } finally {
      if (shouldSave) pendingModelUpdate.current = false
      setApiKeyBusyRoomId(null)
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


  if (roomId === null) {
    return <p className="p-4 text-sm text-text-muted">Select a room to view its settings.</p>
  }

  const rawRoom = rooms?.find(r => r.id === roomId)
  if (!rawRoom) {
    return <p className="p-4 text-sm text-text-muted">Loading...</p>
  }

  const room = { ...rawRoom, ...roomOverrides[rawRoom.id] }
  const quietEnabled = room.queenQuietFrom !== null
  const activeQueenAuth = queenAuth[room.id] ?? null

  function row(label: string, children: React.ReactNode, description?: string): React.JSX.Element {
    return (
      <div className="py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{label}</span>
          <div>{children}</div>
        </div>
        {description && <p className="text-xs text-text-muted mt-0.5 leading-tight">{description}</p>}
      </div>
    )
  }

  function toggleRow(label: string, value: boolean, onChange: () => void, description?: string): React.JSX.Element {
    return (
      <div className="py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{label}</span>
          <button
            onClick={onChange}
            className={`w-9 h-5 rounded-full transition-colors relative ${value ? 'bg-interactive' : 'bg-surface-tertiary'}`}
          >
            <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${value ? 'left-4' : 'left-0.5'}`} />
          </button>
        </div>
        {description && <p className="text-xs text-text-muted mt-0.5 leading-tight">{description}</p>}
      </div>
    )
  }

  const nameChanged = editingName.trim() !== '' && editingName.trim() !== room.name
  const goalChanged = editingGoal.trim() !== (room.goal ?? '')

  async function handleSaveName(): Promise<void> {
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === room.name) return
    optimistic(room.id, { name: trimmed })
    await api.rooms.update(room.id, { name: trimmed })
    refresh()
  }

  async function handleSaveGoal(): Promise<void> {
    const trimmed = editingGoal.trim()
    if (trimmed === (room.goal ?? '')) return
    optimistic(room.id, { goal: trimmed || null })
    await api.rooms.update(room.id, { goal: trimmed || null })
    refresh()
  }

  async function handleArchiveRoom(): Promise<void> {
    if (!window.confirm(`Archive "${room.name}"? This will stop the queen, cancel all stations, and hide the room.`)) return
    setArchiveBusy(true)
    try {
      // Stop the queen
      await api.rooms.queenStop(room.id).catch(() => {})
      // Cancel all cloud stations immediately
      const stations = await api.stations.list(room.id).catch(() => [])
      for (const s of stations) {
        await api.stations.delete(room.id, (s as Record<string, unknown>).id as number).catch(() => {})
      }
      // Set room status to stopped (also pauses all agents server-side)
      await api.rooms.update(room.id, { status: 'stopped' } as Record<string, unknown>)
      refresh()
    } catch {
      // ignore
    }
    setArchiveBusy(false)
  }

  return (
    <div className="p-4">
      {/* Room name */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-text-secondary mb-1">Room Name</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={editingName}
            onChange={e => setEditingName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSaveName() }}
            onBlur={() => void handleSaveName()}
            className="flex-1 px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary focus:outline-none focus:border-interactive"
          />
          {nameChanged && (
            <button
              onClick={() => void handleSaveName()}
              className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors"
            >
              Save
            </button>
          )}
        </div>
      </div>

      {/* Primary Objective */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-text-secondary mb-1">Primary Objective</label>
        <textarea
          value={editingGoal}
          onChange={e => setEditingGoal(e.target.value)}
          onBlur={() => void handleSaveGoal()}
          rows={4}
          placeholder="What should this room accomplish?"
          className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive resize-none"
        />
        {goalChanged && (
          <button
            onClick={() => void handleSaveGoal()}
            className="mt-1 px-3 py-1.5 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors"
          >
            Save
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="space-y-4">
          {/* Queen */}
          <div>
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Queen</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3 divide-y divide-border-primary">

              {/* Autonomy mode */}
              {row('Control',
                <div className="flex rounded-lg overflow-hidden border border-border-primary">
                  <button
                    onClick={() => handleSetAutonomy(room, 'auto')}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      room.autonomyMode === 'auto' ? 'bg-interactive text-text-invert' : 'bg-surface-primary text-text-muted hover:bg-surface-hover'
                    }`}
                  >Auto</button>
                  <button
                    onClick={() => handleSetAutonomy(room, 'semi')}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      room.autonomyMode === 'semi' ? 'bg-interactive text-text-invert' : 'bg-surface-primary text-text-muted hover:bg-surface-hover'
                    }`}
                  >Semi</button>
                </div>,
                'Auto: agents control everything, UI is read-only. Semi: full UI controls for the keeper.'
              )}

              {/* Queen model */}
              {row('Model',
                <Select
                  value={queenModel[room.id] ?? 'claude'}
                  onChange={(v) => handleSetQueenModel(room, v)}
                  options={[
                    { value: 'claude', label: 'Claude Code (subscription)' },
                    { value: 'claude-opus-4-6', label: 'Opus (subscription)' },
                    { value: 'claude-sonnet-4-6', label: 'Sonnet (subscription)' },
                    { value: 'claude-haiku-4-5-20251001', label: 'Haiku (subscription)' },
                    { value: 'codex', label: 'Codex (ChatGPT subscription)' },
                    { value: 'openai:gpt-4o-mini', label: 'OpenAI API' },
                    { value: 'anthropic:claude-3-5-sonnet-latest', label: 'Claude API' },
                    { value: 'ollama:llama3.2', label: 'Llama 3.2 (Ollama, free)' },
                  ]}
                />,
                'LLM provider for the queen. Subscription has lower cost per token than API. API options require a key.'
              )}

              {activeQueenAuth?.mode === 'api' && (
                row('API key',
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${activeQueenAuth.ready ? 'text-status-success' : 'text-status-warning'}`}>
                      {activeQueenAuth.ready
                        ? activeQueenAuth.hasCredential ? 'Saved' : `Env (${activeQueenAuth.envVar ?? 'set'})`
                        : 'Missing'}
                    </span>
                    <button
                      onClick={() => openApiKeyPrompt(room, activeQueenAuth, 'validate')}
                      disabled={apiKeyBusyRoomId === room.id}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => openApiKeyPrompt(room, activeQueenAuth, 'save')}
                      disabled={apiKeyBusyRoomId === room.id}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {apiKeyBusyRoomId === room.id ? 'Validating...' : activeQueenAuth.hasCredential ? 'Update' : 'Set'}
                    </button>
                  </div>
                )
              )}
              {activeQueenAuth?.mode === 'subscription' && !activeQueenAuth.ready && (
                row('Status',
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-status-warning">
                      {activeQueenAuth.provider === 'claude_subscription' && 'Claude CLI not installed'}
                      {activeQueenAuth.provider === 'codex_subscription' && 'Codex CLI not installed'}
                      {activeQueenAuth.provider === 'ollama' && 'Ollama not running'}
                    </span>
                    {activeQueenAuth.provider === 'ollama' && (
                      <button
                        disabled={ollamaBusy}
                        onClick={async () => {
                          setOllamaBusy(true)
                          try {
                            await api.ollama.start()
                            const q = await api.rooms.queenStatus(room.id).catch(() => null)
                            if (q) setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
                          } catch {}
                          setOllamaBusy(false)
                        }}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                      >
                        {ollamaBusy ? 'Installing...' : 'Install & Start'}
                      </button>
                    )}
                  </div>
                )
              )}
              {apiKeyFeedback[room.id] && (
                <div className={`text-xs mt-1 ${
                  apiKeyFeedback[room.id]?.kind === 'success'
                    ? 'text-status-success'
                    : apiKeyFeedback[room.id]?.kind === 'error'
                      ? 'text-status-error'
                      : 'text-text-muted'
                }`}>
                  {apiKeyFeedback[room.id]?.text}
                </div>
              )}

              {/* Sessions */}
              {row('Queen sessions',
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleChangeMaxTasks(room, -1)}
                    disabled={room.maxConcurrentTasks <= 1}
                    className="w-5 h-5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary disabled:opacity-30 text-sm font-medium text-text-secondary"
                  >-</button>
                  <span className="w-5 text-center text-sm tabular-nums text-text-primary">{room.maxConcurrentTasks}</span>
                  <button
                    onClick={() => handleChangeMaxTasks(room, 1)}
                    disabled={room.maxConcurrentTasks >= 10}
                    className="w-5 h-5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary disabled:opacity-30 text-sm font-medium text-text-secondary"
                  >+</button>
                </div>,
                'How many tasks the queen can run in parallel. Higher values use more compute.'
              )}

              {/* Cycle gap */}
              {row('Cycle gap',
                <Select
                  value={String(room.queenCycleGapMs)}
                  onChange={(v) => handleSetCycleGap(room, Number(v))}
                  options={[
                    { value: '10000', label: '10s' },
                    { value: '30000', label: '30s' },
                    { value: '60000', label: '1 min' },
                    { value: '300000', label: '5 min' },
                    { value: '900000', label: '15 min' },
                    { value: '1800000', label: '30 min' },
                    { value: '3600000', label: '1 hr' },
                    { value: '7200000', label: '2 hr' },
                  ]}
                />,
                'Sleep time between queen cycles. Shorter gaps burn more tokens.'
              )}

              {/* Max turns */}
              {row('Max turns',
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleSetMaxTurns(room, -1)}
                    disabled={room.queenMaxTurns <= 1}
                    className="w-5 h-5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary disabled:opacity-30 text-sm font-medium text-text-secondary"
                  >-</button>
                  <span className="w-5 text-center text-sm tabular-nums text-text-primary">{room.queenMaxTurns}</span>
                  <button
                    onClick={() => handleSetMaxTurns(room, 1)}
                    disabled={room.queenMaxTurns >= 50}
                    className="w-5 h-5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary disabled:opacity-30 text-sm font-medium text-text-secondary"
                  >+</button>
                </div>,
                'Max tool-use rounds per cycle. Limits how much the queen can do in one run.'
              )}

              {/* Quiet hours */}
              <div className="py-2 space-y-2">
                {toggleRow('Quiet hours', quietEnabled, () => handleToggleQuietHours(room), 'Pause the queen during off-hours')}
                {quietEnabled && (
                  <div className="flex items-center gap-2 pl-0">
                    <input
                      type="time"
                      value={room.queenQuietFrom ?? '22:00'}
                      onChange={(e) => handleSetQuietHours(room, e.target.value, room.queenQuietUntil ?? '08:00')}
                      className="text-sm border border-border-primary rounded-lg px-2.5 py-1.5 bg-surface-primary text-text-secondary"
                    />
                    <span className="text-text-muted text-sm">–</span>
                    <input
                      type="time"
                      value={room.queenQuietUntil ?? '08:00'}
                      onChange={(e) => handleSetQuietHours(room, room.queenQuietFrom ?? '22:00', e.target.value)}
                      className="text-sm border border-border-primary rounded-lg px-2.5 py-1.5 bg-surface-primary text-text-secondary"
                    />
                  </div>
                )}
              </div>

              {/* Queen start/stop */}
              <div className="pt-2 flex gap-2">
                {room.status === 'active' && (
                  queenRunning[room.id] ? (
                    <button
                      onClick={() => handleQueenStop(room.id)}
                      className="text-sm px-2.5 py-1.5 rounded-lg border text-orange-600 border-orange-200 hover:border-orange-300 transition-colors"
                    >Stop Queen</button>
                  ) : (
                    <button
                      onClick={() => handleQueenStart(room.id)}
                      className="text-sm px-2.5 py-1.5 rounded-lg border text-status-success border-green-200 hover:border-green-300 transition-colors"
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
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Wallet</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3">
              {!wallet ? (
                <p className="text-sm text-text-muted py-1">Wallet not found for this room.</p>
              ) : (
                <div className="space-y-2">
                  <div className="py-1">
                    <p className="text-sm text-text-secondary mb-1">Address</p>
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-text-muted bg-surface-primary border border-border-primary rounded-lg px-2 py-1 truncate flex-1" title={wallet.address}>
                        {wallet.address}
                      </code>
                      <CopyAddressButton address={wallet.address} />
                    </div>
                    {onChainBalance && onChainBalance.totalBalance > 0 && (
                      <div className="text-sm mt-1">
                        <span className="text-interactive font-medium">${onChainBalance.totalBalance.toFixed(2)}</span>
                        <span className="text-text-muted"> on-chain</span>
                      </div>
                    )}
                    {revenueSummary && (
                      <div className="flex gap-3 text-sm mt-1">
                        <span className="text-status-success">+${revenueSummary.totalIncome.toFixed(2)}</span>
                        <span className="text-status-error">-${revenueSummary.totalExpenses.toFixed(2)}</span>
                        <span className={revenueSummary.netProfit >= 0 ? 'text-interactive' : 'text-status-warning'}>
                          net ${revenueSummary.netProfit.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="pt-1 border-t border-border-primary">
                    <p className="text-xs text-text-muted leading-relaxed">
                      Supports USDC and USDT on Base, Ethereum, Arbitrum, Optimism, and Polygon.
                      Same address works on all EVM chains. Balance is aggregated across all networks.
                      Fund the wallet to give the queen resources for stations and services.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Workers */}
          <div>
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Workers</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3">
              <div className="flex items-center justify-between text-sm py-1">
                <div>
                  <span className="text-text-secondary">Llama for workers</span>
                  <p className="text-xs text-text-muted mt-0.5 leading-tight">Local only. When off, workers use the queen's model. Stations always run Llama.</p>
                </div>
                <button
                  onClick={() => handleSetWorkerModel(room, !(room.workerModel ?? 'queen').startsWith('ollama:'))}
                  className={`w-8 h-4 rounded-full transition-colors relative ml-3 flex-shrink-0 ${
                    (room.workerModel ?? 'queen').startsWith('ollama:') ? 'bg-interactive' : 'bg-surface-tertiary'
                  }`}
                >
                  <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                    (room.workerModel ?? 'queen').startsWith('ollama:') ? 'left-4' : 'left-0.5'
                  }`} />
                </button>
              </div>
            </div>
          </div>

          {/* Visibility */}
          <div>
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Visibility</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3">
              <div className="flex items-center justify-between text-sm py-1">
                <div>
                  <span className="text-text-secondary">Public room</span>
                  <p className="text-xs text-text-muted mt-0.5 leading-tight">Visible on the public leaderboard at quoroom.ai. Shows objective, balances, and activity only.</p>
                </div>
                <button
                  onClick={() => handleToggleVisibility(room)}
                  className={`w-8 h-4 rounded-full transition-colors relative ml-3 flex-shrink-0 ${
                    room.visibility === 'public' ? 'bg-interactive' : 'bg-surface-tertiary'
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

      {/* Danger Zone */}
      <div className="mt-6 w-fit">
        <h3 className="text-sm font-semibold text-status-error mb-2">Danger Zone</h3>
        <div className="border border-status-error rounded-lg p-4">
          <p className="text-sm text-text-secondary mb-1">Archive this room</p>
          <p className="text-xs text-text-muted mb-3">Stops the queen, cancels all stations, and hides the room from the sidebar.</p>
          <button
            onClick={() => void handleArchiveRoom()}
            disabled={archiveBusy}
            className="px-4 py-2 rounded-lg border border-status-error text-status-error text-sm font-medium hover:bg-status-error-bg transition-colors disabled:opacity-50"
          >
            {archiveBusy ? 'Archiving...' : 'Archive Room'}
          </button>
        </div>
      </div>

      {apiKeyPrompt && (
        <PromptDialog
          title={`Enter ${apiKeyPrompt.auth.credentialName === 'openai_api_key' ? 'OpenAI' : 'Anthropic'} API key ${apiKeyPrompt.mode === 'save' ? 'to save' : 'to test'}:`}
          placeholder="sk-..."
          type="password"
          confirmLabel={apiKeyBusyRoomId === apiKeyPrompt.roomId ? 'Validating...' : apiKeyPrompt.mode === 'save' ? 'Validate & Save' : 'Validate'}
          onConfirm={submitApiKey}
          onCancel={() => {
            if (apiKeyBusyRoomId === apiKeyPrompt.roomId) return
            setApiKeyPrompt(null)
          }}
        />
      )}
    </div>
  )
}
