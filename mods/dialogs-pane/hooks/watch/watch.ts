// The shared `tg watch PEER --jsonl` (README "tg watch (--jsonl)"): one child
// per peer, whoever listens (bot testing's live replies and timing, routing's
// pins, triage later). This is the pure half: the argv, and the lines as
// typed events. register.tsx owns the child and the subscribers.
import type { MessageView, Sender } from '../../types'
import { parseMessageView, parseSender, TgJsonError } from '../packet/types'
import { failureOf } from '../tg/tg'

/**
 * One event of the stream. `message` and `edit` carry the message as
 * `tg --json` prints it; `ready` ends the replay; `typing` and `delete` are
 * passed on for listeners that want them (triage), read leniently.
 */
export type WatchEvent =
  | { event: 'ready' }
  | { event: 'message' | 'edit'; message: MessageView }
  | { event: 'typing'; chatId: number; action: string; sender: Sender | null }
  | { event: 'delete'; chatId: number | null; ids: number[] }

/** A watch nobody stops still ends after this long with nothing printed. */
export const IDLE_EXIT = '15m'

/** Restarts in a row that never reached `ready` before the hub gives up. */
export const MAX_ATTEMPTS = 6
const FIRST_DELAY_MS = 2_000
const MAX_DELAY_MS = 60_000

/**
 * What the hub does once a child ended by itself (a stop the hub asked for
 * never gets here). Exit 1 (a lost connection) or a signal from outside
 * restarts with a doubling delay, capped; a flood wait restarts when it is
 * over. Exit 0 (`--idle-exit`, Ctrl-C) ends quietly; not logged in, a peer
 * not found, bad usage, or the attempt limit end as a failure.
 */
export type Ending = { kind: 'restart'; delayMs: number } | { kind: 'end'; how: 'quiet' | 'failed' }

export function restartPlan(code: number | null, signal: string | null, stderr: string, attempt: number): Ending {
  if (code === 0) return { kind: 'end', how: 'quiet' }
  if (attempt >= MAX_ATTEMPTS) return { kind: 'end', how: 'failed' }
  if (code === 1 || (code === null && signal !== null)) {
    return { kind: 'restart', delayMs: Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) }
  }
  const failure = failureOf(code ?? 1, stderr)
  return failure.kind === 'flood' ? { kind: 'restart', delayMs: failure.seconds * 1000 } : { kind: 'end', how: 'failed' }
}

/**
 * The child for what its subscribers need: every event kind; `--after` to
 * replay what a restart or a reload missed; `--idle-exit` only when every
 * subscriber is fine with a quiet watch ending (a pin is not).
 */
export function watchArgv(peerArg: string, options: { after: number | null; isBounded: boolean }): string[] {
  return [
    'tg',
    'watch',
    peerArg,
    '--jsonl',
    ...(options.after === null ? [] : ['--after', String(options.after)]),
    ...(options.isBounded ? ['--idle-exit', IDLE_EXIT] : []),
  ]
}

/**
 * Splits streamed watch output into whole lines: a chunk may end mid-line.
 * Returns the parsed events and the unfinished tail to prepend to the next chunk.
 */
export function watchLines(buffered: string, chunk: string): { events: WatchEvent[]; rest: string } {
  const lines = (buffered + chunk).split('\n')
  const rest = lines.pop() ?? ''
  const events = lines.flatMap(line => {
    const one = watchEvent(line)
    return one === null ? [] : [one]
  })
  return { events, rest }
}

type Obj = Record<string, unknown>

/** One `--jsonl` line; null for a kind tg may add later or a line that cannot be read. */
export function watchEvent(line: string): WatchEvent | null {
  if (line.trim() === '') return null
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    // Under --jsonl tg prints only JSON; anything else (a warning) is not an event.
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const o = data as Obj // a non-null, non-array object, checked above
  switch (o.event) {
    case 'ready':
      return { event: 'ready' }
    case 'message':
    case 'edit':
      try {
        return { event: o.event, message: parseMessageView(o) }
      } catch (error) {
        // A line whose message shape is off is skipped; the next thread reload shows it.
        if (error instanceof TgJsonError) return null
        throw error
      }
    case 'typing':
      return typeof o.chat_id === 'number' && typeof o.action === 'string'
        ? { event: 'typing', chatId: o.chat_id, action: o.action, sender: senderOf(o.sender) }
        : null
    case 'delete': {
      const ids = Array.isArray(o.ids) ? o.ids.filter((id): id is number => typeof id === 'number') : []
      return { event: 'delete', chatId: typeof o.chat_id === 'number' ? o.chat_id : null, ids }
    }
    default:
      return null
  }
}

function senderOf(v: unknown): Sender | null {
  try {
    return parseSender(v)
  } catch (error) {
    if (error instanceof TgJsonError) return null
    throw error
  }
}
