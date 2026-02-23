import type { ConsoleLogCallback } from './claude-code'

const FLUSH_INTERVAL_MS = 1000

export interface CycleLogEntryEvent {
  cycleId: number
  seq: number
  entryType: string
  content: string
}

export type CycleLogEntryCallback = (entry: CycleLogEntryEvent) => void

/**
 * Generic console log buffer for agent cycle output.
 * Buffers entries and flushes to a provided writer at intervals.
 */
export function createCycleLogBuffer(
  cycleId: number,
  writer: (entries: Array<{ cycleId: number; seq: number; entryType: string; content: string }>) => void,
  onEntry?: CycleLogEntryCallback
): {
  onConsoleLog: ConsoleLogCallback
  addSynthetic: (entryType: string, content: string) => void
  flush: () => void
} {
  let seq = 0
  let lastFlush = 0
  const buffer: Array<{ cycleId: number; seq: number; entryType: string; content: string }> = []

  function flush(): void {
    if (buffer.length === 0) return
    try {
      const toWrite = buffer.splice(0)
      writer(toWrite)
    } catch (err) {
      console.warn('Non-fatal: cycle log flush failed:', err)
    }
    lastFlush = Date.now()
  }

  function addEntry(entryType: string, content: string): void {
    seq++
    const entry = { cycleId, seq, entryType, content }
    buffer.push(entry)
    onEntry?.(entry)
    if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
      flush()
    }
  }

  return {
    onConsoleLog: (event) => addEntry(event.entryType, event.content),
    addSynthetic: addEntry,
    flush,
  }
}
