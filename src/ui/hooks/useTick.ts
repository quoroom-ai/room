import { useState, useEffect } from 'react'

/** Forces a re-render every `intervalMs` so relative timestamps stay current. */
export function useTick(intervalMs = 30_000): void {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        setTick(t => t + 1)
      }
    }, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}
