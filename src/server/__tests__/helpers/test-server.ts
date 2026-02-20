/**
 * Test helpers for the HTTP API server.
 * Creates a server with an in-memory SQLite database.
 */

import http from 'node:http'
import type Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import { createApiServer } from '../../index'

export interface TestContext {
  db: Database.Database
  server: http.Server
  /** Agent token (full access) */
  token: string
  /** User token (restricted in auto mode) */
  userToken: string
  baseUrl: string
  close: () => void
}

export function createTestServer(): Promise<TestContext> {
  return new Promise((resolve) => {
    const db = initTestDb()
    const { server, token, userToken } = createApiServer({
      db,
      port: 0, // OS picks random available port
      skipTokenFile: true
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        db,
        server,
        token,
        userToken,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => {
          server.close()
          db.close()
        }
      })
    })
  })
}

export interface RequestResult {
  status: number
  body: unknown
}

/** Make an authenticated request using the agent token (full access) */
export function request(
  ctx: TestContext,
  method: string,
  path: string,
  body?: unknown
): Promise<RequestResult> {
  return requestWithToken(ctx, ctx.token, method, path, body)
}

/** Make an authenticated request using the user token */
export function requestAsUser(
  ctx: TestContext,
  method: string,
  path: string,
  body?: unknown
): Promise<RequestResult> {
  return requestWithToken(ctx, ctx.userToken, method, path, body)
}

function requestWithToken(
  ctx: TestContext,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ctx.baseUrl)
    const payload = body ? JSON.stringify(body) : undefined

    const req = http.request(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = raw
        }
        resolve({ status: res.statusCode!, body: parsed })
      })
    })

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Make an unauthenticated request (no Bearer token) */
export function requestNoAuth(
  ctx: TestContext,
  method: string,
  path: string,
  headers?: Record<string, string>
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ctx.baseUrl)
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = raw
        }
        resolve({ status: res.statusCode!, body: parsed })
      })
    })
    req.on('error', reject)
    req.end()
  })
}
