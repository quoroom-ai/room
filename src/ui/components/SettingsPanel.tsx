import { useEffect, useState } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { API_BASE, clearToken, getToken } from '../lib/auth'
import * as notif from '../lib/notifications'
import type { InstallPrompt } from '../hooks/useInstallPrompt'
import { semverGt } from '../lib/releases'

interface SettingsPanelProps {
  advancedMode: boolean
  onAdvancedModeChange: (enabled: boolean) => void
  installPrompt: InstallPrompt
  onNavigate?: (tab: string) => void
}

interface UpdateInfo {
  latestVersion: string
  releaseUrl: string
  assets: { mac: string | null; windows: string | null; linux: string | null }
}

interface ServerStatus {
  version: string
  uptime: number
  dataDir: string
  dbPath: string
  claude: { available: boolean; version?: string }
  codex: { available: boolean; version?: string }
  ollama?: { available: boolean; models: Array<{ name: string; size: number }> }
  resources?: { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number }
  updateInfo?: UpdateInfo | null
}

export function SettingsPanel({ advancedMode, onAdvancedModeChange, installPrompt, onNavigate }: SettingsPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [notifications, setNotifications] = useState<boolean | null>(null)
  const [notifDenied, setNotifDenied] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateChecked, setUpdateChecked] = useState(false)
  const [claudePlan, setClaudePlan] = useState<'pro' | 'max' | 'api' | null>(null)
  const [queenModel, setQueenModel] = useState<string | null>(null)
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null)

  async function handleCheckForUpdates(): Promise<void> {
    setUpdateChecking(true)
    try {
      const status = await api.status.get()
      setServerStatus(status)
      setUpdateChecked(true)
    } catch {
      // ignore
    } finally {
      setUpdateChecking(false)
    }
  }

  useEffect(() => {
    api.settings.get('notifications_enabled').then((v) => {
      setNotifications(v !== 'false')
    }).catch(() => setNotifications(true))

    api.status.get().then(setServerStatus).catch(() => {})

    api.settings.get('claude_plan').then((v) => {
      const valid = ['pro', 'max', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setClaudePlan(plan)
    }).catch(() => {})

    api.settings.get('queen_model').then((v) => {
      setQueenModel(v || null)
    }).catch(() => setQueenModel(null))

    api.settings.get('telemetry_enabled').then((v) => {
      setTelemetryEnabled(v !== 'false')
    }).catch(() => setTelemetryEnabled(true))
  }, [])

  async function setClaudePlanSetting(plan: 'pro' | 'max' | 'api' | null): Promise<void> {
    await api.settings.set('claude_plan', plan ?? '')
    setClaudePlan(plan)
  }

  async function setQueenModelSetting(model: string): Promise<void> {
    await api.settings.set('queen_model', model)
    setQueenModel(model)
  }

  async function toggleTelemetry(): Promise<void> {
    const next = !telemetryEnabled
    await api.settings.set('telemetry_enabled', String(next))
    setTelemetryEnabled(next)
  }

  async function toggleAdvancedMode(): Promise<void> {
    const next = !advancedMode
    await api.settings.set('advanced_mode', String(next))
    onAdvancedModeChange(next)
  }

  async function toggleNotifications(): Promise<void> {
    const next = !notifications
    if (next && notif.isSupported()) {
      const granted = await notif.requestPermission()
      if (!granted) {
        setNotifDenied(true)
        return
      }
      setNotifDenied(false)
    }
    await api.settings.set('notifications_enabled', String(next))
    setNotifications(next)
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }

  function toggle(
    label: string,
    value: boolean | null,
    onChange: () => void,
    description?: string
  ): React.JSX.Element {
    const loading = value === null
    return (
      <div className="py-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-600">{label}</span>
          <button
            onClick={onChange}
            disabled={loading}
            className={`w-8 h-4 rounded-full transition-colors relative ${
              loading ? 'bg-gray-200' : value ? 'bg-green-500' : 'bg-gray-300'
            }`}
          >
            {!loading && (
              <span
                className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                  value ? 'left-4' : 'left-0.5'
                }`}
              />
            )}
          </button>
        </div>
        {description && (
          <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{description}</p>
        )}
      </div>
    )
  }

  function row(label: string, value: string | null): React.JSX.Element {
    return (
      <div className="flex flex-col py-1.5">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <span className="text-xs text-gray-400 truncate selectable">{value ?? '\u2014'}</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`p-4 ${wide ? 'grid grid-cols-2 gap-4' : 'space-y-4'}`}>
      {/* Preferences */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Preferences</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1">
          {toggle('Notifications', notifications, toggleNotifications, 'Notify when workers or queen send messages')}
          {notifDenied && (
            <p className="text-[10px] text-red-400 mt-0.5 leading-tight">Permission denied by browser. Allow notifications in browser settings.</p>
          )}
          {toggle('Advanced mode', advancedMode, toggleAdvancedMode, 'Show memory, watches, results tabs and extra controls')}
          {toggle('Telemetry', telemetryEnabled, toggleTelemetry, 'Send heartbeats to quoroom.ai (room appears in online counter and leaderboard)')}
          <div className="py-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Claude plan</span>
              <div className="flex rounded overflow-hidden border border-gray-200">
                <button
                  onClick={() => setClaudePlanSetting(null)}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    claudePlan === null
                      ? 'bg-gray-400 text-white'
                      : 'bg-white text-gray-400 hover:bg-gray-50'
                  }`}
                >—</button>
                {(['pro', 'max', 'api'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setClaudePlanSetting(p)}
                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      claudePlan === p
                        ? 'bg-blue-500 text-white'
                        : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">Optimizes queen cycle gap and max turns for your plan's token limits</p>
          </div>
          <div className="py-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Queen model</span>
              <div className="flex rounded overflow-hidden border border-gray-200">
                {([
                  ['claude', 'Claude'],
                  ['codex', 'Codex'],
                  ['openai:gpt-4o-mini', 'OpenAI API'],
                  ['anthropic:claude-3-5-sonnet-latest', 'Claude API']
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setQueenModelSetting(id)}
                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      (queenModel ?? 'claude') === id
                        ? 'bg-blue-500 text-white'
                        : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >{label}</button>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">Default queen provider for new rooms. API modes require key in room credentials or env.</p>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Connection</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">API Server</span>
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${serverStatus ? 'bg-green-500' : 'bg-red-400'}`} />
              <span className={serverStatus ? 'text-green-600' : 'text-red-500'}>
                {serverStatus ? 'Connected' : 'Disconnected'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Server URL</span>
            <span className="text-gray-400 font-mono text-[10px]">{API_BASE || location.origin}</span>
          </div>
          {API_BASE && API_BASE.includes('localhost') && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Port</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  defaultValue={localStorage.getItem('quoroom_port') || '3700'}
                  className="w-16 px-1.5 py-0.5 text-[10px] border border-gray-200 rounded text-center font-mono"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      localStorage.setItem('quoroom_port', (e.target as HTMLInputElement).value)
                      clearToken()
                      location.reload()
                    }
                  }}
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Claude Code</span>
            <span className="flex items-center gap-1.5">
              {claudePlan && (
                <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-blue-100 text-blue-600 uppercase tracking-wide">
                  {claudePlan}
                </span>
              )}
              <span className={serverStatus?.claude.available ? 'text-green-600' : 'text-gray-400'}>
                {serverStatus === null
                  ? '...'
                  : serverStatus.claude.available
                    ? serverStatus.claude.version || 'Found'
                    : 'Not found'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Codex</span>
            <span className={serverStatus?.codex.available ? 'text-green-600' : 'text-gray-400'}>
              {serverStatus === null
                ? '...'
                : serverStatus.codex.available
                  ? serverStatus.codex.version || 'Found'
                  : 'Not found'}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Ollama</span>
            <span className={serverStatus?.ollama?.available ? 'text-green-600' : 'text-gray-400'}>
              {serverStatus === null
                ? '...'
                : serverStatus.ollama?.available
                  ? `${serverStatus.ollama.models.length} model${serverStatus.ollama.models.length !== 1 ? 's' : ''}`
                  : 'Not running'}
            </span>
          </div>
          {serverStatus?.ollama?.available && serverStatus.ollama.models.length > 0 && (
            <div className="text-[10px] text-gray-400 pl-2 leading-tight">
              {serverStatus.ollama.models.map(m => m.name).join(' · ')}
            </div>
          )}
          {serverStatus?.resources && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Load</span>
              <span className={serverStatus.resources.memUsedPct > 85 || serverStatus.resources.loadAvg1m > serverStatus.resources.cpuCount * 0.8 ? 'text-amber-600' : 'text-gray-400'}>
                CPU {Math.round(serverStatus.resources.loadAvg1m / serverStatus.resources.cpuCount * 100)}%
                · RAM {serverStatus.resources.memUsedPct}%
              </span>
            </div>
          )}
          {serverStatus && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Uptime</span>
              <span className="text-gray-400">{formatUptime(serverStatus.uptime)}</span>
            </div>
          )}
        </div>
      </div>


      {/* App */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">App</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Installation</span>
            {installPrompt.isInstalled ? (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-green-600">Installed</span>
              </span>
            ) : installPrompt.canInstall ? (
              <button
                onClick={installPrompt.install}
                className="text-xs px-2 py-0.5 bg-amber-500 text-white rounded hover:bg-amber-600 font-medium"
              >
                Install
              </button>
            ) : (
              <button onClick={() => onNavigate?.('help')} className="text-blue-500 hover:text-blue-700">Help tab &rarr;</button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 leading-tight">
            Standalone app with Dock/taskbar icon and badge notifications.
          </p>
        </div>
      </div>

      {/* Server */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Server</h3>
        <div className="bg-gray-50 rounded-lg p-2 divide-y divide-gray-100">
          <div className="flex items-center justify-between text-xs py-1.5">
            <span className="font-medium text-gray-600">Version</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-400">{serverStatus?.version ?? '...'}</span>
              {(() => {
                const ui = serverStatus?.updateInfo
                const hasUpdate = ui && serverStatus && semverGt(ui.latestVersion, serverStatus.version)
                if (hasUpdate) return null
                if (updateChecking) return <span className="text-gray-400">Checking...</span>
                if (updateChecked) return <span className="text-green-600">Up to date</span>
                return (
                  <button
                    onClick={() => void handleCheckForUpdates()}
                    className="text-blue-500 hover:text-blue-700"
                  >
                    Check
                  </button>
                )
              })()}
            </div>
          </div>
          {(() => {
            const ui = serverStatus?.updateInfo
            if (!ui || !serverStatus) return null
            if (!semverGt(ui.latestVersion, serverStatus.version)) return null
            return (
              <div className="flex items-center justify-between text-xs py-1.5">
                <span className="font-medium text-green-600">v{ui.latestVersion} available</span>
                <button
                  onClick={async () => {
                    const token = await getToken()
                    const a = document.createElement('a')
                    a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }}
                  className="px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                >
                  Download
                </button>
              </div>
            )
          })()}
          {row('Database', serverStatus?.dbPath ?? null)}
          {row('Data Directory', serverStatus?.dataDir ?? null)}
        </div>
      </div>

      {/* Actions */}
      <div className={`${wide ? 'col-span-2 grid grid-cols-2 gap-2' : 'space-y-2'}`}>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room/issues/new')}
          className="w-full py-1.5 text-xs text-blue-500 hover:text-blue-700 border border-blue-200 hover:border-blue-300 rounded transition-colors"
        >
          Report Bug
        </button>
        <button
          onClick={() => window.open('mailto:hello@quoroom.ai')}
          className="w-full py-1.5 text-xs text-blue-500 hover:text-blue-700 border border-blue-200 hover:border-blue-300 rounded transition-colors"
        >
          Email Developer
        </button>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room')}
          className="w-full py-1.5 text-xs text-amber-700 hover:text-amber-800 border border-amber-300 hover:border-amber-400 rounded transition-colors"
        >
          Star on GitHub
        </button>
        <button
          onClick={() => window.open('mailto:hello@quoroom.ai?subject=Subscribe&body=Subscribe me for Quoroom updates')}
          className="w-full py-1.5 text-xs text-green-600 hover:text-green-700 border border-green-200 hover:border-green-300 rounded transition-colors"
        >
          Subscribe for Updates
        </button>
      </div>
    </div>
  )
}
