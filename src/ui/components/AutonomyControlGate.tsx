import { useCallback, useEffect, useState } from 'react'

export const AUTO_MODE_LOCKED_BUTTON_CLASS = 'bg-status-info-bg text-status-info border border-border-primary hover:bg-surface-hover'

export function modeAwareButtonClass(semi: boolean, enabledClassName: string, lockedClassName: string = AUTO_MODE_LOCKED_BUTTON_CLASS): string {
  return semi ? enabledClassName : lockedClassName
}

export function useAutonomyControlGate(autonomyMode: 'auto' | 'semi'): {
  semi: boolean
  showLockModal: boolean
  guard: (action: () => void) => void
  requestSemiMode: () => void
  closeLockModal: () => void
} {
  const semi = autonomyMode === 'semi'
  const [showLockModal, setShowLockModal] = useState(false)

  const requestSemiMode = useCallback(() => {
    setShowLockModal(true)
  }, [])

  const guard = useCallback((action: () => void) => {
    if (semi) {
      action()
      return
    }
    setShowLockModal(true)
  }, [semi])

  const closeLockModal = useCallback(() => {
    setShowLockModal(false)
  }, [])

  return { semi, showLockModal, guard, requestSemiMode, closeLockModal }
}

interface AutoModeLockModalProps {
  open: boolean
  onClose: () => void
}

export function AutoModeLockModal({ open, onClose }: AutoModeLockModalProps): React.JSX.Element {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return <></>

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-surface-primary p-5 shadow-2xl">
        <h3 className="text-base font-semibold text-text-primary">Keeper controls are locked in Auto mode</h3>
        <p className="mt-2 text-sm text-text-muted">
          To use manual controls, switch this room to <span className="font-medium text-text-secondary">Semi</span> mode in the Room Settings tab.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
