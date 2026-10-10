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
  // Chrome: header, lens bar, two dividers, tray (3), hints.
  const room = Math.max(4, rows - 8)
  const listRows = Math.max(3, Math.floor(room * 0.4))
  return (
    <Box flexDirection="column">
      {Header(els, { title: 'tg · dialogs', mode: 'wide', onMode: () => cycleMode($) })}
      {LensBar(els, lensProps($, where))}
      {...await drawDialogList($, els, width, listRows)}
      {Divider(els, { label: open?.peer.label ?? 'no dialog open', width })}
      {...await drawThread($, els, width, room - listRows)}
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
  // Chrome: header, lens bar or tray line, hints; 8-12 rows in all.
  const room = Math.max(5, Math.min(rows, 12) - 3)
  return (
    <Box flexDirection="column">
      {Header(els, { title: isThread ? `tg · ${open.peer.label}` : 'tg · dialogs', mode: 'compact', onMode: () => cycleMode($) })}
      {isThread ? null : LensBar(els, lensProps($, where))}
      {...isThread ? await drawThread($, els, width, room) : await drawDialogList($, els, width, room)}
      {isThread ? await tray($, els, 'line') : null}
      {HintsRow(els, { hints: hintsFor(isThread ? 'thread' : 'dialogs', await read($, selection)), onHint: key => onHint($, key) })}
    </Box>
  )
}
