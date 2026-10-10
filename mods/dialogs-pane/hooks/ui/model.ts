// Pure rules of the pane: tokens and glyphs (design §4), lenses, labels,
// selection, hints. No `$` here, so tests call these directly.
import type {
  BandEvent,
  Lens,
  Load,
  Mode,
  Nav,
  Selection,
  TgDialog,
  TgFailure,
  TgMessage,
  TgPeerKind,
} from '../../types'

export const MODES = ['wide', 'compact', 'hidden'] as const satisfies readonly Mode[]
export const LENSES = ['all', 'bots', 'unread'] as const satisfies readonly Lens[]

export function isMode(v: unknown): v is Mode {
  return MODES.some(mode => mode === v)
}

/** `Tab` order: wide → compact → hidden → wide. */
export function nextMode(mode: Mode): Mode {
  const next: Record<Mode, Mode> = { wide: 'compact', compact: 'hidden', hidden: 'wide' }
  return next[mode]
}

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
  pinned: '⌁',
  latency: '⏱',
  done: '✓',
  working: '…',
  error: '⚠',
} as const

export const LENS_LABEL: Record<Lens, string> = { all: 'All', bots: 'Bots', unread: 'Unread' }

/** The empty-lens line: what the lens filters, and how to change it. */
export function emptyLensText(lens: Lens, query: string): string {
  const search = query === '' ? '' : ` matching "${query}"`
  const what: Record<Lens, string> = {
    all: `No dialogs${search}.`,
    bots: `No chats with bots${search}: the Bots lens hides people, groups and channels.`,
    unread: `Nothing unread${search}: the Unread lens shows only chats with unread messages.`,
  }
  const how = query === '' ? (lens === 'all' ? '' : ' Press 1 for All.') : ' Press s and submit an empty search to clear it.'
  return what[lens] + how
}

export function visibleDialogs(dialogs: readonly TgDialog[], nav: Pick<Nav, 'lens' | 'query'>): TgDialog[] {
  const query = nav.query.trim().toLowerCase()
  return dialogs.filter(dialog => {
    if (nav.lens === 'bots' && dialog.kind !== 'bot') return false
    if (nav.lens === 'unread' && dialog.unread === 0) return false
    if (query === '') return true
    return `${dialog.title} ${dialog.username ?? ''}`.toLowerCase().includes(query)
  })
}

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

/** One line of text: newlines become `⏎`, as tg's own listing draws them. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
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

// --- hints: the keys valid right now, never more than five ---

export type Hint = { key: string; hotkey: string; label: string }

export const MAX_HINTS = 5

export function hintsFor(view: Nav['view'], selection: Selection): Hint[] {
  const all: Hint[] =
    view === 'dialogs'
      ? [
          { key: 'down', hotkey: 'j', label: 'down' },
          { key: 'up', hotkey: 'k', label: 'up' },
          { key: 'open', hotkey: 'o', label: 'open' },
          { key: 'search', hotkey: 's', label: 'search' },
          { key: 'mode', hotkey: 'm', label: 'mode' },
        ]
      : [
          { key: 'down', hotkey: 'j', label: 'down' },
          { key: 'up', hotkey: 'k', label: 'up' },
          { key: 'select', hotkey: 'x', label: 'select' },
          { key: 'range', hotkey: 'v', label: selection.anchor === null ? 'range' : 'range end' },
          { key: 'back', hotkey: 'h', label: selection.ids.length > 0 ? 'clear' : 'back' },
        ]
  return all.slice(0, MAX_HINTS)
}

// --- mode defaults, unread growth, the status line ---

/** The mode a fresh open takes: wide where a pane docks beside the transcript. */
export function defaultMode(presentation: { isFullscreen: boolean; columns: number } | undefined): Mode {
  return presentation !== undefined && presentation.isFullscreen && presentation.columns >= 110 ? 'wide' : 'compact'
}

/** The first dialog whose unread count grew between two loads. */
export function grownDialog(before: readonly TgDialog[], after: readonly TgDialog[]): TgDialog | undefined {
  const was = new Map(before.map(dialog => [dialog.id, dialog.unread]))
  return after.find(dialog => dialog.unread > (was.get(dialog.id) ?? 0))
}

/** Hidden mode's status line: unread total, and who wrote last when the band has news. */
export function statusText(load: Load<TgDialog[]>, event: BandEvent | null): string {
  if (load.status === 'error') {
    return load.failure.kind === 'auth' ? 'tg · not logged in: ! tg login' : `tg ${GLYPH.error} ${load.failure.kind}`
  }
  const list = loaded(load)
  if (list === undefined) return `tg ${GLYPH.working}`
  const unread = list.reduce((sum, dialog) => sum + dialog.unread, 0)
  const head = unread === 0 ? `tg ${GLYPH.done} no unread` : `tg ${GLYPH.unread} ${unread} unread`
  return event === null ? head : `${head} · ${event.kind === 'bot' ? `${GLYPH.bot} ` : ''}${event.label} wrote`
}
