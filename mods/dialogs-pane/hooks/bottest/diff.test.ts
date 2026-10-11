import { describe, expect, test } from 'claude-code/testing'

import { ME, msg, REPLY, SENT } from '../packet/fixtures'
import { diffPair, keyboardLines, lineDiff, replyDiff, replyPair } from './diff'

const AFTER = msg({
  id: 677795,
  text: '⚠ Something went wrong\nTry again later',
  buttons: [
    [
      { row: 0, col: 0, type: 'cb', text: 'Retry', data_b64: 'cmV0cnky' },
      { row: 0, col: 1, type: 'cb', text: 'Menu', data_b64: 'YmFjaw==' },
    ],
    [{ row: 1, col: 0, type: 'url', text: 'Status', url: 'https://example.com/status' }],
  ],
})

describe('diffPair', () => {
  test('exactly two bot replies, older first', () => {
    expect(diffPair([677795, 677791], [REPLY, AFTER])).toEqual({ ok: true, pair: [677791, 677795] })
  })

  test('anything else says what to select', () => {
    expect(diffPair([677791], [REPLY])).toEqual({ ok: false, reason: 'select exactly two bot replies with x (now 1)' })
    expect(diffPair([677790, 677791], [SENT, REPLY])).toEqual({ ok: false, reason: 'both selected messages must be bot replies' })
  })
})

describe('replyPair: f with nothing marked (§8 T6)', () => {
  const start = msg({ id: 10, out: true, sender: ME, text: '/start' })
  const hello = msg({ id: 11, text: 'Hi!', reply_to: 10 })
  const settings = msg({ id: 12, out: true, sender: ME, text: '/settings' })
  const failed = msg({ id: 13, text: '⚠ Something went wrong', reply_to: 12 })
  const menu = msg({ id: 14, text: 'Main menu' })
  const again = msg({ id: 15, out: true, sender: ME, text: '/settings' })
  const saved = msg({ id: 16, text: 'Settings saved', reply_to: 15 })

  test('the last earlier reply to the same message: its reply_to, else the last one you sent before it', () => {
    const thread = [start, hello, settings, failed, menu]
    expect(replyPair(menu, thread)).toEqual([13, 14])
    expect(replyPair(failed, thread)).toBeNull()
    expect(replyPair(hello, thread)).toBeNull()
  })

  test('the same text sent again counts as the same message: /settings twice pairs its replies', () => {
    const thread = [start, hello, settings, failed, again, saved]
    expect(replyPair(saved, thread)).toEqual([13, 16])
  })

  test('a sent photo has no text: its replies pair by the message itself', () => {
    const photo = msg({ id: 20, out: true, sender: ME, text: '', media: { type: 'photo' } })
    const first = msg({ id: 21, text: 'Nice photo', reply_to: 20 })
    const second = msg({ id: 22, text: 'Saved it', reply_to: 20 })
    const other = msg({ id: 23, out: true, sender: ME, text: '', media: { type: 'photo' } })
    const third = msg({ id: 24, text: 'Another one', reply_to: 23 })
    expect(replyPair(second, [photo, first, second])).toEqual([21, 22])
    // Another photo is another message, though its text is as empty.
    expect(replyPair(third, [photo, first, second, other, third])).toBeNull()
  })

  test('only a bot reply has a pair', () => {
    expect(replyPair(again, [settings, failed, again])).toBeNull()
  })
})

test('lineDiff keeps common lines and marks the rest, removals first', () => {
  expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
    { op: 'same', text: 'a' },
    { op: 'del', text: 'b' },
    { op: 'add', text: 'x' },
    { op: 'same', text: 'c' },
    { op: 'add', text: 'd' },
  ])
})

test('replyDiff: text lines, keyboard shape, labels and callback data', () => {
  const diff = replyDiff(REPLY, AFTER)
  expect(diff.text).toEqual([
    { op: 'same', text: '⚠ Something went wrong' },
    { op: 'add', text: 'Try again later' },
  ])
  expect(diff.rows).toEqual([1, 2])
  expect(keyboardLines(diff).map(line => line.text)).toEqual([
    'keyboard: 1 → 2 rows (2 → 2+1)',
    '~ 0:0 "Retry" cb retry → "Retry" cb retry2 (data)',
    '~ 0:1 "Back" cb back → "Menu" cb back (label)',
    '+ 1:0 "Status" url https://example.com/status',
  ])
})

test('the same keyboard says so', () => {
  expect(keyboardLines(replyDiff(REPLY, { ...REPLY, id: 677796 })).map(line => line.text)).toEqual([
    'keyboard: 1 rows (2), same shape',
    '  2 buttons unchanged',
  ])
})
