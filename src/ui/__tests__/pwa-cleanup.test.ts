import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MutableGlobals = {
  navigator?: unknown
  caches?: unknown
}

const globals = globalThis as MutableGlobals

describe('cleanupLegacyPwaArtifacts', () => {
  const originalNavigator = globals.navigator
  const originalCaches = globals.caches

  beforeEach(() => {
    vi.resetModules()
    delete globals.navigator
    delete globals.caches
  })

  afterEach(() => {
    if (originalNavigator === undefined) delete globals.navigator
    else globals.navigator = originalNavigator

    if (originalCaches === undefined) delete globals.caches
    else globals.caches = originalCaches
  })

  it('returns false when no legacy service worker or caches are present', async () => {
    const mod = await import('../lib/pwaCleanup')
    await expect(mod.cleanupLegacyPwaArtifacts()).resolves.toBe(false)
  })

  it('unregisters service workers and clears caches when present', async () => {
    const unregisterA = vi.fn().mockResolvedValue(true)
    const unregisterB = vi.fn().mockResolvedValue(true)
    const deleteCache = vi.fn().mockResolvedValue(true)

    globals.navigator = {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([
          { unregister: unregisterA },
          { unregister: unregisterB },
        ]),
      },
    }
    globals.caches = {
      keys: vi.fn().mockResolvedValue(['legacy-v1', 'legacy-v2']),
      delete: deleteCache,
    }

    const mod = await import('../lib/pwaCleanup')
    await expect(mod.cleanupLegacyPwaArtifacts()).resolves.toBe(true)
    expect(unregisterA).toHaveBeenCalledTimes(1)
    expect(unregisterB).toHaveBeenCalledTimes(1)
    expect(deleteCache).toHaveBeenCalledTimes(2)
    expect(deleteCache).toHaveBeenCalledWith('legacy-v1')
    expect(deleteCache).toHaveBeenCalledWith('legacy-v2')
  })

  it('continues best-effort cleanup when unregister/delete fail', async () => {
    const unregister = vi.fn().mockRejectedValue(new Error('failed unregister'))
    const deleteCache = vi.fn().mockRejectedValue(new Error('failed delete'))

    globals.navigator = {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      },
    }
    globals.caches = {
      keys: vi.fn().mockResolvedValue(['legacy']),
      delete: deleteCache,
    }

    const mod = await import('../lib/pwaCleanup')
    await expect(mod.cleanupLegacyPwaArtifacts()).resolves.toBe(true)
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(deleteCache).toHaveBeenCalledWith('legacy')
  })
})
