import { describe, expect, test } from 'claude-code/testing'

import { parseMessageViews, parsePeer, TgJsonError } from './types'

// README → "JSON (--json)", with placeholder values.
const README_MESSAGE = {
  id: 677791,
  chat_id: 123456,
  date: '2026-09-29T11:02:00Z',
  sender: { id: 123456, kind: 'bot', username: 'example_bot', name: 'Example' },
  out: false,
  text: 'Choose an option',
  reply_to: null,
  forward: { from_id: -1000000000777, from_name: '@example_news', date: '2026-09-28T10:00:00Z' },
  edited: null,
  edits: 0,
  pinned: false,
  service: null,
  via_bot: null,
  media: { type: 'photo', size: 219136, mime: 'image/jpeg', width: 1280, height: 720 },
  keyboard: 'inline',
  buttons: [[{ row: 0, col: 0, type: 'cb', text: 'Settings', data_b64: 'c2V0' }]],
  reactions: [{ emoji: '👍', count: 3 }],
  links: [{ text: 'Privacy policy', url: 'https://example.com/privacy' }],
}

describe('parseMessageViews', () => {
  test('reads the README shape unchanged; unset optional keys stay missing', () => {
    const [m] = parseMessageViews(JSON.parse(JSON.stringify([README_MESSAGE])))
    expect(m).toEqual(README_MESSAGE)
    expect(m === undefined ? [] : Object.keys(m.media ?? {})).toEqual(['type', 'size', 'mime', 'width', 'height'])
    expect(m === undefined ? [] : Object.keys(m)).not.toContain('chat_title')
  })

  test('names the bad field', () => {
    const bad = { ...README_MESSAGE, sender: { ...README_MESSAGE.sender, kind: 'robot' } }
    expect(() => parseMessageViews([bad])).toThrow('messages[0].sender.kind')
    expect(() => parseMessageViews([{ ...README_MESSAGE, id: '1' }])).toThrow(TgJsonError)
    expect(() => parseMessageViews({})).toThrow('messages is not an array')
  })
})

test('parsePeer reads a tg resolve / tg dialogs row', () => {
  const row = { id: 900000001, kind: 'bot', title: 'Example Bot', username: 'example_bot', unread: 2 }
  expect(parsePeer(row)).toEqual({ id: 900000001, kind: 'bot', title: 'Example Bot', username: 'example_bot' })
})
