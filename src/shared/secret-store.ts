import crypto from 'node:crypto'
import { hostname, userInfo } from 'node:os'

const SECRET_PREFIX = 'enc:v1:'
const SECRET_ALGO = 'aes-256-gcm'
const SECRET_IV_BYTES = 12

let cachedSecretKey: Buffer | null = null

function getSecretKey(): Buffer {
  if (cachedSecretKey) return cachedSecretKey

  const secretKeyEnv = process.env.QUOROOM_SECRET_KEY
  const isProduction = process.env.NODE_ENV === 'production'

  if (!secretKeyEnv) {
    if (isProduction) {
      throw new Error(
        'QUOROOM_SECRET_KEY environment variable is required in production. ' +
        'Set a secure random string (e.g., 32+ characters) before starting the application.'
      )
    } else {
      // Development mode: generate random key with warning
      console.warn(
        '[SECRET-STORE] QUOROOM_SECRET_KEY not set. Using random development key. ' +
        'WARNING: Secrets will NOT persist across restarts and are NOT secure. ' +
        'Set QUOROOM_SECRET_KEY for production use.'
      )
      // Generate a random 32-byte key for development
      const devSeed = crypto.randomBytes(32).toString('hex')
      cachedSecretKey = crypto.createHash('sha256').update(devSeed).digest()
      return cachedSecretKey
    }
  }

  cachedSecretKey = crypto.createHash('sha256').update(secretKeyEnv).digest()
  return cachedSecretKey
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(SECRET_IV_BYTES)
  const cipher = crypto.createCipheriv(SECRET_ALGO, getSecretKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${SECRET_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptSecret(value: string): string {
  // Backward compatibility for pre-encryption values stored as plaintext.
  if (!value.startsWith(SECRET_PREFIX)) return value

  const raw = value.slice(SECRET_PREFIX.length)
  const parts = raw.split(':')

  if (parts.length !== 3) throw new Error('Invalid encrypted secret format')

  const iv = Buffer.from(parts[0], 'hex')
  const tag = Buffer.from(parts[1], 'hex')
  const ciphertext = Buffer.from(parts[2], 'hex')

  const decipher = crypto.createDecipheriv(SECRET_ALGO, getSecretKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
