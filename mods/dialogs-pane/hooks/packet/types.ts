// What `tg … --json` prints, mirrored by hand. The source of truth is tg itself:
// `src/tg_kit/render.py` (`message_json`), `src/tg_kit/buttons.py` (`Button.to_json`),
// `src/tg_kit/cmd_read.py` (`dialogs`, `resolve`) and README → "JSON (--json)".
// A change there is a contract change and lands here in the same commit.

export const SENDER_KINDS = [
  'self',
  'user',
  'bot',
  'group',
  'channel',
  'supergroup',
  'unknown',
] as const
export type SenderKind = (typeof SENDER_KINDS)[number]

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

/** The chat a packet is about: `tg resolve --json` (or a `Dialog`) carries these. */
export type Peer = Pick<Dialog, 'id' | 'kind' | 'title' | 'username'>

export class TgJsonError extends Error {
  readonly path: string

  constructor(path: string, expected: string) {
    super(`tg --json: ${path} is not ${expected}`)
    this.name = 'TgJsonError'
    this.path = path
  }
}

type Obj = Record<string, unknown>

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TgJsonError(path, 'an object')
  // A non-null, non-array object: reading its keys as unknown is what Obj says.
  return v as Obj
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new TgJsonError(path, 'an array')
  return v
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new TgJsonError(path, 'a string')
  return v
}
function int(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new TgJsonError(path, 'an integer')
  return v
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TgJsonError(path, 'a number')
  return v
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new TgJsonError(path, 'a boolean')
  return v
}
function nullable<T>(v: unknown, path: string, read: (v: unknown, path: string) => T): T | null {
  return v === null ? null : read(v, path)
}
function optional<T>(o: Obj, key: string, path: string, read: (v: unknown, path: string) => T): T | undefined {
  return key in o ? read(o[key], `${path}.${key}`) : undefined
}
function kind(v: unknown, path: string): SenderKind {
  const s = str(v, path)
  const known = SENDER_KINDS.find(k => k === s)
  if (known === undefined) throw new TgJsonError(path, `one of ${SENDER_KINDS.join(' ')}`)
  return known
}

/** Drops the keys whose value is undefined, so optional fields stay missing, never `undefined`. */
function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

function parseButton(v: unknown, path: string): Button {
  const o = obj(v, path)
  return compact({
    row: int(o.row, `${path}.row`),
    col: int(o.col, `${path}.col`),
    type: str(o.type, `${path}.type`),
    text: str(o.text, `${path}.text`),
    data_b64: optional(o, 'data_b64', path, str),
    url: optional(o, 'url', path, str),
    query: optional(o, 'query', path, str),
    same_peer: optional(o, 'same_peer', path, bool),
    user_id: optional(o, 'user_id', path, int),
    copy_text: optional(o, 'copy_text', path, str),
    requires_password: optional(o, 'requires_password', path, bool),
  })
}

function parseMedia(v: unknown, path: string): Media {
  const o = obj(v, path)
  return compact({
    type: str(o.type, `${path}.type`),
    size: optional(o, 'size', path, int),
    name: optional(o, 'name', path, str),
    mime: optional(o, 'mime', path, str),
    duration: optional(o, 'duration', path, num),
    width: optional(o, 'width', path, int),
    height: optional(o, 'height', path, int),
    emoji: optional(o, 'emoji', path, str),
    title: optional(o, 'title', path, str),
    url: optional(o, 'url', path, str),
  })
}

function keyboard(v: unknown, path: string): 'inline' | 'reply' | null {
  if (v === null || v === 'inline' || v === 'reply') return v
  throw new TgJsonError(path, 'inline, reply or null')
}

/** One message of `tg read|msg|search --json`, checked field by field. */
export function parseMessageView(v: unknown, path = 'message'): MessageView {
  const o = obj(v, path)
  const s = obj(o.sender, `${path}.sender`)
  const fwd = o.forward === null ? null : obj(o.forward, `${path}.forward`)
  return compact({
    id: int(o.id, `${path}.id`),
    chat_id: int(o.chat_id, `${path}.chat_id`),
    date: str(o.date, `${path}.date`),
    sender: {
      id: nullable(s.id, `${path}.sender.id`, int),
      kind: kind(s.kind, `${path}.sender.kind`),
      username: nullable(s.username, `${path}.sender.username`, str),
      name: str(s.name, `${path}.sender.name`),
    },
    out: bool(o.out, `${path}.out`),
    text: str(o.text, `${path}.text`),
    reply_to: nullable(o.reply_to, `${path}.reply_to`, int),
    forward:
      fwd === null
        ? null
        : {
            from_id: nullable(fwd.from_id, `${path}.forward.from_id`, int),
            from_name: nullable(fwd.from_name, `${path}.forward.from_name`, str),
            date: nullable(fwd.date, `${path}.forward.date`, str),
          },
    edited: nullable(o.edited, `${path}.edited`, str),
    edits: int(o.edits, `${path}.edits`),
    pinned: bool(o.pinned, `${path}.pinned`),
    service: nullable(o.service, `${path}.service`, str),
    via_bot: nullable(o.via_bot, `${path}.via_bot`, str),
    media: nullable(o.media, `${path}.media`, parseMedia),
    keyboard: keyboard(o.keyboard, `${path}.keyboard`),
    buttons: arr(o.buttons, `${path}.buttons`).map((row, r) =>
      arr(row, `${path}.buttons[${r}]`).map((b, c) => parseButton(b, `${path}.buttons[${r}][${c}]`)),
    ),
    reactions: arr(o.reactions, `${path}.reactions`).map((x, i) => {
      const r = obj(x, `${path}.reactions[${i}]`)
      return { emoji: str(r.emoji, `${path}.reactions[${i}].emoji`), count: int(r.count, `${path}.reactions[${i}].count`) }
    }),
    links: arr(o.links, `${path}.links`).map((x, i) => {
      const l = obj(x, `${path}.links[${i}]`)
      return { text: str(l.text, `${path}.links[${i}].text`), url: str(l.url, `${path}.links[${i}].url`) }
    }),
    chat_title: optional(o, 'chat_title', path, str),
  })
}

/** The list `tg read|msg|search --json` prints. */
export function parseMessageViews(v: unknown): MessageView[] {
  return arr(v, 'messages').map((m, i) => parseMessageView(m, `messages[${i}]`))
}

/** `tg resolve --json`, or one `tg dialogs --json` row. */
export function parsePeer(v: unknown, path = 'peer'): Peer {
  const o = obj(v, path)
  return {
    id: int(o.id, `${path}.id`),
    kind: kind(o.kind, `${path}.kind`),
    title: str(o.title, `${path}.title`),
    username: nullable(o.username, `${path}.username`, str),
  }
}
