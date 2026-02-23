import { useEffect, useRef, useCallback, useState } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = 5000
): { data: T | null; error: string | null; isLoading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetcherRef = useRef(fetcher)
  const doFetchRef = useRef<() => Promise<void>>(async () => {})
  const inFlightRef = useRef(false)
  const queuedRef = useRef(false)
  const nextDelayRef = useRef(intervalMs)
  const unmountedRef = useRef(false)
  fetcherRef.current = fetcher

  const computeDelay = useCallback((baseMs: number): number => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') return baseMs
    // Back off aggressively when tab is hidden to reduce local CPU/network churn.
    return Math.max(baseMs * 4, 30000)
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleNext = useCallback((delayMs: number) => {
    clearTimer()
    if (unmountedRef.current) return
    timerRef.current = setTimeout(() => {
      void doFetchRef.current()
    }, delayMs)
  }, [clearTimer])

  const doFetch = useCallback(async () => {
    if (unmountedRef.current) return
    if (inFlightRef.current) {
      // Ensure we run one follow-up fetch with the latest fetcher/context.
      queuedRef.current = true
      return
    }
    inFlightRef.current = true
    queuedRef.current = false

    try {
      const result = await fetcherRef.current()
      if (unmountedRef.current) return
      setData(result)
      setError(null)
      setIsLoading(false)
      nextDelayRef.current = intervalMs
      scheduleNext(computeDelay(intervalMs))
    } catch (err) {
      if (unmountedRef.current) return
      const message = err instanceof Error ? err.message : 'Failed to load data'
      setError(message)
      setIsLoading(false)
      nextDelayRef.current = Math.min(nextDelayRef.current * 2, 30000)
      scheduleNext(nextDelayRef.current)
    } finally {
      inFlightRef.current = false
      if (!unmountedRef.current && queuedRef.current) {
        queuedRef.current = false
        clearTimer()
        void doFetchRef.current()
      }
    }
  }, [clearTimer, computeDelay, intervalMs, scheduleNext])
  doFetchRef.current = doFetch

  useEffect(() => {
    unmountedRef.current = false
    setIsLoading(true)
    nextDelayRef.current = intervalMs
    void doFetch()

    const onVisibilityChange = (): void => {
      if (unmountedRef.current) return
      if (document.visibilityState === 'visible') {
        nextDelayRef.current = intervalMs
        void doFetchRef.current()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      unmountedRef.current = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearTimer()
    }
  }, [clearTimer, doFetch, intervalMs])

  const refresh = useCallback(() => {
    nextDelayRef.current = intervalMs
    void doFetch()
  }, [doFetch, intervalMs])

  return { data, error, isLoading, refresh }
}
