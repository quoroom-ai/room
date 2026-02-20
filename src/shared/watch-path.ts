import { homedir, tmpdir } from 'os'
import { isAbsolute, resolve, sep } from 'path'
import { realpathSync } from 'fs'

const SENSITIVE_HOME_SUFFIXES = [
  `${sep}.ssh`,
  `${sep}.gnupg`,
  `${sep}.aws`,
  `${sep}.env`,
  `${sep}.kube`,
  `${sep}.docker`,
  `${sep}.npmrc`,
  `${sep}.config${sep}gh`,
  `${sep}Library${sep}Keychains`
]

function getTempRoots(): string[] {
  const roots = [tmpdir()]
  // Also allow /tmp on Unix (symlink to real tmpdir on macOS)
  if (process.platform !== 'win32') roots.push('/tmp')
  return roots
}

export function validateWatchPath(watchPath: string): string | null {
  const resolved = resolve(watchPath)
  if (!isAbsolute(resolved)) {
    return 'Path must be absolute.'
  }

  // Resolve symlinks to prevent bypassing sensitive directory checks
  let realPath: string
  try {
    realPath = realpathSync(resolved)
  } catch {
    // Path doesn't exist yet — validate the literal path
    realPath = resolved
  }

  const home = homedir()
  const inTemp = getTempRoots().some((t) => realPath.startsWith(t))
  if (!realPath.startsWith(home) && !inTemp) {
    return `Path must be within your home directory (${home}) or temp.`
  }

  for (const suffix of SENSITIVE_HOME_SUFFIXES) {
    if (realPath.startsWith(home + suffix)) {
      return `Cannot watch sensitive directory: ${suffix}`
    }
  }

  return null
}
