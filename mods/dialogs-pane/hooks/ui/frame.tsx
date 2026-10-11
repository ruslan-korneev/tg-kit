// The pane's frame (docs/design/dialogs-pane-ux.md §10.5, with §4.3's ring
// rules): the uppercase header, the dock's legend row (which carries the
// notices and what runs), the section cards, START HERE, the key line, the
// menu, the inline notice row, and the hidden keys. Plain functions over the
// surface's element table, as ./components draws; colours come in as `Colors`
// (./palette), handlers as closures.
import type { RenderElement } from 'claude-code'

import type { Notice } from '../../types'
import type { Els } from './components'
import { MENU_GROUPS, type MenuGroup, type MenuSection, type RunKey, type ShownKey } from './keys'
import { GLYPH, flagLetters, graphemes, labelCells } from './model'
import type { Colors, Role } from './palette'
import { STOP_LABEL, STRIP_SEP, type StripItem } from './running'

/** `ctrl+x tab: keys` leads the key line while the keys are elsewhere (§10.5 "Focus, by colour"). */
export const KEYS_ELSEWHERE = 'ctrl+x tab: keys'

// --- the section card ---

/**
 * A card's border: `cursor` is the card that holds ▸ while the pane holds the
 * keys (`accent`); `section` is any other card in its section's role; `away`
 * is every card while the keys are elsewhere (`surface`).
 */
export type CardBorder = 'cursor' | 'section' | 'away'

/** Rows a card adds around its content: the top and the bottom border. */
export const CARD_CHROME = 2
/** Cells a card takes from its width: a border and a pad on each side. */
export const CARD_INNER = 4

export type TitlePart = { text: string; role?: Role; bold?: boolean }

/** `title` cut to `room` cells, part by part, the last kept part ending in …. */
export function fitTitle(parts: readonly TitlePart[], room: number): TitlePart[] {
  const out: TitlePart[] = []
  let used = 0
  for (const one of parts) {
    // A chat's or a topic's name rides in titles: its flags as letters (flagLetters).
    const part = { ...one, text: flagLetters(one.text) }
    const width = labelCells(part.text)
    if (used + width <= room) {
      out.push(part)
      used += width
      continue
    }
    let cut = ''
    for (const glyph of graphemes(part.text)) {
      if (labelCells(`${cut}${glyph}`) > room - used - 1) break
      cut += glyph
    }
    if (room - used >= 1) out.push({ ...part, text: `${cut}…` })
    break
  }
  return out
}

/** Cells the title may take in a card `width` wide with this corner: `╭─ ` title ` ─…─ ` corner ` ─╮`. */
export function titleRoom(width: number, corner: string | null): number {
  const cornerCells = corner === null || corner === '' ? 0 : labelCells(corner) + 2 + 1
  return Math.max(0, width - 2 - 1 - 2 - 1 - cornerCells)
}

/**
 * A rounded box the pane's width, its title over the top edge in the section's
 * role and one dim label at its top right (§10.5 "Section cards"). The border
 * is a full round one and the title and the corner are Boxes laid over its top
 * edge (`position="absolute"`): the engine refuses `borderTop` (P2, §10.11).
 * The content is exactly `rows` rows: each child is one terminal row, and what
 * does not fit is cut, so a card's height never follows its content.
 */
export function Card(
  { Box, Text }: Els,
  props: {
    key: string
    colors: Colors
    /** The section's role: its title, and its border while it is `section`. */
    role: Role
    /** The title's role when it is not the border's (LOG: `subtext` on a `surface` border). */
    titleRole?: Role
    title: string | readonly TitlePart[]
    corner?: string | null
    border: CardBorder
    width: number
    /** Content rows; the card is `rows + CARD_CHROME` tall. */
    rows: number
    children: readonly RenderElement[]
  },
): RenderElement {
  const { colors } = props
  const borderRole: Role = props.border === 'cursor' ? 'accent' : props.border === 'away' ? 'surface' : props.role
  const titleRole = props.titleRole ?? props.role
  const corner = props.corner ?? null
  const parts = typeof props.title === 'string' ? [{ text: props.title, bold: true }] : props.title
  const title = fitTitle(parts, titleRoom(props.width, corner))
  const height = Math.max(0, props.rows) + CARD_CHROME
  return (
    <Box key={props.key} flexDirection="column" width={props.width} height={height} flexShrink={0}>
      <Box flexDirection="column" borderStyle="round" borderColor={colors[borderRole]} paddingX={1} width={props.width} height={height} overflow="hidden">
        {...props.children}
      </Box>
      {title.length === 0 ? null : (
        <Box position="absolute" top={0} left={2}>
          <Text color={colors[titleRole]}>
            {' '}
            {...title.map((part, index) => (
              <Text key={`title:${index}`} color={colors[part.role ?? titleRole]} bold={part.bold === true}>
                {part.text}
              </Text>
            ))}{' '}
          </Text>
        </Box>
      )}
      {corner === null || corner === '' ? null : (
        <Box position="absolute" top={0} right={2}>
          <Text color={colors.dim}>{` ${corner} `}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The CHATS card's title (§10.5, §4.7): `CHATS  Personal  Work 15  Bots  ›`,
 * the current tab bold in `accent`, `‹` and `›` for the tabs past each edge.
 * No digit is drawn: the digits are hidden Buttons (DigitKeys), and `h` lists
 * every folder as pressable rows. A search shows its query instead of tabs.
 */
export function chatsTitle(props: { tabs: readonly string[]; current: number; start: number; end: number; query: string }): TitlePart[] {
  const head: TitlePart = { text: 'CHATS', bold: true }
  if (props.query !== '') return [head, { text: `  "${props.query}"`, role: 'text' }]
  const shown = props.tabs.slice(props.start, props.end).flatMap((text, index): TitlePart[] => {
    const at = props.start + index
    return [{ text: '  ' }, at === props.current ? { text, role: 'accent', bold: true } : { text, role: 'text' }]
  })
  return [
    head,
    ...(props.start > 0 ? [{ text: '  ‹', role: 'dim' as const }] : []),
    ...shown,
    ...(props.end < props.tabs.length ? [{ text: '  ›', role: 'dim' as const }] : []),
  ]
}

/** Cells `CHATS` and its gaps take before the tabs. */
export const CHATS_HEAD = 'CHATS'.length

// --- the header ---

/** What the header counts (§10.5 "The header"). */
export type HeaderCounts = {
  /** Unread chats that are not muted (§4.5). */
  unread: number
  /** Unread mentions of the owner. */
  mentions: number
  /** Drafts and hard stops waiting for the owner. */
  forYou: number
  /** Chats with an autopilot or delegate agent on: the AUTOPILOT card's lanes. */
  agents: number
  /** An agent holds something for the owner: AUTOPILOT draws in `held`. */
  isHolding: boolean
  /** Chats followed into main or an agent (`p`): `⌁ N`, dim and word-less. */
  follows: number
  /** New messages in watched chats. */
  watched: number
}

/**
 * The header's parts, zero ones left out: `TG · 15 UNREAD · 2 FOR YOU ·
 * AUTOPILOT 2 CHATS · ⌁ 1 · ◎ 3 NEW`. `@N` stands in for FOR YOU when that
 * part is out. `short` drops AUTOPILOT's `CHATS`, as the 44-column dock does.
 */
export function headerParts(counts: HeaderCounts, short = false): TitlePart[] {
  const parts: TitlePart[] = [{ text: 'TG', role: 'accent', bold: true }]
  if (counts.unread > 0) parts.push({ text: `${counts.unread} UNREAD`, role: 'unread' })
  if (counts.forYou > 0) parts.push({ text: `${counts.forYou} FOR YOU`, role: 'mention' })
  else if (counts.mentions > 0) parts.push({ text: `@${counts.mentions}`, role: 'mention' })
  if (counts.agents > 0) parts.push({ text: `AUTOPILOT ${counts.agents}${short ? '' : ' CHATS'}`, role: counts.isHolding ? 'held' : 'ok' })
  if (counts.follows > 0) parts.push({ text: `${GLYPH.pinned} ${counts.follows}`, role: 'dim' })
  if (counts.watched > 0) parts.push({ text: `◎ ${counts.watched} NEW`, role: 'subtext' })
  return parts
}

const HEADER_SEP = ' · '

/** Cells the header's parts take, separators included. */
export function headerCells(parts: readonly TitlePart[]): number {
  return parts.reduce((sum, part, index) => sum + labelCells(part.text) + (index === 0 ? 0 : HEADER_SEP.length), 0)
}

/**
 * The top row (§10.5): the uppercase summary, `…` while something loads, and
 * `TG ⚠` in `unread` on an error. Where the pane is goes to the card titles,
 * and who holds the keys to the borders and the key line.
 */
export function Header({ Box, Text }: Els, props: { colors: Colors; counts: HeaderCounts; isLoading: boolean; isError: boolean; width: number }): RenderElement {
  const { colors } = props
  const full = headerParts(props.counts)
  const parts = props.isError ? [{ text: `TG ${GLYPH.error}`, role: 'unread' as const, bold: true }] : headerCells(full) + 2 > props.width ? headerParts(props.counts, true) : full
  return (
    <Box key="header" flexDirection="row">
      <Text wrap="truncate-end">
        {...parts.map((part, index) => (
          <Text key={`hdr:${index}`} color={colors[part.role ?? 'text']} bold={part.bold === true}>
            {`${index === 0 ? '' : HEADER_SEP}${part.text}`}
          </Text>
        ))}
        {props.isLoading ? <Text color={colors.dim}>{` ${GLYPH.working}`}</Text> : null}
      </Text>
    </Box>
  )
}

// --- the legend row ---

/** The legend's sections in the dock's order, each `■` in its role (§10.5 "The legend row"). */
export const LEGEND: readonly { word: string; role: Role }[] = [
  { word: 'for you', role: 'mention' },
  { word: 'chats', role: 'person' },
  { word: 'autopilot', role: 'ok' },
  { word: 'log', role: 'surface' },
]

/** Under this many columns the legend gives way whenever anything else needs the row. */
export const LEGEND_MIN = 52

const NOTICE_ROLE: Record<Notice['tone'], Role> = { info: 'text', warn: 'held', danger: 'unread' }

/**
 * The dock's row under the header, always kept (§4.3 rule 1): a notice, else
 * what runs while the AUTOPILOT card is folded, else the legend. `0: stop all`
 * at the right while something runs and the AUTOPILOT card is not on screen.
 * Text only: no ring stop; the `0` Button is the frame's hidden one.
 */
export function LegendRow(
  { Box, Text }: Els,
  props: {
    colors: Colors
    notice: Notice | null
    /** What runs, while the AUTOPILOT card is folded; null otherwise. */
    running: { shown: readonly StripItem[]; more: number } | null
    /** `0: stop all` here, not in the AUTOPILOT card's corner. */
    isStop: boolean
    width: number
  },
): RenderElement {
  const { colors } = props
  const stop = props.width < LEGEND_MIN ? '0: stop' : STOP_LABEL
  const left =
    props.notice !== null ? (
      // A Box keyed `notice`, as inline's notice row is (a Text keeps no key): one notice, wherever the seat draws it.
      <Box key="notice" flexShrink={1}>
        <Text color={colors[NOTICE_ROLE[props.notice.tone]]} wrap="truncate-end">
          {props.notice.text}
        </Text>
      </Box>
    ) : props.running !== null && props.running.shown.length > 0 ? (
      <Text wrap="truncate-end">
        {...props.running.shown.map((item, index) => (
          <Text key={`running:${item.key}`} color={item.isHeld ? colors.held : colors.text}>
            {`${index === 0 ? '' : STRIP_SEP}${item.text}`}
          </Text>
        ))}
        {props.running.more === 0 ? null : <Text color={colors.dim}>{` +${props.running.more}`}</Text>}
      </Text>
    ) : props.isStop && props.width < LEGEND_MIN ? null : (
      <Text wrap="truncate-end">
        {...LEGEND.map((one, index) => (
          <Text key={`legend:${one.word}`}>
            <Text color={colors[one.role]}>{`${index === 0 ? '' : '  '}■`}</Text>
            <Text color={colors.dim}>{` ${one.word}`}</Text>
          </Text>
        ))}
      </Text>
    )
  return (
    <Box key="legend" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1}>{left}</Box>
      {props.isStop ? (
        <Box flexShrink={0}>
          <Text color={colors.unread}>{stop}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

// --- the key line ---

/** One key of the line: `k: label`, or `⏎ label` for the cursor row's action (a click does it too). */
function LineKey({ Button }: Els, key: ShownKey, hasKeys: boolean, onKey: (id: RunKey) => void): RenderElement {
  const press = () => onKey(key.id)
  if (key.hotkey === null) {
    // `⏎ open` has a hidden twin on o, keyed key:open: this one is the click's.
    return (
      <Button key={key.button ?? (key.id === 'open' ? 'key:open:enter' : `key:${key.id}`)} plain autoFocus={key.isRinged} dimColor={!hasKeys} onPress={press}>
        {`⏎ ${key.label}`}
      </Button>
    )
  }
  return (
    <Button key={`key:${key.id}`} plain hotkey={key.hotkey} dimColor={!hasKeys} onPress={press}>
      {key.label}
    </Button>
  )
}

/**
 * The key line, the pane's last row (§10.5): the verbs for the cursor row in
 * §4.6's order, as many as fit, `m: menu` last (./keys `actionBar`). It is
 * the one row that draws keys, below every list, so its Buttons never sit
 * above the cursor. `lead` (`▪ 3 marked`) comes first: the marks ride this
 * row, so marking never takes a row from the thread (T4b). Without the keys
 * it starts with `ctrl+x tab: keys` and dims (P8: hotkey letters stay lit).
 */
export function KeyLine(
  els: Els,
  props: {
    colors: Colors
    keys: readonly ShownKey[]
    lead: string | null
    /** `1-9: folder` after the first key, where the rows carry the digits (the Folders list, §4.6). */
    digits?: string | null
    hasKeys: boolean
    onKey: (id: RunKey) => void
  },
): RenderElement {
  const { Box, Text } = els
  const { colors } = props
  const keys = props.keys.map(key => LineKey(els, key, props.hasKeys, props.onKey))
  const digits =
    props.digits === undefined || props.digits === null ? null : (
      <Text key="bar:digits" color={props.hasKeys ? colors.text : colors.dim}>
        {props.digits}
      </Text>
    )
  return (
    <Box key="bar" flexDirection="row" columnGap={2}>
      {props.hasKeys ? null : (
        <Text key="bar:keys" color={colors.dim}>
          {KEYS_ELSEWHERE}
        </Text>
      )}
      {props.lead === null ? null : (
        <Text key="bar:lead" color={colors.accent}>
          {props.lead}
        </Text>
      )}
      {keys.slice(0, 1)}
      {digits}
      {keys.slice(1)}
    </Box>
  )
}

/** Cells the key line has left for its keys: `ctrl+x tab: keys` takes its own while the keys are elsewhere. */
export function keyLineRoom(width: number, hasKeys: boolean): number {
  return hasKeys ? width : width - KEYS_ELSEWHERE.length - 2
}

// --- the hidden keys ---

/**
 * The strip's digits while they are live: Buttons in a Box the surface does
 * not show, as HiddenKeys are. They sit under the key line, so no ring stop
 * above the list depends on them.
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

/**
 * The hotkeys a drawn tree already binds, read off its Buttons: the key
 * line's, the hidden keys', and the ones its content draws (a message's
 * buttons, the sheet's intents, the card's levels, the digits).
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

/** The key line's lead while messages are marked: `▪ 3 marked`. */
export function marksLead(count: number): string | null {
  return count === 0 ? null : `${GLYPH.marked} ${count} marked`
}

/**
 * The live keys the key line does not draw, kept pressable in a Box the
 * surface does not show: a hotkey presses its Button whether or not it is
 * shown (checked live on 2.1.296), so the menu can list them instead.
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

// --- the menu ---

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
export function Menu(els: Els, props: { colors: Colors; sections: readonly MenuSection[]; onKey: (id: RunKey) => void }): RenderElement {
  const { Box, Text, Button } = els
  const { colors } = props
  const row = (key: string, label: string, body: RenderElement) => (
    <Box key={`menu:row:${key}`} flexDirection="row">
      <Box width={LABEL_COLUMN} flexShrink={0}>
        <Text color={colors.dim}>{label}</Text>
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
                    <Text color={colors.dim}>{entry.isQuiet ? head : `${head} · ${entry.needs}`}</Text>
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
                  {/* 0 is drawn in `unread` while it has something to stop, as in the legend row and the AUTOPILOT corner (§10.2). */}
                  {def.id === 'stop' ? <Text color={colors.unread}>{entry.label}</Text> : def.hotkey === null ? head : entry.label}
                </Button>
              )
            })}
          </Box>,
        ),
      )}
      {row('keys', 'keys', <Text color={colors.dim} wrap="wrap">only while a card's border is lit; ctrl+x tab hands them over, Esc gives them back to the prompt</Text>)}
    </Box>
  )
}

// --- START HERE ---

/** START HERE's lines (§4.4, §10.5): the keys that matter, in the order a first visit needs them. */
export const START_LINES = [
  '⏎ opens a chat · ⏎ on a message sends it to Claude',
  '1-9: your Telegram folders · h: all of them · y: for you',
  'a: hand a chat to an agent · w: notify me · 0: stop all',
] as const

/** Content rows START HERE takes. */
export const START_ROWS = START_LINES.length

/**
 * The first open's START HERE card, until `d` (§4.4, §10.5). Text only: it
 * draws no ring stop, and `d` is the table's dismiss key, kept live by the
 * frame's hidden keys, so neither drawing it nor putting it away moves a stop.
 */
export function StartCard(els: Els, props: { colors: Colors; width: number; border: CardBorder }): RenderElement {
  const { Text } = els
  return Card(els, {
    key: 'start',
    colors: props.colors,
    role: 'accent',
    title: 'START HERE',
    corner: 'd: got it',
    border: props.border === 'cursor' ? 'section' : props.border,
    width: props.width,
    rows: START_ROWS,
    children: START_LINES.map(line => (
      <Text key={`start:${line.slice(0, 3)}`} wrap="truncate-end">
        {line}
      </Text>
    )),
  })
}

// --- the frame ---

/** One notice row, inline (the dock's ride the legend row): what the last action brought back. `d` dismisses it. */
export function NoticeRow({ Box, Text }: Els, props: { colors: Colors; notice: Notice }): RenderElement {
  return (
    <Box key="notice">
      <Text color={props.colors[NOTICE_ROLE[props.notice.tone]]} wrap="wrap">
        {props.notice.text}
      </Text>
    </Box>
  )
}

/**
 * The frame: the header, the legend row (dock), the cards, the notice row
 * (inline), the key line or a layer in its row. Docked, the root takes the
 * room's rows, so the key line sits at the bottom and a slot taller than its
 * room is cut, never the line. Inline the engine fits the frame to what it
 * holds (seen live: a 12-row room drew 9 rows for 7 chats), so the cards are
 * sized to the room instead.
 */
export function Frame(
  { Box }: Els,
  props: {
    rows: number
    header: RenderElement
    /** The dock's legend row (LegendRow); its row is always kept. */
    legend: RenderElement | null
    slot: readonly RenderElement[]
    /** Inline: the notice row, when a notice shows. */
    notice: RenderElement | null
    bar: RenderElement
    hidden: RenderElement
    /** The folder digits while live (DigitKeys). */
    digits?: RenderElement | null
    /** Every other key, caught (StrayKeys). */
    stray?: RenderElement | null
  },
): RenderElement {
  return (
    <Box key="frame" flexDirection="column" height={Math.max(3, props.rows)}>
      {props.header}
      {props.legend}
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
