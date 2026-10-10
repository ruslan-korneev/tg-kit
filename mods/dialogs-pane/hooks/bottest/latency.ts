// Latency stamps (docs/design/dialogs-pane.md §5 idea 10): `⏱1.4s` on bot replies,
// measured from the trigger. Pure.
//
// Two sources. While `tg watch` runs, each event is stamped with the local clock as
// its line arrives, so a reply is timed against your message (or your press) to the
// tenth of a second. Otherwise the stamp is the difference of Telegram's message
// dates, which have whole-second resolution, so it is drawn in whole seconds.
import type { Timing } from '../../types'
import { findTrigger } from '../packet/replay'
import type { MessageView } from '../packet/types'

/** Above this a stamp is drawn in the `warn` token (design §4). */
export const SLOW_MS = 3000

export const NO_TIMING: Timing = { watch: 'off', lastOut: null, lastPress: null, measured: {}, pressedAt: {} }

export type Stamp = { ms: number; isPrecise: boolean; text: string; isSlow: boolean }

function isBotReply(message: Pick<MessageView, 'out' | 'sender'>): boolean {
  return !message.out && message.sender.kind === 'bot'
}

/**
 * Folds one watched event, stamped `at` (local ms), into the timing. Your message
 * starts a clock; a bot message is timed from the later of your last message and
 * your last press; a bot edit only when it is the first edit of the message you
 * pressed (an edit answers a button; a later one, or another message's, does not).
 */
export function observe(timing: Timing, kind: 'message' | 'edit', message: MessageView, at: number): Timing {
  if (message.out) return kind === 'message' ? { ...timing, lastOut: { at } } : timing
  if (!isBotReply(message)) return timing
  const press = timing.lastPress
  if (kind === 'edit') {
    if (press === null || press.messageId !== message.id || press.at > at) return timing
    return {
      ...timing,
      lastPress: { at: press.at, messageId: null },
      measured: { ...timing.measured, [String(message.id)]: at - press.at },
    }
  }
  const from = Math.max(...[timing.lastOut?.at ?? null, press?.at ?? null].filter((one): one is number => one !== null && one <= at))
  if (!Number.isFinite(from)) return timing
  return { ...timing, measured: { ...timing.measured, [String(message.id)]: at - from } }
}

/**
 * A send from the pane's box, `at` its local start: bot messages after it are
 * timed from here, as from your message the watch shows. The watch may never
 * show it (a fake tg's does not), and then only the dates were left.
 */
export function sent(timing: Timing, at: number): Timing {
  return { ...timing, lastOut: { at } }
}

/** A press from the pane on `messageId`: later watch events time from it; `brought` came back with it. */
export function pressed(timing: Timing, at: number, messageId: number, brought: readonly number[]): Timing {
  const marks = Object.fromEntries(brought.map(id => [String(id), at]))
  // The press result can land after the watch timed the edit: keep a consumed press consumed.
  const lastPress = timing.lastPress?.at === at ? timing.lastPress : { at, messageId }
  return { ...timing, lastPress, pressedAt: { ...timing.pressedAt, ...marks } }
}

/** The stamp for one message of the open thread, or null when it is not a timed bot reply. */
export function stampFor(message: MessageView, history: readonly MessageView[], timing: Timing): Stamp | null {
  if (!isBotReply(message)) return null
  const measured = timing.measured[String(message.id)]
  if (measured !== undefined) return stamp(measured, true)
  const pressAt = timing.pressedAt[String(message.id)]
  if (pressAt !== undefined) {
    // Telegram dates are whole seconds: compare against the press's second.
    const ms = Date.parse(message.edited ?? message.date) - Math.floor(pressAt / 1000) * 1000
    return Number.isFinite(ms) ? stamp(Math.max(0, ms), false) : null
  }
  const trigger = findTrigger(message, history)
  if (trigger === null) return null
  const ms = Date.parse(message.date) - Date.parse(trigger.date)
  return Number.isFinite(ms) && ms >= 0 ? stamp(ms, false) : null
}

function stamp(ms: number, isPrecise: boolean): Stamp {
  return { ms, isPrecise, text: `⏱${latencyText(ms, isPrecise)}`, isSlow: ms > SLOW_MS }
}

/** `1.4s` measured, `2s` from dates, `12s`, `3m`, `2h`. */
export function latencyText(ms: number, isPrecise: boolean): string {
  const s = ms / 1000
  if (s < 10 && isPrecise) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}
