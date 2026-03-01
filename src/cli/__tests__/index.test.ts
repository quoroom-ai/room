import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ARGV = [...process.argv]
const ORIG_ENV = { ...process.env }

let fakeHome: string

beforeEach(() => {
  vi.resetModules()
  process.argv = ['node', 'cli.js', 'help']
  process.env = { ...ORIG_ENV }
  delete process.env.QUOROOM_BOOTSTRAPPED_USER_CLI
  fakeHome = mkdtempSync(path.join(tmpdir(), 'quoroom-cli-home-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  process.argv = [...ORIG_ARGV]
  process.env = { ...ORIG_ENV }
  delete (globalThis as Record<string, unknown>).__userCliLoaded
})

interface CliFixtureOptions {
  createUserCli?: boolean
  versionJson?: string
  nodePath?: string
}

function setupUserUpdateFixture(options: CliFixtureOptions): string {
  const userAppDir = path.join(fakeHome, '.quoroom', 'app')
  const userCliPath = path.join(userAppDir, 'lib', 'cli.js')
  const versionPath = path.join(userAppDir, 'version.json')
  mkdirSync(path.dirname(userCliPath), { recursive: true })

  if (options.createUserCli) {
    writeFileSync(
      userCliPath,
      'globalThis.__userCliLoaded = (globalThis.__userCliLoaded || 0) + 1;\nmodule.exports = {};\n'
    )
  }

  if (typeof options.versionJson === 'string') {
    writeFileSync(versionPath, options.versionJson)
  }

  if (typeof options.nodePath === 'string') {
    process.env.NODE_PATH = options.nodePath
  } else {
    delete process.env.NODE_PATH
  }

  return userCliPath
}

async function runCliWithFixture(options: CliFixtureOptions): Promise<void> {
  setupUserUpdateFixture(options)

  vi.doMock('node:os', () => ({ homedir: () => fakeHome }))

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  await import('../index')
  logSpy.mockRestore()
}

describe('cli bootstrap', () => {
  it('uses bundled CLI when no valid user-space update exists', async () => {
    await runCliWithFixture({})
    expect((globalThis as Record<string, unknown>).__userCliLoaded).toBeUndefined()
  })

  it('uses user-space CLI when user version is newer', async () => {
    await runCliWithFixture({
      createUserCli: true,
      versionJson: JSON.stringify({ version: '9.9.9' }),
    })
    expect((globalThis as Record<string, unknown>).__userCliLoaded).toBe(1)
  })

  it('ignores user-space CLI when version metadata is invalid', async () => {
    await runCliWithFixture({
      createUserCli: true,
      versionJson: '{"version"',
    })
    expect((globalThis as Record<string, unknown>).__userCliLoaded).toBeUndefined()
  })

  it('ignores user-space CLI when user version is not newer', async () => {
    await runCliWithFixture({
      createUserCli: true,
      versionJson: JSON.stringify({ version: '0.0.0' }),
    })
    expect((globalThis as Record<string, unknown>).__userCliLoaded).toBeUndefined()
  })

  it('wires NODE_PATH when bootstrapping user-space CLI', async () => {
    const existingNodePath = '/custom/node_modules'
    await runCliWithFixture({
      createUserCli: true,
      versionJson: JSON.stringify({ version: '9.9.9' }),
      nodePath: existingNodePath,
    })
    const bundledNodeModules = path.join(process.cwd(), 'src', 'cli', 'node_modules')
    const paths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)
    expect((globalThis as Record<string, unknown>).__userCliLoaded).toBe(1)
    expect(paths).toContain(bundledNodeModules)
    expect(paths).toContain(existingNodePath)
  })
})
