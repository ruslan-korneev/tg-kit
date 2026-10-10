// The §4 components, each a plain function over the surface's element table:
// called as `DialogRow(els, props)`, never as a JSX tag, so nothing depends on
// how `h` treats function components. Handlers come in as closures.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Lens, Load, TgDialog, TgMessage } from '../../types'
import {
  GLYPH,
  LENSES,
  LENS_LABEL,
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
  type Hint,
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

export function Header(
  { Box, Text, Button }: Els,
  props: { title: string; mode: string; onMode: () => void },
): RenderElement {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={TOKEN.accent} bold wrap="truncate-end">
        {props.title}
      </Text>
      <Button key="mode" plain hotkey="m" dimColor onPress={props.onMode}>
        {props.mode}
      </Button>
    </Box>
  )
}

export function LensBar(
  els: Els,
  props: {
    lens: Lens
    query: string
    onLens: (lens: Lens) => void
    onSearch: (query: string) => void
    /** Drawn after the built-in tabs: saved lenses and the needs-you toggle. */
    extra?: RenderElement
    /** A saved lens is active, so no built-in tab is drawn as the current one. */
    isSavedLens?: boolean
  },
): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  return (
    <Box flexDirection="row" justifyContent="space-between">
      {Input === undefined ? (
        <Text dimColor>{props.query === '' ? '' : `/ ${props.query}`}</Text>
      ) : (
        <Input key="search" label="/" placeholder="search" value={props.query} submitLabel="filter" onSubmit={value => props.onSearch(value)} />
      )}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>lens:</Text>
        {LENSES.map((lens, index) =>
          lens === props.lens && props.isSavedLens !== true ? (
            <Button key={`lens:${lens}`} plain hotkey={String(index + 1)} onPress={() => props.onLens(lens)}>
              <Text color={TOKEN.accent} bold>{`[${LENS_LABEL[lens]}]`}</Text>
            </Button>
          ) : (
            <Button key={`lens:${lens}`} plain hotkey={String(index + 1)} dimColor onPress={() => props.onLens(lens)}>
              {LENS_LABEL[lens]}
            </Button>
          ),
        )}
        {props.extra ?? null}
      </Box>
    </Box>
  )
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
  },
): RenderElement {
  const { dialog } = props
  const { glyph, color } = dialogGlyph(dialog.kind)
  const isUnread = dialog.unread > 0
  const badge = isUnread ? String(dialog.unread) : ''
  const time = shortTime(dialog.last_date, props.now)
  const marks = isReadOnlyPeer(dialog) ? 'ro' : props.isPinned ? GLYPH.pinned : ''
  // cursor(2) glyph(2) badge(4) time(10) marks(3): the name takes what is left.
  const nameWidth = Math.max(8, props.width - 21)
  return (
    <Button key={`dialog:${dialog.id}`} plain onPress={props.onOpen}>
      <Text color={TOKEN.accent}>{props.isCursor ? `${GLYPH.cursor} ` : '  '}</Text>
      <Text color={color}>{glyph} </Text>
      <Text bold={isUnread || props.isOpen} underline={props.isOpen}>
        {pad(dialogLabel(dialog), nameWidth)}
      </Text>
      <Text bold>{badge.padStart(3)} </Text>
      <Text dimColor>{time.padStart(9)} </Text>
      <Text color={isReadOnlyPeer(dialog) ? TOKEN.warn : TOKEN.accent}>{marks}</Text>
      {props.mark === undefined ? null : <Text color={props.mark.color}>{props.mark.text}</Text>}
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
  // cursor(1) time(11) sender(6) text, then " ⏱1.4s" and " #id": one column spare so nothing wraps.
  const textWidth = Math.max(10, props.width - 20 - id.length - (stamp === null ? 0 : stamp.text.length + 1))
  const color = isErrorText(message.text) ? TOKEN.danger : undefined
  return (
    <Box key={`card:${message.id}`} flexDirection="column">
      <Button key={`msg:${message.id}`} plain onPress={props.onPress}>
        <Text color={TOKEN.accent}>{props.isCursor ? GLYPH.cursor : props.isAnchor ? 'v' : ' '}</Text>
        <Text dimColor> {shortTime(message.date, props.now).padEnd(9)} </Text>
        <Text color={sender === 'bot' ? TOKEN.bot : undefined}>{pad(sender, 6)}</Text>
        <Text color={color} inverse={props.isSelected}>
          {pad(oneLine(body, textWidth), textWidth)}
        </Text>
        {stamp === null ? null : <Text color={stamp.isSlow ? TOKEN.warn : undefined} dimColor={!stamp.isSlow}> {stamp.text}</Text>}
        <Text dimColor> {id}</Text>
      </Button>
      {props.buttonRow !== undefined ? props.buttonRow : message.buttons.length > 0 ? ButtonRow(els, { message, isDim: false }) : null}
    </Box>
  )
}

export function HintsRow({ Box, Button }: Els, props: { hints: readonly Hint[]; onHint: (key: string) => void }): RenderElement {
  return (
    <Box key="hints" flexDirection="row" gap={2}>
      {props.hints.map(hint => (
        <Button key={`hint:${hint.key}`} plain hotkey={hint.hotkey} dimColor onPress={() => props.onHint(hint.key)}>
          {hint.label}
        </Button>
      ))}
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
