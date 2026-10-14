// What the pane says outside itself (docs/design/dialogs-pane-ux.md §4.1, §4.5,
// §8 T5): the footer label, the hint tail, the status line's alarms, the band's
// queue of what needs the owner. A packet's transcript row stays as the engine
// draws it (decision 10). Pure: register.tsx reads the state and makes every
// `$` call.
import type { ApNote, ApUndoWindow, BandEvent, DgStatus, PeerRef, TgDialog } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { undoLeft } from '../autopilot/ledger'
import type { DraftView } from './drafts'
import { GLYPH, cells, dialogLabel, oneLine, peerConfirmLabel } from './model'

// --- the footer label (SessionMode) ---

/** What the footer's `tg` head counts: unread chats that are not muted, still loading, or why it cannot. */
export type UnreadHead = { kind: 'count'; unread: number } | { kind: 'loading' } | { kind: 'failed'; isLoggedOut: boolean }

/** What the Hidden line counts besides the head (§10.8): mentions of the owner, and the autopilot's gauge pair. */
export type HiddenParts = {
  /** Unread mentions of the owner, muted chats included (Telegram notifies those, §10.3). */
  mentions: number
  /** `12/50`: the chat nearest its limit (§10.6); `on` while agents run with no limit; null with none on. */
  autopilot: string | null
}

/**
 * The Hidden line (§10.8, decision 2), the footer label in every state and
 * `/tg status`'s second line: `● tg: 15 unread · @2 · autopilot 12/50`. The
 * unread chats are those not muted. Zero parts are left out, and `tg` stays
 * alone, so the footer always says the pane is there. While the list loads or
 * fails the head says so (`tg …`, `tg ⚠`) and only the autopilot part follows.
 * The footer label is one string: `●` cannot take a role there, it draws dim.
 */
export function footerLabel(head: UnreadHead, parts: HiddenParts): string {
  const pilot = parts.autopilot === null ? [] : [`autopilot ${parts.autopilot}`]
  if (head.kind !== 'count') {
    const first = head.kind === 'loading' ? `tg ${GLYPH.working}` : head.isLoggedOut ? `tg ${GLYPH.error} not logged in` : `tg ${GLYPH.error}`
    return [first, ...pilot].join(' · ')
  }
  const rest = [...(head.unread === 0 ? [] : [`${head.unread} unread`]), ...(parts.mentions === 0 ? [] : [`@${parts.mentions}`]), ...pilot]
  return rest.length === 0 ? 'tg' : `${GLYPH.unread} tg: ${rest.join(' · ')}`
}

/** Unread chats that are not muted, among `rows`: a muted chat's count would bury the rest (§4.5, §4.7). */
export function unreadChats(rows: readonly { unread: number; muted: boolean }[]): number {
  return rows.filter(row => row.unread > 0 && !row.muted).length
}

// --- the status line: alarms only ---

/**
 * The status line (§4.1, §4.5): only a hard stop waiting, stops skipped while
 * delegate runs, and not being logged in. Anything else clears it: what runs
 * is the footer's, what waits the band's, a packet's fate Activity's.
 */
export function statusAlarm(alarms: { hold: string | null; noStops: string | null; isLoggedOut: boolean }): string | undefined {
  const parts = [
    ...(alarms.hold === null ? [] : [alarms.hold]),
    ...(alarms.noStops === null ? [] : [`tg ${alarms.noStops}`]),
    ...(alarms.isLoggedOut ? [`tg ${GLYPH.error} not logged in: ! tg login`] : []),
  ]
  return parts.length === 0 ? undefined : parts.join(' · ')
}

// --- the band: one queue of what needs the owner ---

/** §8 T5: a hard stop first, then drafts, an undo window, a watched reply, a summary, task news. */
export const BAND_ORDER = ['hold', 'draft', 'undo', 'reply', 'summary', 'task'] as const
export type BandKind = (typeof BAND_ORDER)[number]

export type BandHold = { key: string; peer: PeerRef; stops: readonly string[]; what: string }
/** A task that ended, for its news: the owner hears how it went once, and `d` puts it away. */
export type BandTask = { id: number; peer: PeerRef; status: DgStatus; reason: string }

export type BandItem =
  | ({ kind: 'hold' } & BandHold)
  | { kind: 'draft'; key: string; draft: DraftView }
  | { kind: 'undo'; key: string; undo: ApUndoWindow }
  | { kind: 'reply'; key: string; event: BandEvent }
  | { kind: 'summary'; key: string; note: ApNote }
  | { kind: 'task'; key: string; task: BandTask }

/** What the pane shows now, so the band does not say it twice (§4.5). */
export type OnScreen = {
  /** The chat whose thread is drawn; null when none is. */
  chat: number | null
  /** For you is drawn: its agent rows are the drafts and the undo window. */
  isForYou: boolean
  /** The drafts whose rows the pane draws (their chat's thread, For you): read and sent there (§8 T3). */
  drafts: readonly string[]
}

export const NOTHING_ON_SCREEN: OnScreen = { chat: null, isForYou: false, drafts: [] }

export type QueueInput = {
  holds: readonly BandHold[]
  /** Every draft waiting, autopilot's and routing's (./drafts). */
  drafts: readonly DraftView[]
  /** The undo window while it is open. */
  undo: ApUndoWindow | null
  reply: BandEvent | null
  /** Ids of the watched chats: only their news reaches the band. */
  watched: readonly number[]
  notes: readonly ApNote[]
  tasks: readonly BandTask[]
  dismissed: readonly string[]
  onScreen: OnScreen
}

/**
 * The band's items, most urgent first. A hard stop always shows: it mirrors
 * the engine's dialog. The rest are left out while the pane draws them: a
 * draft's row in its thread or For you, the undo window in For you, a reply
 * and a task's news in their chat's thread (the task card sits on top of it).
 * Only a task that ended makes news, and only done or failed: the owner
 * stopped the others.
 */
export function bandQueue(input: QueueInput): BandItem[] {
  const { onScreen } = input
  const inThread = (peerId: number) => onScreen.chat === peerId
  const reply = input.reply
  const items: BandItem[] = [
    ...input.holds.map((hold): BandItem => ({ kind: 'hold', ...hold })),
    ...input.drafts.filter(draft => !onScreen.drafts.includes(draft.key)).map((draft): BandItem => ({ kind: 'draft', key: draft.key, draft })),
    ...(onScreen.isForYou || input.undo === null ? [] : [{ kind: 'undo', key: `undo:${input.undo.seq}`, undo: input.undo } as const]),
    ...(reply === null || !input.watched.includes(reply.dialogId) || inThread(reply.dialogId) ? [] : [{ kind: 'reply', key: `reply:${reply.dialogId}`, event: reply } as const]),
    ...[...input.notes].reverse().map((note): BandItem => ({ kind: 'summary', key: `note:${note.seq}`, note })),
    ...input.tasks
      .filter(task => (task.status === 'done' || task.status === 'failed') && !inThread(task.peer.id))
      .map((task): BandItem => ({ kind: 'task', key: `task:${task.id}:${task.status}`, task })),
  ]
  return items.filter(item => !input.dismissed.includes(item.key))
}

/** The item the band shows: the one `at` names while it is queued, else the first. */
export function shownIndex(items: readonly BandItem[], at: string | null): number {
  const index = items.findIndex(item => item.key === at)
  return index === -1 ? 0 : index
}

/** `j` (+1) and `k` (-1): the key of the next or previous item, round the queue. */
export function stepKey(items: readonly BandItem[], at: string | null, by: 1 | -1): string | null {
  if (items.length === 0) return null
  const index = (shownIndex(items, at) + by + items.length) % items.length
  return items[index]?.key ?? null
}

/** `1/3  j: next`, while more than one item waits. */
export function positionText(index: number, count: number): string | null {
  return count < 2 ? null : `${index + 1}/${count}  j: next`
}

/**
 * The hint line's tail while the band holds items (§4.1, §4.4): where they
 * are, and the key that reaches them. `forYou` counts what §4.5 calls "for
 * you" (drafts and hard stops); without one the band holds news.
 */
export function hintTail(count: number, forYou: number): string | undefined {
  if (count === 0) return undefined
  return `tg: ${forYou > 0 ? `${forYou} for you` : `${count} waiting`} · ctrl+x tab`
}

/** One line per item, for `/tg status`: what waits, most urgent first. */
export function itemLine(item: BandItem, now: number): string {
  switch (item.kind) {
    case 'hold':
      return `⏸ HARD STOP ${item.stops.join(' + ')}: ${oneLine(item.what, 60)} · ${LEVEL_GLYPH.delegate} ${peerConfirmLabel(item.peer)}`
    case 'draft':
      return `${LEVEL_GLYPH.draft} draft for ${peerConfirmLabel(item.draft.peer)}: "${oneLine(item.draft.text, 60)}"`
    case 'undo':
      return `${LEVEL_GLYPH.auto} ${peerConfirmLabel(item.undo.peer)} replied "${oneLine(item.undo.text, 40)}" · u: undo ${undoLeft(item.undo, now)}s`
    case 'reply':
      return `${item.event.kind === 'bot' ? GLYPH.bot : GLYPH.unread} ${item.event.label}: "${oneLine(item.event.text, 60)}"`
    case 'summary':
      return `${LEVEL_GLYPH.listen} ${item.note.peer.label}: ${oneLine(item.note.text, 60)}`
    case 'task':
      return `${LEVEL_GLYPH.delegate} ${item.task.peer.label} · task ${item.task.status}: ${oneLine(item.task.reason, 60)}`
  }
}

/** A draft's own row: `  → ` and its text on one line. */
export const DRAFT_LEAD = '  → '

/**
 * Whether the draft's whole text fits its own row of `width` cells, so one ⏎
 * sends what the owner sees (decision 9). Cells err wide (`cells`), so a draft
 * that might not fit is never taken for one that does.
 */
export function draftFits(text: string, width: number): boolean {
  return cells(`${DRAFT_LEAD}${oneLine(text, Infinity)}`) - 1 <= width
}

// --- the compact card (§10.7) ---

/** The card's width at most, as statuspane's; under `COMPACT_NARROW` body columns it is one line (§10.7). */
export const COMPACT_WIDTH = 46
export const COMPACT_NARROW = 40
/** The chat rows the card draws at once: a window over its page, kept on the ringed row. */
export const COMPACT_ROWS = 3

/**
 * The card's status line (§10.7): the chats in For you; with none, the unread
 * chats that are not muted; with neither, `all read`.
 */
export type CompactStatus = { kind: 'waiting'; chats: number } | { kind: 'unread'; chats: number } | { kind: 'read' }

export function compactStatus(waiting: number, unread: number): CompactStatus {
  if (waiting > 0) return { kind: 'waiting', chats: waiting }
  return unread > 0 ? { kind: 'unread', chats: unread } : { kind: 'read' }
}

/** The status's words and the role of its `●`; `isShort` is the one-line form's (`● 3 waiting`). Null role: all of it dim. */
export function compactStatusText(status: CompactStatus, isShort = false): { text: string; role: 'mention' | 'unread' | null } {
  switch (status.kind) {
    case 'waiting':
      return { text: `${GLYPH.unread} ${status.chats}${isShort ? '' : status.chats === 1 ? ' chat' : ' chats'} waiting`, role: 'mention' }
    case 'unread':
      return { text: `${GLYPH.unread} ${status.chats} unread`, role: 'unread' }
    case 'read':
      return { text: 'all read', role: null }
  }
}

/**
 * The card's search (§10.7): the chats whose name or @username holds the text,
 * any case. Only the chats the card already has; the pane's `s` asks tg for more.
 */
export function compactMatches<T extends { kind: TgDialog['kind']; title: string; username: string | null }>(rows: readonly T[], query: string): T[] {
  const asked = query.trim().toLowerCase()
  if (asked === '') return [...rows]
  return rows.filter(row => dialogLabel(row).toLowerCase().includes(asked) || (row.username ?? '').toLowerCase().includes(asked.replace(/^@/, '')))
}

/** The first of the `COMPACT_ROWS` drawn: the ringed row second from the top while rows go on both sides of it. */
export function compactStart(count: number, at: number): number {
  return Math.max(0, Math.min(at - 1, count - COMPACT_ROWS))
}

/** `f` and shift+f in the card: the folder `by` steps from `current` in the strip's order, round at both ends; null with no list held. */
export function stepFolder(list: readonly { id: number }[] | null, current: number, by: 1 | -1): number | null {
  if (list === null || list.length === 0) return null
  const at = list.findIndex(one => one.id === current)
  // Off the list (a folder since removed), forward lands on the first and back on the last.
  const from = at === -1 ? (by === 1 ? -1 : 0) : at
  return (list[(from + by + list.length) % list.length] ?? list[0])?.id ?? null
}

/** The engine's chord for `abovePrompt:focus` as the person bound it, short (`^x^x`, `^x tab`), from keybindings.json's text. */
export function focusChord(keybindings: string | null): string {
  const fallback = 'ctrl+x tab'
  let chord = fallback
  try {
    const parsed: unknown = keybindings === null ? null : JSON.parse(keybindings)
    const blocks = isRecord(parsed) && Array.isArray(parsed.bindings) ? parsed.bindings : []
    // The owner's own binding wins over the engine's default, which stays bound beside it.
    for (const block of blocks) {
      if (!isRecord(block) || !isRecord(block.bindings)) continue
      for (const [key, action] of Object.entries(block.bindings)) if (action === 'abovePrompt:focus') chord = key
    }
  } catch {
    chord = fallback
  }
  return chord
    .split(' ')
    .map(part => part.replace(/^ctrl\+/, '^'))
    .join(' ')
    .replace(/\^(\w) \^/g, '^$1^')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
