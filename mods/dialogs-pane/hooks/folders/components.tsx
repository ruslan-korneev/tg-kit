// The Folders list and For you (docs/design/dialogs-pane-ux.md §4.7, §5.0,
// §5.3), plain functions over the surface's element table like
// ../ui/components. Handlers come in as closures; their keys are in ../ui/keys.
import type { RenderElement } from 'claude-code'

import type { Els } from '../ui/components'
import { GLYPH, TOKEN, cells, oneLine } from '../ui/model'

/** One row of the Folders list: a folder, the Archive, or a pane view. */
export type FolderItem = {
  key: string
  /** `1: ` while the digits are live, `y: ` on For you; '' keeps the column. */
  prefix: string
  title: string
  /** Unread chats that are not muted; null or 0 draws none. */
  unread: number | null
  /** The first pane view: the `─ pane views ─` line goes above it. */
  isFirstView: boolean
  note: string
}

/** Pads or cuts `text` to `width` cells. */
function fit(text: string, width: number): string {
  const room = Math.max(1, width)
  if (cells(text) <= room) return text + ' '.repeat(room - cells(text))
  let out = ''
  for (const char of text) {
    if (cells(out + char) > room - 1) break
    out += char
  }
  return `${out}…${' '.repeat(Math.max(0, room - cells(out) - 1))}`
}

function FolderRow({ Button, Text }: Els, item: FolderItem, props: { width: number; isCursor: boolean; isStatic: boolean; onOpen: () => void }): RenderElement {
  const count = item.unread === null || item.unread === 0 ? '' : String(item.unread)
  const name = `${item.prefix}${item.title}${item.note === '' ? '' : `  ${item.note}`}`
  const body = [
    <Text color={TOKEN.accent}>{props.isCursor ? `${GLYPH.cursor} ` : '  '}</Text>,
    <Text>{fit(name, props.width - 2 - 4)}</Text>,
    <Text bold>{count.padStart(4)}</Text>,
  ]
  if (props.isStatic) {
    return <Text key={item.key}>{...body}</Text>
  }
  return (
    <Button key={item.key} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onOpen}>
      {...body}
    </Button>
  )
}

/**
 * `h` from Chats: every folder with its count, `shared` on shared ones, the
 * Archive, then the pane views under their own line. The dock gives it one
 * column; inline lays it out in two, so 15 folders fit 12 rows.
 */
export function FoldersList(
  els: Els,
  props: {
    items: readonly FolderItem[]
    cursor: number
    start: number
    rows: number
    columns: 1 | 2
    width: number
    mode: 'active' | 'static'
    onOpen: (index: number) => void
  },
): RenderElement[] {
  const { Box, Text } = els
  const perColumn = Math.max(1, props.rows)
  // The pane-views line takes one row of the room.
  const shown = props.items.slice(props.start, props.start + Math.max(1, perColumn * props.columns - 1))
  const columnWidth = props.columns === 1 ? props.width : Math.floor((props.width - 2) / 2)
  const draw = (item: FolderItem, index: number) => {
    const at = props.start + index
    const row = FolderRow(els, item, { width: columnWidth, isCursor: props.mode === 'active' && at === props.cursor, isStatic: props.mode === 'static', onOpen: () => props.onOpen(at) })
    if (!item.isFirstView) return [row]
    const line = (
      <Text key={`${item.key}:line`} color={TOKEN.accent} dimColor wrap="truncate-end">
        {'─ pane views '.padEnd(Math.max(1, columnWidth), '─')}
      </Text>
    )
    return [line, row]
  }
  if (props.columns === 1) return shown.flatMap(draw)
  // The pane-views line takes a row of whichever column it falls in.
  const firstView = shown.findIndex(item => item.isFirstView)
  const leftCount = firstView >= 0 && firstView < perColumn ? perColumn - 1 : perColumn
  const left = shown.slice(0, leftCount)
  const right = shown.slice(leftCount)
  return [
    <Box key="folders:columns" flexDirection="row" columnGap={2}>
      <Box key="folders:left" flexDirection="column" width={columnWidth}>
        {...left.flatMap((item, index) => draw(item, index))}
      </Box>
      <Box key="folders:right" flexDirection="column" width={columnWidth}>
        {...right.flatMap((item, index) => draw(item, leftCount + index))}
      </Box>
    </Box>,
  ]
}

/** One row of For you as drawn: an agent's item or a person's chat; `isGone` once it was sent, dropped or closed. */
export type ForYouItem = {
  key: string
  section: 'agents' | 'people'
  glyph: string
  glyphColor?: string
  name: string
  /** `draft`, `sent`, `mentions you`, `asks you`, `fyi`. */
  label: string
  text: string
  /** `e` on a draft: the row is its field, in the row's place. */
  isEditing: boolean
  right: string
  isGone: boolean
}

const NAME = 14
const LABEL = 13

/** Cells a For you row gives its text: a draft whose whole text fits them is read whole (decision 9); a longer one opens its row. */
export function forYouTextRoom(width: number, right: string): number {
  return Math.max(10, width - 2 - 2 - NAME - LABEL - right.length - 1)
}

function ForYouRow(els: Els, item: ForYouItem, props: { width: number; isCursor: boolean; isStatic: boolean; onPress: () => void; onSave: (text: string) => void }): RenderElement {
  const { Box, Button, Text } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (item.isEditing && Input !== undefined && !props.isStatic) {
    return <Input key={`${item.key}:edit`} label={`draft for ${item.name}`} value={item.text} submitLabel="keep" onSubmit={value => props.onSave(value)} />
  }
  const room = forYouTextRoom(props.width, item.right)
  const head = [
    <Text color={TOKEN.accent}>{props.isCursor ? `${GLYPH.cursor} ` : '  '}</Text>,
    <Text color={item.glyphColor}>{item.glyph} </Text>,
    <Text dimColor={item.isGone}>{fit(item.name, NAME)}</Text>,
    <Text color={item.section === 'agents' && !item.isGone ? TOKEN.warn : undefined} dimColor={item.section === 'people' || item.isGone}>
      {fit(item.label, LABEL)}
    </Text>,
  ]
  const text = <Text dimColor={item.isGone}>{fit(`"${oneLine(item.text, room - 2)}"`, room)}</Text>
  const body = [...head, text, <Text dimColor> {item.right}</Text>]
  if (props.isStatic) return <Box key={item.key} flexDirection="row">{...body}</Box>
  return (
    <Button key={item.key} plain autoFocus={props.isCursor ? true : undefined} onPress={props.onPress}>
      {...body}
    </Button>
  )
}

/**
 * `y`: what waits for the owner, in every folder (§5.3). The agents' items
 * first, then people ranked with why; each section under its own line.
 */
export function ForYouList(
  els: Els,
  props: {
    items: readonly ForYouItem[]
    cursor: number
    start: number
    rows: number
    width: number
    mode: 'active' | 'idle' | 'static'
    isRanking: boolean
    onPress: (index: number) => void
    onSave: (index: number, text: string) => void
  },
): RenderElement[] {
  const { Text } = els
  const agents = props.items.filter(item => item.section === 'agents').length
  const line = (key: string, label: string) => (
    <Text key={key} color={TOKEN.accent} dimColor wrap="truncate-end">
      {`─ ${label} `.padEnd(Math.max(1, props.width), '─')}
    </Text>
  )
  const shown = props.items.slice(props.start, props.start + Math.max(1, props.rows))
  const out: RenderElement[] = []
  shown.forEach((item, index) => {
    const at = props.start + index
    if (at === 0 && item.section === 'agents') out.push(line('fy:agents', `agents wait · ${agents}`))
    if (item.section === 'people' && (at === 0 || props.items[at - 1]?.section === 'agents')) out.push(line('fy:people', 'people wait · ranked'))
    out.push(
      ForYouRow(els, item, {
        width: props.width,
        isCursor: props.mode !== 'idle' && at === props.cursor,
        isStatic: props.mode === 'static',
        onPress: () => props.onPress(at),
        onSave: text => props.onSave(at, text),
      }),
    )
  })
  if (props.isRanking) out.push(<Text key="fy:ranking" dimColor>{`  ${GLYPH.working} ranking people waiting`}</Text>)
  return out
}
