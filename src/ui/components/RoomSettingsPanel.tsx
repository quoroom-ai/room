import { useState, useRef, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { getCachedToken } from '../lib/auth'
import { storageGet, storageRemove } from '../lib/storage'
import { wsClient, type WsMessage } from '../lib/ws'
import { Select } from './Select'
import { CopyAddressButton } from './CopyAddressButton'
import { PromptDialog } from './PromptDialog'
import { RoomSetupGuideModal } from './RoomSetupGuideModal'
import type { Room, Wallet, RevenueSummary, OnChainBalance } from '@shared/types'
import { FREE_OLLAMA_MODEL_OPTIONS } from '@shared/ollama-models'

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
type QueenModelSetupPhase = 'starting' | 'installing'
type ProviderName = 'codex' | 'claude'
type ProviderSessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'

interface ProviderSessionLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

interface ProviderAuthSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  verificationUrl: string | null
  deviceCode: string | null
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderInstallSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderStatusEntry {
  installed: boolean
  version?: string
  connected: boolean | null
  requestedAt: string | null
  disconnectedAt: string | null
  authSession: ProviderAuthSession | null
  installRequestedAt: string | null
  installSession: ProviderInstallSession | null
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
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
  const { data: onChainBalance } = usePolling<OnChainBalance | null>(
    () => roomId && wallet ? api.wallet.balance(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )
  const { data: providerStatus, refresh: refreshProviderStatus } = usePolling<{
    codex: ProviderStatusEntry
    claude: ProviderStatusEntry
  } | null>(
    () => api.providers.status().catch(() => null),
    10000
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
  const [queenModelBusyRoomId, setQueenModelBusyRoomId] = useState<number | null>(null)
  const [queenModelFeedback, setQueenModelFeedback] = useState<Record<number, ApiKeyFeedback | null>>({})
  const [providerFeedback, setProviderFeedback] = useState<Record<number, ApiKeyFeedback | null>>({})
  const [providerAuthSessions, setProviderAuthSessions] = useState<Partial<Record<ProviderName, ProviderAuthSession | null>>>({})
  const [providerInstallSessions, setProviderInstallSessions] = useState<Partial<Record<ProviderName, ProviderInstallSession | null>>>({})
  const [providerAuthBusySessionId, setProviderAuthBusySessionId] = useState<string | null>(null)
  const [providerInstallBusySessionId, setProviderInstallBusySessionId] = useState<string | null>(null)
  const providerAuthUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const providerInstallUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const [queenModelSetup, setQueenModelSetup] = useState<{ roomId: number; phase: QueenModelSetupPhase; startedAt: number } | null>(null)
  const [queenModelSetupTick, setQueenModelSetupTick] = useState<number>(Date.now())
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [showCryptoTopUp, setShowCryptoTopUp] = useState(false)
  const [showSetupGuide, setShowSetupGuide] = useState(false)
  const [editingInviteCode, setEditingInviteCode] = useState('')

  // Sync editingName/editingGoal when selected room changes
  const currentRoom = rooms?.find(r => r.id === roomId) ?? null
  useEffect(() => {
    if (currentRoom) {
      setEditingName(currentRoom.name)
      setEditingGoal(currentRoom.goal ?? '')
      setEditingInviteCode(currentRoom.inviteCode ?? '')
    }
  }, [currentRoom?.name, currentRoom?.goal, currentRoom?.id, currentRoom?.inviteCode])

  // Auto-open setup popup flow once immediately after creating a room.
  useEffect(() => {
    if (!roomId) return
    const requestedRoom = storageGet('quoroom_setup_flow_room')
    if (requestedRoom && Number(requestedRoom) === roomId) {
      setShowSetupGuide(true)
      storageRemove('quoroom_setup_flow_room')
    }
  }, [roomId])

  useEffect(() => {
    if (!queenModelSetup) return
    const timer = window.setInterval(() => setQueenModelSetupTick(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [queenModelSetup])

  function upsertProviderAuthSession(session: ProviderAuthSession): void {
    setProviderAuthSessions(prev => ({ ...prev, [session.provider]: session }))
  }

  function upsertProviderInstallSession(session: ProviderInstallSession): void {
    setProviderInstallSessions(prev => ({ ...prev, [session.provider]: session }))
  }

  function providerAuthStatusLabel(status: ProviderSessionStatus): string {
    switch (status) {
      case 'starting': return 'Starting'
      case 'running': return 'Waiting for login'
      case 'completed': return 'Connected'
      case 'failed': return 'Failed'
      case 'canceled': return 'Canceled'
      case 'timeout': return 'Timed out'
      default: return status
    }
  }

  function providerInstallStatusLabel(status: ProviderSessionStatus): string {
    switch (status) {
      case 'starting': return 'Starting'
      case 'running': return 'Installing'
      case 'completed': return 'Installed'
      case 'failed': return 'Failed'
      case 'canceled': return 'Canceled'
      case 'timeout': return 'Timed out'
      default: return status
    }
  }

  useEffect(() => {
    if (!providerStatus) return
    setProviderAuthSessions(prev => ({
      codex: providerStatus.codex.authSession ?? prev.codex ?? null,
      claude: providerStatus.claude.authSession ?? prev.claude ?? null,
    }))
    setProviderInstallSessions(prev => ({
      codex: providerStatus.codex.installSession ?? prev.codex ?? null,
      claude: providerStatus.claude.installSession ?? prev.claude ?? null,
    }))
  }, [providerStatus])

  useEffect(() => {
    const unsubs = providerAuthUnsubsRef.current
    const activeSessions = [providerAuthSessions.codex, providerAuthSessions.claude]
      .filter((session): session is ProviderAuthSession => Boolean(session?.active))
    const activeIds = new Set(activeSessions.map((session) => session.sessionId))

    for (const [sessionId, unsubscribe] of [...unsubs.entries()]) {
      if (!activeIds.has(sessionId)) {
        unsubscribe()
        unsubs.delete(sessionId)
      }
    }

    for (const session of activeSessions) {
      if (unsubs.has(session.sessionId)) continue
      const unsubscribe = wsClient.subscribe(`provider-auth:${session.sessionId}`, (event: WsMessage) => {
        if (event.type === 'provider_auth:status') {
          const data = event.data as ProviderAuthSession
          if (!data?.sessionId || !data?.provider) return
          upsertProviderAuthSession(data)
          if (!data.active) void refreshProviderStatus()
          return
        }
        if (event.type === 'provider_auth:line') {
          const data = event.data as {
            sessionId: string
            provider: ProviderName
            id: number
            stream: 'stdout' | 'stderr' | 'system'
            text: string
            timestamp: string
            deviceCode?: string | null
            verificationUrl?: string | null
          }
          if (!data?.sessionId || !data?.provider) return
          setProviderAuthSessions(prev => {
            const current = prev[data.provider]
            if (!current || current.sessionId !== data.sessionId) return prev
            if (current.lines.some((line) => line.id === data.id)) return prev
            const nextLines = [...current.lines, {
              id: data.id,
              stream: data.stream,
              text: data.text,
              timestamp: data.timestamp,
            }]
            return {
              ...prev,
              [data.provider]: {
                ...current,
                updatedAt: data.timestamp,
                lines: nextLines.slice(-300),
                deviceCode: data.deviceCode ?? current.deviceCode,
                verificationUrl: data.verificationUrl ?? current.verificationUrl,
              },
            }
          })
        }
      })
      unsubs.set(session.sessionId, unsubscribe)
    }
  }, [
    providerAuthSessions.codex?.sessionId,
    providerAuthSessions.codex?.active,
    providerAuthSessions.claude?.sessionId,
    providerAuthSessions.claude?.active,
    refreshProviderStatus,
  ])

  useEffect(() => {
    const unsubs = providerInstallUnsubsRef.current
    const activeSessions = [providerInstallSessions.codex, providerInstallSessions.claude]
      .filter((session): session is ProviderInstallSession => Boolean(session?.active))
    const activeIds = new Set(activeSessions.map((session) => session.sessionId))

    for (const [sessionId, unsubscribe] of [...unsubs.entries()]) {
      if (!activeIds.has(sessionId)) {
        unsubscribe()
        unsubs.delete(sessionId)
      }
    }

    for (const session of activeSessions) {
      if (unsubs.has(session.sessionId)) continue
      const unsubscribe = wsClient.subscribe(`provider-install:${session.sessionId}`, (event: WsMessage) => {
        if (event.type === 'provider_install:status') {
          const data = event.data as ProviderInstallSession
          if (!data?.sessionId || !data?.provider) return
          upsertProviderInstallSession(data)
          if (!data.active) void refreshProviderStatus()
          return
        }
        if (event.type === 'provider_install:line') {
          const data = event.data as {
            sessionId: string
            provider: ProviderName
            id: number
            stream: 'stdout' | 'stderr' | 'system'
            text: string
            timestamp: string
          }
          if (!data?.sessionId || !data?.provider) return
          setProviderInstallSessions(prev => {
            const current = prev[data.provider]
            if (!current || current.sessionId !== data.sessionId) return prev
            if (current.lines.some((line) => line.id === data.id)) return prev
            const nextLines = [...current.lines, {
              id: data.id,
              stream: data.stream,
              text: data.text,
              timestamp: data.timestamp,
            }]
            return {
              ...prev,
              [data.provider]: {
                ...current,
                updatedAt: data.timestamp,
                lines: nextLines.slice(-300),
              },
            }
          })
        }
      })
      unsubs.set(session.sessionId, unsubscribe)
    }
  }, [
    providerInstallSessions.codex?.sessionId,
    providerInstallSessions.codex?.active,
    providerInstallSessions.claude?.sessionId,
    providerInstallSessions.claude?.active,
    refreshProviderStatus,
  ])

  useEffect(() => () => {
    const authUnsubs = providerAuthUnsubsRef.current
    for (const unsubscribe of authUnsubs.values()) unsubscribe()
    authUnsubs.clear()
    const installUnsubs = providerInstallUnsubsRef.current
    for (const unsubscribe of installUnsubs.values()) unsubscribe()
    installUnsubs.clear()
  }, [])

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

  async function handleSetWorkerModel(room: Room, workerModel: string): Promise<void> {
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
    if (queenModelBusyRoomId === room.id) return
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
    setQueenModelBusyRoomId(room.id)
    let persistedModel = false
    try {
      await api.workers.update(room.queenWorkerId, { model: dbModel })
      persistedModel = true
      const q = await api.rooms.queenStatus(room.id).catch(() => null)
      if (q) {
        setQueenModel(prev => ({ ...prev, [room.id]: q.model ?? null }))
        setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
      }
      if (!model.startsWith('ollama:')) {
        setQueenModelSetup(null)
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: null }))
      } else {
        const modelName = model.replace('ollama:', '')
        setQueenModelSetup({ roomId: room.id, phase: 'starting', startedAt: Date.now() })
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: 'Starting Ollama...' } }))
        const startResult = await api.ollama.start()
        if (!startResult.available) {
          throw new Error(`Ollama unavailable (${startResult.status})`)
        }
        setQueenModelSetup({ roomId: room.id, phase: 'installing', startedAt: Date.now() })
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: `Installing ${modelName}...` } }))
        await api.ollama.ensureModel(model)
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: { kind: 'success', text: `${modelName} is ready.` } }))
        const refreshed = await api.rooms.queenStatus(room.id).catch(() => null)
        if (refreshed) {
          setQueenModel(prev => ({ ...prev, [room.id]: refreshed.model ?? null }))
          setQueenAuth(prev => ({ ...prev, [room.id]: refreshed.auth }))
        }
      }
    } catch (e) {
      console.error('Failed to update queen model:', e)
      const rawMessage = e instanceof Error ? e.message : 'Failed to update queen model'
      const message = rawMessage.includes('Ollama unavailable')
        ? 'Ollama failed to start in time. Check installation and run `ollama serve`, then try again.'
        : rawMessage
      if (!persistedModel) {
        // Revert only when model save itself failed.
        setQueenModel(prev => ({ ...prev, [room.id]: prevModel }))
        setQueenAuth(prev => ({ ...prev, [room.id]: prevAuth }))
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
      } else {
        // Keep selected model; setup can be retried.
        setQueenModelFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: `Model saved, but setup failed: ${message}` } }))
      }
    } finally {
      setQueenModelSetup(null)
      if (persistedModel) {
        const q = await api.rooms.queenStatus(room.id).catch(() => null)
        if (q) {
          setQueenModel(prev => ({ ...prev, [room.id]: q.model ?? null }))
          setQueenAuth(prev => ({ ...prev, [room.id]: q.auth }))
        }
      }
      pendingModelUpdate.current = false
      setQueenModelBusyRoomId(null)
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

  async function handleProviderConnect(room: Room, provider: 'codex' | 'claude'): Promise<void> {
    setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: `Preparing ${provider} login...` } }))
    try {
      const response = await api.providers.connect(provider)
      upsertProviderAuthSession(response.session)
      await refreshProviderStatus()
      setProviderFeedback(prev => ({
        ...prev,
        [room.id]: {
          kind: 'success',
          text: response.reused
            ? `${provider} login is already running. Continue in the log panel below.`
            : `${provider} login started. Continue in the log panel below.`,
        },
      }))
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to connect ${provider}`
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
    }
  }

  async function handleProviderInstall(room: Room, provider: 'codex' | 'claude'): Promise<void> {
    setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: `Installing ${provider} CLI...` } }))
    try {
      const response = await api.providers.install(provider)
      if (response.session) {
        upsertProviderInstallSession(response.session)
      }
      await refreshProviderStatus()
      setProviderFeedback(prev => ({
        ...prev,
        [room.id]: {
          kind: 'success',
          text: response.status === 'already_installed'
            ? `${provider} CLI is already installed.`
            : response.reused
              ? `${provider} install is already running. Continue in the install log below.`
              : `${provider} install started. Continue in the install log below.`,
        },
      }))
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to install ${provider}`
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
    }
  }

  async function handleProviderDisconnect(room: Room, provider: 'codex' | 'claude'): Promise<void> {
    setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: `Disconnecting ${provider}...` } }))
    try {
      await api.providers.disconnect(provider)
      setProviderAuthSessions(prev => {
        const current = prev[provider]
        return { ...prev, [provider]: current ? { ...current, active: false } : null }
      })
      await refreshProviderStatus()
      setProviderFeedback(prev => ({
        ...prev,
        [room.id]: { kind: 'success', text: `${provider} disconnected.` },
      }))
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to disconnect ${provider}`
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
    }
  }

  async function handleProviderAuthCancel(room: Room, sessionId: string): Promise<void> {
    if (providerAuthBusySessionId === sessionId) return
    setProviderAuthBusySessionId(sessionId)
    setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: 'Canceling login flow...' } }))
    try {
      const response = await api.providers.cancelSession(sessionId)
      upsertProviderAuthSession(response.session)
      await refreshProviderStatus()
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'success', text: 'Login flow canceled.' } }))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to cancel login flow'
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
    } finally {
      setProviderAuthBusySessionId(null)
    }
  }

  async function handleProviderInstallCancel(room: Room, sessionId: string): Promise<void> {
    if (providerInstallBusySessionId === sessionId) return
    setProviderInstallBusySessionId(sessionId)
    setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'info', text: 'Canceling install flow...' } }))
    try {
      const response = await api.providers.cancelInstallSession(sessionId)
      upsertProviderInstallSession(response.session)
      await refreshProviderStatus()
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'success', text: 'Install flow canceled.' } }))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to cancel install flow'
      setProviderFeedback(prev => ({ ...prev, [room.id]: { kind: 'error', text: message } }))
    } finally {
      setProviderInstallBusySessionId(null)
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
  const hasQueenModelLoaded = Object.prototype.hasOwnProperty.call(queenModel, room.id)
  const isQueenModelBusy = queenModelBusyRoomId === room.id
  const queenModelValue = hasQueenModelLoaded ? (queenModel[room.id] ?? 'claude') : '__loading__'
  const queenModelSetupActive = isQueenModelBusy && queenModelSetup?.roomId === room.id && queenModelValue.startsWith('ollama:')
  const queenModelSetupElapsedMs = queenModelSetupActive ? Math.max(0, queenModelSetupTick - queenModelSetup.startedAt) : 0
  const queenModelSetupEstimateMs = queenModelSetup?.phase === 'starting' ? 30_000 : 180_000
  const queenModelSetupPct = queenModelSetupActive
    ? Math.min(95, Math.max(6, Math.round((queenModelSetupElapsedMs / queenModelSetupEstimateMs) * 100)))
    : 0
  const queenModelSetupLabel = queenModelSetup?.phase === 'starting' ? 'Starting Ollama' : `Installing ${queenModelValue.replace('ollama:', '')}`
  const elapsedSeconds = Math.floor(queenModelSetupElapsedMs / 1000)
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  const elapsedRemainderSeconds = elapsedSeconds % 60
  const elapsedText = `${elapsedMinutes}:${String(elapsedRemainderSeconds).padStart(2, '0')}`
  const showQueenSubscriptionStatus = activeQueenAuth?.provider === 'claude_subscription'
    || activeQueenAuth?.provider === 'codex_subscription'
    || (activeQueenAuth?.provider === 'ollama' && !activeQueenAuth.ready && !isQueenModelBusy)
  const queenSubscriptionProvider: 'codex' | 'claude' | null = activeQueenAuth?.provider === 'codex_subscription'
    ? 'codex'
    : activeQueenAuth?.provider === 'claude_subscription'
      ? 'claude'
      : null
  const queenSubscriptionStatus = queenSubscriptionProvider ? providerStatus?.[queenSubscriptionProvider] ?? null : null
  const queenProviderAuthSession = queenSubscriptionProvider
    ? (providerAuthSessions[queenSubscriptionProvider] ?? queenSubscriptionStatus?.authSession ?? null)
    : null
  const queenProviderInstallSession = queenSubscriptionProvider
    ? (providerInstallSessions[queenSubscriptionProvider] ?? queenSubscriptionStatus?.installSession ?? null)
    : null
  const queenProviderAuthBusy = queenProviderAuthSession
    ? providerAuthBusySessionId === queenProviderAuthSession.sessionId
    : false
  const queenProviderInstallBusy = queenProviderInstallSession
    ? providerInstallBusySessionId === queenProviderInstallSession.sessionId
    : false
  const queenProviderAuthRecentLines = queenProviderAuthSession?.lines.slice(-12) ?? []
  const queenProviderInstallRecentLines = queenProviderInstallSession?.lines.slice(-12) ?? []
  const queenModelOptions = [
    { value: 'claude', label: 'Claude Code (subscription)' },
    { value: 'claude-opus-4-6', label: 'Opus (subscription)' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet (subscription)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku (subscription)' },
    { value: 'codex', label: 'Codex (ChatGPT subscription)' },
    { value: 'openai:gpt-4o-mini', label: 'OpenAI API' },
    { value: 'anthropic:claude-3-5-sonnet-latest', label: 'Claude API' },
    ...FREE_OLLAMA_MODEL_OPTIONS.map((model) => ({ value: model.value, label: `${model.label} (Ollama, free)` })),
  ]
  if (!hasQueenModelLoaded) {
    queenModelOptions.unshift({ value: '__loading__', label: 'Loading...' })
  } else if (!queenModelOptions.some((option) => option.value === queenModelValue)) {
    queenModelOptions.unshift({ value: queenModelValue, label: `Current: ${queenModelValue}` })
  }
  const hasWorkerModelLoaded = typeof room.workerModel === 'string' && room.workerModel.trim().length > 0
  const workerModelValue = hasWorkerModelLoaded ? room.workerModel : '__loading__'
  const workerModelOptions = [
    { value: 'queen', label: 'Use queen model' },
    ...FREE_OLLAMA_MODEL_OPTIONS.map((model) => ({ value: model.value, label: `${model.label} (Ollama)` })),
  ]
  if (!hasWorkerModelLoaded) {
    workerModelOptions.unshift({ value: '__loading__', label: 'Loading...' })
  } else if (!workerModelOptions.some((option) => option.value === room.workerModel)) {
    workerModelOptions.unshift({ value: room.workerModel, label: `Current: ${room.workerModel}` })
  }

  const hasClaudeSubscription = providerStatus?.claude.connected === true
  const hasCodexSubscription = providerStatus?.codex.connected === true
  const currentIsCodex = queenModelValue === 'codex' || queenModelValue.startsWith('codex')
  const currentIsClaude = queenModelValue === 'claude' || queenModelValue.startsWith('claude')
  const recommendedQueenModel = currentIsCodex && hasCodexSubscription
    ? 'codex'
    : currentIsClaude && hasClaudeSubscription
      ? 'claude'
      : hasClaudeSubscription
        ? 'claude'
        : hasCodexSubscription
          ? 'codex'
          : null
  const recommendationLabel = recommendedQueenModel === 'claude'
    ? 'Claude subscription'
    : recommendedQueenModel === 'codex'
      ? 'Codex subscription'
      : queenModelValue.startsWith('ollama:')
        ? 'Free Ollama path'
        : activeQueenAuth?.mode === 'api'
          ? 'API key path'
          : 'Choose a setup path'
  const recommendationHint = recommendedQueenModel
    ? 'Subscription detected in this runtime. Subscription models are the fastest setup and usually the most stable for autonomous loops.'
    : activeQueenAuth?.mode === 'api'
      ? 'API model selected. Add and validate API key below to avoid queen auth failures.'
      : queenModelValue.startsWith('ollama:')
        ? 'Free setup path selected. First run can be slower while Ollama starts and model files are prepared.'
        : 'No subscription detected yet. Use API key models or free Ollama, or connect Claude/Codex in Status.'

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
  const inviteCodeChanged = editingInviteCode.trim() !== (room.inviteCode ?? '')

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

  async function handleSaveInviteCode(): Promise<void> {
    const trimmed = editingInviteCode.trim()
    if (trimmed === (room.inviteCode ?? '')) return
    optimistic(room.id, { inviteCode: trimmed || null })
    await api.rooms.update(room.id, { inviteCode: trimmed || null })
    refresh()
  }

  async function handleArchiveRoom(): Promise<void> {
    if (!window.confirm(`Archive "${room.name}"? This will stop the queen, cancel all stations, and hide the room.`)) return
    setArchiveBusy(true)
    setArchiveError(null)
    const issues: string[] = []
    try {
      // Stop the queen first so no new jobs are created during archival.
      try {
        await api.rooms.queenStop(room.id)
      } catch (err) {
        issues.push(`Failed to stop queen: ${getErrorMessage(err)}`)
      }

      // Delete all cloud stations to prevent lingering spend.
      try {
        const stations = await api.cloudStations.list(room.id)
        for (const station of stations) {
          const stationId = Number((station as Record<string, unknown>).id)
          if (!Number.isFinite(stationId)) continue
          try {
            await api.cloudStations.delete(room.id, stationId)
          } catch (err) {
            issues.push(`Station #${stationId}: ${getErrorMessage(err)}`)
          }
        }
      } catch (err) {
        issues.push(`Failed to list cloud stations: ${getErrorMessage(err)}`)
      }

      // Archive room (server also pauses agents).
      try {
        await api.rooms.update(room.id, { status: 'stopped' } as Record<string, unknown>)
      } catch (err) {
        issues.push(`Failed to archive room: ${getErrorMessage(err)}`)
      }

      await refresh()
      if (issues.length > 0) {
        setArchiveError(issues.join('\n'))
      }
    } finally {
      setArchiveBusy(false)
    }
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
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-text-secondary">Queen</h3>
              <button
                onClick={() => setShowSetupGuide(true)}
                className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover"
              >
                Setup guide
              </button>
            </div>
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
                <div className="flex flex-col items-end gap-1">
                  <Select
                    value={queenModelValue}
                    onChange={(v) => handleSetQueenModel(room, v)}
                    options={queenModelOptions}
                    disabled={isQueenModelBusy || !hasQueenModelLoaded}
                  />
                  {queenModelSetupActive && (
                    <div className="w-full max-w-[260px]">
                      <div className="flex items-center justify-between text-[11px] text-text-muted mb-1">
                        <span>{queenModelSetupLabel}</span>
                        <span>{queenModelSetupPct}% · {elapsedText}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-primary border border-border-primary overflow-hidden">
                        <div
                          className="h-full bg-interactive transition-[width] duration-500 ease-out"
                          style={{ width: `${queenModelSetupPct}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>,
                'LLM provider for the queen. Selecting an Ollama model will auto-install and start it if needed.'
              )}

              {row(
                'Recommended path',
                <span className={`text-xs font-medium ${recommendedQueenModel ? 'text-status-success' : 'text-status-warning'}`}>
                  {recommendationLabel}
                </span>,
                recommendationHint
              )}

              <div className="py-2">
                <p className="text-xs text-text-muted leading-relaxed">
                  <span className="font-medium text-text-secondary">Setup outcomes:</span>{' '}
                  Subscription models usually give best quality with lowest setup friction.
                  API models are good for strict key-based billing.
                  Ollama is free and fully self-hosted, but quality and speed depend on local/server hardware.
                </p>
              </div>

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
              {showQueenSubscriptionStatus && (
                row('Status',
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs ${
                      queenSubscriptionStatus?.installed
                        ? queenSubscriptionStatus.connected === true
                          ? 'text-status-success'
                          : 'text-text-muted'
                        : 'text-status-warning'
                    }`}>
                      {activeQueenAuth.provider === 'claude_subscription' && (
                        queenSubscriptionStatus == null
                          ? 'Checking Claude status...'
                          : queenSubscriptionStatus.installed
                          ? queenSubscriptionStatus.connected === true
                            ? 'Claude connected'
                            : queenSubscriptionStatus.connected === false
                              ? 'Claude disconnected'
                              : 'Claude auth status unknown'
                          : 'Claude CLI not installed'
                      )}
                      {activeQueenAuth.provider === 'codex_subscription' && (
                        queenSubscriptionStatus == null
                          ? 'Checking Codex status...'
                          : queenSubscriptionStatus.installed
                          ? queenSubscriptionStatus.connected === true
                            ? 'Codex connected'
                            : queenSubscriptionStatus.connected === false
                              ? 'Codex disconnected'
                              : 'Codex auth status unknown'
                          : 'Codex CLI not installed'
                      )}
                      {activeQueenAuth.provider === 'ollama' && 'Ollama unavailable'}
                    </span>
                    {queenSubscriptionProvider && !queenSubscriptionStatus?.installed && (
                      <button
                        onClick={() => { void handleProviderInstall(room, queenSubscriptionProvider) }}
                        className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={queenProviderInstallSession?.active || queenProviderInstallBusy}
                      >
                        {queenProviderInstallSession?.active ? 'Installing...' : 'Install'}
                      </button>
                    )}
                    {queenSubscriptionProvider && queenSubscriptionStatus?.installed && (
                      <>
                        <button
                          onClick={() => { void handleProviderConnect(room, queenSubscriptionProvider) }}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={queenProviderAuthSession?.active || queenProviderInstallSession?.active}
                        >
                          Connect
                        </button>
                        <button
                          onClick={() => { void handleProviderDisconnect(room, queenSubscriptionProvider) }}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover"
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                    {activeQueenAuth.provider === 'ollama' && queenModelValue.startsWith('ollama:') && (
                      <button
                        onClick={() => { void handleSetQueenModel(room, queenModelValue) }}
                        disabled={isQueenModelBusy}
                        className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                      >
                        Retry setup
                      </button>
                    )}
                  </div>
                )
              )}
              {showQueenSubscriptionStatus && queenSubscriptionProvider && queenProviderInstallSession && (
                row('Install flow',
                  <div className="w-full max-w-[360px] space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs ${
                        queenProviderInstallSession.status === 'completed'
                          ? 'text-status-success'
                          : queenProviderInstallSession.status === 'failed' || queenProviderInstallSession.status === 'timeout'
                            ? 'text-status-error'
                            : 'text-text-muted'
                      }`}>
                        {providerInstallStatusLabel(queenProviderInstallSession.status)}
                      </span>
                      {queenProviderInstallSession.active && (
                        <button
                          onClick={() => { void handleProviderInstallCancel(room, queenProviderInstallSession.sessionId) }}
                          disabled={queenProviderInstallBusy}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {queenProviderInstallBusy ? 'Canceling...' : 'Cancel'}
                        </button>
                      )}
                      {!queenProviderInstallSession.active && (
                        <button
                          onClick={() => { void refreshProviderStatus() }}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover"
                        >
                          Refresh
                        </button>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary p-2 font-mono text-[11px] text-text-muted">
                      {queenProviderInstallRecentLines.length === 0
                        ? 'Waiting for install output...'
                        : queenProviderInstallRecentLines.map((line) => (
                            <div key={line.id} className="whitespace-pre-wrap break-words">
                              {line.text}
                            </div>
                          ))}
                    </div>
                  </div>,
                  'Installs provider CLI in the runtime and streams progress output.'
                )
              )}
              {showQueenSubscriptionStatus && queenSubscriptionProvider && queenProviderAuthSession && (
                row('Login flow',
                  <div className="w-full max-w-[360px] space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs ${
                        queenProviderAuthSession.status === 'completed'
                          ? 'text-status-success'
                          : queenProviderAuthSession.status === 'failed' || queenProviderAuthSession.status === 'timeout'
                            ? 'text-status-error'
                            : 'text-text-muted'
                      }`}>
                        {providerAuthStatusLabel(queenProviderAuthSession.status)}
                      </span>
                      {queenProviderAuthSession.active && (
                        <button
                          onClick={() => { void handleProviderAuthCancel(room, queenProviderAuthSession.sessionId) }}
                          disabled={queenProviderAuthBusy}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {queenProviderAuthBusy ? 'Canceling...' : 'Cancel'}
                        </button>
                      )}
                      {!queenProviderAuthSession.active && (
                        <button
                          onClick={() => { void refreshProviderStatus() }}
                          className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover"
                        >
                          Refresh
                        </button>
                      )}
                    </div>
                    {queenProviderAuthSession.deviceCode && (
                      <div className="text-xs text-text-secondary">
                        Code: <code className="px-1 py-0.5 rounded bg-surface-primary border border-border-primary">{queenProviderAuthSession.deviceCode}</code>
                      </div>
                    )}
                    {queenProviderAuthSession.verificationUrl && (
                      <a
                        href={queenProviderAuthSession.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-interactive hover:underline break-all inline-block"
                      >
                        Open verification page
                      </a>
                    )}
                    <div className="max-h-32 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary p-2 font-mono text-[11px] text-text-muted">
                      {queenProviderAuthRecentLines.length === 0
                        ? 'Waiting for login output...'
                        : queenProviderAuthRecentLines.map((line) => (
                            <div key={line.id} className="whitespace-pre-wrap break-words">
                              {line.text}
                            </div>
                          ))}
                    </div>
                  </div>,
                  'Runs provider CLI login in the runtime and streams device-code output.'
                )
              )}
              {queenModelFeedback[room.id] && (
                <div className={`text-xs mt-1 ${
                  queenModelFeedback[room.id]?.kind === 'success'
                    ? 'text-status-success'
                    : queenModelFeedback[room.id]?.kind === 'error'
                      ? 'text-status-error'
                      : 'text-text-muted'
                }`}>
                  {queenModelFeedback[room.id]?.text}
                </div>
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
              {providerFeedback[room.id] && (
                <div className={`text-xs mt-1 ${
                  providerFeedback[room.id]?.kind === 'success'
                    ? 'text-status-success'
                    : providerFeedback[room.id]?.kind === 'error'
                      ? 'text-status-error'
                      : 'text-text-muted'
                }`}>
                  {providerFeedback[room.id]?.text}
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
                  <div className="flex gap-2">
                    <a
                      href={`/api/rooms/${roomId}/wallet/onramp-redirect?token=${encodeURIComponent(getCachedToken() ?? '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 py-2 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors no-underline"
                    >
                      Top Up from Card
                    </a>
                    <button
                      onClick={() => setShowCryptoTopUp(true)}
                      className="flex-1 py-2 text-sm font-medium text-center text-text-primary bg-surface-tertiary hover:bg-surface-hover rounded-lg transition-colors"
                    >
                      Top Up with Crypto
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Workers */}
          <div>
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Workers</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3">
              {row('Model',
                <Select
                  value={workerModelValue}
                  onChange={(value) => handleSetWorkerModel(room, value)}
                  options={workerModelOptions}
                  disabled={!hasWorkerModelLoaded}
                />,
                'Choose worker model. "Use queen model" inherits whatever queen uses; Ollama worker models run on stations.'
              )}
            </div>
          </div>

          {/* Visibility */}
          <div>
            <h3 className="text-sm font-semibold text-text-secondary mb-1">Visibility</h3>
            <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-3">
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
              <div className="py-1">
                <label className="block text-sm text-text-secondary mb-1">Referral Code</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editingInviteCode}
                    onChange={e => setEditingInviteCode(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleSaveInviteCode() }}
                    onBlur={() => void handleSaveInviteCode()}
                    placeholder="Enter invite code"
                    className="flex-1 px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
                  />
                  {inviteCodeChanged && (
                    <button
                      onClick={() => void handleSaveInviteCode()}
                      className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors"
                    >
                      Save
                    </button>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">Links this room to a referrer's network</p>
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
          {archiveError && (
            <p className="text-xs text-status-error mt-2 break-words whitespace-pre-line">
              Archived with issues: {archiveError}
            </p>
          )}
        </div>
      </div>

      {showSetupGuide && (
        <RoomSetupGuideModal
          roomName={room.name}
          currentModel={queenModelValue}
          claude={providerStatus?.claude ? { installed: providerStatus.claude.installed, connected: providerStatus.claude.connected } : null}
          codex={providerStatus?.codex ? { installed: providerStatus.codex.installed, connected: providerStatus.codex.connected } : null}
          queenAuth={activeQueenAuth}
          onApplyModel={async (model) => {
            await handleSetQueenModel(room, model)
          }}
          onClose={() => setShowSetupGuide(false)}
        />
      )}

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

      {showCryptoTopUp && wallet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) setShowCryptoTopUp(false) }}
        >
          <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 relative">
            <button
              onClick={() => setShowCryptoTopUp(false)}
              className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
              aria-label="Close"
            >
              {'\u2715'}
            </button>
            <h2 className="text-lg font-bold text-text-primary mb-4">Top Up with Crypto</h2>
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Send USDC or USDT to the wallet address below. The balance updates automatically.
              </p>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Wallet address</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-text-primary font-mono truncate flex-1">{wallet.address}</code>
                  <CopyAddressButton address={wallet.address} />
                </div>
              </div>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Supported chains</div>
                <div className="text-sm text-text-primary">Base, Ethereum, Arbitrum, Optimism, Polygon</div>
              </div>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Supported tokens</div>
                <div className="text-sm text-text-primary">USDC, USDT</div>
              </div>
              <p className="text-xs text-text-muted">
                Same address works on all EVM chains. Send from any exchange or wallet. Balance is aggregated across all networks.
              </p>
              <button
                onClick={() => setShowCryptoTopUp(false)}
                className="w-full py-2 text-sm font-medium text-center text-text-primary bg-surface-tertiary hover:bg-surface-hover rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
