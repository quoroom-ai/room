/**
 * Quoroom HTTP API Server
 *
 * Serves REST API + WebSocket on localhost for the browser PWA.
 * Uses raw node:http with a minimal custom router.
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { exec, execSync, spawn } from 'node:child_process'
import type Database from 'better-sqlite3'
import { Router, type RouteContext } from './router'
import {
  generateToken,
  getTokenPrincipal,
  isAllowedOrigin,
  isLocalOrigin,
  isCloudDeployment,
  getDeploymentMode,
  setCorsHeaders,
  writeTokenFile,
  getUserToken,
} from './auth'
import { isAllowedForRole } from './access'
import { registerAllRoutes } from './routes/index'
import { getServerDatabase, closeServerDatabase, getDataDir } from './db'
import { createWsServer } from './ws'
import { stopCloudSync } from '../shared/cloud-sync'
import { initCloudSync } from './cloud'
import { _stopAllLoops } from '../shared/agent-loop'
import { initUpdateChecker, stopUpdateChecker, getUpdateInfo, getReadyUpdateVersion } from './updateChecker'
import { initBootHealthCheck, USER_APP_DIR } from './autoUpdate'
import { startServerRuntime, stopServerRuntime } from './runtime'
import { closeBrowser } from '../shared/web-tools'
import { handleWebhookRequest } from './webhooks'
import { eventBus } from './event-bus'
import { inheritShellPath } from './shell-path'

try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.('.env')
} catch {
  // Ignore missing .env or unsupported Node versions.
}

const DEFAULT_PORT = 3700
const DEFAULT_BIND_HOST_LOCAL = '127.0.0.1'
const DEFAULT_BIND_HOST_CLOUD = '0.0.0.0'

/** Fetch a URL following redirects and pipe the response body to `res`. */
function streamWithRedirects(
  url: string,
  res: http.ServerResponse,
  corsHeaders: Record<string, string>,
  filename: string,
  depth = 0
): void {
  if (depth > 5) {
    if (!res.headersSent) {
      res.writeHead(502, corsHeaders)
      res.end(JSON.stringify({ error: 'Too many redirects' }))
    }
    return
  }
  try {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    mod.get(url, { headers: { 'User-Agent': 'quoroom-updater/1.0' } }, (assetRes) => {
      if (
        (assetRes.statusCode === 301 || assetRes.statusCode === 302 || assetRes.statusCode === 307) &&
        assetRes.headers.location
      ) {
        assetRes.resume()
        streamWithRedirects(assetRes.headers.location, res, corsHeaders, filename, depth + 1)
        return
      }
      const headers: Record<string, string> = {
        ...corsHeaders,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': (assetRes.headers['content-type'] as string) || 'application/octet-stream',
      }
      const contentLength = assetRes.headers['content-length']
      if (contentLength) headers['Content-Length'] = contentLength as string
      res.writeHead(assetRes.statusCode ?? 200, headers)
      assetRes.pipe(res)
    }).on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, corsHeaders)
        res.end(JSON.stringify({ error: 'Failed to fetch installer' }))
      }
    })
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, corsHeaders)
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
  }
}

export interface ServerOptions {
  /** Pass a pre-initialized DB (for tests). If omitted, uses getServerDatabase(). */
  db?: Database.Database
  port?: number
  /** Data directory for token/port files. Defaults to ~/.quoroom */
  dataDir?: string
  /** Path to React SPA build output. If omitted, no static file serving. */
  staticDir?: string
  /** If true, skip writing token/port files to disk */
  skipTokenFile?: boolean
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  const MAX_BODY_BYTES = 1_048_576 // 1 MiB
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      // Drain any remaining data so Node can recycle the socket.
      req.resume()
      reject(err)
    }

    const onData = (chunk: Buffer): void => {
      if (settled) return
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        fail(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    }

    const onEnd = (): void => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString()
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    }

    const onError = (err: Error): void => fail(err)

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function windowsQuote(arg: string): string {
  // Wrap with quotes and escape internal quotes for cmd.exe.
  return `"${arg.replace(/"/g, '\\"')}"`
}

function killProcessListeningOnPort(port: number): boolean {
  if (process.platform === 'win32') {
    // Preferred path: PowerShell TCP table + Stop-Process.
    try {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      )
      return true
    } catch {
      // Fallback to netstat + taskkill for older Windows environments.
    }

    try {
      const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      const pids = new Set<number>()
      for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        const match = line.match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
        if (!match) continue
        const linePort = Number.parseInt(match[1] ?? '', 10)
        const pid = Number.parseInt(match[2] ?? '', 10)
        if (linePort !== port || !Number.isFinite(pid) || pid <= 0) continue
        pids.add(pid)
      }
      if (pids.size === 0) return false
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
        } catch {
          // Ignore per-process kill failures.
        }
      }
      return true
    } catch {
      return false
    }
  }

  try {
    execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function scheduleSelfRestart(): boolean {
  try {
    const args = [...process.execArgv, ...process.argv.slice(1)]
    if (process.platform === 'win32') {
      const cmd = [process.execPath, ...args].map(windowsQuote).join(' ')
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `ping -n 2 127.0.0.1 >nul && ${cmd}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.unref()
    } else {
      const cmd = [process.execPath, ...args].map(shellQuote).join(' ')
      const child = spawn('/bin/sh', ['-c', `sleep 1; exec ${cmd}`], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
    }
    return true
  } catch {
    return false
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
}

const PROFILE_HTTP = process.env.QUOROOM_PROFILE_HTTP === '1'
const PROFILE_HTTP_SLOW_MS = Math.max(1, Number.parseInt(process.env.QUOROOM_PROFILE_HTTP_SLOW_MS ?? '300', 10) || 300)
const PROFILE_HTTP_ENDPOINTS = new Set([
  '/api/status',
  '/api/rooms',
  '/api/rooms/:id',
  '/api/rooms/:id/status',
  '/api/rooms/:id/activity',
  '/api/tasks',
  '/api/runs',
  '/api/runs/:id/logs',
  '/api/workers',
  '/api/memory/entities',
])

function normalizeApiPath(pathname: string): string {
  return pathname
    .replace(/^\/api\/rooms\/\d+(?=\/|$)/, '/api/rooms/:id')
    .replace(/^\/api\/tasks\/\d+(?=\/|$)/, '/api/tasks/:id')
    .replace(/^\/api\/runs\/\d+(?=\/|$)/, '/api/runs/:id')
    .replace(/^\/api\/workers\/\d+(?=\/|$)/, '/api/workers/:id')
    .replace(/^\/api\/watches\/\d+(?=\/|$)/, '/api/watches/:id')
    .replace(/^\/api\/memory\/entities\/\d+(?=\/|$)/, '/api/memory/entities/:id')
}

function maybeLogHttpProfile(method: string, pathname: string, statusCode: number, durationMs: number): void {
  if (!PROFILE_HTTP || !pathname.startsWith('/api/')) return
  const normalized = normalizeApiPath(pathname)
  const isTracked = PROFILE_HTTP_ENDPOINTS.has(normalized)
  if (!isTracked && durationMs < PROFILE_HTTP_SLOW_MS) return
  const slowMark = durationMs >= PROFILE_HTTP_SLOW_MS ? ' SLOW' : ''
  console.error(`[http-prof] ${method} ${normalized} -> ${statusCode} (${durationMs}ms)${slowMark}`)
}

function getCacheControl(filePath: string, ext: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const base = path.basename(filePath)

  if (base === 'sw.js') return 'no-cache, no-store, must-revalidate'
  if (ext === '.html') return 'no-cache, no-store, must-revalidate'
  if (ext === '.webmanifest') return 'public, max-age=3600'
  if (base === 'social.png' || base.startsWith('social-')) {
    // Social preview images rotate; force frequent revalidation.
    return 'no-cache, max-age=0, must-revalidate'
  }

  if (normalized.includes('/assets/') && /-[A-Za-z0-9_-]{8,}\./.test(base)) {
    return 'public, max-age=31536000, immutable'
  }

  if (
    base.startsWith('icon-')
    || base === 'apple-touch-icon.png'
    || ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.woff', '.woff2'].includes(ext)
  ) {
    return 'public, max-age=604800'
  }

  if (ext === '.js' || ext === '.css') {
    return 'public, max-age=3600'
  }

  return 'no-cache, max-age=0'
}

function serveStatic(staticDir: string, pathname: string, res: http.ServerResponse): void {
  // Prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let filePath = path.join(staticDir, safePath)

  try {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
  } catch {
    // If URL looks like a concrete file path (has extension), return 404.
    // SPA fallback is only for app routes like /rooms/123.
    if (path.extname(safePath)) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
      res.end('Not Found')
      return
    }
    filePath = path.join(staticDir, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': getCacheControl(filePath, ext),
  }

  const stream = fs.createReadStream(filePath)
  stream.on('open', () => {
    res.writeHead(200, headers)
    stream.pipe(res)
  })
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
    }
    res.end('Not Found')
  })
}

// ─── Rate limiting (cloud mode only) ───────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_READ = 300   // GET requests per minute per IP
const RATE_LIMIT_WRITE = 120  // mutation requests per minute per IP

interface RateBucket { count: number; resetAt: number }
const rateBuckets = new Map<string, RateBucket>()

// Periodic cleanup of stale buckets (every 2 minutes)
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key)
  }
}, 120_000).unref()

function checkRateLimit(ip: string, method: string): { allowed: boolean; retryAfter: number } {
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  const limit = isWrite ? RATE_LIMIT_WRITE : RATE_LIMIT_READ
  const key = `${ip}:${isWrite ? 'w' : 'r'}`
  const now = Date.now()
  let bucket = rateBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    rateBuckets.set(key, bucket)
  }
  bucket.count++
  if (bucket.count > limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
    return { allowed: false, retryAfter }
  }
  return { allowed: true, retryAfter: 0 }
}

// ─── Security headers (cloud mode only) ────────────────────────
const CLOUD_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

export function createApiServer(options: ServerOptions = {}): {
  server: http.Server
  token: string
  userToken: string
  db: Database.Database
} {
  const db = options.db ?? getServerDatabase()
  const port = options.port ?? DEFAULT_PORT
  const dataDir = options.dataDir ?? getDataDir()

  const router = new Router()
  registerAllRoutes(router)

  const token = generateToken(dataDir)
  if (!options.skipTokenFile) {
    writeTokenFile(dataDir, token, port)
  }

  const server = http.createServer(async (req, res) => {
    // Prevent crash when client disconnects mid-response
    res.on('error', () => {})

    const url = new URL(req.url!, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    const origin = req.headers.origin as string | undefined
    const requestStart = PROFILE_HTTP && pathname.startsWith('/api/') ? process.hrtime.bigint() : null
    if (requestStart) {
      res.on('finish', () => {
        const elapsedMs = Number((process.hrtime.bigint() - requestStart) / BigInt(1_000_000))
        maybeLogHttpProfile(req.method || 'GET', pathname, res.statusCode, elapsedMs)
      })
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {}
      setCorsHeaders(origin, headers)
      res.writeHead(204, headers)
      res.end()
      return
    }

    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    // Security headers for cloud mode
    if (isCloudDeployment()) {
      Object.assign(responseHeaders, CLOUD_SECURITY_HEADERS)
    }
    setCorsHeaders(origin, responseHeaders)

    // Rate limiting for cloud mode (API routes only)
    if (isCloudDeployment() && pathname.startsWith('/api/')) {
      const clientIp = req.socket.remoteAddress || 'unknown'
      const rl = checkRateLimit(clientIp, req.method || 'GET')
      if (!rl.allowed) {
        responseHeaders['Retry-After'] = String(rl.retryAfter)
        res.writeHead(429, responseHeaders)
        res.end(JSON.stringify({ error: 'Too many requests' }))
        return
      }
    }

    // Origin validation for all /api/ requests
    // Allow same-origin: if Origin host matches request Host, it's the app's own UI
    const isSameOrigin = origin && req.headers.host && (() => {
      try {
        return new URL(origin).host === req.headers.host
      } catch { return false }
    })()
    if (pathname.startsWith('/api/') && !isSameOrigin && !isAllowedOrigin(origin)) {
      res.writeHead(403, responseHeaders)
      res.end(JSON.stringify({ error: 'Forbidden origin' }))
      return
    }

    // Auth handshake — local-mode only.
    // Returns user token (restricted in auto mode, full in semi mode)
    if (pathname === '/api/auth/handshake' && req.method === 'GET') {
      const handshakeHeaders: Record<string, string> = {
        ...responseHeaders,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
      if (isCloudDeployment()) {
        res.writeHead(403, handshakeHeaders)
        res.end(JSON.stringify({ error: 'Handshake is disabled in cloud mode' }))
        return
      }
      const isLocalClient = isLoopbackAddress(req.socket.remoteAddress)
      if (!isLocalClient || (origin && !isLocalOrigin(origin))) {
        res.writeHead(403, handshakeHeaders)
        res.end(JSON.stringify({ error: 'Handshake allowed only from localhost clients' }))
        return
      }
      res.writeHead(200, handshakeHeaders)
      res.end(JSON.stringify({ token: getUserToken() }))
      return
    }

    // Local restart endpoint (for recovery UI when auth handshake fails).
    // No token required, but only available from localhost.
    if (pathname === '/api/server/restart' && req.method === 'POST') {
      const isLocalClient = isLoopbackAddress(req.socket.remoteAddress)
      if (!isLocalClient || (origin && !isLocalOrigin(origin))) {
        res.writeHead(403, responseHeaders)
        res.end(JSON.stringify({ error: 'Restart allowed only from localhost clients' }))
        return
      }
      const scheduled = scheduleSelfRestart()
      if (!scheduled) {
        res.writeHead(500, responseHeaders)
        res.end(JSON.stringify({ error: 'Failed to schedule restart' }))
        return
      }
      res.writeHead(202, responseHeaders)
      res.end(JSON.stringify({ ok: true, restarting: true }))
      setTimeout(() => process.exit(0), 120)
      return
    }

    // Update & restart endpoint (applies staged auto-update, then restarts).
    // No token required, but only available from localhost.
    if (pathname === '/api/server/update-restart' && req.method === 'POST') {
      const isLocalClient = isLoopbackAddress(req.socket.remoteAddress)
      if (!isLocalClient || (origin && !isLocalOrigin(origin))) {
        res.writeHead(403, responseHeaders)
        res.end(JSON.stringify({ error: 'Update-restart allowed only from localhost clients' }))
        return
      }
      const readyVersion = getReadyUpdateVersion()
      if (!readyVersion) {
        res.writeHead(404, responseHeaders)
        res.end(JSON.stringify({ error: 'No update ready to apply' }))
        return
      }
      const scheduled = scheduleSelfRestart()
      if (!scheduled) {
        res.writeHead(500, responseHeaders)
        res.end(JSON.stringify({ error: 'Failed to schedule restart' }))
        return
      }
      res.writeHead(202, responseHeaders)
      res.end(JSON.stringify({ ok: true, restarting: true, version: readyVersion }))
      setTimeout(() => process.exit(0), 120)
      return
    }

    // Auth verify
    if (pathname === '/api/auth/verify' && req.method === 'GET') {
      const principal = getTokenPrincipal(req.headers.authorization)
      if (!principal) {
        res.writeHead(401, responseHeaders)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      res.writeHead(200, responseHeaders)
      res.end(JSON.stringify({
        ok: true,
        role: principal.role,
        profile: principal.cloudProfile
          ? {
              email: principal.cloudProfile.email,
              emailVerified: principal.cloudProfile.emailVerified,
              name: principal.cloudProfile.name,
            }
          : null,
      }))
      return
    }

    // Webhook receiver — uses per-task/per-room token, no Bearer auth required
    if (pathname.startsWith('/api/hooks/') && req.method === 'POST') {
      const body = await parseBody(req).catch(() => undefined)
      const result = await handleWebhookRequest(pathname, body, db)
      res.writeHead(result.status, responseHeaders)
      res.end(JSON.stringify(result.data))
      return
    }

    // All other /api/* routes require auth
    if (pathname.startsWith('/api/')) {
      // Support query-token for routes that browsers navigate to directly (no JS fetch).
      const isDownloadRoute = pathname === '/api/status/update/download' && req.method === 'GET'
      const isRedirectRoute = pathname.endsWith('/onramp-redirect') && req.method === 'GET'
      const queryToken = (isDownloadRoute || isRedirectRoute) ? url.searchParams.get('token') : null
      const authValue = req.headers.authorization ?? (queryToken ? `Bearer ${queryToken}` : undefined)
      const principal = getTokenPrincipal(authValue)
      if (!principal) {
        res.writeHead(401, responseHeaders)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const role = principal.role

      // Binary streaming download — must be handled before router (not JSON)
      if (pathname === '/api/status/update/download' && req.method === 'GET') {
        if (!isAllowedForRole(role, req.method, pathname, db)) {
          res.writeHead(403, responseHeaders)
          res.end(JSON.stringify({ error: 'Forbidden: auto mode restricts this action' }))
          return
        }
        const info = getUpdateInfo()
        if (!info) {
          res.writeHead(404, responseHeaders)
          res.end(JSON.stringify({ error: 'No update available' }))
          return
        }
        const osPlatform = process.platform === 'darwin' ? 'mac'
          : process.platform === 'win32' ? 'windows' : 'linux'
        const assetUrl = info.assets[osPlatform as 'mac' | 'windows' | 'linux']
        if (!assetUrl) {
          res.writeHead(404, responseHeaders)
          res.end(JSON.stringify({ error: `No installer for ${osPlatform}` }))
          return
        }
        const filename = assetUrl.split('/').pop()?.split('?')[0] ?? 'installer'
        streamWithRedirects(assetUrl, res, responseHeaders, filename)
        return
      }

      const matched = router.match(req.method!, pathname)
      if (!matched) {
        res.writeHead(404, responseHeaders)
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }

      try {
        const query = Object.fromEntries(url.searchParams)
        const body = req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : await parseBody(req)

        // Role-based access control (context-aware for room-scoped autonomy mode)
        if (!isAllowedForRole(role, req.method!, pathname, db, { params: matched.params, query, body })) {
          res.writeHead(403, responseHeaders)
          res.end(JSON.stringify({ error: 'Forbidden: auto mode restricts this action' }))
          return
        }

        const ctx: RouteContext = {
          params: matched.params,
          query,
          body,
          db
        }
        const result = await matched.handler(ctx)
        if (result.redirect) {
          res.writeHead(302, { ...responseHeaders, Location: result.redirect })
          res.end()
          return
        }
        const status = result.error ? (result.status || 400) : (result.status || 200)
        res.writeHead(status, responseHeaders)
        res.end(JSON.stringify(result.error ? { error: result.error } : result.data))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error'
        const status = message === 'Invalid JSON body'
          ? 400
          : message === 'Payload too large'
            ? 413
            : 500
        res.writeHead(status, responseHeaders)
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    // Static file serving for the SPA
    if (options.staticDir) {
      serveStatic(options.staticDir, pathname, res)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })

  // Attach WebSocket server for live event streaming
  createWsServer(server)

  return { server, token, userToken: getUserToken(), db }
}

/**
 * Patch a single MCP config file with the Quoroom server entry.
 * Only patches if the file already exists — never creates it for users who don't have the client.
 * Returns true if the file was written.
 */
function patchMcpConfig(configPath: string, entry: Record<string, unknown>): boolean {
  try {
    if (!fs.existsSync(configPath)) return false
    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch { /* invalid JSON — overwrite */ }
    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {}
    mcpServers['quoroom'] = entry
    config.mcpServers = mcpServers
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * Patch Codex TOML config to register quoroom MCP server.
 * Codex stores MCP servers in ~/.codex/config.toml as TOML sections.
 * Uses TOML literal strings (single quotes) for paths so backslashes on Windows work.
 */
function patchCodexConfig(configPath: string, nodePath: string, mcpServerPath: string, dbPath: string): boolean {
  try {
    if (!fs.existsSync(configPath)) return false

    const raw = fs.readFileSync(configPath, 'utf-8')

    // Remove existing [mcp_servers.quoroom] section and its sub-sections (line-based
    // to avoid issues with TOML array syntax using '[' in values)
    const lines = raw.split('\n')
    const filtered: string[] = []
    let inQuoroomSection = false
    for (const line of lines) {
      if (/^\[mcp_servers\.quoroom[\].]/.test(line)) {
        inQuoroomSection = true
        continue
      }
      if (inQuoroomSection && /^\[/.test(line)) {
        inQuoroomSection = false
      }
      if (!inQuoroomSection) {
        filtered.push(line)
      }
    }
    let content = filtered.join('\n').trimEnd()

    // Append new section
    content += `\n\n[mcp_servers.quoroom]\ncommand = '${nodePath}'\nargs = ['${mcpServerPath}']\n\n[mcp_servers.quoroom.env]\nQUOROOM_DB_PATH = '${dbPath}'\nQUOROOM_SOURCE = "codex"\n`

    fs.writeFileSync(configPath, content)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure Claude Code settings auto-approve quoroom MCP tools so headless queen
 * sessions don't get stuck prompting for permission.
 * Patches ~/.claude/settings.json → permissions.allow with "mcp__quoroom__*".
 */
function patchClaudeCodePermissions(home: string): boolean {
  try {
    const settingsPath = path.join(home, '.claude', 'settings.json')
    if (!fs.existsSync(settingsPath)) return false

    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    } catch { /* invalid JSON — overwrite */ }

    const perms = (settings.permissions as Record<string, unknown>) ?? {}
    const allow = Array.isArray(perms.allow) ? [...perms.allow] as string[] : []

    const pattern = 'mcp__quoroom__*'
    if (allow.includes(pattern)) return false // already present

    allow.push(pattern)
    perms.allow = allow
    settings.permissions = perms
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * Register Quoroom MCP server in all known AI client configs automatically.
 * Runs silently on server startup so non-technical users get MCP tools without manual setup.
 * Supported: Claude Code, Claude Desktop, Cursor, Windsurf, Codex.
 */
function registerMcpGlobally(dbPath: string): void {
  try {
    const home = homedir()
    // server.js sits next to api-server.js in the compiled output directory
    const mcpServerPath = path.join(__dirname, 'server.js')
    const nodePath = process.execPath

    const entry = (source: string) => ({
      command: nodePath,
      args: [mcpServerPath],
      env: { QUOROOM_DB_PATH: dbPath, QUOROOM_SOURCE: source },
    })

    const isWin = process.platform === 'win32'
    const isMac = process.platform === 'darwin'

    // Claude Code (~/.claude.json) — register MCP server + auto-approve tools
    patchMcpConfig(path.join(home, '.claude.json'), entry('claude-code'))
    patchClaudeCodePermissions(home)

    // Claude Desktop
    const claudeDesktopPath = isWin
      ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : isMac
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
    patchMcpConfig(claudeDesktopPath, entry('claude-desktop'))

    // Cursor (~/.cursor/mcp.json)
    patchMcpConfig(path.join(home, '.cursor', 'mcp.json'), entry('cursor'))

    // Windsurf (~/.codeium/windsurf/mcp_config.json)
    patchMcpConfig(
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      entry('windsurf')
    )

    // Codex (~/.codex/config.toml) — TOML format, needs separate handler
    patchCodexConfig(path.join(home, '.codex', 'config.toml'), nodePath, mcpServerPath, dbPath)
  } catch {
    // Never break server startup over MCP registration
  }
}

/** Start the server (for CLI use) */
export function startServer(options: ServerOptions = {}): void {
  inheritShellPath()
  const port = options.port ?? DEFAULT_PORT
  const deploymentMode = getDeploymentMode()
  const bindHost = process.env.QUOROOM_BIND_HOST
    || (deploymentMode === 'cloud' ? DEFAULT_BIND_HOST_CLOUD : DEFAULT_BIND_HOST_LOCAL)
  // Prefer user-space UI (auto-updated) over bundled UI (from installer)
  if (!options.staticDir) {
    const userUiDir = path.join(USER_APP_DIR, 'ui')
    const bundledUiDir = path.join(__dirname, '../ui')
    if (fs.existsSync(path.join(userUiDir, 'index.html'))) {
      options.staticDir = userUiDir
    } else if (fs.existsSync(bundledUiDir)) {
      options.staticDir = bundledUiDir
    }
  }
  const dbPath = process.env.QUOROOM_DB_PATH || path.join(options.dataDir ?? getDataDir(), 'data.db')
  const { server, token, db: serverDb } = createApiServer(options)

  // Register MCP server in ~/.claude/.mcp.json so Claude Code picks it up automatically.
  // Skip during tests (QUOROOM_SKIP_MCP_REGISTER=1) to avoid clobbering real config.
  if (!process.env.QUOROOM_SKIP_MCP_REGISTER) {
    registerMcpGlobally(dbPath)

    // Re-register when a provider is installed or connected — their config files
    // may not have existed at startup (e.g. user installs codex after quoroom).
    eventBus.on('providers', (evt) => {
      if ((evt.type === 'providers:install_status' || evt.type === 'providers:auth_status') &&
          (evt.data as { status?: string })?.status === 'completed') {
        registerMcpGlobally(dbPath)
      }
    })
  }

  // Start cloud sync if public mode is enabled
  initCloudSync(serverDb)

  // Start background update checker (polls GitHub every 4 hours)
  initUpdateChecker()

  // Boot health check for auto-update rollback safety
  initBootHealthCheck()

  // Start local runtime loops (task scheduler, watch runner, room message sync).
  startServerRuntime(serverDb)

  function listen(): void {
    server.listen(port, bindHost, () => {
      addrInUseAttempts = 0
      const bound = server.address()
      const boundPort = typeof bound === 'object' && bound ? bound.port : port
      const dashboardUrl = `http://localhost:${boundPort}`
      console.error(`Quoroom API server started on http://localhost:${boundPort}`)
      console.error(`Dashboard: ${dashboardUrl}`)
      console.error(`Deployment mode: ${deploymentMode}`)
      console.error(`Bind host: ${bindHost}`)
      console.error(`Auth token: ${token.slice(0, 8)}...`)

      // Auto-open dashboard only in production builds.
      // QUOROOM_NO_AUTO_OPEN is set by the macOS tray app which manages browser opening itself.
      if (process.env.NODE_ENV === 'production' && deploymentMode !== 'cloud' && !process.env.QUOROOM_NO_AUTO_OPEN) {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open'
        exec(`${cmd} ${dashboardUrl}`)
      }
    })
  }

  let addrInUseAttempts = 0
  const MAX_ADDR_IN_USE_ATTEMPTS = 3

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      addrInUseAttempts += 1
      console.error(`Port ${port} is in use — killing existing process...`)
      const reclaimed = killProcessListeningOnPort(port)
      if (!reclaimed) {
        console.error(`Could not reclaim port ${port} (attempt ${addrInUseAttempts}/${MAX_ADDR_IN_USE_ATTEMPTS}).`)
      }
      if (!reclaimed && addrInUseAttempts >= MAX_ADDR_IN_USE_ATTEMPTS) {
        console.error(`Failed to start: port ${port} is still occupied.`)
        return
      }
      setTimeout(listen, 500)
    } else {
      throw err
    }
  })

  listen()

  // Prevent unhandled errors from crashing the server
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err)
  })
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err)
  })

  process.on('SIGINT', () => {
    console.error('Shutting down...')
    _stopAllLoops()
    stopServerRuntime()
    stopCloudSync()
    stopUpdateChecker()
    closeBrowser().catch(() => { /* ignore */ })
    server.close()
    closeServerDatabase()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    _stopAllLoops()
    stopServerRuntime()
    stopCloudSync()
    stopUpdateChecker()
    closeBrowser().catch(() => { /* ignore */ })
    server.close()
    closeServerDatabase()
    process.exit(0)
  })
}

/** @internal exported for testing */
export { windowsQuote as _windowsQuote, shellQuote as _shellQuote, isLoopbackAddress as _isLoopbackAddress }
