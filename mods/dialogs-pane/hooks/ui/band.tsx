// The band above the prompt (docs/design/dialogs-pane-ux.md §4.5, §5, §8 T5):
// one item of the queue at a time, two rows tall, with `1/3  j: next` while
// more wait. Every item draws its ⏎ action as its first Button, so after `j`,
// `k` or an item leaving, the ring (which keeps its place among the Buttons,
// §1) is on the new item's ⏎; `j` and `k` are hidden Buttons after it.
// A draft takes its second row whole, at the band's full width, so a draft
// that fits sends with one ⏎ (decision 9); a longer one opens its row in the pane. Keys reach the band once it holds
// them (ctrl+x tab or a click); typed at the prompt they are text.
// Also the transcript's cards for `/tg help` and `/tg status` (§4.4).
import type { RenderElement } from 'claude-code'

import { LEVEL_GLYPH } from '../autopilot/config'
import { undoLeft } from '../autopilot/ledger'
import { latencyText } from '../triage/live'
import type { Els } from './components'
import { GLYPH, oneLine, peerConfirmLabel } from './model'
import type { Colors } from './palette'
import type { Seg } from './running'
import { COMPACT_NARROW, COMPACT_WIDTH, DRAFT_LEAD, compactStatusText, draftFits, positionText, type BandItem, type CompactStatus } from './queue'

/** The band's width from which a draft's row 1 also draws `ctrl+x tab ›` and `o: open`; under it `o` stays a hidden key. */
export const WIDE_BAND = 90

export type BandActions = {
  /** ⏎: the item's action. */
  primary: () => void
  open: () => void
  dismiss: () => void
  edit: () => void
  save: (text: string) => void
  next: () => void
  prev: () => void
}

export type BandProps = {
  item: BandItem
  index: number
  count: number
  width: number
  now: number
  /** A reply's ⏎: `send to main as Fix`; null where the band cannot tell who wrote (a group's count that grew): ⏎ opens. */
  sendAs: string | null
  /** A watched bot reply's latency, when known. */
  latencyMs: number | null
  on: BandActions
}

const HINT = 'ctrl+x tab ›'

export function BandItemView(els: Els, colors: Colors, props: BandProps): RenderElement {
  switch (props.item.kind) {
    case 'draft':
      return DraftItem(els, colors, props, props.item)
    case 'hold':
      return Item(els, props, {
        title: titleText(els, '⏸', colors.held, `HARD STOP ${props.item.stops.join(' + ')}: ${oneLine(props.item.what, 200)}`),
        detail: `${LEVEL_GLYPH.delegate} ${peerConfirmLabel(props.item.peer)} · answer in the dialog`,
        primary: { key: 'band:hold:open', label: '⏎ open' },
        keys: [],
        hidden: ['o'],
      })
    case 'undo': {
      const { undo } = props.item
      const conf = undo.confidence === null ? '' : ` · conf ${undo.confidence.toFixed(2)}`
      return Item(els, props, {
        title: titleText(els, LEVEL_GLYPH.auto, colors.ok, `${peerConfirmLabel(undo.peer)} replied "${oneLine(undo.text, 200)}"${conf}`),
        detail: null,
        primary: { key: 'ap:band:undo-press', label: `undo ${undoLeft(undo, props.now)}s`, hotkey: 'u' },
        keys: [{ key: 'ap:band:undo-dismiss', label: 'ok', hotkey: 'd', run: props.on.dismiss }],
        hidden: ['o'],
      })
    }
    case 'reply': {
      const { event } = props.item
      const isBot = event.kind === 'bot'
      const latency = props.latencyMs === null ? '' : ` ${GLYPH.latency}${latencyText(props.latencyMs)}`
      const said = isBot ? `${event.label} replied${latency}` : event.label
      return Item(els, props, {
        title: titleText(els, isBot ? GLYPH.bot : GLYPH.unread, isBot ? colors.bot : colors.accent, `${said}: "${oneLine(event.text, 200)}"`),
        detail: null,
        primary: { key: 'band:main', label: props.sendAs === null ? '⏎ open' : `⏎ send to main as ${props.sendAs}` },
        keys: [
          ...(props.sendAs === null ? [] : [{ key: 'band:open', label: 'open', hotkey: 'o', run: props.on.open } as const]),
          { key: 'band:dismiss', label: 'dismiss', hotkey: 'd', run: props.on.dismiss } as const,
        ],
        hidden: props.sendAs === null ? ['o'] : [],
      })
    }
    case 'summary':
      return Item(els, props, {
        title: titleText(els, LEVEL_GLYPH.listen, colors.accent, `${props.item.note.peer.label}: ${oneLine(props.item.note.text, 400)}`),
        detail: null,
        primary: { key: 'ap:note:open', label: '⏎ open' },
        keys: [{ key: 'ap:note:dismiss', label: 'dismiss', hotkey: 'd', run: props.on.dismiss }],
        hidden: ['o'],
      })
    case 'task': {
      const { task } = props.item
      const ended = task.status === 'done' ? `${GLYPH.done} task done` : `${GLYPH.error} task failed`
      return Item(els, props, {
        title: titleText(els, LEVEL_GLYPH.delegate, task.status === 'done' ? colors.ok : colors.unread, `${task.peer.label} · ${ended}: ${oneLine(task.reason, 200)}`),
        detail: null,
        primary: { key: 'band:task:open', label: '⏎ open' },
        keys: [{ key: 'band:task:dismiss', label: 'dismiss', hotkey: 'd', run: props.on.dismiss }],
        hidden: ['o'],
      })
    }
  }
}

function titleText({ Text }: Els, glyph: string, color: Colors[keyof Colors], text: string): RenderElement {
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{`${glyph} `}</Text>
      {text}
    </Text>
  )
}

type Key = { key: string; label: string; hotkey: 'd' | 'e' | 'o'; run: () => void }

/** Row 1: what happened, and where it is in the queue; row 2: `ctrl+x tab ›`, ⏎ first, then its keys. */
function Item(
  els: Els,
  props: BandProps,
  parts: { title: RenderElement; detail: string | null; primary: { key: string; label: string; hotkey?: 'u' }; keys: readonly Key[]; hidden: readonly ('o' | 'e')[] },
): RenderElement {
  const { Box, Text, Button } = els
  const position = positionText(props.index, props.count)
  return (
    <Box key="band" flexDirection="column">
      <Box key="band:row1" flexDirection="row" columnGap={2}>
        <Box flexGrow={1} flexShrink={1}>
          {parts.title}
        </Box>
        {position === null ? null : <Text dimColor>{position}</Text>}
      </Box>
      <Box key="band:row2" flexDirection="row" columnGap={2}>
        <Text dimColor>{`  ${HINT}`}</Text>
        <Button key={parts.primary.key} plain autoFocus hotkey={parts.primary.hotkey} onPress={props.on.primary}>
          {parts.primary.label}
        </Button>
        {parts.keys.map(one => (
          <Button key={one.key} plain hotkey={one.hotkey} dimColor onPress={one.run}>
            {one.label}
          </Button>
        ))}
        {parts.detail === null ? null : (
          <Text dimColor wrap="truncate-end">
            {parts.detail}
          </Text>
        )}
      </Box>
      {HiddenNav(els, props, parts.hidden)}
    </Box>
  )
}

/**
 * A draft: the message it answers and why it waits on row 1, with its keys;
 * the draft alone on row 2, the band's full width. ⏎ sends it when its whole
 * text shows there and the guard's verdict allows it; a longer one, or one
 * the guard has not allowed yet, opens its chat on its row, the one place a
 * draft is read whole and sent (§8 T3, decision 9). `e` swaps row 2 for the
 * field; the band keeps its two rows.
 */
function DraftItem(els: Els, colors: Colors, props: BandProps, item: Extract<BandItem, { kind: 'draft' }>): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { draft } = item
  const isWide = props.width >= WIDE_BAND
  const canSend = draft.canSend && draftFits(draft.text, props.width)
  const position = positionText(props.index, props.count)
  const isEditing = draft.isEditing && Input !== undefined
  const verdict = draft.verdict.tone === 'ok' ? null : draft.verdict
  // While the field is up it is the only ring stop: its keys type into it.
  const keys = isEditing
    ? []
    : [
        isWide ? <Text dimColor>{HINT}</Text> : null,
        <Button key="ap:draft:send" plain autoFocus onPress={props.on.primary}>
          {canSend ? '⏎ send' : '⏎ open'}
        </Button>,
        <Button key="ap:draft:edit" plain hotkey="e" dimColor onPress={props.on.edit}>
          edit
        </Button>,
        <Button key="ap:draft:drop" plain hotkey="d" dimColor onPress={props.on.dismiss}>
          drop
        </Button>,
        isWide ? (
          <Button key="ap:draft:open" plain hotkey="o" dimColor onPress={props.on.open}>
            open
          </Button>
        ) : null,
      ]
  return (
    <Box key="band" flexDirection="column">
      <Box key="band:row1" flexDirection="row" columnGap={2}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={colors.held}>{`${LEVEL_GLYPH.draft} `}</Text>
            {`${peerConfirmLabel(draft.peer)}: "${oneLine(draft.incoming, 200)}"${draft.why === '' ? '' : ` · ${draft.why}`}`}
          </Text>
        </Box>
        {verdict === null ? null : (
          <Text color={verdict.tone === 'danger' ? colors.unread : undefined} dimColor={verdict.tone === 'dim'} wrap="truncate-end">
            {verdict.text}
          </Text>
        )}
        {...keys}
        {position === null ? null : <Text dimColor>{position}</Text>}
      </Box>
      {isEditing && Input !== undefined ? (
        <Input key="ap:draft:text" label="draft" value={draft.text} submitLabel="save" autoFocus onSubmit={value => props.on.save(value)} />
      ) : (
        <Box key="band:row2">
          <Text wrap="truncate-end">{`${DRAFT_LEAD}${oneLine(draft.text, Infinity)}`}</Text>
        </Box>
      )}
      {isEditing ? null : HiddenNav(els, props, isWide ? [] : ['o'])}
    </Box>
  )
}

/** The keys the item does not draw: `j` and `k` while more wait, and `o` where it is not drawn. Never drawn, pressed all the same (§6). */
function HiddenNav(els: Els, props: BandProps, hidden: readonly ('o' | 'e')[]): RenderElement {
  const { Box, Button } = els
  const isQueue = props.count > 1
  return (
    <Box key="band:keys" display="none">
      {hidden.includes('o') ? (
        <Button key="band:key:o" plain hotkey="o" onPress={props.on.open}>
          open
        </Button>
      ) : null}
      {isQueue ? (
        <Button key="band:next" plain hotkey="j" onPress={props.on.next}>
          next
        </Button>
      ) : null}
      {isQueue ? (
        <Button key="band:prev" plain hotkey="k" onPress={props.on.prev}>
          previous
        </Button>
      ) : null}
    </Box>
  )
}

export type CompactActions = {
  /** ⏎ on the status line, where no row is drawn: the pane, Wide. */
  open: () => void
  /** `q`: the card goes, the footer label stays (Hidden). */
  hide: () => void
  /** `j` (+1) and `k` (-1) between the two rows. */
  move: (by: 1 | -1) => void
}

export type CompactProps = {
  /** The band's `bodyColumns`. */
  width: number
  status: CompactStatus
  /** `▰▰▱▱▱ 12/50` (T14's `gaugeSegs`) and its pair for the one-line form, while an agent is on; `segs` null with no limit (`on`). */
  gauge: { segs: readonly Seg[] | null; pair: string } | null
  /** The chat rows, drawn for `compactInner(width)` cells, the ringed one a Button; left out under an item and in one line. */
  rows: readonly RenderElement[]
  /** A band item shows above: the card keeps its status line, and ⏎ `j` `k` are the item's. */
  isUnderItem: boolean
  on: CompactActions
}

/** The card's width (§10.7): statuspane's, `min(46, bodyColumns − 2)`. */
export function compactWidth(width: number): number {
  return Math.min(COMPACT_WIDTH, width - 2)
}

/** Cells inside the card's border and padding: what a row is drawn for. */
export function compactInner(width: number): number {
  return compactWidth(width) - 4
}

/**
 * The compact card above the prompt (§10.7): right-aligned and narrow, as
 * statuspane's, `tg` in its top border and `⏎ open · q: hide` in its bottom
 * one (P2's absolute Boxes, P3). A status line, then the two chat rows. Under
 * 40 columns, one borderless line. Exactly one ring stop: the ringed row, else
 * the status line; under a band item, none (⏎ is the item's). `q` is a hidden
 * Button; `j` and `k` are hidden ones while two rows show (§6, no digits: §11).
 */
export function CompactCard(els: Els, colors: Colors, props: CompactProps): RenderElement {
  const { Box, Text, Button } = els
  const isNarrow = props.width < COMPACT_NARROW
  const status = compactStatusText(props.status, isNarrow)
  const dot = status.role === null ? null : <Text color={colors[status.role]}>{status.text.slice(0, 1)}</Text>
  const words = <Text color={status.role === null ? colors.dim : colors.text}>{status.role === null ? status.text : status.text.slice(1)}</Text>
  // One line has no room for rows, and under an item the card is its status line alone.
  const rows = isNarrow || props.isUnderItem ? [] : props.rows
  const isStatusStop = rows.length === 0 && !props.isUnderItem
  const keys = (
    <Box key="compact:keys" display="none">
      <Button key="compact:hide" plain hotkey="q" onPress={props.on.hide}>
        hide
      </Button>
      {rows.length > 1 ? (
        <Button key="compact:down" plain hotkey="j" onPress={() => props.on.move(1)}>
          down
        </Button>
      ) : null}
      {rows.length > 1 ? (
        <Button key="compact:up" plain hotkey="k" onPress={() => props.on.move(-1)}>
          up
        </Button>
      ) : null}
    </Box>
  )
  if (isNarrow) {
    const line = (
      <Text wrap="truncate-end">
        <Text color={colors.accent}>tg</Text>
        <Text color={colors.dim}> · </Text>
        {dot}
        {words}
        {props.gauge === null ? null : <Text color={colors.ok}>{` · ${GLYPH.agent} ${props.gauge.pair}`}</Text>}
      </Text>
    )
    return (
      <Box key="compact" justifyContent="flex-end" paddingRight={1}>
        {props.isUnderItem ? (
          <Box key="compact:status">{line}</Box>
        ) : (
          <Button key="compact:open" plain autoFocus onPress={props.on.open}>
            {line}
          </Button>
        )}
        {keys}
      </Box>
    )
  }
  const width = compactWidth(props.width)
  // One Text, so the line also reads as a Button's label: ● and its words, then the gauge three cells on.
  const statusRow = (
    <Text wrap="truncate-end">
      {dot}
      {words}
      {props.gauge === null ? null : <Text color={colors.ok}>{`   ${GLYPH.agent} `}</Text>}
      {props.gauge === null
        ? null
        : (props.gauge.segs ?? [{ text: props.gauge.pair, role: 'text' }]).map((seg, index) => (
            <Text key={`compact:gauge:${index}`} color={seg.role === null ? undefined : colors[seg.role]}>
              {seg.text}
            </Text>
          ))}
    </Text>
  )
  return (
    <Box key="compact" justifyContent="flex-end" paddingRight={1}>
      <Box key="compact:card" width={width} flexDirection="column">
        <Box width={width} flexDirection="column" borderStyle="round" borderColor={colors.surface} paddingX={1}>
          {isStatusStop ? (
            <Button key="compact:open" plain autoFocus onPress={props.on.open}>
              {statusRow}
            </Button>
          ) : (
            <Box key="compact:status">{statusRow}</Box>
          )}
          {...rows}
          {keys}
        </Box>
        <Box position="absolute" top={0} left={2}>
          <Text color={colors.accent} bold>
            {' tg '}
          </Text>
        </Box>
        <Box position="absolute" bottom={0} left={2}>
          <Text color={colors.dim}>{' ⏎ open · q: hide '}</Text>
        </Box>
      </Box>
    </Box>
  )
}

/** `/tg help` and `/tg status` in the transcript: the command's text as a card, its first line the title. */
export function CommandCard({ Box, Text }: Els, colors: Colors, text: string): RenderElement {
  const [title = 'tg', ...lines] = text.split('\n')
  return (
    <Box key="tg:card" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={colors.accent}>
        {title}
      </Text>
      {lines.map((line, index) => (
        <Text key={`tg:card:${index}`} wrap="truncate-end">
          {line === '' ? ' ' : line}
        </Text>
      ))}
    </Box>
  )
}
