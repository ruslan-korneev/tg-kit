// A small reading of a Bash command for the Worker's grant and hard stops:
// the simple commands it runs, each as words, with wrappers (sudo, env, xargs,
// sh -c …) taken off. Not a shell: it errs toward finding more commands, and
// says when it met something it cannot follow (substitutions, here-docs), so
// the grant can refuse what it cannot read. Pure.

/** One simple command: its words, quotes removed. */
export type Simple = readonly string[]

export type Reading = { commands: Simple[]; isOpaque: boolean }

const SEPARATORS = new Set([';', '&', '&&', '||', '|', '|&', '\n', '(', ')', '{', '}', '!'])

/** Splits into words and separators; `$(`, backticks and here-docs mark the reading opaque. */
function lex(text: string): { words: string[]; isOpaque: boolean } {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let isOpaque = false
  const flush = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
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
      flush()
      words.push(';')
      if (ch === '$') i++
      continue
    }
    if (ch === '<' && text[i + 1] === '<') isOpaque = true
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      flush()
      words.push(ch === '\n' ? '\n' : ch)
      continue
    }
    if (ch === '&' || ch === '|') {
      // `2>&1` and `&>` are redirections, not separators.
      if (ch === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) {
        word += ch
        hasWord = true
        continue
      }
      flush()
      const two = text.slice(i, i + 2)
      if (two === '&&' || two === '||' || two === '|&') {
        words.push(two)
        i++
      } else {
        words.push(ch)
      }
      continue
    }
    word += ch
    hasWord = true
  }
  flush()
  return { words, isOpaque }
}

const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'builtin', 'then', 'do', 'else', 'if', 'while', 'until', 'xargs', 'watch', 'timeout', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** The basename of a command word: `/usr/bin/git` → `git`. */
export function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/** Takes wrappers and leading assignments off: `sudo env A=1 git push` → `git push`. */
function unwrap(words: string[]): string[] {
  let rest = words
  for (;;) {
    const first = rest[0]
    if (first === undefined) return rest
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      rest = rest.slice(1)
      continue
    }
    const name = base(first)
    if (name === 'env') {
      rest = rest.slice(1)
      while (rest[0] !== undefined && (rest[0].startsWith('-') || rest[0].includes('='))) rest = rest.slice(1)
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

/** The simple commands a Bash command runs, `sh -c '…'` and `eval '…'` read inside. */
export function readCommand(text: string, depth = 0): Reading {
  const { words, isOpaque } = lex(text)
  const commands: Simple[] = []
  let opaque = isOpaque
  let current: string[] = []
  const end = () => {
    const simple = unwrap(current)
    current = []
    if (simple.length === 0) return
    const name = base(simple[0] ?? '')
    const script = SHELLS.has(name) ? simple[simple.indexOf('-c') + 1] : name === 'eval' ? simple.slice(1).join(' ') : undefined
    if (script !== undefined && (name === 'eval' || simple.includes('-c')) && depth < 3) {
      const inner = readCommand(script, depth + 1)
      commands.push(...inner.commands)
      opaque = opaque || inner.isOpaque
      return
    }
    commands.push(simple)
  }
  for (const word of words) {
    if (SEPARATORS.has(word)) end()
    else current.push(word)
  }
  end()
  return { commands, isOpaque: opaque }
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
    if (/^\d*[<>]/.test(word)) continue
    out.push(word)
  }
  return out
}

/** git's subcommand and its words, past the global options (`-C path`, `-c k=v`, `--git-dir=…`). */
export function gitSub(simple: Simple): { sub: string; rest: string[]; dirs: string[] } | null {
  const dirs: string[] = []
  let i = 1
  while (i < simple.length) {
    const word = simple[i] ?? ''
    if (word === '-C' || word === '-c' || word === '--git-dir' || word === '--work-tree' || word === '--namespace') {
      if (word === '-C' || word === '--git-dir' || word === '--work-tree') dirs.push(simple[i + 1] ?? '')
      i += 2
      continue
    }
    if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=')) {
      dirs.push(word.slice(word.indexOf('=') + 1))
      i++
      continue
    }
    if (word.startsWith('-')) {
      i++
      continue
    }
    return { sub: word, rest: simple.slice(i + 1), dirs }
  }
  return null
}
