import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { QuorumDecision, QuorumVote, Worker } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  voting: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  vetoed: 'bg-orange-100 text-orange-700',
  expired: 'bg-gray-100 text-gray-500',
}

const TYPE_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  resource: 'Resource',
  personnel: 'Personnel',
  rule_change: 'Rule Change',
  low_impact: 'Low Impact',
}

const VOTE_COLORS: Record<string, string> = {
  yes: 'bg-green-100 text-green-700 border-green-200',
  no: 'bg-red-100 text-red-700 border-red-200',
  abstain: 'bg-gray-100 text-gray-500 border-gray-200',
}

function formatTimeout(timeoutAt: string | null): string {
  if (!timeoutAt) return ''
  const remaining = new Date(timeoutAt).getTime() - Date.now()
  if (remaining <= 0) return 'expired'
  if (remaining < 60_000) return '<1m left'
  if (remaining < 3_600_000) return `${Math.floor(remaining / 60_000)}m left`
  return `${Math.floor(remaining / 3_600_000)}h left`
}

interface VotesPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function VotesPanel({ roomId, autonomyMode }: VotesPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'

  const { data: decisions, refresh } = usePolling<QuorumDecision[]>(
    () => roomId ? api.decisions.list(roomId) : Promise.resolve([]),
    5000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 30000)

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [votesCache, setVotesCache] = useState<Record<number, QuorumVote[]>>({})
  const [showCreate, setShowCreate] = useState(false)

  // Create form
  const [createProposal, setCreateProposal] = useState('')
  const [createType, setCreateType] = useState('strategy')

  // Vote form
  const [voteWorkerId, setVoteWorkerId] = useState<number | ''>('')
  const [voteReasoning, setVoteReasoning] = useState('')

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  async function handleCreate(): Promise<void> {
    if (!createProposal.trim() || roomId === null) return
    await api.decisions.create(roomId, {
      proposal: createProposal.trim(),
      decisionType: createType,
    })
    setCreateProposal('')
    setCreateType('strategy')
    setShowCreate(false)
    refresh()
  }

  async function toggleExpand(decisionId: number): Promise<void> {
    if (expandedId === decisionId) {
      setExpandedId(null)
      return
    }
    setExpandedId(decisionId)
    if (!votesCache[decisionId]) {
      const votes = await api.decisions.getVotes(decisionId)
      setVotesCache(prev => ({ ...prev, [decisionId]: votes }))
    }
  }

  async function handleVote(decisionId: number, vote: string): Promise<void> {
    if (!voteWorkerId) return
    await api.decisions.vote(decisionId, Number(voteWorkerId), vote, voteReasoning || undefined)
    setVoteReasoning('')
    const votes = await api.decisions.getVotes(decisionId)
    setVotesCache(prev => ({ ...prev, [decisionId]: votes }))
    refresh()
  }

  async function handleResolve(decisionId: number, status: string): Promise<void> {
    await api.decisions.resolve(decisionId, status)
    refresh()
  }

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))
  const active = (decisions ?? []).filter(d => d.status === 'voting')
  const resolved = (decisions ?? []).filter(d => d.status !== 'voting')

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {decisions ? `${decisions.length} decision(s)` : 'Loading...'}
          </span>
          {!roomId && (
            <span className="text-xs text-gray-400">Select a room</span>
          )}
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Proposal'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
          <textarea
            placeholder="What should the group decide on?"
            value={createProposal}
            onChange={(e) => setCreateProposal(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y"
          />
          <div className="flex gap-2 items-center">
            <select
              value={createType}
              onChange={(e) => setCreateType(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
            >
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button
              onClick={handleCreate}
              disabled={!createProposal.trim()}
              className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Submit
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-xs text-gray-400">Select a room to view decisions.</div>
        ) : (decisions ?? []).length === 0 && decisions ? (
          <div className="p-4 text-xs text-gray-400">
            {semi ? 'No decisions yet. Submit a proposal to get started.' : 'No decisions yet. Proposals are created by agents.'}
          </div>
        ) : (
          <>
            {/* Active proposals */}
            {active.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                  Active Voting
                </div>
                <div className="divide-y divide-gray-100">
                  {active.map(d => (
                    <DecisionRow
                      key={d.id}
                      decision={d}
                      workerMap={workerMap}
                      workers={workers ?? []}
                      expanded={expandedId === d.id}
                      votes={votesCache[d.id]}
                      voteWorkerId={voteWorkerId}
                      voteReasoning={voteReasoning}
                      semi={semi}
                      onToggle={() => toggleExpand(d.id)}
                      onVote={(vote) => handleVote(d.id, vote)}
                      onResolve={(status) => handleResolve(d.id, status)}
                      onVoteWorkerChange={setVoteWorkerId}
                      onVoteReasoningChange={setVoteReasoning}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Resolved */}
            {resolved.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                  History
                </div>
                <div className="divide-y divide-gray-100">
                  {resolved.map(d => (
                    <DecisionRow
                      key={d.id}
                      decision={d}
                      workerMap={workerMap}
                      workers={workers ?? []}
                      expanded={expandedId === d.id}
                      votes={votesCache[d.id]}
                      voteWorkerId={voteWorkerId}
                      voteReasoning={voteReasoning}
                      semi={semi}
                      onToggle={() => toggleExpand(d.id)}
                      onVote={(vote) => handleVote(d.id, vote)}
                      onResolve={(status) => handleResolve(d.id, status)}
                      onVoteWorkerChange={setVoteWorkerId}
                      onVoteReasoningChange={setVoteReasoning}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface DecisionRowProps {
  decision: QuorumDecision
  workerMap: Map<number, Worker>
  workers: Worker[]
  expanded: boolean
  votes?: QuorumVote[]
  voteWorkerId: number | ''
  voteReasoning: string
  semi: boolean
  onToggle: () => void
  onVote: (vote: string) => void
  onResolve: (status: string) => void
  onVoteWorkerChange: (v: number | '') => void
  onVoteReasoningChange: (v: string) => void
}

function DecisionRow({
  decision: d, workerMap, workers, expanded, votes,
  voteWorkerId, voteReasoning, semi,
  onToggle, onVote, onResolve, onVoteWorkerChange, onVoteReasoningChange
}: DecisionRowProps): React.JSX.Element {
  const isVoting = d.status === 'voting'

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-800">{d.proposal}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${STATUS_COLORS[d.status] ?? 'bg-gray-100 text-gray-500'}`}>
              {d.status}
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-400 shrink-0">
              {TYPE_LABELS[d.decisionType] ?? d.decisionType}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-400">{formatRelativeTime(d.createdAt)}</span>
            {isVoting && d.timeoutAt && (
              <span className="text-[10px] text-orange-500">{formatTimeout(d.timeoutAt)}</span>
            )}
            {d.proposerId && workerMap.has(d.proposerId) && (
              <span className="text-[10px] text-gray-400">by {workerMap.get(d.proposerId)!.name}</span>
            )}
            {d.result && (
              <span className="text-[10px] text-gray-500 truncate">{d.result}</span>
            )}
          </div>
        </div>
        <span className="text-xs text-gray-300">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 bg-gray-50 space-y-2">
          {/* Vote buttons for active proposals */}
          {isVoting && (
            <div className="space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <select
                  value={voteWorkerId}
                  onChange={(e) => onVoteWorkerChange(e.target.value ? Number(e.target.value) : '')}
                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
                >
                  <option value="">Vote as...</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  value={voteReasoning}
                  onChange={(e) => onVoteReasoningChange(e.target.value)}
                  placeholder="Reasoning (optional)"
                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
                />
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => onVote('yes')}
                  disabled={!voteWorkerId}
                  className="text-[10px] px-2.5 py-0.5 rounded border border-green-200 text-green-600 hover:bg-green-50 disabled:opacity-50"
                >
                  Yes
                </button>
                <button
                  onClick={() => onVote('no')}
                  disabled={!voteWorkerId}
                  className="text-[10px] px-2.5 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  No
                </button>
                <button
                  onClick={() => onVote('abstain')}
                  disabled={!voteWorkerId}
                  className="text-[10px] px-2.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                  Abstain
                </button>
                {semi && (
                  <>
                    <div className="flex-1" />
                    <button
                      onClick={() => onResolve('approved')}
                      className="text-[10px] px-2 py-0.5 rounded border border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onResolve('rejected')}
                      className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Vote breakdown */}
          {votes && votes.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-gray-200">
              <div className="text-[10px] font-medium text-gray-500">Votes</div>
              {votes.map(v => (
                <div key={v.id} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-600 shrink-0">
                    {workerMap.get(v.workerId)?.name ?? `Worker #${v.workerId}`}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${VOTE_COLORS[v.vote] ?? 'bg-gray-100 text-gray-500'}`}>
                    {v.vote}
                  </span>
                  {v.reasoning && (
                    <span className="text-gray-400 truncate">{v.reasoning}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Info */}
          <div className="flex gap-3 text-[10px] text-gray-400 pt-1 border-t border-gray-200">
            <span>Threshold: {d.threshold}</span>
            {d.resolvedAt && <span>Resolved: {formatRelativeTime(d.resolvedAt)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
