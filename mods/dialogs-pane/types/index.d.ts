// The dialogs-pane contract: tg's JSON shapes as the mod reads them, and the
// values the mod keeps in $.state. Self-contained: no imports.

/** `sender.kind` and `tg dialogs` `kind`, as README "JSON (--json)" lists them. */
export type TgPeerKind = 'self' | 'user' | 'bot' | 'group' | 'channel' | 'supergroup' | 'unknown'

/** One row of `tg dialogs --json`. */
export type TgDialog = {
  id: number
  kind: TgPeerKind
  title: string
  username: string | null
  unread: number
  last_id: number | null
  last_date: string | null
  last_text: string
}

export type TgSender = {
  id: number | null
  kind: TgPeerKind
  username: string | null
  name: string
}

export type TgButton = {
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

export type TgMedia = {
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

/** One message of `tg read --json` / `tg msg --json`. */
export type TgMessage = {
  id: number
  chat_id: number
  date: string
  sender: TgSender
  out: boolean
  text: string
  reply_to: number | null
  forward: { from_id: number | null; from_name: string | null; date: string | null } | null
  edited: string | null
  edits: number
  pinned: boolean
  service: string | null
  via_bot: string | null
  media: TgMedia | null
  keyboard: 'inline' | 'reply' | null
  buttons: TgButton[][]
  reactions: { emoji: string; count: number }[]
  links: { text: string; url: string }[]
  chat_title?: string
}

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
      bottest: BotTest
    }
  }
}
