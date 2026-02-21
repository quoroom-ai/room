import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { WalletTransaction, RevenueSummary, Wallet } from '@shared/types'

const TYPE_COLORS: Record<string, string> = {
  receive: 'text-status-success',
  fund: 'text-status-success',
  send: 'text-status-error',
  purchase: 'text-status-error',
}

const BILLING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success-bg text-status-success',
  pending: 'bg-status-warning-bg text-status-warning',
  stopped: 'bg-surface-tertiary text-text-secondary',
  canceling: 'bg-brand-100 text-brand-700',
  canceled: 'bg-surface-tertiary text-text-muted',
  past_due: 'bg-status-error-bg text-status-error',
  error: 'bg-status-error-bg text-status-error',
}

const BILLING_STATUS_LABEL: Record<string, string> = {
  active: 'active',
  pending: 'provisioning',
  stopped: 'stopped',
  canceling: 'canceling',
  canceled: 'canceled',
  past_due: 'past due',
  error: 'error',
}

const TIER_COSTS: Record<string, string> = {
  micro: '$5/mo', small: '$15/mo', medium: '$40/mo', large: '$100/mo',
}

interface CloudStation {
  id: number
  roomId: string
  tier: string
  stationName: string
  status: string
  monthlyCost: number
  currentPeriodEnd: string | null
  createdAt: string
  updatedAt: string
}

interface TransactionsPanelProps {
  roomId: number | null
}

export function TransactionsPanel({ roomId }: TransactionsPanelProps): React.JSX.Element {
  const [subTab, setSubTab] = useState<'wallet' | 'billing'>('wallet')

  const { data: wallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    30000
  )

  const { data: transactions } = usePolling<WalletTransaction[]>(
    () => roomId ? api.wallet.transactions(roomId).catch(() => []) : Promise.resolve([]),
    10000
  )

  const { data: summary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    10000
  )

  const { data: billingStations } = usePolling<CloudStation[]>(
    () => roomId ? (api.cloudStations.list(roomId) as Promise<CloudStation[]>).catch(() => []) : Promise.resolve([]),
    30000
  )

  if (!roomId) {
    return <div className="p-4 text-sm text-text-muted">Select a room to view transactions.</div>
  }

  const activeStations = (billingStations ?? []).filter(s => s.status === 'active' || s.status === 'canceling')
  const totalMonthlyCost = activeStations.reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Transactions</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab('wallet')}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${subTab === 'wallet' ? 'bg-surface-invert text-white' : 'bg-surface-tertiary text-text-muted hover:bg-surface-hover'}`}
          >
            Wallet
          </button>
          <button
            onClick={() => setSubTab('billing')}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${subTab === 'billing' ? 'bg-surface-invert text-white' : 'bg-surface-tertiary text-text-muted hover:bg-surface-hover'}`}
          >
            Billing
          </button>
        </div>
      </div>

      {subTab === 'wallet' && (
        <>
          {/* Wallet Info */}
          {wallet && (
            <div className="bg-surface-secondary rounded-lg p-3 shadow-sm text-sm">
              <div className="text-text-muted">Wallet</div>
              <div className="font-mono text-xs text-text-secondary truncate">{wallet.address}</div>
              <div className="text-xs text-text-muted mt-0.5">{wallet.chain} chain</div>
            </div>
          )}

          {/* P&L Summary */}
          {summary && (
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-status-success-bg rounded-lg p-3 text-center shadow-sm">
                <div className="text-xs text-status-success">Income</div>
                <div className="text-sm font-semibold text-status-success">${summary.totalIncome.toFixed(2)}</div>
              </div>
              <div className="bg-status-error-bg rounded-lg p-3 text-center shadow-sm">
                <div className="text-xs text-status-error">Expenses</div>
                <div className="text-sm font-semibold text-status-error">${summary.totalExpenses.toFixed(2)}</div>
              </div>
              <div className={`rounded-lg p-3 text-center shadow-sm ${summary.netProfit >= 0 ? 'bg-interactive-bg' : 'bg-status-warning-bg'}`}>
                <div className="text-xs text-text-muted">Net</div>
                <div className={`text-sm font-semibold ${summary.netProfit >= 0 ? 'text-interactive' : 'text-brand-700'}`}>
                  ${summary.netProfit.toFixed(2)}
                </div>
              </div>
              <div className="bg-status-info-bg rounded-lg p-3 text-center shadow-sm">
                <div className="text-xs text-status-info">Stations</div>
                <div className="text-sm font-semibold text-status-info">${summary.stationCosts.toFixed(2)}</div>
              </div>
            </div>
          )}

          {/* Transaction List */}
          {(!transactions || transactions.length === 0) ? (
            <div className="text-sm text-text-muted py-4 text-center">
              No transactions yet.
            </div>
          ) : (
            <div className="space-y-2">
              {transactions.map(tx => (
                <div key={tx.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm flex items-center gap-2">
                  <div className={`text-sm font-medium w-16 ${TYPE_COLORS[tx.type] ?? 'text-text-secondary'}`}>
                    {tx.type}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-secondary truncate">
                      {tx.description || tx.counterparty || '-'}
                    </div>
                    {tx.txHash && (
                      <div className="text-xs font-mono text-text-muted truncate">{tx.txHash}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-sm font-semibold ${TYPE_COLORS[tx.type] ?? 'text-text-secondary'}`}>
                      {tx.type === 'receive' || tx.type === 'fund' ? '+' : '-'}${tx.amount}
                    </div>
                    <div className="text-xs text-text-muted">{formatRelativeTime(tx.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {subTab === 'billing' && (
        <>
          {totalMonthlyCost > 0 && (
            <div className="bg-status-info-bg rounded-lg p-3 text-center shadow-sm">
              <div className="text-xs text-status-info">Monthly station cost</div>
              <div className="text-base font-semibold text-status-info">${totalMonthlyCost}/mo</div>
            </div>
          )}

          {(!billingStations || billingStations.length === 0) ? (
            <div className="text-sm text-text-muted py-4 text-center">
              No station subscriptions.
            </div>
          ) : (
            <div className="space-y-2">
              {billingStations.map(station => (
                <div key={station.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{station.stationName}</div>
                    <div className="text-xs text-text-muted flex gap-2 mt-0.5">
                      <span className={`px-1 rounded-lg ${BILLING_STATUS_COLORS[station.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                        {BILLING_STATUS_LABEL[station.status] ?? station.status}
                      </span>
                      <span>{station.tier}</span>
                      <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-text-muted">
                      {station.status === 'canceling' && station.currentPeriodEnd
                        ? `ends ${formatRelativeTime(station.currentPeriodEnd)}`
                        : formatRelativeTime(station.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
