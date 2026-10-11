// What the pane says outside itself (docs/design/dialogs-pane-ux.md §4.1, §4.5,
// §8 T5): the footer label, the hint tail, the status line's alarms, the band's
// queue of what needs the owner, and the transcript's one row per packet. Pure:
// register.tsx reads the state and makes every `$` call.
import type { ApNote, ApUndoWindow, BandEvent, DgStatus, LedgerEntry, PeerRef, RouteIntent } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { undoLeft } from '../autopilot/ledger'
import { intentLabel } from '../routing/route'
import type { DraftView } from './drafts'
import { GLYPH, cells, oneLine, type SummaryParts } from './model'

// --- the footer label (SessionMode) ---

/** What the footer's `tg` head counts: unread chats that are not muted, still loading, or why it cannot. */
export type UnreadHead = { kind: 'count'; unread: number } | { kind: 'loading' } | { kind: 'failed'; isLoggedOut: boolean }

/**
 * `tg 22 · ⌁1 ⟳1 ↯1 · ◎ 3 new · 2 for you` (§4.5): the unread chats that are
 * not muted (the footer only; the pane shows them per chat), then the header's
 * summary. Zero counts are left out; `tg` stays, so the footer always says the
 * pane is there.
 */
export function footerLabel(head: UnreadHead, summary: SummaryParts): string {
  const first =
    head.kind === 'count'
      ? head.unread === 0
        ? 'tg'
        : `tg ${head.unread}`
      : head.kind === 'loading'
        ? `tg ${GLYPH.working}`
        : head.isLoggedOut
          ? `tg ${GLYPH.error} not logged in`
          : `tg ${GLYPH.error}`
  return [first, summary.levels, summary.watched, summary.forYou].filter(part => part !== '').join(' · ')
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
      return `⏸ HARD STOP ${item.stops.join(' + ')}: ${oneLine(item.what, 60)} · ${LEVEL_GLYPH.delegate} ${item.peer.label}`
    case 'draft':
      return `${LEVEL_GLYPH.draft} draft for ${item.draft.peer.label}: "${oneLine(item.draft.text, 60)}"`
    case 'undo':
      return `${LEVEL_GLYPH.auto} ${item.undo.peer.label} replied "${oneLine(item.undo.text, 40)}" · u: undo ${undoLeft(item.undo, now)}s`
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

// --- the transcript: one row per packet ---

/** The packet's opening tag, first in the row: bare, or under the engine's framing of a plugin's prompt (seen live on 2.1.296). */
const PACKET_HEAD = /^(?:The dialogs-pane plugin sent a message:\s*)?<tg-packet v="\d+" intent="([a-z_]+)" source="dialogs-pane"/
const MESSAGE_ID = /<message id="(\d+)"/g
const PLACEHOLDER = /\[(?:id|name|phone|@user)-\d+\]/g
const PEER = /<peer kind="[^"]*"(?: username="([^"]*)")?(?: id="[^"]*")?(?: title="([^"]*)")?/

const INTENT_IDS: readonly RouteIntent[] = ['fix', 'reproduce', 'explain', 'test', 'raw', 'do_it', 'draft_reply']

function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/**
 * The transcript's row for a packet this plugin sent to main (§5.1): `▣ tg
 * packet → main · Fix · @example_bot #677791 (+1 parent, 3 masked)   ctrl+o
 * shows it`. Read off the packet: its intent and the messages it carries (the
 * ones outside `<context>`); the chat's name, the parents and the masks come
 * from the ledger's entry for it when the session still has one, since a
 * redacted packet names a person `[name-1]`. Null: not a packet of this plugin.
 */
export function packetRow(text: string, ledger: readonly LedgerEntry[]): string | null {
  const head = PACKET_HEAD.exec(text)
  const intent = INTENT_IDS.find(one => one === head?.[1])
  if (head === null || intent === undefined) return null
  const end = text.indexOf('</tg-packet>')
  const body = text.slice(0, end === -1 ? undefined : end)
  const contextAt = body.indexOf('<context>')
  const own = contextAt === -1 ? body : body.slice(0, contextAt)
  const ids = [...own.matchAll(MESSAGE_ID)].map(match => Number(match[1]))
  const parentsInText = contextAt === -1 ? 0 : [...body.slice(contextAt).matchAll(MESSAGE_ID)].length
  const same = (entry: LedgerEntry) =>
    entry.to.kind === 'main' && entry.intent === intent && entry.messageIds.length === ids.length && entry.messageIds.every(id => ids.includes(id))
  const entry = ledger.findLast(same)
  const peerMatch = PEER.exec(own)
  const label = entry?.peer.label ?? unescapeXml(peerMatch?.[1] ?? peerMatch?.[2] ?? 'a chat')
  const parents = entry?.parents ?? parentsInText
  const masked = entry?.masked ?? new Set(body.match(PLACEHOLDER) ?? []).size
  const first = ids[0]
  const what = ids.length === 1 && first !== undefined ? `#${first}` : `${ids.length} messages`
  const extras = [...(parents === 0 ? [] : [`+${parents} parent${parents === 1 ? '' : 's'}`]), ...(masked === 0 ? [] : [`${masked} masked`])]
  return `▣ tg packet → main · ${intentLabel(intent)} · ${label} ${what}${extras.length === 0 ? '' : ` (${extras.join(', ')})`}   ctrl+o shows it`
}
