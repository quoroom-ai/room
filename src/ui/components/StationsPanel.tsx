import { useEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import {
  ROOM_BALANCE_EVENT_TYPES,
  ROOM_STATION_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { Wallet } from '@shared/types'

const CLOUD_BASE = (import.meta.env.VITE_CLOUD_URL || 'https://quoroom.ai').replace(/\/$/, '')
const CLOUD_STATIONS_URL = `${CLOUD_BASE}/stations`

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
  micro: '$9/mo',
  small: '$25/mo',
  medium: '$89/mo',
  large: '$179/mo',
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

function formatShortDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface StationsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function StationsPanel({ roomId, autonomyMode }: StationsPanelProps): React.JSX.Element {
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)
  const [cloudRoomId, setCloudRoomId] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ id: number; action: 'cancel' | 'delete' } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const refreshTimeoutRef = useRef<number | null>(null)


  // Check if room has a wallet
  const { data: wallet, refresh: refreshWallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )


  // Fetch the cloud room ID (stable hash) from local server
  useEffect(() => {
    if (!roomId) { setCloudRoomId(null); return }
    api.rooms.cloudId(roomId).then(setCloudRoomId).catch(() => {})
  }, [roomId])

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

  // Fallback poll only; primary refresh comes from room websocket events.
  const { data: stations, refresh: refreshStations } = usePolling<CloudStation[]>(
    async () => {
      if (!roomId) return []
      try {
        const data = await api.cloudStations.list(roomId)
        return data as CloudStation[]
      } catch {
        return []
      }
    },
    60000
  )

  const { data: payments, refresh: refreshPayments } = usePolling<CloudPayment[]>(
    async () => {
      if (!roomId) return []
      try {
        return await api.cloudStations.payments(roomId) as CloudPayment[]
      } catch {
        return []
      }
    },
    120000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      const refreshStationsAndPayments = (): void => {
        if (refreshTimeoutRef.current) return
        refreshTimeoutRef.current = window.setTimeout(() => {
          refreshTimeoutRef.current = null
          void refreshStations()
          void refreshPayments()
        }, 200)
      }
      if (ROOM_STATION_EVENT_TYPES.has(event.type)) {
        refreshStationsAndPayments()
      }
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void refreshWallet()
      }
    })
  }, [refreshPayments, refreshStations, refreshWallet, roomId])

  useEffect(() => () => {
    if (refreshTimeoutRef.current) {
      window.clearTimeout(refreshTimeoutRef.current)
      refreshTimeoutRef.current = null
    }
  }, [])

  async function handleStart(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    setActionError(null)
    try {
      await api.cloudStations.start(roomId, id)
      refreshStations()
      refreshPayments()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start station')
    } finally {
      setBusy(null)
    }
  }

  async function handleStop(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    setActionError(null)
    try {
      await api.cloudStations.stop(roomId, id)
      refreshStations()
      refreshPayments()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to stop station')
    } finally {
      setBusy(null)
    }
  }

  async function handleCancel(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    setActionError(null)
    try {
      await api.cloudStations.cancel(roomId, id)
      setConfirmAction(null)
      refreshStations()
      refreshPayments()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel station')
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(id: number): Promise<void> {
    if (!roomId) return
    setBusy(id)
    setActionError(null)
    try {
      await api.cloudStations.delete(roomId, id)
      setConfirmAction(null)
      refreshStations()
      refreshPayments()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete station')
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
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">Stations</h2>
        <div className="flex items-center gap-2">
          {totalMonthlyCost > 0 && (
            <span className="text-xs text-text-muted">${totalMonthlyCost}/mo</span>
          )}
          {cloudRoomId && (
            <button
              onClick={handleAddStation}
              className="text-xs px-2.5 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover"
            >
              + Rent Station
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg rounded-lg">
          {actionError}
        </div>
      )}

      {(!stations || stations.length === 0) ? (
        <div className="text-sm text-text-muted py-4 text-center">
          No stations yet.
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
                <div className="text-xs text-text-muted text-right">
                  {station.status === 'canceling' && station.currentPeriodEnd
                    ? <span className="text-brand-700">till {formatShortDate(station.currentPeriodEnd)}</span>
                    : station.currentPeriodEnd
                      ? <>next {formatShortDate(station.currentPeriodEnd)}</>
                      : formatRelativeTime(station.createdAt)}
                </div>
              </div>

              <div className="flex gap-2 mt-2 flex-wrap">
                {station.status === 'stopped' && (
                  <button
                    onClick={() => guard(() => { void handleStart(station.id) })}
                    disabled={semi && busy === station.id}
                    className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-50 ${modeAwareButtonClass(semi, 'bg-status-success-bg text-status-success hover:bg-status-success-bg')}`}
                  >
                    Start
                  </button>
                )}
                {station.status === 'active' && (
                  <button
                    onClick={() => guard(() => { void handleStop(station.id) })}
                    disabled={semi && busy === station.id}
                    className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-50 ${modeAwareButtonClass(semi, 'bg-status-warning-bg text-status-warning hover:bg-status-warning-bg')}`}
                  >
                    Stop
                  </button>
                )}
                {semi ? (
                  confirmAction?.id === station.id ? (
                    <div>
                      {confirmAction.action === 'cancel' && station.currentPeriodEnd && (
                        <div className="text-xs text-text-muted mb-1">Active till {formatShortDate(station.currentPeriodEnd)}</div>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            if (confirmAction.action === 'cancel') {
                              void handleCancel(station.id)
                            } else {
                              void handleDelete(station.id)
                            }
                          }}
                          disabled={busy === station.id}
                          className="text-xs px-2.5 py-1.5 bg-status-error text-text-invert rounded-lg disabled:opacity-50"
                        >
                          {confirmAction.action === 'cancel' ? 'Confirm cancel' : 'Confirm delete'}
                        </button>
                        <button
                          onClick={() => setConfirmAction(null)}
                          className="text-xs px-2.5 py-1.5 bg-surface-tertiary rounded-lg"
                        >
                          Back
                        </button>
                      </div>
                    </div>
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
                  )
                ) : (
                  <>
                    {(station.status === 'active' || station.status === 'stopped') && (
                      <button
                        onClick={requestSemiMode}
                        className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                        title="Switch room to Semi mode to cancel station subscriptions"
                      >
                        Cancel sub
                      </button>
                    )}
                    {station.status !== 'canceled' && (
                      <button
                        onClick={requestSemiMode}
                        className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                        title="Switch room to Semi mode to delete stations"
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {payments && payments.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-text-secondary mb-2">Payment history</h3>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {payments.map(p => (
              <div key={p.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-text-primary truncate">{p.sourceName}</span>
                  <span className="text-text-muted shrink-0">${p.amount}</span>
                </div>
                <div className="flex items-center gap-2 min-w-0 text-xs text-text-muted">
                  <span className={`px-1 rounded ${p.status === 'paid' ? 'bg-status-success-bg text-status-success' : 'bg-surface-tertiary text-text-muted'}`}>
                    {p.status}
                  </span>
                  <span>{p.paymentMethod === 'crypto' ? p.cryptoChain ?? 'crypto' : 'card'}</span>
                  <span>{formatShortDate(p.date)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
