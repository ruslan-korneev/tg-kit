// The §4 components, each a plain function over the surface's element table:
// called as `DialogRow(els, props)`, never as a JSX tag, so nothing depends on
// how `h` treats function components. Handlers come in as closures.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Lens, Load, TgDialog, TgMessage } from '../../types'
import {
  GLYPH,
  TOKEN,
  dialogGlyph,
  dialogLabel,
  emptyLensText,
  failureColor,
  failureText,
  isErrorText,
  isReadOnlyPeer,
  mediaTag,
  oneLine,
  senderLabel,
  shortTime,
} from './model'

export type Els = ElementTable

const pad = (text: string, width: number) =>
  text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

/** The rows of `list` a window of `rows` shows so that `cursor` stays in it. */
export function windowAround<T>(list: readonly T[], cursor: number, rows: number): { start: number; items: T[] } {
  const room = Math.max(1, rows)
  const start = Math.min(Math.max(0, cursor - Math.floor(room / 2)), Math.max(0, list.length - room))
  return { start, items: list.slice(start, start + room) }
}

export function DialogRow(
  { Button, Text }: Els,
  props: {
    dialog: TgDialog
    isCursor: boolean
    isOpen: boolean
    isPinned: boolean
    width: number
    now: number
    onOpen: () => void
    /** One glyph after `ro`/`⌁`: the watch mark. */
    mark?: { text: string; color?: string }
    /** The autopilot's level glyph before the name, and `auto 3/50` after the marks; `warn` (red): ── delegate ── skipped hard stops. */
    autopilot?: { glyph: string; tail: string; warn?: string }
  },
): RenderElement {
  const { dialog } = props
  const { glyph, color } = dialogGlyph(dialog.kind)
  const isUnread = dialog.unread > 0
  const badge = isUnread ? String(dialog.unread) : ''
  const time = shortTime(dialog.last_date, props.now)
  const marks = isReadOnlyPeer(dialog) ? 'ro' : props.isPinned ? GLYPH.pinned : ''
  // cursor(2) glyph(2) badge(4) time(10) marks(3): the name takes what is left; an autopilot mark takes its own.
  const pilot = props.autopilot
  const nameWidth = Math.max(8, props.width - 21 - (pilot === undefined ? 0 : pilot.tail.length + 3 + (pilot.warn === undefined ? 0 : pilot.warn.length + 1)))
  return (
    // The cursor row takes the ring whenever the pane takes the keys: ⏎ acts on it at once.
    <Button key={`dialog:${dialog.id}`} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onOpen}>
      <Text color={TOKEN.accent}>{props.isCursor ? `${GLYPH.cursor} ` : props.isOpen ? `${GLYPH.open} ` : '  '}</Text>
      {pilot === undefined ? null : <Text color={TOKEN.accent}>{pilot.glyph} </Text>}
      <Text color={color}>{glyph} </Text>
      <Text bold={isUnread || props.isOpen} underline={props.isOpen}>
        {pad(dialogLabel(dialog), nameWidth)}
      </Text>
      <Text bold>{badge.padStart(3)} </Text>
      <Text dimColor>{time.padStart(9)} </Text>
      <Text color={isReadOnlyPeer(dialog) ? TOKEN.warn : TOKEN.accent}>{marks}</Text>
      {props.mark === undefined ? null : <Text color={props.mark.color}>{props.mark.text}</Text>}
      {pilot === undefined ? null : <Text dimColor> {pilot.tail}</Text>}
      {pilot?.warn === undefined ? null : <Text color={TOKEN.danger}> {pilot.warn}</Text>}
    </Button>
  )
}

/** Inline keyboards as chips. Display only in this phase: nothing presses them. */
export function ButtonRow({ Text }: Els, props: { message: TgMessage; isDim: boolean }): RenderElement {
  const chips = props.message.buttons.map(row => row.map(button => `[ ${button.text} ]`).join(' ')).join('  ')
  return (
    <Text dimColor={props.isDim} wrap="truncate-end">
      {'        '}
      {chips}
    </Text>
  )
}

export function MessageCard(
  els: Els,
  props: {
    message: TgMessage
    isCursor: boolean
    /** The cursor row takes the ring; false while the send sheet holds it (the ▸ still shows). */
    isRinged?: boolean
    isSelected: boolean
    isAnchor: boolean
    width: number
    now: number
    onPress: () => void
    /** Bot testing: the reply's latency stamp, and pressable chips in place of the display row. */
    stamp?: { text: string; isSlow: boolean } | null
    buttonRow?: RenderElement | null
  },
): RenderElement {
  const { Box, Button, Text } = els
  const { message } = props
  const sender = senderLabel(message)
  const id = `#${message.id}`
  const stamp = props.stamp ?? null
  const body = [mediaTag(message), message.text].filter(part => part !== '').join(' ')
  // cursor(1) mark(1) time(11) sender(6) text, then " ⏱1.4s" and " #id": one column spare so nothing wraps.
  const textWidth = Math.max(10, props.width - 21 - id.length - (stamp === null ? 0 : stamp.text.length + 1))
  const color = isErrorText(message.text) ? TOKEN.danger : undefined
  // Marks are ▪ in their own column (§7.1): inverse text is the engine's focus ring.
  const mark = props.isSelected ? GLYPH.marked : props.isAnchor ? 'v' : ' '
  return (
    <Box key={`card:${message.id}`} flexDirection="column">
      <Button key={`msg:${message.id}`} plain autoFocus={props.isCursor && props.isRinged !== false ? true : undefined} onPress={props.onPress}>
        <Text color={TOKEN.accent}>{`${props.isCursor ? GLYPH.cursor : ' '}${mark}`}</Text>
        <Text dimColor> {shortTime(message.date, props.now).padEnd(9)} </Text>
        <Text color={sender === 'bot' ? TOKEN.bot : undefined}>{pad(sender, 6)}</Text>
        <Text color={color}>
          {pad(oneLine(body, textWidth), textWidth)}
        </Text>
        {stamp === null ? null : <Text color={stamp.isSlow ? TOKEN.warn : undefined} dimColor={!stamp.isSlow}> {stamp.text}</Text>}
        <Text dimColor> {id}</Text>
      </Button>
      {props.buttonRow !== undefined ? props.buttonRow : message.buttons.length > 0 ? ButtonRow(els, { message, isDim: false }) : null}
    </Box>
  )
}

/** Loading, flood wait, not logged in, tg missing, an error: one place draws them. */
export function LoadState<T>(
  { Box, Text, Button }: Els,
  props: { load: Load<T>; now: number; rows: number; onReload: () => void },
): RenderElement | null {
  const { load } = props
  if (load.status === 'ok') return null
  if (load.status === 'idle' || load.status === 'loading') {
    return (
      <Box key="loading" flexDirection="column">
        {Array.from({ length: Math.min(3, Math.max(1, props.rows)) }, (_, index) => (
          <Text key={`loading:${index}`} dimColor>
            {'  …'}
          </Text>
        ))}
      </Box>
    )
  }
  return (
    <Box key="failure" flexDirection="column">
      <Text color={failureColor(load.failure)} wrap="wrap">
        {load.failure.kind === 'flood' ? `${GLYPH.error} ` : ''}
        {failureText(load.failure, props.now, load.retryAt)}
      </Text>
      {load.failure.kind === 'flood' ? null : (
        <Button key="reload" plain hotkey="g" dimColor onPress={props.onReload}>
          reload
        </Button>
      )}
    </Box>
  )
}

export function EmptyLens({ Text }: Els, props: { lens: Lens; query: string }): RenderElement {
  return (
    <Text key="empty" dimColor wrap="wrap">
      {emptyLensText(props.lens, props.query)}
    </Text>
  )
}

export function Divider({ Text }: Els, props: { label: string; width: number }): RenderElement {
  const label = props.label === '' ? '' : ` ${props.label} `
  return (
    <Text color={TOKEN.accent} dimColor wrap="truncate-end">
      {`─${label}`.padEnd(Math.max(1, props.width), '─')}
    </Text>
  )
}
