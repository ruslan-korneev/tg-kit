// What pressing a chip does (docs/design/dialogs-pane.md §4 "peer not allowed for
// writes", §5 idea 6), decided before any tg call. Pure.
//
// The guard (src/tg_kit/guard.py) is the real gate: this only keeps the pane from
// asking for a write tg would refuse, and never passes --yes.
import { decodeBase64, printableUtf8, toHex } from '../packet/build'
import type { Button } from '../packet/types'

/** The peer a press or send goes to: its id and what tg is handed (`@name` or the id). */
export type WritePeer = { id: number; arg: string }

/** Why the pane will not write to a peer, or null when it may. */
export type ReadOnly = { kind: 'botfather' } | { kind: 'not-allowed'; arg: string } | { kind: 'allow-unknown'; reason: string }

/** Inline types tg presses, plus a reply-keyboard text button (it sends its text). */
const PRESSABLE = new Set(['cb', 'game', 'reply'])
/** tg prints what these hold and presses nothing (README "Testing a bot"). */
const SHOWN = new Set(['url', 'login', 'webapp', 'switch', 'copy', 'profile'])

export type ChipAction =
  | { kind: 'press' }
  | { kind: 'show'; text: string }
  | { kind: 'refuse'; text: string }

/** BotFather gets read-only navigation (repo rule), whatever the allowlist says. */
export function isBotFather(arg: string): boolean {
  return arg.toLowerCase() === '@botfather'
}

/**
 * Whether the pane may write to `peer`: not BotFather, and its id in the allowlist.
 * `allow` is null when the allowlist could not be read; then nothing is written.
 */
export function readOnlyReason(peer: WritePeer, allow: readonly number[] | null, allowError = 'not read yet'): ReadOnly | null {
  if (isBotFather(peer.arg)) return { kind: 'botfather' }
  if (allow === null) return { kind: 'allow-unknown', reason: allowError }
  return allow.includes(peer.id) ? null : { kind: 'not-allowed', arg: peer.arg }
}

/** The explanation a dimmed chip or the send box gives instead of running tg. */
export function readOnlyText(reason: ReadOnly): string {
  switch (reason.kind) {
    case 'botfather':
      return 'ro: BotFather is read-only here; tg-kit only navigates it, so nothing is pressed or sent.'
    case 'not-allowed':
      return `ro: ${reason.arg} is not in the write allowlist. If you own it, run \`! tg allow add ${reason.arg} --yes\`, then try again. Nothing was sent.`
    case 'allow-unknown':
      return `ro: could not read the allowlist (${reason.reason}); nothing was sent. Press again to retry.`
  }
}

/** What a chip does when pressed, from its type alone. */
export function chipAction(button: Button): ChipAction {
  if (button.requires_password === true) return { kind: 'refuse', text: `"${button.text}" needs the 2FA password; tg refuses it.` }
  if (PRESSABLE.has(button.type)) return { kind: 'press' }
  if (SHOWN.has(button.type)) return { kind: 'show', text: shownText(button) }
  return { kind: 'refuse', text: `tg does not press ${button.type} buttons ("${button.text}"); nothing was sent.` }
}

function shownText(button: Button): string {
  const what =
    button.url ??
    button.copy_text ??
    (button.query !== undefined ? `inline query "${button.query}"` : undefined) ??
    (button.user_id !== undefined ? `user ${button.user_id}` : undefined) ??
    'nothing to show'
  return `${button.type} "${button.text}" → ${what} (not opened)`
}

/** The chip's label: URL buttons carry their URL, so it is seen without opening it. */
export function chipLabel(button: Button, max: number): string {
  const full = button.type === 'url' && button.url !== undefined ? `${button.text} → ${button.url}` : button.text
  return full.length > max ? `${full.slice(0, Math.max(1, max - 1))}…` : full
}

/** Callback data as text when printable, else `hex:…`; empty when the button has none. */
export function callbackData(button: Pick<Button, 'data_b64'>): string {
  if (button.data_b64 === undefined) return ''
  const bytes = decodeBase64(button.data_b64)
  if (bytes === null) return `b64:${button.data_b64}`
  return printableUtf8(bytes) ?? `hex:${toHex(bytes)}`
}
