// The Worker's grant (docs/design/dialogs-pane.md §6 "Grant"): web, repos,
// commands and duration, set in the card; the tools the Worker is given; and
// the check every one of its tool calls passes in a `tool.call` hook, so the
// grant holds whatever the prompt says. Pure.
import type { DgCommands, DgDialog, DgDuration, DgGrant, DgSkip, DgStop, DgWeb } from './contract'
import { isInside, isUnresolvable, resolvePath } from './paths'
import { base, gitSub, operands, readCommand, type Simple } from './shell'
import { DG_STOPS, type Place, type ToolUse } from './stops'

export const DG_WEB = ['off', 'read', 'full'] as const satisfies readonly DgWeb[]
export const WEB_LABEL = { off: 'off', read: 'read-only', full: 'full' } as const satisfies Record<DgWeb, string>
export const COMMANDS_LABEL = { checks: "the repos' checks", any: 'any (permission rules decide)' } as const satisfies Record<DgCommands, string>

export const DEFAULT_GRANT: DgGrant = { web: 'read', repos: [], commands: 'checks', duration: { kind: 'done' } }
export const DEFAULT_DG_DIALOG: DgDialog = { grant: DEFAULT_GRANT, skip: null, isWarned: false }

/** The tools a Worker is spawned with; the hook refuses any other all the same. */
export function workerTools(grant: DgGrant): string[] {
  const local = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite']
  return grant.web === 'off' ? local : [...local, 'WebFetch', 'WebSearch']
}

export function nextWeb(web: DgWeb): DgWeb {
  return DG_WEB[(DG_WEB.indexOf(web) + 1) % DG_WEB.length] ?? 'off'
}

// --- typed fields of the card ---

/** `~/code/app, /srv/api`: paths, comma- or space-separated; `~` kept for the hooks to expand. */
export function parseRepos(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map(one => one.trim().replace(/\/+$/, '')).filter(one => one !== ''))]
}

/** `done`, `90m`, `2h`, `1h30m`. */
export function parseDuration(text: string): { ok: true; value: DgDuration } | { ok: false } {
  const typed = text.trim().toLowerCase()
  if (typed === '' || typed === 'done' || typed === 'until done') return { ok: true, value: { kind: 'done' } }
  const match = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(typed)
  if (match === null || (match[1] === undefined && match[2] === undefined)) return { ok: false }
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
  return minutes > 0 ? { ok: true, value: { kind: 'deadline', minutes } } : { ok: false }
}

export function durationText(duration: DgDuration): string {
  if (duration.kind === 'done') return 'until done'
  const h = Math.floor(duration.minutes / 60)
  const m = duration.minutes % 60
  return `${h > 0 ? `${h}h` : ''}${m > 0 ? `${m}m` : ''}`
}

// --- $.store ---

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function stopsOf(v: unknown): DgStop[] {
  if (!Array.isArray(v)) return []
  return DG_STOPS.filter(stop => v.includes(stop))
}

function grantOf(v: unknown): DgGrant {
  if (!isObj(v)) return DEFAULT_GRANT
  const repos = Array.isArray(v.repos) ? v.repos.filter((one): one is string => typeof one === 'string' && one !== '') : []
  const minutes = isObj(v.duration) && typeof v.duration.minutes === 'number' && Number.isInteger(v.duration.minutes) && v.duration.minutes > 0 ? v.duration.minutes : null
  return {
    web: DG_WEB.find(one => one === v.web) ?? DEFAULT_GRANT.web,
    repos,
    commands: v.commands === 'any' ? 'any' : 'checks',
    duration: minutes === null ? { kind: 'done' } : { kind: 'deadline', minutes },
  }
}

function skipOf(v: unknown): DgSkip | null {
  if (!isObj(v)) return null
  const stops = stopsOf(v.stops)
  const until = v.until === null ? null : typeof v.until === 'number' ? v.until : undefined
  return stops.length === 0 || until === undefined ? null : { stops, until }
}

/** `delegate.dialogs` as stored: dialog id → settings; a field that does not read keeps its default. */
export function parseDgDialogs(v: unknown): Record<string, DgDialog> {
  if (!isObj(v)) return {}
  const out: Record<string, DgDialog> = {}
  for (const [id, value] of Object.entries(v)) {
    if (!/^-?\d+$/.test(id) || !isObj(value)) continue
    out[id] = { grant: grantOf(value.grant), skip: skipOf(value.skip), isWarned: value.isWarned === true }
  }
  return out
}

// --- the repos' checks ---

/** A file the check discovery read: its name in the repo root and its text (null: absent). */
export type RootFile = { name: string; text: string | null }

export const CHECK_FILES = ['package.json', 'pnpm-lock.yaml', 'pyproject.toml', 'uv.lock', 'Makefile', 'justfile', 'Cargo.toml', 'go.mod'] as const

/** The commands a repo checks itself with, read off its root files. */
export function checksOf(files: readonly RootFile[]): string[] {
  const has = (name: string) => files.some(file => file.name === name && file.text !== null)
  const text = (name: string) => files.find(file => file.name === name)?.text ?? ''
  const out: string[] = []
  if (has('package.json')) {
    let scripts: Obj = {}
    try {
      const data: unknown = JSON.parse(text('package.json'))
      if (isObj(data) && isObj(data.scripts)) scripts = data.scripts
    } catch {
      // An unreadable package.json gives no scripts; the other files still count.
    }
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : 'npm'
    for (const name of ['test', 'lint', 'typecheck', 'check', 'build', 'format:check']) {
      if (typeof scripts[name] === 'string') out.push(name === 'test' ? `${runner} test` : `${runner} run ${name}`)
    }
    out.push('npx tsc', 'npx vitest', 'npx jest', 'npx eslint', 'npx prettier --check')
  }
  if (has('pyproject.toml')) {
    const run = has('uv.lock') ? 'uv run ' : ''
    out.push(`${run}pytest`, `${run}ruff check`, `${run}ruff format --check`, `${run}mypy`, ...(run === '' ? [] : ['uv sync']))
  }
  for (const make of ['Makefile', 'justfile']) {
    if (!has(make)) continue
    const tool = make === 'Makefile' ? 'make' : 'just'
    for (const target of ['test', 'check', 'lint', 'typecheck', 'build', 'fmt-check']) {
      if (new RegExp(`^${target}:`, 'm').test(text(make))) out.push(`${tool} ${target}`)
    }
  }
  if (has('Cargo.toml')) out.push('cargo test', 'cargo check', 'cargo clippy', 'cargo fmt --check', 'cargo build')
  if (has('go.mod')) out.push('go test', 'go vet', 'go build')
  return [...new Set(out)]
}

// --- the check on every Worker tool call ---

/** Local commands that only read, or only write inside the cwd the grant already confines. */
const LOCAL = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'tree', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'diff', 'cmp',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'sed', 'awk', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'stat', 'file', 'basename', 'dirname',
  'realpath', 'which', 'type', 'date', 'sleep', 'cd', 'export', 'set', 'tee', 'xargs', 'less', 'column', 'nl', 'comm', 'paste', 'seq', 'chmod',
])
/**
 * git subcommands that stay in the worktree. Not here: the stash and config
 * (shared with the owner's checkout); push passes the grant so that the
 * publish stop asks about it.
 */
const LOCAL_GIT = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'switch', 'checkout', 'branch', 'restore', 'rev-parse', 'ls-files', 'grep', 'blame', 'mv', 'rm', 'reset', 'merge-base', 'describe', 'shortlog', 'fetch', 'rebase', 'cherry-pick', 'revert', 'tag', 'apply', 'am', 'format-patch', 'clean'])
const NET = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'aria2c', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'rsync'])
/** What read-only web may run: a plain GET. */
const FETCHERS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh'])
const SEND_FLAGS = /^(-X|--request|-d|--data.*|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-file|--method)$/

export type GrantCheck = { ok: true } | { ok: false; reason: string }

const refuse = (reason: string): GrantCheck => ({
  ok: false,
  reason: `${reason}. That is outside the grant the owner set for this task: do without it, or end your turn with "FAIL: <what you need and why>".`,
})

/** What the Worker may touch: its worktrees; never the human's checkouts the worktrees came from. */
export type Scope = Place & { checkouts: readonly string[]; checks: readonly string[] }

function pathCheck(raw: string, scope: Scope, verb: string): GrantCheck {
  if (raw === '') return { ok: true }
  if (isUnresolvable(raw)) return refuse(`${verb} ${raw}: a path the grant cannot resolve`)
  const path = resolvePath(raw, scope.worktrees[0] ?? '/', scope.home)
  if (isInside(path, scope.worktrees)) return { ok: true }
  if (isInside(path, scope.checkouts)) return refuse(`${verb} ${path}: that is the owner's own checkout; work in your worktree (${scope.worktrees.join(', ')})`)
  return refuse(`${verb} ${path}: outside your worktree (${scope.worktrees.join(', ')})`)
}

/** Whether one simple command fits `commands: checks`. */
function isCheck(simple: Simple, scope: Scope): boolean {
  const line = simple.join(' ')
  return scope.checks.some(check => line === check || line.startsWith(`${check} `))
}

function bashCheck(command: string, grant: DgGrant, scope: Scope): GrantCheck {
  const reading = readCommand(command)
  if (grant.commands === 'checks' && reading.isOpaque) return refuse('a command substitution or here-doc the grant cannot read')
  for (const simple of reading.commands) {
    const name = base(simple[0] ?? '')
    // `$W/app.py`: where it points is known only when the shell runs, so `checks` cannot clear it.
    if (grant.commands === 'checks' && simple.some(isUnresolvable)) return refuse(`${simple.join(' ').slice(0, 60)}: a variable or expansion the grant cannot resolve; write the path out`)
    if (NET.has(name)) {
      if (grant.web === 'off') return refuse(`${name}: web is off`)
      const isFetch = FETCHERS.has(name) && !simple.some(word => SEND_FLAGS.test(word))
      if (grant.web === 'read' && !isFetch) {
        return refuse(`${simple.join(' ').slice(0, 60)}: web is read-only (fetch pages, nothing sent)`)
      }
    }
    // Paths into the owner's checkouts are refused in every mode: the worktree is the Worker's place.
    for (const word of operands(simple)) {
      if (isUnresolvable(word) || !(word.startsWith('/') || word.startsWith('~') || word.includes('..'))) continue
      const path = resolvePath(word, scope.worktrees[0] ?? '/', scope.home)
      if (isInside(path, scope.checkouts) && !isInside(path, scope.worktrees)) return refuse(`${name} ${path}: that is the owner's own checkout`)
    }
    if (name === 'git') {
      const git = gitSub(simple)
      for (const dir of git?.dirs ?? []) {
        const checked = pathCheck(dir, scope, 'git -C')
        if (!checked.ok) return checked
      }
    }
    if (grant.commands === 'any') continue
    if (isCheck(simple, scope)) continue
    if (name === 'git') {
      const sub = gitSub(simple)?.sub ?? ''
      if (LOCAL_GIT.has(sub) || sub === 'push') continue
      return refuse(`git ${sub}: not a local git command`)
    }
    if (NET.has(name) && grant.web !== 'off') continue
    if (!LOCAL.has(name)) return refuse(`${name}: not one of the repo's checks (${scope.checks.join(', ') || 'none found'}) or a local read-only command`)
    for (const word of operands(simple)) {
      if (!(word.startsWith('/') || word.startsWith('~') || word.includes('..'))) continue
      const checked = pathCheck(word, scope, name)
      if (!checked.ok) return checked
    }
  }
  return { ok: true }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The grant's answer for one tool call of the Worker. Hard stops are judged
 * apart (stops.ts): a call the grant allows may still stop and ask.
 */
export function checkGrant(use: ToolUse, grant: DgGrant, scope: Scope): GrantCheck {
  switch (use.tool) {
    case 'Read':
    case 'NotebookRead':
      return pathCheck(str(use.input.file_path), scope, 'read')
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return pathCheck(str(use.input.file_path), scope, 'write')
    case 'NotebookEdit':
      return pathCheck(str(use.input.notebook_path), scope, 'write')
    case 'Glob':
    case 'Grep':
      return pathCheck(str(use.input.path), scope, use.tool.toLowerCase())
    case 'Bash':
      return bashCheck(str(use.input.command), grant, scope)
    case 'WebFetch':
    case 'WebSearch':
      return grant.web === 'off' ? refuse(`${use.tool}: web is off`) : { ok: true }
    case 'TodoWrite':
      return { ok: true }
    default:
      // Agent would start a loop the hooks do not follow; everything else was not granted.
      return refuse(`${use.tool}: not a tool of this task`)
  }
}
