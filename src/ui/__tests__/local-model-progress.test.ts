import { describe, expect, it } from 'vitest'
import {
  extractLatestProgressPercent,
  getLocalInstallProgressState,
  parseProgressPercentFromText,
} from '../lib/local-model-progress'

describe('local model install progress parser', () => {
  it('parses a percent from ollama pull output', () => {
    expect(parseProgressPercentFromText('pulling 4f2e...: 37% ▕██████         ▏ 8.9 GB')).toBe(37)
  })

  it('uses the latest valid percent from log lines', () => {
    const lines = [
      { text: 'downloading installer... 100%' },
      { text: 'pulling manifest' },
      { text: 'pulling 4f2e...: 12% ▕██            ▏' },
      { text: 'pulling 4f2e...: 28% ▕█████         ▏' },
    ]
    expect(extractLatestProgressPercent(lines)).toBe(28)
  })

  it('ignores invalid percentages', () => {
    expect(parseProgressPercentFromText('progress 150%')).toBeNull()
    expect(parseProgressPercentFromText('progress: none')).toBeNull()
  })

  it('reports indeterminate state while active with no percent', () => {
    const progress = getLocalInstallProgressState({
      status: 'running',
      active: true,
      lines: [{ text: 'pulling manifest' }],
    })
    expect(progress).toEqual({ percent: null, indeterminate: true })
  })

  it('reports completed as 100% when no percent line exists', () => {
    const progress = getLocalInstallProgressState({
      status: 'completed',
      active: false,
      lines: [{ text: 'Local model ready: qwen3-coder:30b.' }],
    })
    expect(progress).toEqual({ percent: 100, indeterminate: false })
  })
})
