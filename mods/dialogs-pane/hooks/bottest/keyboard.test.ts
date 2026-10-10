import { describe, expect, test } from 'claude-code/testing'

import { callbackData, chipAction, chipLabel, readOnlyReason, readOnlyText } from './keyboard'

const BOT = { id: 900000001, arg: '@example_bot' }

describe('readOnlyReason', () => {
  test('an allowlisted bot is writable; one that is not explains tg allow add', () => {
    expect(readOnlyReason(BOT, [900000001])).toBeNull()
    const reason = readOnlyReason(BOT, [42])
    expect(reason).toEqual({ kind: 'not-allowed', arg: '@example_bot' })
    expect(reason === null ? '' : readOnlyText(reason)).toContain('`! tg allow add @example_bot --yes`')
  })

  test('BotFather stays read-only even when allowlisted', () => {
    const reason = readOnlyReason({ id: 7, arg: '@BotFather' }, [7])
    expect(reason).toEqual({ kind: 'botfather' })
    expect(reason === null ? '' : readOnlyText(reason)).not.toContain('tg allow add')
  })

  test('an unread allowlist writes nothing', () => {
    expect(readOnlyReason(BOT, null, 'tg is not on PATH')).toEqual({ kind: 'allow-unknown', reason: 'tg is not on PATH' })
  })
})

describe('chipAction', () => {
  test('callback, game and reply-keyboard buttons are pressed', () => {
    for (const type of ['cb', 'game', 'reply']) expect(chipAction({ row: 0, col: 0, type, text: 'Go' })).toEqual({ kind: 'press' })
  })

  test('a URL button shows its URL and is not opened', () => {
    const url = { row: 1, col: 0, type: 'url', text: 'Docs', url: 'https://example.com/docs' }
    expect(chipAction(url)).toEqual({ kind: 'show', text: 'url "Docs" → https://example.com/docs (not opened)' })
    expect(chipLabel(url, 80)).toBe('Docs → https://example.com/docs')
    expect(chipLabel(url, 10)).toBe('Docs → ht…')
  })

  test('types tg refuses, and 2FA buttons, are refused before any call', () => {
    expect(chipAction({ row: 0, col: 0, type: 'phone', text: 'Share phone' }).kind).toBe('refuse')
    expect(chipAction({ row: 0, col: 0, type: 'cb', text: 'Pay', requires_password: true }).kind).toBe('refuse')
  })
})

test('callback data reads as text when printable, else as hex', () => {
  expect(callbackData({ data_b64: 'cmV0cnk=' })).toBe('retry')
  expect(callbackData({ data_b64: '/wA=' })).toBe('hex:ff00')
  expect(callbackData({})).toBe('')
})
