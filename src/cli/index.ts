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
    const port = parseInt(portIdx !== -1 ? args[portIdx + 1] : (args[1] || '3700'), 10)
    const { startServer } = require('../server/index')
    startServer({ port })
    break
  }

  case 'chat': {
    const { startChat } = require('./chat')
    startChat(args.slice(1))
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
  quoroom help          Show this help message

Dashboard:  https://app.quoroom.ai
Website:    https://quoroom.ai
`)
    break
  }
}
