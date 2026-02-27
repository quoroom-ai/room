import { useCallback, useState } from 'react'

export const AUTO_MODE_LOCKED_BUTTON_CLASS = 'bg-status-info-bg text-status-info border border-border-primary hover:bg-surface-hover'

export function modeAwareButtonClass(_semi: boolean, enabledClassName: string, _lockedClassName: string = AUTO_MODE_LOCKED_BUTTON_CLASS): string {
  return enabledClassName
}

export function useAutonomyControlGate(_autonomyMode: 'semi'): {
  semi: boolean
  showLockModal: boolean
  guard: (action: () => void) => void
  requestSemiMode: () => void
  closeLockModal: () => void
} {
  const semi = true
  const [showLockModal] = useState(false)

  const requestSemiMode = useCallback(() => {
    // Autonomy mode was removed; controls are always enabled.
  }, [])

  const guard = useCallback((action: () => void) => {
    action()
  }, [])

  const closeLockModal = useCallback(() => {
    // no-op
  }, [])

  return { semi, showLockModal, guard, requestSemiMode, closeLockModal }
}

interface AutoModeLockModalProps {
  open: boolean
  onClose: () => void
}

export function AutoModeLockModal({ open, onClose }: AutoModeLockModalProps): React.JSX.Element {
  // Kept for compatibility with existing panel markup.
  // Auto mode no longer exists, so this modal is never rendered.
  void open
  void onClose
  return <></>
}
