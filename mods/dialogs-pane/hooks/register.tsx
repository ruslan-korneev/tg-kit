// Dialogs Pane, phase 1: Telegram dialogs and threads in a pane, read through
// the `tg` CLI. Wide (dock), Compact (inline) and Hidden (status line + band).
// Design: docs/design/dialogs-pane.md §1, §2, §4.
//
// Every function that takes `$` lives in this file: the engine follows `$`
// only into functions declared beside the hook. ./ui and ./tg stay pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Lens, Load, Mode, PeerRef, TgDialog, TgFailure } from '../types'
import { TG_TIMEOUT_MS, settle, tg, type TgRequest, type TgResult } from './tg/tg'
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
  grownDialog,
  hintsFor,
  isMode,
  loaded,
  nextMode,
  oneLine,
  peerArg,
  rangeSelect,
  selectWhole,
  statusText,
  toggleSelected,
  visibleDialogs,
} from './ui/model'

type $ = EngineInterface

const PANE = 'tg'
const STORE_MODE = 'mode'
const POLL_MS = 60_000
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
  registerBottest(on)
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
}

async function cycleMode($: $): Promise<void> {
  await setMode($, nextMode(await read($, mode)))
}

async function refreshStatus($: $): Promise<void> {
  if ((await read($, mode)) !== 'hidden') {
    $.ui.status(undefined)
    return
  }
  $.ui.status(statusText(await read($, dialogs), await read($, band)))
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
  await bottestThreadOpened($, peer)
  await loadThread($, peer)
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
  return visibleDialogs(loaded(await read($, dialogs)) ?? [], await read($, nav))
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
  const waiting = LoadState(els, { load, now: at, rows, onReload: () => reload($) })
  if (waiting !== null) return [waiting]
  const list = visibleDialogs(loaded(load) ?? [], where)
  if (list.length === 0) return [EmptyLens(els, where)]
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
  const diff = await drawBottestDiff($, els, width, rows)
  if (diff !== null) return [diff]
  const where = await read($, nav)
  const chosen = await read($, selection)
  const cursor = clamp(where.messageCursor, messages.length)
  const bt = await bottestCards($, open.peer, messages, width)
  // A card with buttons takes two rows; budget for some of them.
  const shown = windowAround(messages, cursor, Math.max(1, Math.floor(rows / 1.5)))
  return shown.items.map((message, index) =>
    MessageCard(els, {
      ...bt(els, message),
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
    onLens: (lens: Lens) => update($, nav, value => ({ ...value, lens, dialogCursor: 0 })),
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
  // Chrome: header, lens bar, two dividers, tray (3), hints; bot testing under a thread.
  const room = Math.max(4, rows - 8 - (open === null ? 0 : await bottestRows($, width)))
  const listRows = Math.max(3, Math.floor(room * 0.4))
  return (
    <Box flexDirection="column">
      {Header(els, { title: 'tg · dialogs', mode: 'wide', onMode: () => cycleMode($) })}
      {LensBar(els, lensProps($, where))}
      {...await drawDialogList($, els, width, listRows)}
      {Divider(els, { label: open?.peer.label ?? 'no dialog open', width })}
      {...await drawThread($, els, width, room - listRows)}
      {...await drawBottest($, els)}
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
  // Chrome: header, lens bar or tray line, hints; 8-12 rows in all; bot testing under a thread.
  const room = Math.max(5, Math.min(rows, 12) - 3 - (isThread ? await bottestRows($, width) : 0))
  return (
    <Box flexDirection="column">
      {Header(els, { title: isThread ? `tg · ${open.peer.label}` : 'tg · dialogs', mode: 'compact', onMode: () => cycleMode($) })}
      {isThread ? null : LensBar(els, lensProps($, where))}
      {...isThread ? await drawThread($, els, width, room) : await drawDialogList($, els, width, room)}
      {...isThread ? await drawBottest($, els) : []}
      {isThread ? await tray($, els, 'line') : null}
      {HintsRow(els, { hints: hintsFor(isThread ? 'thread' : 'dialogs', await read($, selection)), onHint: key => onHint($, key) })}
    </Box>
  )
}

// ── bottest ──
// Bot testing in the pane (docs/design/dialogs-pane.md §5 ideas 6–10): pressable
// buttons (b, then Enter), a one-line send box (n), the recorder (r), the reply
// diff (f: a Button hotkey is a letter or digit, so `=` cannot be one) and latency
// stamps. The pure parts are in ./bottest; everything that takes `$` is here.
// The block keeps its own imports (ES imports hoist), so the phase-2 branches
// that edit this file meet as little as possible.
import type { On } from 'claude-code'

import type { BotTest, Notice } from '../types'
import { failureText } from './ui/model'
import { calls, decodeAllow, mergeMessages, PRESS_WAIT_S, SEND_WAIT_S, settleWrite, watchLines, type WatchEvent, type WriteResult } from './bottest/calls'
import { diffPair, replyDiff } from './bottest/diff'
import { chipAction, readOnlyReason, readOnlyText, type ReadOnly } from './bottest/keyboard'
import { NO_TIMING, observe, pressed, stampFor } from './bottest/latency'
import { addStep, outcomeOf, scriptPath, startRecording, targetOf, toScript } from './bottest/recorder'
import { BotBar, ChipRow, DiffView, NoticeRow, SendBox, chipKey } from './bottest/ui'
import type { Button as KeyButton, MessageView } from './packet/types'

const NO_BOTTEST: BotTest = {
  allow: { status: 'idle' },
  busy: null,
  notice: null,
  composing: false,
  recording: null,
  recorded: null,
  diff: null,
  timing: NO_TIMING,
}
const bottest = atom({ plugin: 'dialogs-pane', key: 'bottest' } as const, NO_BOTTEST)

function registerBottest(on: On): void {
  // Leaving the pane (Hidden, or closed by hand) stops the thread's watch.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    await stopWatch($)
    return done
  }).catch(($, e, next) => next(e))
}

async function say($: $, tone: Notice['tone'], text: string): Promise<void> {
  await update($, bottest, value => ({ ...value, notice: { tone, text } }))
}

// --- the thread's watch: live replies and local timing ---

let watchRun: { peerId: number; stop: () => void } | null = null

async function stopWatch($: $): Promise<void> {
  const run = watchRun
  if (run === null) return
  watchRun = null
  run.stop()
  await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'off' } }))
}

/** Runs `tg watch` on a bot thread; its loop is the child's life (see $.process.spawn). */
async function startWatch($: $, peer: PeerRef): Promise<void> {
  await stopWatch($)
  await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'starting' } }))
  const stream = $.process.spawn({ argv: calls.watch(peer.arg) })
  let isStopped = false
  const run = {
    peerId: peer.id,
    stop: () => {
      isStopped = true
      stream.return({ code: null, signal: null }).catch(() => {
        // The child is already gone; nothing is left to stop.
      })
    },
  }
  watchRun = run
  async function pump(): Promise<void> {
    let rest = ''
    try {
      for await (const chunk of stream) {
        if (isStopped) break
        if (chunk.stream !== 'stdout') continue
        const parsed = watchLines(rest, chunk.text)
        rest = parsed.rest
        for (const event of parsed.events) await onWatchEvent($, peer, event)
      }
    } catch {
      // tg is missing or the watch could not start: stamps fall back to message dates.
    } finally {
      if (watchRun === run) {
        watchRun = null
        await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'off' } }))
      }
    }
  }
  pump().catch(() => {
    // pump records its own end in state; a failed state write leaves the last stamps.
  })
}

async function onWatchEvent($: $, peer: PeerRef, event: WatchEvent): Promise<void> {
  const at = await $.clock.now()
  if (event.event === 'ready') {
    await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'live' } }))
    return
  }
  await update($, bottest, value => ({ ...value, timing: observe(value.timing, event.event, event.message, at) }))
  await mergeIntoThread($, peer, [event.message])
}

/** Edited messages replace theirs in place; new ones join the end, and the cursor follows if it was there. */
async function mergeIntoThread($: $, peer: PeerRef, incoming: readonly MessageView[]): Promise<void> {
  if (incoming.length === 0) return
  const before = await threadMessages($)
  const open = await update($, thread, value =>
    value === null || value.peer.id !== peer.id || value.load.status !== 'ok'
      ? value
      : { ...value, load: { status: 'ok', value: mergeMessages(value.load.value, incoming) } },
  )
  const after = open?.load.status === 'ok' ? open.load.value : before
  if (after.length > before.length) {
    await update($, nav, value => (value.messageCursor >= before.length - 1 ? { ...value, messageCursor: after.length - 1 } : value))
  }
}

// --- the allowlist, and whether the open peer may be written to ---

async function loadAllow($: $): Promise<void> {
  await update($, bottest, value => ({ ...value, allow: { status: 'loading' } }))
  const result = await runTg($, { argv: calls.allowList(), decode: decodeAllow })
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, allow: result.ok ? { status: 'ok', value: result.value } : failed(result.failure, at) }))
}

async function readOnlyFor($: $, peer: PeerRef): Promise<ReadOnly | null> {
  let allow = (await read($, bottest)).allow
  if (allow.status === 'idle' || allow.status === 'error') {
    await loadAllow($)
    allow = (await read($, bottest)).allow
  }
  const error = allow.status === 'error' ? failureText(allow.failure, 0) : 'still loading'
  return readOnlyReason(peer, allow.status === 'ok' ? allow.value : null, error)
}

/** openThread's hook: a fresh notice, diff and clocks per thread (stamps stay); a watch on bots. */
async function bottestThreadOpened($: $, peer: PeerRef): Promise<void> {
  await update($, bottest, value => ({
    ...value,
    notice: null,
    composing: false,
    diff: null,
    timing: { ...NO_TIMING, measured: value.timing.measured, pressedAt: value.timing.pressedAt },
  }))
  if ((await read($, bottest)).allow.status !== 'ok') {
    loadAllow($).catch(() => {
      // loadAllow records its own failure; a press reads the allowlist again.
    })
  }
  if (peer.kind === 'bot') await startWatch($, peer)
  else await stopWatch($)
}

// --- writes: press and send, through tg's guard ---

async function runWrite($: $, argv: readonly string[], stdin?: string): Promise<WriteResult> {
  try {
    return settleWrite(await $.process.run(argv, { timeoutMs: TG_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) }))
  } catch {
    // tg did not start or outlived the timeout: settleWrite reports `missing`.
    return settleWrite(undefined)
  }
}

type Pending =
  | { kind: 'send'; text: string; wait_s: number }
  | { kind: 'press'; message: MessageView; button: KeyButton; wait_s: number }

/** Shows what a write brought back in place, notes it, and records it. */
async function finishWrite($: $, peer: PeerRef, pending: Pending, startedAt: number, result: WriteResult): Promise<void> {
  await update($, bottest, value => ({ ...value, busy: null }))
  if (!result.ok) {
    const why = failureText(result.failure, startedAt)
    // tg's guard is the real gate: when it refused over the allowlist, say how to add the peer.
    const allow = result.isRefused && why.includes('allowlist') ? ` ${readOnlyText({ kind: 'not-allowed', arg: peer.arg })}` : ''
    await say($, result.failure.kind === 'flood' ? 'warn' : 'danger', `${GLYPH.error} ${why}${allow}`)
    return
  }
  const brought = [...result.sent, ...result.replies]
  if (pending.kind === 'press') {
    await update($, bottest, value => ({ ...value, timing: pressed(value.timing, startedAt, pending.message.id, result.replies.map(one => one.id)) }))
  }
  await mergeIntoThread($, peer, brought)
  const wait = `${pending.wait_s}s`
  const notice: Notice | null = result.noReply
    ? { tone: 'warn', text: `no reply within ${wait} (tg exit 6); a late reply shows up ${(await read($, bottest)).timing.watch === 'live' ? 'here live' : 'on reload (g)'}.` }
    : result.answer === null
      ? null
      : { tone: 'info', text: result.answer }
  await update($, bottest, value => ({ ...value, notice }))
  await recordStep($, peer, pending, startedAt, result)
}

async function recordStep($: $, peer: PeerRef, pending: Pending, at: number, result: WriteResult & { ok: true }): Promise<void> {
  const state = await read($, bottest)
  const recording = state.recording
  if (recording === null) return
  const history = await threadMessages($)
  const firstReply = result.replies.find(one => !one.out)
  const stamp = firstReply === undefined ? null : stampFor(firstReply, history, state.timing)
  const outcome = outcomeOf(result, stamp === null ? null : stamp.ms)
  const step =
    pending.kind === 'send'
      ? { kind: 'send' as const, peer: peer.arg, text: pending.text, wait_s: pending.wait_s, at, outcome }
      : {
          kind: 'press' as const,
          peer: peer.arg,
          target: targetOf(recording, pending.message.id),
          row: pending.button.row,
          col: pending.button.col,
          label: pending.button.text,
          wait_s: pending.wait_s,
          at,
          outcome,
        }
  await update($, bottest, value => (value.recording === null ? value : { ...value, recording: addStep(value.recording, step) }))
}

/** A chip's press: shown, refused, or `tg press PEER ID --row R --col C --wait 5s --json`. */
async function pressChip($: $, message: MessageView, button: KeyButton): Promise<void> {
  const open = await read($, thread)
  if (open === null) return
  const action = chipAction(button)
  if (action.kind !== 'press') return say($, action.kind === 'show' ? 'info' : 'warn', action.text)
  const blocked = await readOnlyFor($, open.peer)
  if (blocked !== null) return say($, 'warn', readOnlyText(blocked))
  if ((await read($, bottest)).busy !== null) return say($, 'info', 'tg is still running the last step; press again once it is done.')
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, busy: `pressing "${button.text}"`, notice: null, timing: pressed(value.timing, at, message.id, []) }))
  const result = await runWrite($, calls.press(open.peer.arg, message.id, button.row, button.col))
  await finishWrite($, open.peer, { kind: 'press', message, button, wait_s: PRESS_WAIT_S }, at, result)
}

/** The send box's submit: `tg send PEER - --plain --wait 10s --json`, the text on stdin. */
async function sendText($: $, text: string): Promise<void> {
  await update($, bottest, value => ({ ...value, composing: false }))
  const open = await read($, thread)
  if (open === null || text.trim() === '') return
  const blocked = await readOnlyFor($, open.peer)
  if (blocked !== null) return say($, 'warn', readOnlyText(blocked))
  if ((await read($, bottest)).busy !== null) return say($, 'info', 'tg is still running the last step; send again once it is done.')
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, busy: `sending ${oneLine(text, 24)}`, notice: null }))
  const result = await runWrite($, calls.send(open.peer.arg), text)
  await finishWrite($, open.peer, { kind: 'send', text, wait_s: SEND_WAIT_S }, at, result)
  // Hand the keys back to the thread, or j/k would type into nothing.
  const last = (await threadMessages($)).at(-1)
  if (last !== undefined) await moveRing($, `msg:${last.id}`)
}

// --- keys: b, n, r, f ---

/** `b`: the ring onto the first chip of the message at the cursor, or of the newest with buttons. */
async function focusButtons($: $): Promise<void> {
  const messages = await threadMessages($)
  const cursor = clamp((await read($, nav)).messageCursor, messages.length)
  const atCursor = messages[cursor]
  const index =
    atCursor !== undefined && atCursor.buttons.length > 0 ? cursor : messages.findLastIndex(one => one.buttons.length > 0)
  const target = messages[index]
  const first = target?.buttons[0]?.[0]
  if (target === undefined || first === undefined) return say($, 'info', 'No message in this thread has buttons.')
  await update($, nav, value => ({ ...value, view: 'thread', messageCursor: index }))
  await moveRing($, chipKey(target.id, first))
}

/** `n`: opens the send box and puts the ring in it; again closes it. */
async function toggleCompose($: $): Promise<void> {
  const next = await update($, bottest, value => ({ ...value, composing: !value.composing, notice: null }))
  if (!next.composing) return
  // The ring can move only onto a drawn element: give the box one frame to draw.
  await $.clock.sleep(50)
  await moveRing($, 'bt:send')
}

/** `r`: starts a recording; again stops it and writes the script. */
async function toggleRecord($: $): Promise<void> {
  const at = await $.clock.now()
  const state = await read($, bottest)
  if (state.recording === null) {
    await update($, bottest, value => ({ ...value, recording: startRecording(at), notice: { tone: 'info', text: 'Recording: sends and presses from the pane become steps. r stops.' } }))
    return
  }
  const recording = state.recording
  if (recording.steps.length === 0) {
    await update($, bottest, value => ({ ...value, recording: null, notice: { tone: 'info', text: 'Recording stopped: no steps, nothing written.' } }))
    return
  }
  const script = toScript(recording, at)
  let written: string | null = null
  try {
    // Under the session's directory (the bot's repo, as a rule), named in full in the notice.
    const path = `${await $.session.cwd()}/${scriptPath(recording)}`
    // The folder ignores itself, so a recording never lands in the repo's history.
    await $.fs.write(path.replace(/[^/]+$/, '.gitignore'), '*\n')
    await $.fs.write(path, script)
    written = path
  } catch {
    // The steps stay in state either way; the notice says the file is missing.
  }
  await update($, bottest, value => ({
    ...value,
    recording: null,
    recorded: { ...recording, stoppedAt: at, script, path: written },
    notice:
      written === null
        ? { tone: 'danger', text: `${GLYPH.error} could not write ${scriptPath(recording)}; the steps are kept in the pane's state.` }
        : { tone: 'info', text: `${GLYPH.done} ${recording.steps.length} steps → ${scriptPath(recording)} (in the session's directory)` },
  }))
}

/** `f`: diff the two selected bot replies; again closes the diff. */
async function toggleDiff($: $): Promise<void> {
  if ((await read($, bottest)).diff !== null) {
    await update($, bottest, value => ({ ...value, diff: null }))
    return
  }
  const picked = diffPair((await read($, selection)).ids, await threadMessages($))
  if (!picked.ok) return say($, 'info', `Diff: ${picked.reason}.`)
  await update($, bottest, value => ({ ...value, diff: picked.pair, notice: null }))
}

// --- drawing ---

/** MessageCard's bot-testing props: the latency stamp and pressable chips. */
async function bottestCards($: $, peer: PeerRef, messages: readonly MessageView[], width: number) {
  const state = await read($, bottest)
  const allow = state.allow.status === 'ok' ? state.allow.value : null
  // Dim until the allowlist says otherwise: a chip that looks pressable must be.
  const isReadOnly = readOnlyReason(peer, allow) !== null
  return (els: Els, message: MessageView) => {
    const stamp = stampFor(message, messages, state.timing)
    return {
      stamp: stamp === null ? null : { text: stamp.text, isSlow: stamp.isSlow },
      buttonRow:
        message.buttons.length === 0
          ? null
          : ChipRow(els, { message, isReadOnly, width, onChip: button => pressChip($, message, button) }),
    }
  }
}

/** The diff in place of the thread, while one is open and both messages are still loaded. */
async function drawBottestDiff($: $, els: Els, width: number, rows: number): Promise<RenderElement | null> {
  const pair = (await read($, bottest)).diff
  if (pair === null) return null
  const messages = await threadMessages($)
  const before = messages.find(one => one.id === pair[0])
  const after = messages.find(one => one.id === pair[1])
  if (before === undefined || after === undefined) return null
  return DiffView(els, { diff: replyDiff(before, after), width, rows })
}

/** Rows the bot-testing lines take under an open thread: the bar, a wrapped notice, the send box. */
async function bottestRows($: $, width: number): Promise<number> {
  const state = await read($, bottest)
  const notice = state.notice === null ? 0 : Math.ceil(state.notice.text.length / Math.max(10, width))
  return 1 + notice + (state.composing ? 1 : 0)
}

async function drawBottest($: $, els: Els): Promise<RenderElement[]> {
  const open = await read($, thread)
  if (open === null) return []
  const state = await read($, bottest)
  const box = state.composing ? SendBox(els, { peer: open.peer.label, onSend: text => sendText($, text) }) : null
  return [
    BotBar(els, {
      recording: state.recording,
      busy: state.busy,
      watch: state.timing.watch,
      onButtons: () => focusButtons($),
      onCompose: () => toggleCompose($),
      onRecord: () => toggleRecord($),
      onDiff: () => toggleDiff($),
    }),
    ...(state.notice === null ? [] : [NoticeRow(els, { notice: state.notice })]),
    ...(box === null ? [] : [box]),
  ]
}
