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
  const nextDelayRef = useRef(intervalMs)
  const unmountedRef = useRef(false)
  fetcherRef.current = fetcher

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
    if (inFlightRef.current || unmountedRef.current) return
    inFlightRef.current = true

    try {
      const result = await fetcherRef.current()
      if (unmountedRef.current) return
      setData(result)
      setError(null)
      setIsLoading(false)
      nextDelayRef.current = intervalMs
      scheduleNext(intervalMs)
    } catch (err) {
      if (unmountedRef.current) return
      const message = err instanceof Error ? err.message : 'Failed to load data'
      setError(message)
      setIsLoading(false)
      nextDelayRef.current = Math.min(nextDelayRef.current * 2, 30000)
      scheduleNext(nextDelayRef.current)
    } finally {
      inFlightRef.current = false
    }
  }, [intervalMs, scheduleNext])
  doFetchRef.current = doFetch

  useEffect(() => {
    unmountedRef.current = false
    setIsLoading(true)
    nextDelayRef.current = intervalMs
    void doFetch()

    return () => {
      unmountedRef.current = true
      clearTimer()
    }
  }, [clearTimer, doFetch, intervalMs])

  const refresh = useCallback(() => {
    nextDelayRef.current = intervalMs
    void doFetch()
  }, [doFetch, intervalMs])

  return { data, error, isLoading, refresh }
}
