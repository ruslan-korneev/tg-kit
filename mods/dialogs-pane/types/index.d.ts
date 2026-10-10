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
    }
  }
}
