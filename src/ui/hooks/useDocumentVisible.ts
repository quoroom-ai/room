import { useState, useEffect } from 'react'

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState === 'visible')

  useEffect(() => {
    function handler(): void {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])

  return visible
}
