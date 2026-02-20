import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { embed, isEngineReady, vectorToBlob, initEngine, isSqliteVecReady } from '../../shared/embeddings'

// Fire-and-forget engine init on first memory tool registration
let engineInitStarted = false
function ensureEngineInit(): void {
  if (!engineInitStarted) {
    engineInitStarted = true
    initEngine().catch(() => { /* non-fatal */ })
  }
}

export function registerMemoryTools(server: McpServer): void {
  ensureEngineInit()

  server.registerTool(
    'quoroom_remember',
    {
      title: 'Remember',
      description:
        'Store a memory. Creates an entity with an observation. Use for facts, preferences, project details, people, events. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Short name for this memory (e.g. "Series A fundraise", "favorite color")'),
        content: z.string().min(1).max(50000).describe('The detailed information to remember'),
        type: z
          .enum(['fact', 'preference', 'person', 'project', 'event'])
          .default('fact')
          .describe('Type: fact, preference, person, project, event'),
        category: z
          .enum(['work', 'personal', 'preference', 'project', 'person'])
          .optional()
          .describe('Category: work, personal, preference, project, person'),
        roomId: z.number().int().positive().optional().describe(
          'Assign this memory to a room by ID. When set, the memory is scoped to that room.'
        ),
      }
    },
    async ({ name, content, type, category, roomId }) => {
      const db = getMcpDatabase()
      const entity = queries.createEntity(db, name, type, category, roomId)
      queries.addObservation(db, entity.id, content, 'claude')
      return {
        content: [
          {
            type: 'text' as const,
            text: `Remembered "${name}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_recall',
    {
      title: 'Recall',
      description:
        'Search memories by keyword. Returns matching entities with their observations and relations.',
      inputSchema: {
        query: z.string().describe('Search term to find memories')
      }
    },
    async ({ query }) => {
      const db = getMcpDatabase()

      // Semantic search via sqlite-vec (single SQL query, no JS loop)
      let semanticResults: Array<{ entityId: number; score: number }> | null = null
      if (isEngineReady() && isSqliteVecReady()) {
        try {
          const queryVec = await embed(query)
          if (queryVec) {
            semanticResults = queries.semanticSearchSql(db, vectorToBlob(queryVec))
          }
        } catch {
          // Non-fatal: fall through to FTS-only
        }
      }

      const hybridResults = queries.hybridSearch(db, query, semanticResults)

      if (hybridResults.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No memories found matching "${query}".` }]
        }
      }

      const results = hybridResults.map((hr) => {
        const observations = queries.getObservations(db, hr.entity.id)
        const relations = queries.getRelations(db, hr.entity.id)
        return {
          id: hr.entity.id,
          name: hr.entity.name,
          type: hr.entity.type,
          category: hr.entity.category,
          score: Math.round(hr.combinedScore * 1000) / 1000,
          observations: observations.map((o) => o.content),
          relations: relations.map((r) => ({
            type: r.relation_type,
            fromEntity: r.from_entity,
            toEntity: r.to_entity
          })),
          updatedAt: hr.entity.updated_at
        }
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(results, null, 2)
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_forget',
    {
      title: 'Forget',
      description: 'Delete a memory by its ID. Also removes all related observations and relations. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The entity ID to delete')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const entity = queries.getEntity(db, id)
      if (!entity) {
        return {
          content: [{ type: 'text' as const, text: `No memory found with id ${id}.` }]
        }
      }
      queries.deleteEntity(db, id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Forgot "${entity.name}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_memory_list',
    {
      title: 'Memory List',
      description:
        'List all stored memories, optionally filtered by category. Returns entity names, types, and observation counts.',
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Filter by category (work, personal, preference, project, person)')
      }
    },
    async ({ category }) => {
      const db = getMcpDatabase()
      const entities = queries.listEntities(db, undefined, category)
      const stats = queries.getMemoryStats(db)

      const list = entities.map((entity) => {
        const observations = queries.getObservations(db, entity.id)
        return {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          category: entity.category,
          observationCount: observations.length,
          updatedAt: entity.updated_at
        }
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                totalEntities: stats.entityCount,
                totalObservations: stats.observationCount,
                totalRelations: stats.relationCount,
                memories: list
              },
              null,
              2
            )
          }
        ]
      }
    }
  )
}
