/**
 * Watch mode: rebuild MCP/CLI/server on source changes and restart the server.
 *
 * Usage: node scripts/dev-server.js [--port 3700]
 */

const { spawn } = require('child_process')
const esbuild = require('esbuild')
const { writeFileSync, mkdirSync, existsSync } = require('fs')
const { version } = require('../package.json')

const port = (() => {
  const i = process.argv.indexOf('--port')
  return i !== -1 ? process.argv[i + 1] : '3700'
})()

const EXTERNALS = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  'onnxruntime-node'
]

const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: EXTERNALS,
  define: { '__APP_VERSION__': `"${version}"` },
  logLevel: 'info'
}

// Ensure out/mcp/package.json exists (for native deps)
mkdirSync('out/mcp', { recursive: true })
if (!existsSync('out/mcp/node_modules')) {
  writeFileSync('out/mcp/package.json', JSON.stringify({
    name: 'quoroom-mcp',
    version,
    private: true,
    dependencies: {
      'better-sqlite3': '11.10.0',
      'sqlite-vec': '*',
      '@huggingface/transformers': '*',
      'ws': '*'
    }
  }, null, 2))
  require('child_process').execSync('npm install --omit=dev', { cwd: 'out/mcp', stdio: 'inherit' })
}

function killExistingServer(port) {
  try {
    const pids = require('child_process').execSync(`lsof -ti TCP:${port} -s TCP:LISTEN`, { encoding: 'utf8' }).trim()
    if (pids) {
      pids.split('\n').forEach(pid => {
        try { process.kill(Number(pid), 'SIGKILL') } catch {}
      })
      console.error(`  Killed PID(s): ${pids.replace(/\n/g, ', ')}`)
    }
  } catch {
    // No process on this port
  }
}

let serverProcess = null

function startServer() {
  serverProcess = spawn('node', ['out/mcp/cli.js', 'serve', '--port', port], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' }
  })
  serverProcess.on('exit', (code) => {
    if (code !== null) serverProcess = null
  })
}

function restartServer() {
  if (serverProcess) {
    serverProcess.on('exit', () => {
      startServer()
    })
    serverProcess.kill('SIGTERM')
  } else {
    startServer()
  }
}

async function main() {
  // Build all three entry points in watch mode
  const builds = [
    { entryPoints: ['src/mcp/server.ts'], outfile: 'out/mcp/server.js', ...COMMON },
    { entryPoints: ['src/cli/index.ts'], outfile: 'out/mcp/cli.js', ...COMMON },
    { entryPoints: ['src/server/index.ts'], outfile: 'out/mcp/api-server.js', ...COMMON, external: [...EXTERNALS, 'ws'] },
  ]

  let ready = 0
  for (const cfg of builds) {
    const ctx = await esbuild.context(cfg)
    await ctx.watch()
    ready++
  }

  // Start Vite in watch mode for the UI
  const viteProcess = spawn(
    'node',
    ['node_modules/.bin/vite', 'build', '--watch', '--config', 'src/ui/vite.config.ts'],
    { stdio: 'inherit' }
  )
  viteProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`Vite exited with code ${code}`)
  })

  console.error(`\n  Watching ${ready} entry points + UI for changes...`)
  console.error(`  Server will start on port ${port}\n`)

  // Kill any existing server on this port before starting
  console.error(`\n  Killing any existing process on port ${port}...\n`)
  killExistingServer(port)

  // Initial start
  startServer()

  // Restart server whenever cli.js is rebuilt (esbuild watch triggers a write)
  const fs = require('fs')
  let debounce = null
  fs.watch('out/mcp/cli.js', () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      console.error('\n  Rebuilt — restarting server...\n')
      restartServer()
    }, 300)
  })

  process.on('SIGINT', () => {
    if (serverProcess) serverProcess.kill('SIGTERM')
    viteProcess.kill('SIGTERM')
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    if (serverProcess) serverProcess.kill('SIGTERM')
    viteProcess.kill('SIGTERM')
    process.exit(0)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
