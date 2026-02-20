import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('telemetry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('getMachineId', () => {
    it('returns a 12-char hex string', async () => {
      vi.doMock('os', () => ({
        hostname: () => 'test-host',
        userInfo: () => ({ username: 'testuser' }),
        release: () => '24.3.0',
        platform: () => 'darwin'
      }))
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      expect(id).toMatch(/^[a-f0-9]{12}$/)
    })

    it('returns consistent ID for same inputs', async () => {
      vi.doMock('os', () => ({
        hostname: () => 'stable-host',
        userInfo: () => ({ username: 'stableuser' }),
        release: () => '24.3.0',
        platform: () => 'darwin'
      }))
      const { getMachineId } = await import('../telemetry')
      expect(getMachineId()).toBe(getMachineId())
    })

    it('returns "unknown" if os functions throw', async () => {
      vi.doMock('os', () => ({
        hostname: () => { throw new Error('fail') },
        userInfo: () => ({ username: 'x' }),
        release: () => '24.3.0',
        platform: () => 'darwin'
      }))
      const { getMachineId } = await import('../telemetry')
      expect(getMachineId()).toBe('unknown')
    })
  })

  describe('isTelemetryEnabled', () => {
    it('returns false when no token is set (default)', async () => {
      const { isTelemetryEnabled } = await import('../telemetry')
      expect(isTelemetryEnabled()).toBe(false)
    })
  })

  describe('submitCrashReport', () => {
    it('is a no-op when telemetry is disabled (no token)', async () => {
      const { submitCrashReport } = await import('../telemetry')
      // Should not throw or make any network calls
      await expect(submitCrashReport({
        error: 'test error',
        stack: 'at test',
        process: 'main',
        version: '0.1.0',
        os: 'darwin-24.3.0',
        nodeVersion: 'v20.0.0',
        timestamp: '2026-01-01T00:00:00Z',
        machineId: 'abc123def456'
      })).resolves.toBeUndefined()
    })
  })

  describe('submitHeartbeat', () => {
    it('is a no-op when telemetry is disabled (no token)', async () => {
      const { submitHeartbeat } = await import('../telemetry')
      await expect(submitHeartbeat({
        version: '0.1.0',
        os: 'darwin-24.3.0',
        machineId: 'abc123def456',
        taskCount: 5,
        workerCount: 2,
        memoryCount: 10
      })).resolves.toBeUndefined()
    })
  })
})
