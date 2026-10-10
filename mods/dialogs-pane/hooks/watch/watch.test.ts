import { expect, test } from 'claude-code/testing'

import { REPLY } from '../packet/fixtures'
import { watchArgv, watchEvent, watchLines } from './watch'

test('argv: every event kind; --after to replay; --idle-exit only when every listener allows it', () => {
  expect(watchArgv('@example_bot', { after: null, isBounded: true })).toEqual([
    'tg', 'watch', '@example_bot', '--jsonl', '--idle-exit', '15m',
  ])
  expect(watchArgv('@example_bot', { after: 677792, isBounded: false })).toEqual([
    'tg', 'watch', '@example_bot', '--jsonl', '--after', '677792',
  ])
})

test('watchLines joins lines split across chunks', () => {
  const line = JSON.stringify({ event: 'message', ...REPLY })
  const first = watchLines('', `{"event":"ready","peers":[]}\n${line.slice(0, 20)}`)
  expect(first.events).toEqual([{ event: 'ready' }])
  const second = watchLines(first.rest, `${line.slice(20)}\n`)
  expect(second.events).toEqual([{ event: 'message', message: REPLY }])
  expect(second.rest).toBe('')
})

test('typing and delete are read for listeners that want them; the rest is noise', () => {
  const sender = { id: 1001, kind: 'bot', username: 'example_bot', name: 'Example Bot' }
  expect(watchEvent(JSON.stringify({ event: 'typing', chat_id: 1001, date: 'x', sender, action: 'typing' }))).toEqual({
    event: 'typing',
    chatId: 1001,
    action: 'typing',
    sender,
  })
  expect(watchEvent(JSON.stringify({ event: 'delete', chat_id: null, date: 'x', ids: [5, 6] }))).toEqual({
    event: 'delete',
    chatId: null,
    ids: [5, 6],
  })
  expect(watchEvent(JSON.stringify({ event: 'edit', ...REPLY, text: 'Saved' }))).toEqual({
    event: 'edit',
    message: { ...REPLY, text: 'Saved' },
  })
  expect(watchEvent(JSON.stringify({ event: 'message', id: 'x' }))).toBeNull()
  expect(watchEvent('{"event": "typing"}')).toBeNull()
  expect(watchEvent('{"event": "reaction"}')).toBeNull()
  expect(watchEvent('not json')).toBeNull()
})
