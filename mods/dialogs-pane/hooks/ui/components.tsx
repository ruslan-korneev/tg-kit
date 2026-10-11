// The §4 components, each a plain function over the surface's element table:
// called as `ChatRow(els, colors, props)`, never as a JSX tag, so nothing depends on
// how `h` treats function components. Handlers come in as closures.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Load, TgMessage } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { DRAFT_INDENT, type DraftView, type VerdictTone } from './drafts'
import { cutCells } from '../folders/folders'
import {
  GLYPH,
  cells,
  failureRole,
  failureText,
  isErrorText,
  labelCells,
  mediaTag,
  oneLine,
  peerConfirmLabel,
  rowWidths,
  senderLabel,
} from './model'
import type { Colors, Role } from './palette'
import { clockOf, fixedCells, type MessageLook } from './thread'

export type Els = ElementTable

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

/** The rows of `list` a window of `rows` from `start` shows. */
export function windowAt<T>(list: readonly T[], start: number, rows: number): T[] {
  return list.slice(start, start + Math.max(1, rows))
}

/** A role's colour, or the surface's own for none. */
const tint = (colors: Colors, role: Role | undefined) => (role === undefined ? undefined : colors[role])

/** `text` cut by cells to `width` with …, then padded to exactly `width` cells. */
function fitCells(text: string, width: number): string {
  const cut = cutCells(text, width)
  return cut + ' '.repeat(Math.max(0, width - cells(cut)))
}

/**
 * One chat in Chats, FOR YOU, the compact card and Topics (§10.4), exactly
 * `width` cells: cursor 1 · time 6 · glyph · name · preview · symbol 3, a space
 * between each. The name keeps its room and the preview gives way first.
 */
export function ChatRow(
  { Box, Button, Text }: Els,
  colors: Colors,
  props: {
    /** `dialog:<gen>:<id>`: the list's generation is part of it, so a reshaped list brings new keys (§8 T9). */
    rowKey: string
    /** The cells the row may use: a card's inner width. */
    width: number
    isCursor: boolean
    /** The open chat's row while the cursor is elsewhere (dock). */
    isOpen: boolean
    /** The keys are elsewhere: ▸ and › dim (§10.5). */
    isDim?: boolean
    /** `rowTime`'s text. */
    time: string
    glyph: { text: string; role: Role }
    name: string
    /** The name bold in `text`; a read chat's name stays plain, not dim. */
    isUnread: boolean
    /** Dim unless a role is given (FOR YOU's `draft: …` is `held`). */
    preview: { text: string; role?: Role }
    symbol: { text: string; role: Role } | null
    /** Drawn without its ring stop (a field holds the ring, §4.3 rule 3; a card of text); ▸ shows. */
    isStatic?: boolean
    /** ⏎ on the row; without it the row is text. */
    onPress?: () => void
  },
): RenderElement {
  const room = rowWidths(props.width)
  const mark = props.isCursor ? GLYPH.cursor : props.isOpen ? GLYPH.open : ' '
  const symbol = props.symbol
  const cellsOf = [
    <Text color={props.isDim === true ? colors.dim : colors.accent}>{mark}</Text>,
    <Text color={colors.dim}>{`${props.time.padStart(6)} `}</Text>,
    <Text color={colors[props.glyph.role]}>{props.glyph.text}</Text>,
    <Text> </Text>,
    <Text color={props.isUnread ? colors.text : undefined} bold={props.isUnread}>
      {fitCells(props.name, room.name)}
    </Text>,
    // A name-only row keeps the preview's space as padding, so the row stays `width` cells.
    <Text color={colors[props.preview.role ?? 'dim']}>{` ${room.preview === 0 ? '' : fitCells(oneLine(props.preview.text, props.width), room.preview)}`}</Text>,
    // ⚡ is two cells (§10.3), so the column pads by cells.
    <Text color={symbol === null ? undefined : colors[symbol.role]}>{` ${' '.repeat(Math.max(0, 3 - labelCells(symbol?.text ?? '')))}${symbol?.text ?? ''}`}</Text>,
  ]
  const onPress = props.onPress
  if (props.isStatic === true || onPress === undefined) {
    return (
      <Box key={props.rowKey} flexDirection="row">
        {...cellsOf}
      </Box>
    )
  }
  return (
    // The cursor row takes the ring whenever the pane takes the keys: ⏎ acts on it at once.
    <Button key={props.rowKey} plain autoFocus={props.isCursor ? true : undefined} onPress={onPress}>
      {...cellsOf}
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
  colors: Colors,
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
  const color = isErrorText(message.text) ? colors.unread : undefined
  // Marks are ▪ in their own column (§7.1): inverse text is the engine's focus ring.
  const mark = props.isSelected ? GLYPH.marked : props.isAnchor ? 'v' : ' '
  const sender = senderLabel(message)
  const head = [
    <Text color={colors.accent}>{`${props.isCursor ? GLYPH.cursor : ' '}${mark}`}</Text>,
    <Text dimColor> {clockOf(message.date).padEnd(5)} </Text>,
    // The bot token is the ◆ glyph's alone (§7.1): the sender column stays plain.
    <Text>{fit(sender, props.sender.width)}</Text>,
    <Text>{' '.repeat(props.sender.gap)}</Text>,
    <Text color={color}>{fit(oneLine(body, textWidth), textWidth)}</Text>,
  ]
  const right = [
    stamp === null ? null : <Text color={stamp.isSlow ? colors.held : undefined} dimColor={!stamp.isSlow}> {stamp.text}</Text>,
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
  colors: Colors,
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
      <Text color={tint(colors, failureRole(load.failure))} wrap="wrap">
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

const VERDICT_ROLE: Record<VerdictTone, Role | undefined> = { ok: 'ok', danger: 'unread', dim: undefined }

/**
 * A draft as a row of its chat's thread (§5.4, §8 T3): its head is the ring
 * stop ⏎ acts on, then its whole text, wrapped (or the field `e` opens, in its
 * place), then why it waits and the guard's verdict. The thread's window holds
 * it whole or not at all (./drafts `draftHeight`), so a draft ⏎ can reach is a
 * draft read whole (decision 9).
 */
export function DraftCard(
  els: Els,
  colors: Colors,
  props: { draft: DraftView; isCursor: boolean; isStatic?: boolean; width: number; onPress: () => void; onSave: (text: string) => void },
): RenderElement {
  const { Box, Button, Text } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { draft } = props
  const to = peerConfirmLabel(draft.peer)
  const head = [
    <Text color={colors.accent}>{`${props.isCursor ? GLYPH.cursor : ' '}  `}</Text>,
    <Text color={colors.held}>{`${LEVEL_GLYPH.draft} draft to ${to}`}</Text>,
    // One line: a Button's row does not cut its text, so the head is cut to the pane's width here.
    <Text dimColor>{` · ${oneLine(draft.why, Math.max(4, props.width - DRAFT_INDENT - 14 - to.length - 3))}`}</Text>,
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
      <Text key={`verdict:${draft.key}`} color={tint(colors, VERDICT_ROLE[draft.verdict.tone])} dimColor={draft.verdict.tone === 'dim'} wrap="truncate-end">
        {`${indent}${draft.verdict.text}`}
      </Text>
    </Box>
  )
}
