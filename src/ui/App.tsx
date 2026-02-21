import { useEffect, useState } from 'react'
import { getToken, clearToken, API_BASE } from './lib/auth'
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
import { ConnectPage } from './components/ConnectPage'
import { WalkthroughModal } from './components/WalkthroughModal'
import { UpdateModal } from './components/UpdateModal'
import { CreateRoomModal } from './components/CreateRoomModal'
import { useNotifications } from './hooks/useNotifications'
import { semverGt } from './lib/releases'
import { useInstallPrompt, type InstallPrompt } from './hooks/useInstallPrompt'
import { api } from './lib/client'
import type { Room, Escalation, RoomMessage, QuorumDecision } from '@shared/types'

const ADVANCED_TABS = new Set<Tab>(
  mainTabs.filter((tab) => tab.advanced).map((tab) => tab.id)
)

const ALL_TAB_IDS: Tab[] = ['swarm', 'status', 'chat', 'goals', 'votes', 'messages', 'workers', 'tasks', 'skills', 'credentials', 'transactions', 'stations', 'room-settings', 'memory', 'watches', 'results', 'settings', 'help']

const DEFAULT_PORT = '3700'
const isRemoteOrigin = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'

function getLocalPort(): string {
  return localStorage.getItem('quoroom_port') || DEFAULT_PORT
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

async function probeLocalServer(port: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`http://localhost:${port}/api/status`, { signal: controller.signal })
    clearTimeout(timeout)
    if (res.ok) {
      window.location.href = `http://localhost:${port}`
      return true
    }
  } catch {
    // Server not reachable
  }
  return false
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('quoroom_tab')
    if (saved && ALL_TAB_IDS.includes(saved as Tab)) return saved as Tab
    return 'swarm'
  })
  const [advancedMode, setAdvancedMode] = useState(false)
  const [autonomyMode, setAutonomyMode] = useState<'auto' | 'semi'>('auto')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Global room selection
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(() => {
    const saved = localStorage.getItem('quoroom_room')
    return saved ? Number(saved) : null
  })
  const [expandedRoomId, setExpandedRoomId] = useState<number | null>(() => {
    const saved = localStorage.getItem('quoroom_room')
    return saved ? Number(saved) : null
  })
  const [rooms, setRooms] = useState<Room[]>([])
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false)

  const [messagesUnread, setMessagesUnread] = useState(0)
  const [votesActive, setVotesActive] = useState(0)
  const [totalBalance, setTotalBalance] = useState<number | null>(null)

  useNotifications()
  const installPrompt = useInstallPrompt()
  const [installDismissed, setInstallDismissed] = useState(() => localStorage.getItem('quoroom_install_dismissed') === 'true')
  const [showWalkthrough, setShowWalkthrough] = useState(() => !localStorage.getItem('quoroom_walkthrough_seen'))
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Update check — fetch /api/status once on startup (and every 30 min) to detect new releases
  const [serverUpdateInfo, setServerUpdateInfo] = useState<{
    currentVersion: string
    latestVersion: string
    releaseUrl: string
    assets: { mac: string | null; windows: string | null; linux: string | null }
  } | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // Remote origin gate: 'probing' → 'connect' or redirect to localhost
  const [gate, setGate] = useState<'probing' | 'connect' | 'app'>(() =>
    isRemoteOrigin ? 'probing' : 'app'
  )

  // Remote origin: probe localhost and redirect or show connect page
  useEffect(() => {
    if (gate !== 'probing') return
    probeLocalServer(getLocalPort()).then((redirected) => {
      if (!redirected) setGate('connect')
    })
  }, [gate])

  // Poll unread message counts for the expanded room (for sidebar badge)
  useEffect(() => {
    if (!ready || expandedRoomId === null) { setMessagesUnread(0); return }
    async function fetchUnread(): Promise<void> {
      try {
        const [esc, msgs] = await Promise.all([
          api.escalations.list(expandedRoomId!).catch(() => [] as Escalation[]),
          api.roomMessages.list(expandedRoomId!).catch(() => [] as RoomMessage[]),
        ])
        setMessagesUnread(
          esc.filter(e => e.status === 'pending').length +
          msgs.filter(m => m.status === 'unread').length
        )
      } catch {
        // ignore polling noise
      }
    }
    void fetchUnread().catch(() => {})
    const interval = setInterval(() => { void fetchUnread().catch(() => {}) }, 10000)
    return () => clearInterval(interval)
  }, [expandedRoomId, ready])

  // Poll active voting count for the expanded room (for sidebar badge)
  useEffect(() => {
    if (!ready || expandedRoomId === null) { setVotesActive(0); return }
    async function fetchActive(): Promise<void> {
      try {
        const decisions = await api.decisions.list(expandedRoomId!, 'voting').catch(() => [] as QuorumDecision[])
        setVotesActive(decisions.length)
      } catch {
        // ignore polling noise
      }
    }
    void fetchActive().catch(() => {})
    const interval = setInterval(() => { void fetchActive().catch(() => {}) }, 10000)
    return () => clearInterval(interval)
  }, [expandedRoomId, ready])

  // Poll total on-chain balance across all rooms (only those with wallets)
  useEffect(() => {
    if (!ready || rooms.length === 0) { setTotalBalance(null); return }
    async function fetchTotalBalance(): Promise<void> {
      try {
        const wallets = await Promise.all(
          rooms.map(r => api.wallet.get(r.id).catch(() => null))
        )
        const roomsWithWallets = rooms.filter((_, i) => wallets[i] !== null)
        if (roomsWithWallets.length === 0) { setTotalBalance(null); return }
        const results = await Promise.all(
          roomsWithWallets.map(r => api.wallet.balance(r.id).catch(() => null))
        )
        const sum = results.reduce((acc, b) => acc + (b?.totalBalance ?? 0), 0)
        setTotalBalance(sum > 0 ? sum : null)
      } catch {
        // ignore polling noise
      }
    }
    void fetchTotalBalance().catch(() => {})
    const interval = setInterval(() => { void fetchTotalBalance().catch(() => {}) }, 60000)
    return () => clearInterval(interval)
  }, [ready, rooms])

  // Local origin: normal auth flow
  useEffect(() => {
    if (gate !== 'app') return
    getToken()
      .then(() => setReady(true))
      .catch((err) => setError(err instanceof Error ? err.message : 'Auth failed'))
  }, [gate])

  useEffect(() => {
    if (gate !== 'app') return
    api.settings.get('advanced_mode').then((v) => {
      setAdvancedMode(v === 'true')
    }).catch(() => {})
  }, [gate])

  useEffect(() => {
    if (gate !== 'app' || !ready) return
    function checkStatus(): void {
      api.status.get().then((status) => {
        const ui = status.updateInfo
        if (!ui) return
        if (!semverGt(ui.latestVersion, status.version)) return
        const dismissed = localStorage.getItem('quoroom_update_dismissed')
        if (dismissed === ui.latestVersion) return
        setServerUpdateInfo({
          currentVersion: status.version,
          latestVersion: ui.latestVersion,
          releaseUrl: ui.releaseUrl,
          assets: ui.assets,
        })
      }).catch(() => {})
    }
    checkStatus()
    const interval = setInterval(checkStatus, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [gate, ready])

  function syncRooms(r: Room[]): void {
    setRooms(r)
    if (selectedRoomId === null && r.length > 0) {
      handleRoomChange(r[0].id)
      setExpandedRoomId(r[0].id)
    }
    if (selectedRoomId !== null && !r.find(room => room.id === selectedRoomId)) {
      const next = r.length > 0 ? r[0].id : null
      handleRoomChange(next)
      setExpandedRoomId(next)
    }
    setExpandedRoomId(prev => {
      if (prev === null && selectedRoomId !== null && r.find(room => room.id === selectedRoomId)) {
        return selectedRoomId
      }
      return prev
    })
    Promise.all(
      r.map(async room => {
        const q = await api.rooms.queenStatus(room.id).catch(() => null)
        return [room.id, q?.running ?? false] as const
      })
    ).then(entries => setQueenRunning(Object.fromEntries(entries))).catch(() => {})
  }

  useEffect(() => {
    if (!ready) return
    function loadRooms(): void {
      api.rooms.list().then(syncRooms).catch(() => {})
    }
    loadRooms()
    const interval = setInterval(loadRooms, 10000)
    return () => clearInterval(interval)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const room = rooms.find(r => r.id === selectedRoomId)
    if (room) setAutonomyMode(room.autonomyMode)
  }, [selectedRoomId, rooms])

  function handleTabChange(t: Tab): void {
    setTab(t)
    localStorage.setItem('quoroom_tab', t)
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
      localStorage.setItem('quoroom_room', String(roomId))
    } else {
      localStorage.removeItem('quoroom_room')
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

  async function handleRoomCreated(created: Room): Promise<void> {
    const createdRoomId = parseCreatedRoomId(created)
    const nextRooms = await api.rooms.list()
    syncRooms(nextRooms)

    const resolvedRoomId = createdRoomId
      ?? [...nextRooms].reverse().find(r => r.name === created.name)?.id
      ?? null
    if (resolvedRoomId !== null) {
      handleRoomChange(resolvedRoomId)
      setExpandedRoomId(resolvedRoomId)
    }
    handleTabChange('room-settings')
    setShowCreateRoomModal(false)
  }

  const selectedRoom = rooms.find(r => r.id === selectedRoomId) ?? null

  function renderPanel(): React.JSX.Element {
    switch (tab) {
      case 'swarm':
        return <SwarmPanel rooms={rooms.filter(r => r.status !== 'stopped')} queenRunning={queenRunning} onNavigateToRoom={(roomId) => {
          handleRoomChange(roomId)
          setExpandedRoomId(roomId)
          handleTabChange('status')
        }} />
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
        return <StationsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
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
        <button
          onClick={() => { setError(null); clearToken(); getToken().then(() => setReady(true)).catch((e) => setError(e instanceof Error ? e.message : 'Auth failed')) }}
          className="text-sm text-interactive hover:text-interactive-hover transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center">
        <div className="text-text-muted text-sm">Connecting...</div>
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
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col bg-surface-secondary border-r border-border-primary py-2 px-2 transform transition-transform duration-200 ease-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:translate-x-0 md:w-48 md:flex-shrink-0 md:z-auto`}
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
          </button>
        </div>

        {/* Create room */}
        <div className="pb-2 mb-2 border-b border-border-primary">
          <button
            onClick={() => setShowCreateRoomModal(true)}
            className="w-full px-3 py-1.5 text-sm text-left text-interactive hover:text-interactive-hover rounded-lg hover:bg-interactive-bg transition-colors"
          >
            + New Room
          </button>
        </div>

        {/* Room accordion — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {rooms.filter(r => r.status !== 'stopped').length === 0 && (
            <p className="text-xs text-text-muted text-center py-4 px-2">No rooms</p>
          )}
          {rooms.filter(r => r.status !== 'stopped').map(r => {
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

        {totalBalance !== null && (
          <div className="mx-2 mb-1.5 px-3 py-2 rounded-lg bg-status-success-bg">
            <div className="text-xs text-text-muted">Total Balance</div>
            <div className="text-sm font-semibold text-status-success">${totalBalance.toFixed(2)}</div>
          </div>
        )}
        <TabBar active={tab} onChange={handleTabChange} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {installPrompt.canInstall && !installPrompt.isInstalled && !installDismissed && (
          <div className="flex items-center gap-3 px-4 py-2 bg-brand-50 border-b border-brand-200">
            <span className="text-sm text-brand-700 flex-1">
              Install Quoroom as an app for quick access, Dock icon, and badge notifications.
            </span>
            <button
              onClick={async () => {
                const accepted = await installPrompt.install()
                if (!accepted) {
                  setInstallDismissed(true)
                  localStorage.setItem('quoroom_install_dismissed', 'true')
                }
              }}
              className="text-sm px-4 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover shrink-0 font-medium transition-colors"
            >
              Install
            </button>
            <button
              onClick={() => {
                setInstallDismissed(true)
                localStorage.setItem('quoroom_install_dismissed', 'true')
              }}
              className="text-brand-400 hover:text-brand-600 text-lg leading-none shrink-0 transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {selectedRoom && tab !== 'swarm' && tab !== 'settings' && tab !== 'help' && (() => {
          const running = selectedRoom.status === 'active' && queenRunning[selectedRoom.id]
          const paused = selectedRoom.status === 'paused'
          const dot = running ? 'bg-status-success' : paused ? 'bg-status-warning' : 'bg-text-muted'
          const statusLabel = running ? 'running' : paused ? 'paused' : 'idle'
          const statusColor = running ? 'text-status-success' : paused ? 'text-status-warning' : 'text-text-muted'
          return (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0">
              <button className="md:hidden p-1 -ml-1 mr-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
              </button>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className="text-sm font-semibold text-text-primary truncate">{selectedRoom.name}</span>
              <span className={`text-xs flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
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
        {(tab === 'swarm' || tab === 'settings' || tab === 'help' || !selectedRoom) && (
          <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0">
            <button className="p-1 -ml-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            <span className="text-sm font-semibold text-text-primary">
              {tab === 'swarm' ? 'My Swarm' : tab === 'settings' ? 'Global Settings' : tab === 'help' ? 'Help' : 'Quoroom'}
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
      {showWalkthrough && <WalkthroughModal onClose={() => setShowWalkthrough(false)} />}
      {serverUpdateInfo && !updateDismissed && (
        <UpdateModal
          version={serverUpdateInfo.latestVersion}
          currentVersion={serverUpdateInfo.currentVersion}
          releaseUrl={serverUpdateInfo.releaseUrl}
          onDownload={async () => {
            const token = await getToken()
            const a = document.createElement('a')
            a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
          }}
          onSkip={() => {
            localStorage.setItem('quoroom_update_dismissed', serverUpdateInfo.latestVersion)
            setUpdateDismissed(true)
          }}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}
    </div>
  )
}

export default App
