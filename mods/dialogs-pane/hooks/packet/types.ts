// What `tg … --json` prints, checked. The shapes live in the mod's contract
// (types/index.d.ts), which must be self-contained; this module re-exports
// them and holds the parsers. A change in tg lands in both in one commit.

import type { Button, Dialog, Media, MessageView, Sender, SenderKind } from '../../types'

export type {
  Button,
  Dialog,
  Forward,
  Link,
  Media,
  MessageView,
  Reaction,
  Sender,
  SenderKind,
} from '../../types'

export const SENDER_KINDS = [
  'self',
  'user',
  'bot',
  'group',
  'channel',
  'supergroup',
  'unknown',
] as const satisfies readonly SenderKind[]

// Fails to compile when the contract gains a kind this list lacks.
const KINDS_LISTED: Exclude<SenderKind, (typeof SENDER_KINDS)[number]> extends never ? true : never = true
void KINDS_LISTED

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

/** A message's `sender`, or a `tg watch` typing event's. */
export function parseSender(v: unknown, path = 'sender'): Sender {
  const s = obj(v, path)
  return {
    id: nullable(s.id, `${path}.id`, int),
    kind: kind(s.kind, `${path}.kind`),
    username: nullable(s.username, `${path}.username`, str),
    name: str(s.name, `${path}.name`),
  }
}

/** One message of `tg read|msg|search --json`, checked field by field. */
export function parseMessageView(v: unknown, path = 'message'): MessageView {
  const o = obj(v, path)
  const fwd = o.forward === null ? null : obj(o.forward, `${path}.forward`)
  return compact({
    id: int(o.id, `${path}.id`),
    chat_id: int(o.chat_id, `${path}.chat_id`),
    date: str(o.date, `${path}.date`),
    sender: parseSender(o.sender, `${path}.sender`),
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

/** One row of `tg dialogs --json`. */
export function parseDialog(v: unknown, path = 'dialog'): Dialog {
  const o = obj(v, path)
  return {
    id: int(o.id, `${path}.id`),
    kind: kind(o.kind, `${path}.kind`),
    title: str(o.title, `${path}.title`),
    username: nullable(o.username, `${path}.username`, str),
    unread: int(o.unread, `${path}.unread`),
    last_id: nullable(o.last_id, `${path}.last_id`, int),
    last_date: nullable(o.last_date, `${path}.last_date`, str),
    last_text: str(o.last_text, `${path}.last_text`),
  }
}

/** The list `tg dialogs --json` prints. */
export function parseDialogs(v: unknown): Dialog[] {
  return arr(v, 'dialogs').map((d, i) => parseDialog(d, `dialogs[${i}]`))
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
