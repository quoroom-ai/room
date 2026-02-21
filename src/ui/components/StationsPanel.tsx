import { useEffect, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'

const CLOUD_STATIONS_URL = 'https://quoroom.ai/stations'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success-bg text-status-success',
  pending: 'bg-status-warning-bg text-status-warning',
  stopped: 'bg-surface-tertiary text-text-secondary',
  canceling: 'bg-brand-100 text-brand-700',
  past_due: 'bg-status-error-bg text-status-error',
  error: 'bg-status-error-bg text-status-error',
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
  const [confirmAction, setConfirmAction] = useState<{ id: number; action: 'cancel' | 'delete' } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  // Fetch the cloud room ID (stable hash) from local server
  useEffect(() => {
    if (!roomId) { setCloudRoomId(null); return }
    api.rooms.cloudId(roomId).then(setCloudRoomId).catch(() => {})
  }, [roomId])

  // Poll cloud API for stations every 10s
  const { data: stations, refresh } = usePolling<CloudStation[]>(
    async () => {
      if (!roomId) return []
      try {
        const data = await api.cloudStations.list(roomId)
        return data as CloudStation[]
      } catch {
        return []
      }
    },
    10000
  )

  async function handleStart(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    try {
      await api.cloudStations.start(roomId, id)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleStop(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    try {
      await api.cloudStations.stop(roomId, id)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleCancel(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    try {
      await api.cloudStations.cancel(roomId, id)
      setConfirmAction(null)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    try {
      await api.cloudStations.delete(roomId, id)
      setConfirmAction(null)
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
    return <div className="p-4 text-sm text-text-muted">Select a room to view stations.</div>
  }

  const activeStations = (stations ?? []).filter(s => s.status === 'active')
  const totalMonthlyCost = activeStations.reduce((sum, s) => sum + s.monthlyCost, 0)

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Stations</h2>
        <div className="flex items-center gap-2">
          {totalMonthlyCost > 0 && (
            <span className="text-xs text-text-muted">${totalMonthlyCost}/mo</span>
          )}
          {cloudRoomId && (
            <button
              onClick={handleAddStation}
              className="text-xs px-2.5 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              + Add Station
            </button>
          )}
        </div>
      </div>

      {(!stations || stations.length === 0) ? (
        <div className="text-sm text-text-muted py-4 text-center">
          No stations. Click "Add Station" to rent a cloud server.
        </div>
      ) : (
        <div className="space-y-2">
          {stations.map(station => (
            <div key={station.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">{station.stationName}</div>
                  <div className="text-xs text-text-muted flex gap-2 mt-0.5">
                    <span className={`px-1 rounded-lg ${STATUS_COLORS[station.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                      {STATUS_LABEL[station.status] ?? station.status}
                    </span>
                    <span>{station.tier}</span>
                    <span>{TIER_COSTS[station.tier] ?? `$${station.monthlyCost}/mo`}</span>
                  </div>
                </div>
                <div className="text-xs text-text-muted">
                  {station.status === 'canceling' && station.currentPeriodEnd
                    ? `ends ${formatRelativeTime(station.currentPeriodEnd)}`
                    : formatRelativeTime(station.createdAt)}
                </div>
              </div>

              {semi && (
                <div className="flex gap-2 mt-2">
                  {station.status === 'stopped' && (
                    <button
                      onClick={() => handleStart(station.id)}
                      disabled={busy === station.id}
                      className="text-xs px-2.5 py-1.5 bg-status-success-bg text-status-success rounded-lg hover:bg-status-success-bg disabled:opacity-50"
                    >
                      Start
                    </button>
                  )}
                  {station.status === 'active' && (
                    <button
                      onClick={() => handleStop(station.id)}
                      disabled={busy === station.id}
                      className="text-xs px-2.5 py-1.5 bg-status-warning-bg text-status-warning rounded-lg hover:bg-status-warning-bg disabled:opacity-50"
                    >
                      Stop
                    </button>
                  )}
                  {confirmAction?.id === station.id ? (
                    <>
                      <button
                        onClick={() => confirmAction.action === 'cancel'
                          ? handleCancel(station.id)
                          : handleDelete(station.id)}
                        disabled={busy === station.id}
                        className="text-xs px-2.5 py-1.5 bg-status-error text-white rounded-lg disabled:opacity-50"
                      >
                        {confirmAction.action === 'cancel' ? 'Confirm cancel' : 'Confirm delete'}
                      </button>
                      <button
                        onClick={() => setConfirmAction(null)}
                        className="text-xs px-2.5 py-1.5 bg-surface-tertiary rounded-lg"
                      >
                        Back
                      </button>
                    </>
                  ) : (
                    <>
                      {(station.status === 'active' || station.status === 'stopped') && (
                        <button
                          onClick={() => setConfirmAction({ id: station.id, action: 'cancel' })}
                          className="text-xs text-brand-700 hover:text-brand-700"
                          title="Cancel subscription at end of billing period"
                        >
                          Cancel sub
                        </button>
                      )}
                      {station.status !== 'canceled' && (
                        <button
                          onClick={() => setConfirmAction({ id: station.id, action: 'delete' })}
                          className="text-xs text-status-error hover:text-status-error"
                          title="Immediately destroy station and cancel subscription"
                        >
                          Delete
                        </button>
                      )}
                    </>
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
