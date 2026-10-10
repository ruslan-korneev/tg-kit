// Dialogs Pane, phase 1: Telegram dialogs and threads in a pane, read through
// the `tg` CLI. Wide (dock), Compact (inline) and Hidden (status line + band).
// Design: docs/design/dialogs-pane.md §1, §2, §4.
//
// Every function that takes `$` lives in this file: the engine follows `$`
// only into functions declared beside the hook. ./ui and ./tg stay pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register, RenderElement, Timer } from 'claude-code'

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
import { EmptySavedLens, LensEditor, LensTabs, SummaryBlock, WatchRow, summaryRows, watchMark } from './triage/components'
import { MAX_LENSES, draftFrom, parseLenses, toggleGroup, togglePicked, upsertLens } from './triage/lenses'
import { EMPTY_TRIAGE, RECENT, applyToDialogs, applyToMessages, hiddenStatus, latencyText, repliesToYou, reportReply } from './triage/live'
import { RANK_SYSTEM, parseMe, parseVerdicts, pruneVerdicts, rankPrompt, toAsk, verdictKey, type Me } from './triage/needs'
import { SUMMARY_LIMIT, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS, TRIAGE_MODEL, summaryPrompt } from './triage/summary'
import { NO_ME, triageDialogs } from './triage/view'
import { MAX_WATCHED, parseWatched } from './triage/watch'
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
  onMainTurnStart,
  onRadar,
  onTurnComplete,
  parentsAtHand,
  parsePlan,
  parseSent,
  peerOf,
  pinnedContext,
  previewPacket,
  radarOf,
  routeOfRows,
  selectedMessages,
  spawnDescription,
  toIntent,
} from './routing/route'
import { restartPlan, watchArgv, watchLines, type WatchEvent } from './watch/watch'
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

export const register: Register = (on, options) => {
  configureAutopilot(options) // ── autopilot ──
  configureDelegate(options) // ── delegate ──
  registerDelegate(on) // ── delegate ──
  registerTriage(on)
  registerBottest(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tg',
      description: 'Open or focus the Telegram dialogs pane · /tg stop stops every agent',
      argumentHint: '[wide|compact|hidden|stop|autopilot [off|--dangerously-skip-hard-stops[=stops]]]',
      // The kill switch must not wait for main's turn to end, so every /tg runs
      // at once: opening the pane touches no turn state either.
      immediate: true,
    })
    // $.store is shared by every session, so it only seeds a fresh one: after a
    // hot reload $.state still holds this session's mode, and the stored one
    // may be another session's last /tg.
    const isFresh = (await $.state.get({ plugin: 'dialogs-pane', key: 'mode' })).version === 0
    const kept = await $.store.get(STORE_MODE)
    if (isFresh && isMode(kept)) await update($, mode, () => kept)
    // Hidden keeps its status line fresh; an open pane keeps its list fresh.
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => {
        // A failed poll leaves the last list on screen; the next one retries.
      })
    })
    if ((await read($, mode)) === 'hidden') {
      loadDialogs($).catch(() => {
        // The status line stays at `tg …` until the first poll lands.
      })
    }
    const started = await next(e)
    await startRouting($) // ── routing ──
    await startTriage($)
    await startAutopilot($) // ── autopilot ──
    await startDelegate($) // ── delegate ──
    return started
  })

  on('command.run', { command: 'tg' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'autopilot' || asked.startsWith('autopilot ')) return autopilotCommand($, asked.slice('autopilot'.length).trim()) // ── autopilot ──
    if (asked === 'stop') return autopilotCommand($, 'off') // ── autopilot ── the kill switch
    const named = MODE_ARGS.find(one => one === asked)
    if (asked !== '' && named === undefined) return { text: 'Usage: /tg [wide|compact|hidden|stop]' }
    // Never chosen, or Hidden: open as the terminal suits; else as last left.
    const kept = await $.store.get(STORE_MODE)
    const target = named ?? (isMode(kept) && kept !== 'hidden' ? kept : defaultMode(e.presentation))
    await setMode($, target)
    // Hidden needs the list too: its status line counts the unread.
    if ((await read($, dialogs)).status !== 'ok') {
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
    const card = await drawAutopilotView($, els, width, rows) // ── autopilot ──
    if (card !== null) return card
    const over = await drawOverlay($, els, width, rows)
    if (over !== null) return over
    return (await read($, mode)) === 'wide'
      ? await drawWide($, els, width, rows)
      : await drawCompact($, els, width, rows)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // ── autopilot ── drafts, undo and summaries show in every mode.
    const pilot = e.props.hasSurvey ? null : await drawAutopilotBand($, $.ui.resolve(e), e.props.bodyColumns)
    if (pilot !== null) return pilot
    const event = await read($, band)
    if (e.props.hasSurvey || event === null || (await read($, mode)) !== 'hidden') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isBot = event.kind === 'bot'
    const room = Math.max(10, e.props.bodyColumns - event.label.length - 52)
    return (
      <Box flexDirection="row" gap={2}>
        <Text wrap="truncate-end">
          <Text color={isBot ? TOKEN.bot : TOKEN.accent}>{isBot ? GLYPH.bot : GLYPH.unread} </Text>
          {`${event.label}: "${oneLine(event.text, room)}"`}
        </Text>
        {await bandLatency($, $.ui.resolve(e), event)}
        {/* The engine gives band hotkeys and ⏎ the keys only once the band holds
            them (ctrl+x tab or a click); typed at the prompt they are text. */}
        <Text dimColor>ctrl+x tab:</Text>
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
    dgOnTurn($, e.agentId, e.reason, e.answer) // ── delegate ──
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
  await syncWatches($)
}

async function cycleMode($: $): Promise<void> {
  await setMode($, nextMode(await read($, mode)))
}

async function refreshStatus($: $): Promise<void> {
  const pilot = await autopilotStatus($) // ── autopilot ──
  if ((await read($, mode)) !== 'hidden') {
    $.ui.status(pilot.line ?? (pilot.tail === '' ? undefined : `tg${pilot.tail}`))
    return
  }
  $.ui.status(pilot.line ?? hiddenStatus(await read($, dialogs), await read($, band), (await read($, triage)).reply) + ledgerStatus(await read($, ledger)) + pilot.tail)
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
  await bottestThreadOpened($, peer)
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
  const pilotOf = await autopilotMarks($)
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
      mark: markOf(dialog.id),
      autopilot: pilotOf(dialog.id),
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
  // Chrome: header, lens bar, watch row, autopilot row, two dividers, tray (3), hints; bot testing under a thread; task cards.
  const taskCards = await drawTaskCards($, els, width, 'wide') // ── delegate ──
  const room = Math.max(4, rows - 10 - taskCards.rows - (open === null ? 0 : await bottestRows($, width)))
  const listRows = Math.max(3, Math.floor(room * 0.4))
  const summary = await drawSummary($, els, width, false)
  return (
    <Box flexDirection="column">
      {Header(els, { title: 'tg · dialogs', mode: 'wide', onMode: () => cycleMode($) })}
      {LensBar(els, { ...lensProps($, where), ...(await lensExtras($, els)) })}
      {await drawWatchRow($, els)}
      {await drawAutopilotRow($, els)}
      {...taskCards.elements}
      {...await drawDialogList($, els, width, listRows)}
      {Divider(els, { label: open?.peer.label ?? 'no dialog open', width })}
      {summary.element}
      {...await drawThread($, els, width, Math.max(1, room - listRows - summary.rows))}
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
  // Chrome: header, autopilot row, lens bar and watch row or summary and tray line, hints; 8-12 rows in all; bot testing under a thread; a task line each.
  const taskRows = await drawTaskCards($, els, width, 'compact') // ── delegate ──
  const room = Math.max(5, Math.min(rows, 12) - 4 - taskRows.rows - (isThread ? await bottestRows($, width) : 0))
  const summary = isThread ? await drawSummary($, els, width, true) : { element: await drawWatchRow($, els), rows: 1 }
  return (
    <Box flexDirection="column">
      {Header(els, { title: isThread ? `tg · ${open.peer.label}` : 'tg · dialogs', mode: 'compact', onMode: () => cycleMode($) })}
      {await drawAutopilotRow($, els)}
      {...taskRows.elements}
      {isThread ? null : LensBar(els, { ...lensProps($, where), ...(await lensExtras($, els)) })}
      {summary.element}
      {...isThread
        ? await drawThread($, els, width, Math.max(1, room - summary.rows))
        : await drawDialogList($, els, width, Math.max(1, room - summary.rows))}
      {...isThread ? await drawBottest($, els) : []}
      {isThread ? await tray($, els, 'line') : null}
      {HintsRow(els, { hints: hintsFor(isThread ? 'thread' : 'dialogs', await read($, selection)), onHint: key => onHint($, key) })}
    </Box>
  )
}

// ── triage ──
// Live updates through the watch hub, watched dialogs in Hidden mode, saved
// lenses, summaries and needs-you ranking (design §5 ideas 11–14). Every `$`
// function of the triage phase is in this block; its pure rules are in
// ./triage. Keys: w watch, t summary, z lens editor, y needs-you, 4–9 lenses.
// `On`, `MessageView` and `failureText` come from the bottest block's imports
// (imports hoist; one module may import a name once).

const triage = atom({ plugin: 'dialogs-pane', key: 'triage' } as const, EMPTY_TRIAGE)
const STORE_WATCHED = 'triage.watched'
const STORE_LENSES = 'triage.lenses'
const STORE_RANKED = 'triage.ranked'
const RANK_TIMEOUT_MS = 20_000
const HUB_NAME = 'triage'

/**
 * A peer triage listens to on the watch hub, and what it has seen there.
 * Module state: a reload drops the hub's children with it, and session.start
 * subscribes again.
 */
type Listening = {
  peer: PeerRef
  /** Watched dialogs must not idle out; the open thread may, and is listened to again. */
  isBounded: boolean
  /** The hub gave up: kept, so syncWatches does not retry it until `w` does. */
  hasFailed: boolean
  recent: MessageView[]
}

const listening = new Map<number, Listening>()
let me: Me | null = null
let scoring: Promise<void> | null = null
let summaryAbort: AbortController | null = null

/** From pane-core's session.start: what $.store kept, then the watches it calls for. */
async function startTriage($: $): Promise<void> {
  const watched = parseWatched(await $.store.get(STORE_WATCHED))
  const lenses = parseLenses(await $.store.get(STORE_LENSES))
  const isRanked = (await $.store.get(STORE_RANKED)) === true
  // After a reload the old subscriptions are gone, so their health is too.
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
    await Promise.allSettled([...listening.keys()].map(id => stopListening($, id)))
    await apReleaseAll($) // ── delegate ──
    return next(e)
  })
}

function peerRefOf(dialog: TgDialog): PeerRef {
  return { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
}

// --- live updates: the watch hub, for the watched dialogs and the open thread ---

/**
 * Listens to what should be live and stops the rest: every dialog marked
 * with `w` (unbounded), plus the open thread while the pane is up (bounded,
 * like bot testing's, so joining its child does not restart it). Called
 * whenever one of those changes.
 */
async function syncWatches($: $): Promise<void> {
  const state = await read($, triage)
  const open = await read($, thread)
  const wanted = new Map(state.watched.map(peer => [peer.id, { peer, isBounded: false }]))
  if ((await read($, mode)) !== 'hidden' && open !== null && !wanted.has(open.peer.id)) {
    wanted.set(open.peer.id, { peer: open.peer, isBounded: true })
  }
  for (const id of [...listening.keys()]) {
    if (!wanted.has(id)) await stopListening($, id)
  }
  const listed = loaded(await read($, dialogs)) ?? []
  for (const { peer, isBounded } of wanted.values()) {
    const current = listening.get(peer.id)
    if (current !== undefined && (current.isBounded === isBounded || current.hasFailed)) continue
    // Replay from what the pane already has, so nothing between that read and `ready` is lost.
    const shown = open?.peer.id === peer.id ? loaded(open.load)?.at(-1)?.id : undefined
    await listen($, peer, isBounded, shown ?? listed.find(dialog => dialog.id === peer.id)?.last_id ?? null)
  }
  await update($, triage, value => ({
    ...value,
    health: Object.fromEntries(Object.entries(value.health).filter(([id]) => listening.has(Number(id)))),
  }))
}

/** Subscribes, or subscribes again (the hub replaces a subscription by name). */
async function listen($: $, peer: PeerRef, isBounded: boolean, after: number | null): Promise<void> {
  const entry: Listening = { peer, isBounded, hasFailed: false, recent: listening.get(peer.id)?.recent ?? [] }
  listening.set(peer.id, entry)
  await setHealth($, peer.id, 'connecting')
  await subscribeWatch($, peer, {
    name: HUB_NAME,
    isBounded,
    after,
    onEvent: (event, isReplay) => onTriageEvent($, entry, event, isReplay),
    onRestart: () => (listening.get(peer.id) === entry ? setHealth($, peer.id, 'retrying') : Promise.resolve()),
    onEnd: (reason, how) => onTriageEnd($, entry, reason, how),
  })
}

async function stopListening($: $, dialogId: number): Promise<void> {
  listening.delete(dialogId)
  await unsubscribeWatch($, dialogId, HUB_NAME)
}

async function onTriageEnd($: $, entry: Listening, reason: string, how: 'quiet' | 'failed'): Promise<void> {
  if (listening.get(entry.peer.id) !== entry) return
  if (how === 'quiet') {
    // Idled out (the open thread's bounded watch) or stopped from outside. Not
    // listened to again from here, or a watch that ends at once would loop:
    // the next syncWatches (opening a thread, a mode change, `w`) starts it.
    listening.delete(entry.peer.id)
    await update($, triage, value => ({ ...value, health: Object.fromEntries(Object.entries(value.health).filter(([id]) => id !== String(entry.peer.id))) }))
    return
  }
  entry.hasFailed = true
  await setHealth($, entry.peer.id, 'failed')
  $.ui.toast(`tg watch ${entry.peer.label}: ${reason}`)
}

async function setHealth($: $, dialogId: number, health: WatchHealth): Promise<void> {
  if (!listening.has(dialogId)) return
  await update($, triage, value => ({ ...value, health: { ...value.health, [String(dialogId)]: health } }))
}

async function onTriageEvent($: $, entry: Listening, event: WatchEvent, isReplay: boolean): Promise<void> {
  if (listening.get(entry.peer.id) !== entry) return
  const { peer } = entry
  if (event.event === 'ready') {
    await setHealth($, peer.id, 'live')
    return
  }
  if (event.event === 'typing') return
  if (event.event !== 'delete') entry.recent = [...entry.recent, event.message].slice(-RECENT)
  const open = await read($, thread)
  if (open?.peer.id === peer.id && open.load.status === 'ok') {
    const atEnd = (await read($, nav)).messageCursor >= open.load.value.length - 1
    const after = await update($, thread, value =>
      value?.peer.id === peer.id && value.load.status === 'ok'
        ? { ...value, load: { status: 'ok', value: applyToMessages(value.load.value, event, message => message) } }
        : value,
    )
    // A cursor on the newest message follows new ones; one placed higher stays.
    const count = after !== null && after.load.status === 'ok' ? after.load.value.length : 0
    if (atEnd) await update($, nav, value => ({ ...value, messageCursor: Math.max(0, count - 1) }))
  }
  if (event.event !== 'message') return
  const { message } = event
  await update($, dialogs, value => (value.status === 'ok' ? { status: 'ok', value: applyToDialogs(value.value, peer.id, message) } : value))
  if (isReplay || message.out) {
    await refreshStatus($)
    return
  }
  if (repliesToYou(message, entry.recent)) {
    await update($, triage, value => ({ ...value, repliedToYou: { ...value.repliedToYou, [String(peer.id)]: message.id } }))
  }
  if (!(await read($, triage)).watched.some(one => one.id === peer.id)) {
    await refreshStatus($)
    return
  }
  const report = reportReply(peer, message, entry.recent)
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
  if (!isWatched && listening.get(peer.id)?.hasFailed === true) await stopListening($, peer.id)
  await syncWatches($)
}

/** `w`'s dialog: the open thread's in the thread view, else the one at the cursor. */
async function watchTarget($: $): Promise<PeerRef | undefined> {
  const where = await read($, nav)
  const open = await read($, thread)
  if (where.view === 'thread' && open !== null) return open.peer
  const list = await shownDialogs($)
  const dialog = list[clamp(where.dialogCursor, list.length)]
  return dialog === undefined ? undefined : peerRefOf(dialog)
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

/** The band's "⏎ send to main" hook point: the watched reply's own message id, when the band shows one. */
async function watchedReplyId($: $, dialogId: number): Promise<number | null> {
  const reply = (await read($, triage)).reply
  return reply !== null && reply.dialogId === dialogId ? reply.messageId : null
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
    $.ui.toast(`tg: ${MAX_LENSES} lenses at most; open one (4–9) and press z to edit or delete it.`)
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

// ── watch hub ──
// One `tg watch PEER --jsonl` child per peer, shared by everyone who listens:
// bot testing (the open bot thread: live replies, local timing), routing
// (pinned dialogs) and triage (the open thread, watched dialogs). A listener
// subscribes by name; the last one out stops the child. A child that dies
// (exit 1, a signal, a flood wait) is restarted with --after the newest id,
// backing off (restartPlan); listeners hear onRestart, and onEnd only once
// the hub gives up or the watch ends quietly. The argv, the line parser and
// the restart rule are ./watch/watch.
//
//   await subscribeWatch($, peer, { name: 'triage', isBounded: true, after: null,
//     onEvent: async (event, isReplay) => { … }, onEnd: async (reason, how) => { … } })
//   await unsubscribeWatch($, peer.id, 'triage')

type WatchSubscriber = {
  /** One subscription per name and peer; subscribing again replaces it. */
  name: string
  /** True when a quiet watch may end on its own (`--idle-exit`); a pin is not. */
  isBounded: boolean
  /** Replay the messages after this id when a child starts (a pin after a reload). */
  after: number | null
  /** Every event in order. `isReplay`: printed before `ready`, so missed while no child ran. */
  onEvent: (event: WatchEvent, isReplay: boolean) => Promise<void>
  /**
   * The watch is over: `quiet` when it ended on its own (`--idle-exit`,
   * Ctrl-C), `failed` when it never started or the hub gave up restarting.
   * An unsubscribe does not call it.
   */
  onEnd: (reason: string, how: 'quiet' | 'failed') => Promise<void>
  /** The child died and a new one starts after `delayMs`; the subscription stays. */
  onRestart?: (reason: string, delayMs: number) => Promise<void>
}

type WatchHub = {
  peer: PeerRef
  subscribers: Map<string, WatchSubscriber>
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  isBounded: boolean
  isLive: boolean
  /** The newest message id seen, so a restart replays only what it missed. */
  lastId: number | null
  /** Children in a row that died before `ready`. */
  attempt: number
  /** The pending restart after a child died. */
  retry: Timer | null
}

const hubs = new Map<number, WatchHub>()

async function subscribeWatch($: $, peer: PeerRef, subscriber: WatchSubscriber): Promise<void> {
  const hub = hubs.get(peer.id)
  if (hub === undefined) {
    spawnHub($, peer, new Map([[subscriber.name, subscriber]]), subscriber.after)
    return
  }
  hub.subscribers.set(subscriber.name, subscriber)
  // An unbounded listener joined a bounded child: start one without --idle-exit.
  if (!subscriber.isBounded && hub.isBounded) {
    restartHub($, hub)
    return
  }
  // Joined a child that is already live: its replay is over.
  if (hub.isLive) await subscriber.onEvent({ event: 'ready' }, false)
}

async function unsubscribeWatch($: $, peerId: number, name: string): Promise<void> {
  const hub = hubs.get(peerId)
  if (hub === undefined || !hub.subscribers.delete(name)) return
  // Still wanted: the child goes on (an unbounded one stays so until the last leaves).
  if (hub.subscribers.size > 0) return
  hubs.delete(peerId)
  hub.retry?.cancel()
  await stopStream(hub.stream)
}

function spawnHub($: $, peer: PeerRef, subscribers: Map<string, WatchSubscriber>, after: number | null): void {
  const isBounded = [...subscribers.values()].every(one => one.isBounded)
  const stream = $.process.spawn({ argv: watchArgv(peer.arg, { after, isBounded }) })
  const hub: WatchHub = { peer, subscribers, stream, isBounded, isLive: false, lastId: after, attempt: 0, retry: null }
  hubs.set(peer.id, hub)
  runHub($, hub)
}

function runHub($: $, hub: WatchHub): void {
  pumpHub($, hub).catch(async (error: unknown) => {
    if (hubs.get(hub.peer.id) !== hub) return
    hubs.delete(hub.peer.id)
    await endHub(hub, `tg watch did not run: ${reasonOf(error)}`, 'failed')
  })
}

/** The same hub, a new child after the last one died: it replays from the newest id seen. */
function respawnHub($: $, hub: WatchHub): void {
  hub.retry = null
  if (hubs.get(hub.peer.id) !== hub) return
  hub.isLive = false
  hub.stream = $.process.spawn({ argv: watchArgv(hub.peer.arg, { after: hub.lastId ?? oldestAfter(hub.subscribers), isBounded: hub.isBounded }) })
  runHub($, hub)
}

/** A new child for the same subscribers, replaying from the newest id seen. */
function restartHub($: $, hub: WatchHub): void {
  const after = hub.lastId ?? oldestAfter(hub.subscribers)
  hub.retry?.cancel()
  spawnHub($, hub.peer, hub.subscribers, after)
  stopStream(hub.stream).catch(() => {
    // The old child is gone already; the new one carries on.
  })
}

function oldestAfter(subscribers: Map<string, WatchSubscriber>): number | null {
  const afters = [...subscribers.values()].flatMap(one => (one.after === null ? [] : [one.after]))
  return afters.length === 0 ? null : Math.min(...afters)
}

async function stopStream(stream: WatchHub['stream']): Promise<void> {
  // Leaving the stream kills the child; the value is only the generator's own return.
  await stream.return({ code: null, signal: 'SIGTERM' })
}

async function pumpHub($: $, hub: WatchHub): Promise<void> {
  let rest = ''
  let stderr = ''
  for await (const chunk of hub.stream) {
    // Stopped or replaced: this child's lines are no one's any more.
    if (hubs.get(hub.peer.id) !== hub) return
    if (chunk.stream === 'stderr') {
      stderr = (stderr + chunk.text).slice(-2000)
      continue
    }
    const parsed = watchLines(rest, chunk.text)
    rest = parsed.rest
    // In order: an edit must reach every listener after the message it edits.
    for (const event of parsed.events) await dispatch(hub, event)
  }
  if (hubs.get(hub.peer.id) !== hub) return
  const ended = await hub.stream.result
  const reason = watchEnded(ended, stderr)
  const plan = restartPlan(ended.code, ended.signal, stderr, hub.attempt)
  if (plan.kind === 'restart') {
    hub.attempt += 1
    await Promise.allSettled([...hub.subscribers.values()].map(one => one.onRestart?.(reason, plan.delayMs)))
    hub.retry = $.clock.after(plan.delayMs, () => respawnHub($, hub))
    return
  }
  hubs.delete(hub.peer.id)
  await endHub(hub, reason, plan.how)
}

async function dispatch(hub: WatchHub, event: WatchEvent): Promise<void> {
  if (event.event === 'ready') {
    hub.isLive = true
    hub.attempt = 0
  }
  if (event.event === 'message' || event.event === 'edit') hub.lastId = Math.max(hub.lastId ?? 0, event.message.id)
  const isReplay = !hub.isLive
  // One listener failing must not starve the others.
  await Promise.allSettled([...hub.subscribers.values()].map(one => one.onEvent(event, isReplay)))
}

async function endHub(hub: WatchHub, reason: string, how: 'quiet' | 'failed'): Promise<void> {
  await Promise.allSettled([...hub.subscribers.values()].map(one => one.onEnd(reason, how)))
}

/** Why a watch stopped, in a listener's words: tg's own error line when it gave one. */
function watchEnded(ended: ProcessSpawnResult, stderr: string): string {
  if (ended.code === 0) return 'tg watch ended'
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
// ── /watch hub ──

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
  await Promise.all(kept.map((pin: Pin) => startPinWatch($, pin)))
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
 * Main gets the packet as a prompt of its own (the human's decision): the
 * transcript shows exactly what the model reads, the packet and its intent
 * line, under this plugin's name. A busy main runs it once idle.
 */
async function deliverMain($: $, base: Base, packet: Packet): Promise<void> {
  const at = await $.clock.now()
  const seq = await addToLedger($, { ...base, at, to: { kind: 'main' }, state: { kind: 'sent' } })
  // $.prompt.submit resolves only when the packet's turn starts: a busy main
  // would hold the press for its whole turn, so the send does not wait on it.
  submitToMain($, seq, packet.text).catch(async (error: unknown) => {
    await markEntry($, seq, { kind: 'failed', reason: reasonOf(error) })
  })
}

async function submitToMain($: $, seq: number, text: string): Promise<void> {
  const submitted = await $.prompt.submit({ text })
  if (submitted.drop !== undefined) await markEntry($, seq, { kind: 'failed', reason: submitted.drop })
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
  // A watched reply names its own message (triage); otherwise the dialog's newest.
  const messageId = event === null ? null : ((await watchedReplyId($, event.dialogId)) ?? dialog?.last_id ?? null)
  if (event === null || dialog === undefined || messageId === null) {
    $.ui.toast('tg: that message is no longer in the dialog list; open it with o.')
    return
  }
  const peer: PeerRef = { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
  const found = await runTg($, tg.msg(peer.arg, [messageId]))
  if (!found.ok || found.value.length === 0) {
    $.ui.toast(`tg: could not fetch #${messageId} (${found.ok ? 'not found' : found.failure.kind}).`)
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
  await startPinWatch($, pin)
  const where = to.kind === 'main' ? 'main, every turn' : to.label
  const note = chosen.kind === 'one' && chosen.to.kind !== 'new' ? '' : ' (pins go to main or one named agent)'
  $.ui.toast(`tg: ${GLYPH.pinned} ${open.peer.label} pinned → ${where}${note}. p again unpins.`)
}

async function unpin($: $, peerId: number): Promise<void> {
  await update($, pins, value => value.filter(pin => pin.peer.id !== peerId))
  $.ui.invalidate('prompt.context')
  await unsubscribeWatch($, peerId, 'pin')
}

/** The pin listens on the peer's shared watch, replaying from its lastId; it keeps the watch from idling out. */
async function startPinWatch($: $, pin: Pin): Promise<void> {
  await subscribeWatch($, pin.peer, {
    name: 'pin',
    isBounded: false,
    after: pin.lastId,
    onEvent: event => onPinEvent($, pin.peer.id, event),
    onEnd: reason => setWatch($, pin.peer.id, { status: 'failed', reason: `${reason}; p twice restarts it` }),
  })
}

async function onPinEvent($: $, peerId: number, event: WatchEvent): Promise<void> {
  if (event.event === 'ready') {
    await setWatch($, peerId, { status: 'live' })
    return
  }
  if (event.event !== 'message' && event.event !== 'edit') return
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

// --- drafted replies: dry run first, then the same tg send; the owner's, so --yes ---

/** The step of `of`, only while it is still the draft in the row: a turn can put another in its place meanwhile. */
async function setDraftStep($: $, of: ReplyDraft, step: ReplyDraft['step']): Promise<void> {
  await update($, draft, value =>
    value !== null && value.peer.id === of.peer.id && value.replyTo === of.replyTo && value.text === of.text ? { ...value, step } : value,
  )
}

async function runDraft($: $, current: ReplyDraft, isDryRun: boolean) {
  if (isBotFather(current.peer.arg)) {
    await setDraftStep($, current, { kind: 'failed', reason: readOnlyText({ kind: 'botfather' }) })
    return null
  }
  try {
    // The owner checks and sends it after reading it whole: their own write (decision 9).
    return await $.process.run(draftArgv(current, isDryRun, true), { stdin: current.text, timeoutMs: TG_TIMEOUT_MS })
  } catch (error) {
    await setDraftStep($, current, { kind: 'failed', reason: `tg did not run: ${reasonOf(error)}` })
    return null
  }
}

/** check: `tg send … --dry-run` prints the WritePlan and the guard's verdict; nothing is sent. */
async function checkDraft($: $): Promise<void> {
  const current = await read($, draft)
  if (current === null) return
  await setDraftStep($, current, { kind: 'checking' })
  const ran = await runDraft($, current, true)
  if (ran === null) return
  const plan = ran.exitCode === 0 ? parsePlan(ran.stdout) : null
  if (plan === null) {
    const failure = failureOf(ran.exitCode, ran.stderr)
    await setDraftStep($, current, { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failure.kind })
    return
  }
  await setDraftStep($, current, { kind: 'planned', ...plan })
}

/** send reply: only after a check the guard allowed, and the same argv minus --dry-run. */
async function sendDraft($: $): Promise<void> {
  const current = await read($, draft)
  if (current === null || current.step.kind !== 'planned' || !current.step.isAllowed) return
  await setDraftStep($, current, { kind: 'sending' })
  const ran = await runDraft($, current, false)
  if (ran === null) return
  const ids = ran.exitCode === 0 ? parseSent(ran.stdout) : null
  if (ids === null) {
    const failure = failureOf(ran.exitCode, ran.stderr)
    await setDraftStep($, current, { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failure.kind })
    return
  }
  await setDraftStep($, current, { kind: 'sent', ids })
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
import { calls, decodeAllow, mergeMessages, PRESS_WAIT_S, SEND_WAIT_S, settleWrite, type WriteResult } from './bottest/calls'
import { diffPair, replyDiff } from './bottest/diff'
import { chipAction, isBotFather, readOnlyText } from './bottest/keyboard'
import { NO_TIMING, observe, pressed, sent, stampFor } from './bottest/latency'
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

/** The bot thread whose shared watch bot testing listens on. */
let watchedPeer: number | null = null

async function stopWatch($: $): Promise<void> {
  const peerId = watchedPeer
  if (peerId === null) return
  watchedPeer = null
  await unsubscribeWatch($, peerId, 'bottest')
  await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'off' } }))
}

/** Listens on the bot thread's shared `tg watch` (the watch hub); bounded, as nobody may stop it. */
async function startWatch($: $, peer: PeerRef): Promise<void> {
  await stopWatch($)
  await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'starting' } }))
  watchedPeer = peer.id
  await subscribeWatch($, peer, {
    name: 'bottest',
    isBounded: true,
    after: null,
    onEvent: (event, isReplay) => onWatchEvent($, peer, event, isReplay),
    onEnd: async () => {
      // tg is missing or the watch ended: stamps fall back to message dates.
      if (watchedPeer !== peer.id) return
      watchedPeer = null
      await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'off' } }))
    },
  })
}

async function onWatchEvent($: $, peer: PeerRef, event: WatchEvent, isReplay: boolean): Promise<void> {
  const at = await $.clock.now()
  if (event.event === 'ready') {
    await update($, bottest, value => ({ ...value, timing: { ...value.timing, watch: 'live' } }))
    return
  }
  if (event.event !== 'message' && event.event !== 'edit') return
  // A replayed message arrived while nobody watched: its local time says nothing.
  if (!isReplay) await update($, bottest, value => ({ ...value, timing: observe(value.timing, event.event, event.message, at) }))
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
      // loadAllow records its own failure; the autopilot card reads the allowlist again.
    })
  }
  if (peer.kind === 'bot') await startWatch($, peer)
  else await stopWatch($)
}

// --- writes: press and send, the owner's own: --yes, only BotFather refused here ---

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
    // --yes leaves tg's guard no allowlist to refuse over; `readonly = true` says so itself.
    await say($, result.failure.kind === 'flood' ? 'warn' : 'danger', `${GLYPH.error} ${failureText(result.failure, startedAt)}`)
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

/** A chip's press: shown, refused, or `tg press PEER ID --row R --col C --wait 5s --json --yes`. */
async function pressChip($: $, message: MessageView, button: KeyButton): Promise<void> {
  const open = await read($, thread)
  if (open === null) return
  const action = chipAction(button)
  if (action.kind !== 'press') return say($, action.kind === 'show' ? 'info' : 'warn', action.text)
  if (isBotFather(open.peer.arg)) return say($, 'warn', readOnlyText({ kind: 'botfather' }))
  if ((await read($, bottest)).busy !== null) return say($, 'info', 'tg is still running the last step; press again once it is done.')
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, busy: `pressing "${button.text}"`, notice: null, timing: pressed(value.timing, at, message.id, []) }))
  const result = await runWrite($, calls.press(open.peer.arg, message.id, button.row, button.col, true))
  await finishWrite($, open.peer, { kind: 'press', message, button, wait_s: PRESS_WAIT_S }, at, result)
}

/** The send box's submit: `tg send PEER - --plain --wait 10s --json --yes`, the text on stdin. */
async function sendText($: $, text: string): Promise<void> {
  await update($, bottest, value => ({ ...value, composing: false }))
  const open = await read($, thread)
  if (open === null || text.trim() === '') return
  if (isBotFather(open.peer.arg)) return say($, 'warn', readOnlyText({ kind: 'botfather' }))
  if ((await read($, bottest)).busy !== null) return say($, 'info', 'tg is still running the last step; send again once it is done.')
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, busy: `sending ${oneLine(text, 24)}`, notice: null, timing: sent(value.timing, at) }))
  const result = await runWrite($, calls.send(open.peer.arg, true), text)
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
  // A press is the owner's own write (--yes): only BotFather's chips are read-only.
  const isReadOnly = isBotFather(peer.arg)
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

// ── autopilot ──
// Phase 3 (docs/design/dialogs-pane.md §6): chosen dialogs answered as you.
// Each running dialog listens on the watch hub (name 'autopilot', unbounded).
// A burst waits for its gap and for the other side to stop typing (60 s at
// most); the Speaker, one $.model.complete call with no tools, writes; the
// dialog is read again right before sending; a reply leaves through the
// bottest write runner as `tg send PEER - --plain --json` (calls.reply), so tg's
// guard and allow.toml decide. Only the owner's own keys pass --yes: ⏎ on a
// draft the band shows whole, and `u`'s delete (design doc §9 decision 9).
// Pure rules are in ./autopilot; every `$` call is here. Keys: q the card
// (pane), u undo (pane and band); a draft's ⏎ e x o in the band. The kill
// switch: `/tg stop` (or `/tg autopilot off`), "stop all" (0).
import type { PluginOptions } from 'claude-code'

import type { ApDialog, ApDraft, ApLevel, ApOutcome, ApPhase, ApTopic, ApUndo, Autopilot } from '../types'
import { AutopilotCard, AutopilotLedger, AutopilotRow, DraftBand, NoteBand, UndoBand, type AllowView } from './autopilot/components'
import {
  AP_LEVELS,
  LEVEL_GLYPH,
  defaultDialog,
  parseDialogs as parseApDialogs,
  parseQuiet,
  parseRate,
  rateText,
  stepGap,
  stepRate,
  stepThreshold,
  toggleTopic,
  DEFAULT_QUIET,
} from './autopilot/config'
import { MAX_REGENERATIONS, NO_BURST, afterCheck, consume, gate, onDeleted, onEdited, onIncoming, onTyping, sentLastHour, wakeAt, type AfterCheck, type Burst } from './autopilot/burst'
import { NO_AUTOPILOT, UNDO_MS, addEntry as addApEntry, draftsTail, logCheck, patchEntry, putDraft, undoStatus } from './autopilot/ledger'
import {
  HISTORY_LIMIT,
  LISTEN_SYSTEM,
  MORE_HISTORY_LIMIT,
  SPEAKER_MAX_TOKENS,
  SPEAKER_MODEL,
  SPEAKER_TIMEOUT_MS,
  checkPrompt,
  listenPrompt,
  parseChecked,
  parseSpoken,
  replyPrompt,
  speakerSystem,
  type Checked,
  type Spoken,
} from './autopilot/speaker'
import { readOnlyReason as apReadOnly } from './bottest/keyboard'

const autopilot = atom({ plugin: 'dialogs-pane', key: 'autopilot' } as const, NO_AUTOPILOT)
const STORE_AUTOPILOT = 'autopilot.dialogs'
const AP_HUB = 'autopilot'

/** The mod option `speakerModel`, read at each load (SPEAKER_MODEL says why the default). */
let speakerModel = SPEAKER_MODEL

function configureAutopilot(options: PluginOptions): void {
  const chosen = options.speakerModel
  speakerModel = typeof chosen === 'string' && chosen.trim() !== '' ? chosen.trim() : SPEAKER_MODEL
}

/** One running dialog's live half: module state, so a reload starts it over from $.state's `running`. */
type ApRuntime = {
  peer: PeerRef
  burst: Burst
  timer: Timer | null
  isBusy: boolean
  /** Bumped on stop and when you answer yourself: a flow begun under an older turn ends without writing. */
  turn: number
  /** Past the hub's `ready`: replayed lines after that are messages a restart missed. */
  wasLive: boolean
  /** A send is running: your own outgoing message from it is not "you answered". */
  isSending: boolean
  sentIds: Set<number>
  /** The burst's ledger entry, kept across its regenerations. */
  seq: number | null
  abort: AbortController | null
}

const apRuntimes = new Map<number, ApRuntime>()
let apTicker: Timer | null = null

/** From session.start (and a reload): the settings from $.store; dialogs still `running` in this session listen again. */
async function startAutopilot($: $): Promise<void> {
  const dialogs = parseApDialogs(await $.store.get(STORE_AUTOPILOT))
  const state = await update($, autopilot, (value): Autopilot => ({
    ...value,
    dialogs,
    running: value.running.filter(id => dialogs[String(id)] !== undefined),
    phase: {},
    view: value.view.kind === 'card' && dialogs[String(value.view.dialogId)] === undefined ? { kind: 'none' } : value.view,
  }))
  // ── delegate ── a reload keeps this session's leases; one another session took meanwhile stops here.
  const kept = await apKeepLeases($, state.running)
  await Promise.all(
    kept.flatMap(id => {
      const dialog = state.dialogs[String(id)]
      return dialog === undefined ? [] : [apListen($, dialog.peer)]
    }),
  )
  if (state.undo !== null) apStartTicker($)
}

async function apSetPhase($: $, dialogId: number, phase: ApPhase): Promise<void> {
  await update($, autopilot, value => (value.phase[String(dialogId)] === phase ? value : { ...value, phase: { ...value.phase, [String(dialogId)]: phase } }))
}

async function apDialog($: $, dialogId: number): Promise<ApDialog | null> {
  return (await read($, autopilot)).dialogs[String(dialogId)] ?? null
}

async function apLog($: $, entry: Omit<Autopilot['ledger'][number], 'seq'>): Promise<number> {
  const next = await update($, autopilot, value => ({ ...value, ledger: addApEntry(value.ledger, entry) }))
  return next.ledger.at(-1)?.seq ?? 0
}

async function apPatch($: $, seq: number, patch: Parameters<typeof patchEntry>[2]): Promise<void> {
  await update($, autopilot, value => ({ ...value, ledger: patchEntry(value.ledger, seq, patch) }))
}

/** The text a ledger row and the band show for a message. */
function messageText(message: MessageView | undefined): string {
  if (message === undefined) return ''
  return [message.media === null ? '' : `[${message.media.type}]`, message.text].filter(part => part !== '').join(' ')
}

function localMinutes(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

function apAllowView(peer: PeerRef, allow: BotTest['allow']): AllowView {
  if (allow.status === 'idle' || allow.status === 'loading') return { kind: 'loading' }
  if (allow.status === 'error') return { kind: 'error', text: failureText(allow.failure, 0) }
  const blocked = apReadOnly(peer, allow.value)
  return blocked?.kind === 'botfather' ? { kind: 'error', text: readOnlyText(blocked) } : { kind: 'ok', isAllowed: blocked === null }
}

/**
 * Whether tg's guard lets writes to the dialog through without --yes; the allowlist is read when not at hand.
 * `reread` reads it again before answering no, so the card's "press 3 again" sees a `! tg allow add` run since.
 */
async function apIsAllowed($: $, peer: PeerRef, reread = false): Promise<boolean> {
  const allowed = async () => {
    const view = apAllowView(peer, (await read($, bottest)).allow)
    return view.kind === 'ok' && view.isAllowed
  }
  if ((await read($, bottest)).allow.status !== 'ok') await loadAllow($)
  else if (reread && !(await allowed())) await loadAllow($)
  return allowed()
}

// --- listening: the watch hub ---

async function apListen($: $, peer: PeerRef): Promise<void> {
  const rt: ApRuntime = { peer, burst: NO_BURST, timer: null, isBusy: false, turn: 0, wasLive: false, isSending: false, sentIds: new Set(), seq: null, abort: null }
  apRuntimes.set(peer.id, rt)
  await apSetPhase($, peer.id, 'listening')
  await subscribeWatch($, peer, {
    name: AP_HUB,
    isBounded: false,
    after: null,
    onEvent: (event, isReplay) => onApEvent($, rt, event, isReplay),
    onEnd: reason => onApEnd($, rt, reason),
  })
}

/** Stops one dialog: its timer, its model call, its subscription; a burst in the works is logged as stopped. */
async function apUnlisten($: $, dialogId: number): Promise<void> {
  const rt = apRuntimes.get(dialogId)
  if (rt === undefined) return
  apRuntimes.delete(dialogId)
  rt.turn += 1
  rt.timer?.cancel()
  rt.abort?.abort()
  if (rt.seq !== null) await apPatch($, rt.seq, { outcome: { kind: 'skipped', reason: 'autopilot stopped' } })
  await unsubscribeWatch($, dialogId, AP_HUB)
  await dgStopTasksOf($, dialogId, 'autopilot stopped') // ── delegate ──
  await apReleaseLease($, dialogId) // ── delegate ──
}

async function onApEnd($: $, rt: ApRuntime, reason: string): Promise<void> {
  if (apRuntimes.get(rt.peer.id) !== rt) return
  await apUnlisten($, rt.peer.id)
  await update($, autopilot, value => ({ ...value, running: value.running.filter(id => id !== rt.peer.id) }))
  $.ui.toast(`tg: autopilot stopped for ${rt.peer.label}: ${reason}`)
}

async function onApEvent($: $, rt: ApRuntime, event: WatchEvent, isReplay: boolean): Promise<void> {
  if (apRuntimes.get(rt.peer.id) !== rt) return
  const at = await $.clock.now()
  switch (event.event) {
    case 'ready':
      rt.wasLive = true
      return
    case 'typing':
      rt.burst = onTyping(rt.burst, event.action, at)
      return apSchedule($, rt)
    case 'delete':
      rt.burst = onDeleted(rt.burst, event.ids)
      return apSchedule($, rt)
    case 'edit':
      if (!event.message.out) rt.burst = onEdited(rt.burst, event.message)
      return
    case 'message':
      break
  }
  const { message } = event
  // What came before the autopilot started listening is not its to answer.
  if (isReplay && !rt.wasLive) return
  if (message.out) {
    if (rt.isSending || rt.sentIds.has(message.id)) return
    if (rt.burst.messages.length > 0 || rt.isBusy) await apYouAnswered($, rt)
    return
  }
  // Joins, leaves and pins are not messages to answer.
  if (message.service !== null) return
  rt.burst = onIncoming(rt.burst, message, at)
  await apSchedule($, rt)
}

/** You wrote in the dialog yourself: the burst is yours, its work stops, its stale draft goes. */
async function apYouAnswered($: $, rt: ApRuntime): Promise<void> {
  rt.turn += 1
  rt.abort?.abort()
  rt.timer?.cancel()
  rt.timer = null
  const seq = rt.seq
  rt.seq = null
  rt.burst = NO_BURST
  if (seq !== null) await apPatch($, seq, { outcome: { kind: 'skipped', reason: 'you replied' } })
  await update($, autopilot, value => ({ ...value, drafts: value.drafts.filter(one => one.peer.id !== rt.peer.id) }))
  await apSetPhase($, rt.peer.id, 'listening')
  await refreshStatus($)
}

/** Sets the burst's timer, or starts it; never awaits the answer, so the hub keeps delivering events meanwhile. */
async function apSchedule($: $, rt: ApRuntime): Promise<void> {
  if (apRuntimes.get(rt.peer.id) !== rt || rt.isBusy) return
  const dialog = await apDialog($, rt.peer.id)
  if (dialog === null) return
  const at = await $.clock.now()
  const wake = wakeAt(rt.burst, dialog.gapS * 1000, at)
  rt.timer?.cancel()
  rt.timer = null
  switch (wake.kind) {
    case 'idle':
      return apSetPhase($, rt.peer.id, 'listening')
    case 'wait':
      rt.timer = $.clock.after(wake.at - at, () => {
        rt.timer = null
        apSchedule($, rt).catch(() => {
          // A failed wake leaves the burst waiting; the next message or typing event schedules it again.
        })
      })
      return apSetPhase($, rt.peer.id, wake.why === 'typing' ? 'typing' : 'gathering')
    case 'go':
      apRunBurst($, rt).catch(() => {
        // apRunBurst logs its own failures in the ledger; nothing is left to report.
      })
      return
  }
}

async function apRunBurst($: $, rt: ApRuntime): Promise<void> {
  if (rt.isBusy) return
  rt.isBusy = true
  const turn = rt.turn
  try {
    await apAnswer($, rt, turn)
  } catch (error) {
    if (rt.seq !== null && rt.turn === turn) await apDone($, rt, rt.burst.messages.map(one => one.id), { kind: 'failed', reason: reasonOf(error) })
  } finally {
    rt.isBusy = false
    rt.abort = null
  }
  if (apRuntimes.get(rt.peer.id) === rt) await apSchedule($, rt)
}

/** The burst is handled: its messages leave it, and its ledger entry gets the outcome. */
async function apDone($: $, rt: ApRuntime, ids: readonly number[], outcome: ApOutcome, patch: Parameters<typeof patchEntry>[2] = {}): Promise<void> {
  const seq = rt.seq
  rt.burst = consume(rt.burst, ids)
  rt.seq = null
  if (seq !== null) await apPatch($, seq, { ...patch, outcome })
  await refreshStatus($)
}

/** read_history: the dialog's last messages, oldest first; none when tg cannot say. */
async function apHistory($: $, rt: ApRuntime, limit: number): Promise<MessageView[]> {
  const result = await runTg($, tg.read(rt.peer.arg, { limit }))
  return result.ok ? result.value : []
}

type Said<T> = { ok: true; value: T } | { ok: false; reason: string }

async function apAsk<T>($: $, rt: ApRuntime, dialog: ApDialog, prompt: string, parse: (text: string) => T | null, system = speakerSystem(dialog)): Promise<Said<T>> {
  rt.abort = new AbortController()
  const result = await $.model.complete(
    { model: speakerModel, system, prompt, maxTokens: SPEAKER_MAX_TOKENS, timeoutMs: SPEAKER_TIMEOUT_MS },
    { signal: rt.abort.signal },
  )
  if (!result.isAnswered) return { ok: false, reason: modelFailure(result) }
  const value = parse(result.text)
  return value === null ? { ok: false, reason: 'the Speaker answered in a shape the autopilot cannot read' } : { ok: true, value }
}

/**
 * One burst: read_history, the Speaker, the gate; for a reply that may go out
 * by itself, the dialog read again and, when it moved, the Speaker's check
 * choice. Every await is followed by `alive()`: a stop or your own reply ends
 * the flow there, before anything is written.
 */
async function apAnswer($: $, rt: ApRuntime, turn: number): Promise<void> {
  const alive = () => apRuntimes.get(rt.peer.id) === rt && rt.turn === turn
  const dialog = await apDialog($, rt.peer.id)
  const burst = rt.burst.messages
  if (dialog === null || burst.length === 0) return
  const ids = burst.map(one => one.id)
  await apSetPhase($, rt.peer.id, 'thinking')
  const incoming = burst.map(one => ({ id: one.id, text: messageText(one) }))
  if (rt.seq === null) {
    rt.seq = await apLog($, { at: await $.clock.now(), peer: rt.peer, level: dialog.level, incoming, reply: '', confidence: null, topics: [], checks: [], outcome: { kind: 'working' }, undo: null })
  } else {
    await apPatch($, rt.seq, { incoming, level: dialog.level })
  }
  const peer = peerOf(rt.peer, loaded(await read($, dialogs)) ?? [])
  const history = await apHistory($, rt, HISTORY_LIMIT)
  if (!alive()) return

  if (dialog.level === 'listen') {
    rt.abort = new AbortController()
    const result = await $.model.complete(
      { model: speakerModel, system: LISTEN_SYSTEM, prompt: listenPrompt({ peer, burst, history }), maxTokens: 200, timeoutMs: SPEAKER_TIMEOUT_MS },
      { signal: rt.abort.signal },
    )
    if (!alive()) return
    if (!result.isAnswered) return apDone($, rt, ids, { kind: 'failed', reason: modelFailure(result) })
    const text = oneLine(result.text.trim(), 200)
    const seq = rt.seq ?? 0
    await update($, autopilot, value => ({ ...value, notes: [...value.notes.filter(one => one.peer.id !== rt.peer.id), { seq, peer: rt.peer, text }] }))
    return apDone($, rt, ids, { kind: 'listened' }, { reply: text })
  }

  // ── delegate ── a delegate dialog's Speaker also has the task actions, and sees the running task.
  const task = dialog.level === 'delegate' ? await dgLiveTask($, rt.peer.id) : null
  const speak = (context: MessageView[], canReadMore: boolean): Promise<Said<DelegateSpoken>> => {
    const prompt = replyPrompt({ peer, burst, history: context, canReadMore })
    return dialog.level === 'delegate'
      ? apAsk($, rt, dialog, `${prompt}\n${delegateInstructions(task)}`, parseDelegate, delegateSystem(dialog))
      : apAsk($, rt, dialog, prompt, text => {
          const spoken = parseSpoken(text)
          return spoken === null ? null : { spoken, task: null }
        })
  }
  let asked = await speak(history, true)
  if (asked.ok && asked.value.spoken.action === 'read_history') {
    const more = await apHistory($, rt, MORE_HISTORY_LIMIT)
    if (!alive()) return
    asked = await speak(more, false)
  }
  if (!alive()) return
  if (!asked.ok) return apDone($, rt, ids, { kind: 'failed', reason: asked.reason })
  const said = asked.value.spoken
  if (asked.value.task !== null) await dgOnTaskAction($, rt.peer, asked.value.task, { peer, burst, history }) // ── delegate ──
  if (said.action === 'none' || said.action === 'read_history') {
    return apDone($, rt, ids, { kind: 'skipped', reason: said.reason === '' ? 'nothing to answer' : said.reason }, { confidence: said.confidence, topics: said.topics })
  }
  const at = await $.clock.now()
  const verdict = gate(dialog, { ...said, action: said.action }, {
    sentLastHour: sentLastHour((await read($, autopilot)).ledger, rt.peer.id, at),
    minutes: localMinutes(at),
    isAllowed: await apIsAllowed($, rt.peer),
  })
  if (rt.seq !== null) await apPatch($, rt.seq, { reply: said.text, confidence: said.confidence, topics: said.topics })
  if (!alive()) return
  if (verdict.kind === 'draft') return apToDraft($, rt, ids, said, verdict.reasons)

  // Check before sending: read the dialog again.
  await apSetPhase($, rt.peer.id, 'checking')
  const fresh = await apFresh($, rt, ids)
  if (!alive()) return
  if (fresh === null) return apYouAnswered($, rt)
  let next: AfterCheck = 'send'
  let confidence = said.confidence
  if (fresh.length > 0) {
    const checked: Said<Checked> = await apAsk($, rt, dialog, checkPrompt({ peer, burst, reply: said.text, fresh }), parseChecked)
    if (!alive()) return
    if (!checked.ok) return apToDraft($, rt, [...ids, ...fresh.map(one => one.id)], said, [`check failed: ${checked.reason}`])
    const choice = checked.value.choice
    if (rt.seq !== null) {
      const seq = rt.seq
      await update($, autopilot, value => ({ ...value, ledger: logCheck(value.ledger, seq, choice) }))
    }
    // The draft's confidence as of the new messages: past the regeneration cap it decides send or draft.
    confidence = checked.value.confidence ?? confidence
    next = afterCheck(choice, rt.burst.regenerations, confidence, dialog.threshold)
  }
  const all = [...ids, ...(fresh ?? []).map(one => one.id)]
  switch (next) {
    case 'regenerate':
      // The new messages are in the burst; a new gap from now, then the Speaker writes it again.
      rt.burst = { ...rt.burst, regenerations: rt.burst.regenerations + 1, lastAt: await $.clock.now() }
      return apSetPhase($, rt.peer.id, 'gathering')
    case 'draft':
      return apToDraft($, rt, all, { ...said, confidence }, [`regenerated ${MAX_REGENERATIONS}×, conf < ${dialog.threshold.toFixed(2)}`])
    case 'send':
      return apSendReply($, rt, turn, all, said)
    case 'send_then_answer':
      return apSendReply($, rt, turn, ids, said)
  }
}

/**
 * Reads the dialog again before sending: the incoming messages newer than the
 * burst (tg's view joined with the watch's), now part of the burst; null when
 * a message of yours came meanwhile.
 */
async function apFresh($: $, rt: ApRuntime, ids: readonly number[]): Promise<MessageView[] | null> {
  const newest = Math.max(...ids)
  const result = await runTg($, tg.read(rt.peer.arg, { limit: 10 }))
  // tg could not read: the watch's view stands alone (it is live, so it lags by a moment at most).
  const later = result.ok ? result.value.filter(one => one.id > newest) : []
  if (later.some(one => one.out && !rt.sentIds.has(one.id))) return null
  const at = await $.clock.now()
  for (const message of later) {
    if (!message.out && message.service === null) rt.burst = onIncoming(rt.burst, message, at)
  }
  return rt.burst.messages.filter(one => !ids.includes(one.id))
}

async function apToDraft($: $, rt: ApRuntime, ids: readonly number[], said: Spoken, reasons: string[]): Promise<void> {
  const seq = rt.seq ?? 0
  const last = rt.burst.messages.filter(one => ids.includes(one.id)).at(-1)
  const draft: ApDraft = { seq, peer: rt.peer, incoming: messageText(last), text: said.text, confidence: said.confidence, reasons, state: { kind: 'ready' } }
  await update($, autopilot, value => ({ ...value, drafts: putDraft(value.drafts, draft) }))
  await apDone($, rt, ids, { kind: 'drafted', reasons })
}

function writeFailure(result: WriteResult & { ok: false }, peer: PeerRef, at: number): string {
  const why = failureText(result.failure, at)
  return result.isRefused ? `${why} ${readOnlyText({ kind: 'not-allowed', arg: peer.arg })}` : why
}

async function apSendReply($: $, rt: ApRuntime, turn: number, ids: readonly number[], said: Spoken): Promise<void> {
  const isRunning = (await read($, autopilot)).running.includes(rt.peer.id)
  if (apRuntimes.get(rt.peer.id) !== rt || rt.turn !== turn || !isRunning) return
  // ── delegate ── share and commit-on-behalf stop the Speaker's text until you answer.
  const stopped = await dgOutgoing($, rt.peer, said.text, rt.seq)
  if (apRuntimes.get(rt.peer.id) !== rt || rt.turn !== turn) return
  if (stopped !== null) return apToDraft($, rt, ids, said, [stopped])
  await apSetPhase($, rt.peer.id, 'sending')
  rt.isSending = true
  let result: WriteResult
  try {
    result = await runWrite($, calls.reply(rt.peer.arg), said.text)
  } finally {
    rt.isSending = false
  }
  const at = await $.clock.now()
  if (!result.ok) {
    // The text is not lost: it waits as a draft, with tg's reason.
    return apToDraft($, rt, ids, said, [writeFailure(result, rt.peer, at)])
  }
  const sent = result.sent.map(one => one.id)
  for (const id of sent) rt.sentIds.add(id)
  const seq = rt.seq ?? 0
  await dgOnSent($, rt.peer.id, said.text, at) // ── delegate ──
  await apDone($, rt, ids, { kind: 'sent', ids: sent, by: 'auto' }, { undo: { state: 'open', until: at + UNDO_MS } })
  await update($, autopilot, value => ({
    ...value,
    now: at,
    undo: { seq, peer: rt.peer, ids: sent, text: said.text, confidence: said.confidence, until: at + UNDO_MS },
  }))
  apStartTicker($)
  await refreshStatus($)
}

// --- undo: `u` within 30 s ---

function apStartTicker($: $): void {
  if (apTicker !== null) return
  apTicker = $.clock.every(1000, () => {
    apTick($).catch(() => {
      // A missed tick only holds the countdown one second.
    })
  })
}

async function apTick($: $): Promise<void> {
  const at = await $.clock.now()
  const state = await update($, autopilot, value => ({ ...value, now: at }))
  if (state.undo !== null && at >= state.undo.until) await apCloseUndo($, { state: 'expired' })
  if ((await read($, autopilot)).undo === null) {
    apTicker?.cancel()
    apTicker = null
  }
  await refreshStatus($)
}

async function apCloseUndo($: $, undo: ApUndo): Promise<void> {
  await update($, autopilot, value => (value.undo === null ? value : { ...value, undo: null, ledger: patchEntry(value.ledger, value.undo.seq, { undo }) }))
}

/** `u`: deletes the last auto reply with `tg delete PEER ID --yes`; the key press is the consent --yes stands for. */
async function apUndo($: $): Promise<void> {
  const undo = (await read($, autopilot)).undo
  const at = await $.clock.now()
  if (undo === null || at >= undo.until) {
    $.ui.toast('tg: nothing to undo; the 30 s window is over.')
    return
  }
  const result = await runWrite($, ['tg', 'delete', undo.peer.arg, ...undo.ids.map(String), '--yes', '--json'])
  if (result.ok) {
    await apCloseUndo($, { state: 'undone' })
    $.ui.toast(`tg: deleted the auto reply in ${undo.peer.label}.`)
  } else {
    const reason = failureText(result.failure, at)
    await apCloseUndo($, { state: 'failed', reason })
    $.ui.toast(`tg: could not delete the auto reply: ${reason}`)
  }
  await refreshStatus($)
}

// --- drafts in the band ---

async function apDraftOf($: $): Promise<ApDraft | null> {
  return (await read($, autopilot)).drafts[0] ?? null
}

async function apSetDraft($: $, seq: number, change: (draft: ApDraft) => ApDraft): Promise<void> {
  await update($, autopilot, value => ({ ...value, drafts: value.drafts.map(one => (one.seq === seq ? change(one) : one)) }))
}

/**
 * ⏎ on a draft the band shows whole: the owner has read it, so it is their own
 * write and passes --yes (decision 9); BotFather stays read-only.
 */
async function apSendDraft($: $): Promise<void> {
  const draft = await apDraftOf($)
  if (draft === null || draft.state.kind === 'sending') return
  if (isBotFather(draft.peer.arg)) {
    await apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'failed', reason: readOnlyText({ kind: 'botfather' }) } }))
    return
  }
  await apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'sending' } }))
  const rt = apRuntimes.get(draft.peer.id)
  if (rt !== undefined) rt.isSending = true
  let result: WriteResult
  try {
    result = await runWrite($, calls.reply(draft.peer.arg, true), draft.text)
  } finally {
    if (rt !== undefined) rt.isSending = false
  }
  if (!result.ok) {
    const reason = writeFailure(result, draft.peer, await $.clock.now())
    await apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'failed', reason } }))
    return
  }
  const sent = result.sent.map(one => one.id)
  for (const id of sent) rt?.sentIds.add(id)
  await update($, autopilot, value => ({
    ...value,
    drafts: value.drafts.filter(one => one.seq !== draft.seq),
    ledger: patchEntry(value.ledger, draft.seq, { reply: draft.text, outcome: { kind: 'sent', ids: sent, by: 'you' } }),
  }))
  await refreshStatus($)
}

async function apDropDraft($: $): Promise<void> {
  const draft = await apDraftOf($)
  if (draft === null) return
  await update($, autopilot, value => ({
    ...value,
    drafts: value.drafts.filter(one => one.seq !== draft.seq),
    ledger: patchEntry(value.ledger, draft.seq, { outcome: { kind: 'dropped' } }),
  }))
  await refreshStatus($)
}

/** ⏎ on a draft the band cuts short: the pane on its dialog, as `o`, and the band shows it whole; ⏎ then sends. */
async function apUnfoldDraft($: $, draft: ApDraft): Promise<void> {
  await apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'unfolded' } }))
  await apOpen($, draft.peer)
}

/** `o` on a draft or a summary: the pane, on that dialog. */
async function apOpen($: $, peer: PeerRef): Promise<void> {
  if ((await read($, mode)) === 'hidden') await setMode($, defaultMode(undefined))
  const listed = (loaded(await read($, dialogs)) ?? []).find(one => one.id === peer.id)
  await openThread($, listed ?? dialogOfPeer(peer))
}

/** The band in every mode: an undoable auto reply first (it has 30 s), then a draft, then a summary. */
async function drawAutopilotBand($: $, els: Els, width: number): Promise<RenderElement | null> {
  const hold = await drawHoldBand($, els, width) // ── delegate ──
  if (hold !== null) return hold
  const state = await read($, autopilot)
  if (state.undo !== null && state.now < state.undo.until) {
    return UndoBand(els, { undo: state.undo, now: state.now, onUndo: () => apUndo($), onDismiss: () => apCloseUndo($, { state: 'expired' }) })
  }
  const draft = state.drafts[0]
  if (draft !== undefined) {
    return DraftBand(els, {
      draft,
      more: state.drafts.length - 1,
      width,
      onSend: () => apSendDraft($),
      onUnfold: () => apUnfoldDraft($, draft),
      onEdit: () => apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'editing' } })),
      onSave: text => apSetDraft($, draft.seq, one => ({ ...one, text: text.trim() === '' ? one.text : text, state: { kind: 'ready' } })),
      onDrop: () => apDropDraft($),
      onOpen: () => apOpen($, draft.peer),
    })
  }
  const note = state.notes.at(-1)
  if (note === undefined) return null
  const dismiss = () => update($, autopilot, value => ({ ...value, notes: value.notes.filter(one => one.seq !== note.seq) }))
  return NoteBand(els, {
    note,
    width,
    onDismiss: dismiss,
    onOpen: async () => {
      await dismiss()
      await apOpen($, note.peer)
    },
  })
}

// --- the card, the ledger tab, the pane's row, the list marks ---

/** `q`: the card for the open thread's dialog, or the one at the cursor; again closes it. */
async function apToggleCard($: $): Promise<void> {
  if ((await read($, autopilot)).view.kind !== 'none') {
    await update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
    return
  }
  const peer = await watchTarget($)
  if (peer === undefined) {
    $.ui.toast('tg: put the cursor on a dialog, then press q for its autopilot card.')
    return
  }
  await update($, autopilot, value => ({
    ...value,
    dialogs: value.dialogs[String(peer.id)] === undefined ? { ...value.dialogs, [String(peer.id)]: defaultDialog(peer) } : value.dialogs,
    view: { kind: 'card', dialogId: peer.id, notice: null },
  }))
  // Fresh: an allow added in the prompt since the last read shows at once.
  loadAllow($).catch(() => {
    // loadAllow records its own failure, and the card shows it.
  })
}

async function apNotice($: $, notice: string | null): Promise<void> {
  await update($, autopilot, value => (value.view.kind === 'card' ? { ...value, view: { ...value.view, notice } } : value))
}

/** A change from the card: kept in $.state and $.store at once. */
async function apEdit($: $, dialogId: number, change: (dialog: ApDialog) => ApDialog): Promise<void> {
  const next = await update($, autopilot, value => {
    const current = value.dialogs[String(dialogId)]
    return current === undefined ? value : { ...value, dialogs: { ...value.dialogs, [String(dialogId)]: change(current) } }
  })
  await $.store.set(STORE_AUTOPILOT, next.dialogs)
}

async function apSetLevel($: $, dialog: ApDialog, level: ApLevel): Promise<void> {
  if ((level === 'auto' || level === 'delegate') && !(await apIsAllowed($, dialog.peer, true))) {
    await apNotice($, `${level} sends by itself, so ${dialog.peer.arg} must be in allow.toml first: run \`! tg allow add ${dialog.peer.arg} --yes\` in the prompt, then press ${level === 'auto' ? 3 : 4} again.`)
    return
  }
  if (level === 'delegate' && !(await dgWarned($, dialog))) return // ── delegate ── the one-time warning
  await apNotice($, null)
  await apEdit($, dialog.peer.id, one => ({ ...one, level }))
}

/** ⏎ in the card: start the dialog (auto needs allow.toml), or stop it. */
async function apToggleRun($: $, dialog: ApDialog): Promise<void> {
  const id = dialog.peer.id
  if ((await read($, autopilot)).running.includes(id)) {
    await apUnlisten($, id)
    await update($, autopilot, value => ({ ...value, running: value.running.filter(one => one !== id), phase: { ...value.phase, [String(id)]: 'listening' } }))
    $.ui.toast(`tg: autopilot off for ${dialog.peer.label}.`)
    await refreshStatus($)
    return
  }
  if ((dialog.level === 'auto' || dialog.level === 'delegate') && !(await apIsAllowed($, dialog.peer, true))) {
    await apNotice($, `Not started: ${dialog.level} needs ${dialog.peer.arg} in allow.toml. Run \`! tg allow add ${dialog.peer.arg} --yes\` in the prompt, or pick 2 draft.`)
    return
  }
  // ── delegate ── one session answers a dialog: the lease in $.store says which.
  const guardText = dialog.level === 'delegate' ? await dgGuardText($) : null
  if (guardText !== null) {
    await apNotice($, `Not started: ${guardText}`)
    return
  }
  const lease = await apTakeLease($, id)
  if (!lease.ok) {
    await apNotice($, `Not started: ${dialog.peer.label} is ${lease.reason}. Stop it there first.`)
    return
  }
  await apEdit($, id, one => one)
  await update($, autopilot, value => ({ ...value, running: [...value.running, id], view: { kind: 'none' } }))
  await apListen($, dialog.peer)
  $.ui.toast(`tg: ${LEVEL_GLYPH[dialog.level]} autopilot ${dialog.level} on for ${dialog.peer.label}. /tg stop stops every dialog.`)
  await refreshStatus($)
}

/** The kill switch: every dialog stops listening, every timer and model call is cut. */
async function apStopAll($: $): Promise<number> {
  const running = (await read($, autopilot)).running
  await Promise.all(running.map(id => apUnlisten($, id)))
  await dgStopAll($, 'kill switch') // ── delegate ──
  await update($, autopilot, value => ({ ...value, running: [], phase: {} }))
  await refreshStatus($)
  return running.length
}

/** `/tg autopilot [off]`. */
async function autopilotCommand($: $, args: string): Promise<{ text: string }> {
  if (args === 'off') {
    const stopped = await apStopAll($)
    return { text: stopped === 0 ? 'tg autopilot: nothing was running.' : `tg autopilot off: ${stopped} dialog${stopped === 1 ? '' : 's'} stopped.` }
  }
  if (args.startsWith(SKIP_FLAG)) return dgSkipCommand($, args) // ── delegate ──
  if (args !== '') return { text: `Usage: /tg autopilot [off | ${SKIP_FLAG}[=publish,delete]]` }
  const state = await read($, autopilot)
  const lines = state.running.flatMap(id => {
    const dialog = state.dialogs[String(id)]
    return dialog === undefined ? [] : [`${LEVEL_GLYPH[dialog.level]} ${dialog.peer.label}: ${dialog.level}, ${rateText(dialog.perHour)}, ${state.phase[String(id)] ?? 'listening'}`]
  })
  lines.push(...(await dgTaskLines($))) // ── delegate ──
  return { text: lines.length === 0 ? 'tg autopilot: off. Open a dialog in the pane and press q.' : ['tg autopilot:', ...lines].join('\n') }
}

/** The card or the ledger tab in place of the pane while one is open. */
async function drawAutopilotView($: $, els: Els, width: number, rows: number): Promise<RenderElement | null> {
  const state = await read($, autopilot)
  const view = state.view
  if (view.kind === 'none') return null
  const close = () => update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
  if (view.kind === 'ledger') {
    const at = await $.clock.now()
    const ledger = await dgLedger($, state.ledger, state.dialogs) // ── delegate ── with the guard's stop events
    return AutopilotLedger(els, { ledger, now: Math.max(at, state.now), rows, width, onCard: null, onClose: close })
  }
  const dialog = state.dialogs[String(view.dialogId)]
  if (dialog === undefined) return null
  const id = dialog.peer.id
  const edit = (change: (one: ApDialog) => ApDialog) => apEdit($, id, change)
  const allow = apAllowView(dialog.peer, (await read($, bottest)).allow)
  return AutopilotCard(els, {
    dialog,
    isRunning: state.running.includes(id),
    phase: state.phase[String(id)],
    allow,
    notice: view.notice,
    width,
    // ── delegate ── offered only for dialogs in allow.toml; its rows while it is the level.
    levels: (allow.kind === 'ok' && allow.isAllowed) || dialog.level === 'delegate' ? AP_LEVELS : AP_LEVELS.filter(one => one !== 'delegate'),
    extra: dialog.level === 'delegate' ? await drawDelegateRows($, els, dialog) : null,
    onLevel: level => apSetLevel($, dialog, level),
    onBrief: (field, text) => edit(one => ({ ...one, brief: { ...one.brief, [field]: text.trim() } })),
    onRate: by => edit(one => ({ ...one, perHour: stepRate(one.perHour, by) })),
    onRateText: async text => {
      const parsed = parseRate(text)
      if (!parsed.ok) return apNotice($, `"${text}" is not a rate: a whole number of replies per hour, or ∞.`)
      await apNotice($, null)
      await edit(one => ({ ...one, perHour: parsed.value }))
    },
    onGap: by => edit(one => ({ ...one, gapS: stepGap(one.gapS, by) })),
    onConf: by => edit(one => ({ ...one, threshold: stepThreshold(one.threshold, by) })),
    onTopic: (topic: ApTopic) => edit(one => ({ ...one, topics: toggleTopic(one.topics, topic) })),
    onQuiet: () => edit(one => ({ ...one, quiet: one.quiet === null ? { ...DEFAULT_QUIET } : null })),
    onQuietText: async text => {
      const parsed = parseQuiet(text)
      if (!parsed.ok) return apNotice($, `"${text}" is not a range: write it as 22:00-08:00, or off.`)
      await apNotice($, null)
      await edit(one => ({ ...one, quiet: parsed.value }))
    },
    onStart: () => apToggleRun($, dialog),
    onEditBrief: () => moveRing($, 'ap:tone'),
    onLedger: () => update($, autopilot, value => ({ ...value, view: { kind: 'ledger' } })),
    onClose: close,
  })
}

async function drawAutopilotRow($: $, els: Els): Promise<RenderElement> {
  const state = await read($, autopilot)
  return AutopilotRow(els, {
    running: state.running.length,
    drafts: state.drafts.length,
    undo: state.undo,
    now: state.now,
    onCard: () => apToggleCard($),
    onUndo: () => apUndo($),
    onStopAll: async () => {
      const stopped = await apStopAll($)
      $.ui.toast(`tg autopilot off: ${stopped} dialog${stopped === 1 ? '' : 's'} stopped.`)
    },
  })
}

/** DialogRow's level mark for running dialogs: the glyph, and `auto 3/50` (sent this hour / limit). */
async function autopilotMarks($: $): Promise<(dialogId: number) => { glyph: string; tail: string; warn?: string } | undefined> {
  const state = await read($, autopilot)
  const noStopsOf = await dgNoStopsOf($) // ── delegate ──
  const at = Math.max(state.now, await $.clock.now())
  return dialogId => {
    const dialog = state.dialogs[String(dialogId)]
    if (dialog === undefined || !state.running.includes(dialogId)) return undefined
    const tail = dialog.level === 'auto' ? `auto ${sentLastHour(state.ledger, dialogId, at)}/${dialog.perHour ?? '∞'}` : dialog.level
    const warn = dialog.level === 'delegate' ? noStopsOf(dialogId) : null // ── delegate ──
    return warn === null ? { glyph: LEVEL_GLYPH[dialog.level], tail } : { glyph: LEVEL_GLYPH[dialog.level], tail, warn }
  }
}

/** The status line: an open undo window owns it (`tg ⟳ … u undo 28s`); waiting drafts add a tail. */
async function autopilotStatus($: $): Promise<{ line: string | null; tail: string }> {
  const state = await read($, autopilot)
  const dg = await dgStatus($) // ── delegate ── a hard stop waiting outranks the undo window.
  const undo = state.undo !== null && state.now < state.undo.until ? `${undoStatus(state.undo, state.now)}${dg.tail}` : null
  const line = dg.line ?? undo
  return { line, tail: draftsTail(state.drafts) + dg.tail }
}
// ── /autopilot ──

// ── delegate ──
// Phase 4 (docs/design/dialogs-pane.md §6 "delegate"): a dialog's work handed
// to a Worker. The Speaker (the autopilot's, with start_task and forward)
// talks; the Worker, a subagent of its own type per task, works in fresh git
// worktrees and never writes to Telegram. They meet in the task card
// ($.state `delegate.tasks`): the Worker's ASK/DONE/FAIL turns go to the chat
// through the Speaker, the chat's answers reach it through session.send.
//
// The grant and the Worker's hard stops are the guard plugin's
// (mods/dialogs-pane-guard): every event of a loop this plugin spawned runs
// under this plugin's frame, and the engine runs no hook of a plugin under its
// own frame (measured live: a Worker's `git push` passed this plugin's hook
// untouched). The guard is another plugin, so its tool.call hook runs there. It
// reads the tasks, grants and skips from `delegate`, and holds a stop in the
// engine's dialog. Its steps, holds and stop events come back through its own
// $.state, drawn here. A task starts only once the guard answered for it (its
// `armed` names the task); here, the .catch refuses a Worker's call from a
// module mirror when the guard went silent or the task is over.
// The Speaker's outgoing text meets share and commit-on-behalf in apSendReply,
// held in the same dialog ($.ui.ask). dangerouslySkipHardStops skips stops by
// name (the option, the session, a dialog), each skip in the ledger. The
// leases in $.store keep a dialog to one session, at every level.
import type { ApEntry, DgDialog, DgGrant, DgStop, DgTask, DgWorktree, Delegate, GuardEvent, GuardHold, GuardWork } from '../types'
import type { Peer } from './packet/types'
import { DelegateRows, HoldBand, TaskCard, TaskRow, warningText } from './delegate/components'
import { armedOf, eventsOf, holdsOf as guardHoldsOf, workOf } from './delegate/guard'
import { CHECK_FILES, DEFAULT_DG_DIALOG, checksOf, nextWeb, parseDgDialogs, parseDuration, parseRepos, workerTools } from './delegate/grant'
import { HEARTBEAT_MS, holder, leaseKey, leaseOf } from './delegate/lease'
import { resolvePath } from './delegate/paths'
import { SKIP_FLAG, noStopsLabel, parseDialogSkip, parseSkipFlag, parseStops, skippedStops } from './delegate/skip'
import { delegateInstructions, delegateSystem, parseDelegate, relayPrompt, type DelegateSpoken, type TaskAction } from './delegate/speaker'
import { partition, stopQuestion, textHits, type StopHit } from './delegate/stops'
import {
  branchOf,
  cardLines,
  isLive,
  parseWorker,
  taskLine,
  workerAnswer,
  workerSystem,
  workerTask,
  workerType,
  worktreePath,
  type TaskView,
  type WorkerSaid,
} from './delegate/task'

const NO_DELEGATE: Delegate = { dialogs: {}, tasks: [], sessionSkip: [], alwaysSkip: [], permissionMode: null, pending: null }
const delegate = atom({ plugin: 'dialogs-pane', key: 'delegate' } as const, NO_DELEGATE)
const STORE_DELEGATE = 'delegate.dialogs'
const WORKER_PREFIX = 'dialogs-pane:worker-'
/** The dialog lists No first, so a stray Enter is a no (seen live: an Enter meant for the prompt took the first option). */
const ASK_YES = 'Yes, allow it'
const ASK_NO = 'No'
/** Steps shown in a Wide task card; finished cards stay until dismissed. */
const CARD_STEPS = 4
const CARDS_MAX = 2
/** The guard heartbeats every 10 s; three missed and it counts as gone. */
const GUARD_TTL_MS = 30_000
const GUARD = 'dialogs-pane-guard'

/** The mod option `dangerouslySkipHardStops`: stops skipped in every session, until removed. */
let alwaysSkip: DgStop[] = []
let optionProblem: string | null = null

function configureDelegate(options: PluginOptions): void {
  const value = options.dangerouslySkipHardStops
  alwaysSkip = []
  optionProblem = null
  if (typeof value !== 'string' && !Array.isArray(value)) return
  const parsed = parseStops(value)
  if (parsed.ok) alwaysSkip = parsed.stops
  else optionProblem = `dangerouslySkipHardStops: unknown stop ${parsed.unknown.join(', ')}; no stop is skipped by the option`
}

// Module state: a reload starts these over; $.state keeps the tasks.
let dgHome = '/'
let dgSession: string | null = null
let dgHeartbeat: Timer | null = null
const dgDeadlines = new Map<number, Timer>()
let dgHoldSeq = 0

/**
 * What the .catch reads when the engine asks it in the hook's place (a
 * Worker's loop runs under this plugin's frame, where its `$` calls reject):
 * the Workers' agent ids, the live tasks, spawns in flight, the guard's last
 * answer. Rebuilt on every `delegate` write and every guard read.
 */
const dgMirror = { workers: new Map<string, number>(), live: new Set<number>(), spawning: 0, isGuardFresh: false }

function dgMirrorTasks(tasks: readonly DgTask[]): void {
  dgMirror.workers = new Map(tasks.flatMap(task => (task.agentId === null ? [] : [[task.agentId, task.id] as const])))
  dgMirror.live = new Set(tasks.filter(isLive).map(task => task.id))
}

/** Why a call must be refused without the guard's word; null: let it go on to the guard. */
function dgRefuse(agentId: string | undefined): string | null {
  if (agentId === undefined) return null
  const taskId = dgMirror.workers.get(agentId)
  if (taskId === undefined) return dgMirror.spawning > 0 ? 'A Worker is starting and the guard does not have it yet: refused. Try again in a moment.' : null
  if (!dgMirror.live.has(taskId)) return 'This task is over. Stop here; end your turn.'
  if (!dgMirror.isGuardFresh) return `The ${GUARD} plugin stopped answering, so nothing guards this call: refused.`
  return null
}

/** Every write of `delegate` goes through here, so the mirror follows it. */
async function dgUpdate($: $, change: (value: Delegate) => Delegate): Promise<Delegate> {
  const next = await update($, delegate, change)
  dgMirrorTasks(next.tasks)
  return next
}

function registerDelegate(on: On): void {
  // The Worker types are the mod's own: the model is never offered them.
  on('agent.offer', ($, e, next) => (e.agent.startsWith(WORKER_PREFIX) ? { isOffered: false } : next(e))).catch(($, e, next) =>
    e.agent.startsWith(WORKER_PREFIX) ? { isOffered: false } : next(e),
  )

  // Defense in depth for the guard plugin: a Worker's call is refused here when
  // the guard went silent or its task is over. The engine asks the .catch in
  // the hook's place for a Worker (re-entry), so both read only the mirror.
  on('tool.call', ($, e, next) => {
    const refused = dgRefuse(e.agentId)
    return refused === null ? next(e) : { deny: refused }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const refused = dgRefuse(e.agentId)
    return refused === null ? next(e) : { deny: refused }
  })

  // The guard's holds change the status line, which is set, not drawn: redo it on each guard write.
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    if (e.plugin === GUARD) await refreshStatus($)
    return done
  }).catch(($, e, next) => next(e))

  // The session's permission mode, for `⚠ no stops · no permissions`: the classic
  // events carry it (classic.PreToolUse's input here is the tool envelope alone).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await dgSeeMode($, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    await dgSeeMode($, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** A Worker's turn ended (routing's turn.complete hook calls this): ASK, DONE or FAIL goes to the chat through the Speaker. */
function dgOnTurn($: $, agentId: string | undefined, reason: string, answer: string): void {
  if (agentId === undefined || !dgMirror.workers.has(agentId)) return
  dgOnWorkerTurn($, agentId, reason, answer).catch(() => {
    // dgOnWorkerTurn records its own failures on the task card.
  })
}

/** Closing the session lets go of its dialogs at once (else they free up after LEASE_TTL_MS); triage's session.end hook calls this. */
async function apReleaseAll($: $): Promise<void> {
  await Promise.all((await read($, autopilot)).running.map(id => apReleaseLease($, id)))
}

async function dgSeeMode($: $, mode: string | undefined): Promise<void> {
  if (mode === undefined) return
  const before = (await read($, delegate)).permissionMode
  if (before === mode) return
  await dgUpdate($, value => ({ ...value, permissionMode: mode }))
  await refreshStatus($)
}

/** From session.start (and a reload): settings from $.store; live tasks keep their Worker and their deadline. */
async function startDelegate($: $): Promise<void> {
  dgHome = (await $.env.get('HOME')) ?? '/'
  const dialogsStored = parseDgDialogs(await $.store.get(STORE_DELEGATE))
  const state = await dgUpdate($, value => ({ ...value, dialogs: dialogsStored, alwaysSkip }))
  await dgGuardArmed($)
  const at = await $.clock.now()
  for (const task of state.tasks.filter(isLive)) dgArmDeadline($, task, at)
  dgHeartbeat?.cancel()
  dgHeartbeat = $.clock.every(HEARTBEAT_MS, () => {
    apBeat($).catch(() => {
      // A missed beat is made up by the next; a lease lapses only after three.
    })
  })
  if (optionProblem !== null) $.ui.toast(`tg: ${optionProblem}`)
}

// --- leases: one session per dialog ---

async function apSessionId($: $): Promise<string> {
  dgSession ??= await $.session.id()
  return dgSession
}

/** Takes the dialog's lease, or says which session holds it. */
async function apTakeLease($: $, dialogId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = await apSessionId($)
  const at = await $.clock.now()
  const held = holder(leaseOf(await $.store.get(leaseKey(dialogId))), session, at)
  if (held.kind === 'other') return { ok: false, reason: `running in another session (${held.session.slice(0, 8)}, alive ${Math.round(held.ageMs / 1000)} s ago)` }
  await $.store.set(leaseKey(dialogId), { session, beat: at })
  // Two sessions taking it at the same moment: the last write stands, and the other one sees that here.
  const after = leaseOf(await $.store.get(leaseKey(dialogId)))
  return after?.session === session ? { ok: true } : { ok: false, reason: 'running in another session' }
}

async function apReleaseLease($: $, dialogId: number): Promise<void> {
  const session = await apSessionId($)
  if (leaseOf(await $.store.get(leaseKey(dialogId)))?.session === session) await $.store.delete(leaseKey(dialogId))
}

/** The dialogs a reloaded session may keep running: the ones whose lease is still its own (or free). */
async function apKeepLeases($: $, running: readonly number[]): Promise<number[]> {
  const kept: number[] = []
  for (const id of running) {
    const lease = await apTakeLease($, id)
    if (lease.ok) kept.push(id)
    else $.ui.toast(`tg: autopilot stopped for dialog ${id}: ${lease.reason}.`)
  }
  if (kept.length !== running.length) await update($, autopilot, value => ({ ...value, running: value.running.filter(id => kept.includes(id)) }))
  return kept
}

/** The heartbeat: renews this session's leases; a dialog another session took over stops here. */
async function apBeat($: $): Promise<void> {
  const session = await apSessionId($)
  const at = await $.clock.now()
  for (const id of (await read($, autopilot)).running) {
    const held = holder(leaseOf(await $.store.get(leaseKey(id))), session, at)
    if (held.kind === 'other') {
      await apUnlisten($, id)
      await update($, autopilot, value => ({ ...value, running: value.running.filter(one => one !== id) }))
      $.ui.toast(`tg: autopilot stopped for dialog ${id}: another session took it over.`)
      continue
    }
    await $.store.set(leaseKey(id), { session, beat: at })
  }
  await dgCheckDeadlines($, at)
  // A guard gone silent leaves Workers unguarded: stop them.
  const armed = await dgGuardArmed($)
  if (armed === null && (await read($, delegate)).tasks.some(isLive)) {
    await dgStopAll($, `the ${GUARD} plugin stopped answering`)
    $.ui.toast(`tg: ⚡ every Worker stopped: the ${GUARD} plugin stopped answering.`)
  }
}

// --- the guard plugin: its handshake and what it reports ---

/** The guard's last answer while it is fresh (null: not loaded, or silent past GUARD_TTL_MS). */
async function dgGuardArmed($: $): Promise<{ at: number; taskIds: number[] } | null> {
  const armed = armedOf(await dgGuardValue($, 'armed'))
  dgMirror.isGuardFresh = armed !== null && (await $.clock.now()) - armed.at <= GUARD_TTL_MS
  return dgMirror.isGuardFresh ? armed : null
}

/** The guard's steps, holds and stop events, for drawing; empty while it has written none. */
async function dgGuardView($: $): Promise<{ work: GuardWork[]; holds: GuardHold[]; events: GuardEvent[] }> {
  const [work, holds, events] = await Promise.all([dgGuardValue($, 'work'), dgGuardValue($, 'holds'), dgGuardValue($, 'events')])
  return { work: workOf(work), holds: guardHoldsOf(holds), events: eventsOf(events) }
}

/**
 * One of the guard's values: another plugin's state, which this contract does
 * not declare (declaring it here breaks the inference of every `update` call),
 * so it is read as unknown and narrowed by ./delegate/guard.
 */
async function dgGuardValue($: $, key: 'armed' | 'work' | 'holds' | 'events'): Promise<unknown> {
  // `as never`: the refs name the guard's keys, typed by its contract alone.
  switch (key) {
    case 'armed':
      return (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'armed' } as never)).value
    case 'work':
      return (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'work' } as never)).value
    case 'holds':
      return (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'holds' } as never)).value
    case 'events':
      return (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'events' } as never)).value
  }
}

function viewOf(task: DgTask, guard: { work: readonly GuardWork[]; holds: readonly GuardHold[] }): TaskView {
  return { work: guard.work.find(one => one.taskId === task.id) ?? null, holds: guard.holds.filter(hold => hold.taskId === task.id) }
}

/** The guard's stop events as ledger rows, beside the autopilot's own. */
function guardEntries(events: readonly GuardEvent[], dialogs: Record<string, ApDialog>): ApEntry[] {
  return events.map(event => ({
    seq: 1_000_000 + event.seq,
    at: event.at,
    peer: event.peer,
    level: dialogs[String(event.peer.id)]?.level ?? 'delegate',
    incoming: [],
    reply: event.summary,
    confidence: null,
    topics: [],
    checks: [],
    outcome: { kind: 'stop', stops: event.stops, what: event.what, answer: event.answer, why: event.why },
    undo: null,
  }))
}

/** The card's `guard:` row while delegate cannot start here; null once the guard answers. */
async function dgGuardText($: $): Promise<string | null> {
  return (await dgGuardArmed($)) === null ? `delegate needs the ${GUARD} plugin loaded and answering: it holds the Worker's hard stops. Enable it, then press s.` : null
}

// --- settings and the card's rows ---

async function dgSettings($: $, dialogId: number): Promise<DgDialog> {
  return (await read($, delegate)).dialogs[String(dialogId)] ?? DEFAULT_DG_DIALOG
}

async function dgEdit($: $, dialogId: number, change: (dg: DgDialog) => DgDialog): Promise<void> {
  const next = await dgUpdate($, value => ({ ...value, dialogs: { ...value.dialogs, [String(dialogId)]: change(value.dialogs[String(dialogId)] ?? DEFAULT_DG_DIALOG) } }))
  await $.store.set(STORE_DELEGATE, next.dialogs)
}

async function dgEditGrant($: $, dialogId: number, change: (grant: DgGrant) => DgGrant): Promise<void> {
  await dgEdit($, dialogId, dg => ({ ...dg, grant: change(dg.grant) }))
}

/** 4 in the card: the first time for a dialog it shows the warning and stops; the next press goes on. */
async function dgWarned($: $, dialog: ApDialog): Promise<boolean> {
  if ((await dgSettings($, dialog.peer.id)).isWarned) return true
  await dgEdit($, dialog.peer.id, dg => ({ ...dg, isWarned: true }))
  await apNotice($, warningText(dialog.peer.label))
  return false
}

/** Every stop skipped for a dialog now, from the option, the session and the dialog. */
async function dgSkipped($: $, dialogId: number): Promise<DgStop[]> {
  const state = await read($, delegate)
  return skippedStops({ always: alwaysSkip, session: state.sessionSkip, dialog: state.dialogs[String(dialogId)]?.skip ?? null, now: await $.clock.now() })
}

/** The red mark per dialog: null while every stop holds. */
async function dgNoStopsOf($: $): Promise<(dialogId: number) => string | null> {
  const state = await read($, delegate)
  const at = await $.clock.now()
  return dialogId =>
    noStopsLabel(skippedStops({ always: alwaysSkip, session: state.sessionSkip, dialog: state.dialogs[String(dialogId)]?.skip ?? null, now: at }), state.permissionMode)
}

async function drawDelegateRows($: $, els: Els, dialog: ApDialog): Promise<RenderElement> {
  const id = dialog.peer.id
  const state = await read($, delegate)
  const at = await $.clock.now()
  return DelegateRows(els, {
    guard: await dgGuardText($),
    dg: state.dialogs[String(id)] ?? DEFAULT_DG_DIALOG,
    label: dialog.peer.label,
    noStops: (await dgNoStopsOf($))(id),
    pending: state.pending?.dialogId === id ? state.pending : null,
    now: at,
    onWeb: () => dgEditGrant($, id, grant => ({ ...grant, web: nextWeb(grant.web) })),
    onCommands: () => dgEditGrant($, id, grant => ({ ...grant, commands: grant.commands === 'checks' ? 'any' : 'checks' })),
    onRepos: text => dgEditGrant($, id, grant => ({ ...grant, repos: parseRepos(text) })),
    onDuration: async text => {
      const parsed = parseDuration(text)
      if (!parsed.ok) return apNotice($, `"${text}" is not a duration: write done, 2h, 90m or 1h30m.`)
      await apNotice($, null)
      await dgEditGrant($, id, grant => ({ ...grant, duration: parsed.value }))
    },
    onSkip: async text => {
      const parsed = parseDialogSkip(text, await $.clock.now())
      if (!parsed.ok) return apNotice($, parsed.why)
      await apNotice($, null)
      // Turning stops back on needs no confirmation; turning them off does.
      if (parsed.skip === null) return dgEdit($, id, dg => ({ ...dg, skip: null }))
      const skip = parsed.skip
      await dgUpdate($, value => ({ ...value, pending: { dialogId: id, skip } }))
    },
    onConfirm: async text => {
      const pending = (await read($, delegate)).pending
      if (pending === null || pending.dialogId !== id) return
      if (text.trim() !== dialog.peer.label) return apNotice($, `Not confirmed: type the dialog's name exactly, "${dialog.peer.label}".`)
      await dgUpdate($, value => ({ ...value, pending: null }))
      await dgEdit($, id, dg => ({ ...dg, skip: pending.skip }))
      await apNotice($, null)
      $.ui.toast(`tg: ⚠ hard stops ${pending.skip.stops.join(', ')} skipped for ${dialog.peer.label}.`)
      await refreshStatus($)
    },
    onCancel: () => dgUpdate($, value => ({ ...value, pending: null })),
  })
}

/** `/tg autopilot --dangerously-skip-hard-stops[=publish,delete]` (`=none` turns them back on). */
async function dgSkipCommand($: $, args: string): Promise<{ text: string }> {
  const parsed = parseSkipFlag(args)
  if (parsed === null || !parsed.ok) return { text: `tg autopilot: unknown stop ${parsed === null ? args : parsed.unknown.join(', ')}. Stops: money, publish, share, delete, commit-on-behalf, or all; none turns them back on.` }
  await dgUpdate($, value => ({ ...value, sessionSkip: parsed.stops }))
  await refreshStatus($)
  return {
    text:
      parsed.stops.length === 0
        ? 'tg autopilot: hard stops are on again for this session.'
        : `tg autopilot: ⚠ hard stops skipped until this session ends: ${parsed.stops.join(', ')}. The kill switch and allow.toml still hold; each skipped stop is logged.`,
  }
}

// --- tasks ---

async function dgLiveTask($: $, dialogId: number): Promise<DgTask | null> {
  return (await read($, delegate)).tasks.find(task => task.peer.id === dialogId && isLive(task)) ?? null
}

async function dgPatchTask($: $, taskId: number, change: (task: DgTask) => DgTask): Promise<DgTask | null> {
  const next = await dgUpdate($, value => ({ ...value, tasks: value.tasks.map(task => (task.id === taskId ? change(task) : task)) }))
  return next.tasks.find(task => task.id === taskId) ?? null
}

const STOPPED_PLACEHOLDER: DgTask = {
  id: 0,
  peer: { id: 0, arg: '', label: '', kind: 'unknown' },
  summary: '',
  agentId: null,
  startedAt: 0,
  deadline: null,
  grant: DEFAULT_DG_DIALOG.grant,
  worktrees: [],
  holds: [],
  question: null,
  chat: null,
  status: 'stopped',
  reason: 'its task is gone',
}

/** The Speaker's task action: start a Worker, or pass the chat's answer to the running one. */
async function dgOnTaskAction($: $, peer: PeerRef, action: TaskAction, chat: { peer: Peer; burst: readonly MessageView[]; history: readonly MessageView[] }): Promise<void> {
  const packet = buildPacket({ messages: chat.burst, context: chat.history.filter(one => !chat.burst.some(b => b.id === one.id)), peer: chat.peer, intent: { id: 'raw', text: '' }, redact: false, replay: false }).text
  const live = await dgLiveTask($, peer.id)
  if (action.kind === 'forward' || live !== null) {
    if (live === null) return
    const text = action.kind === 'forward' ? action.text : action.summary
    await dgForward($, live, text, packet)
    return
  }
  // The ack goes out meanwhile: the worktrees and the spawn take seconds.
  dgStartTask($, peer, action.summary, packet).catch(() => {
    // dgStartTask marks its task failed with the reason.
  })
}

async function dgForward($: $, task: DgTask, text: string, packet: string): Promise<void> {
  if (task.agentId === null) return
  const sent = await $.session.send({ to: { agentId: task.agentId }, text: workerAnswer(text, packet) })
  if (!sent.isDelivered) {
    $.ui.toast(`tg: ⚡ the answer did not reach the Worker for ${task.peer.label}: ${sent.reason}`)
    return
  }
  await dgPatchTask($, task.id, one => ({ ...one, question: null, status: one.status === 'asking' ? 'working' : one.status }))
}

/** Starts a task: worktrees of the granted repos, a Worker type with the granted tools, the spawn, the deadline. */
async function dgStartTask($: $, peer: PeerRef, summary: string, packet: string): Promise<void> {
  const settings = await dgSettings($, peer.id)
  const grant = settings.grant
  const at = await $.clock.now()
  const state = await dgUpdate($, value => {
    const id = value.tasks.reduce((top, one) => Math.max(top, one.id), 0) + 1
    const deadline = grant.duration.kind === 'deadline' ? at + grant.duration.minutes * 60_000 : null
    const task: DgTask = { ...STOPPED_PLACEHOLDER, id, peer, summary, startedAt: at, deadline, grant, status: 'starting', reason: '' }
    return { ...value, tasks: [...value.tasks, task] }
  })
  const task = state.tasks.at(-1)
  if (task === undefined) return
  const fail = async (reason: string) => {
    await dgPatchTask($, task.id, one => ({ ...one, status: 'failed', reason }))
    $.ui.toast(`tg: ⚡ the task for ${peer.label} did not start: ${reason}`)
    await refreshStatus($)
  }
  await refreshStatus($)
  const made = await dgWorktrees($, task)
  if (!made.ok) return fail(made.reason)
  const worktrees = made.value
  if (!isLive((await dgPatchTask($, task.id, one => ({ ...one, worktrees }))) ?? STOPPED_PLACEHOLDER)) return
  // The handshake: the guard saw this write and guards the task, or nothing starts.
  const armed = await dgGuardArmed($)
  if (armed === null || !armed.taskIds.includes(task.id)) return fail(`the ${GUARD} plugin is not loaded or did not answer for this task, so nothing would hold the Worker's hard stops`)
  try {
    await $.agent.register({
      name: workerType(task.id),
      description: 'The Worker of a delegated Telegram dialog; spawned by the dialogs-pane mod only.',
      prompt: workerSystem({ grant, worktrees, deadline: task.deadline }),
      tools: workerTools(grant),
      disallowedTools: ['Agent', 'Task'],
      background: true,
    })
  } catch (error) {
    return fail(`the Worker type was refused: ${reasonOf(error)}`)
  }
  let spawned: Awaited<ReturnType<typeof $.agent.spawn>>
  dgMirror.spawning += 1
  try {
    spawned = await $.agent.spawn({
      subagentType: `${WORKER_PREFIX}${task.id}`,
      prompt: workerTask(summary, packet),
      description: `⚡ ${peer.label}: ${oneLine(summary, 40)}`,
      cwd: worktrees[0]?.path,
    })
  } catch (error) {
    dgMirror.spawning -= 1
    return fail(`the Worker did not start: ${reasonOf(error)}`)
  }
  if (spawned.deny !== undefined) {
    dgMirror.spawning -= 1
    return fail(`the Worker was refused: ${spawned.deny}`)
  }
  // Core names the agent; where it does not, the session's list does, by the Worker's type.
  const listed = spawned.agentId === undefined ? (await $.agent.list()).find(one => one.type === `${WORKER_PREFIX}${task.id}`)?.id : undefined
  const agentId = spawned.agentId ?? listed ?? null
  if (agentId === null) {
    dgMirror.spawning -= 1
    return fail('the Worker started with no local loop, so nothing here could guard it')
  }
  const started = await dgPatchTask($, task.id, one => ({ ...one, agentId, status: one.status === 'starting' ? 'working' : one.status }))
  dgMirror.spawning -= 1
  if (started !== null && !isLive(started)) {
    // Stopped while it spawned: stop the Worker too.
    await dgKillWorker($, agentId)
    return
  }
  if (started !== null) dgArmDeadline($, started, await $.clock.now())
  await refreshStatus($)
}

/** A fresh worktree per granted repo, beside tg's state; a task with no repo gets a scratch directory. */
async function dgWorktrees($: $, task: DgTask): Promise<{ ok: true; value: DgWorktree[] } | { ok: false; reason: string }> {
  const root = (await $.env.get('TG_KIT_CONFIG_DIR')) ?? `${dgHome}/.config/tg-kit`
  const out: DgWorktree[] = []
  for (const raw of task.grant.repos) {
    const repo = resolvePath(raw, dgHome, dgHome)
    const top = await dgGit($, ['git', '-C', repo, 'rev-parse', '--show-toplevel'])
    if (!top.ok) return { ok: false, reason: `${repo} is not a git repository: ${top.reason}` }
    const checkout = top.stdout.trim()
    const path = worktreePath(root, checkout, task.id)
    const branch = branchOf(task.summary, task.id)
    const made = await dgGit($, ['git', '-C', checkout, 'worktree', 'add', '-b', branch, path, 'HEAD'])
    if (!made.ok) return { ok: false, reason: `git worktree add in ${checkout}: ${made.reason}` }
    const files = await Promise.all(
      CHECK_FILES.map(async name => {
        const file = `${path}/${name}`
        if (!(await $.fs.exists(file))) return { name, text: null }
        try {
          return { name, text: await $.fs.read(file) }
        } catch {
          // Unreadable (too large, a race): counted as present with no text, so no scripts are read off it.
          return { name, text: '' }
        }
      }),
    )
    out.push({ repo: checkout, path, branch, checks: checksOf(files) })
  }
  if (out.length === 0) {
    const path = `${root}/worktrees/task-${task.id}`
    const made = await dgGit($, ['mkdir', '-p', path])
    if (!made.ok) return { ok: false, reason: `mkdir ${path}: ${made.reason}` }
    out.push({ repo: '', path, branch: '', checks: [] })
  }
  return { ok: true, value: out }
}

async function dgGit($: $, argv: readonly string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await $.process.run(argv, { timeoutMs: 60_000 })
    return result.exitCode === 0 ? { ok: true, stdout: result.stdout } : { ok: false, reason: oneLine(result.stderr.trim() || `exit ${result.exitCode}`, 160) }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

function dgArmDeadline($: $, task: DgTask, at: number): void {
  dgDeadlines.get(task.id)?.cancel()
  dgDeadlines.delete(task.id)
  if (task.deadline === null) return
  dgDeadlines.set(
    task.id,
    $.clock.after(Math.max(0, task.deadline - at), () => {
      dgStopTask($, task.id, 'the deadline passed').catch(() => {
        // The guard refuses every call past the deadline all the same.
      })
    }),
  )
}

async function dgCheckDeadlines($: $, at: number): Promise<void> {
  for (const task of (await read($, delegate)).tasks) {
    if (isLive(task) && task.deadline !== null && task.deadline <= at) await dgStopTask($, task.id, 'the deadline passed')
  }
}

async function dgKillWorker($: $, agentId: string): Promise<void> {
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: agentId })
  } catch {
    // An agent that already ended cannot be stopped; the guard refuses its calls all the same.
  }
}

/** Stops one task: the guard refuses the Worker's calls from now on, and the Worker is stopped. */
async function dgStopTask($: $, taskId: number, reason: string): Promise<void> {
  dgDeadlines.get(taskId)?.cancel()
  dgDeadlines.delete(taskId)
  const before = (await read($, delegate)).tasks.find(task => task.id === taskId)
  if (before === undefined || !isLive(before)) return
  await dgPatchTask($, taskId, task => ({ ...task, status: 'stopped', reason, holds: [] }))
  if (before.agentId !== null) await dgKillWorker($, before.agentId)
  await refreshStatus($)
}

async function dgStopTasksOf($: $, dialogId: number, reason: string): Promise<void> {
  for (const task of (await read($, delegate)).tasks) {
    if (task.peer.id === dialogId && isLive(task)) await dgStopTask($, task.id, reason)
  }
}

/** The kill switch's half: every Worker. */
async function dgStopAll($: $, reason: string): Promise<void> {
  for (const task of (await read($, delegate)).tasks) {
    if (isLive(task)) await dgStopTask($, task.id, reason)
  }
}

// --- the guard: grant, hard stops, steps ---

/** A ledger row for a hard stop: asked (yes / no and why) or skipped. */
async function dgLogStop($: $, task: DgTask, hits: readonly StopHit[], answer: 'yes' | 'no' | 'skipped', why: string): Promise<void> {
  if (hits.length === 0) return
  const dialog = await apDialog($, task.peer.id)
  await apLog($, {
    at: await $.clock.now(),
    peer: task.peer,
    level: dialog?.level ?? 'delegate',
    incoming: [],
    reply: task.summary,
    confidence: null,
    topics: [],
    checks: [],
    outcome: { kind: 'stop', stops: hits.map(hit => hit.stop), what: hits.map(hit => hit.what).join('; '), answer, why },
    undo: null,
  })
}

/**
 * Asks you about a hard stop in the engine's dialog and waits for the answer.
 * Fail closed: anything but "Yes" (No, free text, a dismissal, `-p`) is no.
 */
async function dgAskStop($: $, task: DgTask, hits: readonly StopHit[], who: string): Promise<{ yes: boolean; why: string }> {
  dgHoldSeq += 1
  const id = dgHoldSeq
  const since = await $.clock.now()
  await dgPatchTask($, task.id, one => ({ ...one, holds: [...one.holds, { id, stops: hits.map(hit => hit.stop), what: hits.map(hit => hit.what).join('; '), since }] }))
  await refreshStatus($)
  let answer: string
  try {
    answer = await $.ui.ask(stopQuestion(hits, who), { options: [ASK_NO, ASK_YES], header: 'HARD STOP' })
  } catch (error) {
    answer = `(no answer: ${reasonOf(error)})`
  }
  const after = await dgPatchTask($, task.id, one => ({ ...one, holds: one.holds.filter(hold => hold.id !== id) }))
  await refreshStatus($)
  const at = await $.clock.now()
  // A task stopped meanwhile (the kill switch, its card, the deadline) is a no, whatever was answered.
  if (after !== null && !isLive(after)) return { yes: false, why: `the task was ${after.status} while it waited (${after.reason})` }
  if (after !== null && after.deadline !== null && after.deadline <= at) return { yes: false, why: 'the deadline passed while it waited' }
  return answer === ASK_YES ? { yes: true, why: 'you' } : { yes: false, why: answer === ASK_NO ? 'you' : answer }
}


/**
 * The Speaker's text in a delegate dialog, right before it is sent: share and
 * commit-on-behalf ask you (a skipped one is logged). Null: send it; else why
 * it becomes a draft.
 */
async function dgOutgoing($: $, peer: PeerRef, text: string, seq: number | null): Promise<string | null> {
  const dialog = await apDialog($, peer.id)
  if (dialog?.level !== 'delegate') return null
  const split = partition(textHits(text), await dgSkipped($, peer.id))
  const task = (await dgLiveTask($, peer.id)) ?? { ...STOPPED_PLACEHOLDER, peer, summary: `reply in ${peer.label}` }
  await dgLogStop($, task, split.skipped, 'skipped', 'dangerouslySkipHardStops')
  if (split.ask.length === 0) return null
  const answer = await dgAskStop($, task, split.ask, `reply in ${peer.label}`)
  await dgLogStop($, task, split.ask, answer.yes ? 'yes' : 'no', answer.why)
  if (answer.yes) return null
  const reason = `HARD STOP ${split.ask.map(hit => hit.stop).join(' + ')}: not sent (${answer.why})`
  if (seq !== null) await apPatch($, seq, { topics: [] })
  return reason
}

/** A message the Speaker sent for a dialog with a running task: the card's `chat:` line. */
async function dgOnSent($: $, dialogId: number, text: string, at: number): Promise<void> {
  const task = await dgLiveTask($, dialogId)
  if (task !== null) await dgPatchTask($, task.id, one => ({ ...one, chat: { text, at } }))
}

/** A Worker's turn ended: the card follows ASK / DONE / FAIL, and the Speaker tells the chat. */
async function dgOnWorkerTurn($: $, agentId: string, reason: string, answer: string): Promise<void> {
  const task = (await read($, delegate)).tasks.find(one => one.agentId === agentId)
  if (task === undefined || !isLive(task)) return
  if (reason !== 'answer') {
    await dgPatchTask($, task.id, one => ({ ...one, status: 'failed', reason: `the Worker's turn ended: ${reason}` }))
    $.ui.toast(`tg: ⚡ the Worker for ${task.peer.label} stopped: ${reason}.`)
    await refreshStatus($)
    return
  }
  const said = parseWorker(answer)
  if (said.kind !== 'ask') {
    dgDeadlines.get(task.id)?.cancel()
    dgDeadlines.delete(task.id)
  }
  const after = await dgPatchTask($, task.id, one =>
    said.kind === 'ask'
      ? { ...one, status: 'asking', question: said.text }
      : { ...one, status: said.kind === 'done' ? 'done' : 'failed', reason: said.text, question: null },
  )
  await refreshStatus($)
  if (after !== null) await dgRelay($, after, said)
}

/** The Speaker phrases the Worker's question or result for the chat; it goes out as an auto reply would, or waits as a draft. */
async function dgRelay($: $, task: DgTask, said: WorkerSaid): Promise<void> {
  const dialog = await apDialog($, task.peer.id)
  if (dialog === null) return
  const history = await runTg($, tg.read(task.peer.arg, { limit: HISTORY_LIMIT }))
  const messages = history.ok ? history.value : []
  const peer = peerOf(task.peer, loaded(await read($, dialogs)) ?? [])
  const packet = buildPacket({ messages: messages.slice(-1), context: messages.slice(0, -1), peer, intent: { id: 'raw', text: '' }, redact: false, replay: false }).text
  const result = await $.model.complete({ model: speakerModel, system: delegateSystem(dialog), prompt: relayPrompt({ said, task, packet }), maxTokens: SPEAKER_MAX_TOKENS, timeoutMs: SPEAKER_TIMEOUT_MS })
  const at = await $.clock.now()
  const incoming = [{ id: 0, text: `Worker ${said.kind.toUpperCase()}: ${said.text}` }]
  const spoken = result.isAnswered ? parseSpoken(result.text) : null
  if (spoken === null || spoken.text === '') {
    const why = result.isAnswered ? 'the Speaker answered in a shape the autopilot cannot read' : modelFailure(result)
    await apLog($, { at, peer: task.peer, level: dialog.level, incoming, reply: '', confidence: null, topics: [], checks: [], outcome: { kind: 'failed', reason: why }, undo: null })
    $.ui.toast(`tg: ⚡ could not tell ${task.peer.label} what the Worker said: ${why}`)
    return
  }
  const seq = await apLog($, { at, peer: task.peer, level: dialog.level, incoming, reply: spoken.text, confidence: spoken.confidence, topics: spoken.topics, checks: [], outcome: { kind: 'working' }, undo: null })
  const toDraft = async (reasons: string[]) => {
    const draft: ApDraft = { seq, peer: task.peer, incoming: incoming[0]?.text ?? '', text: spoken.text, confidence: spoken.confidence, reasons, state: { kind: 'ready' } }
    await update($, autopilot, value => ({ ...value, drafts: putDraft(value.drafts, draft), ledger: patchEntry(value.ledger, seq, { outcome: { kind: 'drafted', reasons } }) }))
    await refreshStatus($)
  }
  if (said.kind === 'fail') return toDraft([`the task failed: ${oneLine(said.text, 60)}`])
  const action = spoken.action === 'reply' || spoken.action === 'draft' || spoken.action === 'escalate' ? spoken.action : 'draft'
  const verdict = gate(dialog, { ...spoken, action }, {
    sentLastHour: sentLastHour((await read($, autopilot)).ledger, task.peer.id, at),
    minutes: localMinutes(at),
    isAllowed: await apIsAllowed($, task.peer),
  })
  if (verdict.kind === 'draft') return toDraft(verdict.reasons)
  const stopped = await dgOutgoing($, task.peer, spoken.text, seq)
  if (stopped !== null) return toDraft([stopped])
  const rt = apRuntimes.get(task.peer.id)
  if (rt !== undefined) rt.isSending = true
  let sent: WriteResult
  try {
    sent = await runWrite($, calls.reply(task.peer.arg), spoken.text)
  } finally {
    if (rt !== undefined) rt.isSending = false
  }
  const done = await $.clock.now()
  if (!sent.ok) return toDraft([writeFailure(sent, task.peer, done)])
  const ids = sent.sent.map(one => one.id)
  for (const id of ids) rt?.sentIds.add(id)
  await dgPatchTask($, task.id, one => ({ ...one, chat: { text: spoken.text, at: done } }))
  await update($, autopilot, value => ({
    ...value,
    now: done,
    ledger: patchEntry(value.ledger, seq, { outcome: { kind: 'sent', ids, by: 'auto' }, undo: { state: 'open', until: done + UNDO_MS } }),
    undo: { seq, peer: task.peer, ids, text: spoken.text, confidence: spoken.confidence, until: done + UNDO_MS },
  }))
  apStartTicker($)
  await refreshStatus($)
}

// --- what shows: task cards, the band, the status line ---

/** The status line: a hard stop waiting owns it; running tasks and skipped stops add a tail. */
async function dgStatus($: $): Promise<{ line: string | null; tail: string }> {
  const state = await read($, delegate)
  const guard = await dgGuardView($)
  const live = state.tasks.filter(isLive)
  const held = live.flatMap(task => holdsOfView(task, guard).map(hold => ({ task, hold })))[0]
  const line = held === undefined ? null : `tg ⏸ HARD STOP ${held.hold.stops.join(' + ')}: ${oneLine(held.hold.what, 50)} · ⚡ ${held.task.peer.label} · answer in the dialog`
  const pilot = await read($, autopilot)
  const noStopsOf = await dgNoStopsOf($)
  const marks = pilot.running.filter(id => pilot.dialogs[String(id)]?.level === 'delegate').map(noStopsOf)
  const noStops = marks.find((one): one is string => one !== null)
  const tasks = live.length === 0 ? '' : ` · ⚡ ${live.length} task${live.length === 1 ? '' : 's'}`
  return { line, tail: `${tasks}${noStops === undefined ? '' : ` · ${noStops}`}` }
}

/** A task's waiting stops: the Speaker's (on the task) and the Worker's (the guard's). */
function holdsOfView(task: DgTask, guard: { holds: readonly GuardHold[] }): { stops: readonly string[]; what: string }[] {
  return [...task.holds, ...guard.holds.filter(hold => hold.taskId === task.id)]
}

async function drawHoldBand($: $, els: Els, width: number): Promise<RenderElement | null> {
  const guard = await dgGuardView($)
  for (const task of (await read($, delegate)).tasks.filter(isLive)) {
    const hold = holdsOfView(task, guard)[0]
    if (hold !== undefined) return HoldBand(els, { label: task.peer.label, stops: hold.stops, what: hold.what, width })
  }
  return null
}

/** Task cards under the autopilot row: Wide draws the card, Compact one line per running task. */
async function drawTaskCards($: $, els: Els, width: number, kind: 'wide' | 'compact'): Promise<{ elements: RenderElement[]; rows: number }> {
  const state = await read($, delegate)
  if (state.tasks.length === 0) return { elements: [], rows: 0 }
  const guard = await dgGuardView($)
  const live = state.tasks.filter(isLive)
  const stop = (task: DgTask) => () => dgStopTask($, task.id, 'stopped from the task card')
  const noStopsOf = await dgNoStopsOf($)
  if (kind === 'compact') {
    const rows = live.slice(0, CARDS_MAX).map(task => TaskRow(els, { task, view: viewOf(task, guard), noStops: noStopsOf(task.peer.id), onStop: stop(task) }))
    return { elements: rows, rows: rows.length }
  }
  const shown = [...live, ...state.tasks.filter(task => !isLive(task)).reverse()].slice(0, CARDS_MAX)
  const at = await $.clock.now()
  const elements = shown.map(task =>
    TaskCard(els, {
      task,
      view: viewOf(task, guard),
      now: at,
      width,
      rows: CARD_STEPS,
      noStops: noStopsOf(task.peer.id),
      onStop: stop(task),
      onDismiss: () => dgUpdate($, value => ({ ...value, tasks: value.tasks.filter(one => one.id !== task.id) })),
    }),
  )
  // Border (2) and header (1), then one row a line of the card.
  const rows = shown.reduce((sum, task) => sum + 3 + cardLines(task, viewOf(task, guard), CARD_STEPS).length, 0)
  return { elements, rows }
}

/** One line per task for `/tg autopilot`. */
async function dgTaskLines($: $): Promise<string[]> {
  const guard = await dgGuardView($)
  return (await read($, delegate)).tasks.filter(isLive).map(task => taskLine(task, viewOf(task, guard)))
}

/** The ledger tab: the autopilot's rows and the guard's stop events, in time order. */
async function dgLedger($: $, ledger: readonly ApEntry[], dialogs: Record<string, ApDialog>): Promise<ApEntry[]> {
  const events = guardEntries((await dgGuardView($)).events, dialogs)
  return [...ledger, ...events].sort((a, b) => a.at - b.at)
}
// ── /delegate ──
