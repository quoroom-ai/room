const { execSync } = require('child_process')
const { writeFileSync, mkdirSync } = require('fs')
const { version } = require('../package.json')

const EXTERNALS = [
  '--external:better-sqlite3',
  '--external:sqlite-vec',
  '--external:@huggingface/transformers',
  '--external:onnxruntime-node'
]

const COMMON = [
  '--bundle',
  '--platform=node',
  '--target=node18',
  ...EXTERNALS,
  `--define:__APP_VERSION__='"${version}"'`
]

// Bundle MCP server
execSync(`esbuild src/mcp/server.ts --outfile=out/mcp/server.js ${COMMON.join(' ')}`, { stdio: 'inherit' })

// Bundle CLI entry point
execSync(`esbuild src/cli/index.ts --outfile=out/mcp/cli.js ${COMMON.join(' ')}`, { stdio: 'inherit' })

// Bundle HTTP API server
execSync(`esbuild src/server/index.ts --outfile=out/mcp/api-server.js ${COMMON.join(' ')} --external:ws`, { stdio: 'inherit' })

// Create package.json so npm install stays in out/mcp/ (not the root)
mkdirSync('out/mcp', { recursive: true })
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

execSync('npm install --omit=dev', { cwd: 'out/mcp', stdio: 'inherit' })
