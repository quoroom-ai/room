import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let readyVersion: string | null = null
let userAppDir = ''

function mockIndexDependencies(): void {
  vi.doMock('../router', () => ({ Router: vi.fn(() => ({ match: vi.fn() })) }))
  vi.doMock('../auth', () => ({
    generateToken: vi.fn(() => 'test-token'),
    getTokenPrincipal: vi.fn(() => ({ role: 'agent' })),
    isAllowedOrigin: vi.fn(() => true),
    isLocalOrigin: vi.fn(() => true),
    isCloudDeployment: vi.fn(() => false),
    getDeploymentMode: vi.fn(() => 'local'),
    setCorsHeaders: vi.fn(),
    writeTokenFile: vi.fn(),
    getUserToken: vi.fn(() => 'user-token'),
  }))
  vi.doMock('../access', () => ({ isAllowedForRole: vi.fn(() => true) }))
  vi.doMock('../routes/index', () => ({ registerAllRoutes: vi.fn() }))
  vi.doMock('../db', () => ({
    getServerDatabase: vi.fn(),
    closeServerDatabase: vi.fn(),
    getDataDir: vi.fn(() => join(tmpdir(), 'quoroom-test')),
  }))
  vi.doMock('../ws', () => ({ createWsServer: vi.fn() }))
  vi.doMock('../../shared/cloud-sync', () => ({ stopCloudSync: vi.fn() }))
  vi.doMock('../cloud', () => ({ initCloudSync: vi.fn() }))
  vi.doMock('../../shared/agent-loop', () => ({ _stopAllLoops: vi.fn() }))
  vi.doMock('../runtime', () => ({
    startServerRuntime: vi.fn(),
    stopServerRuntime: vi.fn(),
  }))
  vi.doMock('../../shared/web-tools', () => ({ closeBrowser: vi.fn(async () => undefined) }))
  vi.doMock('../webhooks', () => ({ handleWebhookRequest: vi.fn(async () => ({ status: 200, data: {} })) }))
  vi.doMock('../event-bus', () => ({ eventBus: { on: vi.fn() } }))
  vi.doMock('../shell-path', () => ({ inheritShellPath: vi.fn() }))
  vi.doMock('../../shared/process-supervisor', () => ({ terminateManagedChildProcesses: vi.fn(async () => undefined) }))
  vi.doMock('../updateChecker', () => ({
    initUpdateChecker: vi.fn(),
    stopUpdateChecker: vi.fn(),
    getUpdateInfo: vi.fn(() => null),
    getReadyUpdateVersion: vi.fn(() => readyVersion),
  }))
  vi.doMock('../autoUpdate', () => ({
    initBootHealthCheck: vi.fn(),
    USER_APP_DIR: userAppDir,
  }))
}

describe('startServer static dir selection', () => {
  afterEach(() => {
    if (userAppDir) rmSync(userAppDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.resetModules()
    readyVersion = null
    userAppDir = mkdtempSync(join(tmpdir(), 'quoroom-user-app-'))
  })

  it('falls back to bundled UI when user UI has no ready update version', async () => {
    mkdirSync(join(userAppDir, 'ui'), { recursive: true })
    writeFileSync(join(userAppDir, 'ui', 'index.html'), '<html>stale</html>')

    mockIndexDependencies()
    const mod = await import('../index')
    const resolved = mod._resolveStaticDirForStart()

    expect(resolved).toBe(join(__dirname, '..', '..', 'ui'))
  })

  it('uses user UI only when a ready update version exists', async () => {
    readyVersion = '999.0.0'
    mkdirSync(join(userAppDir, 'ui'), { recursive: true })
    writeFileSync(join(userAppDir, 'ui', 'index.html'), '<html>new</html>')

    mockIndexDependencies()
    const mod = await import('../index')
    const resolved = mod._resolveStaticDirForStart()

    expect(resolved).toBe(join(userAppDir, 'ui'))
  })
})
