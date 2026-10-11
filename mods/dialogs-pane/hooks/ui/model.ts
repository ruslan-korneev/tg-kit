// Pure rules of the pane: tokens and glyphs (design §4), labels,
// selection, the state summary. No `$` here, so tests call these directly.
// The keys are in ./keys.
import type {
  Load,
  Selection,
  TgDialog,
  TgFailure,
  TgMessage,
  TgPeerKind,
} from '../../types'

/** Terminal palette names, so the pane follows the person's theme. */
export const TOKEN = {
  accent: 'cyan',
  bot: 'magenta',
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
} as const

export const GLYPH = {
  bot: '◆',
  group: '#',
  saved: '★',
  person: '•',
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

const GROUP_KINDS: readonly TgPeerKind[] = ['group', 'supergroup', 'channel']

export function dialogGlyph(kind: TgPeerKind): { glyph: string; color?: string } {
  if (kind === 'bot') return { glyph: GLYPH.bot, color: TOKEN.bot }
  if (kind === 'self') return { glyph: GLYPH.saved }
  if (GROUP_KINDS.includes(kind)) return { glyph: GLYPH.group }
  return { glyph: GLYPH.person }
}

export function dialogLabel(dialog: Pick<TgDialog, 'kind' | 'title' | 'username'>): string {
  if (dialog.kind === 'self') return 'Saved Messages'
  return dialog.username === null ? dialog.title : `@${dialog.username}`
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

/** `14:02` today, `yesterday`, else `09-29`; local time. */
export function shortTime(iso: string | null, now: number): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const today = new Date(now)
  const dayMs = 86_400_000
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (at.getTime() >= startOfToday) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at.getTime() >= startOfToday - dayMs) return 'yesterday'
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
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
 * in one (East Asian Width Neutral): the running strip's level glyphs and
 * arrow, and the folder strip's ‹ ›. ⚡ and ⏸ are two, so they are not here.
 */
export const NARROW_GLYPHS: ReadonlySet<string> = new Set(['⟳', '⌁', '◉', '✎', '→', '‹', '›'])

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
    case 'auth':
      return 'Not logged in. Run `! tg login` in the prompt, then press g to reload.'
    case 'flood': {
      const left = retryAt === undefined ? failure.seconds : Math.max(0, Math.ceil((retryAt - now) / 1000))
      return `Telegram asks to wait ${left} s; retrying then.`
    }
    case 'missing':
      return 'tg is not on PATH, or did not answer in time. Install tg-kit (README → Install).'
    case 'not-found':
    case 'error':
      return `tg: ${failure.message}`
  }
}

export function failureColor(failure: TgFailure): string | undefined {
  switch (failure.kind) {
    case 'flood':
      return TOKEN.warn
    case 'auth':
    case 'missing':
      return undefined
    case 'not-found':
    case 'error':
      return TOKEN.danger
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
