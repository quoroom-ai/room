import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/client'
import type { Room } from '@shared/types'

const PLACEHOLDERS = [
  'Make money. Find opportunities, execute, and grow revenue autonomously...',
  'Trade crypto markets: analyze trends, execute trades, manage risk...',
  'Find freelance dev jobs on Upwork, write proposals, land contracts, deliver code...',
  'Build and sell micro-SaaS products. Find niches, ship MVPs, acquire users...',
  'Arbitrage opportunities across DeFi protocols. Monitor spreads, execute swaps...',
  'Run a content agency: find clients, write copy, invoice, collect payments...',
  'Flip domain names. Research trending keywords, buy low, sell high...',
  'Automate dropshipping: find trending products, list on marketplaces, fulfill orders...',
  'Monitor bounty platforms, pick up bug bounties and coding challenges for pay...',
  'Do whatever it takes to generate revenue. Be creative, be relentless...',
]

interface CreateRoomModalProps {
  onClose: () => void
  onCreate: (room: Room) => void
}

export function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const nameRef = useRef<HTMLInputElement>(null)

  // Auto-focus name input
  useEffect(() => { nameRef.current?.focus() }, [])

  // Rotate placeholder every 3s
  useEffect(() => {
    const timer = setInterval(() => {
      setPlaceholderIdx(prev => (prev + 1) % PLACEHOLDERS.length)
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleCreate(): Promise<void> {
    const trimName = name.trim()
    if (!trimName || busy) return

    setBusy(true)
    setError(null)
    try {
      const created = await api.rooms.create({ name: trimName, goal: goal.trim() || undefined })
      onCreate(created as Room)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
        >
          {'\u2715'}
        </button>

        <h2 className="text-lg font-semibold text-text-primary mb-4">Create Room</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Room Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) handleCreate() }}
              placeholder="My Project"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Primary Objective</label>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder={PLACEHOLDERS[placeholderIdx]}
              rows={6}
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive resize-none transition-colors"
            />
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-status-error">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg bg-surface-tertiary text-text-primary text-sm font-medium hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {busy ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
