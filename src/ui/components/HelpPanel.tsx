import type { InstallPrompt } from '../hooks/useInstallPrompt'

interface HelpPanelProps {
  installPrompt: InstallPrompt
}

export function HelpPanel({ installPrompt }: HelpPanelProps): React.JSX.Element {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Getting Started</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed">
          <p>
            <span className="font-medium text-gray-700">Create a Room</span> — a room is a collective of agents
            working toward a goal. Set an objective and the queen agent will start coordinating.
          </p>
          <p>
            <span className="font-medium text-gray-700">Workers</span> — create workers from templates
            or custom prompts. The queen delegates tasks to workers, and they report back.
          </p>
          <p className="text-gray-400 text-[10px]">
            Example: Set the goal to &quot;Build a micro-SaaS product&quot; and watch the room brainstorm,
            plan, and execute.
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">How It Works</h3>
        <div className="bg-green-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed">
          <p>
            <span className="font-medium text-green-800">100% local.</span> Quoroom runs entirely on your
            machine — database, agents, memory, and all data stay on your computer. Nothing is sent to any cloud.
          </p>
          <p>
            The server runs at <span className="font-mono text-gray-700">localhost:3700</span> and stores everything
            in a local SQLite database. Agents use Claude CLI or Ollama — your keys, your hardware.
          </p>
          <p className="text-[10px] text-gray-500">
            Architecture: <span className="font-mono">quoroom serve</span> &rarr; SQLite (your database) &rarr; Claude CLI / Ollama (your LLMs)
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Quorum Voting</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed">
          <p>
            Any agent can propose an action. Proposals go through quorum — agents deliberate and vote.
            Majority wins by default, but the room can change its own rules.
          </p>
          <p>
            Check the <span className="font-medium text-gray-700">Votes</span> tab to see active proposals
            and decision history.
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Key Concepts</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-1 text-xs text-gray-600">
          <div className="flex gap-1.5">
            <span className="font-medium text-gray-700 shrink-0">Queen</span>
            <span className="text-gray-500">— strategic brain, uses Claude CLI, coordinates workers</span>
          </div>
          <div className="flex gap-1.5">
            <span className="font-medium text-gray-700 shrink-0">Worker</span>
            <span className="text-gray-500">— specialized agent, uses Ollama (free), escalates to queen</span>
          </div>
          <div className="flex gap-1.5">
            <span className="font-medium text-gray-700 shrink-0">Goals</span>
            <span className="text-gray-500">— hierarchical objectives with progress tracking</span>
          </div>
          <div className="flex gap-1.5">
            <span className="font-medium text-gray-700 shrink-0">Skills</span>
            <span className="text-gray-500">— reusable knowledge agents create and share</span>
          </div>
          <div className="flex gap-1.5">
            <span className="font-medium text-gray-700 shrink-0">Memory</span>
            <span className="text-gray-500">— persistent knowledge graph across all agents</span>
          </div>
        </div>
      </div>

      {/* Token Usage & Activity Limits */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Controlling Token Usage</h3>
        <div className="bg-amber-50 rounded-lg p-2 space-y-1.5 text-xs text-gray-600 leading-relaxed">
          <p>
            The queen runs in a continuous loop — without limits she will consume tokens at full speed.
            Use the controls in <span className="font-medium text-gray-700">Room Settings</span> to manage her activity:
          </p>
          <div className="space-y-1 pt-0.5">
            <div className="flex gap-1.5">
              <span className="font-medium text-amber-800 shrink-0">Cycle gap</span>
              <span className="text-gray-500">— sleep between cycles. Set 5–15 min for Pro, 1–5 min for Max.</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-amber-800 shrink-0">Max turns</span>
              <span className="text-gray-500">— tool calls per cycle. Lower = shorter, cheaper runs (3–5 for Pro).</span>
            </div>
            <div className="flex gap-1.5">
              <span className="font-medium text-amber-800 shrink-0">Quiet hours</span>
              <span className="text-gray-500">— block off a time window (e.g. 22:00–08:00) so she rests overnight.</span>
            </div>
          </div>
          <p className="text-[10px] text-gray-500 pt-0.5 border-t border-amber-100">
            <span className="font-medium text-gray-600">Tip:</span> Set your Claude plan in <span className="font-medium text-gray-600">Preferences</span> — Quoroom will apply safe defaults automatically when you create a new room. If you're on Pro, start with 15 min gap and 5 max turns. On Max, 1–5 min and 10 turns work well.
          </p>
        </div>
      </div>

      {/* Install as App */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mb-1">Install as App</h3>
        <div className="bg-gray-50 rounded-lg p-2 space-y-2 text-xs text-gray-600 leading-relaxed">
          {installPrompt.isInstalled ? (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-green-600 font-medium">Installed</span>
            </div>
          ) : (
            <>
              <p className="text-gray-500">
                Install Quoroom as a standalone app for quick access from your Dock/taskbar, badge notifications, and a clean window without browser UI.
              </p>
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
          <div className="space-y-1.5 pt-1 border-t border-gray-200">
            <p className="text-[10px] text-gray-400 font-medium">Manual install by browser:</p>
            <div className="space-y-1">
              <p className="text-[10px] text-gray-500">
                <span className="font-medium text-gray-600">Chrome / Edge</span> — Menu (...) &rarr; Cast, Save, and Share &rarr; Install Quoroom
              </p>
              <p className="text-[10px] text-gray-500">
                <span className="font-medium text-gray-600">Safari (macOS)</span> — File &rarr; Add to Dock
              </p>
              <p className="text-[10px] text-gray-500">
                <span className="font-medium text-gray-600">Chrome (Android)</span> — Menu (&vellip;) &rarr; Add to Home screen
              </p>
              <p className="text-[10px] text-gray-500">
                <span className="font-medium text-gray-600">Safari (iOS)</span> — Share &rarr; Add to Home Screen
              </p>
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
