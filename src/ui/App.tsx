import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getToken, clearToken, API_BASE, APP_MODE, isLocalHost } from './lib/auth'
import { TabBar, mainTabs, tabIcons, type Tab } from './components/TabBar'
import { StatusPanel } from './components/StatusPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { WorkersPanel } from './components/WorkersPanel'
import { TasksPanel } from './components/TasksPanel'
import { WatchesPanel } from './components/WatchesPanel'
import { ResultsPanel } from './components/ResultsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { HelpPanel } from './components/HelpPanel'
import { GoalsPanel } from './components/GoalsPanel'
import { VotesPanel } from './components/VotesPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { MessagesPanel } from './components/MessagesPanel'
import { CredentialsPanel } from './components/CredentialsPanel'
import { TransactionsPanel } from './components/TransactionsPanel'
import { StationsPanel } from './components/StationsPanel'
import { RoomSettingsPanel } from './components/RoomSettingsPanel'
import { SwarmPanel } from './components/SwarmPanel'
import { ChatPanel } from './components/ChatPanel'
import { ClerkPanel } from './components/ClerkPanel'
import { ConnectPage } from './components/ConnectPage'
import { WalkthroughModal } from './components/WalkthroughModal'
import { UpdateModal } from './components/UpdateModal'
import { CreateRoomModal } from './components/CreateRoomModal'
import { KeepInDockModal } from './components/KeepInDockModal'
import { ContactPromptModal, CONTACT_PROMPT_SEEN_KEY } from './components/ContactPromptModal'
import { useNotifications } from './hooks/useNotifications'
import { semverGt } from './lib/releases'
import { useInstallPrompt } from './hooks/useInstallPrompt'
import { useDocumentVisible } from './hooks/useDocumentVisible'
import { api } from './lib/client'
import { wsClient, type WsMessage } from './lib/ws'
import {
  ROOM_BADGE_EVENT_TYPES,
  ROOM_BALANCE_EVENT_TYPES,
  ROOMS_QUEEN_STATE_EVENT,
} from './lib/room-events'
import { storageGet, storageSet, storageRemove } from './lib/storage'
import type { Room } from '@shared/types'

const ADVANCED_TABS = new Set<Tab>(
  mainTabs.filter((tab) => tab.advanced).map((tab) => tab.id)
)

const ALL_TAB_IDS: Tab[] = ['clerk', 'swarm', 'status', 'chat', 'goals', 'votes', 'messages', 'workers', 'tasks', 'skills', 'credentials', 'transactions', 'stations', 'room-settings', 'memory', 'watches', 'results', 'settings', 'help']

const DEFAULT_PORT = '3700'
const KEEP_IN_DOCK_TIP_PENDING_KEY = 'quoroom_keep_in_dock_tip_pending'
const KEEP_IN_DOCK_TIP_SEEN_KEY = 'quoroom_keep_in_dock_tip_seen'
const isRemoteOrigin = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
const shouldProbeLocalServer = APP_MODE === 'local' && isRemoteOrigin

function getLocalPort(): string {
  return storageGet('quoroom_port') || DEFAULT_PORT
}

function parseCreatedRoomId(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.id === 'number') return record.id
  if (record.room && typeof record.room === 'object') {
    const nestedId = (record.room as Record<string, unknown>).id
    if (typeof nestedId === 'number') return nestedId
  }
  return null
}

function isDevDbPath(dbPath: string | undefined): boolean {
  if (!dbPath) return false
  return dbPath.replace(/\\/g, '/').toLowerCase().includes('/.quoroom-dev/')
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatRoomModel(model: string | null | undefined): string {
  if (!model) return ''
  if (model === 'claude') return 'Claude'
  if (model === 'codex') return 'Codex'
  const idx = model.indexOf(':')
  if (idx === -1) return model
  const provider = model.slice(0, idx)
  const modelName = model.slice(idx + 1)
  const providerLabel = provider === 'openai'
    ? 'OpenAI'
    : provider === 'anthropic'
      ? 'Anthropic'
      : provider
  return `${providerLabel}/${modelName}`
}

async function probeLocalServer(port: string): Promise<boolean> {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`]

  for (const origin of origins) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${origin}/api/status`, { signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok) {
        const currentOrigin = window.location.origin.replace(/\/+$/, '')
        if (currentOrigin !== origin) {
          window.location.href = `${origin}${window.location.pathname}${window.location.search}${window.location.hash}`
        }
        return true
      }
    } catch {
      // Try next loopback origin.
    }
  }
  return false
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('clerk')
  const tabRef = useRef(tab)
  const [advancedMode, setAdvancedMode] = useState(false)
  const [autonomyMode, setAutonomyMode] = useState<'auto' | 'semi'>('auto')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startupRetrying, setStartupRetrying] = useState(false)
  const [authAttemptKey, setAuthAttemptKey] = useState(0)
  const [restartingServer, setRestartingServer] = useState(false)

  // Global room selection
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(() => {
    const saved = storageGet('quoroom_room')
    return saved ? Number(saved) : null
  })
  const [expandedRoomId, setExpandedRoomId] = useState<number | null>(() => {
    const saved = storageGet('quoroom_room')
    return saved ? Number(saved) : null
  })
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomsLoaded, setRoomsLoaded] = useState(false)
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false)
  const [swarmInviteNonce, setSwarmInviteNonce] = useState(0)

  const [messagesUnread, setMessagesUnread] = useState(0)
  const [votesActive, setVotesActive] = useState(0)
  const [totalBalance, setTotalBalance] = useState<number | null>(null)
  const [roomBalances, setRoomBalances] = useState<Record<number, number | null>>({})
  const [queenModels, setQueenModels] = useState<Record<number, string | null>>({})

  useNotifications()
  const installPrompt = useInstallPrompt()
  const isVisible = useDocumentVisible()
  const [installDismissed, setInstallDismissed] = useState(() => storageGet('quoroom_install_dismissed') === 'true')

  const [showKeepInDockTip, setShowKeepInDockTip] = useState(false)
  const [showWalkthrough, setShowWalkthrough] = useState(() => !storageGet('quoroom_walkthrough_seen'))
  const [showContactPrompt, setShowContactPrompt] = useState(false)
  const [contactPromptNeeded, setContactPromptNeeded] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [clerkSetupLaunchKey, setClerkSetupLaunchKey] = useState(0)

  // Update check — fetch /api/status once on startup (and every 30 min) to detect new releases
  const [serverUpdateInfo, setServerUpdateInfo] = useState<{
    currentVersion: string
    latestVersion: string
    releaseUrl: string
    assets: { mac: string | null; windows: string | null; linux: string | null }
    readyUpdateVersion: string | null
  } | null>(null)
  const [devDbBanner, setDevDbBanner] = useState<{ dbPath: string; dataDir?: string } | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // Remote origin gate: 'probing' → 'connect' or redirect to localhost
  const [gate, setGate] = useState<'probing' | 'connect' | 'app'>(() =>
    shouldProbeLocalServer ? 'probing' : 'app'
  )

  // Remote origin: probe localhost and redirect or show connect page
  useEffect(() => {
    if (!shouldProbeLocalServer) return
    if (gate !== 'probing') return
    probeLocalServer(getLocalPort()).then((redirected) => {
      if (!redirected) setGate('connect')
    })
  }, [gate])

  useEffect(() => {
    if (installPrompt.installSignal <= 0) return
    if (storageGet(KEEP_IN_DOCK_TIP_SEEN_KEY) === 'true') return
    storageSet(KEEP_IN_DOCK_TIP_PENDING_KEY, 'true')
  }, [installPrompt.installSignal])

  useEffect(() => {
    if (installPrompt.isInstalled) return
    // Uninstall can leave origin storage behind; reset so reinstall can show tip.
    storageRemove(KEEP_IN_DOCK_TIP_SEEN_KEY)
    storageRemove(KEEP_IN_DOCK_TIP_PENDING_KEY)
  }, [installPrompt.isInstalled])

  useEffect(() => {
    if (!installPrompt.isInstalled) return
    if (storageGet(KEEP_IN_DOCK_TIP_SEEN_KEY) === 'true') return
    if (storageGet(KEEP_IN_DOCK_TIP_PENDING_KEY) !== 'true') return
    setShowKeepInDockTip(true)
  }, [installPrompt.isInstalled])

  const fetchRoomBadges = useCallback(async (): Promise<void> => {
    if (!ready || expandedRoomId === null) {
      setMessagesUnread(0)
      setVotesActive(0)
      return
    }
    try {
      const badges = await api.rooms.badges(expandedRoomId)
      if (tabRef.current !== 'messages') setMessagesUnread(badges.pendingEscalations + badges.unreadMessages)
      setVotesActive(badges.activeVotes)
    } catch {
      // ignore polling noise
    }
  }, [expandedRoomId, ready])

  // Fallback poll for sidebar badges (room message/escalation/vote counts).
  useEffect(() => {
    if (!ready || expandedRoomId === null) {
      setMessagesUnread(0)
      setVotesActive(0)
      return
    }
    void fetchRoomBadges().catch(() => {})
    const interval = setInterval(() => { void fetchRoomBadges().catch(() => {}) }, 60000)
    return () => clearInterval(interval)
  }, [expandedRoomId, fetchRoomBadges, ready])

  const fetchTotalBalance = useCallback(async (): Promise<void> => {
    if (!ready || rooms.length === 0) {
      setTotalBalance(null)
      setRoomBalances({})
      return
    }
    try {
      const wallets = await Promise.all(
        rooms.map(r => api.wallet.get(r.id).catch(() => null))
      )
      const nextBalances: Record<number, number | null> = {}
      rooms.forEach((room, idx) => {
        if (!wallets[idx]) nextBalances[room.id] = null
      })
      const roomsWithWallets = rooms.filter((_, i) => wallets[i] !== null)
      if (roomsWithWallets.length === 0) {
        setTotalBalance(null)
        setRoomBalances(nextBalances)
        return
      }
      const results = await Promise.all(
        roomsWithWallets.map(r => api.wallet.balance(r.id).catch(() => null))
      )
      roomsWithWallets.forEach((room, idx) => {
        nextBalances[room.id] = results[idx]?.totalBalance ?? 0
      })
      const sum = Object.values(nextBalances).reduce((acc, b) => acc + (b ?? 0), 0)
      setRoomBalances(nextBalances)
      setTotalBalance(sum > 0 ? sum : null)
    } catch {
      // ignore polling noise
    }
  }, [ready, rooms])

  // Fallback poll for total on-chain balance across all rooms.
  useEffect(() => {
    if (!ready || rooms.length === 0) {
      setTotalBalance(null)
      return
    }
    void fetchTotalBalance().catch(() => {})
    const interval = setInterval(() => { void fetchTotalBalance().catch(() => {}) }, 60000)
    return () => clearInterval(interval)
  }, [fetchTotalBalance, ready, rooms.length])

  useEffect(() => {
    if (!ready || expandedRoomId === null) return
    return wsClient.subscribe(`room:${expandedRoomId}`, (event: WsMessage) => {
      if (ROOM_BADGE_EVENT_TYPES.has(event.type)) {
        void fetchRoomBadges()
      }
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void fetchTotalBalance()
      }
    })
  }, [expandedRoomId, fetchRoomBadges, fetchTotalBalance, ready])

  const fetchSelectedQueenModel = useCallback(async (): Promise<void> => {
    if (!ready || selectedRoomId === null) return
    try {
      const q = await api.rooms.queenStatus(selectedRoomId)
      setQueenModels(prev => ({ ...prev, [selectedRoomId]: q?.model ?? null }))
    } catch {
      // keep previous value on transient failures
    }
  }, [ready, selectedRoomId])

  useEffect(() => {
    if (!ready || selectedRoomId === null) return
    void fetchSelectedQueenModel()
    const interval = setInterval(() => { void fetchSelectedQueenModel() }, 60000)
    return () => clearInterval(interval)
  }, [fetchSelectedQueenModel, ready, selectedRoomId])

  // Local origin: auth flow with auto-retry for server startup
  useEffect(() => {
    if (gate !== 'app') return
    let cancelled = false
    const MAX_RETRIES = 6
    const RETRY_DELAY = 3000

    async function attemptAuth(retriesLeft: number): Promise<void> {
      try {
        await getToken()
        if (!cancelled) {
          setStartupRetrying(false)
          setReady(true)
        }
      } catch (err) {
        if (cancelled) return
        if (retriesLeft > 0) {
          setStartupRetrying(true)
          await new Promise(r => setTimeout(r, RETRY_DELAY))
          if (!cancelled) await attemptAuth(retriesLeft - 1)
        } else {
          setStartupRetrying(false)
          setError(err instanceof Error ? err.message : 'Auth failed')
        }
      }
    }

    void attemptAuth(MAX_RETRIES)
    return () => { cancelled = true }
  }, [gate, authAttemptKey])

  useEffect(() => {
    if (gate !== 'app') return
    api.settings.get('advanced_mode').then((v) => {
      setAdvancedMode(v === 'true')
    }).catch(() => {})
  }, [gate])

  // Contact prompt — check if user has any verified contacts
  useEffect(() => {
    if (gate !== 'app' || !ready) return
    if (storageGet(CONTACT_PROMPT_SEEN_KEY)) return
    api.contacts.status().then((status) => {
      const hasVerified = status.email.verified || status.telegram.verified
      if (hasVerified) {
        storageSet(CONTACT_PROMPT_SEEN_KEY, '1')
        return
      }
      setContactPromptNeeded(true)
      if (!showWalkthrough) {
        setShowContactPrompt(true)
      }
    }).catch(() => {})
  }, [gate, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // Global Clerk presence heartbeat while the app page is visible (all tabs).
  useEffect(() => {
    if (gate !== 'app' || !ready || !isVisible) return
    void api.clerk.presence().catch(() => {})
    const interval = window.setInterval(() => {
      void api.clerk.presence().catch(() => {})
    }, 30_000)
    return () => window.clearInterval(interval)
  }, [gate, ready, isVisible])

  useEffect(() => {
    if (gate !== 'app' || !ready) return
    function checkStatus(): void {
      api.status.getParts(['storage', 'update']).then((status) => {
        const isDevDb = (status.deploymentMode ?? 'local') === 'local' && isDevDbPath(status.dbPath)
        if (isDevDb) {
          setDevDbBanner({ dbPath: status.dbPath, dataDir: status.dataDir })
        } else {
          setDevDbBanner(null)
        }

        const ui = status.updateInfo
        if (!ui) return
        if (!semverGt(ui.latestVersion, status.version)) return
        const dismissed = storageGet('quoroom_update_dismissed')
        if (dismissed === ui.latestVersion) return
        setServerUpdateInfo({
          currentVersion: status.version,
          latestVersion: ui.latestVersion,
          releaseUrl: ui.releaseUrl,
          assets: ui.assets,
          readyUpdateVersion: (status as Record<string, unknown>).readyUpdateVersion as string | null ?? null,
        })
      }).catch(() => {})
    }
    checkStatus()
    const interval = setInterval(checkStatus, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [gate, ready])

  const syncRooms = useCallback((r: Room[]): void => {
    setRooms(r)

    const selectableRooms = r.filter(room => room.status !== 'stopped')
    const fallbackRoomId = selectableRooms[0]?.id ?? null
    const selectedStillSelectable = selectedRoomId !== null && selectableRooms.some(room => room.id === selectedRoomId)

    if (selectedRoomId === null) {
      if (fallbackRoomId !== null) {
        handleRoomChange(fallbackRoomId)
      }
    } else if (!selectedStillSelectable) {
      handleRoomChange(fallbackRoomId)
    }

    setExpandedRoomId(prev => {
      if (prev !== null && selectableRooms.some(room => room.id === prev)) {
        return prev
      }
      if (selectedStillSelectable && selectedRoomId !== null) {
        return selectedRoomId
      }
      return fallbackRoomId
    })
  }, [selectedRoomId])

  const refreshQueenStates = useCallback(async (): Promise<void> => {
    if (!ready) return
    try {
      const states = await api.rooms.queenStates()
      setQueenRunning(states)
    } catch {
      // ignore polling noise
    }
  }, [ready])

  const loadRooms = useCallback(async (): Promise<void> => {
    try {
      const nextRooms = await api.rooms.list()
      syncRooms(nextRooms)
      setRoomsLoaded(true)
      void refreshQueenStates()
    } catch {
      // ignore polling noise
    }
  }, [refreshQueenStates, syncRooms])

  useEffect(() => {
    if (!ready) return
    setRoomsLoaded(false)
    void loadRooms()
    const interval = setInterval(() => { void loadRooms() }, 60000)
    return () => clearInterval(interval)
  }, [loadRooms, ready])

  useEffect(() => {
    if (!ready) return
    let roomsRefreshTimer: number | null = null
    const scheduleRoomsReload = (): void => {
      if (roomsRefreshTimer) window.clearTimeout(roomsRefreshTimer)
      roomsRefreshTimer = window.setTimeout(() => {
        roomsRefreshTimer = null
        void loadRooms()
      }, 200)
    }
    const unsubscribe = wsClient.subscribe('rooms', (event: WsMessage) => {
      if (event.type === ROOMS_QUEEN_STATE_EVENT) {
        const payload = event.data as { roomId?: number; running?: boolean }
        if (typeof payload.roomId === 'number' && typeof payload.running === 'boolean') {
          setQueenRunning(prev => ({ ...prev, [payload.roomId]: payload.running }))
          return
        }
      }
      scheduleRoomsReload()
    })
    return () => {
      unsubscribe()
      if (roomsRefreshTimer) window.clearTimeout(roomsRefreshTimer)
    }
  }, [loadRooms, ready])

  useEffect(() => {
    const room = rooms.find(r => r.id === selectedRoomId)
    if (room) setAutonomyMode(room.autonomyMode)
  }, [selectedRoomId, rooms])

  function handleTabChange(t: Tab): void {
    setTab(t)
    tabRef.current = t
    storageSet('quoroom_tab', t)
    if (t === 'messages') {
      setMessagesUnread(0)
      if (selectedRoomId !== null) void api.roomMessages.markAllRead(selectedRoomId).catch(() => {})
    }
    setSidebarOpen(false)
  }

  function handleAdvancedModeChange(enabled: boolean): void {
    setAdvancedMode(enabled)
    if (!enabled && ADVANCED_TABS.has(tab)) {
      handleTabChange('status')
    }
  }

  function handleRoomChange(roomId: number | null): void {
    setSelectedRoomId(roomId)
    if (roomId !== null) {
      storageSet('quoroom_room', String(roomId))
    } else {
      storageRemove('quoroom_room')
    }
  }

  function handleRoomToggle(roomId: number): void {
    const next = expandedRoomId === roomId ? null : roomId
    setExpandedRoomId(next)
    if (next !== null) handleRoomChange(next)
    else setSidebarOpen(false)
  }

  function handleRoomTabClick(roomId: number, t: Tab): void {
    handleRoomChange(roomId)
    setExpandedRoomId(roomId)
    handleTabChange(t)
  }

  function handleOpenInvite(): void {
    handleTabChange('swarm')
    setSwarmInviteNonce(prev => prev + 1)
  }

  async function handleRoomCreated(created: Room): Promise<void> {
    const createdRoomId = parseCreatedRoomId(created)
    const nextRooms = await api.rooms.list()
    syncRooms(nextRooms)
    void refreshQueenStates()

    const resolvedRoomId = createdRoomId
      ?? [...nextRooms].reverse().find(r => r.name === created.name)?.id
      ?? null
    if (resolvedRoomId !== null) {
      handleRoomChange(resolvedRoomId)
      setExpandedRoomId(resolvedRoomId)
      // Trigger room-setup popup flow once after creating a room.
      storageSet('quoroom_setup_flow_room', String(resolvedRoomId))
    }
    handleTabChange('room-settings')
    setShowCreateRoomModal(false)
  }

  const selectedRoom = rooms.find(r => r.id === selectedRoomId) ?? null
  const selectedRoomModel = selectedRoom ? queenModels[selectedRoom.id] ?? null : null
  const selectedRoomBalance = selectedRoom ? roomBalances[selectedRoom.id] ?? null : null
  const activeRooms = useMemo(() => rooms.filter(r => r.status !== 'stopped'), [rooms])

  function renderPanel(): React.JSX.Element {
    switch (tab) {
      case 'swarm':
        return <SwarmPanel rooms={activeRooms} queenRunning={queenRunning} forcedInviteOpenNonce={swarmInviteNonce} onNavigateToRoom={(roomId) => {
          handleRoomChange(roomId)
          setExpandedRoomId(roomId)
          handleTabChange('status')
        }} />
      case 'clerk':
        return <ClerkPanel setupLaunchKey={clerkSetupLaunchKey} />
      case 'status':
        return <StatusPanel onNavigate={(t) => handleTabChange(t as Tab)} advancedMode={advancedMode} roomId={selectedRoomId} />
      case 'chat':
        return <ChatPanel roomId={selectedRoomId} />
      case 'goals':
        return <GoalsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'votes':
        return <VotesPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'messages':
        return <MessagesPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'memory':
        return <MemoryPanel roomId={selectedRoomId} />
      case 'workers':
        return <WorkersPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'tasks':
        return <TasksPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'skills':
        return <SkillsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'credentials':
        return <CredentialsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'transactions':
        return <TransactionsPanel roomId={selectedRoomId} />
      case 'stations':
        return <StationsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} queenModel={selectedRoom ? (queenModels[selectedRoom.id] ?? null) : null} workerModel={selectedRoom?.workerModel ?? null} />
      case 'room-settings':
        return <RoomSettingsPanel roomId={selectedRoomId} />
      case 'watches':
        return <WatchesPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'results':
        return <ResultsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'settings':
        return <SettingsPanel advancedMode={advancedMode} onAdvancedModeChange={handleAdvancedModeChange} installPrompt={installPrompt} onNavigate={(t) => handleTabChange(t as Tab)} />
      case 'help':
        return <HelpPanel installPrompt={installPrompt} onStartWalkthrough={() => setShowWalkthrough(true)} />
      default:
        return <StatusPanel onNavigate={(t) => handleTabChange(t as Tab)} advancedMode={advancedMode} roomId={selectedRoomId} />
    }
  }

  function handleRetryAuth(): void {
    setError(null)
    setRestartingServer(false)
    setStartupRetrying(false)
    clearToken()
    setAuthAttemptKey(k => k + 1)
  }

  async function handleRestartServer(): Promise<void> {
    if (!isLocalHost()) return
    setRestartingServer(true)
    try {
      const res = await fetch(`${API_BASE}/api/server/restart`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Allow process shutdown and relaunch before retrying handshake.
      setTimeout(() => {
        handleRetryAuth()
      }, 1800)
    } catch {
      setRestartingServer(false)
      setError('Restart could not be triggered. Run "quoroom serve" in terminal, then Retry.')
    }
  }

  function handleDismissKeepInDockTip(): void {
    setShowKeepInDockTip(false)
    storageSet(KEEP_IN_DOCK_TIP_SEEN_KEY, 'true')
    storageRemove(KEEP_IN_DOCK_TIP_PENDING_KEY)
  }

  if (gate === 'probing') {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center">
        <div className="text-text-muted text-sm">Connecting to your local server...</div>
      </div>
    )
  }

  if (gate === 'connect') {
    return (
      <ConnectPage
        port={getLocalPort()}
        onRetry={() => setGate('probing')}
      />
    )
  }

  if (error) {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center px-4">
        <div className="text-status-error text-sm mb-1">Connection failed</div>
        <div className="text-text-muted text-xs mb-3">{error}</div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRetryAuth}
            className="text-sm px-3 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
          >
            Retry
          </button>
          {isLocalHost() && (
            <button
              onClick={() => void handleRestartServer()}
              disabled={restartingServer}
              className="text-sm px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:text-text-primary hover:border-interactive transition-colors disabled:opacity-40"
            >
              {restartingServer ? 'Restarting...' : 'Restart'}
            </button>
          )}
        </div>
        <button
          onClick={() => window.open('mailto:hello@email.quoroom.ai?subject=Connection issue&body=I am having trouble connecting to Quoroom.')}
          className="mt-3 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          Email Developer
        </button>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center">
        <span className="w-4 h-4 rounded-full border-2 border-border-primary border-t-interactive animate-spin mb-3" />
        <div className="text-text-muted text-sm">
          {startupRetrying ? 'Waiting for server to start...' : 'Connecting...'}
        </div>
      </div>
    )
  }

  const visibleTabs = advancedMode ? mainTabs : mainTabs.filter(t => !t.advanced)

  return (
    <div className="flex h-screen bg-surface-primary">
      {/* Sidebar backdrop (mobile only) */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Left sidebar — overlay on mobile, static on desktop */}
      <div
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col bg-surface-secondary border-r border-border-primary py-2 px-2 transform transition-transform duration-200 ease-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:translate-x-0 md:w-72 md:flex-shrink-0 md:z-auto`}
      >
        {/* Navigation links */}
        <div className="pb-2 mb-2 border-b border-border-primary">
          <a
            href="https://quoroom.ai/rooms"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 text-text-muted hover:text-text-secondary hover:bg-surface-hover"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 1C4 1 1 4 1 7s3 6 6 6 6-3 6-6-3-6-6-6z" />
              <path d="M1 7h12" />
              <path d="M7 1c1.5 1.5 2.5 3.5 2.5 6S8.5 11.5 7 13" />
              <path d="M7 1c-1.5 1.5-2.5 3.5-2.5 6s1 4.5 2.5 6" />
            </svg>
            Public Rooms
            <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 ml-auto opacity-50" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 1h5v5" />
              <path d="M9 1L3.5 6.5" />
            </svg>
          </a>
          <button
            onClick={() => handleTabChange('swarm')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'swarm'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
              <polygon points="7,1 12.5,4 12.5,10 7,13 1.5,10 1.5,4" fill="none" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
            My Swarm
            {totalBalance !== null && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[40px] h-5 px-1.5 rounded-full bg-status-success-bg text-status-success text-[11px] font-semibold leading-none">
                ${totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
          </button>
        </div>

        {/* Clerk */}
        <div className="pb-2 mb-2 border-b border-border-primary">
          <button
            onClick={() => handleTabChange('clerk')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'clerk'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.clerk}
            Clerk
          </button>

          {/* Create room */}
          <button
            onClick={() => setShowCreateRoomModal(true)}
            className="w-full px-3 py-1.5 text-sm text-left text-interactive hover:text-interactive-hover rounded-lg hover:bg-interactive-bg transition-colors mt-1"
          >
            + New Room
          </button>
        </div>

        {/* Room accordion — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {!roomsLoaded ? (
            <div className="flex items-center justify-center gap-2 py-4 px-2 text-xs text-text-muted">
              <span className="w-3 h-3 rounded-full border border-border-primary border-t-text-muted animate-spin" />
              <span>Loading rooms...</span>
            </div>
          ) : activeRooms.length === 0 && (
            <p className="text-xs text-text-muted text-center py-4 px-2">No rooms</p>
          )}
          {activeRooms.map(r => {
            const isOpen = expandedRoomId === r.id
            const isSelected = selectedRoomId === r.id
            const running = r.status === 'active' && queenRunning[r.id]
            const paused = r.status === 'paused'
            const dot = running ? 'bg-status-success' : paused ? 'bg-status-warning' : 'bg-text-muted'
            return (
              <div key={r.id}>
                <button
                  onClick={() => handleRoomToggle(r.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left rounded-lg transition-colors hover:bg-surface-hover ${isSelected ? 'bg-surface-hover' : ''}`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-sm font-medium text-text-primary truncate flex-1">{r.name}</span>
                  <span className="text-xs text-text-muted flex-shrink-0">{isOpen ? '\u25B4' : '\u25BE'}</span>
                </button>
                {isOpen && (
                  <div className="pl-4 flex flex-col gap-0.5 pb-1">
                    {visibleTabs.map(t => (
                      <button
                        key={t.id}
                        onClick={() => handleRoomTabClick(r.id, t.id)}
                        className={`px-3 py-1.5 text-sm text-left rounded-lg transition-colors ${
                          tab === t.id && isSelected
                            ? 'bg-surface-tertiary text-text-primary font-medium'
                            : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {tabIcons[t.id]}
                          {t.label}
                          {t.id === 'votes' && votesActive > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-interactive text-text-invert text-[10px] font-bold leading-none">
                              {votesActive}
                            </span>
                          )}
                          {t.id === 'messages' && messagesUnread > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-status-error text-text-invert text-[10px] font-bold leading-none">
                              {messagesUnread}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <TabBar active={tab} onChange={handleTabChange} onInvite={handleOpenInvite} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-4 py-2 bg-brand-50 border-b border-brand-200 shrink-0">
          <span className="text-sm text-brand-700 flex-1">
            You're early! We're building Quoroom every day and releasing often. If something isn't working, let us know.
          </span>
          <button
            onClick={() => window.open('mailto:hello@email.quoroom.ai?subject=Bug report&body=Hi, I found an issue in Quoroom:')}
            className="text-sm px-4 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover shrink-0 font-medium transition-colors"
          >
            Email Developer
          </button>
        </div>

        {devDbBanner && (
          <div className="px-4 py-2 bg-status-warning-bg border-b border-amber-200 shrink-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-status-warning">Dev Mode · Isolated DB</div>
            <div className="text-xs text-text-secondary break-all">
              DB: <span className="font-mono">{devDbBanner.dbPath}</span>
            </div>
            {devDbBanner.dataDir && (
              <div className="text-xs text-text-secondary break-all">
                Data: <span className="font-mono">{devDbBanner.dataDir}</span>
              </div>
            )}
            <button
              onClick={() => { localStorage.clear(); location.reload() }}
              className="mt-1 text-[11px] text-status-warning underline hover:no-underline"
            >
              Clear storage
            </button>
          </div>
        )}

        {(installPrompt.canInstall || installPrompt.isManualInstallPlatform) && !installPrompt.isInstalled && !installDismissed && (
          <div className="flex items-center gap-3 px-4 py-2 bg-brand-50 border-b border-brand-200">
            <span className="text-sm text-brand-700 flex-1">
              {installPrompt.canInstall
                ? 'Install Quoroom as an app for quick access, Dock icon, and badge notifications.'
                : 'Install Quoroom from your browser menu for quick access, Dock icon, and badge notifications.'}
            </span>
            <button
              onClick={async () => {
                if (installPrompt.canInstall) {
                  const accepted = await installPrompt.install()
                  if (!accepted) {
                    setInstallDismissed(true)
                    storageSet('quoroom_install_dismissed', 'true')
                  }
                } else {
                  handleTabChange('help')
                  setInstallDismissed(true)
                  storageSet('quoroom_install_dismissed', 'true')
                }
              }}
              className="text-sm px-4 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover shrink-0 font-medium transition-colors"
            >
              {installPrompt.canInstall ? 'Install' : 'How to install'}
            </button>
            <button
              onClick={() => {
                setInstallDismissed(true)
                storageSet('quoroom_install_dismissed', 'true')
              }}
              className="text-brand-400 hover:text-brand-600 text-lg leading-none shrink-0 transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {selectedRoom && tab !== 'swarm' && tab !== 'clerk' && tab !== 'settings' && tab !== 'help' && (() => {
          const running = selectedRoom.status === 'active' && queenRunning[selectedRoom.id]
          const paused = selectedRoom.status === 'paused'
          const dot = running ? 'bg-status-success' : paused ? 'bg-status-warning' : 'bg-text-muted'
          const statusLabel = running ? 'running' : paused ? 'paused' : 'idle'
          const statusColor = running ? 'text-status-success' : paused ? 'text-status-warning' : 'text-text-muted'
          return (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0 flex-wrap">
              <button className="md:hidden p-1 -ml-1 mr-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
              </button>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className="text-sm font-semibold text-text-primary truncate">{selectedRoom.name}</span>
              <span className={`text-xs flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
              {selectedRoomModel && <span className="text-xs text-text-muted flex-shrink-0">model: {formatRoomModel(selectedRoomModel)}</span>}
              <span className="text-xs text-text-muted flex-shrink-0">
                wallet: {selectedRoomBalance === null ? '--' : formatUsd(selectedRoomBalance)}
              </span>
              {selectedRoom.goal && (
                <>
                  <span className="text-text-muted flex-shrink-0 hidden sm:inline">{'\u00B7'}</span>
                  <span className="text-sm text-text-secondary truncate flex-1 min-w-0 hidden sm:inline">{selectedRoom.goal}</span>
                </>
              )}
            </div>
          )
        })()}

        {/* Mobile header for non-room views */}
        {(tab === 'swarm' || tab === 'clerk' || tab === 'settings' || tab === 'help' || !selectedRoom) && (
          <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0">
            <button className="p-1 -ml-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            <span className="text-sm font-semibold text-text-primary">
              {tab === 'swarm' ? 'My Swarm' : tab === 'clerk' ? 'Clerk' : tab === 'settings' ? 'Global Settings' : tab === 'help' ? 'Help' : 'Quoroom'}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {renderPanel()}
        </div>
      </div>

      {showCreateRoomModal && (
        <CreateRoomModal
          onClose={() => setShowCreateRoomModal(false)}
          onCreate={(room) => void handleRoomCreated(room)}
        />
      )}
      {showWalkthrough && (
        <WalkthroughModal installPrompt={installPrompt} onNavigateToHelp={() => handleTabChange('help')} onClose={() => {
          setShowWalkthrough(false)
          handleTabChange('clerk')
          setClerkSetupLaunchKey((prev) => prev + 1)
          if (contactPromptNeeded) {
            setShowContactPrompt(true)
          }
        }} />
      )}
      {showContactPrompt && (
        <ContactPromptModal
          onClose={() => setShowContactPrompt(false)}
          onNavigateToClerk={() => {
            setShowContactPrompt(false)
            handleTabChange('clerk')
            setClerkSetupLaunchKey((prev) => prev + 1)
          }}
        />
      )}
      {serverUpdateInfo && !updateDismissed && (
        <UpdateModal
          version={serverUpdateInfo.latestVersion}
          currentVersion={serverUpdateInfo.currentVersion}
          releaseUrl={serverUpdateInfo.releaseUrl}
          updateReady={!!serverUpdateInfo.readyUpdateVersion}
          onDownload={async () => {
            const token = await getToken()
            const a = document.createElement('a')
            a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            storageSet('quoroom_update_dismissed', serverUpdateInfo.latestVersion)
            setUpdateDismissed(true)
          }}
          onRestart={async () => {
            try {
              await fetch(`${API_BASE}/api/server/update-restart`, { method: 'POST' })
              // Wait for server to restart, then reload the page
              setTimeout(() => {
                const poll = setInterval(async () => {
                  try {
                    const res = await fetch(`${API_BASE}/api/status`)
                    if (res.ok) {
                      clearInterval(poll)
                      window.location.reload()
                    }
                  } catch { /* server still restarting */ }
                }, 1000)
                // Give up after 30 seconds
                setTimeout(() => clearInterval(poll), 30_000)
              }, 2000)
            } catch {
              // Fallback: just reload after a delay
              setTimeout(() => window.location.reload(), 3000)
            }
          }}
          onSkip={() => {
            storageSet('quoroom_update_dismissed', serverUpdateInfo.latestVersion)
            setUpdateDismissed(true)
          }}
          onDismiss={() => {
            storageSet('quoroom_update_dismissed', serverUpdateInfo.latestVersion)
            setUpdateDismissed(true)
          }}
        />
      )}
      {showKeepInDockTip && (
        <KeepInDockModal onDismiss={handleDismissKeepInDockTip} />
      )}
    </div>
  )
}

export default App
