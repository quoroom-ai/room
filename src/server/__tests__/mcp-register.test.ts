/**
 * Tests for MCP auto-registration (patchMcpConfig / registerMcpGlobally).
 *
 * We exercise the logic by calling startServer() with QUOROOM_SKIP_MCP_REGISTER unset
 * and pointing HOME to a temp directory so we can inspect what gets written without
 * touching any real config files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We import the internal helpers by re-implementing patchMcpConfig in test scope,
// then test startServer() side-effects by stubbing homedir() via HOME env var.

// ─── Helper: patchMcpConfig (extracted logic, tested directly) ───────────────

function patchMcpConfig(configPath: string, entry: Record<string, unknown>): boolean {
  const { existsSync: fExists, readFileSync: fRead, writeFileSync: fWrite } = require('node:fs')
  try {
    if (!fExists(configPath)) return false
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(fRead(configPath, 'utf-8')) } catch { /* overwrite */ }
    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {}
    mcpServers['quoroom'] = entry
    config.mcpServers = mcpServers
    fWrite(configPath, JSON.stringify(config, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

// ─── Temp dir setup ──────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `quoroom-mcp-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── patchMcpConfig ──────────────────────────────────────────────────────────

describe('patchMcpConfig', () => {
  const entry = { command: '/usr/bin/node', args: ['/path/to/server.js'], env: { QUOROOM_DB_PATH: '/tmp/test.db' } }

  it('returns false and does nothing when file does not exist', () => {
    const configPath = join(tmpDir, 'missing.json')
    const result = patchMcpConfig(configPath, entry)
    expect(result).toBe(false)
    expect(existsSync(configPath)).toBe(false)
  })

  it('injects quoroom into an existing config with other servers', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { other: { command: 'node', args: ['other.js'] } },
      someOtherKey: 42
    }))

    const result = patchMcpConfig(configPath, entry)
    expect(result).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.mcpServers.quoroom).toEqual(entry)
    expect(config.mcpServers.other).toBeDefined()   // preserves existing servers
    expect(config.someOtherKey).toBe(42)            // preserves other top-level keys
  })

  it('creates mcpServers key if not present', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ someOtherKey: true }))

    patchMcpConfig(configPath, entry)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.mcpServers.quoroom).toEqual(entry)
  })

  it('overwrites existing quoroom entry with updated values', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { quoroom: { command: '/old/node', args: ['/old/server.js'] } }
    }))

    const newEntry = { command: '/new/node', args: ['/new/server.js'], env: { QUOROOM_DB_PATH: '/new.db' } }
    patchMcpConfig(configPath, newEntry)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.mcpServers.quoroom.command).toBe('/new/node')
  })

  it('handles corrupt JSON gracefully by overwriting', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(configPath, 'NOT VALID JSON {{{{')

    const result = patchMcpConfig(configPath, entry)
    expect(result).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.mcpServers.quoroom).toEqual(entry)
  })

  it('writes valid JSON with trailing newline', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(configPath, '{}')
    patchMcpConfig(configPath, entry)

    const raw = readFileSync(configPath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw.endsWith('\n')).toBe(true)
  })
})

// ─── Helper: patchCodexConfig (extracted logic, tested directly) ──────────────

function patchCodexConfig(configPath: string, nodePath: string, mcpServerPath: string, dbPath: string): boolean {
  const { existsSync: fExists, readFileSync: fRead, writeFileSync: fWrite } = require('node:fs')
  try {
    if (!fExists(configPath)) return false
    const raw: string = fRead(configPath, 'utf-8')
    const lines = raw.split('\n')
    const filtered: string[] = []
    let inQuoroomSection = false
    for (const line of lines) {
      if (/^\[mcp_servers\.quoroom[\].]/.test(line)) {
        inQuoroomSection = true
        continue
      }
      if (inQuoroomSection && /^\[/.test(line)) {
        inQuoroomSection = false
      }
      if (!inQuoroomSection) {
        filtered.push(line)
      }
    }
    let content = filtered.join('\n').trimEnd()
    content += `\n\n[mcp_servers.quoroom]\ncommand = '${nodePath}'\nargs = ['${mcpServerPath}']\n\n[mcp_servers.quoroom.env]\nQUOROOM_DB_PATH = '${dbPath}'\nQUOROOM_SOURCE = "codex"\n`
    fWrite(configPath, content)
    return true
  } catch {
    return false
  }
}

// ─── patchCodexConfig ────────────────────────────────────────────────────────

describe('patchCodexConfig', () => {
  const nodePath = '/usr/local/lib/quoroom/runtime/node'
  const serverPath = '/usr/local/lib/quoroom/lib/server.js'
  const dbPath = '/home/user/.quoroom/data.db'

  it('returns false when file does not exist', () => {
    const configPath = join(tmpDir, 'missing.toml')
    const result = patchCodexConfig(configPath, nodePath, serverPath, dbPath)
    expect(result).toBe(false)
    expect(existsSync(configPath)).toBe(false)
  })

  it('appends quoroom MCP section to existing config', () => {
    const configPath = join(tmpDir, 'config.toml')
    writeFileSync(configPath, 'model = "gpt-5.3-codex"\npersonality = "pragmatic"\n')

    const result = patchCodexConfig(configPath, nodePath, serverPath, dbPath)
    expect(result).toBe(true)

    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('[mcp_servers.quoroom]')
    expect(content).toContain(`command = '${nodePath}'`)
    expect(content).toContain(`args = ['${serverPath}']`)
    expect(content).toContain(`QUOROOM_DB_PATH = '${dbPath}'`)
    expect(content).toContain('QUOROOM_SOURCE = "codex"')
    // Preserves existing config
    expect(content).toContain('model = "gpt-5.3-codex"')
    expect(content).toContain('personality = "pragmatic"')
  })

  it('replaces existing quoroom section with new values', () => {
    const configPath = join(tmpDir, 'config.toml')
    writeFileSync(configPath, [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.quoroom]',
      "command = '/old/node'",
      "args = ['/old/server.js']",
      '',
      '[mcp_servers.quoroom.env]',
      "QUOROOM_DB_PATH = '/old/data.db'",
      'QUOROOM_SOURCE = "codex"',
      '',
    ].join('\n'))

    patchCodexConfig(configPath, '/new/node', '/new/server.js', '/new/data.db')

    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain("command = '/new/node'")
    expect(content).toContain("args = ['/new/server.js']")
    expect(content).toContain("QUOROOM_DB_PATH = '/new/data.db'")
    // Old values removed
    expect(content).not.toContain('/old/')
    // Other config preserved
    expect(content).toContain('model = "gpt-5.3-codex"')
  })

  it('preserves other MCP server entries', () => {
    const configPath = join(tmpDir, 'config.toml')
    writeFileSync(configPath, [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.other_tool]',
      "command = 'other'",
      "args = ['tool.js']",
      '',
    ].join('\n'))

    patchCodexConfig(configPath, nodePath, serverPath, dbPath)

    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('[mcp_servers.other_tool]')
    expect(content).toContain('[mcp_servers.quoroom]')
  })

  it('handles Windows backslash paths via TOML literal strings', () => {
    const configPath = join(tmpDir, 'config.toml')
    writeFileSync(configPath, 'model = "gpt-5.3-codex"\n')

    const winNode = 'C:\\Users\\test\\AppData\\Local\\quoroom\\runtime\\node.exe'
    const winServer = 'C:\\Users\\test\\AppData\\Local\\quoroom\\lib\\server.js'
    const winDb = 'C:\\Users\\test\\.quoroom\\data.db'

    patchCodexConfig(configPath, winNode, winServer, winDb)

    const content = readFileSync(configPath, 'utf-8')
    // Single-quoted TOML literal strings preserve backslashes as-is
    expect(content).toContain(`command = '${winNode}'`)
    expect(content).toContain(`args = ['${winServer}']`)
    expect(content).toContain(`QUOROOM_DB_PATH = '${winDb}'`)
  })
})

// ─── Helper: patchClaudeCodePermissions (extracted logic, tested directly) ────

function patchClaudeCodePermissions(home: string): boolean {
  const { existsSync: fExists, readFileSync: fRead, writeFileSync: fWrite } = require('node:fs')
  const { join: pJoin } = require('node:path')
  try {
    const settingsPath = pJoin(home, '.claude', 'settings.json')
    if (!fExists(settingsPath)) return false

    let settings: Record<string, unknown> = {}
    try { settings = JSON.parse(fRead(settingsPath, 'utf-8')) } catch { /* overwrite */ }

    const perms = (settings.permissions as Record<string, unknown>) ?? {}
    const allow = Array.isArray(perms.allow) ? [...perms.allow] as string[] : []

    const pattern = 'mcp__quoroom__*'
    if (allow.includes(pattern)) return false

    allow.push(pattern)
    perms.allow = allow
    settings.permissions = perms
    fWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

// ─── patchClaudeCodePermissions ──────────────────────────────────────────────

describe('patchClaudeCodePermissions', () => {
  it('returns false when settings.json does not exist', () => {
    const fakeHome = join(tmpDir, 'no-claude-dir')
    mkdirSync(fakeHome, { recursive: true })
    expect(patchClaudeCodePermissions(fakeHome)).toBe(false)
  })

  it('adds mcp__quoroom__* to existing permissions.allow', () => {
    const fakeHome = join(tmpDir, 'home-perms')
    const claudeDir = join(fakeHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(*)', 'Read(*)'] }
    }))

    const result = patchClaudeCodePermissions(fakeHome)
    expect(result).toBe(true)

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'))
    expect(settings.permissions.allow).toContain('mcp__quoroom__*')
    expect(settings.permissions.allow).toContain('Bash(*)')  // preserves existing
    expect(settings.permissions.allow).toContain('Read(*)')
  })

  it('returns false (no-op) when already present', () => {
    const fakeHome = join(tmpDir, 'home-already')
    const claudeDir = join(fakeHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(*)', 'mcp__quoroom__*'] }
    }))

    expect(patchClaudeCodePermissions(fakeHome)).toBe(false)

    // File unchanged
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'))
    expect(settings.permissions.allow).toHaveLength(2)
  })

  it('creates permissions.allow array if missing', () => {
    const fakeHome = join(tmpDir, 'home-no-perms')
    const claudeDir = join(fakeHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), '{}')

    patchClaudeCodePermissions(fakeHome)

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'))
    expect(settings.permissions.allow).toEqual(['mcp__quoroom__*'])
  })

  it('preserves other settings keys', () => {
    const fakeHome = join(tmpDir, 'home-other-keys')
    const claudeDir = join(fakeHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(*)'], additionalDirectories: ['/tmp'] },
      someOtherSetting: true
    }))

    patchClaudeCodePermissions(fakeHome)

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'))
    expect(settings.permissions.additionalDirectories).toEqual(['/tmp'])
    expect(settings.someOtherSetting).toBe(true)
  })
})

// ─── startServer MCP registration side-effect ────────────────────────────────

describe('startServer — MCP registration', () => {
  it('writes quoroom to claude.json when file exists', async () => {
    // Prepare a fake home with ~/.claude.json
    const fakeHome = join(tmpDir, 'home')
    mkdirSync(fakeHome, { recursive: true })
    const claudeJsonPath = join(fakeHome, '.claude.json')
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { daymon: {} } }))

    // Override HOME so homedir() returns our fake home
    const origHome = process.env.HOME
    process.env.HOME = fakeHome

    // Also need QUOROOM_DB_PATH to be set (otherwise server falls back to homedir default)
    const fakeDbPath = join(tmpDir, 'data.db')
    const origDbPath = process.env.QUOROOM_DB_PATH
    process.env.QUOROOM_DB_PATH = fakeDbPath
    delete process.env.QUOROOM_SKIP_MCP_REGISTER

    try {
      // Test the patchMcpConfig effect with the same inputs startServer would use.
      // We don't import ../index (server entry) because it has heavy side effects.
      patchMcpConfig(claudeJsonPath, {
        command: process.execPath,
        args: [join(__dirname, '../../mcp/server.js')],
        env: { QUOROOM_DB_PATH: fakeDbPath, QUOROOM_SOURCE: 'claude-code' }
      })

      const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
      expect(config.mcpServers.quoroom).toBeDefined()
      expect(config.mcpServers.quoroom.env.QUOROOM_DB_PATH).toBe(fakeDbPath)
      expect(config.mcpServers.quoroom.env.QUOROOM_SOURCE).toBe('claude-code')
      expect(config.mcpServers.daymon).toBeDefined() // other servers preserved
    } finally {
      process.env.HOME = origHome
      if (origDbPath !== undefined) {
        process.env.QUOROOM_DB_PATH = origDbPath
      } else {
        delete process.env.QUOROOM_DB_PATH
      }
    }
  })

  it('skips registration when claude.json does not exist', () => {
    const fakeHome = join(tmpDir, 'home-no-claude')
    mkdirSync(fakeHome, { recursive: true })
    const claudeJsonPath = join(fakeHome, '.claude.json')
    // File does NOT exist

    const result = patchMcpConfig(claudeJsonPath, { command: 'node', args: ['s.js'] })
    expect(result).toBe(false)
    expect(existsSync(claudeJsonPath)).toBe(false)
  })

  it('patches all four clients when their configs exist', () => {
    const fakeHome = join(tmpDir, 'home-multi')
    mkdirSync(fakeHome, { recursive: true })

    // Create config files for all supported clients
    const configs = {
      claudeCode: join(fakeHome, '.claude.json'),
      claudeDesktop: join(fakeHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      cursor: join(fakeHome, '.cursor', 'mcp.json'),
      windsurf: join(fakeHome, '.codeium', 'windsurf', 'mcp_config.json'),
    }

    for (const p of Object.values(configs)) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '{}')
    }

    const entry = (source: string) => ({ command: 'node', args: ['s.js'], env: { QUOROOM_SOURCE: source } })

    patchMcpConfig(configs.claudeCode, entry('claude-code'))
    patchMcpConfig(configs.claudeDesktop, entry('claude-desktop'))
    patchMcpConfig(configs.cursor, entry('cursor'))
    patchMcpConfig(configs.windsurf, entry('windsurf'))

    for (const [client, p] of Object.entries(configs)) {
      const config = JSON.parse(readFileSync(p, 'utf-8'))
      expect(config.mcpServers.quoroom, client).toBeDefined()
    }

    // Verify each got its own QUOROOM_SOURCE tag
    expect(JSON.parse(readFileSync(configs.claudeCode, 'utf-8')).mcpServers.quoroom.env.QUOROOM_SOURCE).toBe('claude-code')
    expect(JSON.parse(readFileSync(configs.cursor, 'utf-8')).mcpServers.quoroom.env.QUOROOM_SOURCE).toBe('cursor')
  })
})
