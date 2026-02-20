import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { Station } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-100 text-green-700',
  provisioning: 'bg-amber-100 text-amber-700',
  stopped: 'bg-gray-200 text-gray-600',
  error: 'bg-red-100 text-red-700',
  destroyed: 'bg-red-50 text-red-400',
}

const TIER_COSTS: Record<string, string> = {
  micro: '$5/mo',
  small: '$15/mo',
  medium: '$40/mo',
  large: '$100/mo',
}

interface StationsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function StationsPanel({ roomId, autonomyMode }: StationsPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: stations, refresh } = usePolling<Station[]>(
    () => roomId ? api.stations.list(roomId) : Promise.resolve([]),
    10000
  )

  const wsEvent = useWebSocket(roomId ? `room:${roomId}` : '')
  if (wsEvent) refresh()

  async function handleDelete(id: number): Promise<void> {
    await api.stations.delete(id)
    setConfirmDelete(null)
    refresh()
  }

  async function handleStatusChange(id: number, status: string): Promise<void> {
    await api.stations.update(id, { status })
    refresh()
  }

  if (!roomId) {
    return <div className="p-4 text-xs text-gray-400">Select a room to view stations.</div>
  }

  const totalMonthlyCost = (stations ?? []).filter(s => s.status === 'running').reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Stations</h2>
        {totalMonthlyCost > 0 && (
          <span className="text-[10px] text-gray-500">Total: ${totalMonthlyCost}/mo</span>
        )}
      </div>

      {(!stations || stations.length === 0) ? (
        <div className="text-xs text-gray-400 py-4 text-center">
          No stations provisioned. Agents will rent servers when needed.
        </div>
      ) : (
        <div className="space-y-1.5">
          {stations.map(station => (
            <div key={station.id} className="bg-gray-50 rounded-lg p-2.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-800">{station.name}</div>
                  <div className="text-[10px] text-gray-400 flex gap-2 mt-0.5">
                    <span className={`px-1 rounded ${STATUS_COLORS[station.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {station.status}
                    </span>
                    <span>{station.tier}</span>
                    <span>{station.provider}</span>
                    <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                    {station.region && <span>{station.region}</span>}
                  </div>
                </div>
                <div className="text-[10px] text-gray-400">{formatRelativeTime(station.createdAt)}</div>
              </div>

              {semi && (
                <div className="flex gap-1.5 mt-2">
                  {station.status === 'stopped' && (
                    <button onClick={() => handleStatusChange(station.id, 'running')} className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded hover:bg-green-200">Start</button>
                  )}
                  {station.status === 'running' && (
                    <button onClick={() => handleStatusChange(station.id, 'stopped')} className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200">Stop</button>
                  )}
                  {confirmDelete === station.id ? (
                    <>
                      <button onClick={() => handleDelete(station.id)} className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded">Confirm</button>
                      <button onClick={() => setConfirmDelete(null)} className="text-[10px] px-1.5 py-0.5 bg-gray-200 rounded">Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDelete(station.id)} className="text-[10px] text-red-400 hover:text-red-600">Delete</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
