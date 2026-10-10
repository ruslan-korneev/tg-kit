// Placeholder chats only (repo rule): @example_bot, a made-up group, Saved Messages.
import type { TgDialog, TgMessage } from '../types'

export const DIALOGS: TgDialog[] = [
  {
    id: 1001,
    kind: 'bot',
    title: 'Example Bot',
    username: 'example_bot',
    unread: 2,
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
