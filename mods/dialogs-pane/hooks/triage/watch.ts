// `tg watch PEER --jsonl` as the pane runs it: the argv, the line splitter, the
// event parser and when to restart. One child per dialog, because `--after ID`
// takes one PEER (channel ids are per channel). Contract: README
// "tg watch (--jsonl)". No `$` here; register.tsx spawns and reads.
import type { PeerRef, TgFailure, TgPeerKind } from '../../types'
import { parseMessageView, type MessageView } from '../packet/types'
import { failureOf } from '../tg/tg'

/** Typing is left out: nothing in the pane draws it yet. */
const EVENTS = 'message,edit,delete'

/** Each watch is one connection to Telegram; past this many, `w` asks to unwatch one first. */
export const MAX_WATCHED = 8

/** Restarts in a row that never reached `ready` before the watch gives up. */
export const MAX_ATTEMPTS = 6
const FIRST_DELAY_MS = 2_000
const MAX_DELAY_MS = 60_000

/** `--after` replays what a restart missed; absent, the watch starts live. */
export function watchArgv(peer: string, after: number | null): string[] {
  const argv = ['tg', 'watch', peer, '--jsonl', '--events', EVENTS]
  return after === null ? argv : [...argv, '--after', String(after)]
}

export type WatchEvent =
  | { kind: 'message' | 'edit'; message: MessageView }
  | { kind: 'delete'; ids: number[] }
  | { kind: 'ready' }

/** Splits stdout pieces into whole lines; a piece may end mid-line. */
export function splitLines(pending: string, text: string): { lines: string[]; rest: string } {
  const parts = (pending + text).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

/** One JSONL line, checked; undefined for a kind the pane does not read (typing) or a bad line. */
export function parseWatchLine(line: string): WatchEvent | undefined {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    // A torn or non-JSON line: tg prints JSON only, so skip it rather than stop the watch.
    return undefined
  }
  if (typeof data !== 'object' || data === null || !('event' in data)) return undefined
  switch (data.event) {
    case 'ready':
      return { kind: 'ready' }
    case 'message':
    case 'edit':
      try {
        return { kind: data.event, message: parseMessageView(data) }
      } catch {
        // A message whose shape drifted from render.py: skipped, the next one still counts.
        return undefined
      }
    case 'delete': {
      const ids = 'ids' in data && Array.isArray(data.ids) ? data.ids.filter(id => Number.isSafeInteger(id)) : []
      return ids.length === 0 ? undefined : { kind: 'delete', ids }
    }
    default:
      return undefined
  }
}

export type Ending = { kind: 'restart'; delayMs: number } | { kind: 'stop'; failure: TgFailure }

/**
 * What to do once a watch child ended on its own. Exit 1 (a lost connection)
 * restarts with a doubling delay, capped; a flood wait restarts when it is
 * over; anything else (not logged in, peer gone, tg missing) stops, as does
 * the attempt limit. `code` null: the child never started.
 */
export function ending(code: number | null, stderr: string, attempt: number): Ending {
  if (code === null) return { kind: 'stop', failure: { kind: 'missing' } }
  // 0 is a stop from outside (SIGTERM, Ctrl-C): someone meant it to end.
  if (code === 0) return { kind: 'stop', failure: { kind: 'error', message: 'tg watch was stopped' } }
  const failure = failureOf(code, stderr)
  if (attempt >= MAX_ATTEMPTS) return { kind: 'stop', failure }
  if (code === 1) return { kind: 'restart', delayMs: Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) }
  if (failure.kind === 'flood') return { kind: 'restart', delayMs: failure.seconds * 1000 }
  return { kind: 'stop', failure }
}

const KINDS: readonly TgPeerKind[] = ['self', 'user', 'bot', 'group', 'channel', 'supergroup', 'unknown']

/** Watched dialogs read back from $.store, each entry checked. */
export function parseWatched(stored: unknown): PeerRef[] {
  if (!Array.isArray(stored)) return []
  return stored
    .flatMap((v: unknown): PeerRef[] => {
      if (typeof v !== 'object' || v === null) return []
      const o: Record<string, unknown> = { ...v }
      const kind = KINDS.find(one => one === o.kind)
      if (!Number.isSafeInteger(o.id) || typeof o.id !== 'number') return []
      if (typeof o.arg !== 'string' || typeof o.label !== 'string' || kind === undefined) return []
      return [{ id: o.id, arg: o.arg, label: o.label, kind }]
    })
    .slice(0, MAX_WATCHED)
}
