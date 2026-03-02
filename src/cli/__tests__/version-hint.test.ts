import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }
const ORIG_FETCH = global.fetch

let fakeHome: string

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIG_ENV }
  delete process.env.QUOROOM_DISABLE_VERSION_HINT
  fakeHome = mkdtempSync(path.join(tmpdir(), 'quoroom-version-hint-home-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  process.env = { ...ORIG_ENV }
  global.fetch = ORIG_FETCH
})

async function importVersionHint() {
  vi.doMock('node:os', () => ({ homedir: () => fakeHome }))
  return import('../version-hint')
}

describe('cli version hint', () => {
  it('skips checks for mcp command', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const { maybeShowVersionHint } = await importVersionHint()
    await maybeShowVersionHint('0.1.0', 'mcp')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints hint when a newer npm version exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '9.9.9' }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { maybeShowVersionHint } = await importVersionHint()
    await maybeShowVersionHint('0.1.0', 'serve')
    await maybeShowVersionHint('0.1.0', 'serve')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0][0]).toMatch(/Update available: quoroom v9\.9\.9/)
    logSpy.mockRestore()
  })

  it('uses fresh cache without network calls', async () => {
    const cachePath = path.join(fakeHome, '.quoroom', 'npm-version-check.json')
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({
      checkedAt: Date.now(),
      latestVersion: '9.9.9',
    }))

    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { maybeShowVersionHint } = await importVersionHint()
    await maybeShowVersionHint('0.1.0', 'serve')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    logSpy.mockRestore()
  })
})
