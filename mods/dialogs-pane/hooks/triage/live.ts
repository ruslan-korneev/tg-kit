// What a watch event changes: the open thread's messages, the dialog row, and
// the watched-reply report Hidden mode shows. Pure; register.tsx applies it.
import type { BandEvent, Load, TgDialog, TgPeerKind, Triage, WatchedReply } from '../../types'
import { findTrigger } from '../packet/replay'
import type { MessageView } from '../packet/types'
import { GLYPH, statusText } from '../ui/model'
import type { WatchEvent } from '../watch/watch'

/** Messages a watch keeps to find what a reply answers. */
export const RECENT = 50

/** A reply this long after your message is not "latency" any more, just a later message. */
const MAX_LATENCY_MS = 10 * 60_000

export const EMPTY_TRIAGE: Triage = {
  watched: [],
  health: {},
  verdicts: {},
  repliedToYou: {},
  summary: null,
  reply: null,
}

/** A thread's messages after one event, oldest first; a message seen twice is kept once. */
export function applyToMessages<M extends { id: number }>(messages: readonly M[], event: WatchEvent, toMessage: (m: MessageView) => M): M[] {
  switch (event.event) {
    case 'ready':
    case 'typing':
      return [...messages]
    case 'delete':
      return messages.filter(one => !event.ids.includes(one.id))
    case 'edit': {
      const next = toMessage(event.message)
      return messages.map(one => (one.id === next.id ? next : one))
    }
    case 'message': {
      const next = toMessage(event.message)
      if (messages.some(one => one.id === next.id)) return messages.map(one => (one.id === next.id ? next : one))
      return [...messages, next].sort((a, b) => a.id - b.id)
    }
  }
}

/**
 * The dialog row after a live message: last text, id and date move, and an
 * incoming message counts as unread until the next `tg dialogs` says otherwise.
 */
export function applyToDialogs(dialogs: readonly TgDialog[], dialogId: number, message: MessageView): TgDialog[] {
  return dialogs.map(dialog => {
    if (dialog.id !== dialogId || (dialog.last_id !== null && dialog.last_id >= message.id)) return dialog
    return {
      ...dialog,
      unread: message.out ? 0 : dialog.unread + 1,
      last_id: message.id,
      last_date: message.date,
      last_text: message.text,
    }
  })
}

/** How long the bot took: from your message it answers to this one, when that is known and recent. */
export function latencyOf(reply: MessageView, recent: readonly MessageView[]): number | null {
  const trigger = findTrigger(reply, recent)
  if (trigger === null || trigger === reply) return null
  const ms = Date.parse(reply.date) - Date.parse(trigger.date)
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_LATENCY_MS ? ms : null
}

/** Whether a live message answers one of yours by Telegram's reply link. */
export function repliesToYou(message: MessageView, recent: readonly MessageView[]): boolean {
  return !message.out && message.reply_to !== null && recent.some(one => one.out && one.id === message.reply_to)
}

/** `1.4s`, `12s`, `3m`: latency as the status line and band show it. */
export function latencyText(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

export function replyText(reply: WatchedReply): string {
  const glyph = reply.kind === 'bot' ? `${GLYPH.bot} ` : ''
  const label = reply.label.replace(/^@/, '')
  if (reply.kind !== 'bot') return `${glyph}${label} wrote`
  return `${glyph}${label} replied${reply.latencyMs === null ? '' : ` ${latencyText(reply.latencyMs)}`}`
}

/** Hidden's status line: pane-core's, with the watched reply in place of "wrote" when the band shows it. */
export function hiddenStatus(load: Load<TgDialog[]>, event: BandEvent | null, reply: WatchedReply | null): string {
  if (event === null || reply === null || reply.dialogId !== event.dialogId) return statusText(load, event)
  return `${statusText(load, null)} · ${replyText(reply)}`
}

/** The band and the reply report for a live incoming message in a watched dialog. */
export function reportReply(
  peer: { id: number; label: string; kind: TgPeerKind },
  message: MessageView,
  recent: readonly MessageView[],
): { band: BandEvent; reply: WatchedReply } {
  return {
    band: { dialogId: peer.id, label: peer.label, kind: peer.kind, text: message.text },
    reply: {
      dialogId: peer.id,
      messageId: message.id,
      label: peer.label,
      kind: peer.kind,
      latencyMs: peer.kind === 'bot' ? latencyOf(message, recent) : null,
    },
  }
}
