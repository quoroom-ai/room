import { describe, it, expect } from 'vitest'
import { cosineSimilarity, vectorToBlob, blobToVector, textHash } from '../embeddings'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0)
  })

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([-1, 0, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0)
  })

  it('returns 0 for mismatched dimensions', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('computes correct similarity for arbitrary vectors', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([4, 5, 6])
    // dot = 32, normA = sqrt(14), normB = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77))
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5)
  })
})

describe('vectorToBlob / blobToVector', () => {
  it('roundtrips a Float32Array through Buffer', () => {
    const original = new Float32Array([0.1, -0.5, 0.99, 0, -1])
    const blob = vectorToBlob(original)
    const restored = blobToVector(blob)
    expect(restored.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5)
    }
  })

  it('handles empty vector', () => {
    const empty = new Float32Array([])
    const blob = vectorToBlob(empty)
    const restored = blobToVector(blob)
    expect(restored.length).toBe(0)
  })

  it('preserves 384 dimensions', () => {
    const vec = new Float32Array(384)
    for (let i = 0; i < 384; i++) vec[i] = Math.random() * 2 - 1
    const blob = vectorToBlob(vec)
    expect(blob.length).toBe(384 * 4) // Float32 = 4 bytes
    const restored = blobToVector(blob)
    expect(restored.length).toBe(384)
    for (let i = 0; i < 384; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 5)
    }
  })

  it('returns a zero-copy view (no byte-by-byte copy)', () => {
    const original = new Float32Array([1.0, 2.0, 3.0])
    const blob = vectorToBlob(original)
    const restored = blobToVector(blob)

    // The restored array should share the same underlying buffer as the blob
    expect(restored.buffer).toBe(blob.buffer)
  })

  it('works with Buffer slices (non-zero byteOffset)', () => {
    // Simulate a Buffer that's a slice of a larger allocation
    const large = Buffer.alloc(32)
    const vec = new Float32Array([42.0, -1.5])
    const blob = vectorToBlob(vec)
    blob.copy(large, 8) // copy into offset 8

    const slice = large.subarray(8, 8 + blob.length)
    const restored = blobToVector(slice)
    expect(restored.length).toBe(2)
    expect(restored[0]).toBeCloseTo(42.0, 5)
    expect(restored[1]).toBeCloseTo(-1.5, 5)
  })
})

describe('textHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = textHash('Hello, World!')
    expect(hash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('produces consistent hashes', () => {
    expect(textHash('same input')).toBe(textHash('same input'))
  })

  it('produces different hashes for different input', () => {
    expect(textHash('foo')).not.toBe(textHash('bar'))
  })
})
