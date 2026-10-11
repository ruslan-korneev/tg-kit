// What runs, in one model (docs/design/dialogs-pane-ux.md §5.6, §5.7, T4): a
// row per chat with something on it (an autopilot level, a follow, a delegate
// task), read by the dock's running strip, Activity's running rows and the kill
// switch's answer; and Activity's log, the packet ledger and the autopilot's
// merged by time. Pure.
import type { ActivityView, ApDialog, ApEntry, ApLevel, ApOutcome, ApPhase, LedgerEntry, PeerRef, PinWatch, TgPeerKind } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { packetLogText } from '../routing/route'
import { GLYPH, clockText, dialogGlyph, isSamePeer, labelCells, oneLine, peerKey } from './model'
import type { Role } from './palette'

/** One chat with something on it. */
export type RunRow = {
  peer: PeerRef
  /** The autopilot running here: its level, `auto 3/50` or the level's name, and what it does now. */
  agent: { level: ApLevel; tail: string; phase: ApPhase } | null
  /** Followed into main or an agent (`p`). */
  follow: { to: string; state: PinWatch['status'] } | null
  /** The newest task here not dismissed: the live one if there is one. */
  task: { isLive: boolean; isHeld: boolean; tail: string } | null
  /** Live tasks here: each holds a Worker. */
  workers: number
}

export type RunInput = {
  /** The autopilot's running dialogs, in the order they started. */
  agents: readonly { peer: PeerRef; level: ApLevel; tail: string; phase: ApPhase }[]
  follows: readonly { peer: PeerRef; to: string; state: PinWatch['status'] }[]
  /** Every task not dismissed, oldest first. */
  tasks: readonly { peer: PeerRef; isLive: boolean; isHeld: boolean; tail: string }[]
}

/** The rows: the autopilot's dialogs first, then chats with a task only, then the ones only followed. */
export function runRows(input: RunInput): RunRow[] {
  // By peer key: a forum topic's agent is a row of its own (§10.9).
  const rows = new Map<string, RunRow>()
  const row = (peer: PeerRef): RunRow => {
    const known = rows.get(peerKey(peer))
    if (known !== undefined) return known
    const fresh: RunRow = { peer, agent: null, follow: null, task: null, workers: 0 }
    rows.set(peerKey(peer), fresh)
    return fresh
  }
  for (const agent of input.agents) row(agent.peer).agent = { level: agent.level, tail: agent.tail, phase: agent.phase }
  for (const task of input.tasks) {
    const one = row(task.peer)
    if (task.isLive) one.workers += 1
    if (one.task === null || task.isLive || !one.task.isLive) one.task = { isLive: task.isLive, isHeld: task.isHeld, tail: task.tail }
  }
  for (const follow of input.follows) row(follow.peer).follow = { to: follow.to, state: follow.state }
  return [...rows.values()]
}

/** Something here has to be stopped by `0`: a level, a follow, a Worker. A finished task alone does not. */
export function isRunning(row: RunRow): boolean {
  return row.agent !== null || row.follow !== null || row.workers > 0
}

/** The glyphs before a row's name: the level's (a task's chat is a delegate's), then ⌁ for a follow. */
function glyphsOf(row: RunRow): string {
  const level = row.agent !== null ? LEVEL_GLYPH[row.agent.level] : row.task !== null ? LEVEL_GLYPH.delegate : ''
  return `${level}${row.follow === null ? '' : GLYPH.pinned}`
}

// --- the dock's running strip (§5.6) ---

export const STOP_LABEL = '0: stop all'

export type StripItem = { key: string; text: string; isHeld: boolean }

/** `⌁ @example_bot → main`, `⟳ Dev Team`, `↯ Contact B ⏸`: one item per running chat. */
export function stripItems(rows: readonly RunRow[]): StripItem[] {
  return rows.filter(isRunning).map(row => {
    const to = row.agent === null && row.follow !== null ? ` → ${row.follow.to}` : ''
    const isHeld = row.task?.isLive === true && row.task.isHeld
    return { key: peerKey(row.peer), text: `${glyphsOf(row)} ${row.peer.label}${to}${isHeld ? ' ⏸' : ''}`, isHeld }
  })
}

export const STRIP_SEP = ' · '

/**
 * The items that fit beside `0: stop all` in `width` cells, and how many are
 * left over (`+2`). Names err wide, so a strip shows one name fewer rather than
 * a cut one.
 */
export function fitStrip(items: readonly StripItem[], width: number): { shown: StripItem[]; more: number } {
  const count = fitCount(items.map(item => item.text), STRIP_SEP, width - STOP_LABEL.length - 2)
  return { shown: items.slice(0, count), more: items.length - count }
}

/** How many of `texts`, joined by `sep` and followed by ` +N` for the rest, fit in `room` cells; the first always shows. */
function fitCount(texts: readonly string[], sep: string, room: number): number {
  const used = (count: number) => {
    const more = texts.length - count
    return labelCells(texts.slice(0, count).join(sep)) + (more === 0 ? 0 : ` +${more}`.length)
  }
  let count = texts.length
  while (count > 1 && used(count) > room) count -= 1
  return count
}

// --- the kill switch's answer (§5.6) ---

/** One stopped chat and what stopped there, in the answer's words: `Contact B (delegate and its Worker)`. */
export type Stopped = { label: string; what: string[]; isAgent: boolean; isFollow: boolean }

/** What `0` and `/tg stop` stop, read before they stop it. */
export function stoppedOf(rows: readonly RunRow[]): Stopped[] {
  return rows.filter(isRunning).map(row => {
    const workers = row.workers === 0 ? '' : row.workers === 1 ? 'its Worker' : `its ${row.workers} Workers`
    const what = [
      ...(row.agent === null ? (workers === '' ? [] : [workers]) : [workers === '' ? row.agent.level : `${row.agent.level} and ${workers}`]),
      ...(row.follow === null ? [] : ['follow']),
    ]
    return { label: row.peer.label, what, isAgent: row.agent !== null || row.workers > 0, isFollow: row.follow !== null }
  })
}

const named = (stopped: readonly Stopped[]) => stopped.map(one => `${one.label} (${one.what.join(', ')})`).join(', ')

/** How to start one again: the card for an agent, `p` for a follow. */
function restart(stopped: readonly Stopped[]): string {
  const isAgent = stopped.some(one => one.isAgent)
  const isFollow = stopped.some(one => one.isFollow)
  if (!isAgent) return '/tg, then p in the chat, follows it again.'
  return isFollow ? 'Settings are kept; /tg, then a (p for a follow), restarts one.' : 'Settings are kept; /tg, then a, restarts one.'
}

/**
 * What the kill switch did: the chats it stopped, read before it stopped them,
 * and each part that threw on the way (`@example_bot (follow): …`). A part that
 * failed does not keep the others from stopping.
 */
export type StopReport = { stopped: Stopped[]; failed: string[] }

/** `/tg stop` (and `/tg autopilot off`): what stopped, by name, and what failed to. */
export function stopAnswer(report: StopReport): string {
  const failed = report.failed.length === 0 ? '' : `\n⚠ not stopped cleanly: ${report.failed.join('; ')}.`
  if (report.stopped.length === 0) return `tg: nothing was running.${failed}`
  return `tg: stopped ${named(report.stopped)}.${failed}\n${restart(report.stopped)}`
}

/** The dock's strip row after `0`, fitted to `width`: `■ stopped: Dev Team, @example_bot +1`; the toast says the rest. */
export function stopNotice(names: readonly string[], failed: number, width: number): string {
  const head = '■ stopped: '
  const tail = failed === 0 ? '' : ` · ⚠ ${failed} failed`
  const count = fitCount(names, ', ', width - head.length - tail.length)
  const more = names.length - count
  return `${head}${names.slice(0, count).join(', ')}${more === 0 ? '' : ` +${more}`}${tail}`
}

// --- Activity (§5.7) ---

/**
 * Activity's rows after a redraw: the ones it had, in their order, then the
 * chats that started since. A row whose chat stopped stays (drawn stopped)
 * until the view closes, so a row never moves up under the ring (§4.3 rule 1).
 */
export function activityOrder(view: ActivityView, rows: readonly RunRow[]): ActivityView['rows'] {
  const known = new Set(view.rows.map(peerKey))
  return [...view.rows, ...rows.filter(row => !known.has(peerKey(row.peer))).map(row => row.peer)]
}

/** One running row of Activity: glyphs, the name in a column, what it does. */
export function activityText(row: RunRow | null, label: string): string {
  const name = label.length > 14 ? `${label.slice(0, 13)}…` : label.padEnd(14)
  if (row === null) return `■  ${name} stopped`
  const parts = [
    ...(row.agent === null ? [] : [`${row.agent.tail} · ${row.agent.phase}`]),
    ...(row.task === null ? [] : [row.task.tail]),
    ...(row.follow === null ? [] : [`follows → ${row.follow.to} · ${row.follow.state}`]),
  ]
  return `${glyphsOf(row).padEnd(2)} ${name} ${parts.join(' · ')}`
}

/** ⏎ on a running row: the agent card while an autopilot runs there without a task, else the chat (the task's card is on top). */
export function activityTarget(row: RunRow | null): 'card' | 'chat' {
  return row !== null && row.agent !== null && row.task === null ? 'card' : 'chat'
}

// --- the AUTOPILOT card and the log (§10.6, T14) ---

/** A run of text in one role; `null` is the card's own colour. Rows of the card are lists of these, so the drawing only colours them. */
export type Seg = { text: string; role: Role | null }

/** A card under this many inner cells drops the words: `11 · 2 · 1`, `0:12`, `AUTOPILOT · 2` (a 52-column pane, §10.5). */
export const WIDE_INNER = 48

const HOUR_MS = 3_600_000

/** `0:41`, `41:07`: minutes and seconds, for the lanes' clocks and `↻` (decision 4). */
export function minSec(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** `text` cut to `room` cells with `…`, counted as the terminal draws it (`labelCells`). */
export function cutCells(text: string, room: number): string {
  if (labelCells(text) <= room) return text
  let out = ''
  for (const char of text) {
    if (labelCells(`${out}${char}…`) > room) break
    out += char
  }
  return `${out}…`
}

/** `text` cut to `width` cells and padded to exactly that. */
function column(text: string, width: number): string {
  const cut = cutCells(text, width)
  return `${cut}${' '.repeat(Math.max(0, width - labelCells(cut)))}`
}

// The gauge: the chat nearest its limit.

/** The running chat nearest its hourly limit: its sends in the last hour, the limit, and when the oldest of them leaves the hour. */
export type Gauge = { peer: PeerRef; sent: number; perHour: number; freeInMs: number | null }

/**
 * The chat nearest its limit, by sends over `perHour` (the gate's own count,
 * `sentLastHour`: auto sends in the last hour); ties go to the one with more
 * sends, then the first started. A chat without a limit has no gauge; none
 * with one is null.
 */
export function gauge(dialogs: readonly ApDialog[], ledger: readonly ApEntry[], now: number): Gauge | null {
  let best: Gauge | null = null
  for (const dialog of dialogs) {
    if (dialog.perHour === null) continue
    const counted = ledger.filter(entry => isSamePeer(entry.peer, dialog.peer) && entry.outcome.kind === 'sent' && entry.outcome.by === 'auto' && entry.at > now - HOUR_MS)
    const oldest = counted.reduce((min, entry) => Math.min(min, entry.at), Number.POSITIVE_INFINITY)
    const one: Gauge = { peer: dialog.peer, sent: counted.length, perHour: dialog.perHour, freeInMs: counted.length === 0 ? null : oldest + HOUR_MS - now }
    const ratio = (g: Gauge) => g.sent / g.perHour
    if (best === null || ratio(one) > ratio(best) || (ratio(one) === ratio(best) && one.sent > best.sent)) best = one
  }
  return best
}

export const GAUGE_CELLS = 5

/** How many of the five `▰` are filled (any send fills one), and their role: `held` from 80 %, `unread` at the limit. */
export function gaugeBar(g: Gauge): { filled: number; role: Role } {
  const ratio = g.sent / g.perHour
  const filled = Math.min(GAUGE_CELLS, Math.ceil(ratio * GAUGE_CELLS))
  return { filled, role: ratio >= 1 ? 'unread' : ratio >= 0.8 ? 'held' : 'ok' }
}

/** `12/50`: the compact card's and the Hidden line's pair. */
export function gaugePair(g: Gauge): string {
  return `${g.sent}/${g.perHour}`
}

/** `▰▰▱▱▱ 12/50`: the bar and the pair, as the card, the compact card and Activity draw them. */
export function gaugeSegs(g: Gauge): Seg[] {
  const bar = gaugeBar(g)
  return [
    { text: '▰'.repeat(bar.filled), role: bar.role },
    { text: '▱'.repeat(GAUGE_CELLS - bar.filled), role: 'dim' },
    { text: ` ${gaugePair(g)}`, role: 'text' },
  ]
}

/** The card's first row: `▰▰▱▱▱ 12/50 per hour · Dev chat  ↻ 0:41`; no limit anywhere, `no hourly limit`. */
export function gaugeLine(g: Gauge | null, width: number): Seg[] {
  if (g === null) return [{ text: '∞/h · no hourly limit', role: 'dim' }]
  const isWide = width >= WIDE_INNER
  const free = g.freeInMs === null ? '' : `${isWide ? '  ' : ' '}↻ ${minSec(g.freeInMs)}`
  const head = gaugeSegs(g)
  const per = isWide ? ' per hour' : ''
  const used = labelCells(head.map(seg => seg.text).join('')) + per.length + 3 + labelCells(free)
  return [
    ...head,
    { text: per, role: 'dim' },
    { text: ' · ', role: 'dim' },
    { text: cutCells(g.peer.label, Math.max(4, width - used)), role: 'text' },
    { text: free, role: 'dim' },
  ]
}

// The cell strip.

export const CELL_KINDS = ['sent', 'held', 'asked', 'refused'] as const
export type CellKind = (typeof CELL_KINDS)[number]

export const CELL_ROLE = { sent: 'ok', held: 'held', asked: 'mention', refused: 'unread' } as const satisfies Record<CellKind, Role>

/** §10.6's map from an outcome to its cell; `working`, `listened`, `dropped` and `allowed` draw none. */
export function cellOf(outcome: ApOutcome): CellKind | null {
  switch (outcome.kind) {
    case 'sent':
      return 'sent'
    case 'drafted':
      return 'held'
    case 'stop':
      return 'asked'
    case 'failed':
    case 'skipped':
      return 'refused'
    case 'working':
    case 'listened':
    case 'dropped':
    case 'allowed':
      return null
  }
}

/** The strip: the newest `room` cells, oldest first (newest at the right), and every event's count (not just the shown). */
export type Strip = { cells: CellKind[]; counts: Record<CellKind, number> }

export function cells(entries: readonly ApEntry[], room: number): Strip {
  const all = [...entries]
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
    .flatMap(entry => {
      const cell = cellOf(entry.outcome)
      return cell === null ? [] : [cell]
    })
  const counts: Record<CellKind, number> = { sent: 0, held: 0, asked: 0, refused: 0 }
  for (const cell of all) counts[cell] += 1
  return { cells: room <= 0 ? [] : all.slice(-room), counts }
}

/** `sent 11 · held 2 · asked 1 · refused 1`, each word in its cell's role, zeros left out; narrow, the numbers only. */
function countSegs(counts: Strip['counts'], isWide: boolean): Seg[] {
  return CELL_KINDS.filter(kind => counts[kind] > 0).flatMap((kind, index) => [
    ...(index === 0 ? [] : [{ text: ' · ', role: 'dim' as const }]),
    { text: isWide ? `${kind} ${counts[kind]}` : String(counts[kind]), role: CELL_ROLE[kind] },
  ])
}

/** The card's second row: as many cells as fit beside the counts. */
export function stripLine(entries: readonly ApEntry[], width: number): Seg[] {
  const isWide = width >= WIDE_INNER
  const counted = cells(entries, 0).counts
  const tail = countSegs(counted, isWide)
  if (tail.length === 0) return [{ text: 'no replies yet', role: 'dim' }]
  const tailCells = labelCells(tail.map(seg => seg.text).join(''))
  const strip = cells(entries, width - 2 - tailCells)
  // Runs of one kind draw as one Text.
  const runs: Seg[] = []
  for (const cell of strip.cells) {
    const last = runs.at(-1)
    if (last !== undefined && last.role === CELL_ROLE[cell]) last.text += '■'
    else runs.push({ text: '■', role: CELL_ROLE[cell] })
  }
  return [...runs, { text: '  ', role: null }, ...tail]
}

// The lanes.

/** One running chat as the card reads it: its newest ledger entry, the burst it waits on, a draft held, a live task. */
export type LaneInput = {
  peer: PeerRef
  level: ApLevel
  phase: ApPhase
  gapS: number
  /** The newest incoming message of the burst not answered yet; null with no burst. */
  burstAt: number | null
  /** This chat's newest ledger entry. */
  latest: ApEntry | null
  hasDraft: boolean
  /** A delegate's live task: when it started. */
  taskAt: number | null
}

export type LaneState =
  | { kind: 'drafting'; ms: number }
  | { kind: 'waits' }
  | { kind: 'task'; minutes: number }
  | { kind: 'sent'; confidence: number | null }
  | { kind: 'listening' }

/** One lane: the level glyph, the name, how much of the burst's gap has passed (0–1; null with no burst waiting), and the state. */
export type Lane = { peer: PeerRef; glyph: string; gap: number | null; state: LaneState }

/** `sent 0.93` stays this long at most; then, or at the next burst, `listening` (the designer's call on §10.6). */
export const SENT_SHOWN_MS = 5 * 60_000

const DRAFTING: ReadonlySet<ApPhase> = new Set(['thinking', 'checking', 'sending'])

/**
 * The lanes, in the order the chats started. The lane is the burst's wait:
 * the time since its newest message against the gap. The state, first that
 * holds: drafting (the clock since the burst's entry began), a draft waits,
 * a delegate's task, a send in the last five minutes, listening.
 */
export function lanes(running: readonly LaneInput[], now: number): Lane[] {
  return running.map(one => {
    const gap = one.burstAt === null ? null : Math.min(1, Math.max(0, (now - one.burstAt) / (one.gapS * 1000)))
    const latest = one.latest
    const state: LaneState =
      DRAFTING.has(one.phase)
        ? { kind: 'drafting', ms: latest !== null && latest.outcome.kind === 'working' ? now - latest.at : 0 }
        : one.hasDraft
          ? { kind: 'waits' }
          : one.taskAt !== null
            ? { kind: 'task', minutes: Math.max(0, Math.floor((now - one.taskAt) / 60_000)) }
            : latest !== null && latest.outcome.kind === 'sent' && one.burstAt === null && now - latest.at < SENT_SHOWN_MS
              ? { kind: 'sent', confidence: latest.confidence }
              : { kind: 'listening' }
    return { peer: one.peer, glyph: LEVEL_GLYPH[one.level], gap, state }
  })
}

function stateSeg(state: LaneState, isWide: boolean): Seg {
  switch (state.kind) {
    case 'drafting':
      return { text: isWide ? `drafting ${minSec(state.ms)}` : minSec(state.ms), role: 'text' }
    case 'waits':
      return { text: 'draft waits', role: 'held' }
    case 'task':
      return { text: `task ${state.minutes} min`, role: 'subtext' }
    case 'sent':
      return { text: state.confidence === null ? 'sent' : `sent ${state.confidence.toFixed(2)}`, role: 'ok' }
    case 'listening':
      return { text: 'listening', role: 'dim' }
  }
}

/** The lane's cells: 20 at most, and what the name and the widest state leave. */
export function laneCells(width: number): number {
  const isWide = width >= WIDE_INNER
  return Math.max(4, Math.min(20, width - 2 - (isWide ? 13 : 12) - (isWide ? 2 : 1) - 13))
}

/** `⟳ Dev chat     ━━━━━━━━━━··········  drafting 0:12`. */
export function laneLine(lane: Lane, width: number): Seg[] {
  const isWide = width >= WIDE_INNER
  const cellsWide = laneCells(width)
  const done = Math.round((lane.gap ?? 0) * cellsWide)
  return [
    { text: `${lane.glyph} `, role: 'ok' },
    { text: `${column(lane.peer.label, isWide ? 12 : 11)} `, role: 'text' },
    { text: '━'.repeat(done), role: 'ok' },
    { text: '·'.repeat(cellsWide - done), role: 'dim' },
    { text: isWide ? '  ' : ' ', role: null },
    stateSeg(lane.state, isWide),
  ]
}

/** At most three lanes on the dock's card; Activity shows them all. */
export const MAX_LANES = 3

/** The card's content rows: none with no agent on, else the gauge, the strip and a lane per chat (three at most). */
export function autopilotRows(lanes: number, max: number = MAX_LANES): number {
  return lanes === 0 ? 0 : 2 + Math.min(max, lanes)
}

/** `AUTOPILOT · 2 chats`, `AUTOPILOT · 5 chats · +2`; narrow `AUTOPILOT · 2`. */
export function autopilotTitle(chats: number, shown: number, width: number): string {
  const more = chats > shown ? ` · +${chats - shown}` : ''
  return width >= WIDE_INNER ? `AUTOPILOT · ${chats} chat${chats === 1 ? '' : 's'}${more}` : `AUTOPILOT · ${chats}${more}`
}

/** Everything the AUTOPILOT card draws, read once per draw. */
export type AutopilotCard = { gauge: Gauge | null; entries: readonly ApEntry[]; lanes: readonly Lane[] }

// The log.

/** A log line's text colour: `subtext`, or its outcome's role. */
export type LogTone = Extract<Role, 'subtext' | 'ok' | 'held' | 'mention' | 'unread'>
/** One line of the log: the time and the chat are their own columns, coloured apart from the text (§10.6). */
export type LogRow = { key: string; at: number; peer: { label: string; kind: TgPeerKind }; text: string; tone: LogTone }

const PACKET = '▣'


const conf = (confidence: number | null) => (confidence === null ? '' : ` · ${confidence.toFixed(2)}`)

/** `u` on an auto reply: the log says it was taken back, or why not. */
function undoTail(undo: ApEntry['undo']): string {
  if (undo === null) return ''
  switch (undo.state) {
    case 'undone':
      return ' · undone'
    case 'failed':
      return ` · undo failed: ${undo.reason}`
    case 'open':
    case 'expired':
      return ''
  }
}

/** What the autopilot did with a burst, in the log's words: `sent "Merged, thanks" · 0.93`. */
function entryText(entry: ApEntry): string {
  const outcome = entry.outcome
  switch (outcome.kind) {
    case 'working':
      return `${GLYPH.working}working`
    case 'sent':
      return `sent${outcome.by === 'you' ? ' by you' : ''} "${oneLine(entry.reply, 60)}"${conf(entry.confidence)}${undoTail(entry.undo)}`
    case 'drafted':
      return `draft waits${outcome.reasons.length === 0 ? '' : ` · ${outcome.reasons.join(' · ')}`}${conf(entry.confidence)}`
    case 'dropped':
      return 'draft dropped'
    case 'listened':
      return `summarized: ${oneLine(entry.reply, 60)}`
    case 'allowed':
      return outcome.line
    case 'skipped':
      return `skipped: ${outcome.reason}`
    case 'failed':
      return `${GLYPH.error} ${outcome.reason}`
    // ── delegate ──
    case 'stop':
      return outcome.answer === 'skipped'
        ? `skipped stop: ${outcome.stops.join(', ')} ${outcome.what}`
        : `asked ${outcome.stops.join(' + ')}: ${outcome.what} → ${outcome.answer} (${outcome.why})`
  }
}

/**
 * The log: packets that left the pane, the autopilot's bursts and drafts, and
 * the hard stops (the guard's events come in as entries too), newest first.
 */
export function mergedLog(packets: readonly LedgerEntry[], entries: readonly ApEntry[]): LogRow[] {
  const fromPackets = packets.map(
    (entry): LogRow => ({
      key: `ledger:${entry.seq}`,
      at: entry.at,
      peer: { label: entry.peer.label, kind: entry.peer.kind },
      text: `${PACKET} ${packetLogText(entry)}`,
      tone: entry.state.kind === 'done' ? 'ok' : entry.state.kind === 'failed' ? 'unread' : 'subtext',
    }),
  )
  const fromEntries = entries.map((entry): LogRow => {
    const cell = cellOf(entry.outcome)
    return { key: `ap:entry:${entry.seq}`, at: entry.at, peer: { label: entry.peer.label, kind: entry.peer.kind }, text: entryText(entry), tone: cell === null ? 'subtext' : CELL_ROLE[cell] }
  })
  return [...fromPackets, ...fromEntries].sort((a, b) => b.at - a.at)
}

/** One log line in its columns: `14:02  Dev chat      sent "Merged, thanks" · 0.93`, the name 13 cells wide (12 narrow), the text cut to fit. */
export function logLine(row: LogRow, width: number): Seg[] {
  const name = width >= WIDE_INNER ? 13 : 12
  const head = 5 + 2 + name + 1
  return [
    { text: `${clockText(row.at)}  `, role: 'dim' },
    { text: `${column(row.peer.label, name)} `, role: dialogGlyph(row.peer.kind).role },
    { text: cutCells(row.text, Math.max(1, width - head)), role: row.tone },
  ]
}
