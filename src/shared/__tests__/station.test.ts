import { describe, it, expect } from 'vitest'
import { MockProvider } from '../station'

// ─── MockProvider ───────────────────────────────────────────

describe('MockProvider', () => {
  it('creates a station with unique external ID', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    expect(result.externalId).toContain('mock-test-')
    expect(result.status).toBe('running')
  })

  it('starts a stopped station', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.stop(result.externalId)
    await provider.start(result.externalId)
    const status = await provider.getStatus(result.externalId)
    expect(status).toBe('running')
  })

  it('stops a running station', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.stop(result.externalId)
    const status = await provider.getStatus(result.externalId)
    expect(status).toBe('stopped')
  })

  it('destroys a station', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.destroy(result.externalId)
    const status = await provider.getStatus(result.externalId)
    expect(status).toBe('deleted')
  })

  it('executes commands on running station', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    const exec = await provider.exec(result.externalId, 'ls -la')
    expect(exec.stdout).toContain('ls -la')
    expect(exec.exitCode).toBe(0)
  })

  it('refuses to exec on stopped station', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.stop(result.externalId)
    await expect(provider.exec(result.externalId, 'ls')).rejects.toThrow('not running')
  })

  it('returns logs', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.exec(result.externalId, 'hello')
    const logs = await provider.getLogs(result.externalId)
    expect(logs).toContain('created')
    expect(logs).toContain('exec: hello')
  })

  it('limits log lines', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    await provider.exec(result.externalId, 'cmd1')
    await provider.exec(result.externalId, 'cmd2')
    const logs = await provider.getLogs(result.externalId, 1)
    expect(logs.split('\n').length).toBe(1)
  })

  it('throws for nonexistent station', async () => {
    const provider = new MockProvider()
    await expect(provider.start('nonexistent')).rejects.toThrow('not found')
  })

  it('resets state', async () => {
    const provider = new MockProvider()
    const result = await provider.create({ name: 'test', tier: 'micro' as any })
    provider.reset()
    const status = await provider.getStatus(result.externalId)
    expect(status).toBe('deleted')
  })
})
