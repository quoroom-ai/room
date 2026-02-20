import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { embed, isEngineReady, vectorToBlob, textHash, getModelName, getDimensions } from './embeddings'

const DEFAULT_BATCH_SIZE = 10

export async function indexPendingEmbeddings(
  db: Database.Database,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<{ indexed: number; skipped: number; errors: number }> {
  if (!isEngineReady()) {
    return { indexed: 0, skipped: 0, errors: 0 }
  }

  const unembedded = queries.getUnembeddedEntities(db, batchSize)
  let indexed = 0
  let skipped = 0
  let errors = 0

  for (const entity of unembedded) {
    try {
      // Combine entity name + observations for embedding
      const observations = queries.getObservations(db, entity.id)
      const textParts = [entity.name]
      for (const obs of observations.slice(0, 5)) {
        textParts.push(obs.content)
      }
      const fullText = textParts.join(' ').substring(0, 2000)
      const hash = textHash(fullText)

      // Check if already embedded with same hash
      const existing = queries.getEmbeddingsForEntity(db, entity.id)
      if (existing.some(e => e.textHash === hash)) {
        skipped++
        continue
      }

      const vector = await embed(fullText)
      if (!vector) {
        errors++
        continue
      }

      queries.upsertEmbedding(
        db,
        entity.id,
        'entity',
        entity.id,
        hash,
        vectorToBlob(vector),
        getModelName(),
        getDimensions()
      )
      indexed++
    } catch {
      errors++
    }
  }

  return { indexed, skipped, errors }
}
