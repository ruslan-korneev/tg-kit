// The tg adapter: which `tg … --json` call to make, and how its output becomes
// a typed result. Every value is narrowed here from `unknown`; every failure
// is a TgFailure, never a throw. The hooks module runs the argv through
// $.process.run (`$` never crosses an import) and hands the run to `settle`.
import type { ProcessRunResult } from 'claude-code'

import type {
  TgButton,
  TgDialog,
  TgFailure,
  TgMedia,
  TgMessage,
  TgPeerKind,
  TgSender,
} from '../../types'

/** `partial` is set when tg found only some of what was asked (`tg msg`, exit 4). */
export type TgResult<T> = { ok: true; value: T; partial?: string } | { ok: false; failure: TgFailure }

/**
 * One tg call: the argv to run and how its `--json` stdout is narrowed.
 * `isPartialOnNotFound`: exit 4 still printed what was found (`tg msg`).
 */
export type TgRequest<T> = {
  argv: readonly string[]
  decode: (data: unknown) => T | undefined
  isPartialOnNotFound?: true
}

/** What the caller hands `settle`: the finished run, or nothing when tg did not start. */
type Ran = Pick<ProcessRunResult, 'exitCode' | 'stdout' | 'stderr'> | undefined

// errors.py pins one exit code per failure kind.
const EXIT_AUTH = 3
const EXIT_NOT_FOUND = 4
const EXIT_FLOOD = 5

/** tg's own default timeout is 30 s; leave it room to report its own. */
export const TG_TIMEOUT_MS = 45_000

const PEER_KINDS = [
  'self',
  'user',
  'bot',
  'group',
  'channel',
  'supergroup',
  'unknown',
] as const satisfies readonly TgPeerKind[]

const request = <T>(args: readonly string[], decode: (data: unknown) => T | undefined): TgRequest<T> => ({
  argv: ['tg', ...args, '--json'],
  decode,
})

export const tg = {
  dialogs: (options: { limit?: number } = {}): TgRequest<TgDialog[]> =>
    request(['dialogs', '--limit', String(options.limit ?? 50)], listOf(asDialog)),

  /** The last `limit` messages of a chat, oldest first. */
  read: (peer: string, options: { limit?: number } = {}): TgRequest<TgMessage[]> =>
    request(['read', peer, '--limit', String(options.limit ?? 30), '--reverse'], listOf(asMessage)),

  /** Whole messages by id (`tg msg` never cuts the text). */
  msg: (peer: string, ids: readonly number[]): TgRequest<TgMessage[]> => ({
    ...request(['msg', peer, ...ids.map(String)], listOf(asMessage)),
    isPartialOnNotFound: true,
  }),
}

/**
 * Turns a finished run into a result. `undefined` is a run that never
 * finished: tg is not on PATH, or it outlived the timeout.
 */
export function settle<T>(req: TgRequest<T>, ran: Ran): TgResult<T> {
  if (ran === undefined) return { ok: false, failure: { kind: 'missing' } }
  const isPartial = ran.exitCode === EXIT_NOT_FOUND && req.isPartialOnNotFound === true
  if (ran.exitCode !== 0 && !isPartial) return { ok: false, failure: failureOf(ran.exitCode, ran.stderr) }
  let data: unknown
  try {
    data = JSON.parse(ran.stdout)
  } catch {
    return { ok: false, failure: { kind: 'error', message: 'tg printed something other than JSON' } }
  }
  const value = req.decode(data)
  if (value === undefined) {
    return { ok: false, failure: { kind: 'error', message: 'tg JSON has an unexpected shape' } }
  }
  return isPartial ? { ok: true, value, partial: firstLine(ran.stderr) } : { ok: true, value }
}

/** Maps tg's exit code and stderr (`error: …` then `  fix: …`) to a failure. */
export function failureOf(exitCode: number, stderr: string): TgFailure {
  const message = firstLine(stderr)
  switch (exitCode) {
    case EXIT_AUTH:
      return { kind: 'auth' }
    case EXIT_FLOOD: {
      const seconds = Number(/FLOOD_WAIT (\d+)s/.exec(stderr)?.[1])
      return { kind: 'flood', seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 30 }
    }
    case EXIT_NOT_FOUND:
      return { kind: 'not-found', message }
    default:
      return { kind: 'error', message }
  }
}

function firstLine(stderr: string): string {
  const line = stderr.split('\n').find(one => one.trim() !== '') ?? ''
  return line.replace(/^error:\s*/, '').trim() || 'tg failed'
}

// --- narrowing tg's JSON (README "JSON (--json)", render.py message_json) ---

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null)
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)

function kindOf(v: unknown): TgPeerKind {
  return PEER_KINDS.find(kind => kind === v) ?? 'unknown'
}

function listOf<T>(item: (v: unknown) => T | undefined): (data: unknown) => T[] | undefined {
  return data => {
    if (!Array.isArray(data)) return undefined
    const out: T[] = []
    for (const one of data) {
      const parsed = item(one)
      if (parsed === undefined) return undefined
      out.push(parsed)
    }
    return out
  }
}

export function asDialog(v: unknown): TgDialog | undefined {
  if (!isObj(v) || !isNum(v.id) || !isStr(v.title)) return undefined
  return {
    id: v.id,
    kind: kindOf(v.kind),
    title: v.title,
    username: strOrNull(v.username),
    unread: isNum(v.unread) ? v.unread : 0,
    last_id: numOrNull(v.last_id),
    last_date: strOrNull(v.last_date),
    last_text: isStr(v.last_text) ? v.last_text : '',
  }
}

function asSender(v: unknown): TgSender {
  if (!isObj(v)) return { id: null, kind: 'unknown', username: null, name: '' }
  return {
    id: numOrNull(v.id),
    kind: kindOf(v.kind),
    username: strOrNull(v.username),
    name: isStr(v.name) ? v.name : '',
  }
}

function asButton(v: unknown): TgButton | undefined {
  if (!isObj(v) || !isNum(v.row) || !isNum(v.col) || !isStr(v.text)) return undefined
  return {
    row: v.row,
    col: v.col,
    type: isStr(v.type) ? v.type : 'unknown',
    text: v.text,
    ...(isStr(v.data_b64) && { data_b64: v.data_b64 }),
    ...(isStr(v.url) && { url: v.url }),
  }
}

function asMedia(v: unknown): TgMedia | null {
  if (!isObj(v) || !isStr(v.type)) return null
  const media: TgMedia = { type: v.type }
  for (const key of ['size', 'duration', 'width', 'height'] as const) {
    const value = v[key]
    if (isNum(value)) media[key] = value
  }
  for (const key of ['name', 'mime', 'emoji', 'title', 'url'] as const) {
    const value = v[key]
    if (isStr(value)) media[key] = value
  }
  return media
}

export function asMessage(v: unknown): TgMessage | undefined {
  if (!isObj(v) || !isNum(v.id) || !isNum(v.chat_id) || !isStr(v.date)) return undefined
  const rows = Array.isArray(v.buttons) ? v.buttons : []
  const buttons = rows.map(row =>
    (Array.isArray(row) ? row : []).flatMap(one => asButton(one) ?? []),
  )
  const forward = isObj(v.forward)
    ? {
        from_id: numOrNull(v.forward.from_id),
        from_name: strOrNull(v.forward.from_name),
        date: strOrNull(v.forward.date),
      }
    : null
  return {
    id: v.id,
    chat_id: v.chat_id,
    date: v.date,
    sender: asSender(v.sender),
    out: v.out === true,
    text: isStr(v.text) ? v.text : '',
    reply_to: numOrNull(v.reply_to),
    forward,
    edited: strOrNull(v.edited),
    edits: isNum(v.edits) ? v.edits : 0,
    pinned: v.pinned === true,
    service: strOrNull(v.service),
    via_bot: strOrNull(v.via_bot),
    media: asMedia(v.media),
    keyboard: v.keyboard === 'inline' || v.keyboard === 'reply' ? v.keyboard : null,
    buttons: buttons.filter(row => row.length > 0),
    reactions: (Array.isArray(v.reactions) ? v.reactions : []).flatMap(one =>
      isObj(one) && isStr(one.emoji) && isNum(one.count) ? [{ emoji: one.emoji, count: one.count }] : [],
    ),
    links: (Array.isArray(v.links) ? v.links : []).flatMap(one =>
      isObj(one) && isStr(one.text) && isStr(one.url) ? [{ text: one.text, url: one.url }] : [],
    ),
    ...(isStr(v.chat_title) && { chat_title: v.chat_title }),
  }
}
