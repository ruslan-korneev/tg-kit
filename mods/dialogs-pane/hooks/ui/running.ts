// What runs, in one model (docs/design/dialogs-pane-ux.md §5.6, §5.7, T4): a
// row per chat with something on it (an autopilot level, a follow, a delegate
// task), read by the dock's running strip, Activity's running rows and the kill
// switch's answer; and Activity's log, the packet ledger and the autopilot's
// merged by time. Pure.
import type { ActivityView, ApEntry, ApLevel, ApPhase, LedgerEntry, PeerRef, PinWatch } from '../../types'
import { LEVEL_GLYPH } from '../autopilot/config'
import { entryLines } from '../autopilot/ledger'
import { ledgerRowText } from '../routing/route'
import { GLYPH, clockText, labelCells } from './model'

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
  const rows = new Map<number, RunRow>()
  const row = (peer: PeerRef): RunRow => {
    const known = rows.get(peer.id)
    if (known !== undefined) return known
    const fresh: RunRow = { peer, agent: null, follow: null, task: null, workers: 0 }
    rows.set(peer.id, fresh)
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

/** `⌁ @example_bot → main`, `⟳ Dev Team`, `⚡ Contact B ⏸`: one item per running chat. */
export function stripItems(rows: readonly RunRow[]): StripItem[] {
  return rows.filter(isRunning).map(row => {
    const to = row.agent === null && row.follow !== null ? ` → ${row.follow.to}` : ''
    const isHeld = row.task?.isLive === true && row.task.isHeld
    return { key: String(row.peer.id), text: `${glyphsOf(row)} ${row.peer.label}${to}${isHeld ? ' ⏸' : ''}`, isHeld }
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
  const known = new Set(view.rows.map(one => one.id))
  return [...view.rows, ...rows.filter(row => !known.has(row.peer.id)).map(row => row.peer)]
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

export type LogTone = 'plain' | 'ok' | 'warn' | 'danger'
export type LogRow = { key: string; at: number; text: string; tone: LogTone }

const PACKET = '▣'

/**
 * Activity's log: packets that left the pane, the autopilot's bursts and
 * drafts, and the hard stops (the guard's events come in as entries too),
 * newest first by time.
 */
export function mergedLog(packets: readonly LedgerEntry[], entries: readonly ApEntry[], now: number, width: number): LogRow[] {
  const fromPackets = packets.map(
    (entry): LogRow => ({
      key: `ledger:${entry.seq}`,
      at: entry.at,
      text: `${clockText(entry.at)} ${PACKET} ${ledgerRowText(entry, now)}`,
      tone: entry.state.kind === 'done' ? 'ok' : entry.state.kind === 'failed' ? 'danger' : 'plain',
    }),
  )
  const fromEntries = entries.map((entry): LogRow => {
    const tone: LogTone = entry.outcome.kind === 'failed' ? 'danger' : entry.outcome.kind === 'drafted' || entry.outcome.kind === 'stop' ? 'warn' : 'plain'
    return { key: `ap:entry:${entry.seq}`, at: entry.at, text: `${clockText(entry.at)} ${LEVEL_GLYPH[entry.level]} ${entry.peer.label} · ${entryLines(entry, now, width)[1].trim()}`, tone }
  })
  return [...fromPackets, ...fromEntries].sort((a, b) => b.at - a.at)
}
