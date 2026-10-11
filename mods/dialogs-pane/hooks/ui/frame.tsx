// The pane's frame (docs/design/dialogs-pane-ux.md §4.3, §4.4, §7.3): the
// header with the location, the state summary and who holds the keys; the
// folder strip; the action bar and the menu read from ./keys; one notice row;
// the marks line; and the slot the open view fills. Plain functions over the
// surface's element table, as ./components draws; handlers come in as closures.
import type { RenderElement } from 'claude-code'

import type { Lens, Notice, SavedLens } from '../../types'
import type { Els } from './components'
import { MENU_GROUPS, type MenuGroup, type MenuSection, type RunKey, type ShownKey } from './keys'
import { GLYPH, LENSES, LENS_LABEL, TOKEN, type SummaryParts } from './model'

const FOCUS_HELD = '● keys'
const FOCUS_ELSEWHERE = 'ctrl+x tab: keys'

/** The top row: where the pane is, what runs (§4.5), and who holds the keys. */
export function Header(
  { Box, Text }: Els,
  props: {
    location: string
    /** Inline Chats: the strip shares this row and gives way to the summary. */
    strip?: RenderElement | null
    summary: SummaryParts
    /** `● rec 3` while recording: state of the open chat, not of the pane. */
    chips: readonly { text: string; color?: string }[]
    isFocused: boolean
  },
): RenderElement {
  const { summary } = props
  return (
    <Box key="header" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexDirection="row" columnGap={2} flexShrink={1}>
        <Text color={TOKEN.accent} bold wrap="truncate-end">
          {props.location}
        </Text>
        {props.strip ?? null}
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        {props.chips.map(chip => (
          <Text key={`chip:${chip.text}`} color={chip.color}>
            {chip.text}
          </Text>
        ))}
        {summary.levels === '' ? null : <Text dimColor>{summary.levels}</Text>}
        {summary.watched === '' ? null : <Text dimColor>{`${summary.levels === '' ? '' : '· '}${summary.watched}`}</Text>}
        {summary.forYou === '' ? null : <Text color={TOKEN.warn}>{`${summary.levels === '' && summary.watched === '' ? '' : '· '}${summary.forYou}`}</Text>}
        <Text> </Text>
        {props.isFocused ? <Text color={TOKEN.accent}>{FOCUS_HELD}</Text> : <Text dimColor>{FOCUS_ELSEWHERE}</Text>}
      </Box>
    </Box>
  )
}

/**
 * The lens strip, Telegram folders' place until T9 brings them: the built-in
 * lenses and the saved ones, the current one marked. Their digits are live only
 * while the cursor is in Chats (`isLive`); elsewhere a click still picks one.
 */
export function Strip(
  { Box, Text, Button }: Els,
  props: {
    lens: Lens
    lenses: readonly SavedLens[]
    /** The saved lens shown, or null for the built-in one in `lens`. */
    active: string | null
    firstSavedDigit: number
    isRanked: boolean
    query: string
    isLive: boolean
    /** The dock draws `s: search` here; inline has it in the action bar. */
    hasSearchKey: boolean
    onLens: (lens: Lens) => void
    onSaved: (id: string) => void
    onSearch: () => void
  },
): RenderElement {
  const tab = (key: string, digit: number, name: string, isCurrent: boolean, onPress: () => void) => (
    <Button key={key} plain hotkey={props.isLive ? String(digit) : undefined} dimColor={!isCurrent} onPress={onPress}>
      {isCurrent ? <Text color={TOKEN.accent} bold>{`‹${name}›`}</Text> : name}
    </Button>
  )
  return (
    <Box key="strip" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexDirection="row" columnGap={2} flexShrink={1}>
        {LENSES.map((lens, index) => tab(`lens:${lens}`, index + 1, LENS_LABEL[lens], props.active === null && lens === props.lens, () => props.onLens(lens)))}
        {props.lenses.map((saved, index) => tab(`lens:saved:${saved.id}`, props.firstSavedDigit + index, saved.name, saved.id === props.active, () => props.onSaved(saved.id)))}
        {props.isRanked ? <Text color={TOKEN.accent}>you↑</Text> : null}
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        {props.query === '' ? null : <Text dimColor>{`"${props.query}"`}</Text>}
        {props.hasSearchKey ? (
          <Button key="key:search" plain hotkey="s" dimColor onPress={props.onSearch}>
            search
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}

/** One key of the bar: `k: label`, or `⏎ label` for the cursor row's action (a click does it too). */
function BarKey({ Button, Text }: Els, key: ShownKey, isFocused: boolean, onKey: (id: RunKey) => void): RenderElement {
  const press = () => onKey(key.id)
  if (key.hotkey === null) {
    // `⏎ open` has a hidden twin on o, keyed key:open: this one is the click's.
    return (
      <Button key={key.id === 'open' ? 'key:open:enter' : `key:${key.id}`} plain dimColor={!isFocused} onPress={press}>
        {`⏎ ${key.label}`}
      </Button>
    )
  }
  const label = key.id === 'stop' ? <Text color={TOKEN.danger}>{key.label}</Text> : key.label
  return (
    <Button key={`key:${key.id}`} plain hotkey={key.hotkey} dimColor={!isFocused} onPress={press}>
      {label}
    </Button>
  )
}

/** The bar: the verbs for the cursor row (≤ 7, from ./keys), dim while another site holds the keys. */
export function ActionBar(els: Els, props: { keys: readonly ShownKey[]; isFocused: boolean; onKey: (id: RunKey) => void }): RenderElement {
  const { Box } = els
  return (
    <Box key="bar" flexDirection="row" columnGap={2}>
      {props.keys.map(key => BarKey(els, key, props.isFocused, props.onKey))}
    </Box>
  )
}

/**
 * The live keys the bar does not draw, kept pressable in a Box the surface
 * does not show: a hotkey presses its Button whether or not it is shown
 * (checked live on 2.1.296), so the menu can list them instead of the bar.
 */
export function HiddenKeys({ Box, Button }: Els, props: { keys: readonly ShownKey[]; onKey: (id: RunKey) => void }): RenderElement {
  return (
    <Box key="keys:hidden" display="none">
      {props.keys.map(key => (
        <Button key={`key:${key.id}`} plain hotkey={key.hotkey ?? undefined} onPress={() => props.onKey(key.id)}>
          {key.label}
        </Button>
      ))}
    </Box>
  )
}

const GROUP_LABEL: Record<MenuGroup, string> = {
  move: 'move',
  message: 'message',
  chat: 'chat',
  chats: 'chats',
  pane: 'pane',
  safety: 'safety',
}

const LABEL_COLUMN = 10

/**
 * `m`: every key this view can use, grouped; each live label is a Button, so
 * the menu is also the palette. One that waits for a step is dim with it.
 */
export function Menu(els: Els, props: { sections: readonly MenuSection[]; onKey: (id: RunKey) => void }): RenderElement {
  const { Box, Text, Button } = els
  const row = (key: string, label: string, body: RenderElement) => (
    <Box key={`menu:row:${key}`} flexDirection="row">
      <Box width={LABEL_COLUMN} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {body}
    </Box>
  )
  const sections = MENU_GROUPS.flatMap(group => props.sections.filter(section => section.group === group))
  return (
    <Box key="menu" flexDirection="column">
      {row('move', GROUP_LABEL.move, <Text>j k ↑ ↓ · ⏎ does the row's action</Text>)}
      {...sections.map(section =>
        row(
          section.group,
          GROUP_LABEL[section.group],
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {section.entries.map(entry => {
              const { def } = entry
              const head = def.key === '' ? entry.label : def.hotkey === null ? `${def.key} ${entry.label}` : `${def.key}: ${entry.label}`
              // Not pressable: a Box carries the key, as a Text keeps none.
              if (entry.needs !== null) {
                return (
                  <Box key={`menu:${def.id}`}>
                    <Text dimColor>{`${head} · ${entry.needs}`}</Text>
                  </Box>
                )
              }
              if (def.isDigits === true) {
                return (
                  <Box key={`menu:${def.id}`}>
                    <Text>{`${def.key}: ${entry.label}`}</Text>
                  </Box>
                )
              }
              const id = def.id as RunKey
              return (
                <Button key={`menu:${def.id}`} plain hotkey={def.hotkey ?? undefined} onPress={() => props.onKey(id)}>
                  {def.hotkey === null ? head : entry.label}
                </Button>
              )
            })}
          </Box>,
        ),
      )}
      {row('keys', 'keys', <Text dimColor wrap="wrap">only while ● keys shows; ctrl+x tab hands them over, Esc gives them back to the prompt</Text>)}
    </Box>
  )
}

const NOTICE_COLOR: Record<Notice['tone'], string | undefined> = { info: undefined, warn: TOKEN.warn, danger: TOKEN.danger }

/** One notice row: what the last action brought back. `d` dismisses it. */
export function NoticeRow({ Box, Text }: Els, props: { notice: Notice }): RenderElement {
  return (
    <Box key="notice">
      <Text color={NOTICE_COLOR[props.notice.tone]} wrap="wrap">
        {props.notice.text}
      </Text>
    </Box>
  )
}

/** While messages are marked: how many, and that ⏎ sends them (the always-on tray is gone). */
export function MarksLine({ Box, Text }: Els, props: { count: number; isRangeOpen: boolean }): RenderElement {
  const range = props.isRangeOpen ? ' · v again ends the range' : ''
  return (
    <Box key="marks">
      <Text color={TOKEN.accent} wrap="truncate-end">
        {`${GLYPH.marked} ${props.count} marked · ⏎ sends them · h clears${range}`}
      </Text>
    </Box>
  )
}

/**
 * The frame: header, strip, what runs on top, the view's slot, the temporary
 * rows, the bar. Docked, the root takes the room's rows, so the bar sits at
 * the bottom and a slot taller than its room is cut, never the bar. Inline
 * the engine fits the frame to what it holds (seen live: a 12-row room drew 9
 * rows for 7 chats), so the windows are sized to the room instead.
 */
export function Frame(
  { Box }: Els,
  props: {
    rows: number
    header: RenderElement
    strip: RenderElement | null
    top: readonly RenderElement[]
    slot: readonly RenderElement[]
    temps: readonly RenderElement[]
    bar: RenderElement
    hidden: RenderElement
  },
): RenderElement {
  return (
    <Box key="frame" flexDirection="column" height={Math.max(3, props.rows)}>
      {props.header}
      {props.strip}
      {...props.top}
      <Box key="slot" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {...props.slot}
      </Box>
      {...props.temps}
      {props.bar}
      {props.hidden}
    </Box>
  )
}
