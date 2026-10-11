// The AUTOPILOT and LOG cards (§10.6, T14) and Activity
// (docs/design/dialogs-pane-ux.md §5.6, §5.7), drawn from ./running in the
// frame's section Card (T13). Plain functions over the surface's element
// table, as ./components draws; colours come in as `Colors` (§10.2), handlers
// as closures.
//
// The cards sit beside the lists and change as things start and stop, mostly
// while the cursor stays: they draw no ring stop, so the stops above the
// cursor row keep their count (§4.3 rule 1). `0: stop all` is a label; the `0`
// Button is the frame's hidden one, and the menu's.
import type { Color, RenderElement } from 'claude-code'

import type { Els } from './components'
import { CARD_INNER, Card, type CardBorder } from './frame'
import { GLYPH } from './model'
import type { Colors, Role } from './palette'
import {
  STOP_LABEL,
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
} from './running'

const colorOf = (colors: Colors, role: Role | null): Color | undefined => (role === null ? undefined : colors[role])

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

// --- the AUTOPILOT and LOG cards, in T13's section Card (./frame) ---

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
