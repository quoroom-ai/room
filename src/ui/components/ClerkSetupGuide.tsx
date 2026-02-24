import { useMemo, useState } from 'react'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api'

interface ProviderSignal {
  installed: boolean
  connected: boolean | null
}

interface QueenAuthSignal {
  provider: string
  mode: string
  hasCredential: boolean
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
  queenAuth: QueenAuthSignal | null
  onApplyModel: (model: string) => Promise<void>
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
  queenAuth: QueenAuthSignal | null,
): SetupPathId {
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  if (queenAuth?.ready) {
    if (queenAuth.provider === 'openai_api') return 'openai_api'
    if (queenAuth.provider === 'anthropic_api') return 'anthropic_api'
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
      if (!claude) return { label: 'not detected', ready: false }
      if (claude.connected === true) return { label: 'connected', ready: true }
      if (claude.installed) return { label: 'installed', ready: false }
      return { label: 'not installed', ready: false }
    case 'codex_sub':
      if (!codex) return { label: 'not detected', ready: false }
      if (codex.connected === true) return { label: 'connected', ready: true }
      if (codex.installed) return { label: 'installed', ready: false }
      return { label: 'not installed', ready: false }
    case 'openai_api':
      if (queenAuth?.provider === 'openai_api' && queenAuth.ready) return { label: 'ready', ready: true }
      return { label: 'no API key', ready: false }
    case 'anthropic_api':
      if (queenAuth?.provider === 'anthropic_api' && queenAuth.ready) return { label: 'ready', ready: true }
      return { label: 'no API key', ready: false }
  }
}

export function ClerkSetupGuide({
  claude,
  codex,
  queenAuth,
  onApplyModel,
  onClose,
}: ClerkSetupGuideProps): React.JSX.Element {
  const recommendedId = useMemo(
    () => pickRecommendedPath(claude, codex, queenAuth),
    [claude, codex, queenAuth]
  )
  const [selectedPathId, setSelectedPathId] = useState<SetupPathId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleApply(): Promise<void> {
    const path = selectedPathId ? PATHS.find(p => p.id === selectedPathId) : null
    if (busy || !path) return
    setBusy(true)
    setError(null)
    try {
      await onApplyModel(path.model)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-2xl rounded-2xl bg-surface-primary shadow-2xl p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
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

        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Pick a model path. The Clerk will use this to chat, commentate, and manage your system.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {PATHS.map((path) => {
              const isRecommended = path.id === recommendedId
              const isSelected = path.id === selectedPathId
              const status = getPathStatus(path.id, claude, codex, queenAuth)
              return (
                <button
                  key={path.id}
                  onClick={() => setSelectedPathId(path.id)}
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
                  <span className={`text-xs font-medium ${status.ready ? 'text-status-success' : 'text-text-muted'}`}>
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
            <div className="mt-4 p-3 rounded-lg bg-surface-secondary border border-border-primary">
              <div className="text-sm text-text-secondary space-y-1">
                <p><span className="text-text-muted">Best for:</span> {path.bestFor}</p>
                <p><span className="text-text-muted">Setup:</span> {path.setup}</p>
                <p><span className="text-text-muted">Tradeoff:</span> {path.tradeoff}</p>
              </div>
              {!status.ready && (
                <p className="text-xs text-status-warning mt-2">
                  This provider is not fully configured yet. The Clerk may not work until it is ready.
                </p>
              )}
            </div>
          )
        })()}

        {error && (
          <p className="text-sm text-status-error mt-3">{error}</p>
        )}

        <div className="flex justify-end gap-3 mt-5">
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
