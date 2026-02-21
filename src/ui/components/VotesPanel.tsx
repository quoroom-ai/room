import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { QuorumDecision, QuorumVote, Worker } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  voting: 'bg-interactive-bg text-interactive',
  approved: 'bg-status-success-bg text-status-success',
  rejected: 'bg-status-error-bg text-status-error',
  vetoed: 'bg-brand-100 text-brand-700',
  expired: 'bg-surface-tertiary text-text-muted',
}

const TYPE_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  resource: 'Resource',
  personnel: 'Personnel',
  rule_change: 'Rule Change',
  low_impact: 'Low Impact',
}

const VOTE_COLORS: Record<string, string> = {
  yes: 'bg-status-success-bg text-status-success border-green-200',
  no: 'bg-status-error-bg text-status-error border-red-200',
  abstain: 'bg-surface-tertiary text-text-muted border-border-primary',
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
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // Create form
  const [createProposal, setCreateProposal] = useState('')
  const [createType, setCreateType] = useState('strategy')

  // Vote form
  const [voteWorkerId, setVoteWorkerId] = useState<number | ''>('')
  const [voteReasoning, setVoteReasoning] = useState('')
  const [voteError, setVoteError] = useState<string | null>(null)

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
    setVoteError(null)
    try {
      await api.decisions.vote(decisionId, Number(voteWorkerId), vote, voteReasoning || undefined)
      setVoteReasoning('')
      const votes = await api.decisions.getVotes(decisionId)
      setVotesCache(prev => ({ ...prev, [decisionId]: votes }))
      refresh()
    } catch (e) {
      setVoteError((e as Error).message)
    }
  }

  async function handleKeeperVote(decisionId: number, vote: string): Promise<void> {
    setVoteError(null)
    try {
      await api.decisions.keeperVote(decisionId, vote)
      refresh()
    } catch (e) {
      setVoteError((e as Error).message)
    }
  }

  async function handleResolve(decisionId: number, status: string): Promise<void> {
    await api.decisions.resolve(decisionId, status)
    refresh()
  }

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))
  const allDecisions = decisions ?? []
  const filtered = allDecisions.filter(d => {
    if (statusFilter && d.status !== statusFilter) return false
    if (typeFilter && d.decisionType !== typeFilter) return false
    return true
  })
  const active = filtered.filter(d => d.status === 'voting')
  const resolved = filtered.filter(d => d.status !== 'voting')
  const presentStatuses = [...new Set(allDecisions.map(d => d.status))]
  const presentTypes = [...new Set(allDecisions.map(d => d.decisionType))]

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">
            {decisions ? `${decisions.length} decision(s)` : 'Loading...'}
          </span>
          {!roomId && (
            <span className="text-sm text-text-muted">Select a room</span>
          )}
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Proposal'}
          </button>
        )}
      </div>

      {allDecisions.length > 0 && (presentStatuses.length > 1 || presentTypes.length > 1) && (
        <div className="px-4 py-2 flex flex-wrap gap-2 border-b border-border-primary">
          {presentStatuses.length > 1 && presentStatuses.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? STATUS_COLORS[s] ?? 'bg-surface-tertiary text-text-muted'
                  : statusFilter === null
                    ? STATUS_COLORS[s] ?? 'bg-surface-tertiary text-text-muted'
                    : 'bg-surface-tertiary text-text-muted'
              }`}
            >
              {s}
            </button>
          ))}
          {presentStatuses.length > 1 && presentTypes.length > 1 && (
            <span className="text-text-muted text-xs leading-6">|</span>
          )}
          {presentTypes.length > 1 && presentTypes.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? null : t)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                typeFilter === t
                  ? 'bg-interactive-bg text-interactive'
                  : typeFilter === null
                    ? 'bg-surface-tertiary text-text-secondary'
                    : 'bg-surface-tertiary text-text-muted'
              }`}
            >
              {TYPE_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      )}

      {semi && showCreate && (
        <div className="p-4 border-b border-border-primary bg-surface-secondary space-y-2">
          <textarea
            placeholder="What should the group decide on?"
            value={createProposal}
            onChange={(e) => setCreateProposal(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary text-text-primary placeholder:text-text-muted resize-y"
          />
          <div className="flex gap-2 items-center">
            <Select
              value={createType}
              onChange={setCreateType}
              className="flex-1"
              options={Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
            />
            <button
              onClick={handleCreate}
              disabled={!createProposal.trim()}
              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Submit
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">Select a room to view decisions.</div>
        ) : (decisions ?? []).length === 0 && decisions ? (
          <div className="p-4 text-sm text-text-muted">
            {semi ? 'No decisions yet. Submit a proposal to get started.' : 'No decisions yet. Proposals are created by agents.'}
          </div>
        ) : (
          <>
            {/* Active proposals */}
            {active.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wide bg-surface-secondary border-b border-border-primary">
                  Active Voting
                </div>
                <div className="divide-y divide-border-primary">
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
                      voteError={voteError}
                      semi={semi}
                      onToggle={() => toggleExpand(d.id)}
                      onVote={(vote) => handleVote(d.id, vote)}
                      onKeeperVote={(vote) => handleKeeperVote(d.id, vote)}
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
                <div className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wide bg-surface-secondary border-b border-border-primary">
                  History
                </div>
                <div className="divide-y divide-border-primary">
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
                      voteError={voteError}
                      semi={semi}
                      onToggle={() => toggleExpand(d.id)}
                      onVote={(vote) => handleVote(d.id, vote)}
                      onKeeperVote={(vote) => handleKeeperVote(d.id, vote)}
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
  voteError: string | null
  semi: boolean
  onToggle: () => void
  onVote: (vote: string) => void
  onKeeperVote: (vote: string) => void
  onResolve: (status: string) => void
  onVoteWorkerChange: (v: number | '') => void
  onVoteReasoningChange: (v: string) => void
}

function DecisionRow({
  decision: d, workerMap, workers, expanded, votes,
  voteWorkerId, voteReasoning, voteError, semi,
  onToggle, onVote, onKeeperVote, onResolve, onVoteWorkerChange, onVoteReasoningChange
}: DecisionRowProps): React.JSX.Element {
  const isVoting = d.status === 'voting'

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-primary">{d.proposal}</span>
            <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium shrink-0 ${STATUS_COLORS[d.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
              {d.status}
            </span>
            <span className="px-1.5 py-0.5 rounded-lg text-xs bg-surface-tertiary text-text-muted shrink-0">
              {TYPE_LABELS[d.decisionType] ?? d.decisionType}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-text-muted">{formatRelativeTime(d.createdAt)}</span>
            {isVoting && d.timeoutAt && (
              <span className="text-xs text-orange-500">{formatTimeout(d.timeoutAt)}</span>
            )}
            <span className="text-xs text-text-muted">
              by {d.proposerId && workerMap.has(d.proposerId) ? workerMap.get(d.proposerId)!.name : 'Keeper'}
            </span>
            {d.result && (
              <span className="text-xs text-text-muted truncate">{d.result}</span>
            )}
          </div>
        </div>
        <span className="text-sm text-text-muted">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 bg-surface-secondary space-y-2">
          {/* Keeper vote */}
          {isVoting && (
            <div className="flex items-center gap-2 py-1">
              <span className="text-xs font-medium text-text-secondary shrink-0">Keeper vote:</span>
              {d.keeperVote ? (
                <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium border ${VOTE_COLORS[d.keeperVote] ?? 'bg-surface-tertiary text-text-muted'}`}>
                  {d.keeperVote}
                </span>
              ) : (
                <>
                  <button
                    onClick={() => onKeeperVote('yes')}
                    className="text-xs px-3 py-2 md:px-2 md:py-1 rounded-lg border border-green-200 text-status-success hover:bg-green-50"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => onKeeperVote('no')}
                    className="text-xs px-3 py-2 md:px-2 md:py-1 rounded-lg border border-red-200 text-status-error hover:bg-red-50"
                  >
                    No
                  </button>
                  <button
                    onClick={() => onKeeperVote('abstain')}
                    className="text-xs px-3 py-2 md:px-2 md:py-1 rounded-lg border border-border-primary text-text-muted hover:bg-surface-hover"
                  >
                    Abstain
                  </button>
                </>
              )}
            </div>
          )}

          {/* Worker vote buttons for active proposals */}
          {isVoting && (
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <Select
                  value={String(voteWorkerId)}
                  onChange={(v) => onVoteWorkerChange(v ? Number(v) : '')}
                  className="flex-1"
                  placeholder="Vote as..."
                  options={[
                    { value: '', label: 'Vote as...' },
                    ...workers.map(w => ({ value: String(w.id), label: w.name }))
                  ]}
                />
              </div>
              <div className="flex gap-2 items-center">
                <input
                  value={voteReasoning}
                  onChange={(e) => onVoteReasoningChange(e.target.value)}
                  placeholder="Reasoning (optional)"
                  className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onVote('yes')}
                  disabled={!voteWorkerId}
                  className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-green-200 text-status-success hover:bg-green-50 disabled:opacity-50"
                >
                  Yes
                </button>
                <button
                  onClick={() => onVote('no')}
                  disabled={!voteWorkerId}
                  className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-red-200 text-status-error hover:bg-red-50 disabled:opacity-50"
                >
                  No
                </button>
                <button
                  onClick={() => onVote('abstain')}
                  disabled={!voteWorkerId}
                  className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-border-primary text-text-muted hover:bg-surface-hover disabled:opacity-50"
                >
                  Abstain
                </button>
                {semi && (
                  <>
                    <div className="flex-1" />
                    <button
                      onClick={() => onResolve('approved')}
                      className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-emerald-200 text-status-success hover:bg-emerald-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onResolve('rejected')}
                      className="text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border border-red-200 text-status-error hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {voteError && (
            <div className="text-xs text-status-error">{voteError}</div>
          )}

          {/* Vote breakdown */}
          {(votes && votes.length > 0 || d.keeperVote) && (
            <div className="space-y-2 pt-1 border-t border-border-primary">
              <div className="text-xs font-medium text-text-muted">Votes</div>
              {d.keeperVote && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-secondary shrink-0 font-medium">Keeper</span>
                  <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium border ${VOTE_COLORS[d.keeperVote] ?? 'bg-surface-tertiary text-text-muted'}`}>
                    {d.keeperVote}
                  </span>
                </div>
              )}
              {(votes ?? []).map(v => (
                <div key={v.id} className="flex items-center gap-2 text-sm">
                  <span className="text-text-secondary shrink-0">
                    {workerMap.get(v.workerId)?.name ?? `Worker #${v.workerId}`}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium border ${VOTE_COLORS[v.vote] ?? 'bg-surface-tertiary text-text-muted'}`}>
                    {v.vote}
                  </span>
                  {v.reasoning && (
                    <span className="text-text-muted truncate">{v.reasoning}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Info */}
          <div className="flex gap-3 text-xs text-text-muted pt-1 border-t border-border-primary">
            <span>Threshold: {d.threshold}</span>
            {d.resolvedAt && <span>Resolved: {formatRelativeTime(d.resolvedAt)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
