import { execSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

const PATHS = {
  lib: '/usr/local/lib/quoroom',
  bin: '/usr/local/bin/quoroom',
  data: join(homedir(), '.quoroom'),
  logs: join(homedir(), 'Library', 'Logs', 'Quoroom'),
}
const PKG_ID = 'ai.quoroom.room'

export function runUninstall(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  rl.question('This will remove Quoroom and all its data. Continue? [y/N] ', (answer) => {
    rl.close()
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.')
      process.exit(0)
    }

    // Stop server
    try { execSync('pkill -f "quoroom serve"', { stdio: 'ignore' }) } catch {}

    // Remove data & logs (no sudo needed)
    for (const dir of [PATHS.data, PATHS.logs]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        console.log(`Removed ${dir}`)
      }
    }

    // Remove binary and lib (needs sudo)
    const needsSudo = existsSync(PATHS.lib) || existsSync(PATHS.bin)
    if (needsSudo) {
      console.log('\nRemoving /usr/local/lib/quoroom and /usr/local/bin/quoroom (requires sudo)...')
      try {
        execSync(`sudo rm -rf ${PATHS.lib} ${PATHS.bin}`, { stdio: 'inherit' })
        console.log('Removed binaries.')
      } catch {
        console.error('Failed to remove binaries. Run manually:\n  sudo rm -rf /usr/local/lib/quoroom /usr/local/bin/quoroom')
      }
    }

    // Forget pkg receipt
    try {
      execSync(`sudo pkgutil --forget ${PKG_ID}`, { stdio: 'ignore' })
      console.log('Removed package receipt.')
    } catch {}

    console.log('\nQuoroom has been uninstalled.')
  })
}
