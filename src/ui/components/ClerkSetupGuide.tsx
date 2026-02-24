import { useEffect, useMemo, useRef, useState } from 'react'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api'
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
  active: boolean
  verificationUrl: string | null
  deviceCode: string | null
  lines: ProviderSessionLine[]
}

interface ProviderInstallSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderSignal {
  installed: boolean
  connected: boolean | null
}

interface ApiAuthSignal {
  hasRoomCredential: boolean
  hasSavedKey: boolean
  hasEnvKey: boolean
  ready: boolean
}

interface SetupPath {
  id: SetupPathId
  title: string
  model: string
  summary: string
  bestFor: string
  tradeoff: string
  setup: string
}

interface ClerkSetupGuideProps {
  claude: ProviderSignal | null
  codex: ProviderSignal | null
  apiAuth: {
    openai: ApiAuthSignal
    anthropic: ApiAuthSignal
  } | null
  providerAuthSessions: Partial<Record<ProviderName, ProviderAuthSession | null>>
  providerInstallSessions: Partial<Record<ProviderName, ProviderInstallSession | null>>
  onInstall: (provider: ProviderName) => Promise<void>
  onConnect: (provider: ProviderName) => Promise<void>
  onDisconnect: (provider: ProviderName) => Promise<void>
  onCancelAuth: (sessionId: string) => Promise<void>
  onCancelInstall: (sessionId: string) => Promise<void>
  onRefreshProviders: () => Promise<void>
  onApplyModel: (model: string) => Promise<void>
  onSaveApiKey: (provider: 'openai_api' | 'anthropic_api', key: string) => Promise<void>
  onClose: () => void
}

const PATHS: SetupPath[] = [
  {
    id: 'claude_sub',
    title: 'Claude Subscription',
    model: 'claude',
    summary: 'Best default if Claude subscription is available.',
    bestFor: 'High quality conversation and system management.',
    tradeoff: 'Most cost-effective option. Rate limits depend on your plan tier.',
    setup: 'Claude CLI is auto-detected and connected by Quoroom.',
  },
  {
    id: 'codex_sub',
    title: 'Codex Subscription',
    model: 'codex',
    summary: 'Best if you already run ChatGPT/Codex subscription.',
    bestFor: 'Tool-heavy execution and code-focused tasks.',
    tradeoff: 'Cost-effective with a subscription. Quota depends on your plan tier.',
    setup: 'Codex CLI is auto-detected and connected by Quoroom.',
  },
  {
    id: 'openai_api',
    title: 'OpenAI API',
    model: 'openai:gpt-4o-mini',
    summary: 'Use direct API key billing.',
    bestFor: 'Teams who need API-key based billing.',
    tradeoff: 'Pay-per-token. You manage API keys and limits.',
    setup: 'Uses OPENAI_API_KEY environment variable.',
  },
  {
    id: 'anthropic_api',
    title: 'Anthropic API',
    model: 'anthropic:claude-3-5-sonnet-latest',
    summary: 'Direct Anthropic API path.',
    bestFor: 'Users standardizing on Anthropic API accounts.',
    tradeoff: 'Pay-per-token. You manage keys and limits.',
    setup: 'Uses ANTHROPIC_API_KEY environment variable.',
  },
]

function pickRecommendedPath(
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  apiAuth: { openai: ApiAuthSignal; anthropic: ApiAuthSignal } | null,
): SetupPathId {
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  if (apiAuth?.openai.ready) return 'openai_api'
  if (apiAuth?.anthropic.ready) return 'anthropic_api'
  return 'claude_sub'
}

function getPathStatus(
  pathId: SetupPathId,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  apiAuth: { openai: ApiAuthSignal; anthropic: ApiAuthSignal } | null,
): { label: string; ready: boolean } {
  switch (pathId) {
    case 'claude_sub':
      if (!claude) return { label: 'wait. checking...', ready: false }
      if (claude.connected === true) return { label: 'connected', ready: true }
      if (claude.installed) return { label: 'installed, not connected', ready: false }
      return { label: 'not installed', ready: false }
    case 'codex_sub':
      if (!codex) return { label: 'wait. checking...', ready: false }
      if (codex.connected === true) return { label: 'connected', ready: true }
      if (codex.installed) return { label: 'installed, not connected', ready: false }
      return { label: 'not installed', ready: false }
    case 'openai_api':
      return apiAuth?.openai.ready
        ? { label: `API key ready (${describeApiAuthSource(apiAuth.openai)})`, ready: true }
        : { label: 'API key required', ready: false }
    case 'anthropic_api':
      return apiAuth?.anthropic.ready
        ? { label: `API key ready (${describeApiAuthSource(apiAuth.anthropic)})`, ready: true }
        : { label: 'API key required', ready: false }
  }
}

function isApiPath(pathId: SetupPathId | null): pathId is 'openai_api' | 'anthropic_api' {
  return pathId === 'openai_api' || pathId === 'anthropic_api'
}

function isSubPath(pathId: SetupPathId | null): pathId is 'claude_sub' | 'codex_sub' {
  return pathId === 'claude_sub' || pathId === 'codex_sub'
}

function subPathProvider(pathId: 'claude_sub' | 'codex_sub'): ProviderName {
  return pathId === 'claude_sub' ? 'claude' : 'codex'
}

function describeApiAuthSource(auth: ApiAuthSignal): string {
  if (auth.hasSavedKey) return 'Clerk key'
  if (auth.hasRoomCredential) return 'room key'
  if (auth.hasEnvKey) return 'env key'
  return 'none'
}

function sessionStatusLabel(status: ProviderSessionStatus, kind: 'install' | 'auth'): string {
  switch (status) {
    case 'starting': return 'Starting'
    case 'running': return kind === 'install' ? 'Installing' : 'Waiting for login'
    case 'completed': return kind === 'install' ? 'Installed' : 'Connected'
    case 'failed': return 'Failed'
    case 'canceled': return 'Canceled'
    case 'timeout': return 'Timed out'
    default: return status
  }
}

function sessionStatusColor(status: ProviderSessionStatus): string {
  if (status === 'completed') return 'text-status-success'
  if (status === 'failed' || status === 'timeout') return 'text-status-error'
  return 'text-text-muted'
}

function SessionLog({ lines }: { lines: ProviderSessionLine[] }): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [lines])

  const recentLines = lines.slice(-32)
  return (
    <div
      ref={logRef}
      className="max-h-32 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary p-2 font-mono text-[11px] text-text-muted"
    >
      {recentLines.length === 0
        ? 'Waiting for output...'
        : recentLines.map((line) => (
            <div key={line.id} className="whitespace-pre-wrap break-words">
              {line.text}
            </div>
          ))}
    </div>
  )
}

export function ClerkSetupGuide({
  claude,
  codex,
  apiAuth,
  providerAuthSessions,
  providerInstallSessions,
  onInstall,
  onConnect,
  onDisconnect,
  onCancelAuth,
  onCancelInstall,
  onRefreshProviders,
  onApplyModel,
  onSaveApiKey,
  onClose,
}: ClerkSetupGuideProps): React.JSX.Element {
  const recommendedId = useMemo(
    () => pickRecommendedPath(claude, codex, apiAuth),
    [claude, codex, apiAuth]
  )
  const [selectedPathId, setSelectedPathId] = useState<SetupPathId | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedPathId) setSelectedPathId(recommendedId)
  }, [recommendedId, selectedPathId])

  const selectedProvider = selectedPathId && isSubPath(selectedPathId) ? subPathProvider(selectedPathId) : null
  const providerSignal = selectedProvider === 'claude' ? claude : selectedProvider === 'codex' ? codex : null
  const authSession = selectedProvider ? (providerAuthSessions[selectedProvider] ?? null) : null
  const installSession = selectedProvider ? (providerInstallSessions[selectedProvider] ?? null) : null

  async function handleProviderAction(action: () => Promise<void>): Promise<void> {
    setProviderBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setProviderBusy(false)
    }
  }

  async function handleApply(): Promise<void> {
    const path = selectedPathId ? PATHS.find(p => p.id === selectedPathId) : null
    if (busy || !path) return
    setBusy(true)
    setError(null)
    try {
      if (isApiPath(path.id)) {
        const provider = path.id === 'openai_api' ? 'openai_api' : 'anthropic_api'
        const status = getPathStatus(path.id, claude, codex, apiAuth)
        const key = apiKeyInput.trim()
        if (!status.ready && !key) {
          setError(`Enter your ${provider === 'openai_api' ? 'OpenAI' : 'Anthropic'} API key to continue.`)
          return
        }
        if (key) {
          await onSaveApiKey(provider, key)
        }
      }
      await onApplyModel(path.model)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-surface-primary shadow-2xl p-6 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Connect Your Clerk</h2>
            <p className="text-sm text-text-muted">Choose a model to power your personal assistant.</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-text-muted hover:text-text-secondary text-lg leading-none disabled:opacity-50"
            aria-label="Close"
          >
            {'\u2715'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="space-y-3">
            <div className="rounded-xl border border-border-primary bg-surface-secondary p-3 text-sm text-text-secondary">
              <p className="font-medium text-text-primary mb-1">Who is the Clerk?</p>
              <p>
                Clerk is your global operator assistant. It can control rooms for you (create, update, pause, restart,
                delete), message rooms on your behalf, and run reminders/tasks. It also gives live commentary when you
                are idle.
              </p>
            </div>
            <p className="text-sm text-text-secondary">
              Pick a model path. The Clerk will use this to chat, commentate, and manage your system.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {PATHS.map((path) => {
                const isRecommended = path.id === recommendedId
                const isSelected = path.id === selectedPathId
                const status = getPathStatus(path.id, claude, codex, apiAuth)
                return (
                  <button
                    key={path.id}
                    onClick={() => {
                      setSelectedPathId(path.id)
                      setApiKeyInput('')
                      setError(null)
                    }}
                    disabled={busy}
                    className={`text-left p-3 rounded-xl border transition-colors ${
                      isSelected
                        ? 'border-interactive bg-interactive-bg'
                        : 'border-border-primary bg-surface-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-text-primary">{path.title}</span>
                      {isRecommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-success-bg text-status-success font-semibold">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mb-1">{path.summary}</p>
                    <span className={`text-xs font-medium ${status.ready ? 'text-status-success' : 'text-text-muted'} ${status.label === 'wait. checking...' ? 'animate-pulse' : ''}`}>
                      {status.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {selectedPathId && (() => {
            const path = PATHS.find(p => p.id === selectedPathId)!
            const status = getPathStatus(selectedPathId, claude, codex, apiAuth)
            return (
              <div className="mt-4 p-3 rounded-lg bg-surface-secondary border border-border-primary">
                <div className="text-sm text-text-secondary space-y-1">
                  <p><span className="text-text-muted">Best for:</span> {path.bestFor}</p>
                  <p><span className="text-text-muted">Setup:</span> {path.setup}</p>
                  <p><span className="text-text-muted">Tradeoff:</span> {path.tradeoff}</p>
                </div>

                {/* Subscription path: Install / Connect / Disconnect */}
                {isSubPath(selectedPathId) && selectedProvider && (
                  <div className="mt-3 pt-3 border-t border-border-primary space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs font-medium ${status.ready ? 'text-status-success' : 'text-text-muted'} ${status.label === 'wait. checking...' ? 'animate-pulse' : ''}`}>
                        {status.label}
                      </span>
                      {!providerSignal?.installed && (
                        <button
                          onClick={() => handleProviderAction(() => onInstall(selectedProvider))}
                          disabled={providerBusy || installSession?.active}
                          className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {installSession?.active ? 'Installing...' : 'Install'}
                        </button>
                      )}
                      {providerSignal?.installed && (
                        <>
                          {providerSignal.connected !== true && (
                            <button
                              onClick={() => handleProviderAction(() => onConnect(selectedProvider))}
                              disabled={providerBusy || authSession?.active || installSession?.active}
                              className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {authSession?.active ? 'Connecting...' : 'Connect'}
                            </button>
                          )}
                          <button
                            onClick={() => handleProviderAction(() => onDisconnect(selectedProvider))}
                            disabled={providerBusy}
                            className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Disconnect
                          </button>
                        </>
                      )}
                    </div>

                    {/* Install session progress */}
                    {installSession && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-text-muted">Install:</span>
                          <span className={`text-xs ${sessionStatusColor(installSession.status)}`}>
                            {sessionStatusLabel(installSession.status, 'install')}
                          </span>
                          {installSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onCancelInstall(installSession.sessionId))}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Cancel
                            </button>
                          )}
                          {!installSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onRefreshProviders())}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Refresh
                            </button>
                          )}
                        </div>
                        <SessionLog lines={installSession.lines} />
                      </div>
                    )}

                    {/* Auth session progress */}
                    {authSession && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-text-muted">Login:</span>
                          <span className={`text-xs ${sessionStatusColor(authSession.status)}`}>
                            {sessionStatusLabel(authSession.status, 'auth')}
                          </span>
                          {authSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onCancelAuth(authSession.sessionId))}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Cancel
                            </button>
                          )}
                          {!authSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onRefreshProviders())}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Refresh
                            </button>
                          )}
                        </div>
                        {authSession.deviceCode && (
                          <div className="text-xs text-text-secondary">
                            Code: <code className="px-1 py-0.5 rounded bg-surface-primary border border-border-primary">{authSession.deviceCode}</code>
                          </div>
                        )}
                        {authSession.verificationUrl && (
                          <a
                            href={authSession.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-interactive hover:underline break-all inline-block"
                          >
                            Open verification page
                          </a>
                        )}
                        <SessionLog lines={authSession.lines} />
                      </div>
                    )}
                  </div>
                )}

                {/* API key path */}
                {isApiPath(selectedPathId) && (
                  <div className="mt-3 pt-3 border-t border-border-primary space-y-2">
                    <label className="block text-xs font-medium text-text-secondary">
                      {selectedPathId === 'openai_api' ? 'OpenAI API key' : 'Anthropic API key'}
                    </label>
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={status.ready ? 'Optional: paste a new key to replace' : 'Paste API key'}
                      disabled={busy}
                      className="w-full px-2.5 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70"
                    />
                    <p className="text-xs text-text-muted">
                      {status.ready
                        ? 'A key is already available. Leave blank to reuse it; this key is shared with room setup.'
                        : 'Key is validated and saved when you connect.'}
                    </p>
                  </div>
                )}

                {!status.ready && !isSubPath(selectedPathId) && (
                  <p className="text-xs text-status-warning mt-2">
                    This provider is not fully configured yet. The Clerk may not work until it is ready.
                  </p>
                )}
              </div>
            )
          })()}
        </div>

        {error && (
          <p className="text-sm text-status-error mt-3 shrink-0">{error}</p>
        )}

        <div className="flex justify-end gap-3 mt-5 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={busy || !selectedPathId}
            className="px-4 py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Connecting...' : 'Connect Clerk'}
          </button>
        </div>
      </div>
    </div>
  )
}
