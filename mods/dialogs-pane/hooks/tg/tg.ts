// The tg adapter: which `tg … --json` call to make, and how its output becomes
// a typed result. Every value is narrowed here from `unknown`; every failure
// is a TgFailure, never a throw. The hooks module runs the argv through
// $.process.run (`$` never crosses an import) and hands the run to `settle`.
import type { ProcessRunResult } from 'claude-code'

import type { Folder, FolderPass, TgDialog, TgFailure, TgMessage } from '../../types'
import { TgJsonError, parseDialogs, parseFolderPass, parseFolders, parseMessageViews } from '../packet/types'

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

const request = <T>(args: readonly string[], decode: (data: unknown) => T | undefined): TgRequest<T> => ({
  argv: ['tg', ...args, '--json'],
  decode,
})

export const tg = {
  /** The latest chats; `query` searches every chat's title and @name, `isArchived` lists the Archive. */
  dialogs: (options: { limit?: number; query?: string; isArchived?: boolean } = {}): TgRequest<TgDialog[]> =>
    request(
      [
        'dialogs',
        '--limit',
        String(options.limit ?? 50),
        ...(options.query === undefined ? [] : ['--query', options.query]),
        ...(options.isArchived === true ? ['--archived'] : []),
      ],
      checked(parseDialogs),
    ),

  /** The owner's folders in Telegram's order, without counts: what the strip paints first (§4.7). */
  folders: (): TgRequest<Folder[]> => request(['folders'], checked(parseFolders)),

  /** The pass (§8 T8b): every folder's chats and every chat's row, in one call. */
  pass: (): TgRequest<FolderPass> => request(['folders', '--chats'], checked(parseFolderPass)),

  /** The last `limit` messages of a chat, oldest first. */
  read: (peer: string, options: { limit?: number } = {}): TgRequest<TgMessage[]> =>
    request(['read', peer, '--limit', String(options.limit ?? 30), '--reverse'], checked(parseMessageViews)),

  /** Whole messages by id (`tg msg` never cuts the text). */
  msg: (peer: string, ids: readonly number[]): TgRequest<TgMessage[]> => ({
    ...request(['msg', peer, ...ids.map(String)], checked(parseMessageViews)),
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

/**
 * tg's reason: its `error:` line. A refusal prints the plan before it
 * (`refused; nothing was sent. The plan was:` and the plan's JSON), so the
 * first line alone would hide the guard's reason (§7.4: `readonly = true`).
 */
function firstLine(stderr: string): string {
  const lines = stderr.split('\n')
  const line = lines.find(one => one.startsWith('error:')) ?? lines.find(one => one.trim() !== '') ?? ''
  return line.replace(/^error:\s*/, '').trim() || 'tg failed'
}

/** Runs a strict parser (hooks/packet/types.ts); a shape it refuses is `undefined`. */
function checked<T>(parse: (data: unknown) => T): (data: unknown) => T | undefined {
  return data => {
    try {
      return parse(data)
    } catch (error) {
      if (error instanceof TgJsonError) return undefined
      throw error
    }
  }
}
