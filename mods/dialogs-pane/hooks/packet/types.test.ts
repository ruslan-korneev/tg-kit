import { describe, expect, test } from 'claude-code/testing'

import { parseDialogs, parseMessageViews, parsePeer, parseTopics, TgJsonError } from './types'

// README → "JSON (--json)", with placeholder values.
const README_MESSAGE = {
  id: 677791,
  chat_id: 123456,
  date: '2026-09-29T11:02:00Z',
  sender: { id: 123456, kind: 'bot', username: 'example_bot', name: 'Example' },
  out: false,
  text: 'Choose an option',
  reply_to: null,
  topic_id: null,
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

  test('topic_id: a forum topic\'s id; a tg from before topics prints none, read as outside a forum', () => {
    expect(parseMessageViews([{ ...README_MESSAGE, topic_id: 12 }])[0]?.topic_id).toBe(12)
    const { topic_id: _dropped, ...older } = README_MESSAGE
    expect(parseMessageViews([older])[0]?.topic_id).toBeNull()
    expect(() => parseMessageViews([{ ...README_MESSAGE, topic_id: '12' }])).toThrow('messages[0].topic_id')
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

test('parseDialogs reads tg dialogs rows and names a bad field', () => {
  const row = {
    id: 900000001,
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
    forum: false,
  }
  expect(parseDialogs([row])).toEqual([row])
  expect(() => parseDialogs([{ ...row, unread: null }])).toThrow('dialogs[0].unread')
})

test("parseDialogs: forum is tg's flag for a supergroup with topics; a tg from before topics prints none, read as not a forum", () => {
  const row = { id: -1000000000205, kind: 'supergroup', title: 'Project team', username: null, unread: 9, mentions: 1, pinned: false, muted: false, last_id: 812, last_date: '2026-10-10T14:05:00Z', last_text: 'v2.4 is out' }
  expect(parseDialogs([{ ...row, forum: true }])[0]?.forum).toBe(true)
  expect(parseDialogs([row])[0]?.forum).toBe(false)
  expect(() => parseDialogs([{ ...row, forum: 'yes' }])).toThrow('dialogs[0].forum')
})

test('parseTopics reads the README "Forum topics" row and names a bad field', () => {
  const topic = { id: 12, title: 'Releases', icon_color: 7322096, unread: 5, mentions: 1, pinned: true, closed: false, hidden: false, last_id: 810, last_date: '2026-09-29T11:02:00+00:00', last_text: 'v2.3 is out' }
  expect(parseTopics([topic, { ...topic, id: 1, title: 'General', icon_color: null }])).toEqual([topic, { ...topic, id: 1, title: 'General', icon_color: null }])
  expect(() => parseTopics([{ ...topic, closed: null }])).toThrow('topics[0].closed')
  expect(() => parseTopics({})).toThrow('topics is not an array')
})
