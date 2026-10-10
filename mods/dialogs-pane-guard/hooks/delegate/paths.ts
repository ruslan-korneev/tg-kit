// Paths for the grant: where a path a tool names really points, and whether it
// is inside one of the Worker's worktrees. Pure: symlinks are not followed
// (the hooks environment has no file system), so a link inside a worktree
// that points out of it passes: a known gap of a pure check.

/** Resolves `.` and `..`; a relative path is taken from `cwd`; `~` from `home`. */
export function resolvePath(path: string, cwd: string, home: string): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Whether `path` (absolute, resolved) is one of `roots` or under one. */
export function isInside(path: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const clean = root.replace(/\/+$/, '')
    return path === clean || path.startsWith(`${clean}/`)
  })
}

/** A word that names a place the hooks cannot resolve: an expansion or a glob above a worktree. */
export function isUnresolvable(word: string): boolean {
  return /[$`]/.test(word) || /^~[^/]/.test(word)
}

/** Credential files and stores: reading one is the first step of sharing it. */
export function isCredentialPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example' && name !== '.env.sample') return true
  if (/\.(pem|key|p12|pfx|keystore|jks|kdbx)$/.test(name)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true
  if (['.netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', '.git-credentials', 'secrets.json', 'secrets.yaml', 'secrets.yml'].includes(name)) return true
  return /\/\.(ssh|aws|gnupg|kube|docker|config\/gh)(\/|$)/.test(path) || path.includes('/.config/tg-kit/sessions')
}
