/**
 * CLI command: quoroom update
 *
 * Checks for updates and applies them immediately.
 * If a server is running, restarts it with the new version.
 */

import { forceCheck, getUpdateInfo } from '../server/updateChecker'
import { checkAndApplyUpdate, getReadyUpdateVersion, getAutoUpdateStatus } from '../server/autoUpdate'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

declare const __APP_VERSION__: string

function getCurrentVersion(): string {
  try {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : require('../../package.json').version
  } catch {
    return '0.0.0'
  }
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

function tryRestartServer(): void {
  // Read the token from ~/.quoroom/token to authenticate with the server
  const dataDir = path.join(homedir(), '.quoroom')
  const tokenPath = path.join(dataDir, 'token')
  const portPath = path.join(dataDir, 'port')

  if (!fs.existsSync(tokenPath) || !fs.existsSync(portPath)) {
    console.log('No running server detected. Start with: quoroom serve')
    return
  }

  const token = fs.readFileSync(tokenPath, 'utf-8').trim()
  const port = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10)

  console.log(`Restarting server on port ${port}...`)

  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/api/server/update-restart',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  }, (res) => {
    let body = ''
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => {
      if (res.statusCode === 202) {
        console.log('Server is restarting with the new version.')
      } else {
        console.log(`Server restart failed (${res.statusCode}): ${body}`)
      }
    })
  })

  req.on('error', () => {
    console.log('Could not reach the server. It may not be running.')
  })

  req.end()
}

export async function runUpdate(): Promise<void> {
  const currentVersion = getCurrentVersion()
  console.log(`Current version: ${currentVersion}`)

  // Check if an update is already downloaded
  const readyVersion = getReadyUpdateVersion()
  if (readyVersion) {
    console.log(`Update v${readyVersion} is already downloaded and ready.`)
    tryRestartServer()
    return
  }

  // Check for new releases
  console.log('Checking for updates...')
  await forceCheck()

  const info = getUpdateInfo()
  if (!info) {
    console.log('Could not check for updates. Try again later.')
    return
  }

  if (!semverGt(info.latestVersion, currentVersion)) {
    console.log(`You are on the latest version (${currentVersion}).`)
    return
  }

  console.log(`New version available: ${info.latestVersion}`)

  if (info.updateBundle) {
    console.log('Downloading lightweight update...')
    await checkAndApplyUpdate(info.updateBundle, info.latestVersion)

    const status = getAutoUpdateStatus()
    if (status.state === 'ready') {
      console.log(`Update v${info.latestVersion} downloaded successfully!`)
      tryRestartServer()
    } else if (status.state === 'error') {
      console.log(`Update failed: ${status.error}`)
      console.log(`Download the full installer from: ${info.releaseUrl}`)
    }
  } else {
    console.log('No lightweight update bundle available for this release.')
    console.log(`Download the full installer from: ${info.releaseUrl}`)
  }
}
