import { describe, it, expect } from 'vitest'
import { join } from 'path'

// Import the CJS script — functions exported via module.exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const killPorts = require(join(__dirname, '../../../scripts/kill-ports.js')) as {
  parsePorts: (args: string[]) => number[]
  getListeningPidsWindows: (port: number) => number[]
  getListeningPidsUnix: (port: number) => number[]
  getListeningPids: (port: number) => number[]
  killPid: (pid: number) => boolean
}

describe('kill-ports — parsePorts', () => {
  it('parses valid port numbers', () => {
    expect(killPorts.parsePorts(['4700', '3715', '5173'])).toEqual([4700, 3715, 5173])
  })

  it('ignores non-numeric args', () => {
    expect(killPorts.parsePorts(['abc', '4700', '--flag'])).toEqual([4700])
  })

  it('ignores zero and negative values', () => {
    expect(killPorts.parsePorts(['0', '-1', '4700'])).toEqual([4700])
  })

  it('returns empty array for no valid ports', () => {
    expect(killPorts.parsePorts([])).toEqual([])
    expect(killPorts.parsePorts(['abc'])).toEqual([])
  })

  it('handles decimal strings by truncating', () => {
    expect(killPorts.parsePorts(['4700.5'])).toEqual([4700])
  })
})

describe('kill-ports — platform-specific functions exist', () => {
  it('exports getListeningPidsWindows', () => {
    expect(typeof killPorts.getListeningPidsWindows).toBe('function')
  })

  it('exports getListeningPidsUnix', () => {
    expect(typeof killPorts.getListeningPidsUnix).toBe('function')
  })

  it('exports getListeningPids that delegates to the correct platform', () => {
    expect(typeof killPorts.getListeningPids).toBe('function')
  })

  it('exports killPid', () => {
    expect(typeof killPorts.killPid).toBe('function')
  })
})

describe('kill-ports — getListeningPids returns array for free port', () => {
  // Use a port that is very unlikely to have a listener
  const FREE_PORT = 59_999

  it('returns empty array for an unused port', () => {
    const pids = killPorts.getListeningPids(FREE_PORT)
    expect(Array.isArray(pids)).toBe(true)
    expect(pids.length).toBe(0)
  })

  if (process.platform === 'win32') {
    it('getListeningPidsWindows returns empty for unused port', () => {
      expect(killPorts.getListeningPidsWindows(FREE_PORT)).toEqual([])
    })
  } else {
    it('getListeningPidsUnix returns empty for unused port', () => {
      expect(killPorts.getListeningPidsUnix(FREE_PORT)).toEqual([])
    })
  }
})
