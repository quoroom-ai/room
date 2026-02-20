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

interface TransactionsPanelProps {
  roomId: number | null
}

export function TransactionsPanel({ roomId }: TransactionsPanelProps): React.JSX.Element {
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

  if (!roomId) {
    return <div className="p-4 text-xs text-gray-400">Select a room to view transactions.</div>
  }

  return (
    <div className="p-3 space-y-3">
      <h2 className="text-sm font-semibold text-gray-800">Transactions</h2>

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
    </div>
  )
}
