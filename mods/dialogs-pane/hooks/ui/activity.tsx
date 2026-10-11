// The dock's running strip, which carries the notices too (T4b), the AUTOPILOT
// and LOG cards (§10.6, T14) and Activity (docs/design/dialogs-pane-ux.md §5.6,
// §5.7), drawn from ./running. Plain functions over the surface's element
// table, as ./components draws; colours come in as `Colors` (§10.2), handlers
// as closures.
//
// The strip and the cards sit above or beside the lists and change as things
// start and stop, mostly while the cursor stays: they draw no ring stop, so the
// stops above the cursor row keep their count (§4.3 rule 1). `0: stop all` is
// a label; the `0` Button is the frame's hidden one, and the menu's.
import type { Color, RenderElement } from 'claude-code'

import type { Notice } from '../../types'
import type { Els } from './components'
import { GLYPH } from './model'
import type { Colors, Role } from './palette'
import {
  STOP_LABEL,
  STRIP_SEP,
  autopilotRows,
  autopilotTitle,
  gaugeLine,
  gaugeSegs,
  laneLine,
  logLine,
  stripLine,
  type AutopilotCard,
  type Gauge,
  type LogRow,
  type Seg,
  type StripItem,
} from './running'

const NOTICE_ROLE: Record<Notice['tone'], Role | null> = { info: null, warn: 'held', danger: 'unread' }

const colorOf = (colors: Colors, role: Role | null): Color | undefined => (role === null ? undefined : colors[role])

/**
 * The dock's row under the header: a notice when there is one (a write's
 * result, `… pressing`, what `0` stopped, a draft that waits), else what runs;
 * `0: stop all` at the right while something runs, either way (T4b).
 */
export function RunningStrip(
  { Box, Text }: Els,
  props: { colors: Colors; shown: readonly StripItem[]; more: number; notice: Notice | null; isRunning: boolean },
): RenderElement {
  const left =
    props.notice !== null ? (
      <Box key="notice" flexShrink={1}>
        <Text color={colorOf(props.colors, NOTICE_ROLE[props.notice.tone])} wrap="truncate-end">
          {props.notice.text}
        </Text>
      </Box>
    ) : (
      <Text wrap="truncate-end">
        {...props.shown.map((item, index) => (
          <Text key={`running:${item.key}`} color={item.isHeld ? props.colors.held : undefined}>
            {`${index === 0 ? '' : STRIP_SEP}${item.text}`}
          </Text>
        ))}
        {props.more === 0 ? null : <Text dimColor>{` +${props.more}`}</Text>}
      </Text>
    )
  return (
    <Box key="running" flexDirection="row" justifyContent="space-between" columnGap={2}>
      {left}
      {props.isRunning ? (
        // The kill switch is in `unread`, key and all (§10.2): it is the one red thing the strip says.
        <Text color={props.colors.unread}>{STOP_LABEL}</Text>
      ) : null}
    </Box>
  )
}

/** One row of segments, each in its role; `isStale` draws the row dim (a section that emptied keeps its last state, §10.5). */
function SegRow({ Box, Text }: Els, colors: Colors, segs: readonly Seg[], key: string, isStale = false): RenderElement {
  return (
    <Box key={key}>
      <Text wrap="truncate-end" dimColor={isStale || undefined}>
        {...segs.map((seg, index) => (
          <Text key={`${key}:${index}`} color={isStale ? undefined : colorOf(colors, seg.role)}>
            {seg.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/** `▰▰▱▱▱ 12/50`: the gauge as one run of Text, for the compact card (T15) to draw after its `⚡`. */
export function GaugeBar(els: Els, colors: Colors, props: { gauge: Gauge }): RenderElement {
  return SegRow(els, colors, gaugeSegs(props.gauge), 'gauge')
}

// --- the section card ---
// T13's `Card` (./frame) takes this place once it lands: the same props, so only the import changes.

export type CardBorder = 'cursor' | 'section' | 'away'

/**
 * A rounded card the full width given, its title and corner laid over the top
 * edge (P2: `borderTop` is refused, an absolute Box at top 0 draws over it).
 * `rows` content rows, padded or cut to exactly that.
 */
export function Card(
  { Box, Text }: Els,
  props: {
    key: string
    colors: Colors
    role: Role
    titleRole?: Role
    title: string
    corner?: string | null
    border: CardBorder
    width: number
    rows: number
    children: readonly RenderElement[]
  },
): RenderElement {
  const border = props.border === 'cursor' ? props.colors.accent : props.border === 'away' ? props.colors.surface : props.colors[props.role]
  const shown = props.children.slice(0, props.rows)
  const pad = Array.from({ length: props.rows - shown.length }, (_, index) => <Text key={`${props.key}:pad:${index}`}> </Text>)
  return (
    <Box key={props.key} flexDirection="column" width={props.width}>
      <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} width={props.width}>
        {...shown}
        {...pad}
      </Box>
      <Box position="absolute" top={0} left={2}>
        <Text color={props.colors[props.titleRole ?? props.role]} bold>{` ${props.title} `}</Text>
      </Box>
      {props.corner === undefined || props.corner === null ? null : (
        <Box position="absolute" top={0} right={2}>
          <Text dimColor>{` ${props.corner} `}</Text>
        </Box>
      )}
    </Box>
  )
}

/** Card width from its inner width: a border and a pad cell each side. */
const CARD_INNER = 4
/** Under this pane width the corner reads `0: stop` (§10.5, 44 columns). */
const STOP_WIDE = 52

/**
 * The AUTOPILOT card (§10.6): the gauge, the cell strip, a lane per chat on.
 * `rows` is what the frame granted for this layout generation: fewer lanes
 * than that pad, more are cut and counted in the title. `width` is the inner
 * width. `isStopCorner`: the card carries `0: stop all` (the legend row does
 * not). No ring stops.
 */
export function AutopilotSection(
  els: Els,
  props: { colors: Colors; width: number; rows: number; border: CardBorder; isStopCorner: boolean; card: AutopilotCard; isStale?: boolean; maxLanes?: number },
): RenderElement {
  const { colors, width, card } = props
  const isStale = props.isStale === true
  const laneRoom = Math.max(0, props.rows - 2)
  const shown = card.lanes.slice(0, Math.min(laneRoom, props.maxLanes ?? laneRoom))
  const corner = props.isStopCorner ? (width + CARD_INNER >= STOP_WIDE ? STOP_LABEL : '0: stop') : null
  return Card(els, {
    key: 'card:autopilot',
    colors,
    role: 'ok',
    title: autopilotTitle(card.lanes.length, shown.length, width),
    corner,
    border: props.border,
    width: width + CARD_INNER,
    rows: props.rows,
    children: [
      SegRow(els, colors, gaugeLine(card.gauge, width), 'ap:gauge', isStale),
      SegRow(els, colors, stripLine(card.entries, width), 'ap:strip', isStale),
      ...shown.map(lane => SegRow(els, colors, laneLine(lane, width), `ap:lane:${lane.peer.id}`, isStale)),
    ],
  })
}

/** The LOG card (§10.6): newest first, as many as the granted rows hold; `l: all` opens Activity. No ring stops. */
export function LogSection(els: Els, props: { colors: Colors; width: number; rows: number; border: CardBorder; log: readonly LogRow[] }): RenderElement {
  return Card(els, {
    key: 'card:log',
    colors: props.colors,
    role: 'surface',
    titleRole: 'subtext',
    title: 'LOG',
    corner: 'l: all',
    border: props.border,
    width: props.width + CARD_INNER,
    rows: props.rows,
    children: props.log.slice(0, props.rows).map(row => SegRow(els, props.colors, logLine(row, props.width), row.key)),
  })
}

/**
 * Activity (`l`): what runs, one Button a chat (⏎ opens its card or its
 * chat), the chats watched, then the AUTOPILOT card with every lane and the
 * LOG card to the bottom. The cards are Text: they change in the background,
 * so as Buttons their rows would move under the ring.
 */
export function Activity(
  els: Els,
  props: {
    colors: Colors
    rows: readonly { id: number; text: string; isStopped: boolean }[]
    cursor: number
    watching: string | null
    card: AutopilotCard | null
    log: readonly LogRow[]
    rowsLeft: number
    width: number
    onOpen: (index: number) => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const { colors } = props
  const inner = props.width - CARD_INNER
  const apRows = props.card === null ? 0 : autopilotRows(props.card.lanes.length, Number.POSITIVE_INFINITY)
  const above = Math.max(1, props.rows.length) + (props.watching === null ? 0 : 1) + (apRows === 0 ? 0 : apRows + 2)
  const logRows = Math.max(1, props.rowsLeft - above - 2)
  return (
    <Box key="activity" flexDirection="column">
      {props.rows.length === 0 ? <Text color={colors.dim}>Nothing runs. a on a chat hands it to an agent; p follows it into main.</Text> : null}
      {...props.rows.map((row, index) => (
        <Button key={`act:${row.id}`} plain autoFocus={index === props.cursor ? true : undefined} dimColor={row.isStopped} onPress={() => props.onOpen(index)}>
          <Text color={colors.accent}>{index === props.cursor ? `${GLYPH.cursor} ` : '  '}</Text>
          <Text>{row.text}</Text>
        </Button>
      ))}
      {props.watching === null ? null : (
        <Text color={colors.dim} wrap="truncate-end">
          {`  ◎  ${'watching'.padEnd(14)} ${props.watching}`}
        </Text>
      )}
      {props.card === null ? null : AutopilotSection(els, { colors, width: inner, rows: apRows, border: 'section', isStopCorner: false, card: props.card })}
      {props.log.length === 0 ? (
        <Text color={colors.dim} wrap="truncate-end">
          Nothing logged yet: packets, bursts, drafts and hard stops show here.
        </Text>
      ) : (
        LogSection(els, { colors, width: inner, rows: logRows, border: 'section', log: props.log })
      )}
    </Box>
  )
}
