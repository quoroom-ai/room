import { describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { validateWatchPath } from '../watch-path'

describe('validateWatchPath', () => {
  it('accepts a path inside home directory', () => {
    const path = join(homedir(), 'Documents')
    expect(validateWatchPath(path)).toBeNull()
  })

  it('accepts a path inside temp directory', () => {
    expect(validateWatchPath(join(tmpdir(), 'quoroom-test'))).toBeNull()
  })

  it('rejects a path outside allowed roots', () => {
    const outsidePath = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    expect(validateWatchPath(outsidePath)).toMatch(/home directory/)
  })

  it('rejects sensitive home directories', () => {
    expect(validateWatchPath(join(homedir(), '.ssh'))).toMatch(/sensitive directory/)
  })
})
