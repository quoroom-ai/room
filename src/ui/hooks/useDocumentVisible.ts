import { useState, useEffect } from 'react'

export function useDocumentVisible(): boolean {
  const computeVisible = (): boolean => {
    return document.visibilityState === 'visible' || document.hasFocus()
  }

  const [visible, setVisible] = useState(computeVisible())

  useEffect(() => {
    function handler(): void {
      setVisible(computeVisible())
    }
    document.addEventListener('visibilitychange', handler)
    window.addEventListener('focus', handler)
    window.addEventListener('blur', handler)
    return () => {
      document.removeEventListener('visibilitychange', handler)
      window.removeEventListener('focus', handler)
      window.removeEventListener('blur', handler)
    }
  }, [])

  return visible
}
