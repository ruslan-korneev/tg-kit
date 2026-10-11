// How the open chat draws its message rows (docs/design/dialogs-pane-ux.md §7.3,
// §8 T6): the sender column sized to the chat, a day divider where the day
// changes instead of dates in the time column, and a message's buttons on its
// own row's right from 90 columns. The thread's window counts terminal rows,
// so each message's height is decided here, once, for the drawing and for the
// moves (./drafts windowStart). Pure.
import type { Button, TgMessage } from '../../types'
import { chipLabel } from '../bottest/keyboard'
import type { ChatKind } from './keys'
import { senderLabel } from './model'

/** From this width a message's buttons sit on its own row (§7.3). */
export const CHIPS_ON_ROW_FROM = 90

/** The text keeps at least this much of the row before the buttons give way to a row of their own. */
const MIN_TEXT = 16

/** The longest chip label that sits on the message's row; a longer one takes its keyboard to the row under it. */
export const CHIP_LABEL_MAX = 16

/** Cells a chip takes, at its widest: `1: Retry` (the cursor row's digit form; `[Retry]` takes one less). */
export function chipCells(label: string): number {
  return label.length + 3
}

/** Gap between two chips, and before the `·` that separates two keyboard rows. */
export const CHIP_GAP = 2

/** The chips' labels, row by row, as drawn: a URL button carries its URL, each cut to `max`. */
export function chipLabels(buttons: readonly (readonly Button[])[], max: number): string[][] {
  return buttons.filter(row => row.length > 0).map(row => row.map(button => chipLabel(button, max)))
}

/** Cells the chips take at their widest (the digit form), with a `·` between keyboard rows. */
export function chipsCells(labels: readonly (readonly string[])[]): number {
  const chips = labels.flat().map(chipCells)
  const separators = Math.max(0, labels.length - 1)
  const items = chips.length + separators
  return chips.reduce((sum, one) => sum + one, 0) + separators + CHIP_GAP * Math.max(0, items - 1)
}

/**
 * The sender column (§7.3): 3 in a bot chat (`you`, `bot`), then two cells;
 * elsewhere the longest name loaded, up to 10, then one cell, so a group's
 * `Member 1` never runs into its text.
 */
export function senderColumn(messages: readonly Pick<TgMessage, 'out' | 'sender'>[], kind: ChatKind | null): { width: number; gap: number } {
  if (kind === 'bot' || kind === 'botfather') return { width: 3, gap: 2 }
  const longest = messages.reduce((top, message) => Math.max(top, senderLabel(message).length), 3)
  return { width: Math.min(10, longest), gap: 1 }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `21:02`, local time: the time column holds the time only; the day is the divider's. */
export function clockOf(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

function dayStart(at: number): number {
  const day = new Date(at)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
}

/** The divider's words: `today`, `yesterday`, else `10-08`; local time. */
export function dayLabel(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const today = dayStart(now)
  const day = dayStart(at)
  if (day === today) return 'today'
  // A day back from today's start: a DST change makes a day 23 or 25 hours, so compare starts, not spans.
  if (day === dayStart(today - 1)) return 'yesterday'
  const date = new Date(at)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Where a day divider goes: before the first message of each day, keyed by its
 * id. The first loaded message gets one unless it is from today, so a thread of
 * today alone spends no row on it.
 */
export function dayDividers(messages: readonly Pick<TgMessage, 'id' | 'date'>[], now: number): Map<number, string> {
  const dividers = new Map<number, string>()
  let last: number | null = null
  for (const message of messages) {
    const at = Date.parse(message.date)
    if (Number.isNaN(at)) continue
    const day = dayStart(at)
    if (last === null ? day !== dayStart(now) : day !== last) dividers.set(message.id, dayLabel(message.date, now))
    last = day
  }
  return dividers
}

/** The cells of a message row that are not text: cursor, mark, time, the sender column, and a cell spare so nothing wraps. */
export function fixedCells(sender: { width: number; gap: number }): number {
  // cursor(1) mark(1) space time(5) space, the sender and its gap, one cell spare.
  return 9 + sender.width + sender.gap + 1
}

/** How one message draws: its day divider, and whether its buttons share its row. */
export type MessageLook = { divider: string | null; isChipsOnRow: boolean }

/** The look of every loaded message at `width`. */
export function messageLooks(
  messages: readonly TgMessage[],
  width: number,
  now: number,
  sender: { width: number; gap: number },
  isReadOnly: boolean,
): Map<number, MessageLook> {
  const dividers = dayDividers(messages, now)
  return new Map(
    messages.map(message => {
      // The stamp and the id are left out: the text gives them its room on the rows that have them.
      // Only whole labels share the row: a URL chip carries its URL, which the row under the message has room for.
      const labels = chipLabels(message.buttons, Infinity)
      const isChipsOnRow =
        message.buttons.length > 0 &&
        width >= CHIPS_ON_ROW_FROM &&
        labels.every(row => row.every(label => label.length <= CHIP_LABEL_MAX)) &&
        chipsCells(labels) + (isReadOnly ? 2 + CHIP_GAP : 0) + 1 <= width - fixedCells(sender) - MIN_TEXT
      return [message.id, { divider: dividers.get(message.id) ?? null, isChipsOnRow }]
    }),
  )
}

/** Terminal rows a message takes: its divider, its line, and its buttons' row when they do not share the line. */
export function messageRows(message: Pick<TgMessage, 'buttons'>, look: MessageLook | undefined): number {
  const divider = (look?.divider ?? null) === null ? 0 : 1
  const chips = message.buttons.length > 0 && look?.isChipsOnRow !== true ? 1 : 0
  return divider + 1 + chips
}
