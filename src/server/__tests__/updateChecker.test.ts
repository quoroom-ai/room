import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockReleaseAsset {
  name: string
  browser_download_url: string
}

function makeRelease(assets: MockReleaseAsset[]): Array<{
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: MockReleaseAsset[]
}> {
  return [{
    tag_name: 'v1.2.3',
    html_url: 'https://example.com/release',
    draft: false,
    prerelease: false,
    assets,
  }]
}

async function importChecker(options?: {
  assets?: MockReleaseAsset[]
  applyImpl?: () => Promise<void> | void
  readyVersion?: string | null
}) {
  vi.resetModules()

  const assets = options?.assets ?? makeRelease([{
    name: 'quoroom-update-v1.2.3.tar.gz',
    browser_download_url: 'https://example.com/quoroom-update-v1.2.3.tar.gz',
  }])[0].assets

  let readyVersion = options?.readyVersion ?? null
  const checkAndApplyUpdate = vi.fn(async () => {
    await options?.applyImpl?.()
  })

  const httpsGet = vi.fn((_: string, __: unknown, cb: (res: EventEmitter) => void) => {
    const res = new EventEmitter()
    process.nextTick(() => {
      cb(res)
      res.emit('data', Buffer.from(JSON.stringify(makeRelease(assets))))
      res.emit('end')
    })
    const req = {
      on: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    }
    return req
  })

  vi.doMock('node:https', () => ({ default: { get: httpsGet } }))
  vi.doMock('../autoUpdate', () => ({
    checkAndApplyUpdate: vi.fn(async (bundleUrl: string, version: string) => {
      await checkAndApplyUpdate(bundleUrl, version)
    }),
    getAutoUpdateStatus: vi.fn(() => ({ state: 'idle' })),
    getReadyUpdateVersion: vi.fn(() => readyVersion),
  }))

  const mod = await import('../updateChecker')
  return {
    mod,
    httpsGet,
    checkAndApplyUpdate,
    setReadyVersion: (v: string | null) => { readyVersion = v },
  }
}

describe('updateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses custom poll interval when provided to initUpdateChecker', async () => {
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const { mod, httpsGet } = await importChecker()
      mod.initUpdateChecker({ pollIntervalMs: 1_000 })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(httpsGet).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(httpsGet).toHaveBeenCalledTimes(2)

      mod.stopUpdateChecker()
    } finally {
      process.env.NODE_ENV = prevEnv
    }
  })

  it('fires onReadyUpdate only when a new ready version appears', async () => {
    const callback = vi.fn()
    const { mod, setReadyVersion } = await importChecker({
      readyVersion: null,
      applyImpl: async () => { setReadyVersion('1.2.3') },
    })

    await mod.forceCheck({ onReadyUpdate: callback })
    await mod.forceCheck({ onReadyUpdate: callback })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('1.2.3')
  })

  it('does not fire onReadyUpdate when release has no update bundle', async () => {
    const callback = vi.fn()
    const { mod, checkAndApplyUpdate } = await importChecker({
      assets: [{
        name: 'quoroom-v1.2.3-darwin-universal.pkg',
        browser_download_url: 'https://example.com/quoroom-v1.2.3.pkg',
      }],
      readyVersion: null,
    })

    await mod.forceCheck({ onReadyUpdate: callback })
    expect(checkAndApplyUpdate).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
})
