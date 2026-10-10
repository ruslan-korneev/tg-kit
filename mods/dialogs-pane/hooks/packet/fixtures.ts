// Test fixtures: tg's JSON message shape with placeholder data only.

import type { MessageView, Peer } from './types'

export const BOT: Peer = { id: 900000001, kind: 'bot', title: 'Example Bot', username: 'example_bot' }
export const PERSON: Peer = { id: 900000002, kind: 'user', title: 'Contact A', username: 'contact_a' }

export function msg(over: Partial<MessageView> & Pick<MessageView, 'id'>): MessageView {
  return {
    chat_id: BOT.id,
    date: '2026-10-10T14:01:00Z',
    sender: { id: BOT.id, kind: 'bot', username: 'example_bot', name: 'Example Bot' },
    out: false,
    text: '',
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
    ...over,
  }
}

export const ME = { id: 900000000, kind: 'self', username: null, name: 'Me' } as const

/** You sent /settings; the bot answered with an error and two callback buttons. */
export const SENT = msg({ id: 677790, out: true, sender: ME, text: '/settings', date: '2026-10-10T14:01:06Z' })
export const REPLY = msg({
  id: 677791,
  date: '2026-10-10T14:01:07Z',
  text: '⚠ Something went wrong',
  reply_to: 677790,
  keyboard: 'inline',
  buttons: [
    [
      { row: 0, col: 0, type: 'cb', text: 'Retry', data_b64: 'cmV0cnk=' },
      { row: 0, col: 1, type: 'cb', text: 'Back', data_b64: 'YmFjaw==' },
    ],
  ],
})
