import { createHash } from 'crypto'
import type Database from 'better-sqlite3'

let pipeline: ((text: string | string[]) => Promise<{ tolist: () => number[][] }>) | null = null
let pipelineLoading = false

let sqliteVecLoaded = false

/**
 * Load the sqlite-vec extension into a better-sqlite3 connection.
 * Provides vec_distance_cosine() for vector search in SQL.
 * Non-fatal: if sqlite-vec is unavailable, falls back to JS cosine similarity.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  if (sqliteVecLoaded) return true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec')
    sqliteVec.load(db)
    sqliteVecLoaded = true
    return true
  } catch {
    return false
  }
}

export function isSqliteVecReady(): boolean {
  return sqliteVecLoaded
}

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'
const DIMENSIONS = 384

export function getModelName(): string {
  return MODEL_NAME.replace('Xenova/', '')
}

export function getDimensions(): number {
  return DIMENSIONS
}

export function isEngineReady(): boolean {
  return pipeline !== null
}

export async function initEngine(): Promise<void> {
  if (pipeline || pipelineLoading) return
  pipelineLoading = true
  try {
    // Dynamic import — @huggingface/transformers is optional
    const { pipeline: createPipeline } = await import('@huggingface/transformers')
    const pipe = await createPipeline('feature-extraction', MODEL_NAME, {
      dtype: 'fp32',
      revision: 'main'
    })
    pipeline = async (text: string | string[]) => {
      const result = await pipe(text, { pooling: 'mean', normalize: true })
      return result as { tolist: () => number[][] }
    }
  } catch {
    pipeline = null
  } finally {
    pipelineLoading = false
  }
}

export async function embed(text: string): Promise<Float32Array | null> {
  if (!pipeline && !pipelineLoading) {
    await initEngine()
  }
  if (!pipeline) return null

  try {
    const output = await pipeline(text)
    const vectors = output.tolist()
    return new Float32Array(vectors[0])
  } catch {
    return null
  }
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return []
  if (!pipeline && !pipelineLoading) {
    await initEngine()
  }
  if (!pipeline) return texts.map(() => null)

  try {
    const output = await pipeline(texts)
    const vectors = output.tolist()
    return vectors.map((v: number[]) => new Float32Array(v))
  } catch {
    return texts.map(() => null)
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 16)
}

