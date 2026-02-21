import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { WalletTransaction, RevenueSummary, Wallet } from '@shared/types'

const TYPE_COLORS: Record<string, string> = {
  receive: 'text-green-600',
  fund: 'text-green-600',
  send: 'text-red-500',
  purchase: 'text-red-500',
}

const BILLING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700',
  stopped: 'bg-gray-200 text-gray-600',
  canceling: 'bg-orange-100 text-orange-700',
  canceled: 'bg-gray-200 text-gray-500',
  past_due: 'bg-red-100 text-red-700',
  error: 'bg-red-100 text-red-700',
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
    return <div className="p-4 text-xs text-gray-400">Select a room to view transactions.</div>
  }

  const activeStations = (billingStations ?? []).filter(s => s.status === 'active' || s.status === 'canceling')
  const totalMonthlyCost = activeStations.reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Transactions</h2>
        <div className="flex gap-1">
          <button
            onClick={() => setSubTab('wallet')}
            className={`text-[10px] px-2 py-0.5 rounded ${subTab === 'wallet' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          >
            Wallet
          </button>
          <button
            onClick={() => setSubTab('billing')}
            className={`text-[10px] px-2 py-0.5 rounded ${subTab === 'billing' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          >
            Billing
          </button>
        </div>
      </div>

      {subTab === 'wallet' && (
        <>
          {/* Wallet Info */}
          {wallet && (
            <div className="bg-gray-50 rounded-lg p-2.5 text-xs">
              <div className="text-gray-500">Wallet</div>
              <div className="font-mono text-[10px] text-gray-700 truncate">{wallet.address}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{wallet.chain} chain</div>
            </div>
          )}

          {/* P&L Summary */}
          {summary && (
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-green-50 rounded-lg p-2 text-center">
                <div className="text-[10px] text-green-600">Income</div>
                <div className="text-xs font-semibold text-green-700">${summary.totalIncome.toFixed(2)}</div>
              </div>
              <div className="bg-red-50 rounded-lg p-2 text-center">
                <div className="text-[10px] text-red-500">Expenses</div>
                <div className="text-xs font-semibold text-red-600">${summary.totalExpenses.toFixed(2)}</div>
              </div>
              <div className={`rounded-lg p-2 text-center ${summary.netProfit >= 0 ? 'bg-blue-50' : 'bg-amber-50'}`}>
                <div className="text-[10px] text-gray-500">Net</div>
                <div className={`text-xs font-semibold ${summary.netProfit >= 0 ? 'text-blue-700' : 'text-amber-700'}`}>
                  ${summary.netProfit.toFixed(2)}
                </div>
              </div>
              <div className="bg-purple-50 rounded-lg p-2 text-center">
                <div className="text-[10px] text-purple-500">Stations</div>
                <div className="text-xs font-semibold text-purple-700">${summary.stationCosts.toFixed(2)}</div>
              </div>
            </div>
          )}

          {/* Transaction List */}
          {(!transactions || transactions.length === 0) ? (
            <div className="text-xs text-gray-400 py-4 text-center">
              No transactions yet.
            </div>
          ) : (
            <div className="space-y-1">
              {transactions.map(tx => (
                <div key={tx.id} className="bg-gray-50 rounded-lg p-2 flex items-center gap-2">
                  <div className={`text-xs font-medium w-16 ${TYPE_COLORS[tx.type] ?? 'text-gray-600'}`}>
                    {tx.type}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-700 truncate">
                      {tx.description || tx.counterparty || '-'}
                    </div>
                    {tx.txHash && (
                      <div className="text-[10px] font-mono text-gray-400 truncate">{tx.txHash}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-semibold ${TYPE_COLORS[tx.type] ?? 'text-gray-700'}`}>
                      {tx.type === 'receive' || tx.type === 'fund' ? '+' : '-'}${tx.amount}
                    </div>
                    <div className="text-[10px] text-gray-400">{formatRelativeTime(tx.createdAt)}</div>
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
            <div className="bg-purple-50 rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-purple-500">Monthly station cost</div>
              <div className="text-sm font-semibold text-purple-700">${totalMonthlyCost}/mo</div>
            </div>
          )}

          {(!billingStations || billingStations.length === 0) ? (
            <div className="text-xs text-gray-400 py-4 text-center">
              No station subscriptions.
            </div>
          ) : (
            <div className="space-y-1">
              {billingStations.map(station => (
                <div key={station.id} className="bg-gray-50 rounded-lg p-2 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-800">{station.stationName}</div>
                    <div className="text-[10px] text-gray-400 flex gap-2 mt-0.5">
                      <span className={`px-1 rounded ${BILLING_STATUS_COLORS[station.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {BILLING_STATUS_LABEL[station.status] ?? station.status}
                      </span>
                      <span>{station.tier}</span>
                      <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-gray-400">
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
