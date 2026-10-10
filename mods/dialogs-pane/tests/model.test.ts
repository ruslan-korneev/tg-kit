import { describe, expect, test } from 'claude-code/testing'

import { failureOf, settle, tg } from '../hooks/tg/tg'
import {
  MAX_HINTS,
  NO_SELECTION,
  emptyLensText,
  grownDialog,
  hintsFor,
  nextMode,
  peerArg,
  rangeSelect,
  statusText,
  toggleSelected,
  visibleDialogs,
} from '../hooks/ui/model'
import { DIALOGS, MESSAGES } from './fixtures'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

describe('tg adapter', () => {
  test('builds --json argv for each call', () => {
    expect(tg.dialogs().argv).toEqual(['tg', 'dialogs', '--limit', '50', '--json'])
    expect(tg.read('@example_bot', { limit: 5 }).argv).toEqual([
      'tg', 'read', '@example_bot', '--limit', '5', '--reverse', '--json',
    ])
    expect(tg.msg('@example_bot', [1, 2]).argv).toEqual(['tg', 'msg', '@example_bot', '1', '2', '--json'])
  })

  test('decodes dialogs and messages', () => {
    const dialogs = settle(tg.dialogs(), ok(JSON.stringify(DIALOGS)))
    expect(dialogs).toEqual({ ok: true, value: DIALOGS })
    const messages = settle(tg.read('@example_bot'), ok(JSON.stringify(MESSAGES)))
    expect(messages.ok && messages.value[1]?.buttons[0]?.[0]?.text).toBe('Retry')
  })

  test('maps exit codes to failures', () => {
    expect(failureOf(3, 'error: not logged in\n  fix: tg login')).toEqual({ kind: 'auth' })
    expect(failureOf(5, 'error: FLOOD_WAIT 23s: Telegram asks to wait before retrying')).toEqual({
      kind: 'flood',
      seconds: 23,
    })
    expect(failureOf(4, 'error: no such peer\n  fix: tg dialogs')).toEqual({ kind: 'not-found', message: 'no such peer' })
    expect(failureOf(1, '')).toEqual({ kind: 'error', message: 'tg failed' })
  })

  test('tg msg exit 4 keeps the messages it found and flags the rest', () => {
    const ran = { exitCode: 4, stdout: JSON.stringify(MESSAGES.slice(0, 1)), stderr: 'error: no message 9 in @example_bot' }
    expect(settle(tg.msg('@example_bot', [677790, 9]), ran)).toEqual({
      ok: true,
      value: MESSAGES.slice(0, 1),
      partial: 'no message 9 in @example_bot',
    })
    expect(settle(tg.read('@example_bot'), ran)).toEqual({
      ok: false,
      failure: { kind: 'not-found', message: 'no message 9 in @example_bot' },
    })
  })

  test('a run that never finished is `missing`; bad output is an error', () => {
    expect(settle(tg.dialogs(), undefined)).toEqual({ ok: false, failure: { kind: 'missing' } })
    expect(settle(tg.dialogs(), ok('not json')).ok).toBe(false)
    expect(settle(tg.dialogs(), ok('{"id": 1}')).ok).toBe(false)
  })
})

describe('lenses', () => {
  test('All, Bots, Unread and search', () => {
    expect(visibleDialogs(DIALOGS, { lens: 'all', query: '' })).toHaveLength(3)
    expect(visibleDialogs(DIALOGS, { lens: 'bots', query: '' }).map(d => d.id)).toEqual([1001])
    expect(visibleDialogs(DIALOGS, { lens: 'unread', query: '' }).map(d => d.id)).toEqual([1001, 1002])
    expect(visibleDialogs(DIALOGS, { lens: 'all', query: 'EXAMPLE' }).map(d => d.id)).toEqual([1001])
  })

  test('the empty line says what the lens filters and how to change it', () => {
    expect(emptyLensText('bots', '')).toContain('Press 1 for All')
    expect(emptyLensText('all', 'zzz')).toContain('matching "zzz"')
  })

  test('peer arguments: me, @username, else the id', () => {
    expect(DIALOGS.map(peerArg)).toEqual(['@example_bot', '1002', 'me'])
  })
})

describe('selection', () => {
  const order = [10, 11, 12, 13]

  test('Space toggles one message', () => {
    const one = toggleSelected(NO_SELECTION, 11)
    expect(one.ids).toEqual([11])
    expect(toggleSelected(one, 11).ids).toEqual([])
  })

  test('v marks a start, then selects through the cursor', () => {
    const started = rangeSelect(NO_SELECTION, order, 13)
    expect(started).toEqual({ ids: [13], anchor: 13 })
    expect(rangeSelect(started, order, 11)).toEqual({ ids: [13, 11, 12], anchor: null })
  })
})

describe('modes, hints, status', () => {
  test('Tab cycles wide → compact → hidden → wide', () => {
    expect([nextMode('wide'), nextMode('compact'), nextMode('hidden')]).toEqual(['compact', 'hidden', 'wide'])
  })

  test('never more than five hints', () => {
    for (const view of ['dialogs', 'thread'] as const) {
      expect(hintsFor(view, NO_SELECTION).length).toBeLessThanOrEqual(MAX_HINTS)
    }
    expect(hintsFor('thread', { ids: [1], anchor: null }).find(h => h.key === 'back')?.label).toBe('clear')
  })

  test('status line: unread total, news, not logged in', () => {
    const load = { status: 'ok', value: DIALOGS } as const
    expect(statusText(load, null)).toBe('tg ● 7 unread')
    expect(statusText(load, { dialogId: 1001, label: '@example_bot', kind: 'bot', text: 'hi' })).toBe(
      'tg ● 7 unread · ◆ @example_bot wrote',
    )
    expect(statusText({ status: 'error', failure: { kind: 'auth' } }, null)).toContain('! tg login')
  })

  test('the band reports the dialog whose unread count grew', () => {
    const after = DIALOGS.map(d => (d.id === 1002 ? { ...d, unread: d.unread + 1 } : d))
    expect(grownDialog(DIALOGS, after)?.id).toBe(1002)
    expect(grownDialog(DIALOGS, DIALOGS)).toBeUndefined()
  })
})
