// The Worker's grant (docs/design/dialogs-pane.md §6 "Grant"): web, repos,
// commands and duration, set in the card; the tools the Worker is given; and
// the check every one of its tool calls passes in a `tool.call` hook, so the
// grant holds whatever the prompt says. Pure.
import type { DgDialog, DgDuration, DgGrant, DgSkip, DgStop, DgWeb } from './contract'
import { isInside, isUnresolvable, resolvePath } from './paths'
import { base, gitSub, operands, pathWords, readCommand, seeThrough, type Reading, type Simple } from './shell'
import { DG_STOPS, type Place, type ToolUse } from './stops'

export const DG_WEB = ['off', 'read', 'full'] as const satisfies readonly DgWeb[]
export const WEB_LABEL = { off: 'off', read: 'read-only', full: 'full' } as const satisfies Record<DgWeb, string>
/** The card's fixed `commands` row: the Worker's only commands mode (decision 12). */
export const COMMANDS_LABEL = "the repo's checks"

export const DEFAULT_GRANT: DgGrant = { web: 'read', repos: [], duration: { kind: 'done' } }
export const DEFAULT_DG_DIALOG: DgDialog = { grant: DEFAULT_GRANT, skip: null, isWarned: false }

/** The tools a Worker is spawned with; the hook refuses any other all the same. */
export function workerTools(grant: DgGrant): string[] {
  const local = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite']
  return grant.web === 'off' ? local : [...local, 'WebFetch', 'WebSearch']
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
    // A stored `commands` (`checks`, or the removed `any`) is dropped: the repo's checks are the only mode.
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

/**
 * What the Worker may touch: its worktrees; never the human's checkouts the
 * worktrees came from, nor tg-kit's config directory (TG_KIT_CONFIG_DIR), in
 * which the worktrees live.
 */
export type Scope = Place & { checkouts: readonly string[]; checks: readonly string[]; configDir: string }

/** isLiteral: a Bash word the shell does not expand (`'$1'`), so a `$` in it is a letter. */
function pathCheck(raw: string, scope: Scope, verb: string, cwd = scope.worktrees[0] ?? '/', isLiteral = false): GrantCheck {
  if (raw === '') return { ok: true }
  if (isLiteral ? /^~[^/]/.test(raw) : isUnresolvable(raw)) return refuse(`${verb} ${raw}: a path the grant cannot resolve`)
  const path = resolvePath(raw, cwd, scope.home)
  if (isInside(path, scope.worktrees)) return { ok: true }
  if (isInside(path, scope.checkouts)) return refuse(`${verb} ${path}: that is the owner's own checkout; work in your worktree (${scope.worktrees.join(', ')})`)
  return refuse(`${verb} ${path}: outside your worktree (${scope.worktrees.join(', ')})`)
}

/** Whether one simple command fits `commands: checks`. */
function isCheck(simple: Simple, scope: Scope): boolean {
  const line = simple.join(' ')
  return scope.checks.some(check => line === check || line.startsWith(`${check} `))
}

// --- where a Bash word can point ---

const GLOB = /[*?[{]/

/** One segment of a glob as a regex, case-insensitive; a class it cannot read matches anything. */
function globSegment(part: string): RegExp {
  const source = part
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\{[^}]*\}/g, '.*')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\[!/g, '[^')
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    // An unclosed `[`: fail closed, it may match the segment.
    return /^/
  }
}

/**
 * Whether a resolved path, a glob perhaps, can name something inside `root`
 * that is not in a worktree. The root is compared case-insensitively (macOS
 * file systems are), the worktrees exactly.
 */
function reaches(path: string, root: string, worktrees: readonly string[]): boolean {
  if (!GLOB.test(path)) return isInside(path.toLowerCase(), [root.toLowerCase()]) && !isInside(path, worktrees)
  const parts = path.split('/').filter(part => part !== '')
  const rootParts = root.split('/').filter(part => part !== '')
  for (const [i, rootPart] of rootParts.entries()) {
    const part = parts[i]
    if (part === undefined) return false
    if (part.includes('**')) return true
    if (!globSegment(part).test(rootPart)) return false
  }
  // It matches the root; what it names below the root is a worktree only when it says so before its first glob.
  const below = parts.slice(rootParts.length)
  const firstGlob = below.findIndex(part => GLOB.test(part))
  return !isInside(`/${[...rootParts, ...(firstGlob === -1 ? below : below.slice(0, firstGlob))].join('/')}`, worktrees)
}

/** `$HOME`, `${HOME}`, `$TG_KIT_CONFIG_DIR` and `${TG_KIT_CONFIG_DIR}` put in. */
function putVars(word: string, scope: Scope): string {
  return word.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, scope.home).replace(/\$\{TG_KIT_CONFIG_DIR\}|\$TG_KIT_CONFIG_DIR(?![A-Za-z0-9_])/g, scope.configDir)
}

/** A word with `~` and the known variables put in; null when a variable is left that the grant cannot know. */
function expandWord(word: string, scope: Scope): string | null {
  const out = putVars(word, scope).replace(/^~(?=\/|$)/, scope.home)
  return /[$`]/.test(out) ? null : out
}

/** The rest of a path spelled out inside a longer text. */
const PATH_RUN = /^[^\s'"`;|&<>(){},]*/

/**
 * The first place inside `roots` (and not in a worktree) that a command names:
 * in any word's path position, resolved from each place the command may
 * stand in; or spelled out anywhere in a word (an awk program, a `-c` text).
 * isHomeRelative: a root under home also counts spelled from home on
 * (`.config/tg-kit`), whatever comes before it.
 */
function fenced(reading: Reading, roots: readonly string[], scope: Scope, cwds: (index: number) => readonly string[], isHomeRelative = false): string | null {
  for (const [index, simple] of reading.commands.entries()) {
    for (const word of [simple[0] ?? '', ...pathWords(simple)]) {
      const expanded = expandWord(word, scope)
      if (expanded === null || expanded === '') continue
      for (const cwd of cwds(index)) {
        const path = resolvePath(expanded, cwd, scope.home)
        if (roots.some(root => reaches(path, root, scope.worktrees))) return path
      }
    }
  }
  for (const word of [...reading.commands.flat(), ...reading.assigns]) {
    const text = putVars(word, scope).replace(/(^|[^A-Za-z0-9_])~(?=\/)/g, `$1${scope.home}`)
    const lower = text.toLowerCase()
    for (const root of roots) {
      const spelled = isHomeRelative && root.startsWith(`${scope.home}/`) ? root.slice(scope.home.length + 1) : root
      for (let at = lower.indexOf(spelled.toLowerCase()); at !== -1; at = lower.indexOf(spelled.toLowerCase(), at + 1)) {
        const path = resolvePath(`${root}${(PATH_RUN.exec(text.slice(at + spelled.length)) ?? [''])[0]}`, '/', scope.home)
        if (reaches(path, root, scope.worktrees)) return path
      }
    }
  }
  return null
}

// --- awk and sed: read-only only when their program is ---

/** awk's program text; null when it comes from a file (`-f`) or an option the grant does not know. */
function awkProgram(simple: Simple): string | null {
  let i = 1
  for (; i < simple.length; i++) {
    const word = simple[i] ?? ''
    if (word === '--') return simple[i + 1] ?? null
    if (!word.startsWith('-') || word === '-') break
    if (word === '-F' || word === '-v') i++
    else if (!/^-[Fv]./.test(word)) return null
  }
  return simple[i] ?? null
}

/** An awk program that writes or runs: output redirected or piped, `system(`, getline from a command or a file, gawk's @load. */
const AWK_WRITES = /\bsystem\s*\(|\|\s*&?\s*getline|\bgetline\b[^;}\n]*<|\bprintf?\b[^;}\n]*[>|]|@(load|include)\b/

const SED_LONG = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--zero-terminated', '--posix', '--debug', '--sandbox', '--follow-symlinks'])

/**
 * sed's programs: each `-e`, or else the first operand; null when one comes
 * from a file (`-f`) or an option the grant does not know. bsdProgram: after a
 * bare `-i`, BSD sed takes the first operand for the backup suffix and runs
 * the second, where GNU runs the first.
 */
function sedPrograms(simple: Simple): { programs: string[]; bsdProgram: string | null } | null {
  const programs: string[] = []
  const rest: string[] = []
  let isBareInPlace = false
  for (let i = 1; i < simple.length; i++) {
    const word = simple[i] ?? ''
    if (word === '--') {
      rest.push(...simple.slice(i + 1))
      break
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const option = eq === -1 ? word : word.slice(0, eq)
      if (option === '--expression') programs.push(eq === -1 ? (simple[++i] ?? '') : word.slice(eq + 1))
      else if (option === '--line-length') i += eq === -1 ? 1 : 0
      else if (option !== '--in-place' && !SED_LONG.has(option)) return null
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      rest.push(word)
      continue
    }
    for (let k = 1; k < word.length; k++) {
      const letter = word[k] ?? ''
      if (letter === 'e') {
        programs.push(k + 1 < word.length ? word.slice(k + 1) : (simple[++i] ?? ''))
        break
      }
      if (letter === 'i') {
        // The rest is the backup suffix.
        isBareInPlace = k + 1 === word.length
        break
      }
      if (letter === 'l') {
        if (k + 1 === word.length) i++
        break
      }
      if (!'nrEsuz'.includes(letter)) return null
    }
  }
  if (programs.length > 0) return { programs, bsdProgram: null }
  return { programs: rest.slice(0, 1), bsdProgram: isBareInPlace ? (rest[1] ?? null) : null }
}

type SedVerdict = 'safe' | 'writes' | 'unknown'

/**
 * Whether a sed program can write, run or read another file (`w`, `W`, `e`,
 * `r`, `R`, `s///w`, `s///e`), or is one this cannot parse. `bsd` reads it as
 * BSD sed does: GNU's own commands are unknown there.
 */
function sedVerdict(program: string, dialect: 'gnu' | 'bsd'): SedVerdict {
  const isGnu = dialect === 'gnu'
  let i = 0
  const at = () => program[i] ?? ''
  const isEnd = () => i >= program.length
  /** Past the next unescaped `delim`; false when there is none. */
  const past = (delim: string): boolean => {
    while (!isEnd() && at() !== delim) i += at() === '\\' ? 2 : 1
    if (isEnd()) return false
    i++
    return true
  }
  const address = (): boolean => {
    if (at() === '/' || at() === '\\') {
      const delim = at() === '/' ? '/' : (program[i + 1] ?? '')
      i += at() === '/' ? 1 : 2
      if (!past(delim)) return false
      while (at() === 'I' || at() === 'M') i++
      return true
    }
    while (/[\d$~+]/.test(at()) && !isEnd()) i++
    return true
  }
  for (;;) {
    while (/[\s;]/.test(at()) && !isEnd()) i++
    if (isEnd()) return 'safe'
    if (!address()) return 'unknown'
    if (at() === ',') {
      i++
      if (!address()) return 'unknown'
    }
    while (at() === ' ' || at() === '!') i++
    const command = at()
    i++
    if ('{}pPdDnNgGhHx='.includes(command) || (isGnu && 'zF'.includes(command))) continue
    if ('wr'.includes(command) || (isGnu && 'WeR'.includes(command))) return 'writes'
    if (command === 's' || command === 'y') {
      const delim = at()
      i++
      if (delim === '' || delim === '\n' || delim === '\\' || !past(delim) || !past(delim)) return 'unknown'
      if (command === 's') {
        for (; /[gpiImMew0-9]/.test(at()) && !isEnd(); i++) if (at() === 'w' || (isGnu && at() === 'e')) return 'writes'
      }
      continue
    }
    if ('aic#:bt'.includes(command) || (isGnu && command === 'T')) {
      // Text or a comment runs to the end of the line; a label also ends at `;`.
      const isLabel = ':btT'.includes(command)
      while (!isEnd() && at() !== '\n' && !(isLabel && at() === ';')) i += at() === '\\' ? 2 : 1
      continue
    }
    if ('ql'.includes(command) || (isGnu && 'QL'.includes(command))) {
      while (/[\d ]/.test(at()) && !isEnd()) i++
      continue
    }
    return 'unknown'
  }
}

/** awk and sed are local read-only commands only with a program that can neither write nor run. */
function isReadOnlyProgram(simple: Simple, name: string): boolean {
  if (name === 'awk') {
    const program = awkProgram(simple)
    return program !== null && !AWK_WRITES.test(program)
  }
  if (name === 'sed') {
    const read = sedPrograms(simple)
    if (read === null || read.programs.some(program => sedVerdict(program, 'gnu') !== 'safe')) return false
    // BSD sed runs nothing of a program it cannot parse, so there only one that writes is refused.
    return read.bsdProgram === null || sedVerdict(read.bsdProgram, 'bsd') !== 'writes'
  }
  return true
}

/** The program words of an awk or sed command: code, not paths; isReadOnlyProgram reads them. */
function programWords(simple: Simple, name: string): string[] {
  if (name === 'awk') return [awkProgram(simple) ?? '']
  const read = name === 'sed' ? sedPrograms(simple) : null
  return read === null ? [] : [...read.programs, ...(read.bsdProgram === null ? [] : [read.bsdProgram])]
}

// --- tg: never the Worker's (dialogs-pane-ux.md §9 decision 11) ---

const PYTHON = /^(python|pypy)(\d+(\.\d+)*)?$/
/** Whether Python runs tg-kit's code: `-m tg_kit…`, a `-c` text or a script that names tg_kit. */
function runsTgKit(simple: Simple): boolean {
  const names = (text: string | undefined) => (text ?? '').toLowerCase().includes('tg_kit')
  for (let i = 1; i < simple.length; i++) {
    const word = simple[i] ?? ''
    if (word === '--') return names(simple[i + 1])
    if (!word.startsWith('-') || word === '-' || word.startsWith('--')) {
      if (word.startsWith('--')) continue
      return names(word)
    }
    // A cluster such as `-Im tg_kit`: the value is the rest of the word, or the next one.
    for (let k = 1; k < word.length; k++) {
      const letter = word[k] ?? ''
      if (letter !== 'm' && letter !== 'c' && letter !== 'W' && letter !== 'X') continue
      const value = k + 1 < word.length ? word.slice(k + 1) : simple[++i]
      if (letter === 'm') return (value ?? '').toLowerCase().startsWith('tg_kit')
      if (letter === 'c') return names(value)
      break
    }
  }
  return false
}

/** Whether a simple command runs tg: by any path, or as Python on tg_kit (launchers are seen through by seeThrough). */
function runsTg(simple: Simple): boolean {
  const name = base(simple[0] ?? '').toLowerCase()
  return name === 'tg' || (PYTHON.test(name) && runsTgKit(simple))
}

// --- links: the grant reads paths without following them (paths.ts), so none may lead out ---

/** A cp that makes links instead of copies: `-s`/`--symbolic-link`, `-l`/`--link`. */
function isLinkingCp(simple: Simple): boolean {
  return simple.slice(1).some(word => word === '--symbolic-link' || word === '--link' || /^-[A-Za-z]*[sl]/.test(word))
}

/**
 * The first place an `ln` (or a linking cp) puts a link or points one that is outside the
 * worktrees, or cannot be told; null when every one is inside. A symbolic
 * link's target is read from where the link lies; a hard link's from the cwd.
 */
function linkOutside(simple: Simple, cwds: readonly string[], scope: Scope, reading: Reading): string | null {
  const isSymbolic = simple.some(word => word === '--symbolic' || word === '--symbolic-link' || /^-[A-Za-z]*s/.test(word))
  // `-t DIR`, `-stDIR`, `--target-directory[=]DIR`: the directory the links go in.
  const dirs = simple.flatMap((word, i) => {
    if (/^-[A-Za-z]*t$/.test(word) || word === '--target-directory') return [simple[i + 1] ?? '']
    if (/^-[A-Za-z]*t./.test(word)) return [word.slice(word.indexOf('t') + 1)]
    return word.startsWith('--target-directory=') ? [word.slice(19)] : []
  })
  const hasDir = dirs.length > 0
  const names = operands(simple).filter(word => !dirs.includes(word))
  // With a target directory every operand is a target; without, the last one is the link.
  const targets = isSymbolic ? (hasDir ? names : names.slice(0, -1)) : []
  const where = (word: string): string | null => {
    const expanded = reading.expanded.has(word) ? null : expandWord(word, scope)
    return expanded === null || /^~[^/]/.test(expanded) ? null : expanded
  }
  // Every path word but a symbolic target is read from the cwd: the link names, the directory, a hard link's source.
  const places: string[] = []
  for (const word of pathWords(simple)) {
    if (targets.includes(word)) continue
    const expanded = where(word)
    if (expanded === null) return word
    for (const cwd of cwds) places.push(resolvePath(expanded, cwd, scope.home))
  }
  const links = (hasDir ? dirs : names.slice(-1)).flatMap(word => {
    const expanded = where(word)
    return expanded === null ? [] : cwds.map(cwd => resolvePath(expanded, cwd, scope.home))
  })
  for (const target of targets) {
    const expanded = where(target)
    if (expanded === null) return target
    // The link may be the named path or a file inside it (when it is a directory).
    for (const link of links) places.push(resolvePath(expanded, link.slice(0, link.lastIndexOf('/')) || '/', scope.home), resolvePath(expanded, link, scope.home))
  }
  return places.find(path => !isInside(path, scope.worktrees)) ?? null
}

/** Variables that make a check run other code (git's config and helpers, preloads); refused. */
const RUNS_ENV = /^(GIT_[A-Z0-9_]*|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|BASH_ENV|PAGER|EDITOR|VISUAL)=/
/** git options that run a command of their own: fetch's upload-pack, push's receive-pack. */
const GIT_RUNS = /^(--upload-pack|--receive-pack|--exec)(=|$)/

function bashCheck(command: string, grant: DgGrant, scope: Scope): GrantCheck {
  const reading = readCommand(command)
  // Decision 11: what is nested too deep may run tg.
  const seen = seeThrough(reading)
  if (seen.isTooDeep) return refuse('commands nested deeper than the grant reads (sh -c, eval, find -exec, git rebase -x, launchers)')
  const tg = seen.commands.find(runsTg)
  if (tg !== undefined) return refuse(`${tg.join(' ').slice(0, 60)}: tg is never the Worker's to run; the Speaker is the only voice in the chat`)
  const start = scope.worktrees[0] ?? '/'
  // Where each simple command stands: its worktree, and where a `cd` before it went.
  // Read over `seen`, so a launcher's own `sh -c 'cd …'` counts; its first commands are the reading's, in order.
  const cwds: string[][] = []
  let cwd = start
  for (const simple of seen.commands) {
    cwds.push([...new Set([start, cwd])])
    const name = base(simple[0] ?? '')
    if (name === 'cd' || name === 'pushd') {
      const target = operands(simple)[0]
      const expanded = target === undefined ? scope.home : expandWord(target, scope)
      // Fail closed: past a move it cannot follow, no relative path can be read.
      if (expanded === null || expanded === '') return refuse(`${simple.join(' ').slice(0, 60)}: a directory the grant cannot resolve (a variable, or a launcher's --directory); write the path out`)
      cwd = resolvePath(expanded, cwd, scope.home)
    }
  }
  // tg-kit's config directory, reads too (decision 11): allow.toml, the sessions, the config.
  const config = fenced(seen, [scope.configDir], scope, index => cwds[index] ?? [start], true)
  if (config !== null) return refuse(`${config}: inside tg-kit's config directory (${scope.configDir}), which is never the Worker's`)
  if (reading.isOpaque) return refuse('a command substitution or here-doc the grant cannot read')
  const runs = [...reading.assigns, ...reading.commands.filter(simple => base(simple[0] ?? '') === 'export').flatMap(simple => simple.slice(1))].find(word => RUNS_ENV.test(word))
  if (runs !== undefined) return refuse(`${runs.slice(0, runs.indexOf('='))}: a variable that makes a command run other code`)
  for (const assign of reading.assigns) {
    if (reading.expanded.has(assign)) return refuse(`${assign.slice(0, 60)}: a variable or expansion the grant cannot resolve; write the path out`)
    for (const word of pathWords(['', assign.slice(assign.indexOf('=') + 1)])) {
      const checked = pathCheck(word, scope, 'set', start, true)
      if (!checked.ok) return checked
    }
  }
  // Paths into the owner's checkouts are refused: the worktree is the Worker's place.
  const checkout = fenced(seen, scope.checkouts, scope, index => cwds[index] ?? [start])
  if (checkout !== null) return refuse(`${checkout}: that is the owner's own checkout`)
  for (const [index, simple] of reading.commands.entries()) {
    const name = base(simple[0] ?? '')
    // `$W/app.py`: where it points is known only when the shell runs, so the grant cannot clear it.
    if (simple.some(word => reading.expanded.has(word) || /^~[^/]/.test(word))) {
      return refuse(`${simple.join(' ').slice(0, 60)}: a variable or expansion the grant cannot resolve; write the path out`)
    }
    if (NET.has(name)) {
      if (grant.web === 'off') return refuse(`${name}: web is off`)
      const isFetch = FETCHERS.has(name) && !simple.some(word => SEND_FLAGS.test(word))
      if (grant.web === 'read' && !isFetch) {
        return refuse(`${simple.join(' ').slice(0, 60)}: web is read-only (fetch pages, nothing sent)`)
      }
    }
    // Links: a link inside the worktree that leads out would pass every later check.
    if (name === 'ln' || name === 'link' || (name === 'cp' && isLinkingCp(simple))) {
      const outside = linkOutside(simple, cwds[index] ?? [start], scope, reading)
      if (outside !== null) return refuse(`${name} ${outside}: a link that lies or points outside your worktree, or one the grant cannot resolve; the grant does not follow links`)
    }
    const git = name === 'git' ? gitSub(simple) : null
    for (const dir of git?.dirs ?? []) {
      const checked = pathCheck(dir, scope, 'git -C')
      if (!checked.ok) return checked
    }
    if ((name === 'cd' || name === 'pushd') && operands(simple).length === 0) return refuse(`${name} with no path: it leaves your worktree`)
    // Every place a word can name a path (an operand, `--out=/p`, `-o/p`, `>>/p`) stays in the worktree; an awk or sed program is code, read below.
    const programs = programWords(simple, name)
    for (const word of pathWords(simple.filter((word, i) => i === 0 || !programs.includes(word)))) {
      for (const from of cwds[index] ?? [start]) {
        const checked = pathCheck(word, scope, name, from, true)
        if (!checked.ok) return checked
      }
    }
    if (isCheck(simple, scope)) continue
    if (name === 'git') {
      const sub = git?.sub ?? ''
      if (git?.hasConfig === true) return refuse(`git -c: git's config is not the Worker's (a key such as core.fsmonitor runs a command)`)
      if (sub !== 'rebase' && simple.some(word => GIT_RUNS.test(word))) return refuse(`git ${sub}: an option that runs a command of its own`)
      if (LOCAL_GIT.has(sub) || sub === 'push') continue
      return refuse(`git ${sub}: not a local git command`)
    }
    if (NET.has(name) && grant.web !== 'off') continue
    if (!LOCAL.has(name)) return refuse(`${name}: not one of the repo's checks (${scope.checks.join(', ') || 'none found'}) or a local read-only command`)
    if (!isReadOnlyProgram(simple, name)) return refuse(`${name}: a program that writes or runs commands, or one read from a file`)
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
