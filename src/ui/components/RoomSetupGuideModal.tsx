import { useEffect, useMemo, useRef, useState } from 'react'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api' | 'gemini_api'
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

interface QueenAuthSignal {
  provider: string
  mode: string
  credentialName: string | null
  envVar: string | null
  hasCredential: boolean
  hasEnvKey: boolean
  ready: boolean
  maskedKey: string | null
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

interface RoomSetupGuideModalProps {
  roomName: string
  roomId: number
  currentModel: string
  claude: ProviderSignal | null
  codex: ProviderSignal | null
  queenAuth: QueenAuthSignal | null
  providerAuthSessions: Partial<Record<ProviderName, ProviderAuthSession | null>>
  providerInstallSessions: Partial<Record<ProviderName, ProviderInstallSession | null>>
  onInstall: (provider: ProviderName) => Promise<void>
  onConnect: (provider: ProviderName) => Promise<void>
  onDisconnect: (provider: ProviderName) => Promise<void>
  onCancelAuth: (sessionId: string) => Promise<void>
  onCancelInstall: (sessionId: string) => Promise<void>
  onRefreshProviders: () => Promise<void>
  onApplyModel: (model: string) => Promise<void>
  onSaveApiKey: (credentialName: string, key: string) => Promise<void>
  onClose: () => void
}

const PATHS: SetupPath[] = [
  {
    id: 'claude_sub',
    title: 'Claude Subscription',
    model: 'claude',
    summary: 'Best default if Claude subscription is available.',
    bestFor: 'High quality strategy + execution with minimal setup.',
    tradeoff: 'Most cost-effective. Rate limits depend on your plan tier.',
    setup: 'Claude CLI is auto-detected and connected by Quoroom.',
  },
  {
    id: 'codex_sub',
    title: 'Codex Subscription',
    model: 'codex',
    summary: 'Best if you already run ChatGPT/Codex subscription.',
    bestFor: 'Code-heavy loops and tool-driven execution.',
    tradeoff: 'Cost-effective with a subscription. Quota depends on plan tier.',
    setup: 'Codex CLI is auto-detected and connected by Quoroom.',
  },
  {
    id: 'openai_api',
    title: 'OpenAI API',
    model: 'openai:gpt-4o-mini',
    summary: 'Use direct API key billing and explicit cost control.',
    bestFor: 'Teams who need deterministic API-key based billing.',
    tradeoff: 'Pay-per-token. You manage API keys and limits.',
    setup: 'Add your OpenAI API key \u2014 Quoroom validates it automatically.',
  },
  {
    id: 'anthropic_api',
    title: 'Anthropic API',
    model: 'anthropic:claude-3-5-sonnet-latest',
    summary: 'Direct Anthropic API path using key-based auth.',
    bestFor: 'Users standardizing on Anthropic API accounts.',
    tradeoff: 'Pay-per-token. You manage keys and limits.',
    setup: 'Add your Anthropic API key \u2014 Quoroom validates it automatically.',
  },
  {
    id: 'gemini_api',
    title: 'Gemini API',
    model: 'gemini:gemini-2.5-flash',
    summary: 'Google Gemini via OpenAI-compatible endpoint.',
    bestFor: 'Access to Gemini models with pay-per-token billing.',
    tradeoff: 'Pay-per-token. You manage API keys and limits.',
    setup: 'Add your Gemini API key \u2014 Quoroom validates it automatically.',
  },
]

function pickRecommendedPath(
  currentModel: string,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
): SetupPathId {
  if ((currentModel === 'codex' || currentModel.startsWith('codex')) && codex?.connected === true) return 'codex_sub'
  if ((currentModel === 'claude' || currentModel.startsWith('claude')) && claude?.connected === true) return 'claude_sub'
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  if (queenAuth?.ready) {
    if (queenAuth.provider === 'openai_api') return 'openai_api'
    if (queenAuth.provider === 'anthropic_api') return 'anthropic_api'
    if (queenAuth.provider === 'gemini_api') return 'gemini_api'
  }
  return 'claude_sub'
}

function getPathStatus(
  pathId: SetupPathId,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
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
      if (queenAuth?.provider === 'openai_api' && queenAuth.ready) return { label: 'API key ready', ready: true }
      if (queenAuth?.provider === 'openai_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: 'API key ready', ready: true }
      return { label: 'API key required', ready: false }
    case 'anthropic_api':
      if (queenAuth?.provider === 'anthropic_api' && queenAuth.ready) return { label: 'API key ready', ready: true }
      if (queenAuth?.provider === 'anthropic_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: 'API key ready', ready: true }
      return { label: 'API key required', ready: false }
    case 'gemini_api':
      if (queenAuth?.provider === 'gemini_api' && queenAuth.ready) return { label: 'API key ready', ready: true }
      if (queenAuth?.provider === 'gemini_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: 'API key ready', ready: true }
      return { label: 'API key required', ready: false }
  }
}

function isApiPath(pathId: SetupPathId | null): pathId is 'openai_api' | 'anthropic_api' | 'gemini_api' {
  return pathId === 'openai_api' || pathId === 'anthropic_api' || pathId === 'gemini_api'
}

function isSubPath(pathId: SetupPathId | null): pathId is 'claude_sub' | 'codex_sub' {
  return pathId === 'claude_sub' || pathId === 'codex_sub'
}

function subPathProvider(pathId: 'claude_sub' | 'codex_sub'): ProviderName {
  return pathId === 'claude_sub' ? 'claude' : 'codex'
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

function apiCredentialName(pathId: 'openai_api' | 'anthropic_api' | 'gemini_api'): string {
  if (pathId === 'openai_api') return 'openai_api_key'
  if (pathId === 'gemini_api') return 'gemini_api_key'
  return 'anthropic_api_key'
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

export function RoomSetupGuideModal({
  roomName,
  currentModel,
  claude,
  codex,
  queenAuth,
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
}: RoomSetupGuideModalProps): React.JSX.Element {
  const recommendedId = useMemo(
    () => pickRecommendedPath(currentModel, claude, codex, queenAuth),
    [currentModel, claude, codex, queenAuth]
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

  // Auto-install CLI when a subscription path is selected and CLI is not installed
  const autoTriggeredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedProvider || !providerSignal) return
    if (providerBusy) return
    const key = `install:${selectedProvider}`
    if (autoTriggeredRef.current === key) return
    if (!providerSignal.installed && !installSession?.active) {
      autoTriggeredRef.current = key
      void (async () => {
        setProviderBusy(true)
        try { await onInstall(selectedProvider) } catch { /* shown in session log */ }
        finally { setProviderBusy(false) }
      })()
    }
  }, [selectedProvider, providerSignal?.installed, installSession?.active])

  // Auto-connect after install completes (CLI now installed but not connected)
  useEffect(() => {
    if (!selectedProvider || !providerSignal) return
    if (providerBusy) return
    const key = `connect:${selectedProvider}`
    if (autoTriggeredRef.current === key) return
    if (providerSignal.installed && providerSignal.connected !== true && !authSession?.active) {
      // Only auto-connect if we previously auto-installed (install session exists and completed)
      if (installSession && installSession.status === 'completed') {
        autoTriggeredRef.current = key
        void (async () => {
          setProviderBusy(true)
          try { await onConnect(selectedProvider) } catch { /* shown in session log */ }
          finally { setProviderBusy(false) }
        })()
      }
    }
  }, [selectedProvider, providerSignal?.installed, providerSignal?.connected, installSession?.status, authSession?.active])

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
        const key = apiKeyInput.trim()
        const status = getPathStatus(path.id, claude, codex, queenAuth)
        if (!status.ready && !key) {
          setError(`Enter your ${path.id === 'openai_api' ? 'OpenAI' : path.id === 'gemini_api' ? 'Gemini' : 'Anthropic'} API key to continue.`)
          return
        }
        if (key) {
          await onSaveApiKey(apiCredentialName(path.id), key)
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
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-surface-primary shadow-2xl p-5 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Room Setup</h2>
            <p className="text-xs text-text-muted">Configure {roomName} with the right model path.</p>
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
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">
              Pick a model path. Subscriptions are the most cost-effective and connect automatically.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {PATHS.map((path) => {
                const isRecommended = path.id === recommendedId
                const isSelected = path.id === selectedPathId
                const status = getPathStatus(path.id, claude, codex, queenAuth)
                return (
                  <button
                    key={path.id}
                    onClick={() => {
                      setSelectedPathId(path.id)
                      setApiKeyInput('')
                      setError(null)
                    }}
                    disabled={busy}
                    className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-interactive bg-interactive-bg'
                        : 'border-border-primary bg-surface-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-text-primary">{path.title}</span>
                      {isRecommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-success-bg text-status-success font-semibold">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-muted mb-0.5">{path.summary}</p>
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
            const status = getPathStatus(selectedPathId, claude, codex, queenAuth)
            return (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary">
                <div className="text-xs text-text-secondary space-y-0.5">
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
                {isApiPath(selectedPathId) && (() => {
                  const matchesProvider = queenAuth?.provider === selectedPathId
                  const currentMaskedKey = matchesProvider ? queenAuth?.maskedKey : null
                  const keySource = matchesProvider
                    ? queenAuth?.hasCredential ? 'saved' : queenAuth?.hasEnvKey ? `env` : null
                    : null
                  return (
                  <div className="mt-3 pt-3 border-t border-border-primary space-y-2">
                    <label className="block text-xs font-medium text-text-secondary">
                      {selectedPathId === 'openai_api' ? 'OpenAI API key' : selectedPathId === 'gemini_api' ? 'Gemini API key' : 'Anthropic API key'}
                    </label>
                    {currentMaskedKey && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-text-muted">Current:</span>
                        <code className="px-1.5 py-0.5 rounded bg-surface-primary border border-border-primary text-text-secondary font-mono">
                          {currentMaskedKey}
                        </code>
                        {keySource && (
                          <span className="text-text-muted">({keySource})</span>
                        )}
                      </div>
                    )}
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={status.ready ? 'Paste new key to replace' : 'Paste API key'}
                      disabled={busy}
                      className="w-full px-2.5 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70"
                    />
                    <p className="text-xs text-text-muted">
                      {status.ready
                        ? 'Key is validated and saved per room. Paste a new key to replace it.'
                        : 'Key is validated and saved when you apply.'}
                    </p>
                  </div>
                  )})()}

                {!status.ready && isApiPath(selectedPathId) && !apiKeyInput.trim() && (
                  <p className="text-xs text-status-warning mt-2">
                    This room needs an API key before the queen can start.
                  </p>
                )}
              </div>
            )
          })()}
        </div>

        {error && (
          <p className="text-sm text-status-error mt-3 shrink-0">{error}</p>
        )}

        <div className="flex justify-end gap-2 mt-3 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary border border-border-primary rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={busy || !selectedPathId}
            className="px-3 py-1.5 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Applying...' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
