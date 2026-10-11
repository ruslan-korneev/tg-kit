// Drafts as rows of their chat (docs/design/dialogs-pane-ux.md §5.4, §8 T3,
// decision 9): autopilot's and routing's "Draft reply" seen one way, merged
// into the thread after the message that was newest when they landed, sized
// in terminal rows so the thread's window holds a draft whole or not at all.
// For you and the band read the same views. Pure.
import type { ApDraft, DraftCheck, PeerRef, ReplyDraft, TgMessage } from '../../types'
import { GLYPH, cells, oneLine } from './model'

/** Which draft: autopilot's, by its ledger seq, or routing's one drafted reply. */
export type DraftRef = { kind: 'autopilot'; seq: number } | { kind: 'reply' }

export function draftKey(ref: DraftRef): string {
  return ref.kind === 'autopilot' ? `draft:ap:${ref.seq}` : 'draft:reply'
}

export type VerdictTone = 'ok' | 'danger' | 'dim'

/** One draft as every place draws it: the row in its thread, For you's row, the band's item. */
export type DraftView = {
  ref: DraftRef
  key: string
  peer: PeerRef
  text: string
  /** Landing time and the message it follows in the thread. */
  at: number
  after: number
  /** What it answers, for the band's first row: the incoming text, or `reply to #92`. */
  incoming: string
  /** Who wrote it and why it waits: `from main`, `dates · conf 0.62`. */
  why: string
  /** The guard's verdict, shown before ⏎ sends (§5.4): `✓ the guard allows it`. */
  verdict: { text: string; tone: VerdictTone }
  /** The guard allowed the text as it is, and nothing is running on it: ⏎ sends. */
  canSend: boolean
  /** A dry run or a send is out. */
  isBusy: boolean
  isEditing: boolean
}

function verdictOf(check: DraftCheck | null, sendFailure: string | null): { text: string; tone: VerdictTone } {
  if (sendFailure !== null) return { text: `✗ not sent: ${sendFailure}`, tone: 'danger' }
  if (check === null) return { text: '⏎ checks it first (tg send --dry-run)', tone: 'dim' }
  switch (check.kind) {
    case 'checking':
      return { text: `${GLYPH.working}the guard is checking it`, tone: 'dim' }
    case 'planned':
      return check.isAllowed ? { text: `${GLYPH.done} the guard allows it`, tone: 'ok' } : { text: `✗ the guard refuses: ${check.reason}`, tone: 'danger' }
    case 'failed':
      return { text: `✗ ${check.reason} · ⏎ checks again`, tone: 'danger' }
  }
}

export function apDraftView(draft: ApDraft): DraftView {
  const why = [...draft.reasons, ...(draft.confidence === null ? [] : [`conf ${draft.confidence.toFixed(2)}`])].join(' · ')
  const isSending = draft.state.kind === 'sending'
  return {
    ref: { kind: 'autopilot', seq: draft.seq },
    key: draftKey({ kind: 'autopilot', seq: draft.seq }),
    peer: draft.peer,
    text: draft.text,
    at: draft.at,
    after: draft.after,
    incoming: draft.incoming,
    why,
    verdict: isSending ? { text: `${GLYPH.working}sending`, tone: 'dim' } : verdictOf(draft.check, draft.state.kind === 'failed' ? draft.state.reason : null),
    canSend: !isSending && draft.check.kind === 'planned' && draft.check.isAllowed,
    isBusy: isSending || draft.check.kind === 'checking',
    isEditing: draft.state.kind === 'editing',
  }
}

/** Routing's drafted reply while it waits (a sent one is no draft). */
export function replyDraftView(draft: ReplyDraft): DraftView | null {
  const { step } = draft
  if (step.kind === 'sent') return null
  const check: DraftCheck | null = step.kind === 'checking' ? { kind: 'checking' } : step.kind === 'planned' ? step : step.kind === 'failed' ? { kind: 'failed', reason: step.reason } : null
  return {
    ref: { kind: 'reply' },
    key: draftKey({ kind: 'reply' }),
    peer: draft.peer,
    text: draft.text,
    at: draft.at,
    after: draft.after,
    incoming: `reply to #${draft.replyTo}`,
    why: `from ${draft.from}`,
    verdict: step.kind === 'sending' ? { text: `${GLYPH.working}sending`, tone: 'dim' } : verdictOf(check, null),
    canSend: step.kind === 'planned' && step.isAllowed,
    isBusy: step.kind === 'checking' || step.kind === 'sending',
    isEditing: draft.isEditing,
  }
}

/** Every draft waiting, in landing order: autopilot's and routing's. */
export function draftViews(drafts: readonly ApDraft[], reply: ReplyDraft | null): DraftView[] {
  const replyView = reply === null ? null : replyDraftView(reply)
  return [...drafts.map(apDraftView), ...(replyView === null ? [] : [replyView])].sort((a, b) => a.at - b.at)
}

export type ThreadRow = { kind: 'message'; message: TgMessage } | { kind: 'draft'; draft: DraftView }

export function threadRowKey(row: ThreadRow): string {
  return row.kind === 'message' ? `msg:${row.message.id}` : row.draft.key
}

/**
 * The thread with its chat's drafts: each after the last message it followed
 * when it landed (§4.3: a draft never lands above the cursor), in landing
 * order; one whose message is older than the loaded ones goes first. Messages
 * that came later go after it.
 */
export function threadRows(messages: readonly TgMessage[], drafts: readonly DraftView[]): ThreadRow[] {
  const rows: ThreadRow[] = []
  const placed = new Set<string>()
  const before = drafts.filter(draft => messages.every(message => message.id > draft.after))
  for (const draft of before) {
    rows.push({ kind: 'draft', draft })
    placed.add(draft.key)
  }
  messages.forEach((message, index) => {
    rows.push({ kind: 'message', message })
    const next = messages[index + 1]
    for (const draft of drafts) {
      if (placed.has(draft.key) || draft.after < message.id || (next !== undefined && draft.after >= next.id)) continue
      rows.push({ kind: 'draft', draft })
      placed.add(draft.key)
    }
  })
  return rows
}

/** Rows a text takes wrapped at `width` cells, word by word as a terminal wraps it, erring tall. */
export function wrapRows(text: string, width: number): number {
  const room = Math.max(1, width)
  return text.split('\n').reduce((sum, line) => {
    let rows = 1
    let used = 0
    for (const word of line.split(' ')) {
      const size = cells(word)
      const need = used === 0 ? size : used + 1 + size
      if (need <= room) {
        used = need
        continue
      }
      // A word longer than the row breaks across rows of its own.
      rows += used === 0 ? Math.ceil(size / room) - 1 : Math.ceil(size / room)
      used = size % room === 0 ? room : size % room
    }
    return sum + rows
  }, 0)
}

/** The draft's lead and indent in the thread: the cursor column and a margin, as a message row has. */
export const DRAFT_INDENT = 3

/** Terminal rows a draft row takes: its head, its whole text wrapped (or the field), its verdict. */
export function draftHeight(draft: DraftView, width: number): number {
  return 1 + (draft.isEditing ? 1 : wrapRows(draft.text, width - DRAFT_INDENT)) + 1
}

/** A message row: its line, and its buttons' row under it when it has buttons. */
export function messageHeight(message: TgMessage): number {
  return message.buttons.length > 0 ? 2 : 1
}

export function rowHeight(row: ThreadRow, width: number): number {
  return row.kind === 'message' ? messageHeight(row.message) : draftHeight(row.draft, width)
}

/**
 * Where the thread's window starts so the cursor row fits whole in `rows`
 * terminal rows: it moves only when the cursor leaves the window (edge
 * scrolling, §4.3 rule 2), and never back up on its own, so a row that comes
 * or goes under the cursor leaves the rows above it where they were.
 */
export function windowStart(start: number, cursor: number, heights: readonly number[], rows: number): number {
  const last = Math.max(0, heights.length - 1)
  let first = Math.min(Math.max(0, start), last)
  const at = Math.min(Math.max(0, cursor), last)
  if (at < first) return at
  const sum = (from: number, to: number) => heights.slice(from, to + 1).reduce((total, one) => total + one, 0)
  while (first < at && sum(first, at) > rows) first += 1
  return first
}

/** How many rows from `start` the window holds whole: at least one. */
export function windowCount(start: number, heights: readonly number[], rows: number): number {
  let used = 0
  let count = 0
  for (const height of heights.slice(start)) {
    if (count > 0 && used + height > rows) break
    used += height
    count += 1
  }
  return Math.max(1, count)
}

/**
 * Where the thread's cursor and window go when rows come or go (a draft
 * landing, sent, dropped): each stays on the row it was on; when the cursor's
 * own row left, the next row takes its place, or the one before at the end.
 */
export function keptCursor(before: readonly string[], after: readonly string[], cursor: number, start: number): { cursor: number; start: number } {
  const found = after.indexOf(before[cursor] ?? '')
  const kept = found >= 0 ? found : Math.max(0, Math.min(cursor, after.length - 1))
  const first = after.indexOf(before[start] ?? '')
  return { cursor: kept, start: first >= 0 ? first : Math.min(start, kept) }
}

/** For you's and the band's test: the whole text on one row of `room` cells. */
export function fitsRow(text: string, room: number): boolean {
  return !text.includes('\n') && cells(oneLine(text, Infinity)) <= room
}
