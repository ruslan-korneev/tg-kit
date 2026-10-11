// Telegram's folders in the pane (docs/design/dialogs-pane-ux.md §4.7, §8 T9):
// what one pass (`tg folders --chats --json`) becomes, which view shows which
// rows, how many rows wait for the owner's next move, the strip's window, and
// when the next pass may run. Pure: register.tsx runs tg and keeps the state.
import type { AgentItem, ApDraft, ApUndoWindow, Folder, FolderChats, FolderPass, ForYouWhy, ListView, PassState, TgDialog, Verdict } from '../../types'
import { FOLDER_KINDS, TgJsonError, parseDialog } from '../packet/types'
import { cells, labelCells } from '../ui/model'
import { verdictOf, type Me } from '../triage/needs'

/** A row's `last_text` in $.state and $.store: what a row can draw, not the whole message (§8 T9 b). */
export const TEXT_MAX = 120
/** Two passes back to back flood (T8b's measurement): never one within this of the last one's start. */
export const PASS_GAP_MS = 60_000
/** While the pane is hidden, once it was opened: the footer's count reads the pass. */
export const HIDDEN_GAP_MS = 300_000
/** Digits pick the first nine entries, the owner's first nine tabs on the phone (§4.7). */
export const DIGITS = 9
/** A folder title on the strip: 12 cells at most (§7.3). */
export const TITLE_CELLS = 12

/**
 * The last pass as the module keeps it (§8 T9 a): every row by id, and each
 * folder's pins and chats in its order. Never in $.state: on the owner's
 * account it is 621 rows and 467 KB.
 */
export type PassMap = { rows: Map<number, TgDialog>; folders: FolderChats[] }

export function passMap(pass: FolderPass): PassMap {
  return { rows: new Map(pass.dialogs.map(row => [row.id, row])), folders: pass.folders }
}

/** The folder list the strip and the Folders list draw, with the pass's counts. */
export function folderList(map: PassMap): Folder[] {
  return map.folders.map(folder => ({ id: folder.id, title: folder.title, kind: folder.kind, unread: folder.unread }))
}

export function cutRow(row: TgDialog): TgDialog {
  return row.last_text.length <= TEXT_MAX ? row : { ...row, last_text: row.last_text.slice(0, TEXT_MAX) }
}

export function sameView(a: ListView, b: ListView): boolean {
  return a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.id === b.id))
}

const newestFirst = (a: TgDialog, b: TgDialog) => (b.last_date ?? '').localeCompare(a.last_date ?? '')

/** Bots, a pane view: every bot among the pass's rows, newest first. */
export function botRows(map: PassMap): TgDialog[] {
  return [...map.rows.values()].filter(row => row.kind === 'bot').sort(newestFirst)
}

/**
 * The chats a view lists, from the pass: a folder's in its order, Bots. Null
 * when the pass cannot say: no pass held, a folder it does not have, the
 * Archive (asked when opened, not cached), For you (forYouPeople ranks it).
 */
export function viewRows(map: PassMap | null, view: ListView): TgDialog[] | null {
  if (map === null) return null
  switch (view.kind) {
    case 'folder': {
      const folder = map.folders.find(one => one.id === view.id)
      return folder === undefined ? null : folder.chats.flatMap(id => map.rows.get(id) ?? [])
    }
    case 'bots':
      return botRows(map)
    case 'archive':
    case 'foryou':
      return null
  }
}

/**
 * After a watch event (§8 T9): the chat moves to the top of the unpinned part
 * of every folder that lists it. Nothing else changes until the next pass.
 */
export function bump(map: PassMap, id: number): PassMap {
  const folders = map.folders.map(folder => {
    if (!folder.chats.includes(id) || folder.pinned.includes(id)) return folder
    const rest = folder.chats.filter(one => one !== id)
    const pins = rest.filter(one => folder.pinned.includes(one)).length
    return { ...folder, chats: [...rest.slice(0, pins), id, ...rest.slice(pins)] }
  })
  return { rows: map.rows, folders }
}

/** A folder's count after rows changed between passes: its unread chats that are not muted (§4.7). */
export function recount(map: PassMap): PassMap {
  const folders = map.folders.map(folder => ({
    ...folder,
    unread: folder.chats.filter(id => {
      const row = map.rows.get(id)
      return row !== undefined && row.unread > 0 && !row.muted
    }).length,
  }))
  return { rows: map.rows, folders }
}

// --- For you (§5.3) ---

const WHY_OF: Record<Verdict, ForYouWhy | null> = { 'needs-you': 'asks you', fyi: 'fyi', noise: null }

/** The people part of For you: mentions of the owner, and unread person chats that are not muted. */
export function forYouCandidates(rows: Iterable<TgDialog>): TgDialog[] {
  return [...rows].filter(row => row.mentions > 0 || (row.kind === 'user' && row.unread > 0 && !row.muted))
}

/**
 * The people part ranked with why: mentions and what asks the owner first,
 * then fyi, each newest first; noise is left out.
 */
export function forYouPeople(
  rows: Iterable<TgDialog>,
  me: Me,
  verdicts: Readonly<Record<string, Verdict>>,
  repliedToYou: Readonly<Record<string, number>>,
): { rows: TgDialog[]; why: Record<string, ForYouWhy> } {
  const candidates = forYouCandidates(rows)
  const why: Record<string, ForYouWhy> = {}
  for (const row of candidates) {
    const verdict = verdictOf(row, me, verdicts, repliedToYou)
    const reason = row.mentions > 0 ? 'mentions you' : verdict === undefined ? null : WHY_OF[verdict]
    if (reason !== null) why[String(row.id)] = reason
  }
  const tier = (row: TgDialog) => (why[String(row.id)] === 'fyi' ? 1 : 0)
  const listed = candidates.filter(row => why[String(row.id)] !== undefined)
  return { rows: listed.sort((a, b) => tier(a) - tier(b) || newestFirst(a, b)), why }
}

/** For you's agent rows, read from the autopilot until T5's queue lands: drafts, then the undo window. */
export function agentItems(drafts: readonly ApDraft[], hasReply: boolean, undo: ApUndoWindow | null, now: number): AgentItem[] {
  return [
    ...drafts.map(draft => ({ kind: 'draft', seq: draft.seq }) as const),
    ...(hasReply ? [{ kind: 'reply' } as const] : []),
    ...(undo !== null && now < undo.until ? [{ kind: 'undo', seq: undo.seq } as const] : []),
  ]
}

export function agentKey(item: AgentItem): string {
  switch (item.kind) {
    case 'draft':
      return `draft:${item.seq}`
    case 'reply':
      return 'reply'
    case 'undo':
      return `undo:${item.seq}`
  }
}

// --- what waits for the owner's move (§4.3, §8 T9) ---

/** The length of the longest increasing run, not necessarily contiguous, of `values`. */
function longestRising(values: readonly number[]): number {
  const tails: number[] = []
  for (const value of values) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((tails[mid] ?? 0) < value) low = mid + 1
      else high = mid
    }
    tails[low] = value
  }
  return tails.length
}

/**
 * How many chats moved, joined or left between the list as drawn and as it
 * would be now (`↑N`): one chat moving to the top counts one, not every row it
 * passed.
 */
export function waitingCount(drawn: readonly string[], target: readonly string[]): number {
  const at = new Map(target.map((key, index) => [key, index]))
  const kept = drawn.flatMap(key => {
    const index = at.get(key)
    return index === undefined ? [] : [index]
  })
  const left = drawn.length - kept.length
  const joined = target.length - kept.length
  return left + joined + (kept.length - longestRising(kept))
}

// --- the strip and the Folders list (§4.7, §7.3) ---

/** One entry of the strip and the Folders list: a folder, then For you and Bots; digits on the first nine. */
export type Entry = { view: ListView; title: string; unread: number | null; isShared: boolean; digit: number | null }

/** The strip's entries: Telegram's folders in its order (All chats where the owner put it), then the pane's views. */
export function stripEntries(list: readonly Folder[]): Entry[] {
  const folders = list.map(folder => ({ view: { kind: 'folder', id: folder.id } as const, title: folder.title, unread: folder.unread, isShared: folder.kind === 'shared' }))
  const views = [
    { view: { kind: 'foryou' } as const, title: 'For you', unread: null, isShared: false },
    { view: { kind: 'bots' } as const, title: 'Bots', unread: null, isShared: false },
  ]
  return [...folders, ...views].map((entry, index) => ({ ...entry, digit: index < DIGITS ? index + 1 : null }))
}

/** A title cut to `max` cells, an emoji counting two. */
export function cutCells(text: string, max: number): string {
  if (cells(text) <= max) return text
  let out = ''
  for (const char of text) {
    if (cells(out + char) > max - 1) break
    out += char
  }
  return `${out}…`
}

/** One tab as the CHATS title writes it (§10.5): `Work 3`. No digit is drawn, and the current one is marked by colour. */
export function tabText(entry: Entry): string {
  const count = entry.unread === null || entry.unread === 0 ? '' : ` ${entry.unread}`
  return `${cutCells(entry.title, TITLE_CELLS)}${count}`
}

const GAP = 2
/** `‹` or `›` past an edge: one cell after its gap. */
const EDGE = GAP + 1

/**
 * The tabs that fit `width`, the current one always among them: `start` and
 * `end` index the entries shown; each tab takes its gap, and `‹` / `›` stand
 * for the ones past each edge (§10.5, §10.10 "§4.7 strip").
 */
export function stripWindow(texts: readonly string[], current: number, width: number): { start: number; end: number } {
  const fill = (start: number) => {
    let used = start > 0 ? EDGE : 0
    let end = start
    while (end < texts.length) {
      const next = GAP + labelCells(texts[end] ?? '')
      const mark = end + 1 < texts.length ? EDGE : 0
      if (used + next + mark > width && end > start) break
      used += next
      end += 1
    }
    return end
  }
  for (let start = 0; start <= Math.max(0, current); start++) {
    const end = fill(start)
    if (end > current) return { start, end }
  }
  return { start: Math.max(0, current), end: Math.max(0, current) + 1 }
}

// --- when a pass runs (§8 T9) ---

export const NO_PASS: PassState = { startedAt: null, isRunning: false, queuedFor: null, floodUntil: null, error: null, hasOpened: false }

/** The earliest a pass may start: 60 s after the last start, and not before a flood wait is over. */
export function nextAllowed(state: PassState): number {
  return Math.max(state.startedAt === null ? 0 : state.startedAt + PASS_GAP_MS, state.floodUntil ?? 0)
}

/**
 * What a reason to run a pass comes to. One at a time and never within 60 s
 * of the last start: `g` inside them queues one pass (a second `g` adds none),
 * opening the pane leaves it to the cadence, and the cadence runs one every
 * 60 s while the pane is open and every 5 min while it is hidden after a first
 * open, or the queued one when its time comes.
 */
export function passPlan(state: PassState, now: number, reason: 'open' | 'g' | 'tick', isOpen: boolean): 'run' | 'queue' | 'skip' {
  const isFree = !state.isRunning && now >= nextAllowed(state)
  switch (reason) {
    case 'g':
      return isFree ? 'run' : state.queuedFor === null ? 'queue' : 'skip'
    case 'open':
      return isFree ? 'run' : 'skip'
    case 'tick': {
      if (!isFree) return 'skip'
      if (state.queuedFor !== null && now >= state.queuedFor) return 'run'
      if (state.startedAt === null) return 'skip'
      if (isOpen) return 'run'
      return state.hasOpened && now >= state.startedAt + HIDDEN_GAP_MS ? 'run' : 'skip'
    }
  }
}

// --- what $.store keeps between sessions (§8 T9 d) ---

/** The folder list with its counts, the current view, and that view's rows when it is a folder. */
export type StoredFolders = { list: Folder[]; view: ListView; rows: TgDialog[] }

function storedView(v: unknown): ListView | null {
  if (typeof v !== 'object' || v === null || !('kind' in v)) return null
  if (v.kind === 'archive' || v.kind === 'foryou' || v.kind === 'bots') return { kind: v.kind }
  return v.kind === 'folder' && 'id' in v && Number.isSafeInteger(v.id) ? { kind: 'folder', id: Number(v.id) } : null
}

function storedFolder(v: unknown): Folder[] {
  if (typeof v !== 'object' || v === null) return []
  const o: Record<string, unknown> = { ...v }
  const kind = FOLDER_KINDS.find(one => one === o.kind)
  if (!Number.isSafeInteger(o.id) || typeof o.title !== 'string' || kind === undefined) return []
  return [{ id: Number(o.id), title: o.title, kind, unread: Number.isSafeInteger(o.unread) ? Number(o.unread) : null }]
}

/** What $.store holds, checked: a bad entry is dropped, a bad snapshot is none. */
export function parseStored(v: unknown): StoredFolders | null {
  if (typeof v !== 'object' || v === null || !('list' in v) || !('view' in v) || !('rows' in v)) return null
  const view = storedView(v.view)
  if (!Array.isArray(v.list) || !Array.isArray(v.rows) || view === null) return null
  const rows = v.rows.flatMap((row: unknown): TgDialog[] => {
    try {
      return [cutRow(parseDialog(row))]
    } catch (error) {
      if (error instanceof TgJsonError) return []
      throw error
    }
  })
  return { list: v.list.flatMap(storedFolder), view, rows }
}
