#!/usr/bin/env node

/**
 * Quoroom CLI — Console mode entry point
 *
 * Usage:
 *   quoroom mcp                # Start MCP server (stdio)
 *   quoroom serve [port]       # Start HTTP/WebSocket API server
 *   quoroom chat [--room <id>] # Chat with the queen (interactive REPL)
 */

const args = process.argv.slice(2)
const command = args[0] || 'help'

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

  case 'chat': {
    const { startChat } = require('./chat')
    startChat(args.slice(1))
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
  quoroom chat          Chat with the queen (interactive REPL)
  quoroom update        Check for and apply updates
  quoroom uninstall     Remove Quoroom and all data
  quoroom help          Show this help message

Dashboard:  http://localhost:3700
Website:    https://quoroom.ai
`)
    break
  }
}
