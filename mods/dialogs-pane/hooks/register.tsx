// Dialogs Pane: Telegram chats and threads in a pane, read through the `tg`
// CLI. The pane lays itself out for where the engine seats it (dock or
// inline); Hidden is the pane closed (status line + band).
// Design: docs/design/dialogs-pane.md, and docs/design/dialogs-pane-ux.md §3,
// §4 and §7 for the frame, the keys (./ui/keys) and the menu.
//
// Every function that takes `$` lives in this file: the engine follows `$`
// only into functions declared beside the hook. ./ui and ./tg stay pure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register, RenderElement, Timer } from 'claude-code'

import type {
  Load,
  Mode,
  PeerRef,
  Summary,
  TgDialog,
  TgFailure,
  WatchHealth,
} from '../types'
import { SummaryBlock, watchMark } from './triage/components'
import { EMPTY_TRIAGE, RECENT, applyToDialogs, applyToMessages, repliesToYou, reportReply } from './triage/live'
import { NO_ME, RANK_SYSTEM, parseMe, parseVerdicts, pruneVerdicts, rankPrompt, toAsk, verdictKey, type Me } from './triage/needs'
import { SUMMARY_LIMIT, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS, TRIAGE_MODEL, summaryPrompt } from './triage/summary'
import { MAX_WATCHED, parseWatched } from './triage/watch'
// ── routing ──
import type { AgentInfo, HookStream, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { BroadcastRow, LedgerEntry, Leg, Overlay, Pin, PinWatch, Recipient, RadarEntry, ReplyDraft, RouteIntent, SenderClass, SheetStep, TgMessage } from '../types'
import { buildPacket, type Packet } from './packet/build'
import { expandReplyChain } from './packet/expand'
import { Redactor, redactMessage } from './packet/redact'
import { BroadcastPicker, Inspect, SendSheet, TargetList } from './routing/components'
import {
  addEntry,
  addNewLeg,
  broadcastRows,
  dialogOfPeer,
  draftArgv,
  draftOf,
  feedPin,
  intentLabel,
  legsOf,
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
} from './routing/route'
import {
  CLASS_LABEL,
  SHEET_INTENTS,
  bandIntent,
  inspectView,
  isRemembered,
  legSplit,
  rememberedWith,
  senderClass,
  mainLegIntent,
  nextLegIntent,
  parseLastIntents,
  ringedIntent,
  setClass,
  sheetIntent,
  sheetTitle,
  targetText,
  type LastIntents,
} from './routing/sheet'
import { restartPlan, watchArgv, watchLines, type WatchEvent } from './watch/watch'
// ── /routing ──
import { TG_TIMEOUT_MS, failureOf, settle, tg, type TgRequest, type TgResult } from './tg/tg'
import { DialogRow, DraftCard, Divider, EmptyList, LoadState, MessageCard, edgeStart, windowAt, type Els } from './ui/components'
import { draftKey, draftViews, fitsRow, keptCursor, rowHeight, threadRowKey, threadRows, windowCount, windowStart, type DraftRef, type DraftView, type ThreadRow } from './ui/drafts'
import { BandItemView, CommandCard, type BandActions } from './ui/band'
import { ActionBar, DigitKeys, Frame, Header, HiddenKeys, Menu, NoticeRow, Strip, StrayKeys, hotkeysIn, marksLead, stripRight } from './ui/frame'
import {
  BAR_GAP,
  CHAT_KIND_LABEL,
  STRAY_KEYS,
  strayText,
  actionBar,
  chatKind,
  helpLines,
  hiddenKeys,
  menu as menuSections,
  type ChatKind,
  type CardFacts,
  type KeyContext,
  type RunKey,
  type Seat,
  type Where,
} from './ui/keys'
import {
  GLYPH,
  NO_SELECTION,
  TOKEN,
  clamp,
  dialogLabel,
  grownDialog,
  loaded,
  oneLine,
  peerArg,
  rangeSelect,
  selectWhole,
  stateSummary,
  toggleSelected,
} from './ui/model'
import {
  NOTHING_ON_SCREEN,
  bandQueue,
  footerLabel,
  draftFits,
  hintTail,
  itemLine,
  shownIndex,
  statusAlarm,
  stepKey,
  unreadChats,
  type BandHold,
  type BandItem,
  type OnScreen,
  type UnreadHead,
} from './ui/queue'

type $ = EngineInterface

const PANE = 'tg'
/** This plugin's name, as the engine stamps its prompts (`origin.name`). */
const PLUGIN = 'dialogs-pane'
const STORE_MODE = 'mode'
// Watched dialogs and the open thread are live through `tg watch` (triage);
// this slow poll keeps the unread counts of everything else.
const POLL_MS = 300_000
const THREAD_LIMIT = 30
/** What the pane asks for: the dock's width, the inline block's rows. Each seat ignores the other. */
const DOCK_COLUMNS = 64
const INLINE_ROWS = 12
const MODES: readonly Mode[] = ['open', 'hidden']
/**
 * The pane's one open call, shared: opening an id that is open already resets
 * its title and options, so every place that opens it (setMode, and taking the
 * keys back after the engine's dialog) passes these.
 */
const PANE_OPEN = { id: PANE, title: 'tg · dialogs', focus: true, columns: DOCK_COLUMNS, rows: INLINE_ROWS } as const

const isMode = (value: unknown): value is Mode => MODES.some(one => one === value)

const mode = atom({ plugin: 'dialogs-pane', key: 'mode' } as const, 'open')
const nav = atom({ plugin: 'dialogs-pane', key: 'nav' } as const, {
  view: 'dialogs',
  // All chats until the folder list says which folder is Telegram's first (§4.7).
  list: { kind: 'folder', id: 0 },
  query: '',
  dialogCursor: 0,
  messageCursor: 0,
  folderCursor: 0,
  dialogStart: 0,
  messageStart: 0,
  folderStart: 0,
  isMenuOpen: false,
  isSearching: false,
})
const dialogs = atom({ plugin: 'dialogs-pane', key: 'dialogs' } as const, { status: 'idle' })
const thread = atom({ plugin: 'dialogs-pane', key: 'thread' } as const, null)
const selection = atom({ plugin: 'dialogs-pane', key: 'selection' } as const, NO_SELECTION)
const band = atom({ plugin: 'dialogs-pane', key: 'band' } as const, null)
const queue = atom({ plugin: 'dialogs-pane', key: 'queue' } as const, { at: null, dismissed: [], notified: [] })
const now = atom({ plugin: 'dialogs-pane', key: 'now' } as const, 0)

export const register: Register = (on, options) => {
  configureAutopilot(options) // ── autopilot ──
  registerAutopilot(on) // ── autopilot ──
  configureDelegate(options) // ── delegate ──
  registerDelegate(on) // ── delegate ──
  registerTriage(on)
  registerBottest(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tg',
      description: 'Telegram pane: chats, send to Claude, bots, agents · /tg stop · /tg status · /tg help',
      argumentHint: '[hide|stop|status|help|autopilot [off|--dangerously-skip-hard-stops[=stops]]]',
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
    // Hidden keeps its status line fresh until the pane is first opened; from then on the passes do (── folders ──).
    $.clock.every(POLL_MS, () => {
      poll($).catch(() => {
        // A failed poll leaves the last status line; the next one retries.
      })
    })
    if ((await read($, mode)) === 'hidden') {
      loadLatest($).catch(() => {
        // The status line stays at `tg …` until the first poll lands.
      })
    }
    const started = await next(e)
    await startFolders($) // ── folders ──
    await startRouting($) // ── routing ──
    await startTriage($)
    await startAutopilot($) // ── autopilot ──
    await startDelegate($) // ── delegate ──
    return started
  })

  on('command.run', { command: 'tg' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'autopilot' || asked.startsWith('autopilot ')) return autopilotCommand($, asked.slice('autopilot'.length).trim()) // ── autopilot ──
    if (asked === 'stop') return { text: stopAnswer(await stopEverything($)) } // ── running ── the kill switch
    // §4.4: the key table and what runs, as cards in the transcript (the CommandOutput hook below).
    if (asked === 'help') return { text: helpLines().join('\n') }
    if (asked === 'status') return { text: (await statusLines($)).join('\n') }
    // The layout follows the seat (design decision 4): `wide` and `compact` stay as
    // aliases of `/tg`, `hidden` of `/tg hide`.
    const isHide = asked === 'hide' || asked === 'hidden'
    if (!isHide && asked !== '' && asked !== 'wide' && asked !== 'compact') return { text: 'Usage: /tg [hide|stop|status|help|autopilot]' }
    await setMode($, isHide ? 'hidden' : 'open')
    if (!isHide) await ringCursor($)
    // Hidden needs the list too: its status line counts the unread. Once a pass is held, it counts that.
    if (isHide && passHeld === null && (await read($, dialogs)).status !== 'ok') {
      loadLatest($).catch(() => {
        // loadLatest records its own failures in state; nothing is left to report.
      })
    }
    return { text: isHide ? 'tg pane hidden: status line only. /tg opens it.' : 'tg pane open. m lists every key.' }
  })

  // The person closing the pane by hand (✕, ctrl+x x) leaves the status line: Hidden.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (e.origin.kind === 'person') {
      await update($, mode, () => 'hidden')
      await $.store.set(STORE_MODE, 'hidden')
      await refreshStatus($)
      await syncWatches($)
      await armNext($) // ── folders ── every 5 min while hidden
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
    // ── footer ── the band skips what the pane draws, and the dock draws the open chat under Chats.
    lastSeat = e.props.placement
    return drawPane($, $.ui.resolve(e), {
      seat: e.props.placement,
      width: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      isFocused: e.props.isFocused,
    })
  })

  // ── footer ── dialogs-pane-ux.md §4.1, §4.5, §8 T5: the band, the footer label,
  // the hint tail, /tg help and /tg status as cards. A packet's transcript row stays whole (decision 10).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const drawn = await drawBand($, $.ui.resolve(e), e.props.bodyColumns)
    return drawn ?? next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) =>
    next({ ...e, props: { ...e.props, modes: [...e.props.modes, await footerText($)] } }),
  )

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const tail = hintTail((await bandNow($)).length, (await summaryCounts($)).forYou)
    if (tail === undefined) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail === undefined ? tail : `${e.props.tail} · ${tail}` } })
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'tg' } }, async ($, e, next) => {
    const asked = e.props.args.trim()
    if (e.props.isErrored || (asked !== 'help' && asked !== 'status')) return next(e)
    // The row's text comes under the plugin's name (`dialogs-pane: tg status`, seen live): the card's title is the command's own.
    return CommandCard($.ui.resolve(e), e.props.text.replace(`${PLUGIN}: `, ''))
  })
  // ── /footer ──

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
    const drafted = closed.map(entry => draftOf(entry, answer, at)).findLast(one => one !== null)
    if (drafted !== undefined && drafted !== null) {
      // A row of its chat after the newest message the thread has (§8 T3), checked by the guard as it lands.
      const landed = { ...drafted, after: await newestIn($, drafted.peer.id, drafted.replyTo) }
      await keepThreadCursor($, () => update($, draft, () => landed))
      await checkDraft($)
    }
    return done
  })

  // The dialogs pinned to main reach it every turn as one context block.
  on('prompt.context', async ($, e, next) => {
    const done = await next(e)
    const peers = await knownDialogs($)
    const text = pinnedContext(await read($, pins), peers, await read($, isRedacted))
    return text === null ? done : { ...done, blocks: [...done.blocks, { name: 'tgPinned', text }] }
  })
  // ── /routing ──
}

// --- tg through $.process.run ---

async function runTg<T>($: $, req: TgRequest<T>): Promise<TgResult<T>> {
  let result: TgResult<T>
  try {
    result = settle(req, await $.process.run(req.argv, { timeoutMs: TG_TIMEOUT_MS }))
  } catch {
    // The run rejects when tg cannot start or outlives the timeout; settle
    // reports both as `missing`, which the pane explains.
    result = settle(req, undefined)
  }
  await seeLogin($, result) // ── footer ──
  return result
}

// --- open or hidden, kept in $.store across sessions ---

/**
 * Open asks for the dock's width and the inline block's rows at once: the
 * engine seats the pane and each seat ignores the other's size. Hidden closes
 * it and leaves the status line and band.
 */
async function setMode($: $, next: Mode): Promise<void> {
  await update($, mode, () => next)
  await $.store.set(STORE_MODE, next)
  if (next === 'hidden') {
    await $.ui.close({ id: PANE })
    await armNext($) // ── folders ── every 5 min while hidden
  } else {
    await $.ui.open(PANE_OPEN)
    await openFolders($) // ── folders ──
  }
  await refreshStatus($)
  await syncWatches($)
}

/**
 * The status line holds alarms only (§4.1, §4.5): a hard stop waiting, stops
 * skipped while delegate runs, not logged in; anything else clears it. A hard
 * stop that starts waiting is also a native notification, once, for an owner
 * in another window. Called after every change any of them reads.
 */
async function refreshStatus($: $): Promise<void> {
  const alarms = await dgAlarms($) // ── delegate ──
  await notifyHolds($, alarms.holds)
  const text = statusAlarm({ hold: alarms.line, noStops: alarms.noStops, isLoggedOut })
  // The status line is set, not drawn: write it only when it changes (the undo window ticks every second).
  if (lastStatus !== undefined && lastStatus.text === text) return
  lastStatus = { text }
  $.ui.status(text)
}

/** Before the pane is first opened, the footer's count reads `tg dialogs`; after it, the passes (── folders ──). */
async function poll($: $): Promise<void> {
  if ((await read($, mode)) === 'hidden' && !(await read($, folders)).pass.hasOpened) await loadLatest($, { isQuiet: true })
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

/** The latest chats (`tg dialogs`), for the footer's count and the band before the pane is first opened. */
async function loadLatest($: $, options: { isQuiet?: boolean } = {}): Promise<void> {
  const before = loaded(await read($, dialogs))
  // A quiet reload keeps the list on screen instead of the loading rows.
  if (options.isQuiet !== true || before === undefined) await update($, dialogs, () => ({ status: 'loading' }))
  const result = await runTg($, tg.dialogs())
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!result.ok) {
    await update($, dialogs, () => failed(result.failure, at))
    if (result.failure.kind === 'flood') await retryAfterFlood($, result.failure.seconds, () => loadLatest($))
    await refreshStatus($)
    return
  }
  // The pane opened meanwhile: the list is its view now, not the latest chats.
  if ((await read($, folders)).pass.hasOpened) return
  await update($, dialogs, () => ({ status: 'ok', value: result.value.map(cutRow) }))
  if (before !== undefined) await raiseGrown($, before, result.value)
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
  await ringCursor($)
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
  // The cursor on the newest message; the chat's drafts wait after it (§8 T3).
  const items = await threadItems($)
  await update($, nav, value => ({ ...value, messageCursor: Math.max(0, items.findLastIndex(item => item.kind === 'message')) }))
}

/** `g`: the open chat again; on a list, what waits applies at once and a pass runs or queues (§8 T9). */
async function reload($: $): Promise<void> {
  const open = await read($, thread)
  if ((await read($, nav)).view === 'thread' && open !== null) {
    await update($, thread, () => ({ peer: open.peer, load: { status: 'loading' } }))
    await loadThread($, open.peer)
    return
  }
  await reloadList($) // ── folders ──
}

// --- the cursor and the ring ---

async function threadMessages($: $) {
  const open = await read($, thread)
  return open === null ? [] : (loaded(open.load) ?? [])
}

/** The chat under the cursor in Chats or For you; none on an agent's row. */
async function cursorDialog($: $): Promise<TgDialog | undefined> {
  const row = await cursorRow($)
  return row?.kind === 'chat' ? row.dialog : undefined
}

/** The open chat's thread as drawn: its messages, and its drafts as rows after the message each followed (§8 T3). */
async function threadItems($: $): Promise<ThreadRow[]> {
  const open = await read($, thread)
  if (open === null) return []
  return threadRows(await threadMessages($), (await draftViewsNow($)).filter(one => one.peer.id === open.peer.id))
}

/** The thread's row under the cursor: a message or a draft. */
async function cursorItem($: $): Promise<ThreadRow | undefined> {
  const items = await threadItems($)
  return items[clamp((await read($, nav)).messageCursor, items.length)]
}

/** The message under the cursor; none while the cursor is on a draft. */
async function cursorMessage($: $): Promise<TgMessage | undefined> {
  const item = await cursorItem($)
  return item?.kind === 'message' ? item.message : undefined
}

/** The cursor sits on the thread's last row, and it is a message: new messages take it along. */
async function isOnNewest($: $): Promise<boolean> {
  const items = await threadItems($)
  const cursor = (await read($, nav)).messageCursor
  return items.length === 0 || (cursor >= items.length - 1 && items.at(-1)?.kind === 'message')
}

/** The cursor onto the thread's last row (after isOnNewest said it was there). */
async function toNewest($: $): Promise<void> {
  const count = (await threadItems($)).length
  await update($, nav, value => ({ ...value, messageCursor: Math.max(0, count - 1) }))
}

/**
 * How many rows each list's window showed when last drawn: a move scrolls the
 * window by the same rule the drawing uses. The module's own, as it is a fact
 * of the last drawing rather than state; a reload starts it over at 0, which
 * the next drawing corrects. The thread's are terminal rows, with each of its
 * rows' heights: a draft takes its whole text (./ui/drafts).
 */
const windowRows = { dialogs: 0, messages: 0, folders: 0 }
let threadHeights: number[] = []

/**
 * The cursor of one list moved by a step: its window start is first settled
 * where the drawing put it (a jump may have moved the cursor without it), then
 * moved only if the cursor leaves the window.
 */
function cursorTo(value: Nav, list: 'dialogs' | 'messages' | 'folders', cursor: number, length: number): Nav {
  const rows = windowRows[list]
  if (list === 'dialogs') {
    const drawn = edgeStart(value.dialogStart, value.dialogCursor, rows, length)
    return { ...value, dialogCursor: cursor, dialogStart: edgeStart(drawn, cursor, rows, length) }
  }
  if (list === 'folders') {
    const drawn = edgeStart(value.folderStart, value.folderCursor, rows, length)
    return { ...value, folderCursor: cursor, folderStart: edgeStart(drawn, cursor, rows, length) }
  }
  const heights = Array.from({ length }, (_, index) => threadHeights[index] ?? 1)
  const drawn = windowStart(value.messageStart, value.messageCursor, heights, rows)
  return { ...value, messageCursor: cursor, messageStart: windowStart(drawn, cursor, heights, rows) }
}

/** Moves the cursor in the active list; answers the key of the row it lands on. */
async function moveCursor($: $, by: number): Promise<string | undefined> {
  const view = (await read($, nav)).view
  if (view === 'folders') {
    const items = await folderItems($)
    const moved = await update($, nav, value => cursorTo(value, 'folders', clamp(value.folderCursor + by, items.length), items.length))
    return items[moved.folderCursor]?.key
  }
  if (view === 'dialogs') {
    const list = await listRows($)
    const moved = await update($, nav, value => cursorTo(value, 'dialogs', clamp(value.dialogCursor + by, list.length), list.length))
    const row = list[moved.dialogCursor]
    return row === undefined ? undefined : rowKey((await read($, folders)).gen, row)
  }
  const items = await threadItems($)
  const moved = await update($, nav, value => cursorTo(value, 'messages', clamp(value.messageCursor + by, items.length), items.length))
  const item = items[moved.messageCursor]
  return item === undefined ? undefined : threadRowKey(item)
}

async function followRing($: $, element: string): Promise<void> {
  const [kind, raw] = element.split(':')
  // The ring only reaches drawn rows: the window holds where it was drawn, as for j and k.
  if (kind === 'dialog' || kind === 'fy') {
    const gen = (await read($, folders)).gen
    const list = await listRows($)
    const index = list.findIndex(row => rowKey(gen, row) === element)
    if (index >= 0) await update($, nav, value => ({ ...cursorTo(value, 'dialogs', index, list.length), view: 'dialogs' }))
  } else if (kind === 'folder') {
    const items = await folderItems($)
    const index = items.findIndex(item => item.key === element)
    if (index >= 0) await update($, nav, value => ({ ...cursorTo(value, 'folders', index, items.length), view: 'folders' }))
  } else if (kind === 'msg' || kind === 'draft') {
    const items = await threadItems($)
    const index = items.findIndex(item => threadRowKey(item) === element)
    if (index >= 0) await update($, nav, value => ({ ...cursorTo(value, 'messages', index, items.length), view: 'thread' }))
  } else if (kind === 'act') {
    await followActivity($, Number(raw)) // ── running ──
  }
}

async function moveRing($: $, key: string): Promise<void> {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // The ring is a convenience: the cursor already moved, and the keys act on
    // the cursor, so a ring that cannot move (the pane does not hold the keys,
    // a surface without one) degrades only ⏎, which acts where the ring is.
  }
}

/** The ring back on the cursor row (design §3.3), after any action that drew rows over it. */
async function ringCursor($: $): Promise<void> {
  const where = await underWhere($)
  if (where === 'activity') {
    await ringActivity($) // ── running ──
  } else if (where === 'chat') {
    const item = await cursorItem($)
    if (item !== undefined) await moveRing($, threadRowKey(item))
  } else if (where === 'folders') {
    const items = await folderItems($)
    const item = items[clamp((await read($, nav)).folderCursor, items.length)]
    if (item !== undefined) await moveRing($, item.key)
  } else if (where === 'chats' || where === 'foryou') {
    const row = await cursorRow($)
    if (row !== undefined) await moveRing($, rowKey((await read($, folders)).gen, row))
  }
}

/** ⏎ on a row of Chats or For you: a chat opens, and what waits applies first (§8 T9); an agent's row does its own. */
async function openAtCursor($: $): Promise<void> {
  const row = await cursorRow($)
  if (row?.kind === 'agent') return pressAgentRow($, row.item)
  if (row === undefined) return
  await applyWaiting($)
  await openThread($, row.dialog)
}

async function selectAtCursor($: $, how: 'toggle' | 'range'): Promise<void> {
  const message = await cursorMessage($)
  if (message === undefined) return
  const order = (await threadMessages($)).map(one => one.id)
  await update($, selection, value =>
    how === 'toggle' ? toggleSelected(value, message.id) : rangeSelect(value, order, message.id),
  )
}

// --- keys: what each one does (./ui/keys says where it exists and when it works) ---

/**
 * The view the keys act on, under the menu: a layer (the card, Activity, the
 * send sheet, a diff, the summary, the send box or the search field) or where
 * the cursor is: the Folders list, For you, Chats, the chat.
 */
async function underWhere($: $): Promise<Exclude<Where, 'menu' | 'band'>> {
  if ((await read($, autopilot)).view.kind === 'card') return 'card' // ── autopilot ──
  if ((await read($, activity)) !== null) return 'activity' // ── running ──
  const shown = (await read($, overlay)).kind // ── routing ──
  if (shown === 'sheet' || shown === 'broadcast') return 'sheet'
  if ((await read($, bottest)).diff !== null) return 'diff'
  // T4b's layers: the summary over the lower part, a field in the bar's row.
  const where = await read($, nav)
  const open = await read($, thread)
  const summary = (await read($, triage)).summary
  if (open !== null && summary !== null && summary.peerId === open.peer.id && where.view === 'thread') return 'summary'
  if (where.isSearching || (open !== null && (await read($, bottest)).composing)) return 'field'
  if (where.view === 'thread' && open !== null) return 'chat'
  if (where.view === 'folders') return 'folders'
  return where.list.kind === 'foryou' && where.query === '' ? 'foryou' : 'chats'
}

/** The chat the keys of `where` act on: the card's, the cursor row's in Chats, else the open one. */
async function keyPeer($: $, where: Where): Promise<PeerRef | undefined> {
  const view = (await read($, autopilot)).view
  if (where === 'card' && view.kind === 'card') return (await apDialog($, view.dialogId))?.peer
  if (where === 'chats' || where === 'foryou') {
    const row = await cursorRow($)
    if (row?.kind === 'agent') return agentPeer($, row.item) // ── folders ──
    return row === undefined ? undefined : peerRefOf(row.dialog)
  }
  if (where === 'folders') return undefined
  return (await read($, thread))?.peer
}

function sheetStepOf(shown: Overlay): KeyContext['facts']['sheet'] {
  return shown.kind === 'sheet' ? shown.step : shown.kind === 'broadcast' ? 'broadcast' : null
}

async function keyContext($: $, seat: Seat, where: Exclude<Where, 'menu' | 'band'>): Promise<KeyContext> {
  const peer = await keyPeer($, where)
  const messages = await threadMessages($)
  const chosen = await read($, selection)
  const bt = await read($, bottest)
  const tri = await read($, triage)
  const pilot = await read($, autopilot)
  const view = pilot.view
  const tasks = (await read($, delegate)).tasks
  return {
    where,
    seat,
    kind: peer === undefined ? null : chatKind(peer.kind, isBotFather(peer.arg)),
    facts: {
      rows:
        where === 'chats' || where === 'foryou'
          ? (await listRows($)).length
          : where === 'folders'
            ? (await folderItems($)).length
            : where === 'activity'
              ? (await activityRows($)).length
              : messages.length,
      // ── running ── what 0 stops: every follow, autopilot and Worker (§5.6).
      isRunning: pilot.running.length > 0 || (await read($, pins)).length > 0 || tasks.some(isLive),
      hasFinished: tasks.some(task => !isLive(task)),
      undoLeft: undoLeft(pilot.undo, Math.max(pilot.now, await $.clock.now())),
      hasNotice: where === 'card' ? view.kind === 'card' && view.notice !== null : bt.notice !== null || (await stopNoticeNow($, Infinity)) !== null,
      marks: chosen.ids.length,
      isRangeOpen: chosen.anchor !== null,
      hasPair: diffPair(chosen.ids, messages).ok,
      hasButtons: messages.some(message => message.buttons.length > 0),
      isRecording: bt.recording !== null,
      isWatched: peer !== undefined && tri.watched.some(one => one.id === peer.id),
      isFollowed: peer !== undefined && (await read($, pins)).some(pin => pin.peer.id === peer.id),
      summary: peer !== undefined && tri.summary?.peerId === peer.id ? tri.summary.status : 'none',
      // For you's row (── folders ──); in a chat, a draft's row (§8 T3).
      row: where === 'foryou' ? await forYouRowKind($) : where === 'chat' && (await cursorItem($))?.kind === 'draft' ? 'draft' : null,
      card: where === 'card' && view.kind === 'card' && peer !== undefined ? await cardFacts($, view, peer) : null, // ── autopilot ──
      sheet: sheetStepOf(await read($, overlay)),
    },
  }
}

/** One key, pressed from the bar, a hidden hotkey or the menu. */
async function runKey($: $, id: RunKey): Promise<void> {
  const where = await underWhere($)
  switch (id) {
    case 'down':
    case 'up': {
      const by = id === 'down' ? 1 : -1
      const row = where === 'activity' ? await moveActivity($, by) : await moveCursor($, by)
      if (row !== undefined) await moveRing($, row)
      return
    }
    case 'open':
      if (where === 'card') return apStep($, 'options') // ── autopilot ── o: the card's options
      if (where === 'activity') return openActivityRow($, (await read($, activity))?.cursor ?? 0)
      return where === 'folders' ? openFolderAt($, (await read($, nav)).folderCursor) : openAtCursor($)
    case 'senddraft': {
      if (where === 'foryou') return openAtCursor($)
      const item = await cursorItem($)
      return item?.kind === 'draft' ? enterDraft($, item.draft.ref) : undefined
    }
    case 'send':
      return openSheet($)
    case 'start': {
      await apCardEnter($) // ── autopilot ──
      // A started rung closes the card: the ring goes back to the cursor row. A card still up keeps it where its step put it.
      if ((await read($, autopilot)).view.kind === 'none') await ringCursor($)
      return
    }
    case 'mark':
      await selectAtCursor($, 'toggle')
      return ringCursor($)
    case 'range':
      await selectAtCursor($, 'range')
      return ringCursor($)
    case 'whole': {
      const order = (await threadMessages($)).map(one => one.id)
      await update($, selection, () => selectWhole(order))
      return ringCursor($)
    }
    case 'buttons':
      return focusButtons($)
    case 'agent':
      // In the send sheet a picks another agent (§6); elsewhere it opens the card.
      return where === 'sheet' ? setStep($, 'targets') : apToggleCard($)
    case 'inspect':
      return where === 'sheet' ? setStep($, 'inspect') : openSheet($, 'inspect')
    case 'watch':
      await toggleWatch($, await watchTarget($))
      return ringCursor($)
    case 'follow':
      await togglePin($)
      return ringCursor($)
    case 'summary':
    case 'write': {
      // On the summary, t retries one that failed and otherwise closes it, as h does.
      if (where === 'summary') return (await read($, triage)).summary?.status === 'error' ? toggleSummary($) : back($)
      // From a row in Chats or For you: that chat opens, with its summary over the lower part or the send box in the bar's row.
      const fromList = where === 'chats' || where === 'foryou'
      const dialog = fromList ? await cursorDialog($) : undefined
      if (fromList && dialog === undefined) return
      if (dialog !== undefined) {
        await applyWaiting($) // ── folders ── the cursor moves into the chat: what waits applies.
        await openThread($, dialog)
      }
      return id === 'summary' ? toggleSummary($) : toggleCompose($)
    }
    case 'record':
      await toggleRecord($)
      return ringCursor($)
    case 'diff':
      await toggleDiff($)
      return ringCursor($)
    case 'foryou':
      return switchView($, { kind: 'foryou' }) // ── folders ──
    case 'search':
      return startSearch($)
    case 'edit':
      if (where === 'foryou') return editAgentRow($) // ── folders ──
      if (where === 'card') return apEditField($)
      return editAtCursor($)
    case 'dismiss':
      if (where === 'foryou' && (await cursorRow($))?.kind === 'agent') return dropAgentRow($) // ── folders ──
      if (where === 'card') return apNotice($, null)
      if (where === 'activity') return dismissEnded($)
      if (where === 'chat' && (await cursorItem($))?.kind === 'draft') return dropAtCursor($)
      // The notice row's notice: a write's result, or what 0 stopped.
      await update($, bottest, value => ({ ...value, notice: null }))
      await update($, lastStop, () => null) // ── running ──
      return
    case 'undo':
      await apUndo($)
      return ringCursor($)
    case 'activity':
      return openActivity($)
    case 'reload':
      if (where === 'card') return loadAllow($) // ── autopilot ── g: read allow.toml again (§7.4)
      return reload($)
    case 'back':
      return back($)
    case 'menu':
      await update($, nav, value => ({ ...value, isMenuOpen: !value.isMenuOpen }))
      return ringCursor($)
    case 'hide':
      return setMode($, 'hidden')
    case 'stop': {
      // ── running ── the kill switch; the dock's strip row and the toast say what stopped.
      $.ui.toast(stopAnswer(await stopEverything($)).replace('\n', ' '))
      return ringCursor($)
    }
  }
}

/** A key pressed in the menu: the menu closes, then the key acts on the view under it. */
async function runMenuKey($: $, id: RunKey): Promise<void> {
  await update($, nav, value => ({ ...value, isMenuOpen: false }))
  await runKey($, id)
}

/** `h`: one level up (design §4.2): the menu, a layer, the search, the send box, the marks, the chat. */
async function back($: $): Promise<void> {
  const where = await underWhere($)
  if ((await read($, nav)).isMenuOpen) {
    await update($, nav, value => ({ ...value, isMenuOpen: false }))
  } else if (where === 'card') {
    // ── autopilot ── one step back; only the ladder closes the card, and the ring then goes back to the cursor row.
    await apCardBack($)
    if ((await read($, autopilot)).view.kind === 'card') return
  } else if (where === 'sheet') {
    const shown = await read($, overlay)
    // Broadcast came from the targets, and every other step from the intents: back one step.
    if (shown.kind === 'broadcast') {
      await update($, overlay, () => ({ kind: 'sheet', ids: shown.ids, sender: shown.sender, step: 'targets', to: { kind: 'main' }, isRedacted: shown.isRedacted }))
      return setStep($, 'targets')
    }
    if (shown.kind === 'sheet' && shown.step !== 'intents') return setStep($, 'intents')
    await closeOverlay($)
  } else if (where === 'activity') {
    await update($, activity, () => null)
  } else if (where === 'diff') {
    await update($, bottest, value => ({ ...value, diff: null }))
  } else if (where === 'summary') {
    await hideSummary($)
  } else if (where === 'field') {
    await update($, nav, value => ({ ...value, isSearching: false }))
    await update($, bottest, value => ({ ...value, composing: false }))
  } else if (where === 'chats' || where === 'foryou') {
    // ── folders ── a search goes back to its folder; a folder or For you, up to every folder.
    await backFromList($)
  } else if (where === 'folders') {
    // ── folders ── the top: back down to the chats it came from, as they are now.
    await update($, nav, value => ({ ...value, view: 'dialogs' }))
    await applyWaiting($)
  } else if (where === 'chat') {
    const chosen = await read($, selection)
    if (chosen.ids.length > 0 || chosen.anchor !== null) await update($, selection, () => NO_SELECTION)
    else {
      await update($, nav, value => ({ ...value, view: 'dialogs' }))
      await applyWaiting($) // ── folders ── the ring moves back to Chats: what waits applies.
    }
  }
  await ringCursor($)
}

/** `s`: the search field, ringed so the letters type into it. */
async function startSearch($: $): Promise<void> {
  await update($, nav, value => ({ ...value, isSearching: true, isMenuOpen: false }))
  // $.ui.focus waits, bounded, for the field to be drawn.
  await moveRing($, 'search')
}

/**
 * The search field's ⏎: a new query searches every chat (`tg dialogs --query`,
 * §4.7) and puts the cursor on the first; an empty one goes back to the
 * folder; the same one (⏎ on the field as it opened) only closes it, so the
 * cursor and its window stay where they were (§4.3 rule 1).
 */
async function submitSearch($: $, query: string): Promise<void> {
  const asked = query.trim()
  const where = await read($, nav)
  await update($, nav, value => ({ ...value, isSearching: false }))
  if (asked === where.query) return ringCursor($)
  if (asked === '') return switchView($, where.list) // ── folders ──
  await searchChats($, asked) // ── folders ──
}

async function openFromBand($: $): Promise<void> {
  const event = await read($, band)
  await update($, band, () => null)
  await setMode($, 'open')
  const dialog = (await knownDialogs($)).find(one => one.id === event?.dialogId)
  if (dialog !== undefined) await openThread($, dialog)
}

async function dismissBand($: $): Promise<void> {
  await update($, band, () => null)
  await refreshStatus($)
}

// --- the frame: header, strips, the view's slot, the notice row (inline), the bar or a layer in its row ---

type Seating = { seat: Seat; width: number; rows: number; isFocused: boolean }

/**
 * The pane for where the engine seated it (design §4.1, §7.3). The dock keeps
 * Chats on top (or the Folders list, or For you) and the open chat (or a card,
 * the picker, a diff, the ledger) below; inline shows one view at a time. Both
 * end in the action bar.
 */
async function drawPane($: $, els: Els, seating: Seating): Promise<RenderElement> {
  const { seat, width, rows } = seating
  const where = await underWhere($)
  const isMenu = (await read($, nav)).isMenuOpen
  const context = await keyContext($, seat, where)
  const barContext: KeyContext = isMenu ? { ...context, where: 'menu' } : context
  const onKey = (id: RunKey) => runKey($, id)
  const chosen = await read($, selection)
  // The marks ride the bar's row (T4b): `▪ 3 marked` leads it, and the verbs get what is left.
  const lead = !isMenu && where === 'chat' ? marksLead(chosen.ids.length) : null
  // ── folders ── the Folders list's rows carry the digits: the bar says so after ⏎ (§4.6).
  const digitsText = !isMenu && where === 'folders' ? await digitsLabel($) : null
  const bar = actionBar(barContext, width - (lead === null ? 0 : lead.length + BAR_GAP) - (digitsText === null ? 0 : digitsText.length + BAR_GAP))
  const isBase = where === 'chats' || where === 'chat'
  // Inline Chats: the strip shares the header row; the dock gives it a row of its own.
  const isInlineChats = seat === 'inline' && where === 'chats' && !isMenu
  // The dock's strip draws `s: search` while the keys are Chats' or the chat's (s exists there only);
  // over a layer its Button stays, without the hotkey. The engine keeps the ring by its place among
  // the Buttons (seen live on 2.1.296: closing the sheet put it one row above the cursor while `s`
  // came back), so the strip draws the same Buttons in every view under Chats.
  const search = seat === 'inline' ? 'none' : isBase ? 'key' : 'click'
  // ── folders ── the strip shows while Chats do: not over the Folders list or For you (§5.0, §5.3).
  const isChatsOnTop = await chatsOnTop($)
  const summary = await summaryOf($)
  const stripWidth = seat === 'inline' ? inlineStripRoom(width, summary, seating.isFocused) : width
  const strip = isMenu || !isChatsOnTop || (seat === 'inline' && where !== 'chats') ? null : await drawStrip($, els, { isLive: where === 'chats', search, width: stripWidth })
  // ── running ── the dock's strip comes and goes as things start and stop, mostly while the cursor
  // stays: it draws no ring stop, and its row is kept whether it shows or not, so neither the stops
  // above the cursor nor the lists' windows change with it (§4.3 rule 1). Inline the header counts.
  // Over the Folders list or For you the folder strip is not drawn, so what waits rides this row.
  const running = seat === 'dock' && !isMenu ? await drawRunningStrip($, els, width, !isChatsOnTop) : null
  const runningRows = seat === 'dock' ? RUNNING_ROWS : 0
  // Inline, the windows always leave a row for a notice (T4b): the frame fits its content, so the
  // row costs nothing while it is empty, and one arriving takes no row from a list.
  const notice = seat === 'inline' && !isMenu ? await drawNoticeRow($, els, width) : null
  const noticeRows = seat === 'inline' ? 1 : 0
  // The send sheet's intents and Ask field take the bar's place (§5.1): four rows docked, two inline.
  // The send box and the search field are layers in the bar's own row (T4b).
  const shown = await read($, overlay)
  const sheetBar = isMenu || where !== 'sheet' ? null : await drawSheetBar($, els, seat, width, seating.isFocused)
  const fieldBar = isMenu || where !== 'field' ? null : await drawFieldBar($, els)
  const isAsking = shown.kind === 'sheet' && shown.step === 'ask'
  const sheetRows = sheetBar === null ? 1 : seat === 'dock' ? (isAsking ? 3 : 4) : isAsking ? 3 : 2
  const chrome = 1 + sheetRows + (strip !== null && !isInlineChats ? 1 : 0) + runningRows + noticeRows
  const room = Math.max(3, rows - chrome)
  const slot = isMenu
    ? [Menu(els, { sections: menuSections(context), onKey: id => runMenuKey($, id) })]
    : seat === 'dock'
      ? await drawDock($, els, where, width, room, Math.max(3, rows - 2 - (strip === null ? 0 : 1) - runningRows))
      : await drawInline($, els, where, width, room)
  const drawn = new Set(sheetBar === null && fieldBar === null ? bar.flatMap(key => (key.hotkey === null ? [] : [key.hotkey])) : [])
  if (strip !== null && search === 'key') drawn.add('s')
  // Views that draw a key of the table themselves: the sheet's a, i and h.
  if (sheetBar !== null && !isAsking) for (const key of ['a', 'i', 'h']) drawn.add(key)
  // A failed load draws its own `g: reload` (LoadState): the list's, or the chat's, where they show.
  const isListShown = !isMenu && (seat === 'dock' || where === 'chats' || where === 'foryou')
  const isThreadShown = !isMenu && isBase && (seat === 'dock' || where === 'chat')
  if (await hasReloadRow($, isListShown, isThreadShown)) drawn.add('g')
  // The menu's own Buttons carry the keys of the view under it.
  if (isMenu) for (const section of menuSections(context)) for (const entry of section.entries) if (entry.def.hotkey !== null) drawn.add(entry.def.hotkey)
  // ── folders ── digits pick a folder while the cursor is in Chats, the Folders list or For you (§4.7).
  const isDigitsLive = !isMenu && (where === 'chats' || where === 'folders' || where === 'foryou')
  const header = Header(els, {
    location: await locationOf($, where, isMenu, isInlineChats),
    strip: isInlineChats ? strip : null,
    summary,
    chips: await chipsOf($),
    isFocused: seating.isFocused,
  })
  const barRow = sheetBar ?? fieldBar ?? ActionBar(els, { keys: bar, lead, digits: digitsText, isFocused: seating.isFocused, onKey })
  const hidden = HiddenKeys(els, { keys: hiddenKeys(barContext, drawn), onKey })
  const digits = isDigitsLive ? await drawDigitKeys($, els) : null
  // Every other letter and digit is caught, so none falls through to the prompt and takes the keys (the T9 review's M1).
  const taken = hotkeysIn([header, running, strip, slot, notice, barRow, hidden, digits])
  const stray = StrayKeys(els, { keys: STRAY_KEYS.filter(key => !taken.has(key)), onKey: key => say($, 'info', strayText(key, barContext)) })
  return Frame(els, { rows, header, running, strip: isInlineChats ? null : strip, slot, notice, bar: barRow, hidden, digits, stray })
}

async function hasReloadRow($: $, isListShown: boolean, isThreadShown: boolean): Promise<boolean> {
  const hasRow = (load: Load<unknown> | undefined) => load?.status === 'error' && load.failure.kind !== 'flood'
  return (isListShown && hasRow(await read($, dialogs))) || (isThreadShown && hasRow((await read($, thread))?.load))
}

async function locationOf($: $, where: Where, isMenu: boolean, isInlineChats: boolean): Promise<string> {
  const peer = await keyPeer($, where)
  const label = peer?.label ?? 'chats'
  if (isMenu) return `tg › menu · ${where === 'chats' || where === 'chat' ? label : where}`
  if (isInlineChats) return 'tg'
  switch (where) {
    case 'chats':
      return 'tg › chats'
    case 'folders':
      return 'tg › folders'
    case 'foryou':
      return 'tg › for you'
    case 'chat':
      return `tg › ${label}`
    case 'card': {
      // ── autopilot ── the card's step after its chat: delegate's warning and grant, `o`'s options.
      const view = (await read($, autopilot)).view
      const step = view.kind === 'card' ? view.step : 'ladder'
      return `tg › agent for ${label}${step === 'options' ? ' · options' : step === 'ladder' ? '' : ` · ${LEVEL_GLYPH.delegate} delegate`}`
    }
    case 'sheet': {
      // The intents sit under the open chat, which the header names (§5.1); the other steps say what they are.
      const shown = await read($, overlay)
      if (shown.kind === 'broadcast') return `tg › several agents · ${label}`
      if (shown.kind === 'sheet' && shown.step === 'targets') return `tg › send to · ${label}`
      if (shown.kind === 'sheet' && shown.step === 'inspect') return `tg › inspect · ${label}`
      return `tg › ${label}`
    }
    case 'diff':
      return `tg › diff · ${label}`
    case 'activity':
      return 'tg › activity'
    case 'summary':
      return `tg › summary · ${label}`
    case 'field':
      return (await read($, nav)).isSearching ? 'tg › search' : `tg › ${label}`
    case 'menu':
    case 'band':
      return 'tg'
  }
}

/** §4.5: agents by level, new messages in watched chats, what waits for the owner. One summary: the header, the footer label, `/tg status`. */
async function summaryOf($: $) {
  return stateSummary(await summaryCounts($))
}

async function summaryCounts($: $) {
  const pilot = await read($, autopilot)
  const levels = pilot.running.map(id => pilot.dialogs[String(id)]?.level)
  const count = (level: string) => levels.filter(one => one === level).length
  const watched = new Set((await read($, triage)).watched.map(peer => peer.id))
  const listed = await knownDialogs($)
  const replyDraft = await read($, draft)
  return {
    levels: [
      { glyph: GLYPH.pinned, count: (await read($, pins)).length },
      ...AP_LEVELS.map(level => ({ glyph: LEVEL_GLYPH[level], count: count(level) })),
    ],
    watched: listed.filter(dialog => watched.has(dialog.id)).reduce((sum, dialog) => sum + dialog.unread, 0),
    forYou: pilot.drafts.length + (replyDraft !== null && replyDraft.step.kind !== 'sent' ? 1 : 0) + (await dgHoldCount($)),
  }
}

async function chipsOf($: $): Promise<{ text: string; color?: string }[]> {
  const recording = (await read($, bottest)).recording
  // ── autopilot ── the card says whether its chat runs a rung: `○ off`, `● draft · listening`.
  const pilot = await read($, autopilot)
  const card = pilot.view.kind === 'card' ? [cardChip(await runningRungOf($, pilot.view.dialogId), pilot.phase[String(pilot.view.dialogId)])] : []
  return [...card, ...(recording === null ? [] : [{ text: `${GLYPH.unread} rec ${recording.steps.length}`, color: TOKEN.danger }])]
}

/**
 * The send box (`n`) or the search field (`s`), in the bar's row (T4b, as the
 * send sheet's Ask field): it adds no row, the lists under it are drawn
 * without ring stops while it holds the ring (§4.3 rule 3), and ⏎ on it empty
 * closes it. Null without an Input (a surface that has none).
 */
async function drawFieldBar($: $, els: Els): Promise<RenderElement | null> {
  const Input = 'Input' in els ? els.Input : undefined
  if (Input === undefined) return null
  const where = await read($, nav)
  if (where.isSearching) {
    return <Input key="search" label="search" placeholder="every chat: title or @name; empty goes back to the folder" value={where.query} submitLabel="search" onSubmit={value => submitSearch($, value)} />
  }
  const open = await read($, thread)
  return open === null ? null : SendBox(els, { peer: open.peer.label, onSend: text => sendText($, text) })
}

/**
 * The notice the pane shows now: what a write is doing (`… pressing`), what it
 * brought back or why it was refused, what `0` stopped. A drafted reply is a
 * row of its chat (§8 T3), not a notice. The dock draws it in the running
 * strip's row, inline in the notice row.
 */
async function noticeNow($: $, width: number): Promise<Notice | null> {
  const bt = await read($, bottest)
  if (bt.busy !== null) return { tone: 'info', text: `${GLYPH.working} ${bt.busy}` }
  if (bt.notice !== null) return bt.notice
  const stop = await stopNoticeNow($, width) // ── running ──
  if (stop !== null) return stop
  return passNotice($) // ── folders ──
}

/** Inline's notice row: one row the windows always leave free; while no notice shows, what waits for the owner's move (§8 T9). */
async function drawNoticeRow($: $, els: Els, width: number): Promise<RenderElement | null> {
  const notice = (await noticeNow($, width)) ?? (await movedNotice($))
  return notice === null ? null : NoticeRow(els, { notice })
}

/**
 * Dock: Chats (or the Folders list, or For you) on top, the open chat or a
 * layer below. The list's height comes from `listRoom`, the room without the
 * sheet's rows: the engine keeps the ring by its place among the Buttons, so
 * the rows above must not change in number when a layer opens or closes.
 */
async function drawDock($: $, els: Els, where: Where, width: number, room: number, listRoom: number): Promise<RenderElement[]> {
  const open = await read($, thread)
  // The Folders list has its pane-views line, For you its two section lines (── folders ──).
  const at = await read($, nav)
  const length = at.view === 'folders' ? (await folderItems($)).length + 1 : isForYou(at) ? (await listRows($)).length + 2 : (await listRows($)).length
  const topRows = Math.min(Math.max(1, length), Math.max(3, Math.floor(listRoom * 0.4)))
  // Under the send box or the search field the list is drawn without ring stops (§4.3 rule 3).
  const mode = where === 'chats' || where === 'folders' || where === 'foryou' ? 'active' : where === 'field' ? 'static' : 'idle'
  const list = await drawTop($, els, width, topRows, mode)
  const lower = Math.max(1, room - topRows - 1)
  return [...list, Divider(els, { label: await dividerLabel($), width }), ...(await drawLower($, els, 'dock', where, width, lower, open !== null))]
}

/** Inline: one view at a time; a field in the bar's row shows the column it works on, without ring stops. */
async function drawInline($: $, els: Els, where: Where, width: number, room: number): Promise<RenderElement[]> {
  if (where === 'chats' || where === 'folders' || where === 'foryou') return drawTop($, els, width, room, 'active', 'inline')
  if (where === 'field' && (await read($, nav)).isSearching) return drawDialogList($, els, width, room, 'static')
  return drawLower($, els, 'inline', where, width, room, true)
}

/** The slot T2–T6 fill: the chat, the card, the picker (the send sheet's place), activity, a diff. */
async function drawLower($: $, els: Els, seat: Seat, where: Where, width: number, rows: number, isOpen: boolean): Promise<RenderElement[]> {
  const { Text } = els
  switch (where) {
    case 'card': {
      const view = await drawCard($, els, width) // ── autopilot ──
      return view === null ? [] : [view]
    }
    case 'activity':
      return [await drawActivity($, els, width, rows)] // ── running ──
    case 'sheet': {
      // Targets, inspect and the legs take the lower part; the intents leave the chat on screen above them.
      const over = await drawOverlay($, els, width, rows)
      if (over !== null) return [over]
      const task = await drawChatTask($, els, width, seat, rows) // ── delegate ──
      return [...task.elements, ...(await drawThread($, els, width, Math.max(1, rows - task.rows), 'static'))]
    }
    case 'diff': {
      const diff = await drawBottestDiff($, els, width, rows)
      return diff === null ? [] : [diff]
    }
    case 'summary': {
      const summary = await drawSummary($, els, width) // ── triage ──
      return summary === null ? [] : [summary]
    }
    case 'chats':
    case 'chat':
    case 'folders':
    case 'foryou':
    case 'field': {
      if (!isOpen) return [<Text dimColor>⏎ on a chat opens it here.</Text>]
      // ── delegate ── the chat's task card, on top of its thread; a delegate chat keeps its rows (see drawChatTask).
      const task = await drawChatTask($, els, width, seat, rows)
      const mode = where === 'chat' ? 'active' : where === 'field' ? 'static' : 'idle'
      return [...task.elements, ...(await drawThread($, els, width, Math.max(1, rows - task.rows), mode))]
    }
    case 'menu':
    case 'band':
      return []
  }
}

/** `─ @example_bot · bot · ◎ watched ─`: the open chat, its kind, and what is on it. */
async function dividerLabel($: $): Promise<string> {
  // ── autopilot ── over the lower part, the card asks its one question (§5.4).
  const view = (await read($, autopilot)).view
  const carded = view.kind === 'card' ? await apDialog($, view.dialogId) : null
  if (view.kind === 'card' && carded !== null) {
    const name = carded.peer.label
    return view.step === 'ladder' ? `what may an agent do in ${name}?` : view.step === 'options' ? `options for ${name}` : view.step === 'warning' ? `${LEVEL_GLYPH.delegate} delegate ${name}?` : `${name} · ${LEVEL_GLYPH.delegate} delegate`
  }
  const open = await read($, thread)
  if (open === null) return 'no chat open'
  const kind = CHAT_KIND_LABEL[chatKind(open.peer.kind, isBotFather(open.peer.arg))]
  const isWatched = (await read($, triage)).watched.some(one => one.id === open.peer.id)
  const pin = (await read($, pins)).find(one => one.peer.id === open.peer.id) // ── routing ──
  const follow = pin === undefined ? '' : pin.watch.status === 'failed' ? ` · ${GLYPH.pinned} ${GLYPH.error} ${pin.watch.reason}` : ` · ${GLYPH.pinned} follows → main`
  const live = (await read($, bottest)).timing.watch === 'live' ? ` · ${GLYPH.latency} live` : ''
  return `${open.peer.label} · ${kind}${isWatched ? ' · ◎ watched' : ''}${follow}${live}`
}

/**
 * `active`: the cursor's column, its row ringed. `idle`: the chat holds the
 * cursor. `static`: under the send box or the search field, ▸ shown and no ring stops.
 */
async function drawDialogList($: $, els: Els, width: number, rows: number, mode: 'active' | 'idle' | 'static'): Promise<RenderElement[]> {
  const load = await read($, dialogs)
  const where = await read($, nav)
  const at = await read($, now)
  const open = await read($, thread)
  const waiting = LoadState(els, { load, now: at, rows, onReload: () => reload($) })
  if (waiting !== null) return [waiting]
  const list = loaded(load) ?? []
  if (list.length === 0) return [EmptyList(els, { text: await emptyText($) })] // ── folders ──
  const markOf = await watchMarks($)
  const pilotOf = await autopilotMarks($)
  const cursor = clamp(where.dialogCursor, list.length)
  windowRows.dialogs = rows
  const start = edgeStart(where.dialogStart, cursor, rows, list.length)
  const shown = { start, items: windowAt(list, start, rows) }
  const pinned = new Set((await read($, pins)).map(pin => pin.peer.id))
  const gen = (await read($, folders)).gen
  return shown.items.map((dialog, index) =>
    DialogRow(els, {
      dialog,
      rowKey: rowKey(gen, { kind: 'chat', dialog }),
      isCursor: mode !== 'idle' && shown.start + index === cursor,
      isStatic: mode === 'static',
      isOpen: open?.peer.id === dialog.id,
      isPinned: pinned.has(dialog.id),
      width,
      now: at,
      onOpen: async () => {
        await update($, nav, value => ({ ...value, view: 'dialogs', dialogCursor: shown.start + index }))
        await openAtCursor($)
      },
      mark: markOf(dialog.id),
      autopilot: pilotOf(dialog.id),
    }),
  )
}

/**
 * `active`: the cursor's column, its row ringed. `idle`: Chats hold the cursor.
 * `static`: under the send sheet's intents, ▸ shown and no ring stops at all.
 * The window is counted in terminal rows: a message takes one, two with its
 * buttons, a draft its whole text, so a draft is drawn whole or not at all.
 */
async function drawThread($: $, els: Els, width: number, rows: number, mode: 'active' | 'idle' | 'static'): Promise<RenderElement[]> {
  const { Text } = els
  const open = await read($, thread)
  if (open === null) return [<Text dimColor>⏎ on a chat opens it here.</Text>]
  const at = await read($, now)
  const waiting = LoadState(els, { load: open.load, now: at, rows, onReload: () => reload($) })
  if (waiting !== null) return [waiting]
  const messages = loaded(open.load) ?? []
  if (messages.length === 0) return [<Text dimColor>No messages in this chat yet.</Text>]
  const chosen = await read($, selection)
  const layout = await threadLayout($, width, rows)
  windowRows.messages = rows
  threadHeights = layout.heights
  lastThread = { width, rows } // ── footer ──
  const bt = await bottestCards($, open.peer, messages, width)
  return layout.shown.map((item, index) => {
    const row = layout.start + index
    const isCursor = mode !== 'idle' && row === layout.cursor
    const toRow = () => update($, nav, value => ({ ...value, view: 'thread', messageCursor: row }))
    if (item.kind === 'draft') {
      return DraftCard(els, {
        draft: item.draft,
        isCursor,
        isStatic: mode === 'static',
        width,
        onPress: async () => {
          await toRow()
          await enterDraft($, item.draft.ref)
        },
        onSave: async text => {
          // The field's drawing has the row's head as a ring stop, before it: the ring goes back to it.
          await moveRing($, item.draft.key)
          await saveDraft($, item.draft.ref, text)
        },
      })
    }
    const { message } = item
    return MessageCard(els, {
      ...bt(els, message),
      message,
      isCursor,
      isStatic: mode === 'static',
      isSelected: chosen.ids.includes(message.id),
      isAnchor: chosen.anchor === message.id,
      width,
      now: at,
      // ⏎ (or a click) on a message: the send sheet for it (§5.1).
      onPress: async () => {
        await toRow()
        await openSheet($)
      },
    })
  })
}

/**
 * The open thread's window for `rows` terminal rows at `width`: the rows it
 * holds whole, from where it starts. The drawing and the band (which leaves
 * out a draft the pane draws) read the same answer.
 */
async function threadLayout($: $, width: number, rows: number): Promise<{ shown: ThreadRow[]; start: number; cursor: number; heights: number[] }> {
  const items = await threadItems($)
  const where = await read($, nav)
  const heights = items.map(item => rowHeight(item, width))
  const cursor = clamp(where.messageCursor, items.length)
  const start = windowStart(where.messageStart, cursor, heights, rows)
  return { shown: items.slice(start, start + windowCount(start, heights, rows)), start, cursor, heights }
}

// ── triage ──
// Live updates through the watch hub, watched dialogs in Hidden mode, saved
// summaries and needs-you ranking (design §5 ideas 11–14; the ranking orders
// For you, ── folders ──). Every `$` function of the triage phase is in this
// block; its pure rules are in ./triage. Keys (./ui/keys): w watch, t summary.
// `On`, `MessageView` and `failureText` come from the bottest block's imports
// (imports hoist; one module may import a name once).

const triage = atom({ plugin: 'dialogs-pane', key: 'triage' } as const, EMPTY_TRIAGE)
const STORE_WATCHED = 'triage.watched'
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
  // After a reload the old subscriptions are gone, so their health is too.
  await update($, triage, value => ({ ...value, watched, health: {} }))
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
  const listed = await knownDialogs($)
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
    const atEnd = await isOnNewest($)
    await update($, thread, value =>
      value?.peer.id === peer.id && value.load.status === 'ok'
        ? { ...value, load: { status: 'ok', value: applyToMessages(value.load.value, event, message => message) } }
        : value,
    )
    // A cursor on the newest message follows new ones; one placed higher, or on a draft, stays.
    if (atEnd) await toNewest($)
  }
  if (event.event !== 'message') return
  const { message } = event
  // The row changes in place; in the module's map the chat also moves up in its folders, and that waits (── folders ──).
  await update($, dialogs, value => (value.status === 'ok' ? { status: 'ok', value: applyToDialogs(value.value, peer.id, message).map(cutRow) } : value))
  await patchHeld($, peer.id, message)
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
  // The band names the intents of who wrote (§4.6), not of the chat: in a group a bot's reply is a bot's.
  const report = reportReply(peer, message, entry.recent, senderClass(message, chatKind(peer.kind, isBotFather(peer.arg))))
  await update($, triage, value => ({ ...value, reply: report.reply }))
  // Every mode: the band leaves out what the pane draws (── footer ──).
  await update($, band, () => report.band)
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
  const dialog = await cursorDialog($)
  return dialog === undefined ? undefined : peerRefOf(dialog)
}

/** The band's "⏎ send to main" hook point: the watched reply's own message id, when the band shows one. */
async function watchedReplyId($: $, dialogId: number): Promise<number | null> {
  const reply = (await read($, triage)).reply
  return reply !== null && reply.dialogId === dialogId ? reply.messageId : null
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
  if (current?.peerId === peer.id && current.status !== 'error') return hideSummary($)
  const abort = new AbortController()
  summaryAbort = abort
  await update($, triage, value => ({ ...value, summary: { peerId: peer.id, status: 'loading' } }))
  await update($, nav, value => ({ ...value, view: 'thread' }))
  await moveRing($, 'summary:close')
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

/**
 * `t`'s summary, a layer over the lower part (dock) or the body (inline): it
 * takes no row from the thread, which is not drawn under it (T4b). Its close
 * Button holds the ring, so ⏎ closes it as h does.
 */
async function drawSummary($: $, els: Els, width: number): Promise<RenderElement | null> {
  const open = await read($, thread)
  const summary = (await read($, triage)).summary
  if (open === null || summary === null || summary.peerId !== open.peer.id) return null
  return SummaryBlock(els, { summary, width, onClose: () => back($) })
}

/** `h` on the summary: it closes, and a summary still being written is cancelled. */
async function hideSummary($: $): Promise<void> {
  summaryAbort?.abort()
  summaryAbort = null
  await update($, triage, value => ({ ...value, summary: null }))
}

// --- needs-you ranking: For you's people (── folders ──) ---

/**
 * One ranking call at a time, when For you opens (§5.3, §8 T9): the chats the
 * heuristics leave open and the cache has no verdict for. Nothing outside For
 * you asks the model.
 */
function scoreUnread($: $, candidates: readonly TgDialog[]): Promise<void> {
  scoring ??= askModel($, candidates).finally(() => {
    scoring = null
  })
  return scoring
}

async function askModel($: $, candidates: readonly TgDialog[]): Promise<void> {
  const state = await read($, triage)
  const asked = toAsk(candidates, me ?? NO_ME, state.verdicts, state.repliedToYou)
  if (asked.length === 0) return
  const result = await $.model.complete({
    model: TRIAGE_MODEL,
    system: RANK_SYSTEM,
    prompt: rankPrompt(asked),
    maxTokens: 200,
    effort: 'low',
    timeoutMs: RANK_TIMEOUT_MS,
  })
  // No answer: the heuristics rank alone, and the next opening asks again.
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
// Phase 2, and dialogs-pane-ux.md §5.1 (T2): the send sheet (⏎ on a message),
// its targets from the agent radar, inspect, broadcast, the packet ledger,
// live pins and drafted replies. Pure rules and drawing are
// in ./routing; every `$` call is here.
//
// The ledger lives in $.state, not $.store: its states (… / ✓) and its agents
// belong to this session, and a restarted session has none of those agents.

const RADAR_MS = 5_000
/** An agent pin's new messages go out together once this long passes quietly. */
const PIN_FLUSH_MS = 1_500

const route = atom({ plugin: 'dialogs-pane', key: 'route' } as const, { kind: 'one', to: { kind: 'main' } })
const isRedacted = atom({ plugin: 'dialogs-pane', key: 'isRedacted' } as const, true)
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
  // The packet ledger was an overlay before Activity (T4): a reload across that change may still hold it.
  await update($, overlay, value => (value.kind === 'sheet' || value.kind === 'broadcast' ? value : { kind: 'none' }))
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

/** Keeps the radar fresh while the sheet is up or a packet is with an agent, and Activity's ages moving. */
async function routingTick($: $): Promise<void> {
  const shown = (await read($, overlay)).kind
  const isActivity = (await read($, activity)) !== null // ── running ──
  const isWaiting = (await read($, ledger)).some(
    entry => entry.to.kind === 'agent' && (entry.state.kind === 'sent' || entry.state.kind === 'working'),
  )
  if (shown === 'none' && !isActivity && !isWaiting) return
  await refreshRadar($)
  if (isActivity) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
  await refreshStatus($)
}

// --- the overlay: the send sheet and its steps, broadcast ---

const STORE_INTENTS = 'send.intents'

async function closeOverlay($: $): Promise<void> {
  await update($, overlay, () => ({ kind: 'none' }))
  await ringCursor($)
}

/** The last intent per kind of sender, kept across sessions (§8 T2): ⏎ in the sheet repeats it. */
async function lastIntents($: $): Promise<{ last: LastIntents; stored: unknown }> {
  const stored = await $.store.get(STORE_INTENTS)
  return { last: parseLastIntents(stored), stored }
}

async function rememberIntent($: $, sender: SenderClass, intent: RouteIntent): Promise<void> {
  await $.store.set(STORE_INTENTS, rememberedWith(await $.store.get(STORE_INTENTS), sender, intent))
}

/** The ring on the sheet's intent ⏎ sends: the last one used for this kind of sender. */
async function ringIntent($: $, sender: SenderClass): Promise<void> {
  await moveRing($, `sheet:intent:${ringedIntent((await lastIntents($)).last, sender)}`)
}

/** The chat kind of the open thread, as §4.6 tells them apart. */
function openChatKind(open: { peer: PeerRef }): ChatKind {
  return chatKind(open.peer.kind, isBotFather(open.peer.arg))
}

/**
 * ⏎ on a message (or the marked set): the send sheet with its sender's intents
 * (§4.6), sending to main until `a` picks another. `i` in a chat opens it on
 * inspect. Digits there send at once.
 */
async function openSheet($: $, step: SheetStep = 'intents'): Promise<void> {
  const marked = (await read($, selection)).ids
  const message = await cursorMessage($)
  const ids = marked.length > 0 ? marked : message === undefined ? [] : [message.id]
  const open = await read($, thread)
  if (ids.length === 0 || open === null) return
  const sender = setClass(selectedMessages(await threadMessages($), ids), openChatKind(open))
  // Each sheet starts from the pane's redaction; inspect turns it off for this packet alone.
  const redact = await read($, isRedacted)
  await update($, overlay, () => ({ kind: 'sheet', ids, sender, step, to: { kind: 'main' }, isRedacted: redact }))
  await refreshRadar($)
  if (step === 'inspect') await moveRing($, 'sheet:redact')
  else await ringIntent($, sender)
}

async function setStep($: $, step: SheetStep): Promise<void> {
  const shown = await update($, overlay, value => (value.kind === 'sheet' ? { ...value, step } : value))
  if (shown.kind !== 'sheet') return
  if (step === 'intents') await ringIntent($, shown.sender)
  else if (step === 'ask') await moveRing($, 'sheet:ask')
  else if (step === 'inspect') await moveRing($, 'sheet:redact')
  else await moveRing($, shown.to.kind === 'main' ? 'route:main' : shown.to.kind === 'new' ? 'route:new' : `route:agent:${shown.to.agentId}`)
}

/** A digit of the sheet: that intent goes now to the sheet's target; the last digit opens the Ask field. */
async function pickIntent($: $, chosen: RouteIntent): Promise<void> {
  const shown = await read($, overlay)
  if (shown.kind !== 'sheet') return
  if (chosen === 'raw') return setStep($, 'ask')
  await sendSheet($, shown, chosen, '')
}

/** The Ask field: its words are the intent line; an empty field goes back to the intents. */
async function submitAsk($: $, words: string): Promise<void> {
  const shown = await read($, overlay)
  if (shown.kind !== 'sheet') return
  if (words.trim() === '') return setStep($, 'intents')
  await sendSheet($, shown, 'raw', words)
}

async function sendSheet($: $, shown: Extract<Overlay, { kind: 'sheet' }>, chosen: RouteIntent, words: string): Promise<void> {
  await rememberIntent($, shown.sender, chosen)
  const chosenRoute = { kind: 'one', to: shown.to } as const
  await update($, route, () => chosenRoute)
  await closeOverlay($)
  await sendIds($, shown.ids, legsOf(chosenRoute, chosen), { sender: shown.sender, isRedacted: shown.isRedacted, words })
}

/** A target from `a`: the sheet goes back to its intents, sending there now. */
async function chooseTarget($: $, to: Recipient): Promise<void> {
  await update($, overlay, value => (value.kind === 'sheet' ? { ...value, to } : value))
  await setStep($, 'intents')
}

async function openBroadcast($: $): Promise<void> {
  const shown = await read($, overlay)
  if (shown.kind !== 'sheet') return
  const { last } = await lastIntents($)
  const rows = broadcastRows(await read($, radar), mainLegIntent(last, shown.sender), legSplit(shown.sender))
  await update($, overlay, () => ({ kind: 'broadcast', rows, ids: shown.ids, sender: shown.sender, isRedacted: shown.isRedacted }))
  await moveRing($, 'leg:0:on')
}

async function editLegs($: $, edit: (rows: BroadcastRow[]) => BroadcastRow[]): Promise<void> {
  await update($, overlay, value => (value.kind === 'broadcast' ? { ...value, rows: edit(value.rows) } : value))
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
  await closeOverlay($)
  await sendIds($, shown.ids, chosen.legs, { sender: shown.sender, isRedacted: shown.isRedacted, words: '' })
}

/** What the sheet is about: its messages, the parents at hand, and the packet they make now. */
async function sheetFacts($: $, shown: Extract<Overlay, { kind: 'sheet' }>, intentNow: RouteIntent) {
  const open = await read($, thread)
  const messages = await threadMessages($)
  const selected = selectedMessages(messages, shown.ids)
  const { known, toFetch } = parentsAtHand(selected, messages)
  const peer = open === null ? null : peerOf(open.peer, await knownDialogs($))
  // One redactor for the packet and the lines inspect shows, so their placeholders agree.
  const redactor = shown.isRedacted ? new Redactor() : null
  const packet =
    peer === null || selected.length === 0
      ? null
      : previewPacket({ selected, context: known, peer, intent: sheetIntent(intentNow, shown.sender), redact: redactor ?? false })
  return { open, selected, known, toFetch, redactor, packet }
}

/**
 * The sheet where the bar was (its intents and the Ask field), or null when a
 * step of it takes the lower part instead (targets, inspect) or it is not up.
 */
async function drawSheetBar($: $, els: Els, seat: Seat, width: number, isFocused: boolean): Promise<RenderElement | null> {
  const shown = await read($, overlay)
  if (shown.kind !== 'sheet' || (shown.step !== 'intents' && shown.step !== 'ask')) return null
  const { last, stored } = await lastIntents($)
  const ringed = ringedIntent(last, shown.sender)
  const facts = await sheetFacts($, shown, ringed)
  const agent = shown.to.kind === 'agent' ? shown.to.agentId : null
  const state = shown.to.kind === 'main' ? ((await read($, isMainBusy)) ? 'running' : 'idle') : ((await read($, radar)).find(one => one.agentId === agent)?.state ?? 'idle')
  return SendSheet(els, {
    seat,
    width,
    title: sheetTitle(facts.selected, facts.known.length + facts.toFetch.length),
    target: targetText(shown.to, state),
    intents: SHEET_INTENTS[shown.sender],
    ringed,
    who: CLASS_LABEL[shown.sender],
    isRemembered: isRemembered(stored, shown.sender),
    masked: facts.packet?.redactions.length ?? 0,
    isRedacted: shown.isRedacted,
    isAsking: shown.step === 'ask',
    isFocused,
    onIntent: chosen => pickIntent($, chosen),
    onAsk: words => submitAsk($, words),
    onAgent: () => setStep($, 'targets'),
    onInspect: () => setStep($, 'inspect'),
    onBack: () => back($),
  })
}

/** The steps of the sheet that take the lower part: targets, inspect, the legs. */
async function drawOverlay($: $, els: Els, width: number, rows: number): Promise<RenderElement | null> {
  const shown = await read($, overlay)
  switch (shown.kind) {
    case 'none':
      return null
    case 'sheet': {
      if (shown.step === 'intents' || shown.step === 'ask') return null
      const { last } = await lastIntents($)
      const ringed = ringedIntent(last, shown.sender)
      const facts = await sheetFacts($, shown, ringed)
      const title = sheetTitle(facts.selected, facts.known.length + facts.toFetch.length)
      if (shown.step === 'targets') {
        return TargetList(els, {
          title,
          to: shown.to,
          radar: await read($, radar),
          isMainBusy: await read($, isMainBusy),
          width,
          onMain: () => chooseTarget($, { kind: 'main' }),
          onAgent: (agent: RadarEntry) => chooseTarget($, { kind: 'agent', agentId: agent.agentId, label: agent.label }),
          onNew: () => chooseTarget($, { kind: 'new' }),
          onSeveral: () => openBroadcast($),
        })
      }
      const open = facts.open
      const redactor = facts.redactor
      const shownMessages = (list: readonly TgMessage[]) => (redactor === null ? [...list] : list.map(message => redactMessage(message, redactor)))
      return Inspect(els, {
        target: shown.to.kind === 'main' ? 'main' : shown.to.kind === 'new' ? 'a new agent' : shown.to.label,
        view: inspectView({
          peer: open?.peer.label ?? '?',
          kind: open === null ? '?' : CHAT_KIND_LABEL[openChatKind(open)],
          intent: ringed,
          isRedacted: shown.isRedacted,
          shown: shownMessages(facts.selected),
          parents: shownMessages(facts.known),
          toFetch: facts.toFetch.length,
          replay: facts.packet?.replay ?? null,
          redactions: facts.packet?.redactions ?? [],
          width,
        }),
        isRedacted: shown.isRedacted,
        width,
        onRedact: () => update($, overlay, value => (value.kind === 'sheet' ? { ...value, isRedacted: !value.isRedacted } : value)),
      })
    }
    case 'broadcast':
      return BroadcastPicker(els, {
        count: shown.ids.length,
        rows: shown.rows,
        width,
        onToggle: index => editLegs($, legs => legs.map((leg, at) => (at === index ? { ...leg, isOn: !leg.isOn } : leg))),
        onIntent: index =>
          editLegs($, legs => legs.map((leg, at) => (at === index ? { ...leg, intent: nextLegIntent(shown.sender, leg.intent) } : leg))),
        onAdd: () => editLegs($, legs => addNewLeg(legs, legSplit(shown.sender))),
        onDone: () => finishBroadcast($),
      })
  }
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
  input: { peer: PeerRef; selected: TgMessage[]; known: readonly TgMessage[]; legs: readonly Leg[]; how: SendHow },
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
  const peer = peerOf(input.peer, await knownDialogs($))
  const { sender, isRedacted: redact, words } = input.how
  const before = (await read($, ledger)).length
  await Promise.all(
    input.legs.map(async leg => {
      const packet = buildPacket({
        messages: expanded.messages,
        context: expanded.context,
        peer,
        intent: sheetIntent(leg.intent, sender, words),
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

/** How a sheet sends: whose intents, this packet's redaction, the Ask field's words. */
type SendHow = { sender: SenderClass; isRedacted: boolean; words: string }

/** The sheet's send: these messages, along the legs; the marks clear once every leg went. */
async function sendIds($: $, ids: readonly number[], legs: readonly Leg[], how: SendHow): Promise<void> {
  const open = await read($, thread)
  const messages = await threadMessages($)
  const selected = selectedMessages(messages, ids)
  if (open === null || selected.length === 0) {
    $.ui.toast('tg: those messages are no longer loaded; ⏎ on one sends it.')
    return
  }
  const sent = await sendPacket($, { peer: open.peer, selected, known: messages, legs, how })
  const why = sent.fetchFailure === null ? '' : ` Reply-chain parents missing: ${sent.fetchFailure.kind}.`
  if (sent.failed === 0) {
    await update($, selection, () => NO_SELECTION)
    $.ui.toast(`tg: packet sent to ${legs.length === 1 ? 'one target' : `${legs.length} targets`}; l shows activity.${why}`)
  } else {
    $.ui.toast(`tg: ${sent.failed} of ${legs.length} deliveries failed; l shows why. The marks are kept.${why}`)
  }
}

/** The band's ⏎ on a watched chat's news: the message to main, under the intent the band names; ⏎ opens where it names none. */
async function bandToMain($: $): Promise<void> {
  const event = await read($, band)
  const asked = event === null ? null : bandIntent(event, (await lastIntents($)).last)
  if (event !== null && asked === null) return openFromBand($)
  const dialog = (await knownDialogs($)).find(one => one.id === event?.dialogId)
  // A watched reply names its own message (triage); otherwise the dialog's newest.
  const messageId = event === null ? null : ((await watchedReplyId($, event.dialogId)) ?? dialog?.last_id ?? null)
  if (event === null || asked === null || dialog === undefined || messageId === null) {
    $.ui.toast('tg: that message is no longer in the dialog list; open it with o.')
    return
  }
  const peer: PeerRef = { id: dialog.id, arg: peerArg(dialog), label: dialogLabel(dialog), kind: dialog.kind }
  const found = await runTg($, tg.msg(peer.arg, [messageId]))
  if (!found.ok || found.value.length === 0) {
    $.ui.toast(`tg: could not fetch #${messageId} (${found.ok ? 'not found' : found.failure.kind}).`)
    return
  }
  const { sender, intent } = asked
  const sent = await sendPacket($, {
    peer,
    selected: found.value,
    known: [],
    legs: [{ to: { kind: 'main' }, intent }],
    how: { sender, isRedacted: await read($, isRedacted), words: '' },
  })
  if (sent.failed === 0) await update($, band, () => null)
  await refreshStatus($)
}

// --- live pins: tg watch → $.state → prompt.context (main) or session.send (an agent) ---

let pinFlush: Timer | null = null

async function setWatch($: $, peerId: number, watch: PinWatch): Promise<void> {
  await update($, pins, value => value.map(pin => (pin.peer.id === peerId ? { ...pin, watch } : pin)))
}

/**
 * `p`: follow the open chat to the route's agent (main unless one agent is
 * picked), the ladder's first rung; again stops it. One rung per chat
 * (decision 2): a chat whose autopilot runs is switched on its card.
 */
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
  const running = await runningRungOf($, open.peer.id) // ── autopilot ──
  if (running !== null) return say($, 'info', `p: ${open.peer.label} runs ${RUNG_GLYPH[running]} ${RUNG_NAME[running]} · a: its card switches to follow`)
  const pin = await followPeer($, open.peer)
  const chosen = await read($, route)
  const where = pin.to.kind === 'main' ? 'main, every turn' : pin.to.label
  const note = chosen.kind === 'one' && chosen.to.kind !== 'new' ? '' : ' (pins go to main or one named agent)'
  $.ui.toast(`tg: ${GLYPH.pinned} ${open.peer.label} pinned → ${where}${note}. p again unpins.`)
}

/** The chat follows the route's agent: its new messages, from the newest one known, reach main's context or that agent. */
async function followPeer($: $, peer: PeerRef): Promise<Pin> {
  const chosen = await read($, route)
  const to: Pin['to'] =
    chosen.kind === 'one' && chosen.to.kind === 'agent'
      ? { kind: 'agent', agentId: chosen.to.agentId, label: chosen.to.label }
      : { kind: 'main' }
  const open = await read($, thread)
  const loadedNewest = open?.peer.id === peer.id ? (await threadMessages($)).reduce((top, message) => Math.max(top, message.id), 0) : 0
  const newest = loadedNewest !== 0 ? loadedNewest : ((await knownDialogs($)).find(one => one.id === peer.id)?.last_id ?? 0)
  const pin: Pin = {
    peer,
    to,
    lastId: newest === 0 ? null : newest,
    messages: [],
    unsent: [],
    watch: { status: 'starting' },
  }
  await update($, pins, value => [...value.filter(one => one.peer.id !== peer.id), pin])
  await startPinWatch($, pin)
  return pin
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
  const peers = await knownDialogs($)
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

// --- drafted replies: a row of their chat (§8 T3); the dry run as they land, then the same tg send; the owner's, so --yes ---

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

/** send reply: only after a check the guard allowed, and the same argv minus --dry-run. Answers whether it tried (false: no allowed verdict, nothing ran). */
async function sendDraft($: $): Promise<boolean> {
  const current = await read($, draft)
  if (current === null || current.step.kind !== 'planned' || !current.step.isAllowed) return false
  await setDraftStep($, current, { kind: 'sending' })
  const ran = await runDraft($, current, false)
  if (ran === null) return true
  const ids = ran.exitCode === 0 ? parseSent(ran.stdout) : null
  if (ids === null) {
    const failure = failureOf(ran.exitCode, ran.stderr)
    await setDraftStep($, current, { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failure.kind })
    return true
  }
  await setDraftStep($, current, { kind: 'sent', ids })
  // The thread again, with the reply in it: the draft's row was the cursor's, and the sent message takes it.
  const open = await read($, thread)
  if (open?.peer.id === current.peer.id) await loadThread($, open.peer)
  return true
}
// ── /routing ──

// ── bottest ──
// Bot testing in the pane (docs/design/dialogs-pane.md §5 ideas 6–10): pressable
// buttons (b, then Enter), a one-line send box (n), the recorder (r), the reply
// diff (f) and latency stamps; ./ui/keys keeps r and f to bot chats. The pure
// parts are in ./bottest; everything that takes `$` is here.
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
import { ChipRow, DiffView, SendBox, chipKey } from './bottest/ui'
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

/** How long a notice stays in its row (T4b), unless `d` dismisses it first. */
const NOTICE_MS = 15_000
let noticeTimer: Timer | null = null

/** Every notice goes through here, so each one leaves its row after NOTICE_MS (a newer one restarts the wait). */
async function say($: $, tone: Notice['tone'], text: string): Promise<void> {
  await update($, bottest, value => ({ ...value, notice: { tone, text } }))
  noticeTimer?.cancel()
  noticeTimer = $.clock.after(NOTICE_MS, () => {
    noticeTimer = null
    update($, bottest, value => (value.notice?.text === text ? { ...value, notice: null } : value)).catch(() => {
      // A notice left behind stays until d; the next one replaces it.
    })
  })
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
  const atEnd = await isOnNewest($)
  const open = await update($, thread, value =>
    value === null || value.peer.id !== peer.id || value.load.status !== 'ok'
      ? value
      : { ...value, load: { status: 'ok', value: mergeMessages(value.load.value, incoming) } },
  )
  const after = open?.load.status === 'ok' ? open.load.value : before
  if (after.length > before.length && atEnd) await toNewest($)
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
  if (notice === null) await update($, bottest, value => ({ ...value, notice: null }))
  else await say($, notice.tone, notice.text)
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
/** The send box's ⏎: it closes, the text goes out (an empty box sends nothing), and the ring goes back to the cursor row. */
async function sendText($: $, text: string): Promise<void> {
  await update($, bottest, value => ({ ...value, composing: false }))
  await sendFromBox($, text)
  // The box's drawing lacks the cursor row's key, so the ring waits for the next one (§4.3 rule 3).
  await ringCursor($)
}

async function sendFromBox($: $, text: string): Promise<void> {
  const open = await read($, thread)
  if (open === null || text.trim() === '') return
  if (isBotFather(open.peer.arg)) return say($, 'warn', readOnlyText({ kind: 'botfather' }))
  if ((await read($, bottest)).busy !== null) return say($, 'info', 'tg is still running the last step; send again once it is done.')
  const at = await $.clock.now()
  await update($, bottest, value => ({ ...value, busy: `sending ${oneLine(text, 24)}`, notice: null, timing: sent(value.timing, at) }))
  const result = await runWrite($, calls.send(open.peer.arg, true), text)
  await finishWrite($, open.peer, { kind: 'send', text, wait_s: SEND_WAIT_S }, at, result)
}

// --- keys: b, n, r, f ---

/** `b`: the ring onto the first chip of the message at the cursor, or of the newest with buttons. */
async function focusButtons($: $): Promise<void> {
  const messages = await threadMessages($)
  const atCursor = await cursorMessage($)
  const target = atCursor !== undefined && atCursor.buttons.length > 0 ? atCursor : messages.findLast(one => one.buttons.length > 0)
  const first = target?.buttons[0]?.[0]
  if (target === undefined || first === undefined) return say($, 'info', 'No message in this thread has buttons.')
  const index = (await threadItems($)).findIndex(item => item.kind === 'message' && item.message.id === target.id)
  await update($, nav, value => ({ ...value, view: 'thread', messageCursor: index }))
  await moveRing($, chipKey(target.id, first))
}

/** `n`: opens the send box and puts the ring in it; again closes it. */
async function toggleCompose($: $): Promise<void> {
  const next = await update($, bottest, value => ({ ...value, composing: !value.composing, notice: null }))
  if (!next.composing) return
  // $.ui.focus waits, bounded, for the box to be drawn in the bar's row.
  await moveRing($, 'bt:send')
}

/** `r`: starts a recording; again stops it and writes the script. */
async function toggleRecord($: $): Promise<void> {
  const at = await $.clock.now()
  const state = await read($, bottest)
  if (state.recording === null) {
    await update($, bottest, value => ({ ...value, recording: startRecording(at) }))
    await say($, 'info', 'Recording: sends and presses from the pane become steps. r stops.')
    return
  }
  const recording = state.recording
  if (recording.steps.length === 0) {
    await update($, bottest, value => ({ ...value, recording: null }))
    await say($, 'info', 'Recording stopped: no steps, nothing written.')
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
  }))
  if (written === null) await say($, 'danger', `${GLYPH.error} could not write ${scriptPath(recording)}; the steps are kept in the pane's state.`)
  else await say($, 'info', `${GLYPH.done} ${recording.steps.length} steps → ${scriptPath(recording)} (in the session's directory)`)
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

// ── autopilot ──
// Phase 3 (docs/design/dialogs-pane.md §6): chosen dialogs answered as you.
// Each running dialog listens on the watch hub (name 'autopilot', unbounded).
// A burst waits for its gap and for the other side to stop typing (60 s at
// most); the Speaker, one $.model.complete call with no tools, writes; the
// dialog is read again right before sending; a reply leaves through the
// bottest write runner as `tg send PEER - --plain --json` (calls.reply), so tg's
// guard and allow.toml decide. Only the owner's own keys pass --yes: ⏎ on a
// draft read whole, and `u`'s delete (design doc §9 decision 9). A draft is a
// row of its chat (dialogs-pane-ux.md §8 T3), For you's row and the band's
// item. Pure rules are in ./autopilot and ./ui/drafts; every `$` call is here.
// Keys (./ui/keys): a the card (pane), u undo (pane and band); a draft's ⏎ e d
// on its row and in the band. The kill switch: `/tg stop` (or `/tg autopilot
// off`), "stop all" (0).
import type { PluginOptions } from 'claude-code'

import type { ApDialog, ApDraft, ApLevel, ApOutcome, ApPhase, ApRung, ApTopic, ApUndo, ApView, Autopilot, CardStep, DraftCheck } from '../types'
import { CardLadder, CardOptions, cardChip } from './autopilot/components'
import { AP_LEVELS, LEVEL_GLYPH, defaultDialog, parseDialogs as parseApDialogs, parseQuiet, rateText, toggleTopic } from './autopilot/config'
import {
  ALLOW_NO,
  ALLOW_YES,
  RUNG_GLYPH,
  RUNG_NAME,
  allowArgv,
  allowQuestion,
  allowedLine,
  actionLabel,
  cardAction,
  firstPick,
  ladderFor,
  runningRung,
  type AllowView,
  type CardAction,
} from './autopilot/ladder'
import { MAX_REGENERATIONS, NO_BURST, afterCheck, consume, gate, onDeleted, onEdited, onIncoming, onTyping, sentLastHour, wakeAt, type AfterCheck, type Burst } from './autopilot/burst'
import { NO_AUTOPILOT, UNDO_MS, addEntry as addApEntry, logCheck, patchEntry, putDraft, undoLeft } from './autopilot/ledger'
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

/**
 * The allowlist is read again after each `!` command the owner runs (§5.4, T3):
 * one who adds a chat by hand (`! tg allow add PEER`) sees it in the card at
 * once. Only once the pane has read it at all, so a session that never opens
 * the pane runs no tg for it.
 */
function registerAutopilot(on: On): void {
  on('session.append', async ($, e, next) => {
    const done = await next(e)
    if (isShellOutput(e.message) && (await read($, bottest)).allow.status !== 'idle') {
      loadAllow($).catch(() => {
        // loadAllow records its own failure, and the card shows it (§7.4).
      })
    }
    return done
  }).catch(($, e, next) => next(e))
}

/** A `!` command's output row, as the engine records it in the transcript (`<bash-stdout>`, `<bash-stderr>`). */
function isShellOutput(message: { type: string; content: readonly { type: string; [field: string]: unknown }[] }): boolean {
  return message.type === 'user' && message.content.some(block => block.type === 'text' && typeof block.text === 'string' && /<bash-(stdout|stderr)>/.test(block.text))
}

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
    // A card for a dialog no longer stored closes; so does the ledger tab a reload across T4 may still hold.
    // A card held across a reload from before T3 has no step: it closes too.
    view: value.view.kind === 'card' && dialogs[String(value.view.dialogId)] !== undefined && typeof value.view.step === 'string' ? value.view : { kind: 'none' },
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

/** Whether tg's guard lets an agent's writes to the dialog through without --yes; the allowlist is read when not at hand. */
async function apIsAllowed($: $, peer: PeerRef): Promise<boolean> {
  if ((await read($, bottest)).allow.status !== 'ok') await loadAllow($)
  const view = apAllowView(peer, (await read($, bottest)).allow)
  return view.kind === 'ok' && view.isAllowed
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
  await dgStopTasksOf($, dialogId, 'autopilot stopped') // ── delegate ──
  await apReleaseLease($, dialogId) // ── delegate ──
  // Last: ending the watch child is the part that can throw.
  await unsubscribeWatch($, dialogId, AP_HUB)
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
  await keepThreadCursor($, () => update($, autopilot, value => ({ ...value, drafts: value.drafts.filter(one => one.peer.id !== rt.peer.id) })))
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
  const peer = peerOf(rt.peer, await knownDialogs($))
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

/**
 * A reply that waits for the owner: a row of its chat after the newest message
 * the thread has (so never above the cursor, §4.3), checked by the guard as it
 * lands, so its verdict shows before ⏎ (§8 T3).
 */
async function apToDraft($: $, rt: ApRuntime, ids: readonly number[], said: Spoken, reasons: string[]): Promise<void> {
  const seq = rt.seq ?? 0
  const last = rt.burst.messages.filter(one => ids.includes(one.id)).at(-1)
  const after = await newestIn($, rt.peer.id, Math.max(0, ...ids))
  const draft: ApDraft = { seq, peer: rt.peer, incoming: messageText(last), text: said.text, confidence: said.confidence, reasons, state: { kind: 'ready' }, check: { kind: 'checking' }, at: await $.clock.now(), after }
  await keepThreadCursor($, () => update($, autopilot, value => ({ ...value, drafts: putDraft(value.drafts, draft) })))
  await apDone($, rt, ids, { kind: 'drafted', reasons })
  await apCheckDraft($, seq)
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

// --- drafts: rows of their chat, For you's rows, the band's items (§8 T3) ---

/** The draft For you's row or the band names by `seq`, or the first (the band's). */
async function apDraftOf($: $, seq?: number): Promise<ApDraft | null> {
  const drafts = (await read($, autopilot)).drafts
  return (seq === undefined ? drafts[0] : drafts.find(one => one.seq === seq)) ?? null
}

async function apSetDraft($: $, seq: number, change: (draft: ApDraft) => ApDraft): Promise<void> {
  await update($, autopilot, value => ({ ...value, drafts: value.drafts.map(one => (one.seq === seq ? change(one) : one)) }))
}

/**
 * The guard's verdict on a draft, as the owner would send it (`tg send …
 * --yes --dry-run`, decision 9): run as it lands and after each edit, so it
 * shows before ⏎. A verdict for a text since edited is dropped; BotFather is
 * refused here and runs nothing (the repo's rule).
 */
async function apCheckDraft($: $, seq: number): Promise<void> {
  const draft = await apDraftOf($, seq)
  if (draft === null) return
  const isSame = (one: ApDraft) => one.text === draft.text
  if (isBotFather(draft.peer.arg)) return apSetDraft($, seq, one => ({ ...one, check: { kind: 'failed', reason: readOnlyText({ kind: 'botfather' }) } }))
  await apSetDraft($, seq, one => ({ ...one, check: { kind: 'checking' } }))
  let ran: ProcessRunResult
  try {
    ran = await $.process.run([...calls.reply(draft.peer.arg, true), '--dry-run'], { stdin: draft.text, timeoutMs: TG_TIMEOUT_MS })
  } catch (error) {
    return apSetDraft($, seq, one => (isSame(one) ? { ...one, check: { kind: 'failed', reason: `tg did not run: ${reasonOf(error)}` } } : one))
  }
  const plan = ran.exitCode === 0 ? parsePlan(ran.stdout) : null
  const failure = failureOf(ran.exitCode, ran.stderr)
  const check: DraftCheck =
    plan !== null ? { kind: 'planned', ...plan } : { kind: 'failed', reason: failure.kind === 'error' || failure.kind === 'not-found' ? failure.message : failureText(failure, await $.clock.now()) }
  await apSetDraft($, seq, one => (isSame(one) ? { ...one, check } : one))
}

/**
 * Sends a draft the owner read whole: their own write, so --yes (decision 9),
 * and only once the guard's verdict allows it: the rule is held here, at the
 * write. Its row leaves the thread; the sent message takes the next one.
 * Answers whether it tried (false: no allowed verdict, nothing ran).
 */
async function apSendDraft($: $, seq?: number): Promise<boolean> {
  const draft = await apDraftOf($, seq)
  if (draft === null || draft.state.kind === 'sending' || draft.check.kind !== 'planned' || !draft.check.isAllowed) return false
  if (isBotFather(draft.peer.arg)) {
    await apSetDraft($, draft.seq, one => ({ ...one, state: { kind: 'failed', reason: readOnlyText({ kind: 'botfather' }) } }))
    return true
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
    return true
  }
  const sent = result.sent.map(one => one.id)
  for (const id of sent) rt?.sentIds.add(id)
  await keepThreadCursor($, () =>
    update($, autopilot, value => ({
      ...value,
      drafts: value.drafts.filter(one => one.seq !== draft.seq),
      ledger: patchEntry(value.ledger, draft.seq, { reply: draft.text, outcome: { kind: 'sent', ids: sent, by: 'you' } }),
    })),
  )
  await refreshStatus($)
  return true
}

async function apDropDraft($: $, seq?: number): Promise<void> {
  const draft = await apDraftOf($, seq)
  if (draft === null) return
  await keepThreadCursor($, () =>
    update($, autopilot, value => ({
      ...value,
      drafts: value.drafts.filter(one => one.seq !== draft.seq),
      ledger: patchEntry(value.ledger, draft.seq, { outcome: { kind: 'dropped' } }),
    })),
  )
  await refreshStatus($)
}

/** Every draft waiting, autopilot's and routing's, as their rows draw them. */
async function draftViewsNow($: $): Promise<DraftView[]> {
  return draftViews((await read($, autopilot)).drafts, await read($, draft))
}

async function draftViewOf($: $, ref: DraftRef): Promise<DraftView | undefined> {
  return (await draftViewsNow($)).find(one => one.key === draftKey(ref))
}

/** The newest message id the chat's open thread has, or `fallback`: a draft lands after it (§4.3). */
async function newestIn($: $, peerId: number, fallback: number): Promise<number> {
  const open = await read($, thread)
  const loadedNewest = open?.peer.id === peerId ? (await threadMessages($)).reduce((top, one) => Math.max(top, one.id), 0) : 0
  return Math.max(fallback, loadedNewest)
}

/**
 * ⏎ on a draft's row (or For you's, or the band's once it shows it whole):
 * sent when the guard allowed it; checked first when it has no verdict yet,
 * or its last one did not allow it; told to wait while a check or a send runs.
 */
async function enterDraft($: $, ref: DraftRef): Promise<void> {
  const view = await draftViewOf($, ref)
  if (view === undefined || view.isEditing) return
  if (view.isBusy) return say($, 'info', `${LEVEL_GLYPH.draft} ${view.verdict.text}`)
  // The send paths hold the rule themselves (the guard's verdict allows this text): one that sends nothing is checked again.
  const isSent = ref.kind === 'autopilot' ? await apSendDraft($, ref.seq) : await sendDraft($) // ── routing ──
  if (!isSent) await checkDraftRef($, ref)
}

async function checkDraftRef($: $, ref: DraftRef): Promise<void> {
  if (ref.kind === 'autopilot') await apCheckDraft($, ref.seq)
  else await checkDraft($) // ── routing ──
}

/** `e` on a draft: its text becomes a field, in its row's place; the ring goes to it. */
async function editDraft($: $, ref: DraftRef, isEditing: boolean): Promise<void> {
  if (ref.kind === 'autopilot') await apSetDraft($, ref.seq, one => ({ ...one, state: isEditing ? { kind: 'editing' } : { kind: 'ready' } }))
  else await update($, draft, value => (value === null ? null : { ...value, isEditing })) // ── routing ──
}

/** The field's ⏎: the text kept (an empty one keeps the old), the field gone, and the guard asked again. */
async function saveDraft($: $, ref: DraftRef, text: string): Promise<void> {
  const kept = (old: string) => (text.trim() === '' ? old : text)
  if (ref.kind === 'autopilot') {
    await apSetDraft($, ref.seq, one => ({ ...one, text: kept(one.text), state: { kind: 'ready' } }))
  } else {
    await update($, draft, value => (value === null ? null : { ...value, text: kept(value.text), isEditing: false, step: { kind: 'draft' } })) // ── routing ──
  }
  await checkDraftRef($, ref)
}

async function dropDraft($: $, ref: DraftRef): Promise<void> {
  if (ref.kind === 'autopilot') return apDropDraft($, ref.seq)
  await keepThreadCursor($, () => update($, draft, () => null)) // ── routing ──
}

/** `e` in a chat, the cursor on a draft's row. */
async function editAtCursor($: $): Promise<void> {
  const item = await cursorItem($)
  if (item?.kind !== 'draft') return
  await editDraft($, item.draft.ref, true)
  await moveRing($, `${item.draft.key}:text`)
}

/** `d` in a chat, the cursor on a draft's row. */
async function dropAtCursor($: $): Promise<void> {
  const item = await cursorItem($)
  if (item?.kind === 'draft') await dropDraft($, item.draft.ref)
}

/**
 * A change that may take a draft's row out of the open thread or put one in:
 * the cursor stays on its row, and the window on its first one; when the
 * cursor's own row leaves, the next row takes its place, or the one before
 * it at the end (and the ring goes there, a row the old drawing has in the
 * same place).
 */
async function keepThreadCursor($: $, change: () => Promise<unknown>): Promise<void> {
  const before = (await threadItems($)).map(threadRowKey)
  const at = await read($, nav)
  await change()
  const after = (await threadItems($)).map(threadRowKey)
  if (before.length === 0 || after.length === 0) return
  const kept = keptCursor(before, after, clamp(at.messageCursor, before.length), clamp(at.messageStart, before.length))
  await update($, nav, value => ({ ...value, messageCursor: kept.cursor, messageStart: kept.start }))
  // The cursor's own row left at the end: the one before it, which the old drawing has in the same place, takes the ring.
  if (!after.includes(before[clamp(at.messageCursor, before.length)] ?? '') && kept.cursor < at.messageCursor && (await read($, mode)) === 'open' && (await underWhere($)) === 'chat') await ringCursor($)
}

/** ⏎ on a draft For you or the band shows cut short: the pane opens on its row, and ⏎ there sends what was read whole (decision 9). */
async function openDraftRow($: $, ref: DraftRef): Promise<void> {
  const view = await draftViewOf($, ref)
  if (view === undefined) return
  await apOpen($, view.peer)
  const index = (await threadItems($)).findIndex(item => item.kind === 'draft' && item.draft.key === view.key)
  if (index < 0) return
  await update($, nav, value => ({ ...value, view: 'thread', messageCursor: index }))
  await ringCursor($)
}

/** `o` on a draft or a summary: the pane, on that dialog. */
async function apOpen($: $, peer: PeerRef): Promise<void> {
  if ((await read($, mode)) === 'hidden') await setMode($, 'open')
  const listed = (await knownDialogs($)).find(one => one.id === peer.id)
  await openThread($, listed ?? dialogOfPeer(peer))
}

// --- the agent card (dialogs-pane-ux.md §5.4, §5.5): the ladder, its options, delegate's warning and grant ---

/** The chat kind the card's ladder is read for. */
function cardKind(peer: PeerRef): ChatKind {
  return chatKind(peer.kind, isBotFather(peer.arg))
}

/** The rung running in a chat: its follow (pin), or its autopilot level (one at most, decision 2). */
async function runningRungOf($: $, dialogId: number): Promise<ApRung | null> {
  const pilot = await read($, autopilot)
  const level = pilot.running.includes(dialogId) ? (pilot.dialogs[String(dialogId)]?.level ?? null) : null
  return runningRung((await read($, pins)).some(pin => pin.peer.id === dialogId), level)
}

/** `a`: the card for the open thread's chat, or the one at the cursor; again closes it. */
async function apToggleCard($: $): Promise<void> {
  if ((await read($, autopilot)).view.kind !== 'none') {
    await update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
    return ringCursor($)
  }
  const peer = await watchTarget($)
  if (peer === undefined) {
    $.ui.toast('tg: put the cursor on a chat, then press a for its agent card.')
    return
  }
  await apOpenCard($, peer)
}

/**
 * The agent card of `peer` (from `a`, or ⏎ on a running row in Activity), on
 * the ladder with the rung that runs (or the stored one) picked. allow.toml is
 * read again on every open, so an allow added in the prompt since shows at once.
 */
async function apOpenCard($: $, peer: PeerRef): Promise<void> {
  const ladder = ladderFor(cardKind(peer))
  if (ladder.length === 0) return
  const running = await runningRungOf($, peer.id)
  await update($, autopilot, value => {
    const stored = value.dialogs[String(peer.id)] ?? defaultDialog(peer)
    return {
      ...value,
      dialogs: value.dialogs[String(peer.id)] === undefined ? { ...value.dialogs, [String(peer.id)]: stored } : value.dialogs,
      view: { kind: 'card', dialogId: peer.id, step: 'ladder', pick: firstPick(ladder, running, stored.level), notice: null, back: 'ladder' },
    }
  })
  // ⏎ starts or stops: the ring waits on the bar's `⏎ start …` (design §3.3).
  await moveRing($, 'key:start')
  loadAllow($).catch(() => {
    // loadAllow records its own failure, and the card shows it (§7.4).
  })
}

async function apNotice($: $, notice: string | null): Promise<void> {
  await update($, autopilot, value => (value.view.kind === 'card' ? { ...value, view: { ...value.view, notice } } : value))
}

/** The card's step: its ⏎ is keyed per step (./ui/keys), so the ring waits for the step's own drawing. */
async function apStep($: $, step: CardStep, ring?: string): Promise<void> {
  const view = await update($, autopilot, value => (value.view.kind === 'card' ? { ...value, view: { ...value.view, step, notice: null, back: step === 'options' ? (value.view.step === 'grant' ? 'grant' : 'ladder') : value.view.back } } : value))
  if (view.view.kind !== 'card') return
  if (step === 'grant') await dgFillRepos($, view.view.dialogId) // ── delegate ──
  await moveRing($, ring ?? (step === 'ladder' ? 'key:start' : `key:start:${step}`))
}

/** `e` on the card: the repos field on the grant, else the brief's first field, in the options. */
async function apEditField($: $): Promise<void> {
  const view = (await read($, autopilot)).view
  if (view.kind !== 'card' || view.step === 'warning') return
  if (view.step === 'grant') return moveRing($, 'dg:repos')
  if (view.step === 'options') return moveRing($, 'ap:tone')
  await apStep($, 'options', 'ap:tone')
}

/** The card's facts for the key table: its step, and what ⏎ does now (the bar's label). */
async function cardFacts($: $, view: Extract<ApView, { kind: 'card' }>, peer: PeerRef): Promise<CardFacts> {
  const action = await apCardActionNow($, view, peer)
  return { step: view.step, enter: actionLabel(action, view.pick, view.step), isDelegate: view.pick === 'delegate' }
}

/** `h` on the card: the options back to where `o` came from, the warning and the grant back to the ladder, the ladder closes. */
async function apCardBack($: $): Promise<void> {
  const view = (await read($, autopilot)).view
  if (view.kind !== 'card') return
  if (view.step === 'ladder') {
    await update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
    return
  }
  await apStep($, view.step === 'options' ? view.back : 'ladder')
}

/** A digit on the ladder: picks the rung; 5 goes on to delegate's warning (once per chat) or its grant. */
async function apPick($: $, rung: ApRung): Promise<void> {
  const view = (await read($, autopilot)).view
  if (view.kind !== 'card') return
  await update($, autopilot, value => (value.view.kind === 'card' ? { ...value, view: { ...value.view, pick: rung, notice: null } } : value))
  if (rung === 'delegate') await apStep($, (await dgSettings($, view.dialogId)).isWarned ? 'grant' : 'warning') // ── delegate ──
}

/** A change from the card: kept in $.state and $.store at once. */
async function apEdit($: $, dialogId: number, change: (dialog: ApDialog) => ApDialog): Promise<void> {
  const next = await update($, autopilot, value => {
    const current = value.dialogs[String(dialogId)]
    return current === undefined ? value : { ...value, dialogs: { ...value.dialogs, [String(dialogId)]: change(current) } }
  })
  await $.store.set(STORE_AUTOPILOT, next.dialogs)
}

/** What the card's ⏎ does now, from what is held (the allowlist as last read, the guard's last answer). */
async function apCardActionNow($: $, view: Extract<ApView, { kind: 'card' }>, peer: PeerRef): Promise<CardAction> {
  return cardAction({
    step: view.step,
    pick: view.pick,
    running: await runningRungOf($, peer.id),
    allow: apAllowView(peer, (await read($, bottest)).allow),
    isGuardUp: (await dgGuardArmed($)) !== null, // ── delegate ──
    isWarned: (await dgSettings($, peer.id)).isWarned, // ── delegate ──
  })
}

/**
 * ⏎ on the card: stop the rung that runs, start or switch to the one picked,
 * or the step it needs first. A rung that sends alone reads allow.toml once
 * more before it says no (§2.4's stale cache, T0c), so an allow run in the
 * prompt since is seen; a read that failed is read again, as `g` does.
 */
async function apCardEnter($: $): Promise<void> {
  const view = (await read($, autopilot)).view
  if (view.kind !== 'card') return
  const dialog = await apDialog($, view.dialogId)
  if (dialog === null) return
  const { peer } = dialog
  let action = await apCardActionNow($, view, peer)
  const isStale = action.kind === 'allow' || action.kind === 'retry' || action.kind === 'reading'
  if (isStale) {
    await loadAllow($)
    action = await apCardActionNow($, view, peer)
  }
  switch (action.kind) {
    case 'done':
      return apCardBack($)
    case 'reading':
    case 'retry':
      return
    case 'warn':
      return apStep($, 'warning')
    case 'grant':
      if (view.step === 'warning') await dgEdit($, peer.id, dg => ({ ...dg, isWarned: true })) // ── delegate ── the owner read the warning
      return apStep($, 'grant')
    case 'allow': {
      if (!(await apAskAllow($, peer, view.pick))) return
      // The chat is in allow.toml now: ⏎ goes straight on to the level (start, switch, or delegate's guard).
      const next = await apCardActionNow($, view, peer)
      if (next.kind === 'allow') return apNotice($, `tg allow add ran, but tg allow list does not show ${peer.arg}: nothing started.`)
      return apCardEnter($)
    }
    case 'guard':
      return apNotice($, `Not started: ${await dgGuardText($)}`)
    case 'stop':
      await apStopRung($, dialog)
      $.ui.toast(`tg: ${RUNG_NAME[view.pick]} off for ${peer.label}.`)
      return refreshStatus($)
    case 'start':
    case 'switch': {
      const refused = await apStartRung($, dialog, view.pick)
      if (refused !== null) return apNotice($, `Not started: ${refused}`)
      await update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
      const off = action.kind === 'switch' ? ` (${RUNG_NAME[action.from]} off)` : ''
      $.ui.toast(`tg: ${RUNG_GLYPH[view.pick]} ${RUNG_NAME[view.pick]} on for ${peer.label}${off}. 0 or /tg stop stops every chat.`)
      return refreshStatus($)
    }
  }
}

/**
 * §9 decision 1 as amended by the owner: the chat goes into allow.toml only
 * on the owner's explicit Yes in the engine's dialog, raised by the card's ⏎
 * alone (No listed first). The argv is built once, shown verbatim and run as
 * shown. A dismissal, a timeout, any other answer and a `-p` run (ask rejects:
 * nobody to ask) run nothing, and so does a Yes once the card shows another
 * chat (the answer was for the chat captured at ⏎). After the add the list
 * is read again; the level starts only if the chat is listed then. Answers
 * whether the chat was added.
 */
async function apAskAllow($: $, peer: PeerRef, rung: ApRung): Promise<boolean> {
  const argv = allowArgv(peer.arg)
  let answer: string | null
  try {
    answer = await $.ui.ask(allowQuestion(peer.label, rung, argv), { options: [ALLOW_NO, ALLOW_YES], header: 'allow.toml' })
  } catch {
    // Dismissed, timed out, or a -p run: no answer is a no.
    answer = null
  }
  await takeKeysBack($)
  if (answer === null) {
    await apNotice($, `Not added: nobody said yes, so ${peer.label} stays out of allow.toml.`)
    return false
  }
  const view = (await read($, autopilot)).view
  if (view.kind !== 'card' || view.dialogId !== peer.id) {
    $.ui.toast(`tg: not added: the card had moved on from ${peer.label} when you answered.`)
    return false
  }
  if (answer !== ALLOW_YES) {
    await apNotice($, `Not added: ${peer.label} stays out of allow.toml.`)
    return false
  }
  await apNotice($, `${GLYPH.working}adding ${peer.label}: ${argv.join(' ')}`)
  let ran: ProcessRunResult
  try {
    ran = await $.process.run(argv, { timeoutMs: TG_TIMEOUT_MS })
  } catch (error) {
    await apNotice($, `${GLYPH.error} tg allow add did not run: ${reasonOf(error)}`)
    return false
  }
  if (ran.exitCode !== 0) {
    // tg's own refusal (`readonly = true` among them), as it says it.
    await apNotice($, `${GLYPH.error} ${failureText(failureOf(ran.exitCode, ran.stderr), await $.clock.now())}`)
    return false
  }
  const level: ApLevel = rung === 'follow' ? 'auto' : rung
  await apLog($, { at: await $.clock.now(), peer, level, incoming: [], reply: argv.join(' '), confidence: null, topics: [], checks: [], outcome: { kind: 'allowed', line: allowedLine(peer.label, peer.arg) }, undo: null })
  await apNotice($, null)
  await loadAllow($)
  return true
}

/**
 * When the engine's dialog settles, the keys go to the prompt, not back to
 * the pane (seen live on 2.1.296: after `a 4 ⏎ 2` the header read
 * `ctrl+x tab: keys`, and `j j ⏎` would have sent "jj" to main). The pane's
 * own open call asks for them back; the engine grants focus only while the
 * prompt holds the keys over an empty box, so a draft the owner typed keeps
 * them. $.ui.focus would not do: it is denied while the site lacks the keys.
 */
async function takeKeysBack($: $): Promise<void> {
  try {
    await $.ui.open(PANE_OPEN)
  } catch {
    // Refused (no surface, or the engine kept the keys): the owner's ctrl+x tab still brings them back.
  }
}

/** Stops whatever rung runs in the chat: its follow, or its autopilot (and with it its Worker, apUnlisten → dgStopTasksOf). */
async function apStopRung($: $, dialog: ApDialog): Promise<void> {
  const id = dialog.peer.id
  if ((await read($, pins)).some(pin => pin.peer.id === id)) await unpin($, id) // ── routing ──
  if (!(await read($, autopilot)).running.includes(id)) return
  await apUnlisten($, id)
  await update($, autopilot, value => ({ ...value, running: value.running.filter(one => one !== id), phase: { ...value.phase, [String(id)]: 'listening' } }))
}

/**
 * Starts `rung` in the chat, stopping the rung that ran there first (one per
 * chat, decision 2). The lease is taken before anything stops, so a chat that
 * runs in another session keeps what runs here. Answers why it did not start.
 */
async function apStartRung($: $, dialog: ApDialog, rung: ApRung): Promise<string | null> {
  const id = dialog.peer.id
  if (rung === 'follow') {
    await apStopRung($, dialog)
    await followPeer($, dialog.peer) // ── routing ──
    return null
  }
  // ── delegate ── one session answers a chat: the lease in $.store says which.
  const lease = await apTakeLease($, id)
  if (!lease.ok) return `${dialog.peer.label} is ${lease.reason}. Stop it there first.`
  // Stopping an autopilot level lets its lease go: take it again, which this session may (it held it a moment ago).
  await apStopRung($, dialog)
  const again = await apTakeLease($, id)
  if (!again.ok) return `${dialog.peer.label} is ${again.reason}. Stop it there first.`
  await apEdit($, id, one => ({ ...one, level: rung }))
  await update($, autopilot, value => ({ ...value, running: [...value.running.filter(one => one !== id), id] }))
  await apListen($, dialog.peer)
  return null
}

/**
 * The autopilot's half of the kill switch (stopEverything): the Workers first,
 * then every dialog stops listening, every timer and model call is cut. Each
 * part is settled on its own, so one that throws (a watch that will not end)
 * stops nothing else from stopping; answers what failed.
 */
async function apStopAll($: $): Promise<string[]> {
  const failed: string[] = []
  failed.push(...(await dgStopAll($, 'kill switch'))) // ── delegate ──
  const state = await read($, autopilot)
  const ended = await Promise.allSettled(state.running.map(id => apUnlisten($, id)))
  ended.forEach((result, index) => {
    const id = state.running[index] ?? 0
    if (result.status === 'rejected') failed.push(`${state.dialogs[String(id)]?.peer.label ?? id} (autopilot): ${reasonOf(result.reason)}`)
  })
  await update($, autopilot, value => ({ ...value, running: [], phase: {} }))
  await refreshStatus($)
  return failed
}

/** `/tg autopilot [off]`; `off` is `/tg stop`'s old name and does the same. */
async function autopilotCommand($: $, args: string): Promise<{ text: string }> {
  if (args === 'off') return { text: stopAnswer(await stopEverything($)) } // ── running ──
  if (args.startsWith(SKIP_FLAG)) return dgSkipCommand($, args) // ── delegate ──
  if (args !== '') return { text: `Usage: /tg autopilot [off | ${SKIP_FLAG}[=publish,delete]]` }
  const state = await read($, autopilot)
  const lines = state.running.flatMap(id => {
    const dialog = state.dialogs[String(id)]
    return dialog === undefined ? [] : [`${LEVEL_GLYPH[dialog.level]} ${dialog.peer.label}: ${dialog.level}, ${rateText(dialog.perHour)}, ${state.phase[String(id)] ?? 'listening'}`]
  })
  lines.push(...(await dgTaskLines($))) // ── delegate ──
  return { text: lines.length === 0 ? 'tg autopilot: off. Open a chat in the pane and press a.' : ['tg autopilot:', ...lines].join('\n') }
}

/** The card in the lower part (dock) or the body (inline) while it is open: its step's layer. */
async function drawCard($: $, els: Els, width: number): Promise<RenderElement | null> {
  const state = await read($, autopilot)
  const view = state.view
  if (view.kind === 'none') return null
  const dialog = state.dialogs[String(view.dialogId)]
  if (dialog === undefined) return null
  const id = dialog.peer.id
  const edit = (change: (one: ApDialog) => ApDialog) => apEdit($, id, change)
  const allow = apAllowView(dialog.peer, (await read($, bottest)).allow)
  const isGuardUp = (await dgGuardArmed($)) !== null // ── delegate ──
  switch (view.step) {
    case 'ladder': {
      const pin = await read($, pins)
      const chosen = await read($, route) // ── routing ── where a follow sends the chat
      const followed = pin.find(one => one.peer.id === id)
      const to = followed?.to ?? (chosen.kind === 'one' && chosen.to.kind === 'agent' ? { kind: 'agent' as const, label: chosen.to.label } : { kind: 'main' as const })
      return CardLadder(els, {
        dialog,
        kind: cardKind(dialog.peer),
        ladder: ladderFor(cardKind(dialog.peer)),
        pick: view.pick,
        running: await runningRungOf($, id),
        allow,
        isGuardUp,
        followTo: to.kind === 'main' ? 'main, every turn' : to.label,
        notice: view.notice,
        width,
        onPick: rung => apPick($, rung),
      })
    }
    case 'options':
      return CardOptions(els, {
        dialog,
        notice: view.notice,
        // ── delegate ── the danger zone, in person chats (where delegate exists).
        extra: ladderFor(cardKind(dialog.peer)).includes('delegate') ? await drawDangerZone($, els, dialog) : null,
        onRate: value => edit(one => ({ ...one, perHour: value === 'none' ? null : Number(value) })),
        onGap: value => edit(one => ({ ...one, gapS: Number(value) })),
        onConf: value => edit(one => ({ ...one, threshold: Number(value) })),
        onQuiet: async value => {
          const parsed = parseQuiet(value)
          if (parsed.ok) await edit(one => ({ ...one, quiet: parsed.value }))
        },
        onTopic: (topic: ApTopic) => edit(one => ({ ...one, topics: toggleTopic(one.topics, topic) })),
        onBrief: (field, text) => edit(one => ({ ...one, brief: { ...one.brief, [field]: text.trim() } })),
      })
    case 'warning':
      return DelegateWarning(els, { label: dialog.peer.label }) // ── delegate ──
    case 'grant':
      return drawGrant($, els, dialog, allow, isGuardUp, view.notice) // ── delegate ──
  }
}

/** DialogRow's level mark for running dialogs: the glyph, and `auto 3/50` (sent this hour / limit). */
async function autopilotMarks($: $): Promise<(dialogId: number) => { glyph: string; tail: string; warn?: string } | undefined> {
  const state = await read($, autopilot)
  const noStopsOf = await dgNoStopsOf($) // ── delegate ──
  const at = Math.max(state.now, await $.clock.now())
  return dialogId => {
    const dialog = state.dialogs[String(dialogId)]
    if (dialog === undefined || !state.running.includes(dialogId)) return undefined
    const tail = apLevelTail(state, dialog, at)
    const warn = dialog.level === 'delegate' ? noStopsOf(dialogId) : null // ── delegate ──
    return warn === null ? { glyph: LEVEL_GLYPH[dialog.level], tail } : { glyph: LEVEL_GLYPH[dialog.level], tail, warn }
  }
}

/** `auto 3/50` (sent this hour / the limit) for auto, the level's name for the others. */
function apLevelTail(state: Autopilot, dialog: ApDialog, at: number): string {
  return dialog.level === 'auto' ? `auto ${sentLastHour(state.ledger, dialog.peer.id, at)}/${dialog.perHour ?? '∞'}` : dialog.level
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
import { DangerZone, DelegateGrant, DelegateWarning, TaskCard, TaskRow, chatCardLines, chatTaskRows } from './delegate/components'
import { armedOf, eventsOf, holdsOf as guardHoldsOf, workOf } from './delegate/guard'
import { CHECK_FILES, DEFAULT_DG_DIALOG, DG_WEB, checksOf, parseDgDialogs, parseDuration, parseRepos, workerTools } from './delegate/grant'
import { HEARTBEAT_MS, holder, leaseKey, leaseOf } from './delegate/lease'
import { resolvePath } from './delegate/paths'
import { SKIP_FLAG, noStopsLabel, parseDialogSkip, parseSkipFlag, parseStops, skippedStops, untilText } from './delegate/skip'
import { delegateInstructions, delegateSystem, parseDelegate, relayPrompt, type DelegateSpoken, type TaskAction } from './delegate/speaker'
import { partition, stopQuestion, textHits, type StopHit } from './delegate/stops'
import {
  branchOf,
  elapsedText,
  isLive,
  parseWorker,
  taskLine,
  taskWhere,
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
  dgSessionRepo = null
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
    $.ui.toast(`tg: ↯ every Worker stopped: the ${GUARD} plugin stopped answering.`)
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
  return (await dgGuardArmed($)) === null ? `delegate needs the ${GUARD} plugin loaded and answering: it holds the Worker's hard stops. Enable it, then press ⏎ again.` : null
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

/** The session's repo (`git rev-parse --show-toplevel` in its directory), once looked up; null: not in a repo. */
let dgSessionRepo: { path: string | null } | null = null

/**
 * The grant step's repos, filled from where the owner is (§5.5): the session's
 * repo when its directory is in one and the chat grants none yet.
 */
async function dgFillRepos($: $, dialogId: number): Promise<void> {
  if ((await dgSettings($, dialogId)).grant.repos.length > 0) return
  if (dgSessionRepo === null) {
    const cwd = await $.session.cwd()
    const top = await dgGit($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
    dgSessionRepo = { path: top.ok && top.stdout.trim() !== '' ? top.stdout.trim() : null }
  }
  const path = dgSessionRepo.path
  if (path !== null) await dgEditGrant($, dialogId, grant => ({ ...grant, repos: [path] }))
}

async function drawGrant($: $, els: Els, dialog: ApDialog, allow: AllowView, isGuardUp: boolean, notice: string | null): Promise<RenderElement> {
  const id = dialog.peer.id
  const state = await read($, delegate)
  const dg = state.dialogs[String(id)] ?? DEFAULT_DG_DIALOG
  const at = await $.clock.now()
  const skipped = dg.skip === null || (dg.skip.until !== null && dg.skip.until <= at) ? null : `skipped: ${dg.skip.stops.join(', ')} (${untilText(dg.skip.until)}) · o: limits & safety`
  return DelegateGrant(els, {
    dg,
    label: dialog.peer.label,
    arg: dialog.peer.arg,
    sessionRepo: dgSessionRepo?.path ?? null,
    skipped,
    noStops: (await dgNoStopsOf($))(id),
    isGuardUp,
    guardText: `the ${GUARD} plugin is not loaded or not answering: it holds the Worker's hard stops`,
    allow,
    notice,
    onRepos: text => dgEditGrant($, id, grant => ({ ...grant, repos: parseRepos(text) })),
    onWeb: value => dgEditGrant($, id, grant => ({ ...grant, web: DG_WEB.find(one => one === value) ?? grant.web })),
    onCommands: value => dgEditGrant($, id, grant => ({ ...grant, commands: value === 'any' ? 'any' : 'checks' })),
    onDuration: async value => {
      const parsed = parseDuration(value)
      if (parsed.ok) await dgEditGrant($, id, grant => ({ ...grant, duration: parsed.value }))
    },
  })
}

/** `o`'s danger zone: dangerouslySkipHardStops for this chat, confirmed only by its name typed exactly. */
async function drawDangerZone($: $, els: Els, dialog: ApDialog): Promise<RenderElement> {
  const id = dialog.peer.id
  const state = await read($, delegate)
  return DangerZone(els, {
    dg: state.dialogs[String(id)] ?? DEFAULT_DG_DIALOG,
    label: dialog.peer.label,
    pending: state.pending?.dialogId === id ? state.pending : null,
    now: await $.clock.now(),
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
      if (text.trim() !== dialog.peer.label) return apNotice($, `Not confirmed: type the chat's name exactly, "${dialog.peer.label}".`)
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
    $.ui.toast(`tg: ↯ the answer did not reach the Worker for ${task.peer.label}: ${sent.reason}`)
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
    $.ui.toast(`tg: ↯ the task for ${peer.label} did not start: ${reason}`)
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
      description: `↯ ${peer.label}: ${oneLine(summary, 40)}`,
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

/** The kill switch's half: every Worker, each settled on its own; answers the ones that failed. */
async function dgStopAll($: $, reason: string): Promise<string[]> {
  const live = (await read($, delegate)).tasks.filter(isLive)
  const ended = await Promise.allSettled(live.map(task => dgStopTask($, task.id, reason)))
  return ended.flatMap((result, index) => (result.status === 'rejected' ? [`${live[index]?.peer.label ?? '?'} (its Worker): ${reasonOf(result.reason)}`] : []))
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
    $.ui.toast(`tg: ↯ the Worker for ${task.peer.label} stopped: ${reason}.`)
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
  const peer = peerOf(task.peer, await knownDialogs($))
  const packet = buildPacket({ messages: messages.slice(-1), context: messages.slice(0, -1), peer, intent: { id: 'raw', text: '' }, redact: false, replay: false }).text
  const result = await $.model.complete({ model: speakerModel, system: delegateSystem(dialog), prompt: relayPrompt({ said, task, packet }), maxTokens: SPEAKER_MAX_TOKENS, timeoutMs: SPEAKER_TIMEOUT_MS })
  const at = await $.clock.now()
  const incoming = [{ id: 0, text: `Worker ${said.kind.toUpperCase()}: ${said.text}` }]
  const spoken = result.isAnswered ? parseSpoken(result.text) : null
  if (spoken === null || spoken.text === '') {
    const why = result.isAnswered ? 'the Speaker answered in a shape the autopilot cannot read' : modelFailure(result)
    await apLog($, { at, peer: task.peer, level: dialog.level, incoming, reply: '', confidence: null, topics: [], checks: [], outcome: { kind: 'failed', reason: why }, undo: null })
    $.ui.toast(`tg: ↯ could not tell ${task.peer.label} what the Worker said: ${why}`)
    return
  }
  const seq = await apLog($, { at, peer: task.peer, level: dialog.level, incoming, reply: spoken.text, confidence: spoken.confidence, topics: spoken.topics, checks: [], outcome: { kind: 'working' }, undo: null })
  const toDraft = async (reasons: string[]) => {
    // A row of its chat, after its newest message, checked by the guard as it lands (§8 T3).
    const after = await newestIn($, task.peer.id, 0)
    const draft: ApDraft = { seq, peer: task.peer, incoming: incoming[0]?.text ?? '', text: spoken.text, confidence: spoken.confidence, reasons, state: { kind: 'ready' }, check: { kind: 'checking' }, at: await $.clock.now(), after }
    await keepThreadCursor($, () => update($, autopilot, value => ({ ...value, drafts: putDraft(value.drafts, draft), ledger: patchEntry(value.ledger, seq, { outcome: { kind: 'drafted', reasons } }) })))
    await refreshStatus($)
    await apCheckDraft($, seq)
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

/**
 * The status line's delegate alarms (§4.1): the first hard stop waiting, and
 * stops skipped while a delegate runs; and every hard stop waiting, for the
 * band and its notification (── footer ──).
 */
async function dgAlarms($: $): Promise<{ line: string | null; noStops: string | null; holds: BandHold[] }> {
  const state = await read($, delegate)
  const guard = await dgGuardView($)
  const live = state.tasks.filter(isLive)
  const holds = live.flatMap(task => [
    ...task.holds.map(hold => ({ key: `hold:s:${task.id}:${hold.id}`, peer: task.peer, stops: hold.stops, what: hold.what })),
    ...guard.holds.filter(hold => hold.taskId === task.id).map(hold => ({ key: `hold:g:${task.id}:${hold.id}`, peer: task.peer, stops: hold.stops, what: hold.what })),
  ])
  const held = holds[0]
  const line = held === undefined ? null : `tg ⏸ HARD STOP ${held.stops.join(' + ')}: ${oneLine(held.what, 50)} · ${LEVEL_GLYPH.delegate} ${held.peer.label} · answer in the dialog`
  const pilot = await read($, autopilot)
  const noStopsOf = await dgNoStopsOf($)
  const marks = pilot.running.filter(id => pilot.dialogs[String(id)]?.level === 'delegate').map(noStopsOf)
  return { line, noStops: marks.find((one): one is string => one !== null) ?? null, holds }
}

/** A task's waiting stops: the Speaker's (on the task) and the Worker's (the guard's). */
function holdsOfView(task: DgTask, guard: { holds: readonly GuardHold[] }): { stops: readonly string[]; what: string }[] {
  return [...task.holds, ...guard.holds.filter(hold => hold.taskId === task.id)]
}

/** Hard stops waiting for the owner, for the header's "for you". */
async function dgHoldCount($: $): Promise<number> {
  const guard = await dgGuardView($)
  return (await read($, delegate)).tasks.filter(isLive).reduce((sum, task) => sum + holdsOfView(task, guard).length, 0)
}

/**
 * The open chat's task, on top of its thread: docked, the card with lines from
 * the lower part's height (`lower`, fixed for the view), or one line when the
 * card would get fewer than two; inline, one line. A delegate chat keeps those
 * rows whether a task runs or not, so a task that starts while the cursor is in
 * the thread does not shrink the thread's window, which would move rows above
 * the cursor (§4.3 rule 1). Text only; a finished card stays until `d` in Activity.
 */
async function drawChatTask($: $, els: Els, width: number, seat: Seat, lower: number): Promise<{ elements: RenderElement[]; rows: number }> {
  const open = await read($, thread)
  if (open === null || (await apDialog($, open.peer.id))?.level !== 'delegate') return { elements: [], rows: 0 }
  const lines = seat === 'dock' ? chatCardLines(lower) : 0
  const rows = chatTaskRows(lines)
  const tasks = (await read($, delegate)).tasks.filter(task => task.peer.id === open.peer.id)
  const task = tasks.findLast(isLive) ?? tasks.at(-1)
  if (task === undefined) return { elements: [], rows }
  const guard = await dgGuardView($)
  const noStops = (await dgNoStopsOf($))(task.peer.id)
  const view = viewOf(task, guard)
  const element = rows > 1 ? TaskCard(els, { task, view, now: await $.clock.now(), width, lines, noStops }) : TaskRow(els, { task, view, noStops })
  return { elements: [element], rows }
}

/** Every task not dismissed, for the running rows (../ui/running): live or ended, held, and where it is. */
async function dgTaskRuns($: $, at: number): Promise<RunInput['tasks']> {
  const guard = await dgGuardView($)
  return (await read($, delegate)).tasks.map(task => ({
    peer: task.peer,
    isLive: isLive(task),
    isHeld: holdsOfView(task, guard).length > 0,
    tail: `task ${elapsedText(task.startedAt, at)} · ${taskWhere(task, viewOf(task, guard))}`,
  }))
}

/** `d` in Activity: the tasks that ended leave it, and their cards leave their chats. */
async function dgDismissEnded($: $): Promise<void> {
  await dgUpdate($, value => ({ ...value, tasks: value.tasks.filter(isLive) }))
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

// ── running ──
// dialogs-pane-ux.md §5.6 and §5.7 (T4): what runs, read as one row per chat
// (./ui/running), for the dock's running strip, Activity (`l`) and the kill
// switch (`0`, `/tg stop`), which stops every follow, autopilot and Worker
// and says what it stopped, by name. Every `$` call of it is here.
import { Activity, RunningStrip } from './ui/activity'
import {
  activityOrder,
  activityTarget,
  activityText,
  fitStrip,
  isRunning,
  mergedLog,
  runRows,
  stopAnswer,
  STOP_LABEL,
  stopNotice,
  stoppedOf,
  stripItems,
  type RunInput,
  type RunRow,
  type StopReport,
} from './ui/running'

const activity = atom({ plugin: 'dialogs-pane', key: 'activity' } as const, null)
const lastStop = atom({ plugin: 'dialogs-pane', key: 'lastStop' } as const, null)

/** The dock keeps the strip's row whether it shows or not (see drawPane). */
const RUNNING_ROWS = 1
/** How long the dock's strip row says what `0` stopped. */
const STOP_NOTICE_MS = 15_000

let stopTimer: Timer | null = null

/** What runs now, a row per chat: the autopilot's dialogs, the follows, the tasks not dismissed. */
async function runRowsNow($: $): Promise<RunRow[]> {
  const pilot = await read($, autopilot)
  const at = Math.max(pilot.now, await $.clock.now())
  const agents = pilot.running.flatMap(id => {
    const dialog = pilot.dialogs[String(id)]
    return dialog === undefined ? [] : [{ peer: dialog.peer, level: dialog.level, tail: apLevelTail(pilot, dialog, at), phase: pilot.phase[String(id)] ?? 'listening' }]
  })
  const follows = (await read($, pins)).map(pin => ({ peer: pin.peer, to: pin.to.kind === 'main' ? 'main' : pin.to.label, state: pin.watch.status }))
  return runRows({ agents, follows, tasks: await dgTaskRuns($, at) })
}

/**
 * The kill switch (§5.6): every Worker (TaskStop) and autopilot, then every
 * follow; the settings stay, so the card restarts one. What stopped is read
 * first, so the answer names it. Each part is settled on its own: one that
 * throws is named in the answer and stops nothing else from stopping.
 */
async function stopEverything($: $): Promise<StopReport> {
  const stopped = stoppedOf(await runRowsNow($))
  const failed = await apStopAll($)
  const follows = await read($, pins)
  const unpinned = await Promise.allSettled(follows.map(pin => unpin($, pin.peer.id)))
  unpinned.forEach((result, index) => {
    if (result.status === 'rejected') failed.push(`${follows[index]?.peer.label ?? '?'} (follow): ${reasonOf(result.reason)}`)
  })
  if (stopped.length > 0 || failed.length > 0) {
    const at = await $.clock.now()
    stopTimer?.cancel()
    await update($, lastStop, () => ({ names: stopped.map(one => one.label), failed: failed.length, until: at + STOP_NOTICE_MS }))
    stopTimer = $.clock.after(STOP_NOTICE_MS, () => {
      stopTimer = null
      update($, lastStop, () => null).catch(() => {
        // The strip draws a notice only before its `until`, so one left behind shows nothing.
      })
    })
  }
  await refreshStatus($)
  return { stopped, failed }
}

/** The dock's strip: what runs, `0: stop all` beside it; after `0`, what stopped. Null: nothing to say. */
async function drawRunningStrip($: $, els: Els, width: number, withMoved: boolean): Promise<RenderElement | null> {
  const items = stripItems(await runRowsNow($))
  // A notice takes the row's left part; `0: stop all` keeps its place while something runs (T4b).
  // `withMoved`: no folder strip shows (the Folders list, For you), so what waits for the owner's move rides here (── folders ──).
  const room = width - (items.length > 0 ? STOP_LABEL.length + 2 : 0)
  const notice = (await noticeNow($, room)) ?? (withMoved ? await movedNotice($) : null)
  if (items.length === 0 && notice === null) return null
  return RunningStrip(els, { ...fitStrip(items, width), notice, isRunning: items.length > 0 })
}

/** What `0` stopped, fitted to `width`, while its 15 s last. */
async function stopNoticeNow($: $, width: number): Promise<Notice | null> {
  const notice = await read($, lastStop)
  if (notice === null || notice.until <= (await $.clock.now())) return null
  return { tone: 'danger', text: stopNotice(notice.names, notice.failed, width) }
}

// --- Activity ---

/** Activity's rows as drawn: the ones it had, then the chats that started since. */
async function activityRows($: $): Promise<PeerRef[]> {
  const view = await read($, activity)
  return view === null ? [] : activityOrder(view, await runRowsNow($))
}

/** `l`, from the chats, a chat or the card (which it closes): running rows on top, the log below. */
async function openActivity($: $): Promise<void> {
  await update($, autopilot, value => ({ ...value, view: { kind: 'none' } }))
  const rows = await runRowsNow($)
  await update($, activity, () => ({ rows: activityOrder({ rows: [], cursor: 0 }, rows), cursor: 0 }))
  const at = await $.clock.now()
  await update($, now, () => at)
  // The radar settles the packets' states (… working, ✓ done) the log shows.
  await refreshRadar($)
  await ringActivity($)
}

async function ringActivity($: $): Promise<void> {
  const view = await read($, activity)
  const row = view?.rows[view.cursor]
  if (row !== undefined) await moveRing($, `act:${row.id}`)
}

/** j and k among the running rows; the rows that started since are kept in their order first. */
async function moveActivity($: $, by: number): Promise<string | undefined> {
  const rows = await activityRows($)
  const view = await update($, activity, value => (value === null ? null : { rows, cursor: clamp(value.cursor + by, rows.length) }))
  const row = view?.rows[view.cursor]
  return row === undefined ? undefined : `act:${row.id}`
}

/** The ring moved onto a running row (arrows, a click): the cursor follows. */
async function followActivity($: $, chatId: number): Promise<void> {
  const rows = await activityRows($)
  const index = rows.findIndex(row => row.id === chatId)
  if (index >= 0) await update($, activity, value => (value === null ? null : { rows, cursor: index }))
}

/** ⏎ on a running row: its agent card, or its chat, where a task's card sits on top of the thread. */
async function openActivityRow($: $, index: number): Promise<void> {
  const rows = await activityRows($)
  const peer = rows[index]
  if (peer === undefined) return
  const row = (await runRowsNow($)).find(one => one.peer.id === peer.id) ?? null
  await update($, activity, () => null)
  if (activityTarget(row) === 'card') return apOpenCard($, peer)
  await apOpen($, peer)
}

/** `d` in Activity: the tasks that ended go; their rows stay, drawn stopped, until it closes. */
async function dismissEnded($: $): Promise<void> {
  const rows = await activityRows($)
  await update($, activity, value => (value === null ? null : { ...value, rows }))
  await dgDismissEnded($)
  await ringActivity($)
}

async function drawActivity($: $, els: Els, width: number, rows: number): Promise<RenderElement> {
  const view = await read($, activity)
  const live = await runRowsNow($)
  const order = view === null ? [] : activityOrder(view, live)
  const byId = new Map(live.map(row => [row.peer.id, row]))
  const pilot = await read($, autopilot)
  const at = Math.max(pilot.now, await read($, now), await $.clock.now())
  const watched = (await read($, triage)).watched.map(peer => peer.label)
  const entries = await dgLedger($, pilot.ledger, pilot.dialogs) // ── delegate ── with the guard's stop events
  return Activity(els, {
    rows: order.map(peer => {
      const row = byId.get(peer.id) ?? null
      return { id: peer.id, text: activityText(row, peer.label), isStopped: row === null || !isRunning(row) }
    }),
    cursor: clamp(view?.cursor ?? 0, order.length),
    watching: watched.length === 0 ? null : watched.join(' · '),
    log: mergedLog(await read($, ledger), entries, at, width),
    rowsLeft: rows,
    width,
    onOpen: index => openActivityRow($, index),
  })
}
// ── /running ──

// ── folders ──
// dialogs-pane-ux.md §4.7 and §8 T9: the owner's Telegram folders, For you and
// Bots in Chats' place, all from one pass (`tg folders --chats --json`). The
// pass's rows stay in the module (`passHeld`); $.state holds only what is
// drawn (the folder list, the view's rows cut to 120 characters); $.store the
// list, the current view and its rows for the next session. A list on screen
// changes in place while the cursor stays; what moves, joins or leaves waits
// (`↑N`) for the owner's next move: ⏎ into a chat, h, a folder or view switch,
// g, opening the pane (§4.3). Keys (./ui/keys): 1–9 folder, h up to the
// Folders list, y For you, g reload. Pure rules in ./folders.
import type { AgentItem, Folder, Folders, ForYouWhy, ListView, Nav, Notice as PaneNotice } from '../types'
import { FoldersList, ForYouList, forYouTextRoom, type FolderItem, type ForYouItem } from './folders/components'
import {
  HIDDEN_GAP_MS,
  NO_PASS,
  PASS_GAP_MS,
  agentItems,
  agentKey,
  bump,
  cutRow,
  folderList,
  forYouCandidates,
  forYouPeople,
  nextAllowed,
  parseStored,
  passMap,
  passPlan,
  recount,
  sameView,
  stripEntries,
  stripWindow,
  tabText,
  viewRows,
  waitingCount,
  type PassMap,
  type StoredFolders,
} from './folders/folders'
import { cells, dialogGlyph, shortTime } from './ui/model'

const NO_FOLDERS: Folders = { list: null, gen: 0, agents: [], why: {}, isRanking: false, pass: NO_PASS }
const folders = atom({ plugin: 'dialogs-pane', key: 'folders' } as const, NO_FOLDERS)
const STORE_FOLDERS = 'folders'

/** The last pass (§8 T9 a). A hot reload drops it; the next pass fills it again. */
let passHeld: PassMap | null = null
/** The next pass's timer (the cadence, a queued `g`, a flood wait's end), and the countdown a notice shows. */
let passNext: Timer | null = null
let passCountdown: Timer | null = null
/** What this module last wrote to $.store, so an unchanged view is not written again. */
let lastStored = ''
/** For you's width as last drawn: ⏎ sends a draft only when its whole text fit its row there (decision 9). */
let forYouWidth = 0

/** One row in Chats' place: a chat, or one of For you's agent rows. */
type ListRow = { kind: 'chat'; dialog: TgDialog } | { kind: 'agent'; item: AgentItem }

const rowId = (row: ListRow) => (row.kind === 'chat' ? `chat:${row.dialog.id}` : `agent:${agentKey(row.item)}`)

/** A row's key: the list's generation is part of it, so a reshaped list brings keys the old drawing lacks (§8 T9). */
function rowKey(gen: number, row: ListRow): string {
  return row.kind === 'chat' ? `dialog:${gen}:${row.dialog.id}` : `fy:${gen}:${agentKey(row.item)}`
}

async function startFolders($: $): Promise<void> {
  // A pass running across a hot reload ended with the old module; its start still counts for the 60 s.
  await update($, folders, value => ({ ...value, pass: { ...value.pass, isRunning: false } }))
  await armNext($)
}

/** Every chat the pane knows: the view on screen, then the last pass. */
async function knownDialogs($: $): Promise<TgDialog[]> {
  const shown = loaded(await read($, dialogs)) ?? []
  if (passHeld === null) return shown
  const ids = new Set(shown.map(one => one.id))
  return [...shown, ...[...passHeld.rows.values()].filter(one => !ids.has(one.id))]
}

const isForYou = (where: Pick<Nav, 'list' | 'query'>) => where.list.kind === 'foryou' && where.query === ''

/** The rows in Chats' place as drawn: For you's agent rows first, then the chats. */
async function listRows($: $): Promise<ListRow[]> {
  const chats = (loaded(await read($, dialogs)) ?? []).map((dialog): ListRow => ({ kind: 'chat', dialog }))
  if (!isForYou(await read($, nav))) return chats
  return [...(await read($, folders)).agents.map((item): ListRow => ({ kind: 'agent', item })), ...chats]
}

async function cursorRow($: $): Promise<ListRow | undefined> {
  const rows = await listRows($)
  return rows[clamp((await read($, nav)).dialogCursor, rows.length)]
}

/** The dock's top shows Chats (and the strip) unless the Folders list or For you takes their place. */
async function chatsOnTop($: $): Promise<boolean> {
  const where = await read($, nav)
  return where.view !== 'folders' && !isForYou(where)
}

// --- when passes run ---

/** Opening the pane (§8 T9): the last list paints at once, from $.state or $.store, then a pass runs or waits its turn. */
async function openFolders($: $): Promise<void> {
  const state = await update($, folders, value => ({ ...value, pass: { ...value.pass, hasOpened: true } }))
  // Who the owner is, for For you's mentions, so that opening For you runs no tg call (§8 T9).
  if (me === null) {
    whoAmI($)
      .then(found => {
        me ??= found
      })
      .catch(() => {
        // Without it, For you finds mentions by Telegram's count alone.
      })
  }
  if (state.list === null) {
    const stored = parseStored(await $.store.get(STORE_FOLDERS))
    if (stored !== null && stored.list.length > 0) {
      await paintStored($, stored)
    } else {
      await update($, dialogs, () => ({ status: 'loading' }))
      firstList($).catch(() => {
        // The strip waits for the pass instead; the pass reports its own failure.
      })
    }
  } else {
    // Opening the pane moves the ring: what waits applies.
    await applyWaiting($)
  }
  await requestPass($, 'open')
}

/** What the last session left: the folder list with its counts, the view, and its rows when it is a folder. */
async function paintStored($: $, stored: StoredFolders): Promise<void> {
  const isListed = stored.view.kind !== 'folder' || stored.list.some(folder => sameView({ kind: 'folder', id: folder.id }, stored.view))
  const first = stored.list[0]
  const view: ListView = isListed || first === undefined ? stored.view : { kind: 'folder', id: first.id }
  await update($, folders, value => ({ ...value, list: stored.list, gen: value.gen + 1 }))
  await update($, nav, value => ({ ...value, view: 'dialogs', list: view, query: '', dialogCursor: 0, dialogStart: 0 }))
  await update($, dialogs, () => (view.kind === 'folder' && sameView(view, stored.view) ? { status: 'ok', value: stored.rows } : { status: 'loading' }))
}

/** A first open with nothing held: the strip from `tg folders` (0.66 s on the owner's account), on Telegram's first folder. */
async function firstList($: $): Promise<void> {
  const result = await runTg($, tg.folders())
  if (!result.ok || (await read($, folders)).list !== null) return
  await takeFirstList($, result.value)
}

async function takeFirstList($: $, list: readonly Folder[]): Promise<void> {
  const first = list[0]
  await update($, folders, value => ({ ...value, list: [...list] }))
  if (first !== undefined) await update($, nav, value => ({ ...value, list: { kind: 'folder', id: first.id }, dialogCursor: 0, dialogStart: 0 }))
}

/**
 * A reason to run a pass (./folders `passPlan`): it runs, queues the one pass
 * `g` may queue (`refreshing in N s`), or waits for the cadence.
 */
async function requestPass($: $, reason: 'open' | 'g' | 'tick'): Promise<void> {
  const at = await $.clock.now()
  const state = (await read($, folders)).pass
  const plan = passPlan(state, at, reason, (await read($, mode)) === 'open')
  if (plan === 'run') {
    runPass($).catch(() => {
      // runPass records its own failures in state.
    })
  } else if (plan === 'queue') {
    const when = Math.max(nextAllowed(state), at)
    await update($, folders, value => ({ ...value, pass: { ...value.pass, queuedFor: when } }))
    await armNext($)
    await startCountdown($)
  } else {
    // Not now: the cadence's timer, armed for when it may.
    await armNext($)
  }
}

/**
 * One timer for the next pass: the queued one, else the cadence's (60 s after
 * the last start while the pane is open, 5 min while it is hidden after a
 * first open), never before a flood wait ends. Armed again after every pass
 * and whenever the pane opens or hides.
 */
async function armNext($: $): Promise<void> {
  passNext?.cancel()
  passNext = null
  const state = (await read($, folders)).pass
  const isOpen = (await read($, mode)) === 'open'
  const cadence = state.startedAt === null ? null : isOpen ? state.startedAt + PASS_GAP_MS : state.hasOpened ? state.startedAt + HIDDEN_GAP_MS : null
  const due = state.queuedFor ?? cadence
  if (due === null || state.isRunning) return
  const when = Math.max(due, state.floodUntil ?? 0)
  const timer = $.clock.after(Math.max(0, when - (await $.clock.now())), () => {
    if (passNext === timer) passNext = null
    requestPass($, 'tick').catch(() => {
      // A pass that could not start waits for the next arming: a pass's end, the pane opening or hiding, g.
    })
  })
  passNext = timer
}

/** Ticks `now` each second while a notice counts down (a queued pass, a flood wait). */
async function startCountdown($: $): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  if (passCountdown !== null) return
  const timer = $.clock.every(1000, () => {
    countdownTick().catch(() => {
      // A missed tick only holds the countdown one second.
    })
  })
  passCountdown = timer
  async function countdownTick(): Promise<void> {
    const at = await $.clock.now()
    await update($, now, () => at)
    const pass = (await read($, folders)).pass
    const isCounting = (pass.queuedFor !== null && pass.queuedFor > at) || (pass.floodUntil !== null && pass.floodUntil > at) || (await isRefreshShown($))
    if (isCounting) return
    timer.cancel()
    if (passCountdown === timer) passCountdown = null
  }
}

async function runPass($: $): Promise<void> {
  const startedAt = await $.clock.now()
  await update($, folders, value => ({ ...value, pass: { ...value.pass, startedAt, isRunning: true, queuedFor: null, error: null } }))
  const result = await runTg($, tg.pass())
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!result.ok) {
    await passFailed($, result.failure, at)
    await armNext($)
    return
  }
  const before = passHeld
  const map = passMap(result.value)
  passHeld = map
  await update($, folders, value => ({ ...value, pass: { ...value.pass, isRunning: false, floodUntil: null, error: null } }))
  const verdicts = (await read($, triage)).verdicts
  const kept = pruneVerdicts(verdicts, [...map.rows.values()])
  if (Object.keys(kept).length !== Object.keys(verdicts).length) await update($, triage, value => ({ ...value, verdicts: pruneVerdicts(value.verdicts, [...map.rows.values()]) }))
  await landPass($, map)
  // A watched chat whose unread count grew since the last pass raises the band (── footer ──).
  if (before !== null) await raiseGrown($, [...before.rows.values()], [...map.rows.values()])
  await storeFolders($)
  await refreshStatus($)
  await armNext($)
}

/**
 * Exit 5 keeps the pass and holds the next one until the wait is over, then
 * retries; any other failure keeps it and says so with `g: retry`, and the
 * cadence goes on (§8 T9). With no rows held, the list itself shows it.
 */
async function passFailed($: $, failure: TgFailure, at: number): Promise<void> {
  const floodUntil = failure.kind === 'flood' ? at + failure.seconds * 1000 : null
  await update($, folders, value => ({
    ...value,
    pass: { ...value.pass, isRunning: false, floodUntil: floodUntil ?? value.pass.floodUntil, queuedFor: floodUntil ?? value.pass.queuedFor, error: floodUntil === null ? failureText(failure, at) : null },
  }))
  if ((await read($, dialogs)).status !== 'ok') await update($, dialogs, () => failed(failure, at))
  if (floodUntil !== null) await startCountdown($)
  await refreshStatus($)
}

/**
 * A pass landed. A list with nothing drawn fills at once; a drawn one changes
 * in place (counts, mentions, the last message) and what moved waits. The
 * folder list's counts change in place too; a folder added, removed or moved
 * waits with the rest.
 */
async function landPass($: $, map: PassMap): Promise<void> {
  const state = await read($, folders)
  if (state.list === null) await takeFirstList($, folderList(map))
  else await writeCounts($, map)
  const drawn = loaded(await read($, dialogs))
  const where = await read($, nav)
  if (isForYou(where) && (drawn === undefined || drawn.length === 0)) {
    await fillPeople($)
  } else if (drawn === undefined || drawn.length === 0) {
    await applyWaiting($, true)
    if ((await read($, mode)) === 'open') await ringCursor($)
  } else {
    // In place: the same rows, each as the pass has it now. Rows that did not change are not written again.
    const next = drawn.map(row => cutRow(map.rows.get(row.id) ?? row))
    if (JSON.stringify(next) !== JSON.stringify(drawn)) await update($, dialogs, () => ({ status: 'ok', value: next }))
  }
}

function countsIn(list: Folder[] | null, map: PassMap): Folder[] | null {
  if (list === null) return null
  return list.map(folder => ({ ...folder, unread: map.folders.find(one => one.id === folder.id)?.unread ?? folder.unread }))
}

/** The folder list's counts as the map has them, written only when one changed. */
async function writeCounts($: $, map: PassMap): Promise<void> {
  const list = (await read($, folders)).list
  const next = countsIn(list, map)
  if (JSON.stringify(next) !== JSON.stringify(list)) await update($, folders, value => ({ ...value, list: countsIn(value.list, map) }))
}

/** A watch event between passes (§8 T9): the row in the module's map, and the chat up in every folder that lists it. */
async function patchHeld($: $, dialogId: number, message: MessageView): Promise<void> {
  if (passHeld === null) return
  const row = passHeld.rows.get(dialogId)
  if (row === undefined) return
  const patched = applyToDialogs([row], dialogId, message)[0]
  if (patched === undefined) return
  passHeld.rows.set(dialogId, patched)
  const map = recount(bump(passHeld, dialogId))
  passHeld = map
  await writeCounts($, map)
}

/** $.store (§8 T9 d): the folder list with its counts, the current view, and its rows when it is a folder. */
async function storeFolders($: $): Promise<void> {
  const state = await read($, folders)
  if (state.list === null) return
  const view = (await read($, nav)).list
  const rows = view.kind === 'folder' ? (loaded(await read($, dialogs)) ?? []) : []
  const snapshot = { list: state.list, view, rows }
  // A pass that changed nothing on screen writes nothing: $.store is a file every session shares.
  const text = JSON.stringify(snapshot)
  if (text === lastStored) return
  lastStored = text
  await $.store.set(STORE_FOLDERS, snapshot)
}

// --- what waits, and applying it ---

/** The view as the pass and the live state have it now; null when nothing held can say (the Archive, a search). */
async function viewTarget($: $): Promise<{ agents: AgentItem[]; rows: TgDialog[]; why: Record<string, ForYouWhy> } | null> {
  const where = await read($, nav)
  if (where.query !== '') return null
  if (where.list.kind === 'foryou') {
    const state = await read($, folders)
    const people = passHeld === null || state.isRanking ? null : await rankedPeople($, passHeld)
    return {
      agents: await liveAgents($),
      rows: people?.rows ?? loaded(await read($, dialogs)) ?? [],
      why: people?.why ?? state.why,
    }
  }
  const rows = viewRows(passHeld, where.list)
  return rows === null ? null : { agents: [], rows, why: {} }
}

async function rankedPeople($: $, map: PassMap): Promise<{ rows: TgDialog[]; why: Record<string, ForYouWhy> }> {
  const state = await read($, triage)
  return forYouPeople(map.rows.values(), me ?? NO_ME, state.verdicts, state.repliedToYou)
}

/** `↑N`: the chats that moved, joined or left since the list was drawn (./folders `waitingCount`). */
async function movedCount($: $): Promise<number> {
  const target = await viewTarget($)
  if (target === null) return 0
  const drawn = (await listRows($)).map(rowId)
  const next = [...target.agents.map(item => `agent:${agentKey(item)}`), ...target.rows.map(row => `chat:${row.id}`)]
  return waitingCount(drawn, next)
}

/** Inline's notice row (and the dock's strip row over the Folders list or For you): `↑ 3 moved · g: apply`. */
async function movedNotice($: $): Promise<PaneNotice | null> {
  const count = await movedCount($)
  return count === 0 ? null : { tone: 'info', text: `↑ ${count} moved · g: apply` }
}

/**
 * What waits applies, at the owner's move: the view as it is now, under a new
 * generation, so its row keys are new and `$.ui.focus` waits for the drawing
 * that brings them; the cursor follows its chat wherever it moved. `isFill`: a
 * list with nothing drawn yet, filled the same way.
 */
async function applyWaiting($: $, isFill = false): Promise<boolean> {
  const target = await viewTarget($)
  const state = await read($, folders)
  const list = passHeld === null ? state.list : folderList(passHeld)
  const isListSame = JSON.stringify(list?.map(one => [one.id, one.title, one.kind])) === JSON.stringify(state.list?.map(one => [one.id, one.title, one.kind]))
  if (target === null) {
    if (!isListSame) await update($, folders, value => ({ ...value, list, gen: value.gen + 1 }))
    return !isListSame
  }
  const drawn = await listRows($)
  const next: ListRow[] = [...target.agents.map((item): ListRow => ({ kind: 'agent', item })), ...target.rows.map((dialog): ListRow => ({ kind: 'chat', dialog }))]
  const isSame = drawn.length === next.length && drawn.every((row, index) => { const other = next[index]; return other !== undefined && rowId(row) === rowId(other) })
  if (isSame && isListSame && !isFill) return false
  const where = await read($, nav)
  const atCursor = drawn[clamp(where.dialogCursor, drawn.length)]
  const found = atCursor === undefined ? -1 : next.findIndex(row => rowId(row) === rowId(atCursor))
  const cursor = found >= 0 ? found : clamp(where.dialogCursor, next.length)
  await update($, dialogs, () => ({ status: 'ok', value: target.rows.map(cutRow) }))
  await update($, folders, value => ({ ...value, list, gen: value.gen + 1, agents: target.agents, why: target.why }))
  await update($, nav, value => cursorTo(value, 'dialogs', cursor, next.length))
  return true
}

/** A folder, the Archive or a pane view in Chats' place, from what the module holds: no tg call but the Archive's (§8 T9). */
async function switchView($: $, view: ListView): Promise<void> {
  await update($, nav, value => ({ ...value, view: 'dialogs', list: view, query: '', dialogCursor: 0, dialogStart: 0, isMenuOpen: false, isSearching: false }))
  await update($, folders, value => ({ ...value, gen: value.gen + 1, agents: [], why: {}, isRanking: false }))
  switch (view.kind) {
    case 'folder':
    case 'bots': {
      const rows = viewRows(passHeld, view)
      await update($, dialogs, () => (rows === null ? { status: 'loading' } : { status: 'ok', value: rows.map(cutRow) }))
      // After a hot reload only the view that was on screen is held: the others wait for the next pass.
      if (rows === null) await startCountdown($)
      break
    }
    case 'archive':
      await update($, dialogs, () => ({ status: 'loading' }))
      loadArchive($).catch(() => {
        // loadArchive records its own failure in the list.
      })
      break
    case 'foryou':
      await openForYou($)
      break
  }
  await storeFolders($)
  await ringCursor($)
}

/** The Archive (`tg dialogs --archived`), run when asked and not cached (§8 T9). */
async function loadArchive($: $): Promise<void> {
  const result = await runTg($, tg.dialogs({ isArchived: true }))
  const at = await $.clock.now()
  if ((await read($, nav)).list.kind !== 'archive') return
  await update($, dialogs, () => (result.ok ? { status: 'ok', value: result.value.map(cutRow) } : failed(result.failure, at)))
  await ringCursor($)
}

/** `s`: every chat whose title or @name matches (`tg dialogs --query`), as Telegram's search does (§4.7). */
async function searchChats($: $, query: string): Promise<void> {
  await update($, nav, value => ({ ...value, view: 'dialogs', query, dialogCursor: 0, dialogStart: 0 }))
  await update($, folders, value => ({ ...value, gen: value.gen + 1 }))
  await update($, dialogs, () => ({ status: 'loading' }))
  const result = await runTg($, tg.dialogs({ query }))
  const at = await $.clock.now()
  if ((await read($, nav)).query !== query) return
  await update($, dialogs, () => (result.ok ? { status: 'ok', value: result.value.map(cutRow) } : failed(result.failure, at)))
  await ringCursor($)
}

/** `h` from Chats or For you: a search goes back to its folder; otherwise up to the Folders list, the current entry under the cursor. */
async function backFromList($: $): Promise<void> {
  const where = await read($, nav)
  if (where.query !== '') return switchView($, where.list)
  await applyWaiting($)
  const items = await folderItems($)
  const index = Math.max(0, items.findIndex(item => sameView(item.view, where.list)))
  // The list opens from its top; the drawing scrolls it only if the current entry is past its window.
  await update($, nav, value => ({ ...value, view: 'folders', folderCursor: index, folderStart: 0 }))
}

/** `g` on a list: what waits applies at once, the Archive or a search runs again, then a pass runs or queues (§8 T9). */
async function reloadList($: $): Promise<void> {
  const where = await read($, nav)
  await applyWaiting($)
  if (where.query !== '') await searchChats($, where.query)
  else if (where.list.kind === 'archive') await switchView($, where.list)
  await requestPass($, 'g')
  await ringCursor($)
}

// --- the strip, the Folders list and the digits ---

type FolderRowItem = FolderItem & { view: ListView }

const viewId = (view: ListView) => (view.kind === 'folder' ? `f${view.id}` : view.kind)

/** The Folders list: every folder, the Archive, then For you and Bots (§4.7). */
async function folderItems($: $): Promise<FolderRowItem[]> {
  const state = await read($, folders)
  if (state.list === null) return []
  const entries = stripEntries(state.list)
  const item = (view: ListView, title: string, unread: number | null, digit: number | null, isFirstView: boolean, note: string): FolderRowItem => ({
    key: `folder:${state.gen}:${viewId(view)}`,
    view,
    prefix: digit !== null ? `${digit}: ` : view.kind === 'foryou' ? 'y: ' : '   ',
    title,
    unread,
    isFirstView,
    note,
  })
  const folderRows = entries.filter(entry => entry.view.kind === 'folder').map(entry => item(entry.view, entry.isShared ? `${entry.title} · shared` : entry.title, entry.unread, entry.digit, false, ''))
  const views = entries.filter(entry => entry.view.kind !== 'folder')
  return [
    ...folderRows,
    item({ kind: 'archive' }, 'Archive', null, null, false, ''),
    ...views.map((entry, index) => item(entry.view, entry.title, null, entry.digit, index === 0, entry.view.kind === 'foryou' ? 'agents, then people waiting' : 'every chat with a bot')),
  ]
}

async function openFolderAt($: $, index: number): Promise<void> {
  const item = (await folderItems($))[index]
  if (item !== undefined) await switchView($, item.view)
}

/** `1-9: folder` after ⏎ in the Folders list's bar. */
async function digitsLabel($: $): Promise<string | null> {
  const count = stripEntries((await read($, folders)).list ?? []).filter(entry => entry.digit !== null).length
  return count === 0 ? null : count === 1 ? '1: folder' : `1-${count}: folder`
}

async function drawDigitKeys($: $, els: Els): Promise<RenderElement> {
  const entries = stripEntries((await read($, folders)).list ?? [])
  return DigitKeys(els, {
    digits: entries.flatMap(entry => (entry.digit === null ? [] : [{ digit: entry.digit, title: entry.title, onPress: () => switchView($, entry.view) }])),
  })
}

/** Cells inline's header leaves the strip: the row less `tg`, the state summary and who holds the keys (§7.3). */
function inlineStripRoom(width: number, summary: { levels: string; watched: string; forYou: string }, isFocused: boolean): number {
  const parts = [summary.levels, summary.watched, summary.forYou].filter(part => part !== '')
  const summaryCells = parts.reduce((sum, part) => sum + cells(part) + 3, 0)
  return Math.max(10, width - 2 - 2 - summaryCells - 1 - (isFocused ? 6 : 16) - 2)
}

async function drawStrip($: $, els: Els, props: { isLive: boolean; search: 'key' | 'click' | 'none'; width: number }): Promise<RenderElement> {
  const state = await read($, folders)
  const where = await read($, nav)
  const entries = stripEntries(state.list ?? [])
  const current = entries.findIndex(entry => sameView(entry.view, where.list))
  const texts = entries.map((entry, index) => tabText(entry, index === current, props.isLive))
  const waiting = props.search === 'none' ? 0 : await movedCount($)
  const room = props.search === 'none' ? props.width : props.width - stripRight(where.query, waiting)
  const shown = stripWindow(texts, Math.max(0, current), room)
  return Strip(els, {
    tabs: texts.slice(shown.start, shown.end).map((text, index) => ({ text, isCurrent: shown.start + index === current })),
    before: shown.start,
    after: Math.max(0, entries.length - shown.end),
    query: where.query,
    waiting,
    isLoading: state.list === null || state.pass.isRunning,
    search: props.search,
    onSearch: () => startSearch($),
  })
}

/** The top of the dock, or inline's body: the Folders list, For you, or the chats. */
async function drawTop($: $, els: Els, width: number, rows: number, mode: 'active' | 'idle' | 'static', seat: Seat = 'dock'): Promise<RenderElement[]> {
  const where = await read($, nav)
  if (where.view === 'folders') {
    const items = await folderItems($)
    if (items.length === 0) {
      const loading = LoadState(els, { load: { status: 'loading' }, now: 0, rows, onReload: () => reload($) })
      return loading === null ? [] : [loading]
    }
    const columns = seat === 'inline' ? 2 : 1
    // Inline the second column starts after the first's rows; the pane-views line takes a row of one of them.
    const perColumn = Math.max(1, rows)
    windowRows.folders = Math.max(1, perColumn * columns - 1)
    const cursor = clamp(where.folderCursor, items.length)
    const start = edgeStart(where.folderStart, cursor, windowRows.folders, items.length)
    return FoldersList(els, { items, cursor, start, rows: perColumn, columns, width, mode: mode === 'static' ? 'static' : 'active', onOpen: index => openFolderAt($, index) })
  }
  if (isForYou(where)) return drawForYou($, els, width, rows, mode)
  return drawDialogList($, els, width, rows, mode)
}

// --- For you (§5.3) ---

async function liveAgents($: $): Promise<AgentItem[]> {
  const pilot = await read($, autopilot)
  const reply = await read($, draft)
  return agentItems(pilot.drafts, reply !== null && reply.step.kind !== 'sent', pilot.undo, Math.max(pilot.now, await $.clock.now()))
}

/**
 * `y`: the agents' items at once, then people from the pass, ranked with why
 * by today's ranking call, which runs only here and only when the view opens.
 */
async function openForYou($: $): Promise<void> {
  const agents = await liveAgents($)
  await update($, folders, value => ({ ...value, agents, why: {} }))
  await update($, dialogs, () => (passHeld === null ? { status: 'loading' } : { status: 'ok', value: [] }))
  if (passHeld === null) return startCountdown($)
  const map = passHeld
  const state = await read($, triage)
  const unsure = toAsk(forYouCandidates(map.rows.values()).filter(row => row.mentions === 0), me ?? NO_ME, state.verdicts, state.repliedToYou)
  if (unsure.length === 0) return fillPeople($)
  await update($, folders, value => ({ ...value, isRanking: true }))
  scoreUnread($, unsure)
    .catch(() => {
      // Without verdicts the heuristics rank alone.
    })
    .finally(() => {
      fillPeople($).catch(() => {
        // The rows stay as they are; g applies the ranked ones.
      })
    })
}

/** For you's people land under its agent rows: rows below the cursor's, so nothing above it moves. */
async function fillPeople($: $): Promise<void> {
  const where = await read($, nav)
  if (!isForYou(where) || passHeld === null) return
  const people = await rankedPeople($, passHeld)
  const wasEmpty = (await listRows($)).length === 0
  await update($, folders, value => ({ ...value, why: people.why, isRanking: false }))
  await update($, dialogs, () => ({ status: 'ok', value: people.rows.map(cutRow) }))
  if (wasEmpty && (await read($, mode)) === 'open') await ringCursor($)
}

async function forYouRowKind($: $): Promise<'chat' | 'draft' | 'reply' | 'undo' | null> {
  const row = await cursorRow($)
  return row === undefined ? null : row.kind === 'chat' ? 'chat' : row.item.kind
}

async function agentPeer($: $, item: AgentItem): Promise<PeerRef | undefined> {
  const pilot = await read($, autopilot)
  switch (item.kind) {
    case 'draft':
      return (pilot.drafts.find(one => one.seq === item.seq) ?? pilot.ledger.find(one => one.seq === item.seq))?.peer
    case 'reply':
      return (await read($, draft))?.peer
    case 'undo':
      return pilot.ledger.find(one => one.seq === item.seq)?.peer
  }
}

/**
 * ⏎ on an agent's row: a draft whose whole text is on screen sends with
 * --yes (the owner read it, decision 9) once the guard allows it; one cut
 * short opens its chat on its row, the one place a draft is read whole and
 * sent (§8 T3). Routing's drafted reply is a draft like autopilot's. An undo
 * window's row opens its chat.
 */
async function pressAgentRow($: $, item: AgentItem): Promise<void> {
  switch (item.kind) {
    case 'draft':
    case 'reply': {
      const ref: DraftRef = item.kind === 'draft' ? { kind: 'autopilot', seq: item.seq } : { kind: 'reply' }
      const view = await draftViewOf($, ref)
      if (view === undefined) return
      // The row's text cell as drawn (ForYouList): the whole draft in it is a draft read whole.
      const gen = (await read($, folders)).gen
      const drawn = (await forYouItems($, gen)).find(one => one.key === rowKey(gen, { kind: 'agent', item }))
      if (fitsRow(`"${view.text}"`, forYouTextRoom(forYouWidth, drawn?.right ?? ''))) return enterDraft($, ref)
      return openDraftRow($, ref)
    }
    case 'undo': {
      const peer = await agentPeer($, item)
      if (peer === undefined) return
      await applyWaiting($)
      return openThread($, (await knownDialogs($)).find(one => one.id === peer.id) ?? dialogOfPeer(peer))
    }
  }
}

/** `e` on a draft row: the row becomes its field, in the row's place, so the ring stays there. */
async function editAgentRow($: $): Promise<void> {
  const row = await cursorRow($)
  if (row?.kind !== 'agent') return
  if (row.item.kind === 'undo') return
  await editDraft($, row.item.kind === 'draft' ? { kind: 'autopilot', seq: row.item.seq } : { kind: 'reply' }, true)
  await ringCursor($)
}

/** `d` on an agent's row: drops the draft or closes the undo window; the row stays, drawn done, until the list reshapes. */
async function dropAgentRow($: $): Promise<void> {
  const row = await cursorRow($)
  if (row?.kind !== 'agent') return
  if (row.item.kind === 'draft') await apDropDraft($, row.item.seq)
  else if (row.item.kind === 'reply') await dropDraft($, { kind: 'reply' })
  else await apCloseUndo($, { state: 'expired' })
  await ringCursor($)
}

/** For you's rows as drawn: each agent row read live (done once it is gone), each person's with why. */
async function forYouItems($: $, gen: number): Promise<ForYouItem[]> {
  const pilot = await read($, autopilot)
  const reply = await read($, draft)
  const why = (await read($, folders)).why
  const at = Math.max(pilot.now, await $.clock.now())
  return (await listRows($)).map((row): ForYouItem => {
    const key = rowKey(gen, row)
    if (row.kind === 'chat') {
      const { glyph, color } = dialogGlyph(row.dialog.kind)
      const unread = row.dialog.unread === 0 ? '' : `${row.dialog.muted ? '·' : ''}${row.dialog.unread}`
      return { key, section: 'people', glyph, glyphColor: color, name: dialogLabel(row.dialog), label: why[String(row.dialog.id)] ?? '', text: row.dialog.last_text, isEditing: false, right: `${unread.padStart(4)} ${shortTime(row.dialog.last_date, at).padStart(9)}`, isGone: false }
    }
    const item = row.item
    if (item.kind === 'draft') {
      const one = pilot.drafts.find(value => value.seq === item.seq)
      const entry = pilot.ledger.find(value => value.seq === item.seq)
      if (one === undefined) {
        const label = entry?.outcome.kind === 'sent' ? `${GLYPH.done} sent` : entry?.outcome.kind === 'dropped' ? 'dropped' : 'done'
        return { key, section: 'agents', glyph: LEVEL_GLYPH.draft, name: entry?.peer.label ?? '', label, text: entry?.reply ?? '', isEditing: false, right: '', isGone: true }
      }
      const label = one.state.kind === 'sending' ? `${GLYPH.working} sending` : one.state.kind === 'failed' ? `${GLYPH.error} failed` : 'draft'
      const right = one.state.kind === 'failed' ? one.state.reason : one.confidence === null ? '' : `conf ${one.confidence.toFixed(2)}`
      return { key, section: 'agents', glyph: LEVEL_GLYPH.draft, name: one.peer.label, label, text: one.text, isEditing: one.state.kind === 'editing', right, isGone: false }
    }
    if (item.kind === 'reply') {
      const isLive = reply !== null && reply.step.kind !== 'sent'
      return { key, section: 'agents', glyph: LEVEL_GLYPH.draft, name: reply?.peer.label ?? '', label: isLive ? 'draft reply' : 'done', text: reply?.text ?? '', isEditing: isLive && reply.isEditing, right: isLive ? `from ${reply.from}` : '', isGone: !isLive }
    }
    const undo = pilot.undo !== null && pilot.undo.seq === item.seq && at < pilot.undo.until ? pilot.undo : null
    const entry = pilot.ledger.find(value => value.seq === item.seq)
    return {
      key,
      section: 'agents',
      glyph: LEVEL_GLYPH.auto,
      name: undo?.peer.label ?? entry?.peer.label ?? '',
      label: undo === null ? 'sent' : 'sent',
      text: undo?.text ?? entry?.reply ?? '',
      isEditing: false,
      right: undo === null ? '' : `u: undo ${Math.max(0, Math.ceil((undo.until - at) / 1000))}s`,
      isGone: undo === null,
    }
  })
}

async function drawForYou($: $, els: Els, width: number, rows: number, mode: 'active' | 'idle' | 'static'): Promise<RenderElement[]> {
  const state = await read($, folders)
  const where = await read($, nav)
  const load = await read($, dialogs)
  const items = await forYouItems($, state.gen)
  if (items.length === 0) {
    const waiting = LoadState(els, { load, now: await read($, now), rows, onReload: () => reload($) })
    if (waiting !== null) return [waiting]
    if (!state.isRanking) return [EmptyList(els, { text: 'Nothing waits for you in any folder. h: folders' })]
  }
  // Two rows always go to the section lines, so a section that appears does not move the window.
  const window = Math.max(1, rows - 2)
  windowRows.dialogs = window
  forYouWidth = width
  const cursor = clamp(where.dialogCursor, items.length)
  const start = edgeStart(where.dialogStart, cursor, window, items.length)
  return ForYouList(els, {
    items,
    cursor,
    start,
    rows: window,
    width,
    mode,
    isRanking: state.isRanking,
    onPress: async index => {
      await update($, nav, value => ({ ...value, view: 'dialogs', dialogCursor: index }))
      await openAtCursor($)
    },
    onSave: async (index, text) => {
      const row = (await listRows($))[index]
      if (row?.kind !== 'agent' || row.item.kind === 'undo') return
      await saveDraft($, row.item.kind === 'draft' ? { kind: 'autopilot', seq: row.item.seq } : { kind: 'reply' }, text)
      await ringCursor($)
    },
  })
}

// --- notices and empty lists ---

/** A pass that cannot run now (§7.4): a flood wait counting down, a failure with `g: retry`, a queued pass. */
async function passNotice($: $): Promise<PaneNotice | null> {
  const pass = (await read($, folders)).pass
  const at = Math.max(await read($, now), await $.clock.now())
  const seconds = (until: number) => Math.max(0, Math.ceil((until - at) / 1000))
  if (pass.floodUntil !== null && pass.floodUntil > at) return { tone: 'warn', text: `Telegram asks to wait ${seconds(pass.floodUntil)} s · retrying` }
  if (pass.error !== null && (await read($, dialogs)).status === 'ok') return { tone: 'danger', text: `${pass.error} · g: retry` }
  if (pass.queuedFor !== null && pass.queuedFor > at) return { tone: 'info', text: `refreshing in ${seconds(pass.queuedFor)} s` }
  if (await isRefreshShown($)) return { tone: 'info', text: `refreshing in ${seconds(nextAllowed(pass))} s` }
  return null
}

/** After a hot reload, a view the module no longer holds shows `…` rows until the next pass (§8 T9 c). */
async function isRefreshShown($: $): Promise<boolean> {
  const where = await read($, nav)
  return passHeld === null && (await read($, folders)).pass.hasOpened && (await read($, dialogs)).status === 'loading' && where.list.kind !== 'archive' && where.query === ''
}

/** One sentence and one key (§7.4). */
async function emptyText($: $): Promise<string> {
  const where = await read($, nav)
  if (where.query !== '') return `No chats match "${where.query}". h: back to the folder`
  switch (where.list.kind) {
    case 'archive':
      return 'Nothing in the Archive. h: folders'
    case 'bots':
      return 'No chats with bots. h: folders'
    case 'foryou':
      return 'Nothing waits for you in any folder. h: folders'
    case 'folder': {
      const id = where.list.id
      const folder = (await read($, folders)).list?.find(one => one.id === id)
      const scan = folder?.kind === 'all' ? ' among the latest 500 chats' : ''
      return `No chats in ${folder?.title ?? 'this folder'}${scan}. h: folders`
    }
  }
}
// ── /folders ──

// ── footer ──
// dialogs-pane-ux.md §4.1, §4.5 and §8 T5: what the pane says outside itself.
// The footer label (SessionMode) is the §4.5 summary with the unread chats
// that are not muted; the status line holds the three alarms only; the band
// above the prompt is one queue of what needs the owner, most urgent first,
// leaving out what the pane draws; the hint tail says the band has something;
// /tg help and /tg status are cards; a packet's transcript row stays whole
// (decision 10). Pure rules in ./ui/queue, the band's drawing in ./ui/band.

/** The seat the pane was last drawn in: docked, the open chat shows under Chats. */
let lastSeat: Seat | null = null
/** The thread's room as last drawn: the band leaves out a draft whose row the thread's window holds (§4.5). */
let lastThread: { width: number; rows: number } | null = null
/** tg's last answer was "not logged in" (exit 3): the status line's third alarm. A hot reload forgets it until tg next answers. */
let isLoggedOut = false
/** What the status line last got; undefined until the first write, so a fresh module always writes once. */
let lastStatus: { text: string | undefined } | undefined

/** Every tg answer says whether the account is logged in; a change redoes the status line. */
async function seeLogin($: $, result: TgResult<unknown>): Promise<void> {
  const isOut = !result.ok && result.failure.kind === 'auth'
  // Only an answer from Telegram says the account is in: a missing tg or a flood says nothing about it.
  if (isOut === isLoggedOut || (!isOut && !result.ok)) return
  isLoggedOut = isOut
  await refreshStatus($)
}

/** `tg 22`: the All chats folder's count, as tg counts it (unread, not muted); before the first pass, the latest chats'. */
async function unreadHead($: $): Promise<UnreadHead> {
  if (isLoggedOut) return { kind: 'failed', isLoggedOut: true }
  const state = await read($, folders)
  const all = state.list?.find(one => one.kind === 'all')
  if (all !== undefined && all.unread !== null) return { kind: 'count', unread: all.unread }
  const load = await read($, dialogs)
  // Once the pane opened, the list on screen is a folder's, not the latest chats: wait for the pass.
  if (state.pass.hasOpened) return passHeld === null ? { kind: 'loading' } : { kind: 'count', unread: unreadChats([...passHeld.rows.values()]) }
  if (load.status === 'ok') return { kind: 'count', unread: unreadChats(load.value) }
  return load.status === 'error' ? { kind: 'failed', isLoggedOut: false } : { kind: 'loading' }
}

async function footerText($: $): Promise<string> {
  return footerLabel(await unreadHead($), await summaryOf($))
}

/**
 * What the pane draws now, so the band does not say it twice. An open pane
 * the engine has not placed (a terminal too narrow) or keeps behind another
 * tab draws nothing.
 */
async function onScreen($: $): Promise<OnScreen> {
  if ((await read($, mode)) === 'hidden') return NOTHING_ON_SCREEN
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane === undefined || !pane.isPlaced || !pane.isShown) return NOTHING_ON_SCREEN
  const where = await read($, nav)
  const open = await read($, thread)
  const isDock = lastSeat === 'dock'
  const chat = open !== null && (isDock || where.view === 'thread') ? open.peer.id : null
  const isForYou = where.list.kind === 'foryou' && where.query === '' && (isDock || where.view === 'dialogs')
  // The drafts whose rows are drawn: every one For you lists, and the ones the thread's window holds whole.
  const listed = isForYou ? (await draftViewsNow($)).map(one => one.key) : []
  const inThread = chat === null || lastThread === null ? [] : (await threadLayout($, lastThread.width, lastThread.rows)).shown.flatMap(item => (item.kind === 'draft' ? [item.draft.key] : []))
  return { chat, isForYou, drafts: [...listed, ...inThread] }
}

/** The band's queue now; `seen`: what counts as on screen (`/tg status` lists everything). */
async function bandNow($: $, seen?: OnScreen): Promise<BandItem[]> {
  const pilot = await read($, autopilot)
  return bandQueue({
    holds: (await dgAlarms($)).holds,
    drafts: await draftViewsNow($),
    undo: pilot.undo !== null && pilot.now < pilot.undo.until ? pilot.undo : null,
    reply: await read($, band),
    watched: (await read($, triage)).watched.map(peer => peer.id),
    notes: pilot.notes,
    tasks: (await read($, delegate)).tasks.map(task => ({ id: task.id, peer: task.peer, status: task.status, reason: task.reason })),
    dismissed: (await read($, queue)).dismissed,
    onScreen: seen ?? (await onScreen($)),
  })
}

/** The band: the item the queue is on, two rows, or null with nothing to show. */
async function drawBand($: $, els: Els, width: number): Promise<RenderElement | null> {
  const items = await bandNow($)
  const index = shownIndex(items, (await read($, queue)).at)
  const item = items[index]
  if (item === undefined) return null
  const asked = item.kind === 'reply' ? bandIntent(item.event, (await lastIntents($)).last) : null
  const reply = (await read($, triage)).reply
  return BandItemView(els, {
    item,
    index,
    count: items.length,
    width,
    now: (await read($, autopilot)).now,
    sendAs: asked === null ? null : intentLabel(asked.intent),
    latencyMs: item.kind === 'reply' && reply !== null && reply.dialogId === item.event.dialogId ? reply.latencyMs : null,
    on: bandActions($, item, width),
  })
}

/** What the band's keys do for `item` (§6 "Band"): ⏎ its action, e d o u, j k through the queue. */
function bandActions($: $, item: BandItem, width: number): BandActions {
  const step = (by: 1 | -1) => async () => {
    const items = await bandNow($)
    const at = stepKey(items, (await read($, queue)).at, by)
    await update($, queue, value => ({ ...value, at }))
  }
  const put = () => dismissItem($, item.key)
  const none = async () => undefined
  const base = { edit: none, save: none, next: step(1), prev: step(-1) }
  switch (item.kind) {
    case 'hold':
      return { ...base, primary: () => apOpen($, item.peer), open: () => apOpen($, item.peer), dismiss: none }
    case 'draft': {
      const { ref } = item.draft
      return {
        ...base,
        primary: () => bandDraftEnter($, ref, width),
        open: () => openDraftRow($, ref),
        dismiss: () => dropDraft($, ref),
        edit: () => editDraft($, ref, true),
        save: text => saveDraft($, ref, text),
      }
    }
    case 'undo':
      return { ...base, primary: () => apUndo($), open: () => apOpen($, item.undo.peer), dismiss: () => apCloseUndo($, { state: 'expired' }) }
    case 'reply':
      return { ...base, primary: () => bandToMain($), open: () => openFromBand($), dismiss: () => dismissBand($) }
    case 'summary': {
      const drop = () => update($, autopilot, value => ({ ...value, notes: value.notes.filter(one => one.seq !== item.note.seq) }))
      const open = async () => {
        await drop()
        await apOpen($, item.note.peer)
      }
      return { ...base, primary: open, open, dismiss: drop }
    }
    case 'task': {
      // Opening the chat shows the task card on top of its thread: the news is read.
      const open = async () => {
        await put()
        await apOpen($, item.task.peer)
      }
      return { ...base, primary: open, open, dismiss: put }
    }
  }
}

/**
 * ⏎ on a draft's item: it sends when its whole text shows on its row and the
 * guard allowed it, as the owner's own write (decision 9); otherwise the pane
 * opens on the draft's row in its chat, the one place it is read whole and
 * sent (§8 T3). Read again at the press: the draft may have changed since.
 */
async function bandDraftEnter($: $, ref: DraftRef, width: number): Promise<void> {
  const view = await draftViewOf($, ref)
  if (view === undefined) return
  if (view.canSend && draftFits(view.text, width)) return enterDraft($, ref)
  return openDraftRow($, ref)
}

/** `d` on news: it leaves the band; the key is kept so the same news does not come back. */
async function dismissItem($: $, key: string): Promise<void> {
  await update($, queue, value => ({ ...value, dismissed: [...value.dismissed.filter(one => one !== key), key].slice(-50) }))
}

/** A hard stop that starts waiting reaches an owner in another window too (§5.5): one notification each. */
async function notifyHolds($: $, holds: readonly BandHold[]): Promise<void> {
  const keys = holds.map(hold => hold.key)
  const notified = (await read($, queue)).notified
  const fresh = holds.filter(hold => !notified.includes(hold.key))
  if (fresh.length === 0 && notified.every(key => keys.includes(key))) return
  await update($, queue, value => ({ ...value, notified: keys }))
  for (const hold of fresh) {
    $.ui.notify(`HARD STOP ${hold.stops.join(' + ')}: ${oneLine(hold.what, 120)} (${hold.peer.label}). Answer in Claude Code.`, { title: 'tg' }).catch(() => {
      // A refused or unbound notification leaves the status line and the band, which say the same.
    })
  }
}

/** A watched chat whose unread count grew between two loads raises the band; the others wait in their folders. */
async function raiseGrown($: $, before: readonly TgDialog[], after: readonly TgDialog[]): Promise<void> {
  const watched = new Set((await read($, triage)).watched.map(peer => peer.id))
  const grown = grownDialog(before, after.filter(dialog => watched.has(dialog.id)))
  if (grown === undefined) return
  // Only the chat is known, not who wrote: the band picks no sender's intents in a group.
  await update($, band, () => ({ dialogId: grown.id, label: dialogLabel(grown), kind: grown.kind, text: grown.last_text, sender: null }))
}

/** `/tg status` (§4.4, §4.5): the summary, what runs, what is watched, what waits, the alarm. Its first line is the card's title. */
async function statusLines($: $): Promise<string[]> {
  const running = (await runRowsNow($)).filter(isRunning)
  const watched = (await read($, triage)).watched
  const items = await bandNow($, NOTHING_ON_SCREEN)
  const now = (await read($, autopilot)).now
  const alarms = await dgAlarms($)
  const alarm = statusAlarm({ hold: alarms.line, noStops: alarms.noStops, isLoggedOut })
  return [
    'tg status',
    await footerText($),
    ...(running.length === 0 ? ['running   nothing'] : ['running', ...running.map(row => `  ${activityText(row, row.peer.label)}`)]),
    `watching  ${watched.length === 0 ? 'nothing' : watched.map(peer => peer.label).join(' · ')}`,
    ...(items.length === 0 ? ['waiting   nothing'] : ['waiting', ...items.map(item => `  ${itemLine(item, now)}`)]),
    ...(alarm === undefined ? [] : [`alarm     ${alarm}`]),
  ]
}
// ── /footer ──
