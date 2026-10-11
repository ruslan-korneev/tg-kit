// The pane's frame (docs/design/dialogs-pane-ux.md §4.3, §4.4, §7.3): the
// header with the location, the state summary and who holds the keys; the
// folder strip; the action bar (with the marks count) and the menu read from
// ./keys; the inline notice row; and the slot the open view fills. Plain functions over the
// surface's element table, as ./components draws; handlers come in as closures.
import type { RenderElement } from 'claude-code'

import type { Notice } from '../../types'
import type { Els } from './components'
import { MENU_GROUPS, type MenuGroup, type MenuSection, type RunKey, type ShownKey } from './keys'
import { GLYPH, TOKEN, type SummaryParts } from './model'

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
 * The folder strip (§4.7, §7.3): Telegram's folders in its order, then For you
 * and Bots, the current one marked `‹Work 3›`, `+N` for the ones past an edge.
 * The tabs are text, not ring stops: a pass changes their counts, and inline
 * the header's summary changes the room they get, both while the cursor stays,
 * so stops here would move the ring (§4.3 rule 1). Their digits are Buttons
 * the frame keeps undrawn under the bar (`DigitKeys`), live while the cursor
 * is in Chats; `h` lists every folder as pressable rows. The dock adds `↑N`
 * (what waits for the owner's move) and `s: search` at the right.
 */
export function Strip(
  { Box, Text, Button }: Els,
  props: {
    tabs: readonly { text: string; isCurrent: boolean }[]
    /** Entries past the left and the right edge. */
    before: number
    after: number
    query: string
    /** Chats waiting to move (§8 T9); drawn dim in the dock, where the strip has its own row. */
    waiting: number
    /** `…` while the folder list or the pass is on its way (§7.4). */
    isLoading: boolean
    /** The dock draws `s: search` here (`key`), or the Button alone over a layer (`click`); inline has it in the action bar. */
    search: 'key' | 'click' | 'none'
    onSearch: () => void
  },
): RenderElement {
  return (
    <Box key="strip" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexDirection="row" columnGap={2} flexShrink={1} overflow="hidden">
        {props.before > 0 ? <Text dimColor>{`+${props.before}`}</Text> : null}
        {props.tabs.map((tab, index) =>
          tab.isCurrent ? (
            <Text key={`tab:${index}`} color={TOKEN.accent} bold wrap="truncate-end">
              {tab.text}
            </Text>
          ) : (
            <Text key={`tab:${index}`} wrap="truncate-end">
              {tab.text}
            </Text>
          ),
        )}
        {props.after > 0 ? <Text dimColor>{`+${props.after}`}</Text> : null}
        {props.isLoading ? <Text dimColor>{GLYPH.working}</Text> : null}
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        {props.query === '' ? null : <Text dimColor>{`"${props.query}"`}</Text>}
        {props.search === 'none' || props.waiting === 0 ? null : <Text dimColor>{`↑${props.waiting}`}</Text>}
        {props.search === 'none' ? null : (
          <Button key="key:search" plain hotkey={props.search === 'key' ? 's' : undefined} dimColor onPress={props.onSearch}>
            search
          </Button>
        )}
      </Box>
    </Box>
  )
}

/** Cells the dock strip's right side takes: `"query"`, `↑N`, `s: search`; the tabs get the rest. */
export function stripRight(query: string, waiting: number): number {
  return (query === '' ? 0 : query.length + 3) + (waiting === 0 ? 0 : String(waiting).length + 2) + 'search'.length + 3 + 2
}

/**
 * The strip's digits while they are live: Buttons in a Box the surface does
 * not show, as HiddenKeys are. They sit under the bar, so no ring stop above
 * the list depends on them.
 */
export function DigitKeys({ Box, Button }: Els, props: { digits: readonly { digit: number; title: string; onPress: () => void }[] }): RenderElement {
  return (
    <Box key="keys:digits" display="none">
      {props.digits.map(one => (
        <Button key={`digit:${one.digit}`} plain hotkey={String(one.digit)} onPress={one.onPress}>
          {one.title}
        </Button>
      ))}
    </Box>
  )
}

/** One key of the bar: `k: label`, or `⏎ label` for the cursor row's action (a click does it too). */
function BarKey({ Button, Text }: Els, key: ShownKey, isFocused: boolean, onKey: (id: RunKey) => void): RenderElement {
  const press = () => onKey(key.id)
  if (key.hotkey === null) {
    // `⏎ open` has a hidden twin on o, keyed key:open: this one is the click's.
    return (
      <Button key={key.button ?? (key.id === 'open' ? 'key:open:enter' : `key:${key.id}`)} plain dimColor={!isFocused} onPress={press}>
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

/**
 * The bar: the verbs for the cursor row (≤ 7, from ./keys), dim while another
 * site holds the keys. `lead` (`▪ 3 marked`) comes first: the marks ride the
 * bar's row, so marking never takes a row from the thread (§4.3 rule 1, T4b).
 */
export function ActionBar(
  els: Els,
  props: {
    keys: readonly ShownKey[]
    lead: string | null
    /** `1-9: folder` after the first key, where the rows carry the digits (the Folders list, §4.6). */
    digits?: string | null
    isFocused: boolean
    onKey: (id: RunKey) => void
  },
): RenderElement {
  const { Box, Text } = els
  const keys = props.keys.map(key => BarKey(els, key, props.isFocused, props.onKey))
  const digits =
    props.digits === undefined || props.digits === null ? null : (
      <Text key="bar:digits" dimColor={!props.isFocused}>
        {props.digits}
      </Text>
    )
  return (
    <Box key="bar" flexDirection="row" columnGap={2}>
      {props.lead === null ? null : (
        <Text key="bar:lead" color={TOKEN.accent}>
          {props.lead}
        </Text>
      )}
      {keys.slice(0, 1)}
      {digits}
      {keys.slice(1)}
    </Box>
  )
}

/**
 * The hotkeys a drawn tree already binds, read off its Buttons: the bar's,
 * the hidden keys', and the ones its content draws (a message's buttons, the
 * sheet's intents, the card's levels, the strip's digits).
 */
export function hotkeysIn(nodes: readonly unknown[]): Set<string> {
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const one of node) walk(one)
      return
    }
    if (typeof node !== 'object' || node === null) return
    if ('props' in node && typeof node.props === 'object' && node.props !== null && 'hotkey' in node.props && typeof node.props.hotkey === 'string') found.add(node.props.hotkey)
    if ('children' in node) walk(node.children)
  }
  walk(nodes)
  return found
}

/**
 * The keys nothing in this view binds, each a Button in a Box the surface
 * does not show: a press says where the key works instead of falling through
 * to the prompt, which would take the keys with it (the T9 review's M1).
 */
export function StrayKeys({ Box, Button }: Els, props: { keys: readonly string[]; onKey: (key: string) => void }): RenderElement {
  return (
    <Box key="keys:stray" display="none">
      {props.keys.map(key => (
        <Button key={`stray:${key}`} plain hotkey={key} onPress={() => props.onKey(key)}>
          {key}
        </Button>
      ))}
    </Box>
  )
}

/** The bar's lead while messages are marked: `▪ 3 marked`. */
export function marksLead(count: number): string | null {
  return count === 0 ? null : `${GLYPH.marked} ${count} marked`
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
              // Not pressable: a Box carries the key, as a Text keeps none. A quiet one names no step.
              if (entry.needs !== null) {
                return (
                  <Box key={`menu:${def.id}`}>
                    <Text dimColor>{entry.isQuiet ? head : `${head} · ${entry.needs}`}</Text>
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

/** One notice row, inline (the dock's ride the running strip's row): what the last action brought back. `d` dismisses it. */
export function NoticeRow({ Box, Text }: Els, props: { notice: Notice }): RenderElement {
  return (
    <Box key="notice">
      <Text color={NOTICE_COLOR[props.notice.tone]} wrap="wrap">
        {props.notice.text}
      </Text>
    </Box>
  )
}

/**
 * The frame: header, the running strip (dock), the folder strip, the view's
 * slot, the notice row (inline), the bar or a layer in its row. Docked, the root takes the room's rows, so the bar sits at
 * the bottom and a slot taller than its room is cut, never the bar. Inline
 * the engine fits the frame to what it holds (seen live: a 12-row room drew 9
 * rows for 7 chats), so the windows are sized to the room instead.
 */
export function Frame(
  { Box }: Els,
  props: {
    rows: number
    header: RenderElement
    /** The dock's running strip (./activity), while something runs or was just stopped. */
    running: RenderElement | null
    strip: RenderElement | null
    slot: readonly RenderElement[]
    /** Inline: the notice row, when a notice shows. */
    notice: RenderElement | null
    bar: RenderElement
    hidden: RenderElement
    /** The strip's digits while live (DigitKeys). */
    digits?: RenderElement | null
    /** Every other key, caught (StrayKeys). */
    stray?: RenderElement | null
  },
): RenderElement {
  return (
    <Box key="frame" flexDirection="column" height={Math.max(3, props.rows)}>
      {props.header}
      {props.running}
      {props.strip}
      <Box key="slot" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {...props.slot}
      </Box>
      {props.notice}
      {props.bar}
      {props.hidden}
      {props.digits ?? null}
      {props.stray ?? null}
    </Box>
  )
}
