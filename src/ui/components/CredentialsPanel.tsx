import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { Credential } from '@shared/types'

const TYPE_LABELS: Record<string, string> = {
  api_key: 'API Key',
  account: 'Account',
  card: 'Card',
  other: 'Other'
}

interface CredentialsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function CredentialsPanel({ roomId }: CredentialsPanelProps): React.JSX.Element {
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [type, setType] = useState('api_key')
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: credentials, refresh } = usePolling<Credential[]>(
    () => roomId ? api.credentials.list(roomId) : Promise.resolve([]),
    10000
  )

  const wsEvent = useWebSocket(roomId ? `room:${roomId}` : '')
  if (wsEvent) refresh()

  async function handleCreate(): Promise<void> {
    if (!roomId || !name.trim() || !value.trim()) return
    await api.credentials.create(roomId, name.trim(), value.trim(), type)
    setName('')
    setValue('')
    setShowForm(false)
    refresh()
  }

  async function handleDelete(id: number): Promise<void> {
    await api.credentials.delete(id)
    setConfirmDelete(null)
    refresh()
  }

  function maskValue(val: string): string {
    if (val.length <= 8) return '••••••••'
    return val.slice(0, 4) + '••••' + val.slice(-4)
  }

  if (!roomId) {
    return <div className="p-4 text-sm text-text-muted">Select a room to view credentials.</div>
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Credentials</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs px-2.5 py-1.5 bg-surface-tertiary rounded-lg hover:bg-surface-tertiary text-text-secondary"
        >
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div className="bg-surface-secondary shadow-sm rounded-lg p-4 space-y-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name (e.g. OpenAI API Key)"
            className="w-full text-sm px-2.5 py-1.5 border border-border-primary rounded-lg bg-surface-primary text-text-primary"
          />
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Value (will be encrypted)"
            type="password"
            className="w-full text-sm px-2.5 py-1.5 border border-border-primary rounded-lg bg-surface-primary text-text-primary"
          />
          <div className="flex gap-2 items-center">
            <Select
              value={type}
              onChange={setType}
              options={[
                { value: 'api_key', label: 'API Key' },
                { value: 'account', label: 'Account' },
                { value: 'card', label: 'Card' },
                { value: 'other', label: 'Other' },
              ]}
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || !value.trim()}
              className="text-xs px-2.5 py-1.5 bg-surface-invert text-text-invert rounded-lg hover:opacity-80 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {(!credentials || credentials.length === 0) ? (
        <div className="text-sm text-text-muted py-4 text-center">
          No credentials provided yet. Agents may request API keys, accounts, or passwords.
        </div>
      ) : (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="bg-surface-secondary shadow-sm rounded-lg p-3 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary truncate">{cred.name}</div>
                <div className="text-xs text-text-muted flex gap-2">
                  <span className="bg-surface-tertiary px-1 rounded">{TYPE_LABELS[cred.type] ?? cred.type}</span>
                  <span>{maskValue(cred.valueEncrypted)}</span>
                  <span>{formatRelativeTime(cred.createdAt)}</span>
                </div>
              </div>
              {confirmDelete === cred.id ? (
                <div className="flex gap-1">
                  <button onClick={() => handleDelete(cred.id)} className="text-xs px-2.5 py-1.5 bg-status-error text-text-invert rounded-lg">Delete</button>
                  <button onClick={() => setConfirmDelete(null)} className="text-xs px-2.5 py-1.5 bg-surface-tertiary rounded-lg">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(cred.id)} className="text-xs text-status-error hover:text-red-600">Delete</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
