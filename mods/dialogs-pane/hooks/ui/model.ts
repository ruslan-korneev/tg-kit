// Pure rules of the pane: tokens and glyphs (design §4), labels,
// selection, the state summary. No `$` here, so tests call these directly.
// The keys are in ./keys.
import type {
  Load,
  PeerRef,
  Selection,
  TgDialog,
  TgFailure,
  TgMessage,
  TgPeerKind,
} from '../../types'
import type { Role } from './palette'

/** Terminal palette names, so the pane follows the person's theme. */
export const TOKEN = {
  accent: 'cyan',
  bot: 'magenta',
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
} as const

export const GLYPH = {
  // The chat row's kinds (§10.3), each drawn in its role.
  person: '○',
  group: '◇',
  channel: '▷',
  bot: '⬡',
  saved: '★',
  forum: '⌗',
  /** A forum topic, in its `icon_color`; General is `general`, dim. */
  topic: '●',
  general: '#',
  allTopics: '≡',
  // The row's symbols (§10.3); counts are text.
  /** An agent is on here, at any level. Wide: two cells. */
  agent: '⚡',
  muted: '◌',
  closed: '⊘',
  draft: '✎',
  unread: '●',
  cursor: '▸',
  /** The open chat's row while the cursor is elsewhere (dock). */
  open: '›',
  marked: '▪',
  pinned: '⌁',
  latency: '⏱',
  done: '✓',
  working: '…',
  error: '⚠',
} as const

/** A chat's kind glyph and its role (§10.3). tg's JSON has no forum flag yet: the caller says (T16). */
export function dialogGlyph(kind: TgPeerKind, isForum = false): { text: string; role: Role } {
  if (isForum) return { text: GLYPH.forum, role: 'group' }
  switch (kind) {
    case 'bot':
      return { text: GLYPH.bot, role: 'bot' }
    case 'self':
      return { text: GLYPH.saved, role: 'saved' }
    case 'group':
    case 'supergroup':
      return { text: GLYPH.group, role: 'group' }
    case 'channel':
      return { text: GLYPH.channel, role: 'channel' }
    case 'user':
    case 'unknown':
      return { text: GLYPH.person, role: 'person' }
  }
}

/** A chat's name: its title (a user's first and last name), never `@username` (§10.4). */
export function dialogLabel(dialog: Pick<TgDialog, 'kind' | 'title'>): string {
  return dialog.kind === 'self' ? 'Saved Messages' : dialog.title
}

/**
 * The name where the owner confirms something about a peer, with the handle tg is
 * given: names are not unique, and anyone can take "Ivan Petrov". `Ivan Petrov ·
 * @ivan_example`, `Project team · -1001234`; Saved Messages alone. Lists, the log and
 * dividers show the name only (§10.4).
 */
export function peerConfirmLabel(peer: Pick<PeerRef, 'label' | 'arg'>): string {
  return peer.arg === 'me' ? peer.label : `${peer.label} · ${peer.arg}`
}

/** What tg is handed for a dialog: `me`, `@username`, or the numeric id. */
export function peerArg(dialog: Pick<TgDialog, 'id' | 'kind' | 'username'>): string {
  if (dialog.kind === 'self') return 'me'
  return dialog.username === null ? String(dialog.id) : `@${dialog.username}`
}

/** BotFather gets read-only navigation (repo rule), drawn as `ro`. */
export function isReadOnlyPeer(dialog: Pick<TgDialog, 'username'>): boolean {
  return dialog.username?.toLowerCase() === 'botfather'
}

export function senderLabel(message: Pick<TgMessage, 'out' | 'sender'>): string {
  if (message.out) return 'you'
  if (message.sender.kind === 'bot') return 'bot'
  return message.sender.name || (message.sender.username === null ? '?' : `@${message.sender.username}`)
}

/** Replies drawn in the `danger` token: a bot saying something broke. */
export function isErrorText(text: string): boolean {
  return text.startsWith(GLYPH.error) || text.startsWith('❌') || /\b(error|went wrong|failed)\b/i.test(text)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** The row's time (§10.4), at most 6 cells: `14:02` today, `Mon` within six days, `Oct 3` this year, else `2025`; local time. */
export function rowTime(iso: string | null, now: number): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // Calendar days, not 24 h steps, so a DST change does not move the edge.
  const sixDaysBack = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (at >= startOfToday) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at >= sixDaysBack) return WEEKDAYS[at.getDay()] ?? ''
  if (at.getFullYear() === today.getFullYear()) return `${MONTHS[at.getMonth()] ?? ''} ${at.getDate()}`
  return String(at.getFullYear())
}

/** The row's columns besides the name and the preview (§10.4): cursor 1, time 6, the glyph 1, symbol 3, and five spaces. */
const ROW_FIXED = 15
const ROW_NAME_MAX = 20
const ROW_PREVIEW_MIN = 12
const ROW_NAME_MIN = 10

/** The name's and the preview's cells in a row `width` wide: the preview gives way first (§10.4). */
export function rowWidths(width: number): { name: number; preview: number } {
  const rest = Math.max(0, width - ROW_FIXED)
  const name = Math.min(ROW_NAME_MAX, rest - ROW_PREVIEW_MIN)
  if (name < ROW_NAME_MIN) return { name: rest, preview: 0 }
  return { name, preview: rest - name }
}

/**
 * An agent on the chat: `holding` while it holds a draft or a hard stop for the
 * owner; `no-stops` while a delegate runs with hard stops skipped.
 */
export type AgentMark = 'on' | 'holding' | 'no-stops'

/** The row's one symbol and its role, by §10.3's priority; null draws the column blank. */
export function rowSymbol(
  dialog: Pick<TgDialog, 'unread' | 'mentions' | 'muted' | 'username'>,
  agent: AgentMark | null,
  extra: { isClosed?: boolean; hasDraft?: boolean } = {},
): { text: string; role: Role } | null {
  // Skipped hard stops are the one dangerous state, so they outrank what waits.
  if (agent === 'no-stops') return { text: GLYPH.error, role: 'unread' }
  // Telegram notifies mentions in a muted chat too, so they keep their colour there (decision 5).
  if (dialog.mentions > 0) return { text: dialog.mentions > 99 ? '@9+' : `@${dialog.mentions}`, role: 'mention' }
  if (dialog.unread > 0) return { text: dialog.unread > 99 ? '99+' : String(dialog.unread), role: dialog.muted ? 'dim' : 'unread' }
  if (extra.isClosed === true) return { text: GLYPH.closed, role: 'dim' }
  if (agent !== null) return { text: GLYPH.agent, role: agent === 'holding' ? 'held' : 'ok' }
  if (isReadOnlyPeer(dialog)) return { text: 'ro', role: 'held' }
  if (extra.hasDraft === true) return { text: GLYPH.draft, role: 'held' }
  if (dialog.muted) return { text: GLYPH.muted, role: 'dim' }
  return null
}

/** What a chat list's row draws for a dialog, spread into `ChatRow`'s props. */
export function dialogRow(
  dialog: TgDialog,
  context: { now: number; agent: AgentMark | null; isForum?: boolean },
): { time: string; glyph: { text: string; role: Role }; name: string; isUnread: boolean; preview: { text: string }; symbol: { text: string; role: Role } | null } {
  return {
    time: rowTime(dialog.last_date, context.now),
    glyph: dialogGlyph(dialog.kind, context.isForum),
    name: dialogLabel(dialog),
    isUnread: dialog.unread > 0 && !dialog.muted,
    preview: { text: dialog.last_text },
    symbol: rowSymbol(dialog, context.agent),
  }
}

/** `14:02`, local time, from epoch milliseconds. */
export function clockText(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One line of text: newlines become `⏎`, as tg's own listing draws them. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

/**
 * Terminal cells, erring wide: `truncate-end` cuts by cells. Everything from U+2000 up
 * counts two (CJK, emoji, and wide symbols such as ✅ ⭐ ⌚ ☕ among narrow arrows and
 * punctuation), as does Hangul Jamo; Latin and Cyrillic stay one. Too wide only opens
 * a draft that would have fit (the band) or shows one fewer name (the running strip);
 * too narrow would send a draft the owner never saw whole.
 */
export function cells(text: string): number {
  let count = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    count += (point >= 0x1100 && point <= 0x115f) || point >= 0x2000 ? 2 : 1
  }
  return count
}

/**
 * Glyphs of the pane's own chrome that `cells` counts two but a terminal draws
 * in one (East Asian Width Neutral or Ambiguous): the running strip's level glyphs
 * and arrow, the folder strip's ‹ ›, and §10.3's kinds, symbols and card glyphs.
 * ⏸ and ⚡ are two, so they are not here.
 */
export const NARROW_GLYPHS: ReadonlySet<string> = new Set([
  '⟳', '⌁', '◉', '✎', '↯', '→', '‹', '›',
  '○', '◇', '▷', '⬡', '★', '⌗', '●', '≡', '⊘', '◌', '▸',
  '◎', '▪', '▣', '✓', '✗', '…', '■', '▰', '▱', '━', '↻', '⚠',
])

/** Cells of the pane's own labels: its narrow glyphs as drawn, everything else erring wide (`cells`). */
export function labelCells(text: string): number {
  return cells(text) - [...text].filter(char => NARROW_GLYPHS.has(char)).length
}

export function mediaTag(message: Pick<TgMessage, 'media'>): string {
  return message.media === null ? '' : `[${message.media.type}]`
}

export function clamp(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1)
}

// --- selection: Space, v range, D whole dialog ---

export const NO_SELECTION: Selection = { ids: [], anchor: null }

export function toggleSelected(selection: Selection, id: number): Selection {
  const ids = selection.ids.includes(id)
    ? selection.ids.filter(one => one !== id)
    : [...selection.ids, id]
  return { ids, anchor: selection.anchor }
}

/**
 * `v`: the first press marks where the range starts, the second selects every
 * message between the mark and the cursor, both ends included.
 */
export function rangeSelect(selection: Selection, order: readonly number[], id: number): Selection {
  if (selection.anchor === null) {
    return { ids: selection.ids.includes(id) ? selection.ids : [...selection.ids, id], anchor: id }
  }
  const from = order.indexOf(selection.anchor)
  const to = order.indexOf(id)
  if (from === -1 || to === -1) return { ids: selection.ids, anchor: null }
  const span = order.slice(Math.min(from, to), Math.max(from, to) + 1)
  return { ids: [...new Set([...selection.ids, ...span])], anchor: null }
}

/** `D`: every message the thread has loaded. */
export function selectWhole(order: readonly number[]): Selection {
  return { ids: [...order], anchor: null }
}

// --- states ---

export function failureText(failure: TgFailure, now: number, retryAt?: number): string {
  switch (failure.kind) {
    // §7.4's sentences; the key after them (`g: retry`) is the caller's. Login stays the owner's act: the pane
    // cannot fill a `!` line that runs (§1, `$.prompt.fill`), so it says what to type.
    case 'auth':
      return 'Not logged in: type ! tg login in your prompt'
    case 'flood': {
      // Telegram's wait, then the count to the retry, which may come later: a pass never runs within 60 s of the last (§8 T9).
      if (retryAt === undefined) return `Telegram asks to wait ${failure.seconds} s · retrying`
      return `Telegram asks to wait ${failure.seconds} s · retrying in ${Math.max(0, Math.ceil((retryAt - now) / 1000))} s`
    }
    case 'missing':
      return 'tg is not on PATH, or did not answer in time. README → Install'
    case 'not-found':
    case 'error':
      return `tg: ${failure.message}`
  }
}

/** A failure's role (§10.2): a flood wait is `held`, an error `unread` (red); the rest plain. */
export function failureRole(failure: TgFailure): Role | undefined {
  switch (failure.kind) {
    case 'flood':
      return 'held'
    case 'auth':
    case 'missing':
      return undefined
    case 'not-found':
    case 'error':
      return 'unread'
  }
}

export function loaded<T>(load: Load<T>): T | undefined {
  return load.status === 'ok' ? load.value : undefined
}

// --- the state summary (design §4.5), unread growth, the status line ---

/** The header's summary in three parts, zeros left out; `forYou` is drawn in the warn token. */
export type SummaryParts = { levels: string; watched: string; forYou: string }

export function stateSummary(counts: {
  /** Agents on, by ladder level, in ladder order. */
  levels: readonly { glyph: string; count: number }[]
  /** New messages in watched chats. */
  watched: number
  /** Drafts and hard stops waiting for the owner. */
  forYou: number
}): SummaryParts {
  return {
    levels: counts.levels
      .filter(level => level.count > 0)
      .map(level => `${level.glyph}${level.count}`)
      .join(' '),
    watched: counts.watched > 0 ? `◎ ${counts.watched} new` : '',
    forYou: counts.forYou > 0 ? `${counts.forYou} for you` : '',
  }
}

/** The first dialog whose unread count grew between two loads. */
export function grownDialog(before: readonly TgDialog[], after: readonly TgDialog[]): TgDialog | undefined {
  const was = new Map(before.map(dialog => [dialog.id, dialog.unread]))
  return after.find(dialog => dialog.unread > (was.get(dialog.id) ?? 0))
}
