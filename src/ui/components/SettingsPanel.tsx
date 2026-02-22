import { useEffect, useState } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useTheme } from '../hooks/useTheme'
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
  const [chatGptPlan, setChatGptPlan] = useState<'plus' | 'pro' | 'api' | null>(null)
  const [queenModel, setQueenModel] = useState<string | null>(null)
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null)
  const { theme, setTheme } = useTheme()

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

    api.settings.get('chatgpt_plan').then((v) => {
      const valid = ['plus', 'pro', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setChatGptPlan(plan)
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

  async function setChatGptPlanSetting(plan: 'plus' | 'pro' | 'api' | null): Promise<void> {
    await api.settings.set('chatgpt_plan', plan ?? '')
    setChatGptPlan(plan)
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
      <div className="py-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{label}</span>
          <button
            onClick={onChange}
            disabled={loading}
            className={`w-9 h-5 rounded-full transition-colors relative ${
              loading ? 'bg-surface-tertiary' : value ? 'bg-interactive' : 'bg-text-muted'
            }`}
          >
            {!loading && (
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${
                  value ? 'left-4.5' : 'left-0.5'
                }`}
              />
            )}
          </button>
        </div>
        {description && (
          <p className="text-xs text-text-muted mt-0.5 leading-tight">{description}</p>
        )}
      </div>
    )
  }

  function row(label: string, value: string | null): React.JSX.Element {
    return (
      <div className="flex flex-col py-2">
        <span className="text-sm font-medium text-text-secondary">{label}</span>
        <span className="text-xs text-text-muted truncate selectable">{value ?? '\u2014'}</span>
      </div>
    )
  }

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string; icon: string }> = [
    { value: 'light', label: 'Light', icon: '\u2600' },
    { value: 'dark', label: 'Dark', icon: '\u263E' },
    { value: 'system', label: 'Auto', icon: '\u2699' },
  ]

  return (
    <div ref={containerRef} className={`p-5 ${wide ? 'grid grid-cols-2 gap-5' : 'space-y-5'}`}>
      {/* Preferences */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-2">Preferences</h3>
        <div className="bg-surface-secondary rounded-lg p-3 space-y-1 shadow-sm">
          {/* Theme toggle */}
          <div className="py-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Theme</span>
              <div className="flex rounded-lg overflow-hidden border border-border-primary">
                {themeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setTheme(opt.value)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      theme === opt.value
                        ? 'bg-interactive text-text-invert'
                        : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                    }`}
                  >{opt.icon} {opt.label}</button>
                ))}
              </div>
            </div>
          </div>
          {toggle('Notifications', notifications, toggleNotifications, 'Notify when workers or queen send messages')}
          {notifDenied && (
            <p className="text-xs text-status-error mt-0.5 leading-tight">Permission denied by browser. Allow notifications in browser settings.</p>
          )}
          {toggle('Advanced mode', advancedMode, toggleAdvancedMode, 'Show memory, watches, results tabs and extra controls')}
          {toggle('Telemetry', telemetryEnabled, toggleTelemetry, 'Send heartbeats to quoroom.ai (room appears in online counter and leaderboard)')}
          <div className="py-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Claude plan</span>
              <div className="flex rounded-lg overflow-hidden border border-border-primary">
                <button
                  onClick={() => setClaudePlanSetting(null)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    claudePlan === null
                      ? 'bg-text-muted text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{'\u2014'}</button>
                {(['pro', 'max', 'api'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setClaudePlanSetting(p)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      claudePlan === p
                        ? 'bg-interactive text-text-invert'
                        : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                    }`}
                  >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mt-0.5 leading-tight">Optimizes queen cycle gap and max turns for your plan's token limits</p>
          </div>
          <div className="py-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">ChatGPT plan</span>
              <div className="flex rounded-lg overflow-hidden border border-border-primary">
                <button
                  onClick={() => setChatGptPlanSetting(null)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    chatGptPlan === null
                      ? 'bg-text-muted text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{'\u2014'}</button>
                {(['plus', 'pro', 'api'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setChatGptPlanSetting(p)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      chatGptPlan === p
                        ? 'bg-interactive text-text-invert'
                        : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                    }`}
                  >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mt-0.5 leading-tight">Optimizes queen defaults when using Codex. Plus and Pro have different rate limits.</p>
          </div>
          <div className="py-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Queen model</span>
              <div className="flex rounded-lg overflow-hidden border border-border-primary">
                {([
                  ['claude', 'Claude'],
                  ['codex', 'Codex'],
                  ['openai:gpt-4o-mini', 'OpenAI API'],
                  ['anthropic:claude-3-5-sonnet-latest', 'Claude API']
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setQueenModelSetting(id)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      (queenModel ?? 'claude') === id
                        ? 'bg-interactive text-text-invert'
                        : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                    }`}
                  >{label}</button>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mt-0.5 leading-tight">Default queen provider for new rooms. API modes require key in room credentials or env.</p>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-2">Connection</h3>
        <div className="bg-surface-secondary rounded-lg p-3 space-y-1.5 shadow-sm">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">API Server</span>
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${serverStatus ? 'bg-status-success' : 'bg-status-error'}`} />
              <span className={serverStatus ? 'text-status-success' : 'text-status-error'}>
                {serverStatus ? 'Connected' : 'Disconnected'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Server URL</span>
            <span className="text-text-muted font-mono text-xs">{API_BASE || location.origin}</span>
          </div>
          {API_BASE && API_BASE.includes('localhost') && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Port</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  defaultValue={localStorage.getItem('quoroom_port') || '3700'}
                  className="w-16 px-2 py-1 text-xs border border-border-primary rounded text-center font-mono bg-surface-primary text-text-primary"
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
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Claude Code</span>
            <span className="flex items-center gap-1.5">
              {claudePlan && (
                <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                  {claudePlan}
                </span>
              )}
              <span className={serverStatus?.claude.available ? 'text-status-success' : 'text-text-muted'}>
                {serverStatus === null
                  ? '...'
                  : serverStatus.claude.available
                    ? serverStatus.claude.version || 'Found'
                    : 'Not found'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Codex</span>
            <span className="flex items-center gap-1.5">
              {chatGptPlan && (
                <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                  {chatGptPlan}
                </span>
              )}
              <span className={serverStatus?.codex.available ? 'text-status-success' : 'text-text-muted'}>
                {serverStatus === null
                  ? '...'
                  : serverStatus.codex.available
                    ? serverStatus.codex.version || 'Found'
                    : 'Not found'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Ollama</span>
            <span className={serverStatus?.ollama?.available ? 'text-status-success' : 'text-text-muted'}>
              {serverStatus === null
                ? '...'
                : serverStatus.ollama?.available
                  ? `${serverStatus.ollama.models.length} model${serverStatus.ollama.models.length !== 1 ? 's' : ''}`
                  : 'Not running'}
            </span>
          </div>
          {serverStatus?.ollama?.available && serverStatus.ollama.models.length > 0 && (
            <div className="text-xs text-text-muted pl-2 leading-tight">
              {serverStatus.ollama.models.map(m => m.name).join(' \u00B7 ')}
            </div>
          )}
          {serverStatus?.resources && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Load</span>
              <span className={serverStatus.resources.memUsedPct > 85 || serverStatus.resources.loadAvg1m > serverStatus.resources.cpuCount * 0.8 ? 'text-status-warning' : 'text-text-muted'}>
                CPU {Math.round(serverStatus.resources.loadAvg1m / serverStatus.resources.cpuCount * 100)}%
                {' \u00B7 '}RAM {serverStatus.resources.memUsedPct}%
              </span>
            </div>
          )}
          {serverStatus && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">Uptime</span>
              <span className="text-text-muted">{formatUptime(serverStatus.uptime)}</span>
            </div>
          )}
        </div>
      </div>


      {/* App */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-2">App</h3>
        <div className="bg-surface-secondary rounded-lg p-3 space-y-1.5 shadow-sm">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Installation</span>
            {installPrompt.isInstalled ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-status-success" />
                <span className="text-status-success">Installed</span>
              </span>
            ) : installPrompt.canInstall ? (
              <button
                onClick={installPrompt.install}
                className="text-sm px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover font-medium transition-colors"
              >
                Install
              </button>
            ) : installPrompt.isManualInstallPlatform ? (
              <button
                onClick={() => onNavigate?.('help')}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
              >
                Manual install &rarr;
              </button>
            ) : (
              <button
                onClick={() => onNavigate?.('help')}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
              >
                Help tab &rarr;
              </button>
            )}
          </div>
          <p className="text-xs text-text-muted leading-tight">
            Standalone app with Dock/taskbar icon and badge notifications.
          </p>
        </div>
      </div>

      {/* Server */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-2">Server</h3>
        <div className="bg-surface-secondary rounded-lg p-3 divide-y divide-border-secondary shadow-sm">
          <div className="flex items-center justify-between text-sm py-2">
            <span className="font-medium text-text-secondary">Version</span>
            <div className="flex items-center gap-2">
              <span className="text-text-muted">{serverStatus?.version ?? '...'}</span>
              {(() => {
                const ui = serverStatus?.updateInfo
                const hasUpdate = ui && serverStatus && semverGt(ui.latestVersion, serverStatus.version)
                if (hasUpdate) return null
                if (updateChecking) return <span className="text-text-muted">Checking...</span>
                if (updateChecked) return <span className="text-status-success">Up to date</span>
                return (
                  <button
                    onClick={() => void handleCheckForUpdates()}
                    className="px-2.5 py-1 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
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
              <div className="flex items-center justify-between text-sm py-2">
                <span className="font-medium text-status-success">v{ui.latestVersion} available</span>
                <button
                  onClick={async () => {
                    const token = await getToken()
                    const a = document.createElement('a')
                    a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }}
                  className="px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
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
      <div className={`${wide ? 'col-span-2 grid grid-cols-2 gap-3' : 'space-y-3'}`}>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room/issues/new')}
          className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
        >
          Report Bug
        </button>
        <button
          onClick={() => window.open('mailto:hello@quoroom.ai')}
          className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
        >
          Email Developer
        </button>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room')}
          className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
        >
          Star on GitHub
        </button>
        <button
          onClick={() => window.open('mailto:hello@quoroom.ai?subject=Subscribe&body=Subscribe me for Quoroom updates')}
          className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
        >
          Subscribe for Updates
        </button>
      </div>
    </div>
  )
}
