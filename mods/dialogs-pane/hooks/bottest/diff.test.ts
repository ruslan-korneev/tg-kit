import { describe, expect, test } from 'claude-code/testing'

import { msg, REPLY, SENT } from '../packet/fixtures'
import { diffPair, keyboardLines, lineDiff, replyDiff } from './diff'

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
