import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerCredentialTools(server: McpServer): void {
  server.registerTool(
    'quoroom_credentials_list',
    {
      title: 'List Credentials',
      description: 'List all credentials for a room. Values are masked — use quoroom_credentials_get to retrieve actual values.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      const db = getMcpDatabase()
      const credentials = queries.listCredentials(db, roomId)
      if (credentials.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No credentials provided.' }] }
      }
      const list = credentials.map(c => ({
        name: c.name, type: c.type, providedBy: c.providedBy, createdAt: c.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_credentials_get',
    {
      title: 'Get Credential',
      description: 'Get a credential by name with the actual (unmasked) value. Use this to retrieve API keys and secrets needed for tasks.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        name: z.string().min(1).describe('The credential name (e.g. "OpenAI API Key")')
      }
    },
    async ({ roomId, name }) => {
      const db = getMcpDatabase()
      const credential = queries.getCredentialByName(db, roomId, name)
      if (!credential) {
        return { content: [{ type: 'text' as const, text: `Credential "${name}" not found in this room.` }], isError: true }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            name: credential.name,
            type: credential.type,
            value: credential.valueEncrypted
          }, null, 2)
        }]
      }
    }
  )
}
