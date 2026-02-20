import type { InstallPrompt } from '../hooks/useInstallPrompt'

interface HelpPanelProps {
  installPrompt: InstallPrompt
  onStartWalkthrough?: () => void
}

export function HelpPanel({ installPrompt, onStartWalkthrough }: HelpPanelProps): React.JSX.Element {
  return (
    <div className="p-4 space-y-3">
      {onStartWalkthrough && (
        <button
          onClick={onStartWalkthrough}
          className="w-full py-2 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
        >
          Quick Start Guide →
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">

        {/* Getting Started */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">Getting Started</h3>
          <div className="bg-gray-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed flex-1">
            <p>
              <span className="font-medium text-gray-700">Create a Room</span> — a collective of agents working toward a goal. The queen starts coordinating immediately.
            </p>
            <p>
              <span className="font-medium text-gray-700">Workers</span> — the queen spawns workers and delegates tasks. They report back and escalate when needed.
            </p>
            <p className="text-gray-400 text-[10px]">
              Example: &quot;Build a micro-SaaS product&quot; — watch the room brainstorm, plan, and execute.
            </p>
          </div>
        </div>

        {/* How It Works */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">How It Works</h3>
          <div className="bg-green-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed flex-1">
            <p>
              <span className="font-medium text-green-800">100% local.</span> Database, agents, memory — everything stays on your machine.
            </p>
            <p>
              Server at <span className="font-mono text-gray-700">localhost:3700</span>, SQLite database. Queen uses Claude CLI, workers use Ollama (free).
            </p>
            <p className="text-[10px] text-gray-500">
              <span className="font-mono">quoroom serve</span> → SQLite → Claude CLI / Ollama
            </p>
          </div>
        </div>

        {/* Key Concepts */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">Key Concepts</h3>
          <div className="bg-gray-50 rounded-lg p-2 space-y-1 text-xs text-gray-600 flex-1">
            <div className="flex gap-1.5">
              <span className="font-medium text-gray-700 shrink-0">Queen</span>
              <span className="text-gray-500">— strategic brain, Claude CLI</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-gray-700 shrink-0">Worker</span>
              <span className="text-gray-500">— executor, Ollama (free)</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-gray-700 shrink-0">Goals</span>
              <span className="text-gray-500">— hierarchical objectives</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-gray-700 shrink-0">Skills</span>
              <span className="text-gray-500">— reusable knowledge</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-gray-700 shrink-0">Memory</span>
              <span className="text-gray-500">— persistent knowledge graph</span>
            </div>
          </div>
        </div>

        {/* Quorum Voting */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">Quorum Voting</h3>
          <div className="bg-gray-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed flex-1">
            <p>
              Any agent can propose an action. Proposals go to quorum — agents deliberate and vote. Majority wins by default.
            </p>
            <p>
              Check the <span className="font-medium text-gray-700">Votes</span> tab for active proposals and history.
            </p>
          </div>
        </div>

        {/* Token Usage */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">Controlling Token Usage</h3>
          <div className="bg-amber-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed flex-1">
            <p>
              The queen runs in a continuous loop. Use <span className="font-medium text-gray-700">Room Settings</span> to manage her activity:
            </p>
            <div className="space-y-1">
              <div className="flex gap-1.5">
                <span className="font-medium text-amber-800 shrink-0">Cycle gap</span>
                <span className="text-gray-500">— sleep between cycles. 5–15 min (Pro), 1–5 min (Max).</span>
              </div>
              <div className="flex gap-1.5">
                <span className="font-medium text-amber-800 shrink-0">Max turns</span>
                <span className="text-gray-500">— tool calls per cycle. 3–5 for Pro, up to 10 for Max.</span>
              </div>
              <div className="flex gap-1.5">
                <span className="font-medium text-amber-800 shrink-0">Quiet hours</span>
                <span className="text-gray-500">— block a time window (e.g. 22:00–08:00) so she rests.</span>
              </div>
            </div>
            <p className="text-[10px] text-gray-500 pt-1 border-t border-amber-100">
              <span className="font-medium text-gray-600">Tip:</span> Set your Claude plan in Preferences — Quoroom applies safe defaults automatically.
            </p>
          </div>
        </div>

        {/* Install as App */}
        <div className="flex flex-col">
          <h3 className="text-xs font-semibold text-gray-700 mb-1">Install as App</h3>
          <div className="bg-gray-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 flex-1">
            {installPrompt.isInstalled ? (
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-green-600 font-medium">Installed</span>
              </div>
            ) : (
              <>
                <p className="text-gray-500">Install for Dock icon, badge notifications, and a clean window without browser UI.</p>
                {installPrompt.canInstall && (
                  <button
                    onClick={installPrompt.install}
                    className="w-full py-1.5 text-xs font-medium text-white bg-amber-500 hover:bg-amber-600 rounded transition-colors"
                  >
                    Install Quoroom
                  </button>
                )}
              </>
            )}
            <div className="space-y-0.5 pt-1 border-t border-gray-200">
              <p className="text-[10px] text-gray-400 font-medium mb-0.5">Manual install:</p>
              <p className="text-[10px] text-gray-500"><span className="font-medium text-gray-600">Chrome/Edge</span> — Menu → Install Quoroom</p>
              <p className="text-[10px] text-gray-500"><span className="font-medium text-gray-600">Safari macOS</span> — File → Add to Dock</p>
              <p className="text-[10px] text-gray-500"><span className="font-medium text-gray-600">Chrome Android</span> — Menu → Add to Home screen</p>
              <p className="text-[10px] text-gray-500"><span className="font-medium text-gray-600">Safari iOS</span> — Share → Add to Home Screen</p>
            </div>
          </div>
        </div>

      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room/issues/new')}
          className="w-full py-1.5 text-xs text-blue-500 hover:text-blue-700 border border-blue-200 hover:border-blue-300 rounded transition-colors"
        >
          Report Bug
        </button>
        <button
          onClick={() => window.open('https://github.com/quoroom-ai/room')}
          className="w-full py-1.5 text-xs text-yellow-600 hover:text-yellow-700 border border-yellow-200 hover:border-yellow-300 rounded transition-colors"
        >
          Star on GitHub
        </button>
      </div>
    </div>
  )
}
