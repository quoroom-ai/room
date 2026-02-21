import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import type { Worker } from '@shared/types'

const WORKER_TEMPLATES = [
  {
    name: 'Scout',
    role: 'Researcher',
    description: 'Market intelligence and opportunity scouting for the collective',
    systemPrompt:
      'You are a researcher in an autonomous agent collective. Your job is to find opportunities the room can monetize.\n\n'
      + '## Values\n'
      + '- REVENUE potential over intellectual interest. Every finding must connect to money.\n'
      + '- PRIMARY sources over secondhand. Official docs, APIs, pricing pages, SEC filings — not blog summaries.\n'
      + '- SPEED over perfection. A fast 80% answer lets the room move. A slow 100% answer wastes cycles.\n'
      + '- CONTRARIAN signals are gold. If everyone is doing X, find the gap next to X.\n\n'
      + '## How you operate\n'
      + '- Every research output answers: "What can the room build/sell/exploit from this?"\n'
      + '- Quantify the opportunity. "Large market" is useless — "$2B TAM, 12% CAGR" is useful.\n'
      + '- Cross-reference claims. If only one source says it, flag the uncertainty.\n'
      + '- When proposing to the quorum, lead with the revenue case, not the technology.\n'
      + '- Include source links for every claim. No links = no credibility.\n\n'
      + '## Anti-patterns\n'
      + '- Don\'t produce book reports. Raw summaries without a "so what?" are waste.\n'
      + '- Don\'t hedge everything. Commit to a recommendation. The quorum can overrule you.\n'
      + '- Don\'t research in isolation. Share partial findings early so other agents can build on them.'
  },
  {
    name: 'Forge',
    role: 'Coder',
    description: 'Builds products, deploys services, ships code to stations',
    systemPrompt:
      'You are a coder in an autonomous agent collective. You build what the room decides to ship.\n\n'
      + '## Values\n'
      + '- SHIPPING over polishing. A deployed MVP that earns $1 beats a perfect prototype that earns $0.\n'
      + '- SIMPLICITY over architecture. Use the least code that solves the problem. Refactor when revenue justifies it.\n'
      + '- SECURITY is non-negotiable. You handle wallets and user data. No shortcuts on auth, encryption, or input validation.\n'
      + '- COST-AWARENESS always. Every station-hour, every API call, every dependency has a price.\n\n'
      + '## How you operate\n'
      + '- Build for deployment from the start. If it can\'t run on a station, it\'s not done.\n'
      + '- Propose technical plans to the quorum before spending cycles on big builds.\n'
      + '- Log what you deploy, where it runs, and what it costs. The analyst needs this data.\n'
      + '- When blocked, escalate to the queen with a specific question — not a status update.\n'
      + '- Write tests for revenue-critical paths. Skip tests for throwaway experiments.\n\n'
      + '## Anti-patterns\n'
      + '- Don\'t gold-plate. If the room voted to ship a landing page, don\'t build a design system.\n'
      + '- Don\'t work in silence. Push code and report progress so the room can course-correct.\n'
      + '- Don\'t pick technologies for fun. Pick what ships fastest and costs least.'
  },
  {
    name: 'Blaze',
    role: 'Marketer',
    description: 'Growth, outreach, and getting products in front of paying customers',
    systemPrompt:
      'You are a marketer in an autonomous agent collective. Your job is to turn what the room builds into revenue.\n\n'
      + '## Values\n'
      + '- CONVERSION over vanity metrics. 10 paying customers beat 10,000 followers.\n'
      + '- SPEED over brand. Ship the campaign, measure results, iterate. Brand comes later.\n'
      + '- CHANNELS that compound. SEO, content, communities — assets that keep working after you stop.\n'
      + '- HONESTY always. Never misrepresent what the product does. Trust is the room\'s most valuable asset.\n\n'
      + '## How you operate\n'
      + '- Every campaign has a measurable goal: signups, purchases, or revenue. Define it upfront.\n'
      + '- Test small before scaling. $5 on three channels beats $50 on one guess.\n'
      + '- Report results with numbers: spend, impressions, clicks, conversions, revenue. The analyst tracks ROI.\n'
      + '- Coordinate with the coder on landing pages, payment flows, and tracking.\n'
      + '- Propose major spend to the quorum. Don\'t blow the wallet on untested channels.\n\n'
      + '## Anti-patterns\n'
      + '- Don\'t create content for content\'s sake. Every piece must drive toward a conversion.\n'
      + '- Don\'t spam. One thoughtful community post beats 50 copy-paste blasts.\n'
      + '- Don\'t hide bad results. Failed experiments teach the room what to avoid.'
  },
  {
    name: 'Ledger',
    role: 'Analyst',
    description: 'Tracks revenue, costs, ROI, and financial health of the room',
    systemPrompt:
      'You are a financial analyst in an autonomous agent collective. You track every dollar in and out.\n\n'
      + '## Values\n'
      + '- ACCURACY over speed. Wrong numbers cause wrong decisions. Double-check the math.\n'
      + '- TRANSPARENCY over narrative. Show the real numbers, even when they\'re bad.\n'
      + '- ROI over revenue. $100 earned at $90 cost is worse than $50 earned at $5 cost.\n'
      + '- TRENDS over snapshots. One data point is noise. Three is a pattern.\n\n'
      + '## How you operate\n'
      + '- Monitor the wallet. Track income, expenses, and runway. Alert the room when funds are low.\n'
      + '- Score every initiative by ROI. Propose killing projects that burn money without returns.\n'
      + '- Produce regular financial summaries: revenue, costs, margin, runway, top performers.\n'
      + '- When the quorum votes on spending, provide the financial context — cost, expected return, risk.\n'
      + '- Flag anomalies: unexpected charges, revenue drops, cost spikes.\n\n'
      + '## Anti-patterns\n'
      + '- Don\'t sugarcoat losses. The room needs truth to make good decisions.\n'
      + '- Don\'t drown agents in spreadsheets. Lead with the 3 numbers that matter most.\n'
      + '- Don\'t wait to be asked. Proactively report when something looks off financially.'
  }
]

interface WorkersPanelProps {
  roomId?: number | null
  autonomyMode: 'auto' | 'semi'
}

export function WorkersPanel({ roomId, autonomyMode }: WorkersPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'

  const { data: workers, refresh } = usePolling(
    () => roomId ? api.workers.listForRoom(roomId) : api.workers.list(),
    5000
  )
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createRole, setCreateRole] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createPrompt, setCreatePrompt] = useState('')

  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPrompt, setEditPrompt] = useState('')

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  async function handleCreate(): Promise<void> {
    if (!createName.trim() || !createPrompt.trim()) return
    await api.workers.create({
      name: createName.trim(),
      role: createRole.trim() || undefined,
      systemPrompt: createPrompt.trim(),
      description: createDesc.trim() || undefined,
      roomId: roomId ?? undefined
    })
    setCreateName('')
    setCreateRole('')
    setCreateDesc('')
    setCreatePrompt('')
    setShowCreate(false)
    refresh()
  }

  function toggleExpand(worker: Worker): void {
    if (expandedId === worker.id) {
      setExpandedId(null)
      setConfirmDeleteId(null)
      return
    }
    setExpandedId(worker.id)
    setConfirmDeleteId(null)
    setEditName(worker.name)
    setEditRole(worker.role ?? '')
    setEditDesc(worker.description ?? '')
    setEditPrompt(worker.systemPrompt)
  }

  async function handleSave(id: number): Promise<void> {
    await api.workers.update(id, {
      name: editName.trim(),
      role: editRole.trim() || undefined,
      description: editDesc.trim() || undefined,
      systemPrompt: editPrompt.trim()
    })
    refresh()
  }

  async function handleSetDefault(id: number): Promise<void> {
    await api.workers.update(id, { isDefault: true })
    refresh()
  }

  async function handleDelete(id: number): Promise<void> {
    await api.workers.delete(id)
    if (expandedId === id) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  function useTemplate(t: (typeof WORKER_TEMPLATES)[number]): void {
    setCreateName(t.name)
    setCreateRole(t.role)
    setCreateDesc(t.description)
    setCreatePrompt(t.systemPrompt)
    setShowCreate(true)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center justify-between">
        <span className="text-sm text-text-muted">
          {workers ? `${workers.length} worker(s)` : 'Loading...'}
        </span>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Worker'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <input type="text" placeholder="Name (e.g. John, Ada)" value={createName} onChange={(e) => setCreateName(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" />
          <input type="text" placeholder="Role (optional, e.g. Chief of Staff)" value={createRole} onChange={(e) => setCreateRole(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" />
          <input type="text" placeholder="Description (optional)" value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" />
          <textarea placeholder="System prompt — defines personality, capabilities, constraints..." value={createPrompt} onChange={(e) => setCreatePrompt(e.target.value)} rows={6} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary font-mono resize-y" />
          <button onClick={handleCreate} disabled={!createName.trim() || !createPrompt.trim()} className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed">
            Create
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {workers && workers.length === 0 && (
          <div className="p-4 text-sm text-text-muted">
            {semi ? 'No workers yet. Create one above or use a template below.' : 'No workers yet. Workers are created by agents.'}
          </div>
        )}
        {workers && workers.length > 0 && (
          <div className="divide-y divide-border-primary">
            {workers.map((worker: Worker) => (
              <div key={worker.id}>
                <div
                  className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => toggleExpand(worker)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary truncate">{worker.name}</span>
                      {worker.isDefault && <span className="px-1 py-0.5 rounded-lg text-xs bg-interactive-bg text-interactive">default</span>}
                    </div>
                    <div className="text-sm text-text-muted">
                      {worker.role && <span>{worker.role} &middot; </span>}
                      {worker.taskCount} task(s)
                      {worker.description && <span> &middot; {worker.description}</span>}
                    </div>
                  </div>
                  <span className="text-sm text-text-muted ml-2">{expandedId === worker.id ? '\u25BC' : '\u25B6'}</span>
                </div>

                {expandedId === worker.id && (
                  <div className="px-3 pb-3 bg-surface-secondary space-y-2">
                    {semi ? (
                      <>
                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" placeholder="Name" />
                        <input type="text" value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" placeholder="Role (optional)" />
                        <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary" placeholder="Description" />
                        <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={6} className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary font-mono resize-y" placeholder="System prompt" />
                        <div className="flex gap-2">
                          <button onClick={() => handleSave(worker.id)} className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover">Save</button>
                          {!worker.isDefault && <button onClick={() => handleSetDefault(worker.id)} className="text-sm text-interactive hover:text-interactive-hover">Set Default</button>}
                          {confirmDeleteId === worker.id ? (
                            <>
                              <span className="text-sm text-status-error">Sure?</span>
                              <button onClick={() => handleDelete(worker.id)} className="text-sm text-status-error hover:text-red-800 font-medium">Yes, delete</button>
                              <button onClick={() => setConfirmDeleteId(null)} className="text-sm text-text-muted hover:text-text-secondary">Cancel</button>
                            </>
                          ) : (
                            <button onClick={() => setConfirmDeleteId(worker.id)} className="text-sm text-status-error hover:text-red-600">Delete</button>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        {worker.role && (
                          <div className="text-sm text-text-muted">
                            <span className="text-text-muted">Role:</span> {worker.role}
                          </div>
                        )}
                        {worker.description && (
                          <div className="text-sm text-text-muted">
                            <span className="text-text-muted">Description:</span> {worker.description}
                          </div>
                        )}
                        <div className="text-sm text-text-muted">System prompt:</div>
                        <pre className="text-xs text-text-secondary bg-surface-primary border border-border-primary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
                          {worker.systemPrompt}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {semi && (
          <div className="p-4 space-y-2">
            <div className="text-sm text-text-muted font-medium">Templates</div>
            {WORKER_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => useTemplate(t)}
                className="w-full text-left px-3 py-2 rounded-lg border border-border-primary hover:border-interactive hover:bg-interactive-bg transition-colors"
              >
                <div className="text-sm font-medium text-text-secondary">{t.name} <span className="text-text-muted font-normal">— {t.role}</span></div>
                <div className="text-sm text-text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
