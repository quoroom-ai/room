import { useMemo, useState } from 'react'
import { FREE_OLLAMA_MODEL_OPTIONS } from '@shared/ollama-models'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api' | 'ollama_free'

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
  needs: string
  outcome: string
}

interface RoomSetupGuideModalProps {
  roomName: string
  currentModel: string
  claude: ProviderSignal | null
  codex: ProviderSignal | null
  queenAuth: QueenAuthSignal | null
  onApplyModel: (model: string) => Promise<void>
  onClose: () => void
}

const OLLAMA_DEFAULT = FREE_OLLAMA_MODEL_OPTIONS[0]?.value ?? 'ollama:qwen3:8b'

const PATHS: SetupPath[] = [
  {
    id: 'claude_sub',
    title: 'Claude Subscription',
    model: 'claude',
    summary: 'Best default if Claude subscription is available.',
    bestFor: 'High quality strategy + execution with minimal setup work.',
    tradeoff: 'Paid subscription and rate limits depend on your plan tier.',
    needs: 'Claude CLI installed and connected in this runtime.',
    outcome: 'Fastest stable setup for most keepers.',
  },
  {
    id: 'codex_sub',
    title: 'Codex Subscription',
    model: 'codex',
    summary: 'Best if you already run ChatGPT/Codex subscription.',
    bestFor: 'Code-heavy loops and tool-driven execution.',
    tradeoff: 'Paid subscription and quota behavior depends on plan tier.',
    needs: 'Codex CLI installed and connected in this runtime.',
    outcome: 'Strong coding performance without API key management.',
  },
  {
    id: 'openai_api',
    title: 'OpenAI API',
    model: 'openai:gpt-4o-mini',
    summary: 'Use direct API key billing and explicit cost control.',
    bestFor: 'Teams who need deterministic API-key based billing.',
    tradeoff: 'You manage API keys and usage limits manually.',
    needs: 'Valid OpenAI API key in room credentials or environment.',
    outcome: 'Predictable API flow with full key ownership.',
  },
  {
    id: 'anthropic_api',
    title: 'Anthropic API',
    model: 'anthropic:claude-3-5-sonnet-latest',
    summary: 'Direct Anthropic API path using key-based auth.',
    bestFor: 'Users standardizing on Anthropic API accounts.',
    tradeoff: 'You manage keys, limits, and failures directly.',
    needs: 'Valid Anthropic API key in room credentials or environment.',
    outcome: 'Strong Claude-family behavior without subscription login.',
  },
  {
    id: 'ollama_free',
    title: 'Free Ollama',
    model: OLLAMA_DEFAULT,
    summary: 'No subscription and no API keys required.',
    bestFor: 'Zero-cost local model path and experimentation.',
    tradeoff: 'Lower quality than top hosted models; uses local/server CPU/GPU.',
    needs: 'Ollama runtime + model install (auto-started by Quoroom).',
    outcome: 'Fully self-hosted setup path with no provider account.',
  },
]

function pickRecommendedPath(
  currentModel: string,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
): SetupPathId {
  // 1. Current model is a connected subscription → keep it
  if ((currentModel === 'codex' || currentModel.startsWith('codex')) && codex?.connected === true) return 'codex_sub'
  if ((currentModel === 'claude' || currentModel.startsWith('claude')) && claude?.connected === true) return 'claude_sub'
  // 2. Any subscription connected → recommend it
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  // 3. Subscription CLI installed → recommend it
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  // 4. Current model has a ready API key → recommend that API path
  if (queenAuth?.ready) {
    if (queenAuth.provider === 'openai_api') return 'openai_api'
    if (queenAuth.provider === 'anthropic_api') return 'anthropic_api'
  }
  // 5. Fallback
  return 'ollama_free'
}

function getPathStatus(
  pathId: SetupPathId,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
): { label: string; ready: boolean } | null {
  switch (pathId) {
    case 'claude_sub':
      if (!claude) return { label: 'not detected', ready: false }
      if (claude.connected === true) return { label: 'connected', ready: true }
      if (claude.installed) return { label: 'installed, not connected', ready: false }
      return { label: 'not installed', ready: false }
    case 'codex_sub':
      if (!codex) return { label: 'not detected', ready: false }
      if (codex.connected === true) return { label: 'connected', ready: true }
      if (codex.installed) return { label: 'installed, not connected', ready: false }
      return { label: 'not installed', ready: false }
    case 'openai_api':
      if (queenAuth?.provider === 'openai_api' && queenAuth.ready) return { label: 'API key ready', ready: true }
      if (queenAuth?.provider === 'openai_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: 'API key ready', ready: true }
      return { label: 'no API key', ready: false }
    case 'anthropic_api':
      if (queenAuth?.provider === 'anthropic_api' && queenAuth.ready) return { label: 'API key ready', ready: true }
      if (queenAuth?.provider === 'anthropic_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: 'API key ready', ready: true }
      return { label: 'no API key', ready: false }
    case 'ollama_free':
      if (queenAuth?.provider === 'ollama' && queenAuth.ready) return { label: 'available', ready: true }
      return { label: 'auto-installed on first run', ready: false }
  }
}

export function RoomSetupGuideModal({
  roomName,
  currentModel,
  claude,
  codex,
  queenAuth,
  onApplyModel,
  onClose,
}: RoomSetupGuideModalProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const recommendedId = useMemo(
    () => pickRecommendedPath(currentModel, claude, codex, queenAuth),
    [currentModel, claude, codex, queenAuth]
  )
  const [selectedPathId, setSelectedPathId] = useState<SetupPathId>(recommendedId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedPath = PATHS.find((path) => path.id === selectedPathId) ?? PATHS[0]
  const isLast = step === 2

  async function handleApplyAndClose(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onApplyModel(selectedPath.model)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply setup path')
      setBusy(false)
    }
  }

  function stepDot(index: number): string {
    if (index === step) return 'bg-interactive'
    return 'bg-surface-tertiary'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-2xl rounded-2xl bg-surface-primary shadow-2xl p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Room Setup Flow</h2>
            <p className="text-sm text-text-muted">Configure {roomName} with the right model path.</p>
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

        <div className="flex gap-1.5 mb-5">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              onClick={() => !busy && setStep(index)}
              className={`h-2.5 w-2.5 rounded-full transition-colors ${stepDot(index)}`}
              aria-label={`Step ${index + 1}`}
              disabled={busy}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Pick setup path. Subscription paths are recommended when already connected.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {PATHS.map((path) => {
                const isRecommended = path.id === recommendedId
                const selected = path.id === selectedPathId
                const status = getPathStatus(path.id, claude, codex, queenAuth)
                return (
                  <button
                    key={path.id}
                    onClick={() => setSelectedPathId(path.id)}
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      selected
                        ? 'border-interactive bg-interactive-bg'
                        : 'border-border-primary bg-surface-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text-primary">{path.title}</span>
                      {isRecommended && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-status-success-bg text-status-success">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted">{path.summary}</p>
                    {status && (
                      <p className={`text-[11px] mt-1 ${status.ready ? 'text-status-success' : 'text-text-muted'}`}>
                        {status.label}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-2 text-sm">
            <h3 className="text-base font-semibold text-text-primary">{selectedPath.title}</h3>
            <div className="rounded-lg bg-surface-secondary border border-border-primary p-3 space-y-1.5">
              <p><span className="text-text-secondary font-medium">Best for:</span> <span className="text-text-muted">{selectedPath.bestFor}</span></p>
              <p><span className="text-text-secondary font-medium">Needs:</span> <span className="text-text-muted">{selectedPath.needs}</span></p>
              <p><span className="text-text-secondary font-medium">Tradeoff:</span> <span className="text-text-muted">{selectedPath.tradeoff}</span></p>
              <p><span className="text-text-secondary font-medium">Outcome:</span> <span className="text-text-muted">{selectedPath.outcome}</span></p>
            </div>
            {(() => {
              const status = getPathStatus(selectedPath.id, claude, codex, queenAuth)
              if (!status) return null
              return (
                <p className={`text-xs ${status.ready ? 'text-status-success' : 'text-text-muted'}`}>
                  Status: {status.label}.
                  {!status.ready && selectedPath.id === 'claude_sub' && ' Connect via Room Settings \u2192 Queen \u2192 Status \u2192 Connect.'}
                  {!status.ready && selectedPath.id === 'codex_sub' && ' Connect via Room Settings \u2192 Queen \u2192 Status \u2192 Connect.'}
                  {!status.ready && (selectedPath.id === 'openai_api' || selectedPath.id === 'anthropic_api') && ' Add API key in Room Settings \u2192 Queen \u2192 API key.'}
                  {!status.ready && selectedPath.id === 'ollama_free' && ' Ollama will be auto-installed on first run.'}
                </p>
              )
            })()}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-2 text-sm">
            <h3 className="text-base font-semibold text-text-primary">Apply Setup</h3>
            <p className="text-text-muted">
              Quoroom will switch queen model to <span className="font-mono text-text-secondary">{selectedPath.model}</span>.
            </p>
            {(selectedPath.id === 'openai_api' || selectedPath.id === 'anthropic_api') && (
              <p className="text-xs text-status-warning">
                Next step: add API key in Room Settings {'\u2192'} Queen {'\u2192'} API key.
              </p>
            )}
            {(selectedPath.id === 'claude_sub' || selectedPath.id === 'codex_sub') && (
              <p className="text-xs text-status-warning">
                Next step: if not connected yet, use Room Settings {'\u2192'} Queen {'\u2192'} Status {'\u2192'} Connect.
              </p>
            )}
            {selectedPath.id === 'ollama_free' && (
              <p className="text-xs text-status-warning">
                First run may take time while Ollama starts and model is installed.
              </p>
            )}
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              Back
            </button>
          )}
          {!isLast && (
            <button
              onClick={() => setStep(step + 1)}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover disabled:opacity-50"
            >
              Next
            </button>
          )}
          {isLast && (
            <button
              onClick={() => { void handleApplyAndClose() }}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover disabled:opacity-50"
            >
              {busy ? 'Applying...' : 'Apply and Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
