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
    }
  }
}
