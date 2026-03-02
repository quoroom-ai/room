#!/usr/bin/env node

/**
 * Quoroom CLI — Console mode entry point
 *
 * Usage:
 *   quoroom mcp                # Start MCP server (stdio)
 *   quoroom serve [port]       # Start HTTP/WebSocket API server
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { maybeShowVersionHint } from './version-hint'

declare const __APP_VERSION__: string

const BOOTSTRAP_GUARD_ENV = 'QUOROOM_BOOTSTRAPPED_USER_CLI'
const USER_APP_DIR = path.join(homedir(), '.quoroom', 'app')
const USER_VERSION_PATH = path.join(USER_APP_DIR, 'version.json')
const USER_CLI_PATH = path.join(USER_APP_DIR, 'lib', 'cli.js')
const BUNDLED_NODE_MODULES = path.join(__dirname, 'node_modules')

interface UserVersionFile {
  version?: string
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

function getBundledVersion(): string {
  try {
    if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
      return __APP_VERSION__
    }
  } catch {
    // Fall through to package.json.
  }
  try {
    return require('./package.json').version as string
  } catch {
    return '0.0.0'
  }
}

function getUserVersion(): string | null {
  try {
    if (!fs.existsSync(USER_VERSION_PATH)) return null
    const raw = fs.readFileSync(USER_VERSION_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as UserVersionFile
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
    return version || null
  } catch {
    return null
  }
}

function applyNodePathBootstrap(): void {
  const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []
  const next = [BUNDLED_NODE_MODULES, ...existing.filter(Boolean)]
  process.env.NODE_PATH = Array.from(new Set(next)).join(path.delimiter)
  const nodeModule = require('node:module') as { Module?: { _initPaths?: () => void } }
  nodeModule.Module?._initPaths?.()
}

function tryBootstrapUserCli(): boolean {
  if (process.env[BOOTSTRAP_GUARD_ENV] === '1') return false
  if (!fs.existsSync(USER_CLI_PATH) || !fs.existsSync(USER_VERSION_PATH)) return false
  if (path.resolve(USER_CLI_PATH) === path.resolve(__filename)) return false

  const userVersion = getUserVersion()
  if (!userVersion) return false

  const bundledVersion = getBundledVersion()
  if (!semverGt(userVersion, bundledVersion)) return false

  process.env[BOOTSTRAP_GUARD_ENV] = '1'
  applyNodePathBootstrap()
  require(USER_CLI_PATH)
  return true
}

function runBundledCli(): void {
  const args = process.argv.slice(2)
  const command = args[0] || 'help'
  void maybeShowVersionHint(getBundledVersion(), command)

  switch (command) {
    case 'mcp': {
      // Re-export MCP server startup
      require('../mcp/server')
      break
    }

    case 'serve': {
      const portIdx = args.indexOf('--port')
      const rawPort = portIdx !== -1 ? args[portIdx + 1] : args[1]
      const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 3700
      const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3700
      const { startServer } = require('../server/index')
      startServer({ port })
      break
    }

    case 'update': {
      const { runUpdate } = require('./update')
      runUpdate()
      break
    }

    case 'uninstall': {
      const { runUninstall } = require('./uninstall')
      runUninstall()
      break
    }

    case 'help':
    default: {
      console.log(`
Quoroom — Autonomous AI Agent Collective

Usage:
  quoroom mcp           Start MCP server (stdio transport)
  quoroom serve [port]  Start HTTP/WebSocket API server (default: 3700)
  quoroom update        Check for and apply updates
  quoroom uninstall     Remove Quoroom and all data
  quoroom help          Show this help message

Dashboard:  http://localhost:3700
Website:    https://quoroom.ai
`)
      break
    }
  }
}

if (!tryBootstrapUserCli()) {
  runBundledCli()
}
