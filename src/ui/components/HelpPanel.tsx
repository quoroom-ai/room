import { APP_MODE } from '../lib/auth'

interface HelpPanelProps {
  onStartWalkthrough?: () => void
}

export function HelpPanel({ onStartWalkthrough }: HelpPanelProps): React.JSX.Element {
  return (
    <div className="p-4 space-y-4">
      {onStartWalkthrough && (
        <button
          onClick={onStartWalkthrough}
          className="w-full py-2 text-sm font-medium text-brand-700 bg-status-warning-bg hover:bg-status-warning-bg border border-amber-200 rounded-lg transition-colors"
        >
          Quick Start Guide -&gt;
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Getting Started</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-text-secondary">Create a Room</span> - a collective of agents working toward a goal. The queen starts coordinating immediately.
            </p>
            <p>
              <span className="font-medium text-text-secondary">Workers</span> - the queen spawns workers and delegates tasks. They report back and escalate when needed.
            </p>
            <p className="text-text-muted text-xs">
              Example: &quot;Build a micro-SaaS product&quot; - watch the room brainstorm, plan, and execute.
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">How It Works</h3>
          <div className="bg-surface-secondary rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-interactive">
                {APP_MODE === 'cloud' ? 'Your private server.' : '100% local.'}
              </span>{' '}
              {APP_MODE === 'cloud'
                ? 'Database, agents, memory - everything stays on your cloud server.'
                : 'Database, agents, memory - everything stays on your machine.'}
            </p>
            <p>
              {APP_MODE === 'cloud'
                ? 'Hosted server, SQLite database.'
                : <>Server at <span className="font-mono text-text-secondary">localhost:3700</span>, SQLite database.</>
              }{' '}
              Queen and workers support Claude, Codex, OpenAI, and Anthropic API models.
            </p>
            <p className="text-xs text-text-muted">
              {APP_MODE === 'cloud'
                ? 'Cloud server -> SQLite -> Room Settings model selection'
                : <><span className="font-mono">quoroom serve</span> -&gt; SQLite -&gt; Room Settings model selection</>
              }
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Key Concepts</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary flex-1">
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Queen</span>
              <span className="text-text-muted">- strategic brain, configurable model provider</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Worker</span>
              <span className="text-text-muted">- executor, can inherit queen model or use a separate API model</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Goals</span>
              <span className="text-text-muted">- hierarchical objectives</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Skills</span>
              <span className="text-text-muted">- reusable knowledge</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">Memory</span>
              <span className="text-text-muted">- persistent knowledge graph</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Quorum Voting</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              Any agent can propose an action. Proposals go to quorum - agents deliberate and vote. Majority wins by default.
            </p>
            <p>
              Check the <span className="font-medium text-text-secondary">Votes</span> tab for active proposals and history.
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">Controlling Token Usage</h3>
          <div className="bg-status-warning-bg rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              The queen runs in a continuous loop. Use <span className="font-medium text-text-secondary">Room Settings</span> to manage her activity:
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Cycle gap</span>
                <span className="text-text-muted">- sleep between cycles. 5-15 min (Pro), 1-5 min (Max).</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Max turns</span>
                <span className="text-text-muted">- tool calls per cycle. 3-5 for Pro, up to 10 for Max.</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">Quiet hours</span>
                <span className="text-text-muted">- block a time window (e.g. 22:00-08:00) so she rests.</span>
              </div>
            </div>
            <p className="text-xs text-text-muted pt-1 border-t border-amber-100">
              <span className="font-medium text-text-secondary">Tip:</span> Set your Claude plan in Preferences - Quoroom applies safe defaults automatically.
            </p>
            <p className="text-xs text-text-muted">
              <span className="font-medium text-text-secondary">No token budget?</span>{' '}
              Use a pay-per-use API model (OpenAI or Anthropic) for precise cost control.
            </p>
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
          onClick={() => { window.location.href = 'mailto:hello@email.quoroom.ai' }}
          className="w-full py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary hover:border-border-primary rounded-lg transition-colors"
        >
          Contact Developer
        </button>
      </div>
    </div>
  )
}
