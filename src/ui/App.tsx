import { useEffect, useState } from 'react'
import { getToken, clearToken } from './lib/auth'
import { TabBar, mainTabs, type Tab } from './components/TabBar'
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
import { ConnectPage } from './components/ConnectPage'
import { useNotifications } from './hooks/useNotifications'
import { useInstallPrompt, type InstallPrompt } from './hooks/useInstallPrompt'
import { api } from './lib/client'
import type { Room } from '@shared/types'

const ADVANCED_TABS = new Set<Tab>(['memory', 'watches', 'results'])

const ALL_TAB_IDS: Tab[] = ['status', 'goals', 'votes', 'messages', 'workers', 'tasks', 'skills', 'credentials', 'transactions', 'stations', 'memory', 'watches', 'results', 'settings', 'help']

const DEFAULT_PORT = '3700'
const isRemoteOrigin = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'

function getLocalPort(): string {
  return localStorage.getItem('quoroom_port') || DEFAULT_PORT
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
    return 'status'
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

  useNotifications()
  const installPrompt = useInstallPrompt()
  const [installDismissed, setInstallDismissed] = useState(() => localStorage.getItem('quoroom_install_dismissed') === 'true')

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

  // Load rooms list and poll for updates
  useEffect(() => {
    if (!ready) return
    function loadRooms(): void {
      api.rooms.list().then((r) => {
        setRooms(r)
        // Auto-select first room if none selected
        if (selectedRoomId === null && r.length > 0) {
          handleRoomChange(r[0].id)
          setExpandedRoomId(r[0].id)
        }
        // Clear selection if room no longer exists
        if (selectedRoomId !== null && !r.find(room => room.id === selectedRoomId)) {
          const next = r.length > 0 ? r[0].id : null
          handleRoomChange(next)
          setExpandedRoomId(next)
        }
        // Sync expandedRoomId on first load
        setExpandedRoomId(prev => {
          if (prev === null && selectedRoomId !== null && r.find(room => room.id === selectedRoomId)) {
            return selectedRoomId
          }
          return prev
        })
        // Fetch queen running status for all rooms
        Promise.all(
          r.map(async room => {
            const q = await api.rooms.queenStatus(room.id).catch(() => null)
            return [room.id, q?.running ?? false] as const
          })
        ).then(entries => setQueenRunning(Object.fromEntries(entries))).catch(() => {})
      }).catch(() => {})
    }
    loadRooms()
    const interval = setInterval(loadRooms, 10000)
    return () => clearInterval(interval)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derive autonomyMode from selected room
  useEffect(() => {
    const room = rooms.find(r => r.id === selectedRoomId)
    if (room) setAutonomyMode(room.autonomyMode)
  }, [selectedRoomId, rooms])

  function handleTabChange(t: Tab): void {
    setTab(t)
    localStorage.setItem('quoroom_tab', t)
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
  }

  function handleRoomTabClick(roomId: number, t: Tab): void {
    handleRoomChange(roomId)
    setExpandedRoomId(roomId)
    handleTabChange(t)
  }

  const selectedRoom = rooms.find(r => r.id === selectedRoomId) ?? null

  function renderPanel(): React.JSX.Element {
    switch (tab) {
      case 'status':
        return <StatusPanel onNavigate={(t) => handleTabChange(t as Tab)} advancedMode={advancedMode} roomId={selectedRoomId} />
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
      case 'watches':
        return <WatchesPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'results':
        return <ResultsPanel roomId={selectedRoomId} autonomyMode={autonomyMode} />
      case 'settings':
        return <SettingsPanel advancedMode={advancedMode} onAdvancedModeChange={handleAdvancedModeChange} installPrompt={installPrompt} onNavigate={(t) => handleTabChange(t as Tab)} selectedRoomId={selectedRoomId} onSelectRoom={handleRoomChange} />
      case 'help':
        return <HelpPanel installPrompt={installPrompt} />
      default:
        return <div className="p-4 text-xs text-gray-400">Coming soon</div>
    }
  }

  // Remote origin: probing localhost
  if (gate === 'probing') {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center">
        <div className="text-gray-400 text-sm">Connecting to your local server...</div>
      </div>
    )
  }

  // Remote origin: server not reachable — show connect page
  if (gate === 'connect') {
    return (
      <ConnectPage
        port={getLocalPort()}
        onRetry={() => setGate('probing')}
      />
    )
  }

  // Local origin: auth error
  if (error) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center px-4">
        <div className="text-red-500 text-sm mb-1">Connection failed</div>
        <div className="text-gray-400 text-xs mb-3">{error}</div>
        <button
          onClick={() => { setError(null); clearToken(); getToken().then(() => setReady(true)).catch((e) => setError(e instanceof Error ? e.message : 'Auth failed')) }}
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          Retry
        </button>
      </div>
    )
  }

  // Local origin: loading
  if (!ready) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center">
        <div className="text-gray-400 text-sm">Connecting...</div>
      </div>
    )
  }

  const visibleTabs = advancedMode ? mainTabs : mainTabs.filter(t => !t.advanced)

  return (
    <div className="flex h-screen bg-white">
      {/* Left sidebar */}
      <div data-testid="sidebar" className="w-40 flex-shrink-0 flex flex-col bg-gray-50 border-r border-gray-200 py-1.5 px-1.5">
        {/* Room accordion — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {rooms.length === 0 && (
            <p className="text-[10px] text-gray-400 text-center py-3 px-2">No rooms</p>
          )}
          {rooms.map(r => {
            const isOpen = expandedRoomId === r.id
            const isSelected = selectedRoomId === r.id
            const running = r.status === 'active' && queenRunning[r.id]
            const paused = r.status === 'paused'
            const dot = running ? 'bg-green-400' : paused ? 'bg-yellow-400' : 'bg-gray-300'
            return (
              <div key={r.id}>
                {/* Room row */}
                <button
                  onClick={() => handleRoomToggle(r.id)}
                  className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-left rounded transition-colors hover:bg-gray-100 ${isSelected ? 'bg-gray-100' : ''}`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-xs font-medium text-gray-700 truncate flex-1">{r.name}</span>
                  <span className="text-[9px] text-gray-400 flex-shrink-0">{isOpen ? '▴' : '▾'}</span>
                </button>
                {/* Submenu */}
                {isOpen && (
                  <div className="pl-3 flex flex-col gap-0.5 pb-1">
                    {visibleTabs.map(t => (
                      <button
                        key={t.id}
                        onClick={() => handleRoomTabClick(r.id, t.id)}
                        className={`px-2 py-1 text-xs text-left rounded transition-colors ${
                          tab === t.id && isSelected
                            ? 'bg-gray-200 text-gray-900 font-medium'
                            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Bottom nav — Settings, Help */}
        <TabBar active={tab} onChange={handleTabChange} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Install banner */}
        {installPrompt.canInstall && !installPrompt.isInstalled && !installDismissed && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border-b border-amber-200">
            <span className="text-xs text-amber-800 flex-1">
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
              className="text-xs px-2.5 py-1 bg-amber-500 text-white rounded hover:bg-amber-600 shrink-0 font-medium"
            >
              Install
            </button>
            <button
              onClick={() => {
                setInstallDismissed(true)
                localStorage.setItem('quoroom_install_dismissed', 'true')
              }}
              className="text-amber-400 hover:text-amber-600 text-sm leading-none shrink-0"
            >
              &times;
            </button>
          </div>
        )}

        {/* Room context header */}
        {selectedRoom && tab !== 'settings' && tab !== 'help' && (() => {
          const running = selectedRoom.status === 'active' && queenRunning[selectedRoom.id]
          const paused = selectedRoom.status === 'paused'
          const dot = running ? 'bg-green-400' : paused ? 'bg-yellow-400' : 'bg-gray-300'
          const statusLabel = running ? 'running' : paused ? 'paused' : 'idle'
          const statusColor = running ? 'text-green-600' : paused ? 'text-yellow-600' : 'text-gray-400'
          return (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 bg-white shrink-0">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className="text-xs font-semibold text-gray-800 truncate">{selectedRoom.name}</span>
              <span className={`text-[10px] flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
              {selectedRoom.goal && (
                <>
                  <span className="text-gray-300 flex-shrink-0">·</span>
                  <span className="text-[11px] text-gray-400 truncate flex-1 min-w-0">{selectedRoom.goal}</span>
                </>
              )}
            </div>
          )
        })()}

        <div className="flex-1 overflow-y-auto">
          {renderPanel()}
        </div>
      </div>
    </div>
  )
}

export default App
