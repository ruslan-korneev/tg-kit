// Dialogs Pane, phase 1: Telegram dialogs and threads in a pane, read through
// the `tg` CLI. Wide (dock), Compact (inline) and Hidden (status line + band).
// Design: docs/design/dialogs-pane.md §1, §2, §4.
//
// Every function that takes `$` lives in this file: the engine follows `$`
// only into functions declared beside the hook. ./ui and ./tg stay pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Lens, Load, Mode, PeerRef, TgDialog, TgFailure } from '../types'
// ── routing ──
import type { AgentInfo, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { BroadcastRow, LedgerEntry, Leg, Pin, PinWatch, Recipient, RadarEntry, ReplyDraft, TgMessage } from '../types'
import { buildPacket, type Packet } from './packet/build'
import { expandReplyChain } from './packet/expand'
import { BroadcastPicker, Ledger, RoutePicker, RoutedTray } from './routing/components'
import {
  addEntry,
  addNewLeg,
  broadcastRows,
  dialogOfPeer,
  draftArgv,
  draftOf,
  feedPin,
  ledgerStatus,
  legsOf,
  nextIntent,
  noticeText,
  nudgeText,
  onMainTurnStart,
  onRadar,
  onTurnComplete,
  parentsAtHand,
  parsePlan,
  parseSent,
  parseWatchLine,
  peerOf,
  pinnedContext,
  previewPacket,
  radarOf,
  routeOfRows,
  selectedMessages,
  spawnDescription,
  splitLines,
  toIntent,
  watchArgv,
} from './routing/route'
// ── /routing ──
import { TG_TIMEOUT_MS, failureOf, settle, tg, type TgRequest, type TgResult } from './tg/tg'
import {
  DialogRow,
  Divider,
  EmptyLens,
  Header,
  HintsRow,
  LensBar,
  LoadState,
  MessageCard,
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
    const started = await next(e)
    await startRouting($) // ── routing ──
    return started
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
    const over = await drawOverlay($, els, width, rows)
    if (over !== null) return over
    return (await read($, mode)) === 'wide'
      ? await drawWide($, els, width, rows)
      : await drawCompact($, els, width, rows)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const event = await read($, band)
    if (e.props.hasSurvey || event === null || (await read($, mode)) !== 'hidden') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isBot = event.kind === 'bot'
    const room = Math.max(10, e.props.bodyColumns - event.label.length - 40)
    return (
      <Box flexDirection="row" gap={2}>
        <Text wrap="truncate-end">
          <Text color={isBot ? TOKEN.bot : TOKEN.accent}>{isBot ? GLYPH.bot : GLYPH.unread} </Text>
          {`${event.label}: "${oneLine(event.text, room)}"`}
        </Text>
        <Button key="band:main" plain autoFocus onPress={() => bandToMain($)}>
          ⏎ send to main
        </Button>
        <Button key="band:open" plain hotkey="o" onPress={() => openFromBand($)}>
          open
        </Button>
        <Button key="band:dismiss" plain hotkey="x" dimColor onPress={() => dismissBand($)}>
          dismiss
        </Button>
      </Box>
    )
  })

  // ── routing ──
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await update($, isMainBusy, () => true)
    await update($, ledger, onMainTurnStart)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await update($, isMainBusy, () => false)
    const at = await $.clock.now()
    let closed: LedgerEntry[] = []
    await update($, ledger, value => {
      const settled = onTurnComplete(value, e.agentId, at)
      closed = settled.closed
      return settled.ledger
    })
    // Only a real answer becomes a draft: an error or an interrupt says nothing to send.
    const answer = e.reason === 'answer' ? e.answer : ''
    const drafted = closed.map(entry => draftOf(entry, answer)).findLast(one => one !== null)
    if (drafted !== undefined && drafted !== null) await update($, draft, () => drafted)
    return done
  })

  // The dialogs pinned to main reach it every turn as one context block.
  on('prompt.context', async ($, e, next) => {
    const done = await next(e)
    const peers = loaded(await read($, dialogs)) ?? []
    const text = pinnedContext(await read($, pins), peers, await read($, isRedacted))
    return text === null ? done : { ...done, blocks: [...done.blocks, { name: 'tgPinned', text }] }
  })
  // ── /routing ──
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
  $.ui.status(statusText(await read($, dialogs), await read($, band)) + ledgerStatus(await read($, ledger)))
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
  const pinned = new Set((await read($, pins)).map(pin => pin.peer.id))
  return shown.items.map((dialog, index) =>
    DialogRow(els, {
      dialog,
      isCursor: where.view === 'dialogs' && shown.start + index === cursor,
      isOpen: open?.peer.id === dialog.id,
      isPinned: pinned.has(dialog.id),
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
  return routedTray($, els, size, {
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

// ── routing ──
// Phase 2: the tray's send, the route picker and its agent radar, broadcast,
// the packet ledger, live pins and drafted replies. Pure rules and drawing are
// in ./routing; every `$` call is here.
//
// The ledger lives in $.state, not $.store: its states (… / ✓) and its agents
// belong to this session, and a restarted session has none of those agents.

const RADAR_MS = 5_000
/** An agent pin's new messages go out together once this long passes quietly. */
const PIN_FLUSH_MS = 1_500

const route = atom({ plugin: 'dialogs-pane', key: 'route' } as const, { kind: 'one', to: { kind: 'main' } })
const intent = atom({ plugin: 'dialogs-pane', key: 'intent' } as const, 'fix')
const isRedacted = atom({ plugin: 'dialogs-pane', key: 'isRedacted' } as const, true)
const isMaskShown = atom({ plugin: 'dialogs-pane', key: 'isMaskShown' } as const, false)
const overlay = atom({ plugin: 'dialogs-pane', key: 'overlay' } as const, { kind: 'none' })
const radar = atom({ plugin: 'dialogs-pane', key: 'radar' } as const, [])
const isMainBusy = atom({ plugin: 'dialogs-pane', key: 'isMainBusy' } as const, false)
const ledger = atom({ plugin: 'dialogs-pane', key: 'ledger' } as const, [])
const pins = atom({ plugin: 'dialogs-pane', key: 'pins' } as const, [])
const draft = atom({ plugin: 'dialogs-pane', key: 'draft' } as const, null)

/**
 * At session start (and after a reload): pins outlive a reload in $.state,
 * their `tg watch` children do not, so each is started again from its lastId.
 */
async function startRouting($: $): Promise<void> {
  const kept = await update($, pins, value => value.map(pin => ({ ...pin, watch: { status: 'starting' } })))
  for (const pin of kept) startPinWatch($, pin)
  $.clock.every(RADAR_MS, () => {
    routingTick($).catch(() => {
      // A missed tick leaves the radar and ages one tick old; the next one catches up.
    })
  })
}

// --- the radar ---

async function refreshRadar($: $): Promise<void> {
  let list: AgentInfo[]
  try {
    list = await $.agent.list()
  } catch {
    // No list (the session is not bound yet): the picker keeps the last radar.
    return
  }
  const entries = radarOf(list)
  const at = await $.clock.now()
  await update($, radar, () => entries)
  await update($, ledger, value => onRadar(value, entries, at))
}

/** Keeps the radar fresh while the picker is up or a packet is with an agent, and the ages moving. */
async function routingTick($: $): Promise<void> {
  const shown = (await read($, overlay)).kind
  const isWaiting = (await read($, ledger)).some(
    entry => entry.to.kind === 'agent' && (entry.state.kind === 'sent' || entry.state.kind === 'working'),
  )
  if (shown === 'none' && !isWaiting) return
  await refreshRadar($)
  if (shown === 'ledger') {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
  await refreshStatus($)
}

// --- the overlay: route picker, broadcast, ledger ---

async function closeOverlay($: $, ring?: string): Promise<void> {
  await update($, overlay, () => ({ kind: 'none' }))
  if (ring !== undefined) await moveRing($, ring)
}

async function openPicker($: $): Promise<void> {
  await update($, overlay, () => ({ kind: 'picker' }))
  await refreshRadar($)
  await moveRing($, 'route:main')
}

/** A target is picked: the tray shows it and the ring waits on send, so Enter sends. */
async function chooseRoute($: $, to: Recipient): Promise<void> {
  await update($, route, () => ({ kind: 'one', to }))
  await closeOverlay($, 'send')
}

async function openBroadcast($: $): Promise<void> {
  const rows = broadcastRows(await read($, radar), await read($, intent))
  await update($, overlay, () => ({ kind: 'broadcast', rows }))
  await moveRing($, 'leg:0:on')
}

async function editLegs($: $, edit: (rows: BroadcastRow[]) => BroadcastRow[]): Promise<void> {
  await update($, overlay, value => (value.kind === 'broadcast' ? { kind: 'broadcast', rows: edit(value.rows) } : value))
}

async function finishBroadcast($: $): Promise<void> {
  const shown = await read($, overlay)
  if (shown.kind !== 'broadcast') return
  const chosen = routeOfRows(shown.rows)
  if (chosen === null) {
    $.ui.toast('tg: turn on at least one leg (its digit) first.')
    return
  }
  await update($, route, () => chosen)
  await closeOverlay($, 'send')
}

async function openLedger($: $): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, overlay, () => ({ kind: 'ledger', cursor: 0 }))
  await refreshRadar($)
  const newest = (await read($, ledger)).at(-1)
  if (newest !== undefined) await moveRing($, `ledger:${newest.seq}`)
}

/** Enter on a ledger row: open its dialog with the cursor on the message. */
async function jumpTo($: $, entry: LedgerEntry): Promise<void> {
  await closeOverlay($)
  const list = loaded(await read($, dialogs)) ?? []
  await openThread($, list.find(one => one.id === entry.peer.id) ?? dialogOfPeer(entry.peer))
  const target = entry.messageIds.at(-1)
  const index = (await threadMessages($)).findIndex(message => message.id === target)
  if (target === undefined || index < 0) {
    $.ui.toast(`tg: #${target ?? '?'} is older than the ${THREAD_LIMIT} messages loaded.`)
    return
  }
  await update($, nav, value => ({ ...value, view: 'thread', messageCursor: index }))
  await moveRing($, `msg:${target}`)
}

async function drawOverlay($: $, els: Els, width: number, rows: number): Promise<RenderElement | null> {
  const shown = await read($, overlay)
  const count = (await read($, selection)).ids.length
  switch (shown.kind) {
    case 'none':
      return null
    case 'picker':
      return RoutePicker(els, {
        count,
        radar: await read($, radar),
        isMainBusy: await read($, isMainBusy),
        intent: await read($, intent),
        width,
        onMain: () => chooseRoute($, { kind: 'main' }),
        onAgent: (agent: RadarEntry) => chooseRoute($, { kind: 'agent', agentId: agent.agentId, label: agent.label }),
        onNew: () => chooseRoute($, { kind: 'new' }),
        onBroadcast: () => openBroadcast($),
        onIntent: () => update($, intent, nextIntent),
        onClose: () => closeOverlay($, 'send'),
      })
    case 'broadcast':
      return BroadcastPicker(els, {
        count,
        rows: shown.rows,
        width,
        onToggle: index => editLegs($, legs => legs.map((leg, at) => (at === index ? { ...leg, isOn: !leg.isOn } : leg))),
        onIntent: index =>
          editLegs($, legs => legs.map((leg, at) => (at === index ? { ...leg, intent: nextIntent(leg.intent) } : leg))),
        onAdd: () => editLegs($, addNewLeg),
        onDone: () => finishBroadcast($),
        onBack: () => openPicker($),
      })
    case 'ledger':
      return Ledger(els, {
        ledger: await read($, ledger),
        now: await read($, now),
        rows,
        width,
        onJump: entry => jumpTo($, entry),
        onClose: () => closeOverlay($, 'send'),
      })
  }
}

// --- the tray ---

async function routedTray(
  $: $,
  els: Els,
  size: 'full' | 'line',
  handlers: { onWhole: () => Promise<void>; onClear: () => Promise<unknown> },
): Promise<RenderElement> {
  const open = await read($, thread)
  const messages = await threadMessages($)
  const chosen = await read($, selection)
  const selected = selectedMessages(messages, chosen.ids)
  const { known, toFetch } = parentsAtHand(selected, messages)
  const redact = await read($, isRedacted)
  const shownIntent = await read($, intent)
  const redactions =
    open === null || selected.length === 0 || !redact
      ? []
      : previewPacket({
          selected,
          context: known,
          peer: peerOf(open.peer, loaded(await read($, dialogs)) ?? []),
          intent: shownIntent,
          isRedacted: true,
        }).redactions
  const pin = open === null ? null : ((await read($, pins)).find(one => one.peer.id === open.peer.id) ?? null)
  return RoutedTray(els, {
    size,
    selection: chosen,
    preview: { selected, parents: known.length, toFetch: toFetch.length, redactions },
    route: await read($, route),
    intent: shownIntent,
    isRedacted: redact,
    isMaskShown: await read($, isMaskShown),
    pin,
    draft: await read($, draft),
    width: 200,
    onSend: () => sendSelection($),
    onWhole: handlers.onWhole,
    onClear: handlers.onClear,
    onRoute: () => openPicker($),
    onIntent: async () => {
      await update($, intent, nextIntent)
      await moveRing($, 'send')
    },
    onRedact: async () => {
      await update($, isRedacted, value => !value)
    },
    onMask: async () => {
      await update($, isMaskShown, value => !value)
    },
    onPin: () => togglePin($),
    onLedger: () => openLedger($),
    onDraft: {
      onCheck: () => checkDraft($),
      onSend: () => sendDraft($),
      onDrop: () => update($, draft, () => null),
      onEdit: text => update($, draft, value => (value === null ? null : { ...value, text, step: { kind: 'draft' } })),
    },
  })
}

// --- sending a packet ---

type Base = Pick<LedgerEntry, 'peer' | 'messageIds' | 'intent' | 'parents' | 'missing' | 'masked'>

async function addToLedger($: $, entry: Omit<LedgerEntry, 'seq'>): Promise<number> {
  const next = await update($, ledger, value => addEntry(value, entry))
  await refreshStatus($)
  return next.at(-1)?.seq ?? 0
}

async function markEntry($: $, seq: number, state: LedgerEntry['state']): Promise<void> {
  await update($, ledger, value => value.map(entry => (entry.seq === seq ? { ...entry, state } : entry)))
  await refreshStatus($)
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Main gets the packet as a $.session.append user row (the human's decision).
 * The engine stores that row isMeta and does not draw it, and draws no plugin
 * `system` row either (checked live), so the person's visible trace is a
 * $.ui.log line naming the packet. An idle main is woken by a short prompt
 * naming the packet; a busy one reads the row at its next step.
 */
async function deliverMain($: $, base: Base, packet: Packet): Promise<void> {
  const isBusy = await read($, isMainBusy)
  const at = await $.clock.now()
  const seq = await addToLedger($, { ...base, at, to: { kind: 'main' }, state: { kind: isBusy ? 'working' : 'sent' } })
  let appended: Awaited<ReturnType<typeof $.session.append>>
  try {
    appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: packet.text }] } })
  } catch (error) {
    await markEntry($, seq, { kind: 'failed', reason: reasonOf(error) })
    return
  }
  if (appended.deny !== undefined) {
    await markEntry($, seq, { kind: 'failed', reason: appended.deny })
    return
  }
  $.ui.log(noticeText(base))
  if (!isBusy) await $.prompt.submit({ text: nudgeText(base) })
}

async function deliverAgent($: $, base: Base, packet: Packet, agent: { agentId: string; label: string }): Promise<void> {
  const at = await $.clock.now()
  const to = { kind: 'agent', isNew: false, ...agent } as const
  let sent: Awaited<ReturnType<typeof $.session.send>>
  try {
    sent = await $.session.send({ to: { agentId: agent.agentId }, text: packet.text })
  } catch (error) {
    await addToLedger($, { ...base, at, to, state: { kind: 'failed', reason: reasonOf(error) } })
    return
  }
  await addToLedger($, { ...base, at, to, state: sent.isDelivered ? { kind: 'sent' } : { kind: 'failed', reason: sent.reason } })
}

/** "+ new agent": the packet and its intent line are the brief. */
async function deliverNew($: $, base: Base, packet: Packet): Promise<void> {
  const at = await $.clock.now()
  const description = spawnDescription(base.intent, base.messageIds)
  const failed = (reason: string) =>
    addToLedger($, { ...base, at, to: { kind: 'agent', isNew: true, agentId: '', label: description }, state: { kind: 'failed', reason } })
  let spawned: Awaited<ReturnType<typeof $.agent.spawn>>
  try {
    spawned = await $.agent.spawn({ prompt: packet.text, description })
  } catch (error) {
    await failed(reasonOf(error))
    return
  }
  if (spawned.deny !== undefined) {
    await failed(spawned.deny)
    return
  }
  // Started with no local loop (a remote agent): delivered, but nothing here can follow it.
  const agentId = spawned.agentId ?? ''
  await addToLedger($, {
    ...base,
    at,
    to: { kind: 'agent', isNew: true, agentId, label: description },
    state: { kind: agentId === '' ? 'sent' : 'working' },
  })
  await refreshRadar($)
}

/**
 * Expands the reply chain once (tg msg for parents the thread lacks), then
 * builds one packet per leg and delivers each. Answers how many legs failed.
 */
async function sendPacket(
  $: $,
  input: { peer: PeerRef; selected: TgMessage[]; known: readonly TgMessage[]; legs: readonly Leg[] },
): Promise<{ failed: number; fetchFailure: TgFailure | null }> {
  let fetchFailure: TgFailure | null = null
  const expanded = await expandReplyChain(
    input.selected,
    async ids => {
      const result = await runTg($, tg.msg(input.peer.arg, ids))
      if (result.ok) return result.value
      // The parents count as missing in the packet; the toast says why.
      fetchFailure = result.failure
      return []
    },
    { known: input.known },
  )
  const peer = peerOf(input.peer, loaded(await read($, dialogs)) ?? [])
  const redact = await read($, isRedacted)
  const before = (await read($, ledger)).length
  await Promise.all(
    input.legs.map(async leg => {
      const packet = buildPacket({
        messages: expanded.messages,
        context: expanded.context,
        peer,
        intent: toIntent(leg.intent),
        redact,
      })
      const base: Base = {
        peer: input.peer,
        messageIds: expanded.messages.map(message => message.id),
        intent: leg.intent,
        parents: expanded.context.length,
        missing: expanded.missing,
        masked: packet.redactions.length,
      }
      switch (leg.to.kind) {
        case 'main':
          return deliverMain($, base, packet)
        case 'agent':
          return deliverAgent($, base, packet, leg.to)
        case 'new':
          return deliverNew($, base, packet)
      }
    }),
  )
  const added = (await read($, ledger)).slice(before)
  return { failed: added.filter(entry => entry.state.kind === 'failed').length, fetchFailure }
}

/** The tray's send: the selection, along the route, under the intent. */
async function sendSelection($: $): Promise<void> {
  const open = await read($, thread)
  const messages = await threadMessages($)
  const selected = selectedMessages(messages, (await read($, selection)).ids)
  if (open === null || selected.length === 0) {
    $.ui.toast('tg: select messages first (x, v, or d for the whole thread).')
    return
  }
  const legs = legsOf(await read($, route), await read($, intent))
  const sent = await sendPacket($, { peer: open.peer, selected, known: messages, legs })
  const why = sent.fetchFailure === null ? '' : ` Reply-chain parents missing: ${sent.fetchFailure.kind}.`
  if (sent.failed === 0) {
    await update($, selection, () => NO_SELECTION)
    $.ui.toast(`tg: packet sent to ${legs.length === 1 ? 'one target' : `${legs.length} targets`}; l shows the ledger.${why}`)
  } else {
    $.ui.toast(`tg: ${sent.failed} of ${legs.length} deliveries failed; l shows why. The selection is kept.${why}`)
  }
}

/** The Hidden band's ⏎: the dialog's newest message to main, under the tray's intent. */
async function bandToMain($: $): Promise<void> {
  const event = await read($, band)
  const dialog = (loaded(await read($, dialogs)) ?? []).find(one => one.id === event?.dialogId)
  if (event === null || dialog === undefined || dialog.last_id === null) {
    $.ui.toast('tg: that message is no longer in the dialog list; open it with o.')
    return
  }
  const peer: PeerRef = { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
  const found = await runTg($, tg.msg(peer.arg, [dialog.last_id]))
  if (!found.ok || found.value.length === 0) {
    $.ui.toast(`tg: could not fetch #${dialog.last_id} (${found.ok ? 'not found' : found.failure.kind}).`)
    return
  }
  const sent = await sendPacket($, {
    peer,
    selected: found.value,
    known: [],
    legs: [{ to: { kind: 'main' }, intent: await read($, intent) }],
  })
  if (sent.failed === 0) await update($, band, () => null)
  await refreshStatus($)
}

// --- live pins: tg watch → $.state → prompt.context (main) or session.send (an agent) ---

const watchers = new Map<number, HookStream<ProcessSpawnChunk, ProcessSpawnResult>>()
let pinFlush: Timer | null = null

async function setWatch($: $, peerId: number, watch: PinWatch): Promise<void> {
  await update($, pins, value => value.map(pin => (pin.peer.id === peerId ? { ...pin, watch } : pin)))
}

/** `p`: pin the open dialog to the route's agent (main unless one agent is picked); again unpins. */
async function togglePin($: $): Promise<void> {
  const open = await read($, thread)
  if (open === null) {
    $.ui.toast('tg: open a dialog to pin it.')
    return
  }
  if ((await read($, pins)).some(pin => pin.peer.id === open.peer.id)) {
    await unpin($, open.peer.id)
    $.ui.toast(`tg: ${open.peer.label} unpinned.`)
    return
  }
  const chosen = await read($, route)
  const to: Pin['to'] =
    chosen.kind === 'one' && chosen.to.kind === 'agent'
      ? { kind: 'agent', agentId: chosen.to.agentId, label: chosen.to.label }
      : { kind: 'main' }
  const newest = (await threadMessages($)).reduce((top, message) => Math.max(top, message.id), 0)
  const pin: Pin = {
    peer: open.peer,
    to,
    lastId: newest === 0 ? null : newest,
    messages: [],
    unsent: [],
    watch: { status: 'starting' },
  }
  await update($, pins, value => [...value, pin])
  startPinWatch($, pin)
  const where = to.kind === 'main' ? 'main, every turn' : to.label
  const note = chosen.kind === 'one' && chosen.to.kind !== 'new' ? '' : ' (pins go to main or one named agent)'
  $.ui.toast(`tg: ${GLYPH.pinned} ${open.peer.label} pinned → ${where}${note}. p again unpins.`)
}

async function unpin($: $, peerId: number): Promise<void> {
  const stream = watchers.get(peerId)
  watchers.delete(peerId)
  await update($, pins, value => value.filter(pin => pin.peer.id !== peerId))
  $.ui.invalidate('prompt.context')
  // Leaving the stream kills the child; the value is only the generator's own return.
  if (stream !== undefined) await stream.return({ code: null, signal: 'SIGTERM' })
}

/** Starts the pin's `tg watch`; the loop runs on after the caller returns, until unpin or the child ends. */
function startPinWatch($: $, pin: Pin): void {
  const stream = $.process.spawn({ argv: watchArgv(pin) })
  watchers.set(pin.peer.id, stream)
  pump($, pin.peer.id, stream).catch(async (error: unknown) => {
    if (watchers.get(pin.peer.id) !== stream) return
    watchers.delete(pin.peer.id)
    await setWatch($, pin.peer.id, { status: 'failed', reason: reasonOf(error) })
  })
}

async function pump($: $, peerId: number, stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>): Promise<void> {
  let rest = ''
  let stderr = ''
  for await (const chunk of stream) {
    if (chunk.stream === 'stderr') {
      stderr = (stderr + chunk.text).slice(-2000)
      continue
    }
    const split = splitLines(rest, chunk.text)
    rest = split.rest
    // In order: an edit must land after the message it edits.
    for (const line of split.lines) await onWatchLine($, peerId, line)
  }
  const ended = await stream.result
  // Unpinned (the loop was told to stop) or restarted: nothing to report.
  if (watchers.get(peerId) !== stream) return
  watchers.delete(peerId)
  await setWatch($, peerId, { status: 'failed', reason: watchEnded(ended, stderr) })
}

/** Why a watch stopped, in the tray's words: tg's own error line when it gave one. */
function watchEnded(ended: ProcessSpawnResult, stderr: string): string {
  if (ended.code === 0) return 'tg watch ended; p twice restarts it'
  if (ended.code === null) return `tg watch was stopped (${ended.signal ?? 'signal'})`
  const failure = failureOf(ended.code, stderr)
  switch (failure.kind) {
    case 'auth':
      return 'not logged in: ! tg login'
    case 'flood':
      return `Telegram asks to wait ${failure.seconds} s`
    case 'missing':
      return 'tg is not on PATH'
    case 'not-found':
    case 'error':
      return `tg watch: ${failure.message}`
  }
}

async function onWatchLine($: $, peerId: number, line: string): Promise<void> {
  const event = parseWatchLine(line)
  if (event === null) return
  if (event.kind === 'ready') {
    await setWatch($, peerId, { status: 'live' })
    return
  }
  const fed = await update($, pins, value => value.map(pin => (pin.peer.id === peerId ? feedPin(pin, event.message) : pin)))
  const pin = fed.find(one => one.peer.id === peerId)
  if (pin?.to.kind === 'main') $.ui.invalidate('prompt.context')
  else if (pin?.to.kind === 'agent' && pinFlush === null) {
    pinFlush = $.clock.after(PIN_FLUSH_MS, () => {
      pinFlush = null
      flushAgentPins($).catch(() => {
        // Undelivered ids stay in `unsent`; the next message retries them.
      })
    })
  }
}

/** Agent pins: the messages not delivered yet go out as one packet per dialog. */
async function flushAgentPins($: $): Promise<void> {
  const redact = await read($, isRedacted)
  const peers = loaded(await read($, dialogs)) ?? []
  const waiting = (await read($, pins)).filter(pin => pin.to.kind === 'agent' && pin.unsent.length > 0)
  await Promise.all(
    waiting.map(async pin => {
      if (pin.to.kind !== 'agent') return
      const fresh = pin.messages.filter(message => pin.unsent.includes(message.id))
      const packet = buildPacket({
        messages: fresh,
        peer: peerOf(pin.peer, peers),
        intent: { id: 'raw', text: 'New messages in a Telegram dialog pinned to you (live, from the dialogs pane).' },
        redact,
        replay: false,
      })
      const sent = await $.session.send({ to: { agentId: pin.to.agentId }, text: packet.text })
      if (sent.isDelivered) {
        await update($, pins, value =>
          value.map(one => (one.peer.id === pin.peer.id ? { ...one, unsent: one.unsent.filter(id => !pin.unsent.includes(id)) } : one)),
        )
      } else {
        await setWatch($, pin.peer.id, { status: 'failed', reason: `${pin.to.label}: ${sent.reason}` })
      }
    }),
  )
}

// --- drafted replies: dry run first, then the same tg send ---

async function setDraftStep($: $, step: ReplyDraft['step']): Promise<void> {
  await update($, draft, value => (value === null ? null : { ...value, step }))
}

async function runDraft($: $, current: ReplyDraft, isDryRun: boolean) {
  try {
    return await $.process.run(draftArgv(current, isDryRun), { stdin: current.text, timeoutMs: TG_TIMEOUT_MS })
  } catch (error) {
    await setDraftStep($, { kind: 'failed', reason: `tg did not run: ${reasonOf(error)}` })
    return null
  }
}

/** check: `tg send … --dry-run` prints the WritePlan and the guard's verdict; nothing is sent. */
async function checkDraft($: $): Promise<void> {
  const current = await read($, draft)
  if (current === null) return
  await setDraftStep($, { kind: 'checking' })
  const ran = await runDraft($, current, true)
  if (ran === null) return
  const plan = ran.exitCode === 0 ? parsePlan(ran.stdout) : null
  if (plan === null) {
    const failure = failureOf(ran.exitCode, ran.stderr)
    await setDraftStep($, { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failure.kind })
    return
  }
  await setDraftStep($, { kind: 'planned', ...plan })
}

/** send reply: only after a check the guard allowed, and the same argv minus --dry-run. */
async function sendDraft($: $): Promise<void> {
  const current = await read($, draft)
  if (current === null || current.step.kind !== 'planned' || !current.step.isAllowed) return
  await setDraftStep($, { kind: 'sending' })
  const ran = await runDraft($, current, false)
  if (ran === null) return
  const ids = ran.exitCode === 0 ? parseSent(ran.stdout) : null
  if (ids === null) {
    const failure = failureOf(ran.exitCode, ran.stderr)
    await setDraftStep($, { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failure.kind })
    return
  }
  await setDraftStep($, { kind: 'sent', ids })
  const open = await read($, thread)
  if (open?.peer.id === current.peer.id) await loadThread($, open.peer)
}
// ── /routing ──

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
