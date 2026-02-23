#!/usr/bin/env node
const { spawn } = require('child_process')

const skipTypecheck = process.argv.includes('--skip-typecheck')

/** Run a command and return a promise that resolves/rejects on exit */
function run(label, cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: true })
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${label} failed (exit ${code})`))
      else resolve()
    })
    proc.on('error', reject)
  })
}

async function main() {
  const tasks = [
    run('build:mcp', 'node', ['scripts/build-mcp.js']),
    run('build:ui', 'npx', ['vite', 'build', '--config', 'src/ui/vite.config.ts']),
  ]
  if (!skipTypecheck) {
    tasks.push(run('typecheck', 'npx', ['tsc', '--noEmit']))
  }

  const results = await Promise.allSettled(tasks)
  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length) {
    for (const f of failed) console.error(f.reason.message)
    process.exit(1)
  }
}

main()
