// A small reading of a Bash command for the Worker's grant and hard stops:
// the simple commands it runs, each as words, with wrappers (sudo, env, xargs,
// sh -c …) taken off, and the places its words can name a path. Not a shell:
// it errs toward finding more commands and more paths, and says when it met
// something it cannot follow (substitutions, here-docs), so the grant can
// refuse what it cannot read. Pure.

/** One simple command: its words, quotes removed. */
export type Simple = readonly string[]

/**
 * isTooDeep: a command nests more `sh -c`s, `eval`s or `-exec`s than the
 * reading follows. expanded: the words the shell expands (a `$` outside single
 * quotes), so `'{print $1}'` is a literal and `"$X"` is not. assigns: the
 * `NAME=value` words taken off before the commands (`A=1 npm test`, `env A=1 …`).
 */
export type Reading = { commands: Simple[]; isOpaque: boolean; isTooDeep: boolean; expanded: Set<string>; assigns: string[] }

/** A word, or a separator between simple commands (`;`, `&&`, `|`, …); a quoted `;` is a word. */
type Token = { text: string; isSep: boolean }

/** Splits into words and separators; `$(`, backticks and here-docs mark the reading opaque. */
function lex(text: string): { tokens: Token[]; isOpaque: boolean; expanded: Set<string> } {
  const tokens: Token[] = []
  const expanded = new Set<string>()
  let word = ''
  let hasWord = false
  let isExpanded = false
  let isOpaque = false
  const flush = () => {
    if (hasWord) tokens.push({ text: word, isSep: false })
    if (hasWord && isExpanded) expanded.add(word)
    word = ''
    hasWord = false
    isExpanded = false
  }
  const sep = (mark: string) => {
    flush()
    tokens.push({ text: mark, isSep: true })
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === '\\' && i + 1 < text.length) {
      word += text[i + 1] === '\n' ? '' : (text[i + 1] ?? '')
      hasWord = true
      i++
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      word += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      hasWord = true
      i = end === -1 ? text.length : end
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          word += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '`' || (text[j] === '$' && text[j + 1] === '(')) isOpaque = true
        if (text[j] === '$') isExpanded = true
        word += text[j]
        j++
      }
      hasWord = true
      i = j
      continue
    }
    if (ch === '`' || (ch === '$' && text[i + 1] === '(')) {
      // A substitution runs a command of its own: its words are read too, and the reading is opaque.
      isOpaque = true
      sep(';')
      if (ch === '$') i++
      continue
    }
    if (ch === '>' || ch === '<') {
      // A redirection starts a word of its own (`x>f` is `x` and `>f`); a descriptor or `&` before it is part of it (`2>f`, `&>f`).
      if (!/^(\d+|&)$/.test(word)) flush()
      let op = ch
      const two = text.slice(i, i + 2)
      if (two === '<<') {
        isOpaque = true
        op = text.slice(i, i + 3) === '<<<' ? '<<<' : '<<'
      } else if (two === '>>' || two === '>|' || two === '>&' || two === '<>' || two === '<&') {
        op = two
      }
      word += op
      hasWord = true
      i += op.length - 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      sep(ch)
      continue
    }
    // `{ …; }` groups; in a word (`{}`, `${x}`, `a{b,c}`) a brace is a letter.
    if ((ch === '{' || ch === '}') && !hasWord && /^[\s;)]?$/.test(text[i + 1] ?? '')) {
      sep(ch)
      continue
    }
    if (ch === '&' || ch === '|') {
      // `&>` is a redirection, not a separator.
      if (ch === '&' && text[i + 1] === '>') {
        flush()
        word = '&'
        hasWord = true
        continue
      }
      const two = text.slice(i, i + 2)
      if (two === '&&' || two === '||' || two === '|&') {
        sep(two)
        i++
      } else {
        sep(ch)
      }
      continue
    }
    if (ch === '$') isExpanded = true
    word += ch
    hasWord = true
  }
  flush()
  return { tokens, isOpaque, expanded }
}

const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'builtin', 'then', 'do', 'else', 'if', 'while', 'until', 'xargs', 'watch', 'timeout', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** The basename of a command word: `/usr/bin/git` → `git`. */
export function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Takes wrappers and leading assignments off: `sudo env A=1 git push` → `git push`, `A=1` into `assigns`. */
function unwrap(words: string[], assigns: string[]): string[] {
  let rest = words
  for (;;) {
    const first = rest[0]
    if (first === undefined) return rest
    if (ASSIGN.test(first)) {
      assigns.push(first)
      rest = rest.slice(1)
      continue
    }
    const name = base(first)
    if (name === 'env') {
      rest = rest.slice(1)
      while (rest[0] !== undefined && (rest[0].startsWith('-') || rest[0].includes('='))) {
        if (ASSIGN.test(rest[0])) assigns.push(rest[0])
        rest = rest.slice(1)
      }
      continue
    }
    if (WRAPPERS.has(name)) {
      rest = rest.slice(1)
      // Their own flags (`timeout 10`, `nice -n 5`, `xargs -0`) come before the command.
      while (rest[0] !== undefined && (rest[0].startsWith('-') || /^\d+[smh]?$/.test(rest[0]))) rest = rest.slice(1)
      continue
    }
    return rest
  }
}

/** How deep `sh -c`, `eval`, `find -exec` and `git rebase -x` are read inside one another. */
const MAX_DEPTH = 3
/** find's actions that run a command: their words up to `;` (or `{} +`). */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

const empty = (): Reading => ({ commands: [], isOpaque: false, isTooDeep: false, expanded: new Set(), assigns: [] })

/** Adds what `from` read to `into`. */
function merge(into: Reading, from: Reading): void {
  into.commands.push(...from.commands)
  into.isOpaque = into.isOpaque || from.isOpaque
  into.isTooDeep = into.isTooDeep || from.isTooDeep
  for (const word of from.expanded) into.expanded.add(word)
  into.assigns.push(...from.assigns)
}

/** The commands one simple command runs: itself, or what its shell, eval, find -exec or rebase -x runs. */
function expand(words: readonly string[], depth: number): Reading {
  const out = empty()
  const simple = unwrap([...words], out.assigns)
  if (simple.length === 0) return out
  const name = base(simple[0] ?? '')
  // `-c`, or in a cluster: `bash -lc '…'`.
  const dashC = SHELLS.has(name) ? simple.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word)) : -1
  const script = dashC !== -1 ? (simple[dashC + 1] ?? '') : name === 'eval' ? simple.slice(1).join(' ') : undefined
  const inner = (read: () => Reading) => {
    if (depth < MAX_DEPTH) merge(out, read())
    else out.isTooDeep = true
  }
  if (script !== undefined) {
    if (depth >= MAX_DEPTH) out.commands.push(simple)
    inner(() => readCommand(script, depth + 1))
    return out
  }
  // find and git rebase stay commands of their own; what they run is read beside them.
  out.commands.push(simple)
  if (name === 'find') {
    for (let i = 1; i < simple.length; i++) {
      if (!FIND_EXEC.has(simple[i] ?? '')) continue
      let j = i + 1
      while (j < simple.length && simple[j] !== ';' && !(simple[j] === '+' && simple[j - 1] === '{}')) j++
      const action = simple.slice(i + 1, j)
      inner(() => expand(action, depth + 1))
      i = j
    }
  }
  const git = name === 'git' ? gitSub(simple) : null
  if (git?.sub === 'rebase') {
    git.rest.forEach((word, i) => {
      const exec = word === '-x' || word === '--exec' ? git.rest[i + 1] : word.startsWith('--exec=') ? word.slice(7) : /^-x./.test(word) ? word.slice(2) : undefined
      if (exec !== undefined) inner(() => readCommand(exec, depth + 1))
    })
  }
  return out
}

/** The commands an argv runs (a launcher's `uv run …`), read as one simple command of a Bash command is. */
export function readArgv(words: readonly string[]): Reading {
  return expand(words, 0)
}

/** The simple commands a Bash command runs, `sh -c '…'`, `eval '…'`, `find -exec` and `git rebase -x` read inside. */
export function readCommand(text: string, depth = 0): Reading {
  const { tokens, isOpaque, expanded } = lex(text)
  const out: Reading = { ...empty(), isOpaque, expanded }
  let current: string[] = []
  const end = () => {
    merge(out, expand(current, depth))
    current = []
  }
  for (const token of tokens) {
    if (token.isSep) end()
    else current.push(token.text)
  }
  end()
  return out
}

/** The words that are not options: `rm -rf a b` → `a b`. */
export function operands(simple: Simple): string[] {
  const out: string[] = []
  let isAfterDashes = false
  for (const word of simple.slice(1)) {
    if (!isAfterDashes && word === '--') {
      isAfterDashes = true
      continue
    }
    if (!isAfterDashes && word.startsWith('-')) continue
    // Redirections are not operands of the command.
    if (/^(\d*|&)[<>]/.test(word)) continue
    out.push(word)
  }
  return out
}

/** A redirection word: its operator and what follows it in the same word. */
const REDIRECT = /^(?:\d*|&)(>>|>\||>&|<<<|<<|<>|<&|>|<)(.*)$/s

/**
 * Every string a command's words can name a path with: each word itself, a
 * value after `=` (`--output=/p`, `of=/p`), a short option's attached value
 * (`-o/p`), and a redirection's target (`>>/p`; spaced, it is the next word).
 * `N>&M` names no file. It errs toward more: a pattern or a message is read
 * as a path too, which only ever refuses more.
 */
export function pathWords(simple: Simple): string[] {
  const out: string[] = []
  for (const word of simple.slice(1)) {
    const redirect = REDIRECT.exec(word)
    if (redirect !== null) {
      const target = redirect[2] ?? ''
      const isDup = (redirect[1] === '>&' || redirect[1] === '<&') && /^(\d+-?|-)?$/.test(target)
      if (target !== '' && !isDup) out.push(target)
      continue
    }
    out.push(word)
    const eq = word.indexOf('=')
    if (eq !== -1) out.push(word.slice(eq + 1))
    if (/^-[^-]/.test(word)) {
      out.push(word.slice(2))
      // A cluster, `-uo/p`: the value starts at its first path character.
      const at = word.slice(2).search(/[/~.$]/)
      if (at > 0) out.push(word.slice(2 + at))
    }
  }
  return out.filter(one => one !== '')
}

/** git's subcommand and its words, past the global options (`-C path`, `-c k=v`, `--git-dir=…`); hasConfig: a `-c` or `--config-env`. */
export function gitSub(simple: Simple): { sub: string; rest: string[]; dirs: string[]; hasConfig: boolean } | null {
  const dirs: string[] = []
  let hasConfig = false
  let i = 1
  while (i < simple.length) {
    const word = simple[i] ?? ''
    if (word === '-C' || word === '-c' || word === '--git-dir' || word === '--work-tree' || word === '--namespace' || word === '--config-env') {
      if (word === '-C' || word === '--git-dir' || word === '--work-tree') dirs.push(simple[i + 1] ?? '')
      if (word === '-c' || word === '--config-env') hasConfig = true
      i += 2
      continue
    }
    if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=')) {
      dirs.push(word.slice(word.indexOf('=') + 1))
      i++
      continue
    }
    if (word.startsWith('-')) {
      if (word.startsWith('--config-env=') || /^-c./.test(word)) hasConfig = true
      i++
      continue
    }
    return { sub: word, rest: simple.slice(i + 1), dirs, hasConfig }
  }
  return null
}
