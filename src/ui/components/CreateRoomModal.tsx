import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/client'
import { storageGet, storageSet } from '../lib/storage'
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
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const nameRef = useRef<HTMLInputElement>(null)
  const inviteAutoFilled = useRef(false)

  // Auto-focus name input
  useEffect(() => { nameRef.current?.focus() }, [])

  // Auto-fill invite code from: URL param > localStorage > existing rooms
  useEffect(() => {
    if (inviteAutoFilled.current) return
    inviteAutoFilled.current = true
    const urlParams = new URLSearchParams(window.location.search)
    const urlCode = urlParams.get('invite')
    if (urlCode) {
      setInviteCode(urlCode)
      storageSet('quoroom_invite_code', urlCode)
      return
    }
    const stored = storageGet('quoroom_invite_code')
    if (stored) {
      setInviteCode(stored)
      return
    }
    // Check existing rooms for invite code
    void api.rooms.list().then(rooms => {
      const existing = rooms.find(r => r.inviteCode)
      if (existing?.inviteCode) {
        setInviteCode(existing.inviteCode)
        storageSet('quoroom_invite_code', existing.inviteCode)
      }
    }).catch(() => {})
  }, [])

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
      const trimCode = inviteCode.trim() || undefined
      if (trimCode) storageSet('quoroom_invite_code', trimCode)
      const created = await api.rooms.create({ name: trimName, goal: goal.trim() || undefined, inviteCode: trimCode })
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

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Referral Code <span className="text-xs font-normal">(optional)</span></label>
            <input
              type="text"
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value)}
              placeholder="Enter invite code"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
            />
            <p className="text-xs text-text-muted mt-0.5">Links this room to a referrer's network</p>
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
