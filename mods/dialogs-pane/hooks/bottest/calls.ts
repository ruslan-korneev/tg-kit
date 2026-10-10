// The tg calls bot testing makes: argv, and how each run's output is narrowed.
// Pure: register.tsx runs the argv through $.process.run / $.process.spawn.
// Shapes: README "JSON (--json)" (send, press) and "tg watch (--jsonl)".
import type { ProcessRunResult } from 'claude-code'

import type { TgFailure } from '../../types'
import { TgJsonError, parseMessageView, parseMessageViews, type MessageView } from '../packet/types'
import { failureOf } from '../tg/tg'

/** `press` waits 5 s (tg's own default); a send waits longer for a cold bot. */
export const PRESS_WAIT_S = 5
export const SEND_WAIT_S = 10

const EXIT_NO_REPLY = 6
const EXIT_REFUSED = 7

/** A write tg ran: what it sent, what came back, and the callback answer. */
export type WriteResult =
  | { ok: true; noReply: boolean; exit: number; sent: MessageView[]; replies: MessageView[]; answer: string | null }
  | { ok: false; failure: TgFailure; isRefused: boolean }

type Ran = Pick<ProcessRunResult, 'exitCode' | 'stdout' | 'stderr'> | undefined

export const calls = {
  press: (peer: string, id: number, row: number, col: number): string[] => [
    'tg', 'press', peer, String(id), '--row', String(row), '--col', String(col), '--wait', `${PRESS_WAIT_S}s`, '--json',
  ],
  /** The text goes on stdin (`-`), so a leading dash or newline needs no escaping. `--plain`: sent as typed. */
  send: (peer: string): string[] => ['tg', 'send', peer, '-', '--plain', '--wait', `${SEND_WAIT_S}s`, '--json'],
  allowList: (): string[] => ['tg', 'allow', 'list', '--json'],
  /** Live only (no replay); `--idle-exit` bounds a watch nobody stops. */
  watch: (peer: string): string[] => ['tg', 'watch', peer, '--jsonl', '--events', 'message,edit', '--idle-exit', '15m'],
}

/** A finished `tg send|press --json`; exit 6 (no reply) still printed what was sent. */
export function settleWrite(ran: Ran): WriteResult {
  if (ran === undefined) return { ok: false, failure: { kind: 'missing' }, isRefused: false }
  if (ran.exitCode !== 0 && ran.exitCode !== EXIT_NO_REPLY) {
    return { ok: false, failure: failureOf(ran.exitCode, ran.stderr), isRefused: ran.exitCode === EXIT_REFUSED }
  }
  let doc: unknown
  try {
    doc = JSON.parse(ran.stdout)
  } catch {
    return shapeFailure('tg printed something other than JSON')
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return shapeFailure('tg JSON has an unexpected shape')
  const fields = doc as Record<string, unknown> // a non-null, non-array object, checked above
  try {
    const sent = fields.sent === undefined ? [] : parseMessageViews(fields.sent)
    const replies = fields.replies === undefined ? [] : parseMessageViews(fields.replies)
    return { ok: true, noReply: ran.exitCode === EXIT_NO_REPLY, exit: ran.exitCode, sent, replies, answer: answerText(fields.answer) }
  } catch (error) {
    if (error instanceof TgJsonError) return shapeFailure(error.message)
    throw error
  }
}

function shapeFailure(message: string): WriteResult {
  return { ok: false, failure: { kind: 'error', message }, isRefused: false }
}

/** press's `answer`: `{alert, toast, url}` or null; the URL is shown, never opened. */
function answerText(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const fields = answer as Record<string, unknown> // a non-null object, checked above
  const parts = (['alert', 'toast', 'url'] as const).flatMap(key => {
    const value = fields[key]
    return typeof value === 'string' && value !== '' ? [`${key}: ${value}`] : []
  })
  return parts.length === 0 ? null : parts.join(' · ')
}

/** `tg allow list --json`: the allowlisted ids, or undefined for any other shape. */
export function decodeAllow(data: unknown): number[] | undefined {
  if (!Array.isArray(data)) return undefined
  const ids: number[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const id: unknown = (entry as Record<string, unknown>).id // a non-null object, checked above
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return undefined
    ids.push(id)
  }
  return ids
}

export type WatchEvent =
  | { event: 'ready' }
  | { event: 'message' | 'edit'; message: MessageView }

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

/** One `--jsonl` line; null for a kind this pane does not use or a line it cannot read. */
export function watchEvent(line: string): WatchEvent | null {
  if (line.trim() === '') return null
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const kind = (data as Record<string, unknown>).event // a non-null object, checked above
  if (kind === 'ready') return { event: 'ready' }
  if (kind !== 'message' && kind !== 'edit') return null
  try {
    return { event: kind, message: parseMessageView(data) }
  } catch (error) {
    // A line whose message shape is off is skipped; the next thread reload shows it.
    if (error instanceof TgJsonError) return null
    throw error
  }
}

/** The thread with `incoming` folded in: an edit replaces its message, a new one joins in id order. */
export function mergeMessages<T extends { id: number }>(thread: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(thread.map(one => [one.id, one]))
  for (const one of incoming) byId.set(one.id, one)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}
