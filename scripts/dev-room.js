const { spawn } = require('child_process')
const { homedir } = require('os')
const { join } = require('path')

const IS_WIN = process.platform === 'win32'

function getArgValue(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return fallback
  const value = process.argv[idx + 1]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function run(command, args, options = {}) {
  const env = {}
  const sourceEnv = options.env ?? process.env
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!key || key.includes('=') || value === undefined) continue
    env[key] = String(value)
  }
  return new Promise((resolve, reject) => {
    const child = IS_WIN && command === 'npm'
      ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], {
          stdio: 'inherit',
          cwd: options.cwd ?? process.cwd(),
          env,
        })
      : spawn(command, args, {
          stdio: 'inherit',
          cwd: options.cwd ?? process.cwd(),
          env,
        })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`))
    })
  })
}

async function main() {
  const port = getArgValue('--port', '4700')
  const isolated = process.argv.includes('--isolated')
  const env = { ...process.env }
  env.QUOROOM_SKIP_MCP_NPM_INSTALL = env.QUOROOM_SKIP_MCP_NPM_INSTALL || '1'

  if (isolated) {
    env.QUOROOM_DATA_DIR = env.QUOROOM_DATA_DIR || join(homedir(), '.quoroom-dev')
    env.QUOROOM_SKIP_MCP_REGISTER = env.QUOROOM_SKIP_MCP_REGISTER || '1'
  }

  await run('npm', ['run', 'build:mcp'], { env })
  await run('npm', ['run', 'build:ui'], { env })
  await run(process.execPath, ['scripts/dev-server.js', '--port', port], { env })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
