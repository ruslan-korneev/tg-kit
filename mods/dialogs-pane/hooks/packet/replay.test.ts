import { describe, expect, test } from 'claude-code/testing'

import { BOT, ME, msg, PERSON, REPLY, SENT } from './fixtures'
import { Redactor } from './redact'
import { buildReplay, peerSpec, shellQuote } from './replay'

describe('buildReplay', () => {
  test('a bot reply replays the command you sent, with --wait', () => {
    expect(buildReplay(REPLY, [SENT, REPLY], BOT)).toBe('tg send @example_bot /settings --wait 10s')
    expect(buildReplay(REPLY, [SENT], BOT, { waitSeconds: 30 })).toBe('tg send @example_bot /settings --wait 30s')
  })

  test('without reply_to, the last message you sent before it', () => {
    const older = msg({ id: 5, out: true, sender: ME, text: '/help' })
    const newer = msg({ id: 7, out: true, sender: ME, text: '/menu' })
    const later = msg({ id: 9, out: true, sender: ME, text: '/later' })
    const reply = msg({ id: 8, text: 'Menu' })
    expect(buildReplay(reply, [older, newer, later], BOT)).toBe('tg send @example_bot /menu --wait 10s')
  })

  test('/start with a payload becomes tg start', () => {
    const start = msg({ id: 5, out: true, sender: ME, text: '/start ref_42' })
    expect(buildReplay(msg({ id: 6 }), [start], BOT)).toBe('tg start @example_bot ref_42 --wait 10s')
    const bare = msg({ id: 5, out: true, sender: ME, text: '/start' })
    expect(buildReplay(msg({ id: 6 }), [bare], BOT)).toBe('tg start @example_bot --wait 10s')
  })

  test('your own message replays itself; to a person, without --wait', () => {
    const mine = msg({ id: 5, chat_id: PERSON.id, out: true, sender: ME, text: "it's done", reply_to: 3 })
    expect(buildReplay(mine, [], PERSON)).toBe("tg send @contact_a 'it'\\''s done' --reply-to 3")
  })

  test('markdown-looking text is sent --plain; a leading dash goes through stdin', () => {
    const md = msg({ id: 5, out: true, sender: ME, text: '/set_name *bold*' })
    expect(buildReplay(md, [], BOT)).toBe("tg send @example_bot '/set_name *bold*' --plain --wait 10s")
    const dash = msg({ id: 5, out: true, sender: ME, text: '-5' })
    expect(buildReplay(dash, [], BOT)).toBe("printf '%s' -5 | tg send @example_bot - --wait 10s")
  })

  test('nothing replayable: no message of yours, media, another chat', () => {
    expect(buildReplay(REPLY, [], BOT)).toBe(null)
    const photo = msg({ id: 5, out: true, sender: ME, media: { type: 'photo' } })
    expect(buildReplay(msg({ id: 6 }), [photo], BOT)).toBe(null)
    const elsewhere = msg({ id: 5, chat_id: 1, out: true, sender: ME, text: '/x' })
    expect(buildReplay(msg({ id: 6 }), [elsewhere], BOT)).toBe(null)
  })

  test('a redactor masks the peer and the text', () => {
    const r = new Redactor()
    const mine = msg({ id: 5, chat_id: PERSON.id, out: true, sender: ME, text: 'call +1 555 010 0200' })
    expect(buildReplay(mine, [], PERSON, { redactor: r })).toBe("tg send '[@user-1]' 'call [phone-1]'")
  })
})

describe('peerSpec and shellQuote', () => {
  test('peers', () => {
    expect(peerSpec(BOT)).toBe('@example_bot')
    expect(peerSpec({ id: -1000000000777, kind: 'supergroup', title: 'Dev', username: null })).toBe('-1000000000777')
    expect(peerSpec({ id: 1, kind: 'self', title: 'Saved', username: null })).toBe('me')
  })

  test('quoting', () => {
    expect(shellQuote('/settings')).toBe('/settings')
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote('$(x) `y`')).toBe("'$(x) `y`'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('two\nlines')).toBe("'two\nlines'")
  })
})
