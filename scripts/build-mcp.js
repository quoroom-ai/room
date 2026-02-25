const { execSync } = require('child_process')
const { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } = require('fs')
const path = require('path')
const { version } = require('../package.json')

const OUT_DIR = 'out/mcp'
const NODE_MODULES_DIR = path.join(OUT_DIR, 'node_modules')
const INSTALL_META_PATH = path.join(OUT_DIR, '.install-meta.json')

const EXTERNALS = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  'onnxruntime-node',
  'playwright',
  'playwright-core'
]

const REQUIRED_PACKAGES = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  'playwright',
  'ws'
]

const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: EXTERNALS,
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
}

function packageInstalled(name) {
  return existsSync(path.join(NODE_MODULES_DIR, ...name.split('/'), 'package.json'))
}

function readBinaryMagic(filePath) {
  if (!existsSync(filePath)) return null
  const bytes = readFileSync(filePath)
  if (bytes.length < 4) return null
  return [bytes[0], bytes[1], bytes[2], bytes[3]]
}

function isMagicForCurrentPlatform(magic) {
  if (!magic) return false
  if (process.platform === 'win32') return magic[0] === 0x4d && magic[1] === 0x5a // PE (MZ)
  if (process.platform === 'linux') return magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46 // ELF
  if (process.platform === 'darwin') {
    const sig = magic.map((b) => b.toString(16).padStart(2, '0')).join('')
    return sig === 'cffaedfe' || sig === 'cefaedfe' || sig === 'cafebabe' || sig === 'feedface' || sig === 'feedfacf'
  }
  return true
}

function getInstallReasons() {
  const reasons = []

  if (!existsSync(NODE_MODULES_DIR)) reasons.push('missing out/mcp/node_modules')
  for (const name of REQUIRED_PACKAGES) {
    if (!packageInstalled(name)) reasons.push(`missing dependency "${name}"`)
  }

  let meta = null
  if (!existsSync(INSTALL_META_PATH)) {
    reasons.push('missing native dependency install metadata')
  } else {
    try {
      meta = JSON.parse(readFileSync(INSTALL_META_PATH, 'utf8'))
    } catch {
      reasons.push('invalid native dependency install metadata')
    }
  }

  if (meta) {
    if (meta.platform !== process.platform || meta.arch !== process.arch) {
      reasons.push(`native dependencies built for ${meta.platform}/${meta.arch}, need ${process.platform}/${process.arch}`)
    }
  }

  const betterSqliteBinary = path.join(NODE_MODULES_DIR, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  const magic = readBinaryMagic(betterSqliteBinary)
  if (!magic) {
    reasons.push('missing better-sqlite3 native binary')
  } else if (!isMagicForCurrentPlatform(magic)) {
    reasons.push('better-sqlite3 native binary does not match current platform')
  }

  return reasons
}

function writeInstallMeta() {
  writeFileSync(
    INSTALL_META_PATH,
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node
    }, null, 2)
  )
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  // Bundle all three entry points in parallel
  const esbuild = require('esbuild')
  await Promise.all([
    esbuild.build({ ...COMMON, entryPoints: ['src/mcp/server.ts'], outfile: path.join(OUT_DIR, 'server.js') }),
    esbuild.build({ ...COMMON, entryPoints: ['src/cli/index.ts'], outfile: path.join(OUT_DIR, 'cli.js') }),
    esbuild.build({ ...COMMON, entryPoints: ['src/server/index.ts'], outfile: path.join(OUT_DIR, 'api-server.js'), external: [...EXTERNALS, 'ws'] }),
  ])

  // Create package.json for native dependencies
  writeFileSync(path.join(OUT_DIR, 'package.json'), JSON.stringify({
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

  // Reinstall native deps when missing/stale/platform-mismatched.
  // In local dev, QUOROOM_SKIP_MCP_NPM_INSTALL=1 can skip this intentionally.
  const skipInstall = process.env.QUOROOM_SKIP_MCP_NPM_INSTALL === '1'
  const installReasons = getInstallReasons()
  if (installReasons.length > 0) {
    if (skipInstall) {
      console.warn(
        'Skipping out/mcp npm install due QUOROOM_SKIP_MCP_NPM_INSTALL=1 even though native deps look stale:\n'
        + installReasons.map((r) => `- ${r}`).join('\n')
      )
    } else {
      console.log(
        'Installing out/mcp native dependencies:\n'
        + installReasons.map((r) => `- ${r}`).join('\n')
      )
      rmSync(NODE_MODULES_DIR, { recursive: true, force: true })
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      execSync(`${npmCmd} install --omit=dev`, { cwd: OUT_DIR, stdio: 'inherit' })
      writeInstallMeta()
    }
  }

  if (!skipInstall) {
    const postInstallReasons = getInstallReasons()
    if (postInstallReasons.length > 0) {
      throw new Error(
        'out/mcp native dependencies are not ready after install:\n'
        + postInstallReasons.map((r) => `- ${r}`).join('\n')
      )
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
