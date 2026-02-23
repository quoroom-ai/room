import { useState, useCallback, useEffect, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import type { Entity, Observation } from '@shared/types'

interface MemoryPanelProps {
  roomId?: number | null
}

export function MemoryPanel({ roomId }: MemoryPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [obsCache, setObsCache] = useState<Record<number, Observation[]>>({})
  const obsCacheRef = useRef(obsCache)
  obsCacheRef.current = obsCache

  const fetcher = useCallback(
    () =>
      search.trim()
        ? api.memory.searchEntities(search.trim())
        : api.memory.listEntities(roomId ?? undefined),
    [search, roomId]
  )

  const { data: entities, refresh } = usePolling(fetcher, 30000)
  const memoryEvent = useWebSocket('memory')

  useEffect(() => {
    if (memoryEvent) refresh()
  }, [memoryEvent, refresh])

  useEffect(() => {
    if (!wide || !entities || entities.length === 0) return
    let cancelled = false
    const load = async (): Promise<void> => {
      const newCache: Record<number, Observation[]> = {}
      for (const entity of entities) {
        if (cancelled) return
        if (obsCacheRef.current[entity.id]) {
          newCache[entity.id] = obsCacheRef.current[entity.id]
        } else {
          try {
            newCache[entity.id] = await api.memory.getObservations(entity.id)
          } catch {
            newCache[entity.id] = []
          }
        }
      }
      if (!cancelled) setObsCache(newCache)
    }
    load()
    return () => { cancelled = true }
  }, [wide, entities])

  async function toggleExpand(id: number): Promise<void> {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (!obsCache[id]) {
      const obs = await api.memory.getObservations(id)
      setObsCache((prev) => ({ ...prev, [id]: obs }))
    }
  }

  function renderObservations(entityId: number): React.JSX.Element | null {
    const obs = obsCache[entityId]
    if (!obs) return <div className="text-sm text-text-muted py-1">Loading...</div>
    if (obs.length === 0) return <div className="text-sm text-text-muted py-1">No observations</div>
    return (
      <div className="space-y-2">
        {obs.map((o) => (
          <div key={o.id} className="text-sm p-2 bg-surface-primary rounded-lg">
            <span className="text-text-secondary">{o.content}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border-primary">
        <input
          type="text"
          placeholder="Search entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary"
        />
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {!entities || entities.length === 0 ? (
          <div className="p-4 text-center text-sm text-text-muted">
            {search ? 'No matching entities' : 'No memories yet'}
          </div>
        ) : wide ? (
          <div className="grid grid-cols-2 gap-3 p-4">
            {entities.map((entity: Entity, i: number) => (
              <div key={entity.id} className="border border-border-primary rounded-lg overflow-hidden">
                <div
                  className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => setExpandedId(expandedId === entity.id ? null : entity.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary truncate">{entity.name}</div>
                    <div className="text-sm text-text-muted">
                      {entity.type}
                      {entity.category && <span> &middot; {entity.category}</span>}
                    </div>
                  </div>
                </div>
                {(i < 2 || expandedId === entity.id) && (
                  <div className="px-3 pb-2 bg-surface-secondary">
                    {renderObservations(entity.id)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {entities.map((entity: Entity) => (
              <div key={entity.id} className="bg-surface-secondary border border-border-primary rounded-lg overflow-hidden">
                <div
                  className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => toggleExpand(entity.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary truncate">{entity.name}</div>
                    <div className="text-sm text-text-muted">
                      {entity.type}
                      {entity.category && <span> &middot; {entity.category}</span>}
                    </div>
                  </div>
                </div>
                {expandedId === entity.id && (
                  <div className="px-3 pb-2 pt-2 border-t border-border-primary bg-surface-secondary">
                    {renderObservations(entity.id)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
