// The §4 components, each a plain function over the surface's element table:
// called as `DialogRow(els, props)`, never as a JSX tag, so nothing depends on
// how `h` treats function components. Handlers come in as closures.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Load, TgDialog, TgMessage } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { DRAFT_INDENT, type DraftView, type VerdictTone } from './drafts'
import {
  GLYPH,
  TOKEN,
  dialogGlyph,
  dialogLabel,
  failureColor,
  failureText,
  isErrorText,
  isReadOnlyPeer,
  mediaTag,
  oneLine,
  senderLabel,
  shortTime,
} from './model'
import { clockOf, fixedCells, type MessageLook } from './thread'

export type Els = ElementTable

const pad = (text: string, width: number) =>
  text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

/** A column exactly `width` wide: cut with … only when the text is longer (`bot` fills a 3-column sender). */
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width))

/**
 * Where a list's window starts so that `cursor` is in it, scrolling at the
 * edges: the start moves only when the cursor leaves [start, start + rows).
 * The engine keeps the focus ring by its place among a site's Buttons across
 * a redraw (2.1.296), so a window that recentred on every move left the ring
 * one row off the cursor; one that holds still keeps them together.
 */
export function edgeStart(start: number, cursor: number, rows: number, length: number): number {
  const room = Math.max(1, rows)
  const moved = cursor < start ? cursor : cursor >= start + room ? cursor - room + 1 : start
  return Math.min(Math.max(0, moved), Math.max(0, length - room))
}

/** A dialog row's cells besides the name (§7.3): cursor 2, level 2, kind 2, watch 2, unread 4, time 10. */
const DIALOG_FIXED = 22

/** The rows of `list` a window of `rows` from `start` shows. */
export function windowAt<T>(list: readonly T[], start: number, rows: number): T[] {
  return list.slice(start, start + Math.max(1, rows))
}

export function DialogRow(
  { Box, Button, Text }: Els,
  props: {
    dialog: TgDialog
    /** `dialog:<gen>:<id>`: the list's generation is part of it, so a reshaped list brings new keys (§8 T9). */
    rowKey: string
    isCursor: boolean
    /** Drawn without its ring stop while a field in the bar's row holds the ring (§4.3 rule 3); ▸ shows. */
    isStatic?: boolean
    isOpen: boolean
    isPinned: boolean
    width: number
    now: number
    onOpen: () => void
    /** The watch column's glyph (◎, colored by the watch's health); BotFather's `ro` takes the column instead. */
    mark?: { text: string; color?: string }
    /** The autopilot's level glyph in the level column, and `auto 3/50` after the name; `warn` (red): ── delegate ── skipped hard stops. */
    autopilot?: { glyph: string; tail: string; warn?: string }
  },
): RenderElement {
  const { dialog } = props
  const { glyph, color } = dialogGlyph(dialog.kind)
  const isUnread = dialog.unread > 0
  // A muted chat's count is dim and marked `·14`: muted ones would bury the rest (§4.7, §5).
  const badge = isUnread ? `${dialog.muted ? '·' : ''}${dialog.unread}` : ''
  const time = shortTime(dialog.last_date, props.now)
  const pilot = props.autopilot
  // §7.3: cursor 2 · level 2 · kind 2 · name · watch 2 · unread 4 · time 10. The level column is always drawn,
  // so a name does not shift when an agent starts; a follow is the ladder's first level (decision 2), so ⌁ sits there too.
  const level = pilot !== undefined ? pilot.glyph : props.isPinned ? GLYPH.pinned : ' '
  // The watch column: `ro` on BotFather (read-only, nothing to watch there), else the watch mark.
  const watch = isReadOnlyPeer(dialog) ? { text: 'ro', color: TOKEN.warn } : props.mark
  const tail = pilot === undefined ? 0 : pilot.tail.length + 1 + (pilot.warn === undefined ? 0 : pilot.warn.length + 1)
  const nameWidth = Math.max(8, props.width - DIALOG_FIXED - tail)
  const cells = [
    <Text color={TOKEN.accent}>{props.isCursor ? `${GLYPH.cursor} ` : props.isOpen ? `${GLYPH.open} ` : '  '}</Text>,
    <Text color={TOKEN.accent}>{`${level} `}</Text>,
    <Text color={color}>{glyph} </Text>,
    <Text bold={(isUnread && !dialog.muted) || props.isOpen} underline={props.isOpen}>
      {pad(dialogLabel(dialog), nameWidth)}
    </Text>,
    pilot === undefined ? null : <Text dimColor>{`${pilot.tail} `}</Text>,
    pilot?.warn === undefined ? null : <Text color={TOKEN.danger}>{`${pilot.warn} `}</Text>,
    <Text color={watch?.color}>{(watch?.text ?? '').padEnd(2)}</Text>,
    <Text bold={!dialog.muted} dimColor={dialog.muted}>{badge.padStart(4)}</Text>,
    <Text dimColor>{time.padStart(10)}</Text>,
  ]
  if (props.isStatic === true) {
    return (
      <Box key={props.rowKey} flexDirection="row">
        {...cells}
      </Box>
    )
  }
  return (
    // The cursor row takes the ring whenever the pane takes the keys: ⏎ acts on it at once.
    <Button key={props.rowKey} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onOpen}>
      {...cells}
    </Button>
  )
}

/**
 * A message row of the open chat (§7.3): cursor, mark, time, the sender
 * column, the text, then the latency stamp and, on the cursor row only, the
 * id. A day divider above the first message of a day stands for the dates the
 * time column no longer carries. The message's buttons (bot testing's Chips)
 * sit on its own row's right where ./thread found room, else on a row under it.
 */
export function MessageCard(
  els: Els,
  props: {
    message: TgMessage
    isCursor: boolean
    /**
     * Drawn without ring stops (plain Text, chips as text) while the send sheet
     * holds the keys: the engine keeps the ring by its place among the stops, so
     * rows coming back under a closing sheet would leave it above ▸. The ▸ shows.
     */
    isStatic?: boolean
    isSelected: boolean
    isAnchor: boolean
    width: number
    /** The chat's sender column, and this message's divider and chips placement (./thread). */
    sender: { width: number; gap: number }
    /** Where chips beside the text start (./thread `chipsColumn`) and what the row keeps after them (`chipsTail`). */
    chipsAt: { column: number; tail: number }
    look: MessageLook
    onPress: () => void
    /** Bot testing: the reply's latency stamp. */
    stamp?: { text: string; isSlow: boolean } | null
    /** The message's buttons; null without buttons. */
    chips: { element: RenderElement } | null
  },
): RenderElement {
  const { Box, Button, Text } = els
  const { message, look } = props
  const id = props.isCursor ? `#${message.id}` : ''
  const stamp = props.stamp ?? null
  const chips = props.chips
  const isOnRow = chips !== null && look.isChipsOnRow
  const body = [mediaTag(message), message.text].filter(part => part !== '').join(' ')
  // Beside the text the chips start at the thread's chips column, and the stamp and id follow them; elsewhere they end the row.
  const tail = isOnRow ? props.chipsAt.column + 1 + props.chipsAt.tail : (stamp === null ? 0 : stamp.text.length + 1) + (id === '' ? 0 : id.length + 1)
  const textWidth = Math.max(10, props.width - fixedCells(props.sender) - tail)
  const color = isErrorText(message.text) ? TOKEN.danger : undefined
  // Marks are ▪ in their own column (§7.1): inverse text is the engine's focus ring.
  const mark = props.isSelected ? GLYPH.marked : props.isAnchor ? 'v' : ' '
  const sender = senderLabel(message)
  const head = [
    <Text color={TOKEN.accent}>{`${props.isCursor ? GLYPH.cursor : ' '}${mark}`}</Text>,
    <Text dimColor> {clockOf(message.date).padEnd(5)} </Text>,
    // The bot token is the ◆ glyph's alone (§7.1): the sender column stays plain.
    <Text>{fit(sender, props.sender.width)}</Text>,
    <Text>{' '.repeat(props.sender.gap)}</Text>,
    <Text color={color}>{fit(oneLine(body, textWidth), textWidth)}</Text>,
  ]
  const right = [
    stamp === null ? null : <Text color={stamp.isSlow ? TOKEN.warn : undefined} dimColor={!stamp.isSlow}> {stamp.text}</Text>,
    id === '' ? null : <Text dimColor> {id}</Text>,
  ]
  const line = isOnRow ? head : [...head, ...right]
  const row =
    props.isStatic === true ? (
      <Box key={`row:${message.id}`} flexDirection="row">
        {...line}
      </Box>
    ) : (
      <Button key={`msg:${message.id}`} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onPress}>
        {...line}
      </Button>
    )
  return (
    <Box key={`card:${message.id}`} flexDirection="column">
      {look.divider === null ? null : (
        <Box key={`day:${message.id}`}>
          <Text dimColor wrap="truncate-end">{`   ── ${look.divider} ──`}</Text>
        </Box>
      )}
      {isOnRow ? (
        <Box key={`line:${message.id}`} flexDirection="row">
          {row}
          <Text> </Text>
          {chips.element}
          {...right}
        </Box>
      ) : (
        row
      )}
      {chips === null || isOnRow ? null : (
        <Box key={`under:${message.id}`} flexDirection="row">
          <Text>{' '.repeat(fixedCells(props.sender) - 1)}</Text>
          {chips.element}
        </Box>
      )}
    </Box>
  )
}

/**
 * Loading, flood wait, not logged in, tg missing, an error: one place draws
 * them (§7.4), each one sentence and one key. A flood wait retries by itself,
 * counting down in the warn token; the rest end in `g: retry`, an error's line red.
 */
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
        {failureText(load.failure, props.now, load.retryAt)}
      </Text>
      {load.failure.kind === 'flood' ? null : (
        <Button key="reload" plain hotkey="g" dimColor onPress={props.onReload}>
          retry
        </Button>
      )}
    </Box>
  )
}

/** An empty list: one sentence and one key (§7.4). */
export function EmptyList({ Text }: Els, props: { text: string }): RenderElement {
  return (
    <Text key="empty" dimColor wrap="wrap">
      {props.text}
    </Text>
  )
}

/** `─ label ───…`; `right` ends it (`─ start here ──── d: got it ─`). */
export function Divider({ Text }: Els, props: { label: string; width: number; right?: string }): RenderElement {
  const label = props.label === '' ? '' : ` ${props.label} `
  const right = props.right === undefined ? '' : ` ${props.right} ─`
  return (
    <Text color={TOKEN.accent} dimColor wrap="truncate-end">
      {`─${label}`.padEnd(Math.max(1, props.width - right.length), '─') + right}
    </Text>
  )
}

const VERDICT_COLOR: Record<VerdictTone, string | undefined> = { ok: TOKEN.ok, danger: TOKEN.danger, dim: undefined }

/**
 * A draft as a row of its chat's thread (§5.4, §8 T3): its head is the ring
 * stop ⏎ acts on, then its whole text, wrapped (or the field `e` opens, in its
 * place), then why it waits and the guard's verdict. The thread's window holds
 * it whole or not at all (./drafts `draftHeight`), so a draft ⏎ can reach is a
 * draft read whole (decision 9).
 */
export function DraftCard(
  els: Els,
  props: { draft: DraftView; isCursor: boolean; isStatic?: boolean; width: number; onPress: () => void; onSave: (text: string) => void },
): RenderElement {
  const { Box, Button, Text } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { draft } = props
  const head = [
    <Text color={TOKEN.accent}>{`${props.isCursor ? GLYPH.cursor : ' '}  `}</Text>,
    <Text color={TOKEN.warn}>{`${LEVEL_GLYPH.draft} draft to ${draft.peer.label}`}</Text>,
    // One line: a Button's row does not cut its text, so the head is cut to the pane's width here.
    <Text dimColor>{` · ${oneLine(draft.why, Math.max(4, props.width - DRAFT_INDENT - 14 - draft.peer.label.length - 3))}`}</Text>,
  ]
  const indent = ' '.repeat(DRAFT_INDENT)
  return (
    <Box key={`card:${draft.key}`} flexDirection="column">
      {props.isStatic === true ? (
        <Box key={`row:${draft.key}`} flexDirection="row">
          {...head}
        </Box>
      ) : (
        <Button key={draft.key} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onPress}>
          {...head}
        </Button>
      )}
      {draft.isEditing && Input !== undefined && props.isStatic !== true ? (
        <Input key={`${draft.key}:text`} label={`${indent}✎`} value={draft.text} submitLabel="keep" autoFocus onSubmit={value => props.onSave(value)} />
      ) : (
        <Box key={`text:${draft.key}`} flexDirection="row">
          <Text>{indent}</Text>
          <Text wrap="wrap">{draft.text}</Text>
        </Box>
      )}
      <Text key={`verdict:${draft.key}`} color={VERDICT_COLOR[draft.verdict.tone]} dimColor={draft.verdict.tone === 'dim'} wrap="truncate-end">
        {`${indent}${draft.verdict.text}`}
      </Text>
    </Box>
  )
}
