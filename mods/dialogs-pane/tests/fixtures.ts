// Placeholder chats only (repo rule): @example_bot, a made-up group, Saved Messages.
import type { ProcessRunResult } from 'claude-code'
import type { ElementQuery, FoundElement } from 'claude-code/testing'

import type { FolderKind, TgDialog, TgMessage } from '../types'

export const DIALOGS: TgDialog[] = [
  {
    id: 1001,
    kind: 'bot',
    title: 'Example Bot',
    username: 'example_bot',
    unread: 2,
    mentions: 0,
    pinned: false,
    muted: false,
    last_id: 677792,
    last_date: '2026-10-10T11:02:00Z',
    last_text: 'Main menu',
  },
  {
    id: 1002,
    kind: 'supergroup',
    title: 'Dev Team',
    username: null,
    unread: 5,
    mentions: 0,
    pinned: false,
    muted: false,
    last_id: 500,
    last_date: '2026-10-10T10:58:00Z',
    last_text: 'deploy is green',
  },
  {
    id: 1003,
    kind: 'self',
    title: 'Saved Messages',
    username: null,
    unread: 0,
    mentions: 0,
    pinned: false,
    muted: false,
    last_id: 42,
    last_date: '2026-10-09T08:20:00Z',
    last_text: 'note',
  },
]

const bot = { id: 1001, kind: 'bot', username: 'example_bot', name: 'Example Bot' } as const
const me = { id: 1003, kind: 'self', username: null, name: 'Me' } as const

const base: Omit<TgMessage, 'id' | 'date' | 'sender' | 'out' | 'text'> = {
  chat_id: 1001,
  reply_to: null,
  forward: null,
  edited: null,
  edits: 0,
  pinned: false,
  service: null,
  via_bot: null,
  media: null,
  keyboard: null,
  buttons: [],
  reactions: [],
  links: [],
}

export const MESSAGES: TgMessage[] = [
  { ...base, id: 677790, date: '2026-10-10T11:01:00Z', sender: me, out: true, text: '/settings' },
  {
    ...base,
    id: 677791,
    date: '2026-10-10T11:01:07Z',
    sender: bot,
    out: false,
    text: '⚠ Something went wrong',
    reply_to: 677790,
    keyboard: 'inline',
    buttons: [
      [
        { row: 0, col: 0, type: 'cb', text: 'Retry', data_b64: 'cmV0cnk=' },
        { row: 0, col: 1, type: 'cb', text: 'Back', data_b64: 'YmFjaw==' },
      ],
    ],
  },
  { ...base, id: 677792, date: '2026-10-10T11:02:00Z', sender: bot, out: false, text: 'Main menu' },
]

// A person, a group with a member and the bot, a channel: §4.6's senders.
export const MORE_DIALOGS: TgDialog[] = [
  { id: 1004, kind: 'user', title: 'Contact A', username: null, unread: 1, mentions: 0, pinned: false, muted: false, last_id: 92, last_date: '2026-10-10T10:49:00Z', last_text: 'Can we call tomorrow at 10?' },
  { id: 1005, kind: 'channel', title: 'Announcements', username: null, unread: 0, mentions: 0, pinned: false, muted: false, last_id: 7, last_date: '2026-10-10T09:19:00Z', last_text: 'release 2.0 is out' },
]

const contact = { id: 1004, kind: 'user', username: null, name: 'Contact A' } as const
const member = { id: 2001, kind: 'user', username: null, name: 'Member 1' } as const
const channel = { id: 1005, kind: 'channel', username: null, name: 'Announcements' } as const

export const PERSON_MESSAGES: TgMessage[] = [
  { ...base, chat_id: 1004, id: 91, date: '2026-10-10T10:40:00Z', sender: me, out: true, text: 'got it, reading' },
  { ...base, chat_id: 1004, id: 92, date: '2026-10-10T10:49:00Z', sender: contact, out: false, text: 'Can we call tomorrow at 10?' },
]

export const GROUP_MESSAGES: TgMessage[] = [
  { ...base, chat_id: 1002, id: 499, date: '2026-10-10T10:44:00Z', sender: member, out: false, text: 'anyone looked at the flaky checkout test?' },
  { ...base, chat_id: 1002, id: 500, date: '2026-10-10T10:58:00Z', sender: bot, out: false, text: 'deploy is green' },
]

export const CHANNEL_MESSAGES: TgMessage[] = [
  { ...base, chat_id: 1005, id: 7, date: '2026-10-10T09:19:00Z', sender: channel, out: false, text: 'release 2.0 is out' },
]

/** What `tg read <peer>` answers per placeholder chat; the bot's thread for any other. */
export function messagesFor(peer: string | undefined): TgMessage[] {
  switch (peer) {
    case '1004':
      return PERSON_MESSAGES
    case '1002':
      return GROUP_MESSAGES
    case '1005':
      return CHANNEL_MESSAGES
    default:
      return MESSAGES
  }
}

/** A placeholder Telegram folder: its chats in its order, its pins first. */
export type FolderSpec = { id: number; title: string; kind: FolderKind; chats: number[]; pinned?: number[] }

/**
 * What tg answers to `folders` (`--chats` for the pass) on a placeholder
 * account whose chats are what `listed` (its `tg dialogs` answer) holds: the
 * folders given, then All chats with every chat, as an account without
 * folders has it. A failed `listed` fails the same way.
 */
export function folderRun(argv: readonly string[], listed: ProcessRunResult, folders: readonly FolderSpec[] = []): ProcessRunResult {
  if (listed.exitCode !== 0) return listed
  const rows: TgDialog[] = JSON.parse(listed.stdout)
  const all: FolderSpec = { id: 0, title: 'All chats', kind: 'all', chats: rows.map(row => row.id) }
  const specs = [...folders, ...(folders.some(one => one.kind === 'all') ? [] : [all])]
  const unread = (spec: FolderSpec) => rows.filter(row => spec.chats.includes(row.id) && row.unread > 0 && !row.muted).length
  const value = argv.includes('--chats')
    ? {
        at: '2026-10-10T12:00:00+00:00',
        scan: 500,
        folders: specs.map(spec => ({ id: spec.id, title: spec.title, kind: spec.kind, unread: unread(spec), pinned: spec.pinned ?? [], chats: spec.chats })),
        dialogs: rows.filter(row => specs.some(spec => spec.chats.includes(row.id))),
      }
    : specs.map(spec => ({ id: spec.id, title: spec.title, kind: spec.kind }))
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** What the helpers below need of a mounted pane. */
type Finder = { findAll: (query: ElementQuery) => Promise<FoundElement[]>; find: (query: ElementQuery) => Promise<FoundElement | undefined> }

/**
 * The key a chat's row is drawn under now, `dialog:<gen>:<id>`: the list's
 * generation is part of it and goes up as the list reshapes (§8 T9). A row
 * not drawn gets a key nothing has.
 */
export async function chatKey(ui: Finder, id: number): Promise<string> {
  const drawn = [...(await ui.findAll({ type: 'Button' })), ...(await ui.findAll({ type: 'Box' }))]
  return drawn.find(one => one.key?.startsWith('dialog:') === true && one.key.endsWith(`:${id}`))?.key ?? `dialog:none:${id}`
}

/** The chat's row as drawn, if it is. */
export async function findChat(ui: Finder, id: number): Promise<FoundElement | undefined> {
  return ui.find({ key: await chatKey(ui, id) })
}

/** The chat ids of `dialog:<gen>:<id>` keys, in order. */
export function chatIds(keys: readonly (string | undefined)[]): number[] {
  return keys.flatMap(key => (key?.startsWith('dialog:') === true ? [Number(key.split(':')[2])] : []))
}
