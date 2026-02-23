import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import {
  ROOM_BALANCE_EVENT_TYPES,
  ROOM_STATION_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { getCachedToken } from '../lib/auth'
import { formatRelativeTime } from '../utils/time'
import { CopyAddressButton } from './CopyAddressButton'
import type { WalletTransaction, RevenueSummary, Wallet, OnChainBalance } from '@shared/types'

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
  micro: '$9/mo', small: '$25/mo', medium: '$89/mo', large: '$179/mo',
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
  const [showCryptoTopUp, setShowCryptoTopUp] = useState(false)

  const { data: wallet, refresh: refreshWallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  const { data: transactions, refresh: refreshTransactions } = usePolling<WalletTransaction[]>(
    () => roomId && wallet ? api.wallet.transactions(roomId).catch(() => []) : Promise.resolve([]),
    30000
  )

  const { data: summary, refresh: refreshSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  const { data: onChainBalance, refresh: refreshOnChainBalance } = usePolling<OnChainBalance | null>(
    () => roomId && wallet ? api.wallet.balance(roomId).catch(() => null) : Promise.resolve(null),
    90000
  )

  const { data: billingStations, refresh: refreshBillingStations } = usePolling<CloudStation[]>(
    () => roomId ? (api.cloudStations.list(roomId) as Promise<CloudStation[]>).catch(() => []) : Promise.resolve([]),
    60000
  )

  interface CloudPayment {
    id: string
    sourceName: string
    status: string
    amount: number
    currency: string
    date: string
    paymentMethod: string
    cryptoTxHash?: string
    cryptoChain?: string
  }

  const { data: billingPayments, refresh: refreshBillingPayments } = usePolling<CloudPayment[]>(
    () => roomId ? (api.cloudStations.payments(roomId) as Promise<CloudPayment[]>).catch(() => []) : Promise.resolve([]),
    120000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void refreshWallet()
        void refreshTransactions()
        void refreshSummary()
        void refreshOnChainBalance()
      }
      if (ROOM_STATION_EVENT_TYPES.has(event.type)) {
        void refreshBillingStations()
        void refreshBillingPayments()
      }
    })
  }, [
    refreshBillingPayments,
    refreshBillingStations,
    refreshOnChainBalance,
    refreshSummary,
    refreshTransactions,
    refreshWallet,
    roomId,
  ])

  if (!roomId) {
    return <div className="p-4 text-sm text-text-muted">Select a room to view transactions.</div>
  }

  const activeStations = (billingStations ?? []).filter(s => s.status === 'active' || s.status === 'canceling')
  const totalMonthlyCost = activeStations.reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">Transactions</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab('wallet')}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${
              subTab === 'wallet'
                ? 'bg-interactive text-text-invert hover:bg-interactive-hover'
                : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
            }`}
          >
            Wallet
          </button>
          <button
            onClick={() => setSubTab('billing')}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${
              subTab === 'billing'
                ? 'bg-interactive text-text-invert hover:bg-interactive-hover'
                : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
            }`}
          >
            Billing
          </button>
          {subTab === 'wallet' && wallet && (
            <>
              <a
                href={roomId ? `/api/rooms/${roomId}/wallet/onramp-redirect?token=${encodeURIComponent(getCachedToken() ?? '')}` : '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover no-underline"
              >
                Top Up from Card
              </a>
              <button
                onClick={() => setShowCryptoTopUp(true)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-tertiary text-text-primary hover:bg-surface-hover"
              >
                Top Up with Crypto
              </button>
            </>
          )}
        </div>
      </div>

      {subTab === 'wallet' && (
        <>
          {/* Wallet Info */}
          {wallet && (
            <div className="bg-surface-secondary rounded-lg p-3 shadow-sm text-sm">
              <div className="text-text-muted">Wallet</div>
              <div className="flex items-center gap-1">
                <div className="font-mono text-xs text-text-secondary truncate">{wallet.address}</div>
                <CopyAddressButton address={wallet.address} />
              </div>
              <div className="text-xs text-text-muted mt-0.5">EVM</div>
            </div>
          )}

          {/* P&L Summary */}
          {summary && (
            <div className={`grid gap-2 ${onChainBalance && onChainBalance.totalBalance > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
              {onChainBalance && onChainBalance.totalBalance > 0 && (
                <div className="bg-interactive-bg rounded-lg p-3 text-center shadow-sm">
                  <div className="text-xs text-interactive">Balance</div>
                  <div className="text-sm font-semibold text-interactive">${onChainBalance.totalBalance.toFixed(2)}</div>
                </div>
              )}
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

          {billingStations && billingStations.length > 0 && (
            <>
              <div className="text-xs font-medium text-text-muted uppercase tracking-wide">Active subscriptions</div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {billingStations.map(station => (
                  <div key={station.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium text-text-primary">{station.stationName}</div>
                      <div className="text-xs text-text-muted text-right">
                        {station.status === 'canceling' && station.currentPeriodEnd
                          ? `ends ${formatRelativeTime(station.currentPeriodEnd)}`
                          : formatRelativeTime(station.createdAt)}
                      </div>
                    </div>
                    <div className="text-xs text-text-muted flex flex-wrap gap-2">
                      <span className={`px-1 rounded-lg ${BILLING_STATUS_COLORS[station.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                        {BILLING_STATUS_LABEL[station.status] ?? station.status}
                      </span>
                      <span>{station.tier}</span>
                      <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {billingPayments && billingPayments.length > 0 ? (
            <>
              <div className="text-xs font-medium text-text-muted uppercase tracking-wide">Payment history</div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {billingPayments.map(p => (
                  <div key={p.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm text-text-primary">{p.sourceName}</div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-text-secondary">${p.amount}</div>
                        <div className="text-xs text-text-muted">{formatRelativeTime(p.date)}</div>
                      </div>
                    </div>
                    <div className="text-xs text-text-muted flex flex-wrap gap-2">
                      <span className={`px-1 rounded ${p.status === 'paid' ? 'bg-status-success-bg text-status-success' : 'bg-surface-tertiary text-text-muted'}`}>
                        {p.status}
                      </span>
                      <span>{p.paymentMethod === 'crypto' ? p.cryptoChain ?? 'crypto' : 'card'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (!billingStations || billingStations.length === 0) ? (
            <div className="text-sm text-text-muted py-4 text-center">
              No station subscriptions.
            </div>
          ) : null}
        </>
      )}

      {showCryptoTopUp && wallet && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) setShowCryptoTopUp(false) }}
        >
          <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 relative">
            <button
              onClick={() => setShowCryptoTopUp(false)}
              className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
              aria-label="Close"
            >
              {'\u2715'}
            </button>
            <h2 className="text-lg font-bold text-text-primary mb-4">Top Up with Crypto</h2>
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Send USDC or USDT to the wallet address below. The balance updates automatically.
              </p>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Wallet address</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-text-primary font-mono truncate flex-1">{wallet.address}</code>
                  <CopyAddressButton address={wallet.address} />
                </div>
              </div>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Supported chains</div>
                <div className="text-sm text-text-primary">Base, Ethereum, Arbitrum, Optimism, Polygon</div>
              </div>
              <div className="bg-surface-secondary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Supported tokens</div>
                <div className="text-sm text-text-primary">USDC, USDT</div>
              </div>
              <p className="text-xs text-text-muted">
                Same address works on all EVM chains. Send from any exchange or wallet. Balance is aggregated across all networks.
              </p>
              <button
                onClick={() => setShowCryptoTopUp(false)}
                className="w-full py-2 text-sm font-medium text-center text-text-primary bg-surface-tertiary hover:bg-surface-hover rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
