import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import { createApiServer } from '../index'

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function requestRaw(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, baseUrl), { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('static and API cache headers', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves HTML/static/API responses with strict no-store headers', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'quoroom-static-'))
    cleanupDirs.push(staticDir)
    mkdirSync(join(staticDir, 'assets'), { recursive: true })
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body>ok</body></html>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("ok")')

    const db = initTestDb()
    const { server, token } = createApiServer({
      db,
      port: 0,
      staticDir,
      skipTokenFile: true,
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const root = await requestRaw(baseUrl, '/')
      expect(root.status).toBe(200)
      expect(root.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(root.headers['pragma']).toBe('no-cache')
      expect(root.headers['expires']).toBe('0')
      expect(root.headers['clear-site-data']).toBe('"cache"')

      const script = await requestRaw(baseUrl, '/assets/app.js')
      expect(script.status).toBe(200)
      expect(script.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(script.headers['pragma']).toBe('no-cache')
      expect(script.headers['expires']).toBe('0')
      expect(script.headers['clear-site-data']).toBeUndefined()

      const apiVerify = await requestRaw(baseUrl, '/api/auth/verify', {
        Authorization: `Bearer ${token}`,
      })
      expect(apiVerify.status).toBe(200)
      expect(apiVerify.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(apiVerify.headers['pragma']).toBe('no-cache')
      expect(apiVerify.headers['expires']).toBe('0')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    }
  })
})
