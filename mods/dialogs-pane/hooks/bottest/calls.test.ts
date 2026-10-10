import { describe, expect, test } from 'claude-code/testing'

import { REPLY, SENT } from '../packet/fixtures'
import { calls, decodeAllow, mergeMessages, settleWrite, watchLines } from './calls'

const ran = (exitCode: number, stdout: unknown, stderr = '') => ({ exitCode, stdout: JSON.stringify(stdout), stderr })

describe('settleWrite', () => {
  test('a press: the edited message, replies and the callback answer', () => {
    const result = settleWrite(ran(0, { button: {}, answer: { alert: null, toast: 'Saved', url: null }, replies: [REPLY] }))
    expect(result).toMatchObject({ ok: true, noReply: false, exit: 0, sent: [], answer: 'toast: Saved' })
    expect(result.ok && result.replies.map(one => one.id)).toEqual([677791])
  })

  test('exit 6 still carries what was sent', () => {
    const result = settleWrite(ran(6, { sent: [SENT], replies: [] }, 'error: no reply within 10s'))
    expect(result).toMatchObject({ ok: true, noReply: true, exit: 6 })
    expect(result.ok && result.sent.map(one => one.id)).toEqual([677790])
  })

  test('exit 7 is a guard refusal; tg missing is `missing`', () => {
    expect(settleWrite({ exitCode: 7, stdout: '', stderr: 'error: target is not in the allowlist\n  fix: …' })).toEqual({
      ok: false,
      failure: { kind: 'error', message: 'target is not in the allowlist' },
      isRefused: true,
    })
    expect(settleWrite(undefined)).toEqual({ ok: false, failure: { kind: 'missing' }, isRefused: false })
  })

  test('an odd shape is an error, not a crash', () => {
    expect(settleWrite({ exitCode: 0, stdout: 'not json', stderr: '' }).ok).toBe(false)
    expect(settleWrite(ran(0, { replies: [{ id: 'x' }] })).ok).toBe(false)
  })
})

test('argv: press waits 5 s, send reads the text from stdin as typed', () => {
  expect(calls.press('@example_bot', 677791, 0, 1)).toEqual(['tg', 'press', '@example_bot', '677791', '--row', '0', '--col', '1', '--wait', '5s', '--json'])
  expect(calls.send('@example_bot')).toEqual(['tg', 'send', '@example_bot', '-', '--plain', '--wait', '10s', '--json'])
})

test('decodeAllow reads ids and rejects other shapes', () => {
  expect(decodeAllow([{ id: 900000001, kind: 'bot', username: 'example_bot' }])).toEqual([900000001])
  expect(decodeAllow({ id: 1 })).toBeUndefined()
})

test('watchLines joins lines split across chunks and skips kinds it does not use', () => {
  const line = JSON.stringify({ event: 'message', ...REPLY })
  const first = watchLines('', `{"event":"ready","peers":[]}\n${line.slice(0, 20)}`)
  expect(first.events).toEqual([{ event: 'ready' }])
  const second = watchLines(first.rest, `${line.slice(20)}\n{"event":"typing"}\n`)
  expect(second.events.map(one => (one.event === 'ready' ? 'ready' : one.message.id))).toEqual([677791])
  expect(second.rest).toBe('')
})

test('mergeMessages replaces edits in place and adds new ones in id order', () => {
  const edited = { ...REPLY, text: 'Saved' }
  expect(mergeMessages([SENT, REPLY], [edited, { ...REPLY, id: 677792 }]).map(one => [one.id, one.text])).toEqual([
    [677790, '/settings'],
    [677791, 'Saved'],
    [677792, '⚠ Something went wrong'],
  ])
})
