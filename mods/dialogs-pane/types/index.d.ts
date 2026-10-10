// The dialogs-pane contract: tg's JSON shapes as the mod reads them, and the
// values the mod keeps in $.state. Self-contained: no imports
// (`claude plugin validate` refuses them), so the JSON shapes are defined
// here once and hooks/packet/types.ts re-exports them beside its parsers.

// What `tg … --json` prints, mirrored by hand. The source of truth is tg itself:
// `src/tg_kit/render.py` (`message_json`), `src/tg_kit/buttons.py` (`Button.to_json`),
// `src/tg_kit/cmd_read.py` (`dialogs`, `resolve`) and README → "JSON (--json)".
// A change there is a contract change and lands here in the same commit.

/** `sender.kind` and `tg dialogs` `kind`, as README "JSON (--json)" lists them. */
export type SenderKind = 'self' | 'user' | 'bot' | 'group' | 'channel' | 'supergroup' | 'unknown'

export type Sender = {
  id: number | null
  kind: SenderKind
  username: string | null
  name: string
}

export type Forward = {
  from_id: number | null
  from_name: string | null
  date: string | null
}

/** `media` keeps only the keys tg set, so every field but `type` may be missing. */
export type Media = {
  type: string
  size?: number
  name?: string
  mime?: string
  duration?: number
  width?: number
  height?: number
  emoji?: string
  title?: string
  url?: string
}

/** A button's `type` stays an open string: tg prints new TL kinds by name. */
export type Button = {
  row: number
  col: number
  type: string
  text: string
  data_b64?: string
  url?: string
  query?: string
  same_peer?: boolean
  user_id?: number
  copy_text?: string
  requires_password?: boolean
}

export type Reaction = { emoji: string; count: number }
export type Link = { text: string; url: string }

/** One message of `tg read|msg|search --json`. */
export type MessageView = {
  id: number
  chat_id: number
  /** ISO 8601, UTC, second resolution (`2026-10-10T14:01:07Z`). */
  date: string
  sender: Sender
  out: boolean
  text: string
  reply_to: number | null
  forward: Forward | null
  /** The last edit time, or null. */
  edited: string | null
  /** Edits seen during a `--wait`; 0 otherwise. */
  edits: number
  pinned: boolean
  service: string | null
  via_bot: string | null
  media: Media | null
  keyboard: 'inline' | 'reply' | null
  buttons: Button[][]
  reactions: Reaction[]
  links: Link[]
  /** Only in global search results. */
  chat_title?: string
}

/** One row of `tg dialogs --json`. */
export type Dialog = {
  id: number
  kind: SenderKind
  title: string
  username: string | null
  unread: number
  last_id: number | null
  last_date: string | null
  last_text: string
}

// The pane's names for the same shapes.
export type TgPeerKind = SenderKind
export type TgDialog = Dialog
export type TgSender = Sender
export type TgButton = Button
export type TgMedia = Media
export type TgMessage = MessageView

/** Why a tg call gave no data: its exit code (errors.py), or tg missing. */
export type TgFailure =
  | { kind: 'auth' }
  | { kind: 'flood'; seconds: number }
  | { kind: 'not-found'; message: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

/** A value fetched through tg: not asked yet, in flight, here, or failed. */
export type Load<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; failure: TgFailure; retryAt?: number }

export type Mode = 'wide' | 'compact' | 'hidden'
export type Lens = 'all' | 'bots' | 'unread'

/** The peer a thread is open on: `arg` is what tg is given (`@name` or the id). */
export type PeerRef = { id: number; arg: string; label: string; kind: TgPeerKind }

export type Nav = {
  /** Compact shows one column: the dialogs or the open thread. */
  view: 'dialogs' | 'thread'
  lens: Lens
  query: string
  dialogCursor: number
  messageCursor: number
}

export type Thread = { peer: PeerRef; load: Load<TgMessage[]> }

/** Selected message ids, and where a `v` range started. */
export type Selection = { ids: number[]; anchor: number | null }

/** What the Hidden band reports: a dialog whose unread count grew. */
export type BandEvent = { dialogId: number; label: string; kind: TgPeerKind; text: string }

// ── triage ──
// Live updates, watched dialogs, saved lenses, summaries and needs-you ranking
// (design §5 ideas 11–14). Pure rules in hooks/triage/.

/** How one `tg watch` child is doing: starting, past `ready`, waiting to restart, or given up. */
export type WatchHealth = 'connecting' | 'live' | 'retrying' | 'failed'

/** A saved lens: an extra LensBar tab. Every filter that is set must match. */
export type SavedLens = {
  id: string
  name: string
  /** Peer kinds shown; empty shows every kind. */
  kinds: TgPeerKind[]
  isUnreadOnly: boolean
  /** Title or username contains it; '' matches all. */
  query: string
  /** Dialog ids picked by hand; empty matches any dialog. */
  dialogs: number[]
}

/** The lens editor while it is open: a new lens, or a saved one being changed. */
export type LensDraft = { lens: SavedLens; isNew: boolean }

/** Needs-you ranking: who asks you something, what is just news, what is noise. */
export type Verdict = 'needs-you' | 'fyi' | 'noise'

/** The summary of one thread, drawn above its messages. */
export type Summary = { peerId: number } & (
  | { status: 'loading' }
  | { status: 'ok'; text: string; count: number }
  | { status: 'error'; message: string }
)

/** The last live reply in a watched dialog, for Hidden's status line and band. */
export type WatchedReply = {
  dialogId: number
  messageId: number
  label: string
  kind: TgPeerKind
  /** From your message it answers to the reply; null when there is none. */
  latencyMs: number | null
}

export type Triage = {
  /** Dialogs marked with `w`; kept in $.store. */
  watched: PeerRef[]
  /** Each running watch, by dialog id. */
  health: Record<string, WatchHealth>
  /** The active saved lens's id; null: the built-in lens in `nav.lens`. */
  lens: string | null
  lenses: SavedLens[]
  editor: LensDraft | null
  isRanked: boolean
  /** Model verdicts, by `dialogId:last_id`, so a dialog is asked about once per new message. */
  verdicts: Record<string, Verdict>
  /** Dialog id → the id of a live message that replied to one of yours. */
  repliedToYou: Record<string, number>
  summary: Summary | null
  reply: WatchedReply | null
}

// ── routing ──
// Phase 2 (docs/design/dialogs-pane.md §4, §5 ideas 1–5 and 16–20): where a
// packet goes, what went to whom, live pins and drafted replies.

/** The packet module's intent ids (hooks/packet/intents.ts `INTENT_IDS`). */
export type RouteIntent = 'fix' | 'reproduce' | 'explain' | 'test' | 'draft_reply' | 'raw'

/** One live agent of this session, as `$.agent.list()` names it. */
export type AgentRef = { agentId: string; label: string }

/** A recipient: this session's main loop, a live agent, or one spawned for the packet. */
export type Recipient = { kind: 'main' } | ({ kind: 'agent' } & AgentRef) | { kind: 'new' }

/** One recipient of a broadcast, with an intent of its own. */
export type Leg = { to: Recipient; intent: RouteIntent }

/** Where the tray's send goes: one recipient under the tray's intent, or a broadcast. */
export type Route = { kind: 'one'; to: Recipient } | { kind: 'broadcast'; legs: Leg[] }

/** `$.agent.list()` statuses folded into the radar's three. */
export type AgentState = 'idle' | 'running' | 'done'
export type RadarEntry = AgentRef & { type: string; state: AgentState }

/** A broadcast being put together in the picker: each leg on or off. */
export type BroadcastRow = Leg & { isOn: boolean }

/** What the pane draws over the dialogs and thread. */
export type Overlay =
  | { kind: 'none' }
  | { kind: 'picker' }
  | { kind: 'broadcast'; rows: BroadcastRow[] }
  | { kind: 'ledger'; cursor: number }

/** Who a ledger entry went to; a spawned agent is known once it started. */
export type Delivered = { kind: 'main' } | ({ kind: 'agent'; isNew: boolean } & AgentRef)

export type LedgerState =
  | { kind: 'sent' }
  | { kind: 'working' }
  | { kind: 'done'; at: number }
  | { kind: 'failed'; reason: string }

/** One packet that left the pane. */
export type LedgerEntry = {
  seq: number
  at: number
  peer: PeerRef
  messageIds: number[]
  to: Delivered
  intent: RouteIntent
  state: LedgerState
  /** Reply-chain parents carried as context, and parents tg could not find. */
  parents: number
  missing: number[]
  masked: number
}

/** Where a pinned dialog's new messages go. */
export type PinTarget = { kind: 'main' } | ({ kind: 'agent' } & AgentRef)

export type PinWatch = { status: 'starting' } | { status: 'live' } | { status: 'failed'; reason: string }

/** A dialog pinned to an agent: `tg watch` feeds `messages`, newest last. */
export type Pin = {
  peer: PeerRef
  to: PinTarget
  /** The newest message id seen, so a restarted watch replays from it (`--after`). */
  lastId: number | null
  messages: TgMessage[]
  /** Agent pins: ids not delivered yet. */
  unsent: number[]
  watch: PinWatch
}

export type DraftStep =
  | { kind: 'draft' }
  | { kind: 'checking' }
  | { kind: 'planned'; isAllowed: boolean; reason: string }
  | { kind: 'sending' }
  | { kind: 'sent'; ids: number[] }
  | { kind: 'failed'; reason: string }

/** An agent's result drafted as a reply to the message it was about (idea 20). */
export type ReplyDraft = { peer: PeerRef; replyTo: number; text: string; from: string; step: DraftStep }

// ── /routing ──

// ── bottest ──

/** One message a recorded step printed, in tg's output order (send: sent first). */
export type StepMessage = { id: number; out: boolean; text: string; buttons: string[][] }

/** What a recorded step got back: tg's exit code (0, or 6 for no reply) and the messages. */
export type StepOutcome = { exit: number; messages: StepMessage[]; answer: string | null; latency_ms: number | null }

/**
 * The message a press acted on: its id now, and where it came from, so a replay
 * can find it again (ids differ on every run). `from` is null for a message that
 * was there before the recording started.
 */
export type StepTarget = { id: number; from: { step: number; position: number } | null }

/** A send or press done from the pane; `--wait` is part of each, so waits are not steps of their own. */
export type BotStep =
  | { kind: 'send'; peer: string; text: string; wait_s: number; at: number; outcome: StepOutcome }
  | {
      kind: 'press'
      peer: string
      target: StepTarget
      row: number
      col: number
      label: string
      wait_s: number
      at: number
      outcome: StepOutcome
    }

export type Recording = { startedAt: number; steps: BotStep[] }

/** A stopped recording: its steps, the shell script, and where the script was written. */
export type Recorded = Recording & { stoppedAt: number; script: string; path: string | null }

/**
 * Reply timing. `measured` (ms, by message id) is local timing from `tg watch`;
 * `pressedAt` (local ms, by message id) marks what a pane press brought back.
 * `lastPress.messageId` is the pressed message until its first edit is timed.
 */
export type Timing = {
  watch: 'off' | 'starting' | 'live'
  lastOut: { id: number; at: number } | null
  lastPress: { at: number; messageId: number | null } | null
  measured: Record<string, number>
  pressedAt: Record<string, number>
}

export type Notice = { tone: 'info' | 'warn' | 'danger'; text: string }

export type BotTest = {
  /** Allowlisted peer ids (`tg allow list --json`). */
  allow: Load<number[]>
  /** The tg write running now, as the bar shows it. */
  busy: string | null
  notice: Notice | null
  composing: boolean
  recording: Recording | null
  recorded: Recorded | null
  /** The two message ids being compared, older first. */
  diff: [number, number] | null
  timing: Timing
}

// ── autopilot ──
// Phase 3 (docs/design/dialogs-pane.md §6): dialogs answered as you, per level.
// Pure rules in hooks/autopilot/.

/** listen ◉ reads and summarizes; draft ✎ writes into the band; auto ⟳ sends within the limits. */
export type ApLevel = 'listen' | 'draft' | 'auto'

/** Escalation topics: a reply touching an enabled one goes to you as a draft. */
export type ApTopic = 'money' | 'dates' | 'promises' | 'opinions' | 'personal'

/** What the Speaker may use: your words, never the chat's. */
export type ApBrief = { tone: string; promises: string; facts: string }

/** One dialog handed to the autopilot, kept in $.store (`autopilot.dialogs`). */
export type ApDialog = {
  peer: PeerRef
  level: ApLevel
  brief: ApBrief
  /** Auto replies per hour; null is ∞ (no limit). */
  perHour: number | null
  /** Messages closer than this are one burst, answered once. */
  gapS: number
  /** Enabled escalation topics. */
  topics: ApTopic[]
  /** Below this confidence an auto reply becomes a draft. */
  threshold: number
  /** Local minutes of the day; inside, the dialog acts as `draft`. null: off. */
  quiet: { from: number; to: number } | null
}

/** Check before sending, when new messages came while the reply was written. */
export type ApCheck = 'send' | 'regenerate' | 'send_then_answer'

export type ApOutcome =
  | { kind: 'working' }
  | { kind: 'sent'; ids: number[]; by: 'auto' | 'you' }
  | { kind: 'drafted'; reasons: string[] }
  | { kind: 'dropped' }
  | { kind: 'listened' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export type ApUndo = { state: 'open'; until: number } | { state: 'undone' } | { state: 'expired' } | { state: 'failed'; reason: string }

/** One burst the autopilot handled: the autopilot ledger. */
export type ApEntry = {
  seq: number
  at: number
  peer: PeerRef
  level: ApLevel
  incoming: { id: number; text: string }[]
  reply: string
  confidence: number | null
  topics: ApTopic[]
  /** Every check-before-send choice, in order. */
  checks: ApCheck[]
  outcome: ApOutcome
  undo: ApUndo | null
}

export type ApDraftState = { kind: 'ready' } | { kind: 'editing' } | { kind: 'sending' } | { kind: 'failed'; reason: string }

/** A reply waiting for you in the band: ⏎ send, e edit, x drop, o open. */
export type ApDraft = {
  seq: number
  peer: PeerRef
  incoming: string
  text: string
  confidence: number | null
  reasons: string[]
  state: ApDraftState
}

/** A `listen` dialog's summary of a burst. */
export type ApNote = { seq: number; peer: PeerRef; text: string }

export type ApPhase = 'listening' | 'gathering' | 'typing' | 'thinking' | 'checking' | 'sending'

export type ApView = { kind: 'none' } | { kind: 'card'; dialogId: number; notice: string | null } | { kind: 'ledger' }

/** The newest auto reply while `u` may still delete it. */
export type ApUndoWindow = { seq: number; peer: PeerRef; ids: number[]; text: string; confidence: number | null; until: number }

export type Autopilot = {
  /** Per dialog id; mirrors $.store. */
  dialogs: Record<string, ApDialog>
  /** Dialog ids answered in this session: started from the card, never resumed by a new session. */
  running: number[]
  phase: Record<string, ApPhase>
  view: ApView
  ledger: ApEntry[]
  drafts: ApDraft[]
  notes: ApNote[]
  undo: ApUndoWindow | null
  /** Ticks each second while an undo window is open. */
  now: number
}

// ── /autopilot ──

declare module 'claude-code' {
  interface PluginState {
    'dialogs-pane': {
      mode: Mode
      nav: Nav
      dialogs: Load<TgDialog[]>
      thread: Thread | null
      selection: Selection
      band: BandEvent | null
      now: number
      triage: Triage
      // ── routing ──
      route: Route
      intent: RouteIntent
      isRedacted: boolean
      /** The tray lists what redaction masked. */
      isMaskShown: boolean
      overlay: Overlay
      radar: RadarEntry[]
      /** Whether the main loop is in a turn: main's AgentChip in the route picker. */
      isMainBusy: boolean
      ledger: LedgerEntry[]
      pins: Pin[]
      draft: ReplyDraft | null
      // ── /routing ──
      bottest: BotTest
      autopilot: Autopilot
    }
  }
}
