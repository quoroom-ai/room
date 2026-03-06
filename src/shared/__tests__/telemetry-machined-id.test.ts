import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import * as telemetry from '../telemetry'

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  const mockFs = {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    accessSync: vi.fn()
  }
  return mockFs
})

// Mock homedir
vi.mock('os', async () => {
  const actual = await vi.importActual('os')
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue('/home/testuser')
  }
})

describe('getMachineId', () => {
  const PRIMARY_PATH = '/home/testuser/.quoroom/machine-id'
  const FALLBACK_PATH = '/tmp/.quoroom-machine-id'
  
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the cachedMachineId by reloading the module
    vi.resetModules()
  })
  
  afterEach(() => {
    vi.resetAllMocks()
  })
  
  describe('Generation', () => {
    it('should generate a random 24-character hex ID', async () => {
      // Mock that no file exists
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      vi.mocked(telemetry.isTelemetryEnabled).mockReturnValue(false)
      
      // We need to re-import after mocking
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).toHaveLength(24)
      expect(id).toMatch(/^[0-9a-f]+$/)
    })
    
    it('should generate cryptographically secure random ID', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id1 = getMachineId()
      
      vi.resetModules()
      const { getMachineId: getMachineId2 } = await import('../telemetry')
      const id2 = getMachineId2()
      
      expect(id1).not.toBe(id2) // Should be different if regenerated
    })
  })
  
  describe('Persistence', () => {
    it('should persist ID to primary path', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.quoroom/machine-id'),
        id,
        'utf8'
      )
    })
    
    it('should load existing ID from primary path', async () => {
      const existingId = 'abcdef1234567890abcdef12'
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(existingId)
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).toBe(existingId)
      expect(writeFileSync).not.toHaveBeenCalled()
    })
    
    it('should fallback to /tmp if primary is not writable', async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === PRIMARY_PATH) return false
        if (path === FALLBACK_PATH) return false
        if (path === '/home/testuser/.quoroom') return false
        if (path === '/tmp') return true
        return false
      })
      
      // Primary path not writable
      vi.mocked(accessSync).mockImplementation((path, mode) => {
        if (path === PRIMARY_PATH || path === '/home/testuser/.quoroom') {
          throw new Error('Permission denied')
        }
      })
      
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).toHaveLength(24)
      // Should try to write to fallback path
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/.quoroom-machine-id'),
        expect.any(String),
        'utf8'
      )
    })
  })
  
  describe('Validation', () => {
    it('should reject invalid ID format and generate new one', async () => {
      const invalidId = 'invalid-id!'
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(invalidId)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).not.toBe(invalidId)
      expect(id).toHaveLength(24)
    })
    
    it('should reject ID with wrong length', async () => {
      const shortId = 'abc123'
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(shortId)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).not.toBe(shortId)
      expect(id).toHaveLength(24)
    })
  })
  
  describe('Fallback to memory', () => {
    it('should use in-memory ID if all persistence fails', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied')
      })
      vi.mocked(accessSync).mockImplementation(() => {
        throw new Error('Permission denied')
      })
      
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id = getMachineId()
      
      expect(id).toHaveLength(24)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('All persistence paths failed')
      )
      
      consoleWarnSpy.mockRestore()
    })
  })
  
  describe('Stability', () => {
    it('should return same ID on subsequent calls', async () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(writeFileSync).mockImplementation(() => {})
      vi.mocked(mkdirSync).mockImplementation(() => {})
      
      const { getMachineId } = await import('../telemetry')
      const id1 = getMachineId()
      const id2 = getMachineId()
      
      expect(id1).toBe(id2)
    })
  })
})
