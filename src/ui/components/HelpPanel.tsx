import type { InstallPrompt } from '../hooks/useInstallPrompt'

interface HelpPanelProps {
  installPrompt: InstallPrompt
  onStartWalkthrough?: () => void
}

export function HelpPanel({ installPrompt, onStartWalkthrough }: HelpPanelProps): React.JSX.Element {
  return (
    <div className="p-4 space-y-4">
      {onStartWalkthrough && (
        <button
          onClick={onStartWalkthrough}
          className="w-full py-2 text-sm font-medium text-brand-700 bg-status-warning-bg hover:bg-status-warning-bg border border-amber-200 rounded-lg transition-colors"
        >
          Quick Start Guide →
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">

        {/* Getting Started */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Getting Started</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-text-secondary">Create a Room</span> — a collective of agents working toward a goal. The queen starts coordinating immediately.
            </p>
            <p>
              <span className="font-medium text-text-secondary">Workers</span> — the queen spawns workers and delegates tasks. They report back and escalate when needed.
            </p>
            <p className="text-text-muted text-xs">
              Example: &quot;Build a micro-SaaS product&quot; — watch the room brainstorm, plan, and execute.
            </p>
          </div>
        </div>

        {/* How It Works */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">How It Works</h3>
          <div className="bg-surface-secondary rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-interactive">100% local.</span> Database, agents, memory — everything stays on your machine.
            </p>
            <p>
              Server at <span className="font-mono text-text-secondary">localhost:3700</span>, SQLite database. Queen uses Claude CLI, workers use Ollama (free).
            </p>
            <p className="text-xs text-text-muted">
              <span className="font-mono">quoroom serve</span> → SQLite → Claude CLI / Ollama
            </p>
          </div>
        </div>

        {/* Key Concepts */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Key Concepts</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary flex-1">
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Queen</span>
              <span className="text-text-muted">— strategic brain, Claude CLI</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Worker</span>
              <span className="text-text-muted">— executor, Ollama (free)</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Goals</span>
              <span className="text-text-muted">— hierarchical objectives</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Skills</span>
              <span className="text-text-muted">— reusable knowledge</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Memory</span>
              <span className="text-text-muted">— persistent knowledge graph</span>
            </div>
          </div>
        </div>

        {/* Quorum Voting */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Quorum Voting</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              Any agent can propose an action. Proposals go to quorum — agents deliberate and vote. Majority wins by default.
            </p>
            <p>
              Check the <span className="font-medium text-text-secondary">Votes</span> tab for active proposals and history.
            </p>
          </div>
        </div>

        {/* Token Usage */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Controlling Token Usage</h3>
          <div className="bg-status-warning-bg rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              The queen runs in a continuous loop. Use <span className="font-medium text-text-secondary">Room Settings</span> to manage her activity:
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Cycle gap</span>
                <span className="text-text-muted">— sleep between cycles. 5–15 min (Pro), 1–5 min (Max).</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Max turns</span>
                <span className="text-text-muted">— tool calls per cycle. 3–5 for Pro, up to 10 for Max.</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Quiet hours</span>
                <span className="text-text-muted">— block a time window (e.g. 22:00–08:00) so she rests.</span>
              </div>
            </div>
            <p className="text-xs text-text-muted pt-1 border-t border-amber-100">
              <span className="font-medium text-text-secondary">Tip:</span> Set your Claude plan in Preferences — Quoroom applies safe defaults automatically.
            </p>
          </div>
        </div>

        {/* Install as App */}
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Install as App</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary flex-1">
            {installPrompt.isInstalled ? (
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                <span className="text-status-success font-medium">Installed</span>
              </div>
            ) : (
              <>
                <p className="text-text-muted">Install for Dock icon, badge notifications, and a clean window without browser UI.</p>
                {installPrompt.canInstall && (
                  <button
                    onClick={installPrompt.install}
                    className="w-full py-1.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
                  >
                    Install Quoroom
                  </button>
                )}
              </>
            )}
            <div className="space-y-0.5 pt-1 border-t border-border-primary">
              <p className="text-xs text-text-muted font-medium mb-0.5">Manual install:</p>
              <p className="text-xs text-text-muted"><span className="font-medium text-text-secondary">Chrome/Edge</span> — Menu → Install Quoroom</p>
              <p className="text-xs text-text-muted"><span className="font-medium text-text-secondary">Safari macOS</span> — File → Add to Dock</p>
              <p className="text-xs text-text-muted"><span className="font-medium text-text-secondary">Chrome Android</span> — Menu → Add to Home screen</p>
              <p className="text-xs text-text-muted"><span className="font-medium text-text-secondary">Safari iOS</span> — Share → Add to Home Screen</p>
            </div>
          </div>
        </div>

      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room/issues/new')}
          className="w-full py-2 text-sm text-interactive hover:text-interactive-hover border border-border-primary hover:border-interactive rounded-lg transition-colors"
        >
          Report Bug
        </button>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room')}
          className="w-full py-2 text-sm text-status-warning hover:text-status-warning border border-yellow-200 hover:border-yellow-300 rounded-lg transition-colors"
        >
          Star on GitHub
        </button>
        <button
          onClick={() => { window.location.href = 'mailto:hello@quoroom.ai' }}
          className="w-full py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary hover:border-border-primary rounded-lg transition-colors"
        >
          Contact Developer
        </button>
      </div>
    </div>
  )
}
