// The pane's one key table (docs/design/dialogs-pane-ux.md §3, §4.6, §6): every
// key, the views it serves, the kinds of chat it exists in, and when it works.
// The action bar, the menu and the hidden hotkeys are all read from it, so a
// letter means one thing everywhere, the band included. Pure.
//
// A key is in one of three states in a context (§4.6):
// - never here: its view or the chat's kind is not listed. Not drawn, not in
//   the menu, no hotkey.
// - not now: `needs` names the step it waits for. Listed dim in the menu with
//   that step; no hotkey.
// - here and now: in the action bar when it is one of this context's verbs,
//   otherwise a hotkey the frame keeps live without drawing it, and in the menu.
import type { SheetStep, TgPeerKind } from '../../types'

/** The kinds of chat §4.6 tells apart. */
export const CHAT_KINDS = ['bot', 'person', 'group', 'channel', 'saved', 'botfather'] as const
export type ChatKind = (typeof CHAT_KINDS)[number]

/** tg's peer kind as §4.6 reads it; BotFather is a bot chat the repo keeps read-only. */
export function chatKind(kind: TgPeerKind, isBotFather: boolean): ChatKind {
  switch (kind) {
    case 'bot':
      return isBotFather ? 'botfather' : 'bot'
    case 'user':
      return 'person'
    case 'self':
      return 'saved'
    case 'group':
    case 'supergroup':
      return 'group'
    case 'channel':
    // An unknown peer gets the fewest keys: nothing that writes.
    case 'unknown':
      return 'channel'
  }
}

export const CHAT_KIND_LABEL: Record<ChatKind, string> = {
  bot: 'bot',
  person: 'person',
  group: 'group',
  channel: 'channel',
  saved: 'saved',
  botfather: 'bot · ro',
}

/**
 * Where the keys act. `chats` and `chat` are the two columns (the cursor's);
 * the rest are layers drawn over the lower part (dock) or the body (inline).
 * `sheet` is the send sheet (§5.1) and the views it opens: targets, inspect, the
 * Ask field, a broadcast's legs.
 */
export const WHERES = ['chats', 'chat', 'sheet', 'card', 'activity', 'diff', 'editor', 'menu', 'band'] as const
export type Where = (typeof WHERES)[number]

export type Seat = 'dock' | 'inline'

export const MENU_GROUPS = ['move', 'message', 'chat', 'chats', 'pane', 'safety'] as const
export type MenuGroup = (typeof MENU_GROUPS)[number]

/** What the context holds right now: each fact turns some key on or off. */
export type KeyFacts = {
  /** Chats listed (chats), messages loaded (chat). */
  rows: number
  /** A follow, an autopilot or a Worker runs: `0` has something to stop. */
  isRunning: boolean
  /** Activity lists a delegate task that ended: `d` dismisses them. */
  hasFinished: boolean
  /** Seconds left to undo the last auto reply; 0 when no window is open. */
  undoLeft: number
  hasNotice: boolean
  marks: number
  isRangeOpen: boolean
  /** Two bot replies are marked: `f` has a pair. */
  hasPair: boolean
  /** A message in the open chat has buttons. */
  hasButtons: boolean
  isRecording: boolean
  isWatched: boolean
  isFollowed: boolean
  isRanked: boolean
  /** The summary of the chat the keys act on: what `t` does next. */
  summary: 'none' | 'loading' | 'ok' | 'error'
  isSavedLens: boolean
  /** The card's chat has its agent running: ⏎ stops it. */
  isAgentOn: boolean
  /** The send sheet's step while it is up (`broadcast`: the legs, from its targets), else null. */
  sheet: SheetStep | 'broadcast' | null
}

export type KeyContext = { where: Where; seat: Seat; kind: ChatKind | null; facts: KeyFacts }

export const NO_FACTS: KeyFacts = {
  rows: 0,
  isRunning: false,
  hasFinished: false,
  undoLeft: 0,
  hasNotice: false,
  marks: 0,
  isRangeOpen: false,
  hasPair: false,
  hasButtons: false,
  isRecording: false,
  isWatched: false,
  isFollowed: false,
  isRanked: false,
  summary: 'none',
  isSavedLens: false,
  isAgentOn: false,
  sheet: null,
}

type Def = {
  id: string
  /** What the person presses, as the menu writes it: a letter, `⏎`, a digit range. */
  key: string
  /** The Button hotkey: one lowercase letter or digit (the engine's rule), or null. */
  hotkey: string | null
  group: MenuGroup
  where: readonly Where[]
  /** The kinds of chat it exists in; `any` for keys of the pane, not of a chat. */
  kinds: readonly ChatKind[] | 'any'
  /** Views where it exists in every kind of chat even so: `a` picks another agent in any chat's send sheet. */
  anyKindIn?: readonly Where[]
  label: (c: KeyContext) => string
  /** The step it waits for, or null when it works now. */
  needs?: (c: KeyContext) => string | null
  /**
   * The menu while it waits: `quiet` lists it dim without the step (the safety
   * row teaches `0` and /tg stop in every chat); `hidden` leaves it out (`u`
   * means nothing until an auto reply goes out). Absent: dim, with the step.
   */
  whileWaiting?: 'quiet' | 'hidden'
  /** The menu's words, where they differ from the bar's. */
  menuLabel?: (c: KeyContext) => string
  /** Digits drawn next to their options (folders, levels, targets): the content draws them. */
  isDigits?: true
}

const PANE: readonly Where[] = ['chats', 'chat', 'sheet', 'card', 'activity', 'diff', 'editor']
const LISTS: readonly Where[] = ['chats', 'chat']
/** Views with a cursor that j and k move: the two columns, and Activity's running rows. */
const MOVES: readonly Where[] = [...LISTS, 'activity']
/** §4.6's "what exists in which chat" table, one constant per row. */
const WRITE: readonly ChatKind[] = ['bot', 'person', 'group', 'saved']
/** The chats the owner can write to: `n`, and the send sheet's Draft reply to a person (§4.6). */
export const CHAT_KIND_WRITE = WRITE
const AGENT: readonly ChatKind[] = ['bot', 'person', 'group', 'channel']
const WATCH: readonly ChatKind[] = ['bot', 'person', 'group', 'channel']
const BUTTONS: readonly ChatKind[] = ['bot', 'group', 'channel', 'botfather']

const SUMMARY_LABEL: Record<KeyFacts['summary'], string> = { none: 'summary', loading: 'cancel summary', ok: 'hide summary', error: 'retry summary' }

const noRows = (what: string) => (c: KeyContext) => (c.facts.rows === 0 ? `needs ${what}` : null)
/** The send sheet's own keys work on its intents; its other steps answer h. */
const onIntents = (c: KeyContext) => (c.facts.sheet === 'intents' ? null : 'needs the intents (h)')

export const KEYS = [
  { id: 'down', key: 'j', hotkey: 'j', group: 'move', where: MOVES, kinds: 'any', label: () => 'down' },
  { id: 'up', key: 'k', hotkey: 'k', group: 'move', where: MOVES, kinds: 'any', label: () => 'up' },
  {
    id: 'open',
    key: 'o',
    hotkey: 'o',
    group: 'chats',
    where: ['chats', 'activity', 'band'],
    kinds: 'any',
    label: () => 'open',
    needs: c => noRows(c.where === 'activity' ? 'something running' : 'a chat in the list')(c),
  },
  { id: 'send', key: '⏎', hotkey: null, group: 'message', where: ['chat'], kinds: 'any', label: () => 'send…', needs: noRows('a message') },
  { id: 'start', key: '⏎', hotkey: null, group: 'chat', where: ['card'], kinds: AGENT, label: c => (c.facts.isAgentOn ? 'stop' : 'start') },
  { id: 'mark', key: 'x', hotkey: 'x', group: 'message', where: ['chat'], kinds: 'any', label: () => 'mark', needs: noRows('a message') },
  { id: 'range', key: 'v', hotkey: 'v', group: 'message', where: ['chat'], kinds: 'any', label: c => (c.facts.isRangeOpen ? 'range end' : 'range'), needs: noRows('a message') },
  { id: 'whole', key: '', hotkey: null, group: 'message', where: ['chat'], kinds: 'any', label: () => 'mark the whole loaded thread', needs: noRows('a message') },
  {
    id: 'buttons',
    key: 'b',
    hotkey: 'b',
    group: 'message',
    where: ['chat'],
    kinds: BUTTONS,
    label: () => 'buttons',
    needs: c => (c.facts.hasButtons ? null : 'needs a message with buttons'),
  },
  {
    id: 'agent',
    key: 'a',
    hotkey: 'a',
    group: 'chat',
    where: [...LISTS, 'sheet'],
    kinds: AGENT,
    anyKindIn: ['sheet'],
    label: c => (c.where === 'sheet' ? 'another agent' : 'agent'),
    needs: c => (c.where === 'sheet' ? onIntents(c) : null),
  },
  { id: 'watch', key: 'w', hotkey: 'w', group: 'chat', where: LISTS, kinds: WATCH, label: c => (c.facts.isWatched ? 'unwatch' : 'watch') },
  { id: 'follow', key: 'p', hotkey: 'p', group: 'chat', where: ['chat'], kinds: AGENT, label: c => (c.facts.isFollowed ? 'unfollow' : 'follow → main') },
  { id: 'summary', key: 't', hotkey: 't', group: 'chat', where: LISTS, kinds: 'any', label: c => SUMMARY_LABEL[c.facts.summary] },
  { id: 'write', key: 'n', hotkey: 'n', group: 'chat', where: LISTS, kinds: WRITE, label: () => 'write' },
  { id: 'record', key: 'r', hotkey: 'r', group: 'chat', where: ['chat'], kinds: ['bot'], label: c => (c.facts.isRecording ? 'stop rec' : 'rec') },
  {
    id: 'diff',
    key: 'f',
    hotkey: 'f',
    group: 'chat',
    where: ['chat', 'diff'],
    kinds: ['bot'],
    label: c => (c.where === 'diff' ? 'close diff' : 'diff'),
    needs: c => (c.where === 'diff' || c.facts.hasPair ? null : 'needs two replies marked (x)'),
  },
  { id: 'lens', key: '1-9', hotkey: null, group: 'chats', where: ['chats'], kinds: 'any', label: () => 'lens', isDigits: true },
  { id: 'foryou', key: 'y', hotkey: 'y', group: 'chats', where: LISTS, kinds: 'any', label: c => (c.facts.isRanked ? 'keep the list order' : 'who needs you first') },
  // From a chat too: search looks at every chat, not at the one open.
  { id: 'search', key: 's', hotkey: 's', group: 'chats', where: LISTS, kinds: 'any', label: () => 'search' },
  { id: 'lenses', key: 'z', hotkey: 'z', group: 'chats', where: ['chats', 'editor'], kinds: 'any', label: c => (c.where === 'chats' && c.facts.isSavedLens ? 'edit lens' : 'save lens') },
  { id: 'level', key: '1-4', hotkey: null, group: 'chat', where: ['card'], kinds: AGENT, label: () => 'level', isDigits: true },
  // In a chat, i opens the send sheet on inspect for the cursor's message or the marks.
  {
    id: 'inspect',
    key: 'i',
    hotkey: 'i',
    group: 'message',
    where: ['chat', 'sheet'],
    kinds: 'any',
    label: () => 'inspect',
    needs: c => (c.where === 'chat' ? noRows('a message')(c) : onIntents(c)),
  },
  { id: 'intents', key: '1-9', hotkey: null, group: 'message', where: ['sheet'], kinds: 'any', label: () => 'send as', needs: onIntents, isDigits: true },
  {
    id: 'target',
    key: '1-9',
    hotkey: null,
    group: 'message',
    where: ['sheet'],
    kinds: 'any',
    label: c => (c.facts.sheet === 'broadcast' ? 'leg on or off' : 'send to'),
    needs: c => (c.facts.sheet === 'targets' || c.facts.sheet === 'broadcast' ? null : 'needs a: another agent'),
    isDigits: true,
  },
  { id: 'edit', key: 'e', hotkey: 'e', group: 'chat', where: ['card', 'band'], kinds: 'any', label: c => (c.where === 'card' ? 'brief' : 'edit') },
  {
    id: 'dismiss',
    key: 'd',
    hotkey: 'd',
    group: 'pane',
    where: ['chat', 'card', 'activity', 'band'],
    kinds: 'any',
    label: c => (c.where === 'activity' ? 'dismiss ended tasks' : 'dismiss'),
    needs: c => (c.where === 'band' ? null : c.where === 'activity' ? (c.facts.hasFinished ? null : 'needs a task that ended') : c.facts.hasNotice ? null : 'needs a notice'),
  },
  {
    id: 'undo',
    key: 'u',
    hotkey: 'u',
    group: 'safety',
    where: [...PANE, 'band'],
    kinds: 'any',
    label: c => (c.facts.undoLeft > 0 ? `undo ${c.facts.undoLeft}s` : 'undo'),
    needs: c => (c.where === 'band' || c.facts.undoLeft > 0 ? null : 'needs an auto reply in its 30 s'),
    whileWaiting: 'hidden',
  },
  { id: 'activity', key: 'l', hotkey: 'l', group: 'pane', where: ['chats', 'chat', 'card'], kinds: 'any', label: () => 'activity' },
  { id: 'reload', key: 'g', hotkey: 'g', group: 'pane', where: LISTS, kinds: 'any', label: () => 'reload' },
  {
    id: 'back',
    key: 'h',
    hotkey: 'h',
    group: 'pane',
    where: ['chat', 'sheet', 'card', 'activity', 'diff', 'editor', 'menu'],
    kinds: 'any',
    label: c => (c.where === 'chat' ? (c.facts.marks > 0 || c.facts.isRangeOpen ? 'clear' : 'chats') : c.where === 'sheet' && c.facts.sheet === 'intents' ? 'cancel' : 'back'),
  },
  { id: 'menu', key: 'm', hotkey: 'm', group: 'pane', where: [...PANE, 'menu'], kinds: 'any', label: c => (c.where === 'menu' ? 'close' : 'menu') },
  { id: 'hide', key: 'q', hotkey: 'q', group: 'pane', where: PANE, kinds: 'any', label: () => 'hide' },
  {
    id: 'stop',
    key: '0',
    hotkey: '0',
    group: 'safety',
    where: PANE,
    kinds: 'any',
    label: () => 'stop all',
    needs: c => (c.facts.isRunning ? null : 'nothing runs'),
    whileWaiting: 'quiet',
    menuLabel: () => 'stop every agent and Worker · /tg stop',
  },
] as const satisfies readonly Def[]

export type KeyId = (typeof KEYS)[number]['id']
export type KeyDef = Def & { id: KeyId }
const TABLE: readonly KeyDef[] = KEYS

/** The ids a press runs: every key but the digit groups, which their options draw. */
export type RunKey = Exclude<KeyId, 'lens' | 'level' | 'intents' | 'target'>

export function keyDef(id: KeyId): KeyDef {
  const def = TABLE.find(one => one.id === id)
  // KeyId is derived from KEYS, so every id has its row.
  if (def === undefined) throw new Error(`no key ${id}`)
  return def
}

/** The key exists in this view and this kind of chat (never here otherwise). */
export function exists(def: KeyDef, c: KeyContext): boolean {
  if (!def.where.includes(c.where)) return false
  if (def.kinds === 'any' || def.anyKindIn?.includes(c.where) === true) return true
  return c.kind !== null && def.kinds.includes(c.kind)
}

/** The step a key waits for here, or null when it works now. */
export function needsOf(def: KeyDef, c: KeyContext): string | null {
  return def.needs === undefined ? null : def.needs(c)
}

export function isLive(def: KeyDef, c: KeyContext): boolean {
  return exists(def, c) && needsOf(def, c) === null
}

export type ShownKey = { id: RunKey; key: string; hotkey: string | null; label: string }

function shown(def: KeyDef, c: KeyContext): ShownKey {
  // Digit groups never reach here: they are in no bar and pressed by their options.
  return { id: def.id as RunKey, key: def.key, hotkey: def.hotkey, label: def.label(c) }
}

export const MAX_BAR = 7

/** §4.6 "the action bar, by context": the verbs after ⏎, in the order the owner reaches for them. */
const KIND_BAR: Record<ChatKind, readonly KeyId[]> = {
  bot: ['send', 'write', 'record', 'mark', 'diff', 'agent'],
  person: ['send', 'write', 'agent', 'watch', 'mark'],
  group: ['send', 'summary', 'watch', 'agent', 'write'],
  channel: ['send', 'summary', 'watch', 'agent', 'mark'],
  saved: ['send', 'write', 'mark'],
  botfather: ['send', 'summary', 'mark'],
}

function verbs(c: KeyContext): readonly KeyId[] {
  switch (c.where) {
    case 'chats':
      // The dock draws `s: search` on the strip; inline has no strip row to spare.
      return c.seat === 'inline' ? ['open', 'search', 'summary', 'watch', 'agent'] : ['open', 'summary', 'watch', 'agent']
    case 'chat':
      // Inline shows one view: the way back to the chats is a verb there.
      return [...(c.kind === null ? ['send' as const] : KIND_BAR[c.kind]), ...(c.seat === 'inline' ? ['back' as const] : [])]
    case 'sheet':
      return ['back']
    case 'card':
      return ['start', 'edit', 'activity', 'back']
    case 'activity':
      return ['open', 'dismiss', 'back']
    case 'editor':
      return ['back']
    case 'diff':
      return ['diff', 'back']
    case 'menu':
      return ['back']
    case 'band':
      return []
  }
}

/** Cells a key takes in the bar: `k: label`, or `⏎ label` for the cursor row's action. */
export function barCells(key: Pick<ShownKey, 'hotkey' | 'label'>): number {
  return key.hotkey === null ? key.label.length + 2 : key.label.length + 3
}

export const BAR_GAP = 2

/**
 * The action bar: this context's live verbs in §4.6's order, then `u` and `0`
 * while they work, then `m`; never more than seven, and never wider than
 * `width`. Verbs leave from the end first; the rest stay in the menu and on
 * their hotkeys. In the dock the running strip says `0: stop all` (§4.6, §5.6),
 * so the bar does not: never both.
 */
export function actionBar(c: KeyContext, width = Infinity): ShownKey[] {
  const live = (id: KeyId) => isLive(keyDef(id), c)
  const head = verbs(c).filter(live)
  const safety: readonly KeyId[] = c.seat === 'dock' ? ['undo'] : ['undo', 'stop']
  const tail: KeyId[] = [...safety.filter(live), ...(c.where === 'band' ? [] : (['menu'] as const))]
  const fixed = new Set<KeyId>(['back', 'undo', 'stop', 'menu'])
  let picked = [...head, ...tail]
  const cells = (ids: readonly KeyId[]) => ids.reduce((sum, id, index) => sum + barCells(shown(keyDef(id), c)) + (index === 0 ? 0 : BAR_GAP), 0)
  while (picked.length > MAX_BAR || cells(picked) > width) {
    // The first verb is the cursor row's action and stays; so do back, undo, stop and menu.
    const drop = picked.findLastIndex((id, index) => index > 0 && !fixed.has(id))
    if (drop === -1) break
    picked = picked.filter((_, index) => index !== drop)
  }
  // Chats' ⏎ opens the row and is drawn as `⏎ open` (§4.6); `o` stays a hidden hotkey.
  return picked.map(id => (id === 'open' ? { ...shown(keyDef(id), c), hotkey: null } : shown(keyDef(id), c)))
}

/**
 * The live keys of this context that nothing draws: the frame keeps their
 * hotkeys in a Box it does not show, so `j`, `q` or `p` work without the
 * menu while the bar shows only the verbs. `drawn` are the hotkeys the view
 * draws itself (the bar's, the strip's `s`, a load error's `g`).
 */
export function hiddenKeys(c: KeyContext, drawn: ReadonlySet<string>): ShownKey[] {
  return TABLE.filter(def => def.hotkey !== null && !drawn.has(def.hotkey) && isLive(def, c)).map(def => shown(def, c))
}

/** `needs` is the step it waits for; `isQuiet` draws it dim without that step. */
export type MenuEntry = { def: KeyDef; label: string; needs: string | null; isQuiet: boolean }
export type MenuSection = { group: MenuGroup; entries: MenuEntry[] }

/**
 * The menu (`m`) for the view under it: every key this view and this kind of
 * chat can use, grouped; one that waits for a step carries it. A key that
 * can never work here is not listed (§4.6). `h` and `m` close the menu
 * itself, so they are the menu's bar, not its entries; moving is a line of
 * its own.
 */
export function menu(c: KeyContext): MenuSection[] {
  const listed = TABLE.filter(def => exists(def, c) && def.group !== 'move' && def.id !== 'back' && def.id !== 'menu')
  return MENU_GROUPS.flatMap(group => {
    const entries = listed
      .filter(def => def.group === group)
      .map(def => ({ def, label: (def.menuLabel ?? def.label)(c), needs: needsOf(def, c), isQuiet: def.whileWaiting === 'quiet' }))
      .filter(entry => entry.needs === null || entry.def.whileWaiting !== 'hidden')
    return entries.length === 0 ? [] : [{ group, entries }]
  })
}

/** Every hotkey the table owns, each with its one meaning. */
export function hotkeyTable(): Map<string, KeyId> {
  const owners = new Map<string, KeyId>()
  for (const def of TABLE) if (def.hotkey !== null) owners.set(def.hotkey, def.id)
  return owners
}
