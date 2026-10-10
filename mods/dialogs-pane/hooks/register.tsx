// Dialogs Pane, phase 1: Telegram dialogs and threads in a pane, read through
// the `tg` CLI. Wide (dock), Compact (inline) and Hidden (status line + band).
// Design: docs/design/dialogs-pane.md §1, §2, §4.
//
// Every function that takes `$` lives in this file: the engine follows `$`
// only into functions declared beside the hook. ./ui and ./tg stay pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, On, Register, RenderElement, Timer } from 'claude-code'

import type {
  BandEvent,
  Lens,
  LensDraft,
  Load,
  Mode,
  Nav,
  PeerRef,
  SavedLens,
  Summary,
  TgDialog,
  TgFailure,
  WatchHealth,
} from '../types'
import type { MessageView } from './packet/types'
import { TG_TIMEOUT_MS, settle, tg, type TgRequest, type TgResult } from './tg/tg'
import { EmptySavedLens, LensEditor, LensTabs, SummaryBlock, WatchRow, summaryRows, watchMark } from './triage/components'
import { MAX_LENSES, draftFrom, parseLenses, toggleGroup, togglePicked, upsertLens } from './triage/lenses'
import { EMPTY_TRIAGE, RECENT, applyToDialogs, applyToMessages, hiddenStatus, latencyText, repliesToYou, reportReply } from './triage/live'
import { RANK_SYSTEM, parseMe, parseVerdicts, pruneVerdicts, rankPrompt, toAsk, verdictKey, type Me } from './triage/needs'
import { SUMMARY_LIMIT, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS, TRIAGE_MODEL, summaryPrompt } from './triage/summary'
import { NO_ME, triageDialogs } from './triage/view'
import { MAX_WATCHED, ending, parseWatchLine, parseWatched, splitLines, watchArgv, type WatchEvent } from './triage/watch'
import {
  DialogRow,
  Divider,
  EmptyLens,
  Header,
  HintsRow,
  LensBar,
  LoadState,
  MessageCard,
  PacketTray,
  windowAround,
  type Els,
} from './ui/components'
import {
  GLYPH,
  NO_SELECTION,
  TOKEN,
  clamp,
  defaultMode,
  dialogLabel,
  failureText,
  grownDialog,
  hintsFor,
  isMode,
  loaded,
  nextMode,
  oneLine,
  peerArg,
  rangeSelect,
  selectWhole,
  toggleSelected,
} from './ui/model'

type $ = EngineInterface

const PANE = 'tg'
const STORE_MODE = 'mode'
// Watched dialogs and the open thread are live through `tg watch` (triage);
// this slow poll keeps the unread counts of everything else.
const POLL_MS = 300_000
const THREAD_LIMIT = 30
const MODE_ARGS: readonly Mode[] = ['wide', 'compact', 'hidden']

const mode = atom({ plugin: 'dialogs-pane', key: 'mode' } as const, 'compact')
const nav = atom({ plugin: 'dialogs-pane', key: 'nav' } as const, {
  view: 'dialogs',
  lens: 'all',
  query: '',
  dialogCursor: 0,
  messageCursor: 0,
})
const dialogs = atom({ plugin: 'dialogs-pane', key: 'dialogs' } as const, { status: 'idle' })
const thread = atom({ plugin: 'dialogs-pane', key: 'thread' } as const, null)
const selection = atom({ plugin: 'dialogs-pane', key: 'selection' } as const, NO_SELECTION)
const band = atom({ plugin: 'dialogs-pane', key: 'band' } as const, null)
const now = atom({ plugin: 'dialogs-pane', key: 'now' } as const, 0)

export const register: Register = on => {
  registerTriage(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tg',
      description: 'Open or focus the Telegram dialogs pane',
      argumentHint: '[wide|compact|hidden]',
    })
    const kept = await $.store.get(STORE_MODE)
    if (isMode(kept)) await update($, mode, () => kept)
    // Hidden keeps its status line fresh; an open pane keeps its list fresh.
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => {
        // A failed poll leaves the last list on screen; the next one retries.
      })
    })
    if (kept === 'hidden') {
      loadDialogs($).catch(() => {
        // The status line stays at `tg …` until the first poll lands.
      })
    }
    await startTriage($)
    return next(e)
  })

  on('command.run', { command: 'tg' }, async ($, e) => {
    const asked = e.args.trim()
    const named = MODE_ARGS.find(one => one === asked)
    if (asked !== '' && named === undefined) return { text: 'Usage: /tg [wide|compact|hidden]' }
    // Never chosen, or Hidden: open as the terminal suits; else as last left.
    const kept = await $.store.get(STORE_MODE)
    const target = named ?? (isMode(kept) && kept !== 'hidden' ? kept : defaultMode(e.presentation))
    await setMode($, target)
    if (target !== 'hidden' && (await read($, dialogs)).status !== 'ok') {
      loadDialogs($).catch(() => {
        // loadDialogs records its own failures in state; nothing is left to report.
      })
    }
    return { text: target === 'hidden' ? 'tg pane hidden: status line only.' : `tg pane open (${target}).` }
  })

  // The person closing the pane by hand leaves the status line: Hidden.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (e.origin.kind === 'person') {
      await update($, mode, () => 'hidden')
      await $.store.set(STORE_MODE, 'hidden')
      await refreshStatus($)
      await syncWatches($)
    }
    return done
  }).catch(($, e, next) => next(e))

  // Arrows and clicks move the focus ring; the cursor follows it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (done.deny === undefined && e.element !== undefined) await followRing($, e.element)
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    return (await read($, mode)) === 'wide'
      ? await drawWide($, els, width, rows)
      : await drawCompact($, els, width, rows)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const event = await read($, band)
    if (e.props.hasSurvey || event === null || (await read($, mode)) !== 'hidden') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isBot = event.kind === 'bot'
    const room = Math.max(10, e.props.bodyColumns - event.label.length - 24)
    return (
      <Box flexDirection="row" gap={2}>
        <Text wrap="truncate-end">
          <Text color={isBot ? TOKEN.bot : TOKEN.accent}>{isBot ? GLYPH.bot : GLYPH.unread} </Text>
          {`${event.label}: "${oneLine(event.text, room)}"`}
        </Text>
        {await bandLatency($, $.ui.resolve(e), event)}
        {/* tg-mod-routing: "⏎ send to main" goes here. The watched reply it sends is
            triage's `reply` (dialogId, messageId), set as the reply arrives. */}
        <Button key="band:open" plain hotkey="o" onPress={() => openFromBand($)}>
          open
        </Button>
        <Button key="band:dismiss" plain hotkey="x" dimColor onPress={() => dismissBand($)}>
          dismiss
        </Button>
      </Box>
    )
  })
}

// --- tg through $.process.run ---

async function runTg<T>($: $, req: TgRequest<T>): Promise<TgResult<T>> {
  try {
    return settle(req, await $.process.run(req.argv, { timeoutMs: TG_TIMEOUT_MS }))
  } catch {
    // The run rejects when tg cannot start or outlives the timeout; settle
    // reports both as `missing`, which the pane explains.
    return settle(req, undefined)
  }
}

// --- mode: Wide / Compact / Hidden, kept in $.store across sessions ---

/**
 * Seats the pane for `next`: Wide asks the dock for width, Compact asks for
 * 12 rows inline, Hidden closes it and leaves the status line and band.
 */
async function setMode($: $, next: Mode): Promise<void> {
  await update($, mode, () => next)
  await $.store.set(STORE_MODE, next)
  if (next === 'hidden') {
    await $.ui.close({ id: PANE })
  } else {
    const seat = next === 'wide' ? { columns: 64 } : { rows: 12 }
    await $.ui.open({ id: PANE, title: 'tg · dialogs', focus: true, ...seat })
  }
  await refreshStatus($)
  await syncWatches($)
}

async function cycleMode($: $): Promise<void> {
  await setMode($, nextMode(await read($, mode)))
}

async function refreshStatus($: $): Promise<void> {
  if ((await read($, mode)) !== 'hidden') {
    $.ui.status(undefined)
    return
  }
  $.ui.status(hiddenStatus(await read($, dialogs), await read($, band), (await read($, triage)).reply))
}

async function poll($: $): Promise<void> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (isUp || (await read($, mode)) === 'hidden') await loadDialogs($, { isQuiet: true })
}

// --- loading, and the flood-wait countdown ---

let floodTimer: Timer | null = null

function failed<T>(failure: TgFailure, at: number): Load<T> {
  return failure.kind === 'flood'
    ? { status: 'error', failure, retryAt: at + failure.seconds * 1000 }
    : { status: 'error', failure }
}

/**
 * Ticks `now` each second so the flood row counts down, and retries once the
 * wait is over. One countdown at a time: a newer flood wait replaces it.
 */
async function retryAfterFlood($: $, seconds: number, retry: () => Promise<void>): Promise<void> {
  floodTimer?.cancel()
  const until = (await $.clock.now()) + seconds * 1000
  const timer = $.clock.every(1000, () => {
    tick().catch(() => {
      // A failed tick only skips one second of the countdown.
    })
  })
  floodTimer = timer
  async function tick(): Promise<void> {
    const at = await $.clock.now()
    await update($, now, () => at)
    if (at < until) return
    timer.cancel()
    if (floodTimer === timer) floodTimer = null
    await retry()
  }
}

async function loadDialogs($: $, options: { isQuiet?: boolean } = {}): Promise<void> {
  const before = loaded(await read($, dialogs))
  // A quiet reload keeps the list on screen instead of the loading rows.
  if (options.isQuiet !== true || before === undefined) await update($, dialogs, () => ({ status: 'loading' }))
  const result = await runTg($, tg.dialogs())
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!result.ok) {
    await update($, dialogs, () => failed(result.failure, at))
    if (result.failure.kind === 'flood') await retryAfterFlood($, result.failure.seconds, () => loadDialogs($))
    await refreshStatus($)
    return
  }
  await update($, dialogs, () => ({ status: 'ok', value: result.value }))
  afterDialogs($).catch(() => {
    // Ranking is a convenience: without verdicts the list keeps tg's order.
  })
  const grown = before === undefined ? undefined : grownDialog(before, result.value)
  if (grown !== undefined && (await read($, mode)) === 'hidden') {
    await update($, band, () => ({ dialogId: grown.id, label: dialogLabel(grown), kind: grown.kind, text: grown.last_text }))
  }
  await refreshStatus($)
}

async function openThread($: $, dialog: TgDialog): Promise<void> {
  const peer: PeerRef = { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
  await update($, thread, () => ({ peer, load: { status: 'loading' } }))
  await update($, selection, () => NO_SELECTION)
  await update($, nav, value => ({ ...value, view: 'thread', messageCursor: 0 }))
  await loadThread($, peer)
  await syncWatches($)
}

async function loadThread($: $, peer: PeerRef): Promise<void> {
  const result = await runTg($, tg.read(peer.arg, { limit: THREAD_LIMIT }))
  const at = await $.clock.now()
  await update($, now, () => at)
  // A thread opened meanwhile owns the slot; this answer is another peer's.
  if ((await read($, thread))?.peer.id !== peer.id) return
  if (!result.ok) {
    await update($, thread, () => ({ peer, load: failed(result.failure, at) }))
    if (result.failure.kind === 'flood') await retryAfterFlood($, result.failure.seconds, () => loadThread($, peer))
    return
  }
  const messages = result.value
  await update($, thread, () => ({ peer, load: { status: 'ok', value: messages } }))
  await update($, nav, value => ({ ...value, messageCursor: Math.max(0, messages.length - 1) }))
}

async function reload($: $): Promise<void> {
  const open = await read($, thread)
  if ((await read($, nav)).view === 'thread' && open !== null) {
    await update($, thread, () => ({ peer: open.peer, load: { status: 'loading' } }))
    await loadThread($, open.peer)
    return
  }
  await loadDialogs($)
}

// --- keys: one action per hint or hotkey ---

async function shownDialogs($: $): Promise<TgDialog[]> {
  return visibleTriaged($, loaded(await read($, dialogs)) ?? [], await read($, nav))
}

async function threadMessages($: $) {
  const open = await read($, thread)
  return open === null ? [] : (loaded(open.load) ?? [])
}

/** Moves the cursor in the active list; answers the key of the row it lands on. */
async function moveCursor($: $, by: number): Promise<string | undefined> {
  if ((await read($, nav)).view === 'dialogs') {
    const list = await shownDialogs($)
    const moved = await update($, nav, value => ({ ...value, dialogCursor: clamp(value.dialogCursor + by, list.length) }))
    const dialog = list[moved.dialogCursor]
    return dialog === undefined ? undefined : `dialog:${dialog.id}`
  }
  const messages = await threadMessages($)
  const moved = await update($, nav, value => ({ ...value, messageCursor: clamp(value.messageCursor + by, messages.length) }))
  const message = messages[moved.messageCursor]
  return message === undefined ? undefined : `msg:${message.id}`
}

async function followRing($: $, element: string): Promise<void> {
  const [kind, raw] = element.split(':')
  const id = Number(raw)
  if (kind === 'dialog') {
    const index = (await shownDialogs($)).findIndex(dialog => dialog.id === id)
    if (index >= 0) await update($, nav, value => ({ ...value, view: 'dialogs', dialogCursor: index }))
  } else if (kind === 'msg') {
    const index = (await threadMessages($)).findIndex(message => message.id === id)
    if (index >= 0) await update($, nav, value => ({ ...value, view: 'thread', messageCursor: index }))
  }
}

async function openAtCursor($: $): Promise<void> {
  const list = await shownDialogs($)
  const dialog = list[clamp((await read($, nav)).dialogCursor, list.length)]
  if (dialog !== undefined) await openThread($, dialog)
}

async function selectAtCursor($: $, how: 'toggle' | 'range'): Promise<void> {
  const messages = await threadMessages($)
  const message = messages[clamp((await read($, nav)).messageCursor, messages.length)]
  if (message === undefined) return
  const order = messages.map(one => one.id)
  await update($, selection, value =>
    how === 'toggle' ? toggleSelected(value, message.id) : rangeSelect(value, order, message.id),
  )
}

/** `Esc`'s job, on `h`: clear the selection first, then go back to the dialogs. */
async function back($: $): Promise<void> {
  const chosen = await read($, selection)
  if (chosen.ids.length > 0 || chosen.anchor !== null) {
    await update($, selection, () => NO_SELECTION)
    return
  }
  await update($, nav, value => ({ ...value, view: 'dialogs' }))
}

async function moveRing($: $, key: string): Promise<void> {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // The ring is a convenience: the cursor already moved, and j/k/o act on
    // the cursor, so a ring that cannot move (a surface without one) degrades
    // only Enter, which then acts where the person last put the ring.
  }
}

async function onHint($: $, key: string): Promise<void> {
  switch (key) {
    case 'down':
    case 'up': {
      const row = await moveCursor($, key === 'down' ? 1 : -1)
      // The ring follows the cursor so Enter acts on it.
      if (row !== undefined) await moveRing($, row)
      return
    }
    case 'open':
      return openAtCursor($)
    case 'search':
      return moveRing($, 'search')
    case 'mode':
      return cycleMode($)
    case 'select':
      return selectAtCursor($, 'toggle')
    case 'range':
      return selectAtCursor($, 'range')
    case 'back':
      return back($)
  }
}

async function openFromBand($: $): Promise<void> {
  const event = await read($, band)
  await update($, band, () => null)
  await setMode($, defaultMode(undefined))
  const dialog = (loaded(await read($, dialogs)) ?? []).find(one => one.id === event?.dialogId)
  if (dialog !== undefined) await openThread($, dialog)
}

async function dismissBand($: $): Promise<void> {
  await update($, band, () => null)
  await refreshStatus($)
}

function sendStub($: $): void {
  // tg-mod-routing (phase 2) builds the packet and routes it; until then the
  // selection stays in the tray.
  $.ui.toast('tg: sending arrives with the routing phase; the selection is kept.')
}

// --- layouts ---

async function drawDialogList($: $, els: Els, width: number, rows: number): Promise<RenderElement[]> {
  const load = await read($, dialogs)
  const where = await read($, nav)
  const at = await read($, now)
  const open = await read($, thread)
  const editor = await drawLensEditor($, els, rows)
  if (editor !== null) return [editor]
  const waiting = LoadState(els, { load, now: at, rows, onReload: () => reload($) })
  if (waiting !== null) return [waiting]
  const list = await visibleTriaged($, loaded(load) ?? [], where)
  if (list.length === 0) return [(await emptySavedLens($, els)) ?? EmptyLens(els, where)]
  const markOf = await watchMarks($)
  const cursor = clamp(where.dialogCursor, list.length)
  const shown = windowAround(list, cursor, rows)
  return shown.items.map((dialog, index) =>
    DialogRow(els, {
      dialog,
      isCursor: where.view === 'dialogs' && shown.start + index === cursor,
      isOpen: open?.peer.id === dialog.id,
      width,
      now: at,
      onOpen: () => openThread($, dialog),
      mark: markOf(dialog.id),
    }),
  )
}

async function drawThread($: $, els: Els, width: number, rows: number): Promise<RenderElement[]> {
  const { Text } = els
  const open = await read($, thread)
  if (open === null) return [<Text dimColor>Open a dialog with o or Enter.</Text>]
  const at = await read($, now)
  const waiting = LoadState(els, { load: open.load, now: at, rows, onReload: () => reload($) })
  if (waiting !== null) return [waiting]
  const messages = loaded(open.load) ?? []
  if (messages.length === 0) return [<Text dimColor>No messages in this chat yet.</Text>]
  const where = await read($, nav)
  const chosen = await read($, selection)
  const cursor = clamp(where.messageCursor, messages.length)
  // A card with buttons takes two rows; budget for some of them.
  const shown = windowAround(messages, cursor, Math.max(1, Math.floor(rows / 1.5)))
  return shown.items.map((message, index) =>
    MessageCard(els, {
      message,
      isCursor: where.view === 'thread' && shown.start + index === cursor,
      isSelected: chosen.ids.includes(message.id),
      isAnchor: chosen.anchor === message.id,
      width,
      now: at,
      onPress: async () => {
        await update($, nav, value => ({ ...value, view: 'thread', messageCursor: shown.start + index }))
        await selectAtCursor($, 'toggle')
      },
    }),
  )
}

async function tray($: $, els: Els, size: 'full' | 'line'): Promise<RenderElement> {
  return PacketTray(els, {
    size,
    selection: await read($, selection),
    messages: await threadMessages($),
    onSend: () => sendStub($),
    onWhole: async () => {
      const order = (await threadMessages($)).map(one => one.id)
      await update($, selection, () => selectWhole(order))
    },
    onClear: () => update($, selection, () => NO_SELECTION),
  })
}

function lensProps($: $, where: { lens: Lens; query: string }) {
  return {
    lens: where.lens,
    query: where.query,
    onLens: async (lens: Lens) => {
      await update($, nav, value => ({ ...value, lens, dialogCursor: 0 }))
      await selectSavedLens($, null)
    },
    onSearch: async (query: string) => {
      await update($, nav, value => ({ ...value, view: 'dialogs', query: query.trim(), dialogCursor: 0 }))
      // Hand the keys back to the list, or j/k would keep typing into the field.
      const first = (await shownDialogs($))[0]
      if (first !== undefined) await moveRing($, `dialog:${first.id}`)
    },
  }
}

async function drawWide($: $, els: Els, width: number, rows: number): Promise<RenderElement> {
  const { Box } = els
  const where = await read($, nav)
  const open = await read($, thread)
  // Chrome: header, lens bar, watch row, two dividers, tray (3), hints.
  const room = Math.max(4, rows - 9)
  const listRows = Math.max(3, Math.floor(room * 0.4))
  const summary = await drawSummary($, els, width, false)
  return (
    <Box flexDirection="column">
      {Header(els, { title: 'tg · dialogs', mode: 'wide', onMode: () => cycleMode($) })}
      {LensBar(els, { ...lensProps($, where), ...(await lensExtras($, els)) })}
      {await drawWatchRow($, els)}
      {...await drawDialogList($, els, width, listRows)}
      {Divider(els, { label: open?.peer.label ?? 'no dialog open', width })}
      {summary.element}
      {...await drawThread($, els, width, Math.max(1, room - listRows - summary.rows))}
      {Divider(els, { label: '', width })}
      {await tray($, els, 'full')}
      {HintsRow(els, { hints: hintsFor(where.view, await read($, selection)), onHint: key => onHint($, key) })}
    </Box>
  )
}

async function drawCompact($: $, els: Els, width: number, rows: number): Promise<RenderElement> {
  const { Box } = els
  const where = await read($, nav)
  const open = await read($, thread)
  const isThread = where.view === 'thread' && open !== null
  // Chrome: header, lens bar and watch row or summary and tray line, hints; 8-12 rows in all.
  const room = Math.max(5, Math.min(rows, 12) - 3)
  const summary = isThread ? await drawSummary($, els, width, true) : { element: await drawWatchRow($, els), rows: 1 }
  return (
    <Box flexDirection="column">
      {Header(els, { title: isThread ? `tg · ${open.peer.label}` : 'tg · dialogs', mode: 'compact', onMode: () => cycleMode($) })}
      {isThread ? null : LensBar(els, { ...lensProps($, where), ...(await lensExtras($, els)) })}
      {summary.element}
      {...isThread
        ? await drawThread($, els, width, Math.max(1, room - summary.rows))
        : await drawDialogList($, els, width, Math.max(1, room - summary.rows))}
      {isThread ? await tray($, els, 'line') : null}
      {HintsRow(els, { hints: hintsFor(isThread ? 'thread' : 'dialogs', await read($, selection)), onHint: key => onHint($, key) })}
    </Box>
  )
}

// ── triage ──
// Live updates through `tg watch`, watched dialogs in Hidden mode, saved
// lenses, summaries and needs-you ranking (design §5 ideas 11–14). Every `$`
// function of the triage phase is in this block; its pure rules are in
// ./triage. Keys: w watch, t summary, f lens editor, y needs-you, 4–9 lenses.

const triage = atom({ plugin: 'dialogs-pane', key: 'triage' } as const, EMPTY_TRIAGE)
const STORE_WATCHED = 'triage.watched'
const STORE_LENSES = 'triage.lenses'
const STORE_RANKED = 'triage.ranked'
const RANK_TIMEOUT_MS = 20_000

/**
 * One `tg watch` child and what it has seen. Module state on purpose: the
 * children belong to this copy of the module, and a reload kills them with it
 * (session.start then starts them again).
 */
type Watch = {
  peer: PeerRef
  stream: ReturnType<$['process']['spawn']> | null
  isStopped: boolean
  /** Past `ready` in the current run: what arrives now is live, not replay. */
  isLive: boolean
  /** Runs in a row that ended before `ready`. */
  attempt: number
  /** The newest message id seen, for `--after` on a restart. */
  lastId: number | null
  recent: MessageView[]
  restart: Timer | null
}

const watches = new Map<number, Watch>()
let me: Me | null = null
let scoring: Promise<void> | null = null
let summaryAbort: AbortController | null = null

/** From pane-core's session.start: what $.store kept, then the watches it calls for. */
async function startTriage($: $): Promise<void> {
  const watched = parseWatched(await $.store.get(STORE_WATCHED))
  const lenses = parseLenses(await $.store.get(STORE_LENSES))
  const isRanked = (await $.store.get(STORE_RANKED)) === true
  // After a reload the old children are gone, so their health is too.
  await update($, triage, value => ({
    ...value,
    watched,
    lenses,
    isRanked,
    health: {},
    lens: lenses.some(lens => lens.id === value.lens) ? value.lens : null,
  }))
  await syncWatches($)
}

function registerTriage(on: On): void {
  on('session.end', async ($, e, next) => {
    for (const watch of [...watches.values()]) stopWatch(watch)
    return next(e)
  })
}

function peerOf(dialog: TgDialog): PeerRef {
  return { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
}

// --- live updates: one `tg watch` per watched dialog and for the open thread ---

/**
 * Starts the watches that should run and stops the rest: every dialog marked
 * with `w`, plus the open thread while the pane is up. Called whenever one of
 * those changes.
 */
async function syncWatches($: $): Promise<void> {
  const state = await read($, triage)
  const open = await read($, thread)
  const wanted = new Map(state.watched.map(peer => [peer.id, peer]))
  if ((await read($, mode)) !== 'hidden' && open !== null && !wanted.has(open.peer.id)) wanted.set(open.peer.id, open.peer)
  for (const watch of [...watches.values()]) {
    if (!wanted.has(watch.peer.id)) stopWatch(watch)
  }
  const listed = loaded(await read($, dialogs)) ?? []
  for (const peer of wanted.values()) {
    if (watches.has(peer.id)) continue
    // Replay from what the pane already has, so nothing between that read and `ready` is lost.
    const shown = open?.peer.id === peer.id ? loaded(open.load)?.at(-1)?.id : undefined
    startWatch($, peer, shown ?? listed.find(dialog => dialog.id === peer.id)?.last_id ?? null)
  }
  await update($, triage, value => ({
    ...value,
    health: Object.fromEntries(Object.entries(value.health).filter(([id]) => watches.has(Number(id)))),
  }))
}

function startWatch($: $, peer: PeerRef, after: number | null): void {
  const watch: Watch = { peer, stream: null, isStopped: false, isLive: false, attempt: 0, lastId: after, recent: [], restart: null }
  watches.set(peer.id, watch)
  scheduleWatch($, watch, 0)
}

/** Runs the watch from a timer, so the child outlives the press or hook that asked for it. */
function scheduleWatch($: $, watch: Watch, delayMs: number): void {
  watch.restart = $.clock.after(delayMs, () => {
    watch.restart = null
    runWatch($, watch).catch(() => {
      // runWatch reports its own failures in `health`; one that escapes leaves the mark as it was.
    })
  })
}

/** Kills the child (leaving its loop is what kills it) and forgets the watch. */
function stopWatch(watch: Watch): void {
  watch.isStopped = true
  watch.restart?.cancel()
  watch.stream?.return({ code: null, signal: 'SIGTERM' }).catch(() => {
    // The child is already gone; nothing is left to stop.
  })
  watches.delete(watch.peer.id)
}

async function setHealth($: $, dialogId: number, health: WatchHealth): Promise<void> {
  if (!watches.has(dialogId)) return
  await update($, triage, value => ({ ...value, health: { ...value.health, [String(dialogId)]: health } }))
}

async function runWatch($: $, watch: Watch): Promise<void> {
  if (watch.isStopped) return
  await setHealth($, watch.peer.id, watch.attempt === 0 ? 'connecting' : 'retrying')
  const stream = $.process.spawn({ argv: watchArgv(watch.peer.arg, watch.lastId) })
  watch.stream = stream
  watch.isLive = false
  let pending = ''
  let stderr = ''
  let hasStarted = true
  try {
    for await (const chunk of stream) {
      if (watch.isStopped) break
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-4000)
        continue
      }
      const split = splitLines(pending, chunk.text)
      pending = split.rest
      for (const line of split.lines) {
        const event = parseWatchLine(line)
        if (event !== undefined) await onWatchEvent($, watch, event)
      }
    }
  } catch {
    // The first pull rejects when tg cannot start (not on PATH): `ending` reports it as missing.
    hasStarted = false
  }
  watch.stream = null
  if (watch.isStopped) return
  const result = hasStarted ? await stream.result : undefined
  // A signal from outside ends it like a lost connection: worth a restart.
  const code = result === undefined ? null : (result.code ?? 1)
  if (watch.isLive) watch.attempt = 0
  const next = ending(code, stderr, watch.attempt)
  if (next.kind === 'restart') {
    watch.attempt += 1
    await setHealth($, watch.peer.id, 'retrying')
    scheduleWatch($, watch, next.delayMs)
    return
  }
  await setHealth($, watch.peer.id, 'failed')
  $.ui.toast(`tg watch ${watch.peer.label}: ${failureText(next.failure, await $.clock.now())}`)
}

async function onWatchEvent($: $, watch: Watch, event: WatchEvent): Promise<void> {
  if (event.kind === 'ready') {
    watch.isLive = true
    await setHealth($, watch.peer.id, 'live')
    return
  }
  if (event.kind !== 'delete') {
    watch.lastId = Math.max(watch.lastId ?? 0, event.message.id)
    watch.recent = [...watch.recent, event.message].slice(-RECENT)
  }
  const open = await read($, thread)
  if (open?.peer.id === watch.peer.id && open.load.status === 'ok') {
    const atEnd = (await read($, nav)).messageCursor >= open.load.value.length - 1
    const after = await update($, thread, value =>
      value?.peer.id === watch.peer.id && value.load.status === 'ok'
        ? { ...value, load: { status: 'ok', value: applyToMessages(value.load.value, event, message => message) } }
        : value,
    )
    // A cursor on the newest message follows new ones; one placed higher stays.
    const count = after !== null && after.load.status === 'ok' ? after.load.value.length : 0
    if (atEnd) await update($, nav, value => ({ ...value, messageCursor: Math.max(0, count - 1) }))
  }
  if (event.kind !== 'message') return
  const { message } = event
  await update($, dialogs, value => (value.status === 'ok' ? { status: 'ok', value: applyToDialogs(value.value, watch.peer.id, message) } : value))
  if (!watch.isLive || message.out) {
    await refreshStatus($)
    return
  }
  if (repliesToYou(message, watch.recent)) {
    await update($, triage, value => ({ ...value, repliedToYou: { ...value.repliedToYou, [String(watch.peer.id)]: message.id } }))
  }
  if (!(await read($, triage)).watched.some(peer => peer.id === watch.peer.id)) {
    await refreshStatus($)
    return
  }
  const report = reportReply(watch.peer, message, watch.recent)
  await update($, triage, value => ({ ...value, reply: report.reply }))
  if ((await read($, mode)) === 'hidden') await update($, band, () => report.band)
  await refreshStatus($)
}

async function toggleWatch($: $, peer: PeerRef | undefined): Promise<void> {
  if (peer === undefined) return
  const state = await read($, triage)
  const isWatched = state.watched.some(one => one.id === peer.id)
  if (!isWatched && state.watched.length >= MAX_WATCHED) {
    $.ui.toast(`tg: ${MAX_WATCHED} dialogs are watched already; press w on one to unwatch it first.`)
    return
  }
  const watched = isWatched ? state.watched.filter(one => one.id !== peer.id) : [...state.watched, peer]
  await update($, triage, value => ({ ...value, watched }))
  await $.store.set(STORE_WATCHED, watched)
  // Marking a dialog again is how a failed watch gets a fresh start.
  const running = watches.get(peer.id)
  if (!isWatched && running !== undefined && state.health[String(peer.id)] === 'failed') stopWatch(running)
  await syncWatches($)
}

/** `w`'s dialog: the open thread's in the thread view, else the one at the cursor. */
async function watchTarget($: $): Promise<PeerRef | undefined> {
  const where = await read($, nav)
  const open = await read($, thread)
  if (where.view === 'thread' && open !== null) return open.peer
  const list = await shownDialogs($)
  const dialog = list[clamp(where.dialogCursor, list.length)]
  return dialog === undefined ? undefined : peerOf(dialog)
}

async function drawWatchRow($: $, els: Els): Promise<RenderElement | null> {
  const state = await read($, triage)
  if (state.editor !== null) return null
  const target = await watchTarget($)
  const where = await read($, nav)
  const list = await shownDialogs($)
  return WatchRow(els, {
    cursor: where.view === 'thread' ? (loaded(await read($, dialogs)) ?? []).find(one => one.id === target?.id) : list[clamp(where.dialogCursor, list.length)],
    isWatched: target !== undefined && state.watched.some(one => one.id === target.id),
    health: state.health,
    isSavedLens: state.lens !== null,
    onWatch: async () => toggleWatch($, await watchTarget($)),
    onLensEditor: () => openLensEditor($),
  })
}

/** The latency on Hidden's band, when the band shows the watched reply. */
async function bandLatency($: $, els: Els, event: BandEvent): Promise<RenderElement | null> {
  const reply = (await read($, triage)).reply
  if (reply === null || reply.dialogId !== event.dialogId || reply.latencyMs === null) return null
  const { Text } = els
  return <Text color={reply.latencyMs > 3000 ? TOKEN.warn : undefined} dimColor={reply.latencyMs <= 3000}>{`${GLYPH.latency}${latencyText(reply.latencyMs)}`}</Text>
}

// --- saved lenses ---

async function visibleTriaged($: $, list: readonly TgDialog[], where: Nav): Promise<TgDialog[]> {
  return triageDialogs(list, where, await read($, triage), me ?? NO_ME)
}

async function lensExtras($: $, els: Els): Promise<{ extra: RenderElement; isSavedLens: boolean }> {
  const state = await read($, triage)
  return {
    isSavedLens: state.lens !== null,
    extra: LensTabs(els, {
      lenses: state.lenses,
      active: state.lens,
      isRanked: state.isRanked,
      onLens: id => selectSavedLens($, id),
      onRank: () => toggleRanking($),
    }),
  }
}

async function selectSavedLens($: $, id: string | null): Promise<void> {
  await update($, triage, value => ({ ...value, lens: id }))
  await update($, nav, value => ({ ...value, view: 'dialogs', dialogCursor: 0 }))
}

async function openLensEditor($: $): Promise<void> {
  const state = await read($, triage)
  const saved = state.lenses.find(lens => lens.id === state.lens)
  if (saved === undefined && state.lenses.length >= MAX_LENSES) {
    $.ui.toast(`tg: ${MAX_LENSES} lenses at most; open one (4–9) and press f to edit or delete it.`)
    return
  }
  const id = `lens-${(await $.clock.now()).toString(36)}`
  const draft: LensDraft = saved === undefined ? { lens: draftFrom(await read($, nav), state.lenses, id), isNew: true } : { lens: saved, isNew: false }
  await update($, triage, value => ({ ...value, editor: draft }))
  await update($, nav, value => ({ ...value, view: 'dialogs' }))
}

async function editDraft($: $, change: (lens: SavedLens) => SavedLens): Promise<void> {
  await update($, triage, value => (value.editor === null ? value : { ...value, editor: { ...value.editor, lens: change(value.editor.lens) } }))
}

async function saveLens($: $): Promise<void> {
  const draft = (await read($, triage)).editor
  if (draft === null) return
  const lenses = upsertLens((await read($, triage)).lenses, draft.lens)
  await update($, triage, value => ({ ...value, lenses, editor: null, lens: draft.lens.id }))
  await update($, nav, value => ({ ...value, dialogCursor: 0 }))
  await $.store.set(STORE_LENSES, lenses)
}

async function deleteLens($: $): Promise<void> {
  const draft = (await read($, triage)).editor
  if (draft === null) return
  const lenses = (await read($, triage)).lenses.filter(lens => lens.id !== draft.lens.id)
  await update($, triage, value => ({ ...value, lenses, editor: null, lens: value.lens === draft.lens.id ? null : value.lens }))
  await $.store.set(STORE_LENSES, lenses)
}

/** The editor in place of the dialog list while it is open; null otherwise. */
async function drawLensEditor($: $, els: Els, rows: number): Promise<RenderElement | null> {
  const draft = (await read($, triage)).editor
  if (draft === null) return null
  return LensEditor(els, {
    draft,
    dialogs: loaded(await read($, dialogs)) ?? [],
    rows,
    onName: name => editDraft($, lens => ({ ...lens, name })),
    onQuery: query => editDraft($, lens => ({ ...lens, query: query.trim() })),
    onKind: group => editDraft($, lens => toggleGroup(lens, group)),
    onUnread: () => editDraft($, lens => ({ ...lens, isUnreadOnly: !lens.isUnreadOnly })),
    onPick: dialogId => editDraft($, lens => togglePicked(lens, dialogId)),
    onSave: () => saveLens($),
    onDelete: () => deleteLens($),
    onCancel: () => update($, triage, value => ({ ...value, editor: null })),
  })
}

async function emptySavedLens($: $, els: Els): Promise<RenderElement | null> {
  const state = await read($, triage)
  const saved = state.lenses.find(lens => lens.id === state.lens)
  return saved === undefined ? null : EmptySavedLens(els, { lens: saved })
}

/** The `◎` mark of each watched dialog's row, colored by its watch's health. */
async function watchMarks($: $): Promise<(dialogId: number) => { text: string; color?: string } | undefined> {
  const state = await read($, triage)
  const watched = new Set(state.watched.map(peer => peer.id))
  return dialogId => (watched.has(dialogId) ? watchMark(state.health[String(dialogId)]) : undefined)
}

// --- summary of the open thread ---

async function setSummary($: $, peerId: number, summary: Summary | null): Promise<void> {
  await update($, triage, value => (value.summary === null || value.summary.peerId === peerId ? { ...value, summary } : value))
}

function modelFailure(result: Exclude<ModelCompleteResult, { isAnswered: true }>): string {
  switch (result.reason) {
    case 'api-error':
      return `the model call failed (${result.error})`
    case 'empty-reply':
      return 'the model gave no text'
    case 'aborted':
      return 'the model took too long'
  }
}

/** `t`: summarize the open thread; again while it runs cancels, once shown hides it. */
async function toggleSummary($: $): Promise<void> {
  const open = await read($, thread)
  if (open === null) return
  const peer = open.peer
  const current = (await read($, triage)).summary
  summaryAbort?.abort()
  summaryAbort = null
  if (current?.peerId === peer.id && current.status !== 'error') {
    await update($, triage, value => ({ ...value, summary: null }))
    return
  }
  const abort = new AbortController()
  summaryAbort = abort
  await update($, triage, value => ({ ...value, summary: { peerId: peer.id, status: 'loading' } }))
  const fetched = await runTg($, tg.read(peer.arg, { limit: SUMMARY_LIMIT }))
  if (abort.signal.aborted) return
  if (!fetched.ok) {
    await setSummary($, peer.id, { peerId: peer.id, status: 'error', message: failureText(fetched.failure, await $.clock.now()) })
    return
  }
  const result = await $.model.complete(
    {
      model: TRIAGE_MODEL,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt(peer.label, fetched.value),
      maxTokens: SUMMARY_MAX_TOKENS,
      effort: 'low',
      timeoutMs: SUMMARY_TIMEOUT_MS,
    },
    { signal: abort.signal },
  )
  if (abort.signal.aborted) return
  summaryAbort = null
  await setSummary(
    $,
    peer.id,
    result.isAnswered
      ? { peerId: peer.id, status: 'ok', text: result.text, count: fetched.value.length }
      : { peerId: peer.id, status: 'error', message: modelFailure(result) },
  )
}

/** The summary block above the thread, and the rows it takes. */
async function drawSummary($: $, els: Els, width: number, hasWatchKey: boolean): Promise<{ element: RenderElement | null; rows: number }> {
  const open = await read($, thread)
  if (open === null) return { element: null, rows: 0 }
  const state = await read($, triage)
  const summary = state.summary?.peerId === open.peer.id ? state.summary : null
  return {
    rows: summaryRows(summary),
    element: SummaryBlock(els, {
      summary,
      isWatched: state.watched.some(peer => peer.id === open.peer.id),
      width,
      onSummary: () => toggleSummary($),
      ...(hasWatchKey && { onWatch: () => toggleWatch($, open.peer) }),
    }),
  }
}

// --- needs-you ranking ---

async function toggleRanking($: $): Promise<void> {
  const isRanked = !(await read($, triage)).isRanked
  await update($, triage, value => ({ ...value, isRanked }))
  await update($, nav, value => ({ ...value, dialogCursor: 0 }))
  await $.store.set(STORE_RANKED, isRanked)
  if (isRanked) await scoreUnread($)
}

/** After each `tg dialogs`: drop verdicts for messages no longer on top, and score the new ones. */
async function afterDialogs($: $): Promise<void> {
  const list = loaded(await read($, dialogs)) ?? []
  await update($, triage, value => ({ ...value, verdicts: pruneVerdicts(value.verdicts, list) }))
  if ((await read($, triage)).isRanked) await scoreUnread($)
}

/** One scoring pass at a time; a second caller shares the one in flight. */
function scoreUnread($: $): Promise<void> {
  scoring ??= askModel($).finally(() => {
    scoring = null
  })
  return scoring
}

async function askModel($: $): Promise<void> {
  me ??= await whoAmI($)
  const state = await read($, triage)
  const asked = toAsk(loaded(await read($, dialogs)) ?? [], me, state.verdicts, state.repliedToYou)
  if (asked.length === 0) return
  const result = await $.model.complete({
    model: TRIAGE_MODEL,
    system: RANK_SYSTEM,
    prompt: rankPrompt(asked),
    maxTokens: 200,
    effort: 'low',
    timeoutMs: RANK_TIMEOUT_MS,
  })
  // No answer: the heuristics rank alone, and the next pass asks again.
  if (!result.isAnswered) return
  // A dialog the reply skipped counts as fyi, so it is not asked about again until a new message.
  const verdicts = { ...Object.fromEntries(asked.map(dialog => [verdictKey(dialog), 'fyi' as const])), ...parseVerdicts(result.text, asked) }
  await update($, triage, value => ({ ...value, verdicts: { ...value.verdicts, ...verdicts } }))
}

/** Who "you" is, for mentions; unknown when tg cannot say. */
async function whoAmI($: $): Promise<Me> {
  const result = await runTg($, { argv: ['tg', 'whoami', '--json'], decode: parseMe })
  return result.ok ? result.value : NO_ME
}
