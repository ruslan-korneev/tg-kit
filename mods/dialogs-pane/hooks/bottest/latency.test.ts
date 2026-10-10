import { describe, expect, test } from 'claude-code/testing'

import { msg, REPLY, SENT } from '../packet/fixtures'
import { NO_TIMING, latencyText, observe, pressed, stampFor } from './latency'

describe('stampFor', () => {
  test('without a watch: the date difference from your trigger, whole seconds', () => {
    expect(stampFor(REPLY, [SENT, REPLY], NO_TIMING)).toEqual({ ms: 1000, isPrecise: false, text: '⏱1s', isSlow: false })
    const slow = msg({ id: 677793, reply_to: 677790, date: '2026-10-10T14:01:10Z' })
    expect(stampFor(slow, [SENT, slow], NO_TIMING)?.isSlow).toBe(true)
  })

  test('your own messages and replies with no trigger get no stamp', () => {
    expect(stampFor(SENT, [SENT, REPLY], NO_TIMING)).toBeNull()
    expect(stampFor(REPLY, [REPLY], NO_TIMING)).toBeNull()
  })

  test('with a watch: local timing to the tenth of a second', () => {
    let timing = observe({ ...NO_TIMING, watch: 'live' }, 'message', SENT, 10_000)
    timing = observe(timing, 'message', REPLY, 11_400)
    expect(stampFor(REPLY, [SENT, REPLY], timing)?.text).toBe('⏱1.4s')
  })

  test('a press times the first edit of the pressed message, from the press', () => {
    let timing = pressed(NO_TIMING, 20_000, REPLY.id, [])
    timing = observe(timing, 'edit', { ...REPLY, edited: '2026-10-10T14:02:00Z' }, 23_500)
    expect(stampFor(REPLY, [SENT, REPLY], timing)).toEqual({ ms: 3500, isPrecise: true, text: '⏱3.5s', isSlow: true })
    // A later edit (another press from elsewhere, a timer) keeps the stamp.
    expect(observe(timing, 'edit', REPLY, 60_000)).toBe(timing)
  })

  test('an edit of a message you did not press is not timed', () => {
    const timing = pressed(NO_TIMING, 20_000, 1, [])
    expect(observe(timing, 'edit', REPLY, 21_000)).toBe(timing)
  })

  test('a press without a watch: the edit date against the press second', () => {
    const at = Date.parse('2026-10-10T14:02:00.700Z')
    const timing = pressed(NO_TIMING, at, REPLY.id, [REPLY.id])
    const edited = { ...REPLY, edited: '2026-10-10T14:02:02Z' }
    expect(stampFor(edited, [SENT, edited], timing)?.text).toBe('⏱2s')
  })

  test('an edit with no press before it is not timed', () => {
    expect(observe(NO_TIMING, 'edit', REPLY, 5000)).toBe(NO_TIMING)
  })
})

test('latencyText', () => {
  expect(latencyText(1400, true)).toBe('1.4s')
  expect(latencyText(1400, false)).toBe('1s')
  expect(latencyText(12_300, true)).toBe('12s')
  expect(latencyText(180_000, false)).toBe('3m')
})
