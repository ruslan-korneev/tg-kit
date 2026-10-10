// The `tg …` command that reproduces a message: what you sent that made the bot answer.

import type { Redactor } from './redact'
import type { MessageView, Peer } from './types'

export type ReplayOptions = {
  /** `--wait` for the answer, in seconds. */
  waitSeconds?: number
  /** Masks the peer and the text the same way the packet around the command is masked. */
  redactor?: Redactor
}

const DEFAULT_WAIT_SECONDS = 10

/** How tg names the peer on a command line (README → Peer specs). */
export function peerSpec(peer: Peer, redactor?: Redactor): string {
  if (peer.kind === 'self') return 'me'
  if (peer.username) return redactor ? redactor.username(`@${peer.username}`) : `@${peer.username}`
  return redactor ? redactor.id(peer.id) : String(peer.id)
}

/** POSIX single quotes, unless the word is plainly safe. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * The message you sent that `target` answers: `target` itself when you sent it, else the
 * outgoing message it replies to, else the last one you sent before it.
 */
export function findTrigger(target: MessageView, history: readonly MessageView[]): MessageView | null {
  if (target.out) return target
  const sent = history.filter(m => m.out && m.chat_id === target.chat_id && m.id < target.id)
  return sent.find(m => m.id === target.reply_to) ?? sent.reduce<MessageView | null>((a, m) => (a === null || m.id > a.id ? m : a), null)
}

/**
 * The replay command, or null when there is nothing replayable: no message of yours before
 * it, or the trigger carries media or is a service message (the file is not in the record).
 */
export function buildReplay(
  target: MessageView,
  history: readonly MessageView[],
  peer: Peer,
  options: ReplayOptions = {},
): string | null {
  const trigger = findTrigger(target, history)
  if (trigger === null || trigger.media !== null || trigger.service !== null || trigger.text === '') return null

  const r = options.redactor
  const spec = shellQuote(peerSpec(peer, r))
  const text = r ? r.text(trigger.text) : trigger.text
  const expectsAnswer = !target.out || peer.kind === 'bot'
  const wait = expectsAnswer ? ` --wait ${options.waitSeconds ?? DEFAULT_WAIT_SECONDS}s` : ''

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text)
  if (start && peer.kind === 'bot') {
    const payload = start[1] === undefined ? '' : ` ${shellQuote(start[1])}`
    return `tg start ${spec}${payload}${wait}`
  }

  const replyTo = trigger.reply_to === null ? '' : ` --reply-to ${trigger.reply_to}`
  // `tg send` parses Markdown by default; the record holds the text as it arrived.
  const plain = /[*_`~|[\]]/.test(trigger.text) ? ' --plain' : ''
  // A leading dash would read as an option; stdin carries such text verbatim.
  if (text.startsWith('-')) {
    return `printf '%s' ${shellQuote(text)} | tg send ${spec} -${replyTo}${plain}${wait}`
  }
  return `tg send ${spec} ${shellQuote(text)}${replyTo}${plain}${wait}`
}
