// The open chat's message rows, pure (dialogs-pane-ux.md §7.3, §8 T6).
import { describe, expect, test } from 'claude-code/testing'

import { ME, msg } from '../packet/fixtures'
import { CHIPS_ON_ROW_FROM, chipLabels, chipsCells, clockOf, dayDividers, dayLabel, messageLooks, messageRows, senderColumn } from './thread'

/** Local times, so the day boundaries hold in any time zone the tests run in. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
const NOW = new Date(2026, 9, 11, 12, 0).getTime()
const MEMBER = { id: 2001, kind: 'user', username: null, name: 'Member 1' } as const
const LONG = { id: 2002, kind: 'user', username: null, name: 'A Very Long Member Name' } as const
const RETRY = [
  [
    { row: 0, col: 0, type: 'cb', text: 'Retry', data_b64: 'cmV0cnk=' },
    { row: 0, col: 1, type: 'cb', text: 'Back', data_b64: 'YmFjaw==' },
  ],
]

describe('the sender column (§7.3)', () => {
  test('3 cells and a gap of 2 in a bot chat; elsewhere the longest name, up to 10, and a gap of 1', () => {
    const thread = [msg({ id: 1, out: true, sender: ME }), msg({ id: 2 })]
    expect(senderColumn(thread, 'bot')).toEqual({ width: 3, gap: 2 })
    expect(senderColumn(thread, 'botfather')).toEqual({ width: 3, gap: 2 })
    expect(senderColumn([...thread, msg({ id: 3, sender: MEMBER })], 'group')).toEqual({ width: 8, gap: 1 })
    expect(senderColumn([msg({ id: 3, sender: LONG })], 'group')).toEqual({ width: 10, gap: 1 })
    expect(senderColumn([msg({ id: 1, out: true, sender: ME })], 'person')).toEqual({ width: 3, gap: 1 })
  })
})

describe('day dividers instead of dates in the time column (§7.3)', () => {
  test('the time column holds the time; the divider says today, yesterday, or the date', () => {
    expect(clockOf(at(10, 21, 2))).toBe('21:02')
    expect(dayLabel(at(11, 9), NOW)).toBe('today')
    expect(dayLabel(at(10, 23, 59), NOW)).toBe('yesterday')
    expect(dayLabel(at(8, 10), NOW)).toBe('10-08')
  })

  test('one before the first message of each day; a thread of today alone spends no row on it', () => {
    const thread = [msg({ id: 1, date: at(8, 10) }), msg({ id: 2, date: at(8, 11) }), msg({ id: 3, date: at(10, 20) }), msg({ id: 4, date: at(11, 9) }), msg({ id: 5, date: at(11, 10) })]
    expect([...dayDividers(thread, NOW)]).toEqual([
      [1, '10-08'],
      [3, 'yesterday'],
      [4, 'today'],
    ])
    expect([...dayDividers(thread.slice(3), NOW)]).toEqual([])
  })
})

describe('a message’s buttons on its own row from 90 columns (§7.3)', () => {
  const sender = { width: 3, gap: 2 }
  const reply = msg({ id: 7, date: at(11, 9), buttons: RETRY })

  test('from 90 columns they share the row; narrower, they take the row under it', () => {
    expect(messageLooks([reply], CHIPS_ON_ROW_FROM, NOW, sender, false).get(7)).toEqual({ divider: null, isChipsOnRow: true })
    expect(messageLooks([reply], CHIPS_ON_ROW_FROM - 1, NOW, sender, false).get(7)).toEqual({ divider: null, isChipsOnRow: false })
    expect(messageRows(reply, { divider: null, isChipsOnRow: true })).toBe(1)
    expect(messageRows(reply, { divider: null, isChipsOnRow: false })).toBe(2)
    expect(messageRows(reply, { divider: 'yesterday', isChipsOnRow: false })).toBe(3)
    expect(messageRows(msg({ id: 8 }), { divider: null, isChipsOnRow: true })).toBe(1)
  })

  test('a URL chip carries its URL, so its keyboard takes the row under the message', () => {
    const link = msg({ id: 9, date: at(11, 9), buttons: [[{ row: 0, col: 0, type: 'url', text: 'Docs', url: 'https://example.com/docs' }]] })
    expect(chipLabels(link.buttons, Infinity)).toEqual([['Docs → https://example.com/docs']])
    expect(messageLooks([link], 120, NOW, sender, false).get(9)?.isChipsOnRow).toBe(false)
  })

  test('chips take their digit form’s cells, with a · between keyboard rows', () => {
    // `1: Retry  2: Back`: 8 + 2 + 7.
    expect(chipsCells([['Retry', 'Back']])).toBe(17)
    // `1: A  ·  2: B`.
    expect(chipsCells([['A'], ['B']])).toBe(13)
  })
})
