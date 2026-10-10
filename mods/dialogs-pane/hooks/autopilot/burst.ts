// Bursts and the check before sending (docs/design/dialogs-pane.md §6 "Check
// before sending"): when a burst is answered, how typing holds it, what the
// Speaker's check choice comes to, and whether a reply may go out by itself.
// Pure: register.tsx owns the timers, the tg calls and the model calls.
import type { ApCheck, ApDialog, ApEntry, ApTopic } from '../../types'
import type { MessageView } from '../packet/types'
import { TOPIC_LABEL, isQuiet, rateText } from './config'

/** Telegram repeats `typing` about every 5 s and drops it after about 6 s without one (README "tg watch"). */
export const TYPING_LAPSE_MS = 6_000
/** The longest a reply waits for the other side to stop typing. */
export const TYPING_HOLD_MS = 60_000
/** A burst is written again at most this many times; then the last version goes out, or becomes a draft. */
export const MAX_REGENERATIONS = 3

/** The incoming messages not answered yet, and what holds them back. */
export type Burst = {
  messages: MessageView[]
  /** Local ms of the newest incoming message. */
  lastAt: number
  /** The other side typing: since when without a break, and when that lapses. */
  typing: { since: number; until: number } | null
  regenerations: number
}

export const NO_BURST: Burst = { messages: [], lastAt: 0, typing: null, regenerations: 0 }

/** A new incoming message joins the burst and ends the typing. */
export function onIncoming(burst: Burst, message: MessageView, at: number): Burst {
  if (burst.messages.some(one => one.id === message.id)) return burst
  return { ...burst, messages: [...burst.messages, message].sort((a, b) => a.id - b.id), lastAt: at, typing: null }
}

/** An edit replaces its message while the burst still holds it; an answered message's edit is not a new question. */
export function onEdited(burst: Burst, message: MessageView): Burst {
  if (!burst.messages.some(one => one.id === message.id)) return burst
  return { ...burst, messages: burst.messages.map(one => (one.id === message.id ? message : one)) }
}

/** Deleted messages leave the burst: nothing to answer there any more. */
export function onDeleted(burst: Burst, ids: readonly number[]): Burst {
  const messages = burst.messages.filter(one => !ids.includes(one.id))
  return messages.length === burst.messages.length ? burst : { ...burst, messages, regenerations: messages.length === 0 ? 0 : burst.regenerations }
}

/** A typing event: `cancel` ends it; anything else keeps it alive for TYPING_LAPSE_MS. */
export function onTyping(burst: Burst, action: string, at: number): Burst {
  if (action === 'cancel') return { ...burst, typing: null }
  const isOngoing = burst.typing !== null && burst.typing.until > at
  return { ...burst, typing: { since: isOngoing && burst.typing !== null ? burst.typing.since : at, until: at + TYPING_LAPSE_MS } }
}

export type Wake = { kind: 'idle' } | { kind: 'wait'; at: number; why: 'gap' | 'typing' } | { kind: 'go' }

/**
 * When the burst is answered: once the gap after its newest message passed,
 * and the other side is not typing; a typing hold lasts at most TYPING_HOLD_MS
 * from the later of the gap's end and the start of the typing.
 */
export function wakeAt(burst: Burst, gapMs: number, now: number): Wake {
  if (burst.messages.length === 0) return { kind: 'idle' }
  const gapEnd = burst.lastAt + gapMs
  if (now < gapEnd) return { kind: 'wait', at: gapEnd, why: 'gap' }
  const typing = burst.typing
  if (typing === null || typing.until <= now) return { kind: 'go' }
  const holdEnd = Math.max(gapEnd, typing.since) + TYPING_HOLD_MS
  return now < holdEnd ? { kind: 'wait', at: Math.min(typing.until, holdEnd), why: 'typing' } : { kind: 'go' }
}

/** Takes the answered messages out; what is left is the next burst, written from scratch. */
export function consume(burst: Burst, ids: readonly number[]): Burst {
  const messages = burst.messages.filter(one => !ids.includes(one.id))
  return { ...burst, messages, regenerations: 0 }
}

/** What happens after the Speaker's check choice; `regenerate` past the cap sends, or drafts a reply it is unsure of. */
export type AfterCheck = 'send' | 'send_then_answer' | 'regenerate' | 'draft'

export function afterCheck(choice: ApCheck, regenerations: number, confidence: number, threshold: number): AfterCheck {
  if (choice !== 'regenerate') return choice
  if (regenerations < MAX_REGENERATIONS) return 'regenerate'
  return confidence >= threshold ? 'send' : 'draft'
}

/** Auto replies already sent in this dialog within the last hour (the limit counts these). */
export function sentLastHour(ledger: readonly ApEntry[], dialogId: number, now: number): number {
  return ledger.filter(entry => entry.peer.id === dialogId && entry.outcome.kind === 'sent' && entry.outcome.by === 'auto' && entry.at > now - 3_600_000).length
}

export type Gate = { kind: 'send' } | { kind: 'draft'; reasons: string[] }

/**
 * Whether a written reply may go out by itself. Everything outside the limits
 * falls back to a draft, and the band says why: the level, the Speaker's own
 * doubt, an escalation topic, the confidence, the hourly limit, quiet hours,
 * the allowlist.
 */
export function gate(
  dialog: ApDialog,
  reply: { action: 'reply' | 'draft' | 'escalate'; confidence: number; topics: readonly ApTopic[]; reason: string },
  context: { sentLastHour: number; minutes: number; isAllowed: boolean },
): Gate {
  const reasons: string[] = []
  const hit = dialog.topics.filter(topic => reply.topics.includes(topic))
  if (hit.length > 0) reasons.push(`escalated: ${hit.map(topic => TOPIC_LABEL[topic]).join(' · ')}`)
  if (reply.action === 'escalate') reasons.push(`asks you: ${reply.reason || 'unsure'}`)
  if (dialog.level === 'draft') return { kind: 'draft', reasons }
  if (reply.action === 'draft') reasons.push(`speaker: ${reply.reason || 'wants you to check'}`)
  if (reply.confidence < dialog.threshold) reasons.push(`conf ${reply.confidence.toFixed(2)} < ${dialog.threshold.toFixed(2)}`)
  if (dialog.perHour !== null && context.sentLastHour >= dialog.perHour) reasons.push(`limit ${rateText(dialog.perHour)} reached`)
  if (isQuiet(dialog.quiet, context.minutes)) reasons.push('quiet hours')
  if (!context.isAllowed) reasons.push('not in allow.toml')
  return reasons.length === 0 ? { kind: 'send' } : { kind: 'draft', reasons }
}
