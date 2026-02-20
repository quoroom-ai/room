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
import { exec, execSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import { Router, type RouteContext } from './router'
import {
  generateToken,
  validateToken,
  isAllowedOrigin,
  isLocalOrigin,
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
import { initUpdateChecker, stopUpdateChecker, getUpdateInfo } from './updateChecker'

const DEFAULT_PORT = 3700

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

  try {
    const data = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    }
    res.writeHead(200, headers)
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }
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

  const token = generateToken()
  if (!options.skipTokenFile) {
    writeTokenFile(dataDir, token, port)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    const origin = req.headers.origin as string | undefined

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
    setCorsHeaders(origin, responseHeaders)

    // Origin validation for all /api/ requests
    if (pathname.startsWith('/api/') && !isAllowedOrigin(origin)) {
      res.writeHead(403, responseHeaders)
      res.end(JSON.stringify({ error: 'Forbidden origin' }))
      return
    }

    // Auth handshake — no token needed, Origin must be localhost
    // Returns user token (restricted in auto mode, full in semi mode)
    if (pathname === '/api/auth/handshake' && req.method === 'GET') {
      if (!isLocalOrigin(origin)) {
        res.writeHead(403, responseHeaders)
        res.end(JSON.stringify({ error: 'Handshake allowed only from local origin' }))
        return
      }
      res.writeHead(200, responseHeaders)
      res.end(JSON.stringify({ token: getUserToken() }))
      return
    }

    // Auth verify
    if (pathname === '/api/auth/verify' && req.method === 'GET') {
      const role = validateToken(req.headers.authorization)
      if (!role) {
        res.writeHead(401, responseHeaders)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      res.writeHead(200, responseHeaders)
      res.end(JSON.stringify({ ok: true, role }))
      return
    }

    // All other /api/* routes require auth
    if (pathname.startsWith('/api/')) {
      // Support token via ?token= query param (used for binary download links)
      const queryToken = url.searchParams.get('token')
      const authValue = req.headers.authorization ?? (queryToken ? `Bearer ${queryToken}` : undefined)
      const role = validateToken(authValue)
      if (!role) {
        res.writeHead(401, responseHeaders)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      // Role-based access control
      if (!isAllowedForRole(role, req.method!, pathname, db)) {
        res.writeHead(403, responseHeaders)
        res.end(JSON.stringify({ error: 'Forbidden: auto mode restricts this action' }))
        return
      }

      // Binary streaming download — must be handled before router (not JSON)
      if (pathname === '/api/status/update/download' && req.method === 'GET') {
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
        const body = await parseBody(req)
        const query = Object.fromEntries(url.searchParams)
        const ctx: RouteContext = {
          params: matched.params,
          query,
          body,
          db
        }
        const result = await matched.handler(ctx)
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
 * Register Quoroom MCP server in all known AI client configs automatically.
 * Runs silently on server startup so non-technical users get MCP tools without manual setup.
 * Supported: Claude Code, Claude Desktop, Cursor, Windsurf.
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

    // Claude Code (~/.claude.json)
    patchMcpConfig(path.join(home, '.claude.json'), entry('claude-code'))

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
  } catch {
    // Never break server startup over MCP registration
  }
}

/** Start the server (for CLI use) */
export function startServer(options: ServerOptions = {}): void {
  const port = options.port ?? DEFAULT_PORT
  // Default to built UI directory next to the compiled server output
  if (!options.staticDir) {
    const defaultUiDir = path.join(__dirname, '../ui')
    if (fs.existsSync(defaultUiDir)) {
      options.staticDir = defaultUiDir
    }
  }
  const dbPath = process.env.QUOROOM_DB_PATH || path.join(options.dataDir ?? getDataDir(), 'data.db')
  const { server, token, db: serverDb } = createApiServer(options)

  // Register MCP server in ~/.claude/.mcp.json so Claude Code picks it up automatically.
  // Skip during tests (QUOROOM_SKIP_MCP_REGISTER=1) to avoid clobbering real config.
  if (!process.env.QUOROOM_SKIP_MCP_REGISTER) {
    registerMcpGlobally(dbPath)
  }

  // Start cloud sync if public mode is enabled
  initCloudSync(serverDb)

  // Start background update checker (polls GitHub every 4 hours)
  initUpdateChecker()

  function listen(): void {
    server.listen(port, () => {
      const dashboardUrl = 'https://app.quoroom.ai'
      console.error(`Quoroom API server started on http://localhost:${port}`)
      console.error(`Dashboard: ${dashboardUrl}`)
      console.error(`Auth token: ${token.slice(0, 8)}...`)

      // Auto-open dashboard only in production builds.
      if (process.env.NODE_ENV === 'production') {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open'
        exec(`${cmd} ${dashboardUrl}`)
      }
    })
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use — killing existing process...`)
      try {
        execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' })
      } catch {
        // No process found or kill failed — ignore
      }
      setTimeout(listen, 500)
    } else {
      throw err
    }
  })

  listen()

  process.on('SIGINT', () => {
    console.error('Shutting down...')
    _stopAllLoops()
    stopCloudSync()
    stopUpdateChecker()
    server.close()
    closeServerDatabase()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    _stopAllLoops()
    stopCloudSync()
    stopUpdateChecker()
    server.close()
    closeServerDatabase()
    process.exit(0)
  })
}
