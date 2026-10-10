import { describe, expect, test } from 'claude-code/testing'

import { BOT, msg, REPLY } from './fixtures'
import { botUsernames, redactMessage, Redactor } from './redact'

describe('Redactor.text', () => {
  test('phones in common shapes, one placeholder per number', () => {
    const r = new Redactor()
    expect(r.text('+1 555 010 0200')).toBe('[phone-1]')
    expect(r.text('+15550100200')).toBe('[phone-1]')
    expect(r.text('8 (000) 000-00-01')).toBe('[phone-2]')
    expect(r.text('+44 20 7946 0958')).toBe('[phone-3]')
  })

  test('usernames and t.me links; emails and reserved t.me paths stay', () => {
    const r = new Redactor({ keep: ['@example_bot'] })
    expect(r.text('ask @contact_a or t.me/contact_a')).toBe('ask [@user-1] or t.me/[@user-1]')
    expect(r.text('https://t.me/joinchat/AAAA')).toBe('https://t.me/joinchat/AAAA')
    expect(r.text('mail user@example.com')).toBe('mail user@example.com')
    expect(r.text('@example_bot and @Example_Bot')).toBe('@example_bot and @Example_Bot')
    expect(r.text('@abc is too short')).toBe('@abc is too short')
  })

  test('long digit runs are ids, including -100 chat ids; short numbers, dates and amounts stay', () => {
    const r = new Redactor()
    expect(r.text('user 900000009 in -1000000000777')).toBe('user [id-1] in [id-2]')
    expect(r.text('order 4521, 2026-10-10 14:01, total 1 000 000')).toBe('order 4521, 2026-10-10 14:01, total 1 000 000')
    expect(r.id(900000009)).toBe('[id-1]')
  })

  test('the same value always maps to the same placeholder; the mapping lists each once', () => {
    const r = new Redactor()
    r.text('@contact_a @contact_b @contact_a')
    r.username('contact_a')
    expect(r.mapping()).toEqual([
      { kind: 'username', original: '@contact_a', placeholder: '[@user-1]' },
      { kind: 'username', original: '@contact_b', placeholder: '[@user-2]' },
    ])
  })

  test('mapping() is a snapshot', () => {
    const r = new Redactor()
    r.text('@contact_a')
    const snap = r.mapping()
    r.text('@contact_b')
    expect(snap).toHaveLength(1)
  })
})

describe('redactMessage', () => {
  test('masks a person sender, their name and strings in buttons, links and contact media', () => {
    const r = new Redactor()
    const m = msg({
      id: 1,
      sender: { id: 900000002, kind: 'user', username: 'contact_a', name: 'Contact A' },
      text: 'hi',
      forward: { from_id: 900000003, from_name: 'Contact B', date: null },
      media: { type: 'contact', title: 'Contact C', name: '+1 555 010 0200' },
      links: [{ text: 'me', url: 'https://t.me/contact_a' }],
      buttons: [[{ row: 0, col: 0, type: 'url', text: 'Write @contact_a', url: 'https://t.me/contact_a' }]],
    })
    const v = redactMessage(m, r)
    expect(v.sender).toEqual({ id: 900000002, kind: 'user', username: '[@user-1]', name: '[name-1]' })
    expect(v.forward?.from_name).toBe('[name-2]')
    expect(v.media).toEqual({ type: 'contact', title: '[name-3]', name: '[phone-1]' })
    expect(v.links).toEqual([{ text: 'me', url: 'https://t.me/[@user-1]' }])
    expect(v.buttons[0]?.[0]).toMatchObject({ text: 'Write [@user-1]', url: 'https://t.me/[@user-1]' })
    // The input is not touched.
    expect(m.sender.username).toBe('contact_a')
  })

  test('a bot sender keeps its username when kept', () => {
    const r = new Redactor({ keep: botUsernames(BOT, [REPLY]) })
    expect(redactMessage(REPLY, r).sender.username).toBe('example_bot')
  })
})
