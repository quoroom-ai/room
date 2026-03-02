import { afterEach, describe, expect, it } from 'vitest'
import { getLocalModelInstallScriptPreview } from '../local-model'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('local model service install command', () => {
  it('uses official shell installer on macOS', () => {
    setPlatform('darwin')
    const script = getLocalModelInstallScriptPreview()
    expect(script).toEqual({
      command: '/bin/sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
    })
  })

  it('uses official PowerShell installer on Windows', () => {
    setPlatform('win32')
    const script = getLocalModelInstallScriptPreview()
    expect(script).toEqual({
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr -useb https://ollama.com/install.ps1 | iex'],
    })
  })
})
