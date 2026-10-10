// Masks phones, @usernames, numeric ids and people's names before a packet leaves the pane.
// One Redactor keeps one table, so the same value always gets the same placeholder; the pane
// can keep a Redactor per dialog to hold placeholders steady across packets.

import type { MessageView, Peer } from './types'

export const REDACT_KINDS = ['phone', 'username', 'id', 'name'] as const
export type RedactKind = (typeof REDACT_KINDS)[number]

export type Redaction = { kind: RedactKind; original: string; placeholder: string }

export type RedactorOptions = {
  /** Usernames (with or without `@`) that stay readable, e.g. the bot under test. */
  keep?: readonly string[]
}

const PLACEHOLDER: Record<RedactKind, (n: number) => string> = {
  phone: n => `[phone-${n}]`,
  username: n => `[@user-${n}]`,
  id: n => `[id-${n}]`,
  name: n => `[name-${n}]`,
}

// 10–15 digits is a phone number (E.164 caps at 15); fewer digits with separators is
// a date, time or amount and stays. A bare run of 7+ digits is an id (user ids are 9–10
// digits, chats are -100…).
const PHONE_DIGITS = { min: 10, max: 15 } as const
const ID_MIN_DIGITS = 7

// One pass over the text, so a placeholder is never scanned again:
//   a t.me link to a username, an @username, or a number that may carry `+`, spaces, dots,
//   dashes and parentheses between its digits.
// Telegram usernames are 5–32 chars, a letter first; the lookbehind keeps emails out.
const SENSITIVE =
  /(?<tme>\b(?:https?:\/\/)?(?:t\.me|telegram\.me)\/)(?<tmeUser>[A-Za-z][A-Za-z0-9_]{3,31})(?!\w)|(?<![\w@])@(?<user>[A-Za-z][A-Za-z0-9_]{3,31})(?!\w)|(?<![\w+@])(?<number>[+-]?\d(?:[ ().-]{0,2}\d)*)(?!\w)/g
// t.me paths that are not usernames.
const TME_RESERVED = new Set(['joinchat', 'addstickers', 'addemoji', 'addtheme', 'share', 'proxy', 'socks', 'login'])
// 2026-10-10 and what follows it: a date, not a phone.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

export class Redactor {
  private readonly keep: Set<string>
  private readonly table = new Map<string, Redaction>()
  private readonly counts: Record<RedactKind, number> = { phone: 0, username: 0, id: 0, name: 0 }

  constructor(options: RedactorOptions = {}) {
    this.keep = new Set((options.keep ?? []).map(normUsername))
  }

  /** Keeps a username readable from now on (an already masked one stays masked). */
  keepUsername(username: string): void {
    this.keep.add(normUsername(username))
  }

  /** Every value masked so far, in the order first seen. A snapshot, not live state. */
  mapping(): Redaction[] {
    return [...this.table.values()].map(r => ({ ...r }))
  }

  id(value: number | string): string {
    return this.mask('id', String(value), String(value))
  }

  username(value: string): string {
    const bare = value.replace(/^@/, '')
    if (this.keep.has(normUsername(bare))) return value
    return this.mask('username', normUsername(bare), `@${bare}`)
  }

  name(value: string): string {
    return value === '' ? value : this.mask('name', value.trim(), value)
  }

  /** Free text: phones, @mentions, t.me/username links and long digit runs. */
  text(value: string): string {
    let out = ''
    let last = 0
    for (const m of value.matchAll(SENSITIVE)) {
      out += value.slice(last, m.index) + this.replace(m[0], m.groups ?? {})
      last = m.index + m[0].length
    }
    return out + value.slice(last)
  }

  private replace(whole: string, g: Record<string, string | undefined>): string {
    if (g.tme !== undefined && g.tmeUser !== undefined) {
      return TME_RESERVED.has(g.tmeUser.toLowerCase()) ? whole : `${g.tme}${this.username(g.tmeUser)}`
    }
    if (g.user !== undefined) return this.username(whole)
    return this.number(whole)
  }

  private number(whole: string): string {
    const digits = whole.replace(/\D/g, '')
    const separated = /[ ().-]/.test(whole.slice(1))
    if (ISO_DATE.test(whole)) return whole
    const phoneLength = digits.length >= PHONE_DIGITS.min && digits.length <= PHONE_DIGITS.max
    if (whole.startsWith('+') && digits.length >= ID_MIN_DIGITS) return this.mask('phone', `+${digits}`, whole)
    if (phoneLength && separated) return this.mask('phone', `+${digits}`, whole)
    if (!separated && digits.length >= ID_MIN_DIGITS) return this.id(whole)
    return whole
  }

  private mask(kind: RedactKind, key: string, original: string): string {
    const k = `${kind}:${key}`
    const known = this.table.get(k)
    if (known) return known.placeholder
    this.counts[kind] += 1
    const r: Redaction = { kind, original, placeholder: PLACEHOLDER[kind](this.counts[kind]) }
    this.table.set(k, r)
    return r.placeholder
  }
}

function normUsername(u: string): string {
  return u.replace(/^@/, '').toLowerCase()
}

/**
 * The usernames a packet keeps by default: bots are public and the replay command needs
 * them. People, groups and channels are masked.
 */
export function botUsernames(peer: Peer | null, messages: readonly MessageView[]): string[] {
  const out = new Set<string>()
  if (peer?.kind === 'bot' && peer.username) out.add(peer.username)
  for (const m of messages) {
    if (m.sender.kind === 'bot' && m.sender.username) out.add(m.sender.username)
    if (m.via_bot) out.add(m.via_bot)
  }
  return [...out]
}

/** Whose display name is personal: a person's, or the account's own. */
function personal(kind: string): boolean {
  return kind === 'user' || kind === 'self' || kind === 'unknown'
}

/**
 * A copy of the peer with its strings masked. Numeric ids stay numbers here: the packet
 * writer masks them with `Redactor.id` as it prints them.
 */
export function redactPeer(peer: Peer, r: Redactor): Peer {
  return {
    ...peer,
    title: personal(peer.kind) ? r.name(peer.title) : r.text(peer.title),
    username: peer.username === null ? null : r.username(peer.username),
  }
}

/** A copy of the message with its strings masked; numeric ids as in `redactPeer`. */
export function redactMessage(m: MessageView, r: Redactor): MessageView {
  return {
    ...m,
    sender: {
      ...m.sender,
      username: m.sender.username === null ? null : r.username(m.sender.username),
      name: personal(m.sender.kind) ? r.name(m.sender.name) : r.text(m.sender.name),
    },
    text: r.text(m.text),
    forward:
      m.forward === null
        ? null
        : {
            ...m.forward,
            from_name:
              m.forward.from_name === null
                ? null
                : m.forward.from_name.startsWith('@')
                  ? r.username(m.forward.from_name)
                  : r.name(m.forward.from_name),
          },
    media: m.media === null ? null : redactMedia(m.media, r),
    buttons: m.buttons.map(row =>
      row.map(b => ({
        ...b,
        text: r.text(b.text),
        ...(b.url !== undefined && { url: r.text(b.url) }),
        ...(b.query !== undefined && { query: r.text(b.query) }),
        ...(b.copy_text !== undefined && { copy_text: r.text(b.copy_text) }),
      })),
    ),
    links: m.links.map(l => ({ text: r.text(l.text), url: r.text(l.url) })),
    ...(m.chat_title !== undefined && { chat_title: r.text(m.chat_title) }),
  }
}

function redactMedia(media: NonNullable<MessageView['media']>, r: Redactor): NonNullable<MessageView['media']> {
  return {
    ...media,
    ...(media.name !== undefined && { name: r.text(media.name) }),
    // A shared contact's title is the person's name.
    ...(media.title !== undefined && { title: media.type === 'contact' ? r.name(media.title) : r.text(media.title) }),
    ...(media.url !== undefined && { url: r.text(media.url) }),
  }
}
