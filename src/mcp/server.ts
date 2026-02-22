import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerMemoryTools } from './tools/memory'
import { registerSchedulerTools } from './tools/scheduler'
import { registerWatcherTools } from './tools/watcher'
import { registerWorkerTools } from './tools/workers'
import { registerSettingsTools } from './tools/settings'
import { registerRoomTools } from './tools/room'
import { registerQuorumTools } from './tools/quorum'
import { registerGoalTools } from './tools/goals'
import { registerSelfModTools } from './tools/self-mod'
import { registerSkillTools } from './tools/skills'
import { registerWalletTools } from './tools/wallet'
import { registerStationTools } from './tools/station'
import { registerIdentityTools } from './tools/identity'
import { registerInboxTools } from './tools/inbox'
import { registerCredentialTools } from './tools/credentials'
import { registerResourceTools } from './tools/resources'
import { registerInviteTools } from './tools/invite'
import { closeMcpDatabase } from './db'

declare const __APP_VERSION__: string

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'quoroom',
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
  })

  registerMemoryTools(server)
  registerSchedulerTools(server)
  registerWatcherTools(server)
  registerWorkerTools(server)
  registerSettingsTools(server)
  registerRoomTools(server)
  registerQuorumTools(server)
  registerGoalTools(server)
  registerSelfModTools(server)
  registerSkillTools(server)
  registerWalletTools(server)
  registerStationTools(server)
  registerIdentityTools(server)
  registerInboxTools(server)
  registerCredentialTools(server)
  registerResourceTools(server)
  registerInviteTools(server)

  // Clean up database on process exit
  const cleanup = (): void => {
    closeMcpDatabase()
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('exit', cleanup)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Quoroom MCP server started (stdio)')
}

main().catch((error) => {
  console.error('Fatal error in Quoroom MCP server:', error)
  process.exit(1)
})
