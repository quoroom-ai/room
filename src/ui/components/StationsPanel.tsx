import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'

const CLOUD_API = 'https://quoroom.ai/api'
const CLOUD_STATIONS_URL = 'https://quoroom.ai/stations'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700',
  stopped: 'bg-gray-200 text-gray-600',
  canceling: 'bg-orange-100 text-orange-700',
  past_due: 'bg-red-100 text-red-700',
  error: 'bg-red-100 text-red-700',
}

const STATUS_LABEL: Record<string, string> = {
  active: 'running',
  pending: 'provisioning',
  stopped: 'stopped',
  canceling: 'canceling',
  past_due: 'past due',
  error: 'error',
}

const TIER_COSTS: Record<string, string> = {
  micro: '$5/mo',
  small: '$15/mo',
  medium: '$40/mo',
  large: '$100/mo',
}

interface CloudStation {
  id: number
  roomId: string
  tier: string
  stationName: string
  flyAppName: string | null
  flyMachineId: string | null
  status: string
  monthlyCost: number
  currentPeriodEnd: string | null
  createdAt: string
  updatedAt: string
}

interface StationsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function StationsPanel({ roomId, autonomyMode }: StationsPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'
  const [cloudRoomId, setCloudRoomId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  // Fetch the cloud room ID (stable hash) from local server
  useEffect(() => {
    if (!roomId) { setCloudRoomId(null); return }
    api.rooms.cloudId(roomId).then(setCloudRoomId).catch(() => {})
  }, [roomId])

  // Poll cloud API for stations every 10s
  const { data: stations, refresh } = usePolling<CloudStation[]>(
    async () => {
      if (!cloudRoomId) return []
      try {
        const res = await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations`)
        if (!res.ok) return []
        const data = await res.json() as { stations: CloudStation[] }
        return data.stations ?? []
      } catch {
        return []
      }
    },
    10000
  )

  async function handleStart(id: number): Promise<void> {
    if (!cloudRoomId) return
    setBusy(id)
    try {
      await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${id}/start`, { method: 'POST' })
      refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleStop(id: number): Promise<void> {
    if (!cloudRoomId) return
    setBusy(id)
    try {
      await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${id}/stop`, { method: 'POST' })
      refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(id: number): Promise<void> {
    if (!cloudRoomId) return
    setBusy(id)
    try {
      await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${id}`, { method: 'DELETE' })
      setConfirmDelete(null)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  function handleAddStation(): void {
    if (!cloudRoomId) return
    window.open(`${CLOUD_STATIONS_URL}?room=${encodeURIComponent(cloudRoomId)}`, '_blank')
  }

  if (!roomId) {
    return <div className="p-4 text-xs text-gray-400">Select a room to view stations.</div>
  }

  const activeStations = (stations ?? []).filter(s => s.status === 'active')
  const totalMonthlyCost = activeStations.reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Stations</h2>
        <div className="flex items-center gap-2">
          {totalMonthlyCost > 0 && (
            <span className="text-[10px] text-gray-500">${totalMonthlyCost}/mo</span>
          )}
          {cloudRoomId && (
            <button
              onClick={handleAddStation}
              className="text-[10px] px-2 py-0.5 bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              + Add Station
            </button>
          )}
        </div>
      </div>

      {(!stations || stations.length === 0) ? (
        <div className="text-xs text-gray-400 py-4 text-center">
          No stations. Click "Add Station" to rent a cloud server.
        </div>
      ) : (
        <div className="space-y-1.5">
          {stations.map(station => (
            <div key={station.id} className="bg-gray-50 rounded-lg p-2.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-800">{station.stationName}</div>
                  <div className="text-[10px] text-gray-400 flex gap-2 mt-0.5">
                    <span className={`px-1 rounded ${STATUS_COLORS[station.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {STATUS_LABEL[station.status] ?? station.status}
                    </span>
                    <span>{station.tier}</span>
                    <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                  </div>
                </div>
                <div className="text-[10px] text-gray-400">{formatRelativeTime(station.createdAt)}</div>
              </div>

              {semi && (
                <div className="flex gap-1.5 mt-2">
                  {station.status === 'stopped' && (
                    <button
                      onClick={() => handleStart(station.id)}
                      disabled={busy === station.id}
                      className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-50"
                    >
                      Start
                    </button>
                  )}
                  {station.status === 'active' && (
                    <button
                      onClick={() => handleStop(station.id)}
                      disabled={busy === station.id}
                      className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-50"
                    >
                      Stop
                    </button>
                  )}
                  {confirmDelete === station.id ? (
                    <>
                      <button
                        onClick={() => handleDelete(station.id)}
                        disabled={busy === station.id}
                        className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-[10px] px-1.5 py-0.5 bg-gray-200 rounded"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(station.id)}
                      className="text-[10px] text-red-400 hover:text-red-600"
                    >
                      Cancel sub
                    </button>
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
