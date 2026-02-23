const { execSync } = require('child_process')
const { writeFileSync, mkdirSync, existsSync } = require('fs')
const { version } = require('../package.json')

const EXTERNALS = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  'onnxruntime-node',
  'playwright',
  'playwright-core'
]

const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: EXTERNALS,
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
}

async function main() {
  mkdirSync('out/mcp', { recursive: true })

  // Bundle all three entry points in parallel
  const esbuild = require('esbuild')
  await Promise.all([
    esbuild.build({ ...COMMON, entryPoints: ['src/mcp/server.ts'], outfile: 'out/mcp/server.js' }),
    esbuild.build({ ...COMMON, entryPoints: ['src/cli/index.ts'], outfile: 'out/mcp/cli.js' }),
    esbuild.build({ ...COMMON, entryPoints: ['src/server/index.ts'], outfile: 'out/mcp/api-server.js', external: [...EXTERNALS, 'ws'] }),
  ])

  // Create package.json for native dependencies
  writeFileSync('out/mcp/package.json', JSON.stringify({
    name: 'quoroom-mcp',
    version,
    private: true,
    dependencies: {
      'better-sqlite3': '11.10.0',
      'sqlite-vec': '*',
      '@huggingface/transformers': '*',
      'playwright': '*',
      'ws': '*'
    }
  }, null, 2))

  // Only run npm install if node_modules doesn't exist yet
  if (!existsSync('out/mcp/node_modules')) {
    execSync('npm install --omit=dev', { cwd: 'out/mcp', stdio: 'inherit' })
  }
}

main().catch(err => { console.error(err); process.exit(1) })
