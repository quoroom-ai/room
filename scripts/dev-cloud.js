const { spawn } = require('child_process')
const { existsSync } = require('fs')
const { resolve } = require('path')

const IS_WIN = process.platform === 'win32'

function run(command, args, options = {}) {
  const env = {}
  const sourceEnv = options.env ?? process.env
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!key || key.includes('=') || value === undefined) continue
    env[key] = String(value)
  }
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`))
    })
  })
}

async function main() {
  await run('npm', ['run', 'kill:ports', '--', '3715'])

  const cloudDir = resolve(__dirname, '../../cloud')
  if (!existsSync(cloudDir)) {
    console.error(`Cloud project not found at ${cloudDir}`)
    process.exit(1)
  }

  const env = {
    ...process.env,
    PORT: '3715',
    CLOUD_PUBLIC_URL: 'http://127.0.0.1:3715',
    CLOUD_ALLOWED_ORIGINS: 'http://127.0.0.1:3715,http://localhost:3715,http://localhost:5173,http://127.0.0.1:5173,https://quoroom.ai,https://www.quoroom.ai,https://app.quoroom.ai',
  }

  await run('npm', ['start'], { cwd: cloudDir, env })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
