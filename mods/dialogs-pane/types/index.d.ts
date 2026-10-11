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

/** Open: the pane is up, laid out for where the engine seats it (dock or inline). Hidden: closed. */
export type Mode = 'open' | 'hidden'
export type Lens = 'all' | 'bots' | 'unread'

/** The peer a thread is open on: `arg` is what tg is given (`@name` or the id). */
export type PeerRef = { id: number; arg: string; label: string; kind: TgPeerKind }

export type Nav = {
  /** The column the cursor is in; inline shows only that one. */
  view: 'dialogs' | 'thread'
  lens: Lens
  query: string
  dialogCursor: number
  messageCursor: number
  /**
   * The first row of each list's window, as last drawn: it moves only when the
   * cursor leaves the window (hooks/ui/components.tsx `edgeStart`).
   */
  dialogStart: number
  messageStart: number
  /** `m`: the menu over the view. */
  isMenuOpen: boolean
  /** `s`: the search field is up. */
  isSearching: boolean
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
export type RouteIntent = 'fix' | 'reproduce' | 'explain' | 'test' | 'do_it' | 'draft_reply' | 'raw'

/**
 * Who wrote the message the send sheet is for (docs/design/dialogs-pane-ux.md §4.6):
 * a bot; a person in a chat the owner can write to; anyone else (a channel, the
 * owner, a person where the owner cannot write). Each has its own intents.
 */
export type SenderClass = 'bot' | 'person' | 'other'

/** The send sheet's steps: its intents, `a` the targets, `i` inspect, the last digit's field. */
export type SheetStep = 'intents' | 'targets' | 'inspect' | 'ask'

/** One live agent of this session, as `$.agent.list()` names it. */
export type AgentRef = { agentId: string; label: string }

/** A recipient: this session's main loop, a live agent, or one spawned for the packet. */
export type Recipient = { kind: 'main' } | ({ kind: 'agent' } & AgentRef) | { kind: 'new' }

/** One recipient of a broadcast, with an intent of its own. */
export type Leg = { to: Recipient; intent: RouteIntent }

/** Where a send went: one recipient under the sheet's intent, or a broadcast. */
export type Route = { kind: 'one'; to: Recipient } | { kind: 'broadcast'; legs: Leg[] }

/** `$.agent.list()` statuses folded into the radar's three. */
export type AgentState = 'idle' | 'running' | 'done'
export type RadarEntry = AgentRef & { type: string; state: AgentState }

/** A broadcast being put together from the sheet's targets: each leg on or off. */
export type BroadcastRow = Leg & { isOn: boolean }

/** What the pane draws over the dialogs and thread. */
export type Overlay =
  | { kind: 'none' }
  /**
   * ⏎ on a message: the send sheet for `ids` (the marked set, or the cursor's
   * message), with the intents of `sender`, sending to `to`. `isRedacted` is this
   * packet's alone (inspect toggles it); the next sheet starts redacted again.
   */
  | { kind: 'sheet'; ids: number[]; sender: SenderClass; step: SheetStep; to: Recipient; isRedacted: boolean }
  | { kind: 'broadcast'; rows: BroadcastRow[]; ids: number[]; sender: SenderClass; isRedacted: boolean }

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
  lastOut: { at: number } | null
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

/**
 * listen ◉ reads and summarizes; draft ✎ writes into the band; auto ⟳ sends
 * within the limits; delegate ⚡ also hands work to a Worker agent (── delegate ──).
 */
export type ApLevel = 'listen' | 'draft' | 'auto' | 'delegate'

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
  // ── delegate ── a hard stop met: asked (yes / no, and who said it) or skipped.
  | { kind: 'stop'; stops: DgStop[]; what: string; answer: 'yes' | 'no' | 'skipped'; why: string }

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

/** `unfolded`: the band shows the whole text after ⏎ found it cut short; only then does ⏎ send it. */
export type ApDraftState = { kind: 'ready' } | { kind: 'unfolded' } | { kind: 'editing' } | { kind: 'sending' } | { kind: 'failed'; reason: string }

/** A reply waiting for you in the band: ⏎ send (or open, when the band cuts it short), e edit, x drop, o open. */
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

export type ApView = { kind: 'none' } | { kind: 'card'; dialogId: number; notice: string | null }

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

// ── delegate ──
// Phase 4 (docs/design/dialogs-pane.md §6 "delegate"): the Worker, its grant,
// worktrees, hard stops and dangerouslySkipHardStops. Pure rules in hooks/delegate/.

/** The hard stops, named so each can be skipped alone. */
export type DgStop = 'money' | 'publish' | 'share' | 'delete' | 'commit-on-behalf'

/** off; read: fetch pages and search, nothing sent; full: anything the tools do. */
export type DgWeb = 'off' | 'read' | 'full'

/** checks: the repos' own checks and local, read-only commands; any: Claude Code's permission rules decide. */
export type DgCommands = 'checks' | 'any'

/** Until the task is done, or a deadline this many minutes after it starts; the kill switch ends either. */
export type DgDuration = { kind: 'done' } | { kind: 'deadline'; minutes: number }

/** What the Worker may use, set in the card. */
export type DgGrant = { web: DgWeb; repos: string[]; commands: DgCommands; duration: DgDuration }

/** dangerouslySkipHardStops for one dialog: which stops, until when (null: never). */
export type DgSkip = { stops: DgStop[]; until: number | null }

/** One dialog's delegate settings, kept in $.store (`delegate.dialogs`). */
export type DgDialog = { grant: DgGrant; skip: DgSkip | null; isWarned: boolean }

/** A fresh worktree of a granted repo: the Worker's only place to write. */
export type DgWorktree = { repo: string; path: string; branch: string; checks: string[] }

/** One step on the task card, read off a Worker tool call by the guard. */
export type DgStep = { text: string; count: number; state: 'done' | 'failed' }

/** A hard stop waiting for your answer in the engine's dialog. */
export type DgHold = { id: number; stops: DgStop[]; what: string; since: number }

export type DgStatus = 'starting' | 'working' | 'asking' | 'done' | 'failed' | 'stopped'

/** One task a delegate dialog handed to a Worker: the task card. */
export type DgTask = {
  id: number
  peer: PeerRef
  summary: string
  /** The Worker's agent id once spawned: its tool calls carry it, and the hooks enforce the grant by it. */
  agentId: string | null
  startedAt: number
  /** Local ms; null: until done. */
  deadline: number | null
  grant: DgGrant
  worktrees: DgWorktree[]
  /** The Speaker's hard stops waiting for you; the Worker's are the guard's (GuardHold). */
  holds: DgHold[]
  /** What the Worker asked the chat, while it waits for the answer. */
  question: string | null
  /** The last message the Speaker sent for the task. */
  chat: { text: string; at: number } | null
  status: DgStatus
  /** Why it ended (done: the result; failed / stopped: the reason). */
  reason: string
}

/** The card's per-dialog skip, until you type the dialog's name. */
export type DgPending = { dialogId: number; skip: DgSkip }

export type Delegate = {
  /** Per dialog id; mirrors $.store. */
  dialogs: Record<string, DgDialog>
  tasks: DgTask[]
  /** `/tg autopilot --dangerously-skip-hard-stops[=…]`: until the session ends. */
  sessionSkip: DgStop[]
  /** The mod option `dangerouslySkipHardStops`, mirrored here so the guard plugin reads it. */
  alwaysSkip: DgStop[]
  /** The session's permission mode as the classic hooks last reported it; null: not seen yet. */
  permissionMode: string | null
  pending: DgPending | null
}

// The guard plugin's state (mods/dialogs-pane-guard), as this mod reads it to
// draw. The guard owns, writes and declares it; here it is external data,
// narrowed by hooks/delegate/guard.ts before use.

/** The Worker's steps and the call it runs now, per task. */
export type GuardWork = { taskId: number; steps: DgStep[]; current: string | null }

/** A Worker's hard stop waiting for your answer in the engine's dialog. */
export type GuardHold = { id: number; taskId: number; stops: DgStop[]; what: string; since: number }

/** A Worker's hard stop met: asked (yes / no and who) or skipped. */
export type GuardEvent = { seq: number; at: number; taskId: number; peer: PeerRef; summary: string; stops: DgStop[]; what: string; answer: 'yes' | 'no' | 'skipped'; why: string }

/** The handshake: the guard's last heartbeat, and the task ids it saw and guards (written on every `delegate` write). */
export type GuardArmed = { at: number; taskIds: number[] }

// ── /delegate ──

// ── running ──
// dialogs-pane-ux.md §5.6 and §5.7 (T4): what runs, what the kill switch
// stopped, and Activity. Pure rules in hooks/ui/running.ts.

/**
 * Activity (`l`): its running rows, one per chat, in the order they were first
 * drawn, and the cursor among them. A row that stops stays, drawn stopped, until
 * the view closes, and a row that starts goes last: the rows above the cursor
 * never change while it stays (dialogs-pane-ux.md §4.3 rule 1).
 */
export type ActivityView = { rows: PeerRef[]; cursor: number }

/** What the kill switch stopped, by name: the dock's strip row says it until `until`. */
export type StopNotice = { text: string; until: number }

// ── /running ──

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
      isRedacted: boolean
      overlay: Overlay
      radar: RadarEntry[]
      /** Whether the main loop is in a turn: main's state in the send sheet. */
      isMainBusy: boolean
      ledger: LedgerEntry[]
      pins: Pin[]
      draft: ReplyDraft | null
      // ── /routing ──
      bottest: BotTest
      autopilot: Autopilot
      delegate: Delegate
      // ── running ──
      activity: ActivityView | null
      lastStop: StopNotice | null
    }
  }
}
