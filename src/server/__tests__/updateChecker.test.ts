import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockReleaseAsset {
  name: string
  browser_download_url: string
}

function makeRelease(assets: MockReleaseAsset[]) {
  return [{
    tag_name: 'v1.2.3',
    html_url: 'https://example.com/release',
    draft: false,
    prerelease: false,
    assets,
  }]
}

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const normalizedHeaders = new Map<string, string>()
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders.set(key.toLowerCase(), value)
  }
  const textBody = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
    text: async () => textBody,
  } as unknown as Response
}

async function importChecker(options?: {
  readyVersion?: string | null
  applyImpl?: () => Promise<void> | void
  fetchImpl?: (url: string) => Promise<Response>
}) {
  vi.resetModules()

  let readyVersion = options?.readyVersion ?? null
  const applySpy = vi.fn(async () => {
    await options?.applyImpl?.()
  })
  const fetchMock = vi.fn(async (url: string) => {
    if (options?.fetchImpl) return options.fetchImpl(url)
    return makeResponse(200, makeRelease([{
      name: 'quoroom-update-v1.2.3.tar.gz',
      browser_download_url: 'https://example.com/quoroom-update-v1.2.3.tar.gz',
    }]))
  })

  vi.stubGlobal('fetch', fetchMock)
  vi.doMock('../autoUpdate', () => ({
    checkAndApplyUpdate: vi.fn(async () => {
      await applySpy()
    }),
    getAutoUpdateStatus: vi.fn(() => ({ state: 'idle' })),
    getReadyUpdateVersion: vi.fn(() => readyVersion),
  }))

  const mod = await import('../updateChecker')
  return {
    mod,
    fetchMock,
    applySpy,
    setReadyVersion: (value: string | null) => { readyVersion = value },
  }
}

describe('updateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env.QUOROOM_UPDATE_SOURCE_URL
    delete process.env.QUOROOM_UPDATE_SOURCE_TOKEN
    delete process.env.QUOROOM_UPDATE_GITHUB_TOKEN
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses custom poll interval when provided to initUpdateChecker', async () => {
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const { mod, fetchMock } = await importChecker()
      mod.initUpdateChecker({ pollIntervalMs: 1_000 })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)

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

  it('does not trigger auto-apply when release has no update bundle', async () => {
    const callback = vi.fn()
    const { mod, applySpy } = await importChecker({
      fetchImpl: async () => makeResponse(200, makeRelease([{
        name: 'quoroom-v1.2.3-darwin-universal.pkg',
        browser_download_url: 'https://example.com/quoroom-v1.2.3.pkg',
      }])),
    })

    await mod.forceCheck({ onReadyUpdate: callback })
    expect(applySpy).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('stores diagnostics for GitHub rate limit responses', async () => {
    const { mod } = await importChecker({
      fetchImpl: async () => makeResponse(403, { message: 'rate limit' }, {
        'x-ratelimit-remaining': '0',
        'retry-after': '60',
      }),
    })

    await mod.forceCheck({ ignoreBackoff: true })
    const diagnostics = mod.getUpdateDiagnostics()
    expect(diagnostics.lastErrorCode).toBe('rate_limited')
    expect(diagnostics.lastErrorMessage).toContain('Rate limited')
    expect(diagnostics.lastSuccessAt).toBeNull()
  })

  it('applies exponential backoff on repeated failures and recovers on success', async () => {
    const calls: Array<(url: string) => Promise<Response>> = [
      async () => makeResponse(500, { error: 'boom' }),
      async () => makeResponse(500, { error: 'boom' }),
      async () => makeResponse(200, makeRelease([{
        name: 'quoroom-update-v1.2.3.tar.gz',
        browser_download_url: 'https://example.com/quoroom-update-v1.2.3.tar.gz',
      }])),
    ]
    const { mod, fetchMock } = await importChecker({
      fetchImpl: async (url: string) => {
        const next = calls.shift()
        return next ? next(url) : makeResponse(200, [])
      },
    })

    await mod.forceCheck({ ignoreBackoff: true })
    await mod.forceCheck({ ignoreBackoff: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await mod.forceCheck()
    expect(fetchMock).toHaveBeenCalledTimes(2) // skipped due to backoff

    await mod.forceCheck({ ignoreBackoff: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const diagnostics = mod.getUpdateDiagnostics()
    expect(diagnostics.lastErrorCode).toBeNull()
    expect(diagnostics.consecutiveFailures).toBe(0)
    expect(diagnostics.lastSuccessAt).not.toBeNull()
  })

  it('stores structured diagnostics for non-JSON responses', async () => {
    const { mod } = await importChecker({
      fetchImpl: async () => makeResponse(200, 'not-json'),
    })
    await mod.forceCheck({ ignoreBackoff: true })
    const diagnostics = mod.getUpdateDiagnostics()
    expect(diagnostics.lastErrorCode).toBe('invalid_json')
  })

  it('stores structured diagnostics for timeout errors', async () => {
    const { mod } = await importChecker({
      fetchImpl: async () => {
        const error = new Error('Timeout')
        error.name = 'TimeoutError'
        throw error
      },
    })
    await mod.forceCheck({ ignoreBackoff: true })
    const diagnostics = mod.getUpdateDiagnostics()
    expect(diagnostics.lastErrorCode).toBe('timeout')
  })

  it('uses cloud source first and falls back to GitHub on cloud errors', async () => {
    process.env.QUOROOM_UPDATE_SOURCE_URL = 'https://quoroom.io/api/cloud/runtime-update/latest'
    const { mod, fetchMock } = await importChecker({
      fetchImpl: async (url: string) => {
        if (url.includes('/runtime-update/latest')) {
          return makeResponse(500, { error: 'cloud unavailable' })
        }
        return makeResponse(200, makeRelease([{
          name: 'quoroom-update-v1.2.3.tar.gz',
          browser_download_url: 'https://example.com/quoroom-update-v1.2.3.tar.gz',
        }]))
      },
    })

    await mod.forceCheck({ ignoreBackoff: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mod.getUpdateInfo()?.latestVersion).toBe('1.2.3')
    expect(mod.getUpdateDiagnostics().updateSource).toBe('github')
  })
})
