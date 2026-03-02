import { afterEach, describe, expect, it, vi } from 'vitest'

const originalPlatform = process.platform
const GB = 1024 ** 3

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
  vi.resetModules()
  vi.clearAllMocks()
})

describe('local model compatibility gate', () => {
  it('treats transient CPU/RAM load as warnings, not blockers', async () => {
    setPlatform('darwin')

    vi.doMock('node:os', () => {
      const total = 96 * GB
      const free = 6 * GB
      return {
        default: {
          cpus: () => Array.from({ length: 12 }, () => ({ model: 'test', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
          loadavg: () => [13.5, 0, 0],
          totalmem: () => total,
          freemem: () => free,
          release: () => '25.3.0',
        },
      }
    })

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        statfsSync: () => ({ bavail: 300_000_000, bsize: 4096 }),
      }
    })

    vi.doMock('../auth', () => ({
      getDeploymentMode: () => 'local' as const,
    }))

    vi.doMock('../../shared/local-model', async () => {
      const actual = await vi.importActual<typeof import('../../shared/local-model')>('../../shared/local-model')
      return {
        ...actual,
        probeOllamaRuntime: () => ({
          installed: true,
          version: 'ollama version is 0.16.3',
          daemonReachable: true,
          modelAvailable: false,
          models: [],
          ready: false,
          error: 'model "qwen3-coder:30b" is not installed',
        }),
      }
    })

    const { getLocalModelStatus } = await import('../local-model')
    const status = getLocalModelStatus()

    expect(status.blockers).not.toContainEqual(expect.stringContaining('Current RAM load'))
    expect(status.blockers).not.toContainEqual(expect.stringContaining('Current CPU load'))
    expect(status.warnings).toContainEqual(expect.stringContaining('Current RAM load is high'))
    expect(status.warnings).toContainEqual(expect.stringContaining('Current CPU load is high'))
  })
})
