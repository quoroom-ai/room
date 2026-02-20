import { useState, useRef, useCallback, useEffect } from 'react'

export function useContainerWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((node: T | null) => {
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
    if (node) {
      const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
      ro.observe(node)
      roRef.current = ro
      setWidth(node.clientWidth)
    }
  }, [])
  useEffect(() => () => { roRef.current?.disconnect() }, [])
  return [ref, width]
}
