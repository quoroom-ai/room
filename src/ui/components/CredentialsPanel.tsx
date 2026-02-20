import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
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
    return <div className="p-4 text-xs text-gray-400">Select a room to view credentials.</div>
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Credentials</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-[10px] px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200 text-gray-600"
        >
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded-lg p-3 space-y-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name (e.g. OpenAI API Key)"
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded"
          />
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Value (will be encrypted)"
            type="password"
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded"
          />
          <div className="flex gap-2 items-center">
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="text-xs px-2 py-1 border border-gray-200 rounded"
            >
              <option value="api_key">API Key</option>
              <option value="account">Account</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </select>
            <button
              onClick={handleCreate}
              disabled={!name.trim() || !value.trim()}
              className="text-[10px] px-2 py-1 bg-gray-800 text-white rounded hover:bg-gray-700 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {(!credentials || credentials.length === 0) ? (
        <div className="text-xs text-gray-400 py-4 text-center">
          No credentials provided yet. Agents may request API keys, accounts, or passwords.
        </div>
      ) : (
        <div className="space-y-1.5">
          {credentials.map(cred => (
            <div key={cred.id} className="bg-gray-50 rounded-lg p-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-800 truncate">{cred.name}</div>
                <div className="text-[10px] text-gray-400 flex gap-2">
                  <span className="bg-gray-200 px-1 rounded">{TYPE_LABELS[cred.type] ?? cred.type}</span>
                  <span>{maskValue(cred.valueEncrypted)}</span>
                  <span>{formatRelativeTime(cred.createdAt)}</span>
                </div>
              </div>
              {confirmDelete === cred.id ? (
                <div className="flex gap-1">
                  <button onClick={() => handleDelete(cred.id)} className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded">Delete</button>
                  <button onClick={() => setConfirmDelete(null)} className="text-[10px] px-1.5 py-0.5 bg-gray-200 rounded">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(cred.id)} className="text-[10px] text-red-400 hover:text-red-600">Delete</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
