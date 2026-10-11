import { describe, expect, test } from 'claude-code/testing'

import type { ApEntry, LedgerEntry, PeerRef } from '../../types'
import {
  activityOrder,
  activityTarget,
  activityText,
  fitStrip,
  isRunning,
  mergedLog,
  runRows,
  stopAnswer,
  stopNotice,
  stoppedOf,
  stripItems,
  type RunInput,
} from './running'

const peer = (id: number, label: string, kind: PeerRef['kind'] = 'user'): PeerRef => ({ id, arg: String(id), label, kind })
const BOT = peer(1001, '@example_bot', 'bot')
const GROUP = peer(1002, 'Dev Team', 'supergroup')
const B = peer(2002, 'Contact B')

/** The spec's Flow 6: auto in Dev Team, delegate with a Worker in Contact B, a follow on @example_bot. */
const FLOW_6: RunInput = {
  agents: [
    { peer: GROUP, level: 'auto', tail: 'auto 3/50', phase: 'listening' },
    { peer: B, level: 'delegate', tail: 'delegate', phase: 'listening' },
  ],
  follows: [{ peer: BOT, to: 'main', state: 'live' }],
  tasks: [{ peer: B, isLive: true, isHeld: false, tail: 'task 42 min · … edit src/pay/webhook.py' }],
}

describe('what runs, a row per chat', () => {
  test('the autopilot’s dialogs first, then chats with only a task, then the ones only followed; one row a chat', () => {
    const rows = runRows({ ...FLOW_6, follows: [...FLOW_6.follows, { peer: GROUP, to: 'main', state: 'live' }] })
    expect(rows.map(row => row.peer.label)).toEqual(['Dev Team', 'Contact B', '@example_bot'])
    expect(rows[0]?.follow).toEqual({ to: 'main', state: 'live' })
    expect(rows[1]?.workers).toBe(1)
  })

  test('a chat’s live task wins over one that ended; an ended task alone is nothing for 0 to stop', () => {
    const rows = runRows({
      agents: [],
      follows: [],
      tasks: [
        { peer: B, isLive: true, isHeld: true, tail: 'live' },
        { peer: B, isLive: false, isHeld: false, tail: 'done' },
        { peer: GROUP, isLive: false, isHeld: false, tail: 'done' },
      ],
    })
    expect(rows.map(row => row.task?.tail)).toEqual(['live', 'done'])
    expect(rows.map(isRunning)).toEqual([true, false])
    expect(stoppedOf(rows).map(one => one.label)).toEqual(['Contact B'])
  })
})

describe('the kill switch names what it stopped (§5.6)', () => {
  test('/tg stop: every chat, with what stopped there', () => {
    expect(stopAnswer(stoppedOf(runRows(FLOW_6)))).toBe(
      'tg: stopped Dev Team (auto), Contact B (delegate and its Worker), @example_bot (follow).\nSettings are kept; /tg, then a (p for a follow), restarts one.',
    )
    expect(stopNotice(stoppedOf(runRows(FLOW_6)))).toBe(
      '■ stopped: Dev Team (auto), Contact B (delegate and its Worker), @example_bot (follow). Settings kept; a restarts one.',
    )
  })

  test('nothing, a follow alone, two Workers, a follow beside a level', () => {
    expect(stopAnswer([])).toBe('tg: nothing was running.')
    expect(stopAnswer(stoppedOf(runRows({ agents: [], follows: FLOW_6.follows, tasks: [] })))).toBe('tg: stopped @example_bot (follow).\n/tg, then p in the chat, follows it again.')
    const two = runRows({
      agents: [{ peer: B, level: 'delegate', tail: 'delegate', phase: 'listening' }],
      follows: [{ peer: B, to: 'main', state: 'live' }],
      tasks: [
        { peer: B, isLive: true, isHeld: false, tail: 'a' },
        { peer: B, isLive: true, isHeld: false, tail: 'b' },
      ],
    })
    expect(stopAnswer(stoppedOf(two)).split('\n')[0]).toBe('tg: stopped Contact B (delegate and its 2 Workers, follow).')
  })
})

describe('the running strip (dock)', () => {
  test('one item a running chat: a follow says where it goes, a held task ⏸', () => {
    const rows = runRows({ ...FLOW_6, tasks: [{ ...FLOW_6.tasks[0], peer: B, isHeld: true } as RunInput['tasks'][number]] })
    expect(stripItems(rows).map(item => item.text)).toEqual(['⟳ Dev Team', '⚡ Contact B ⏸', '⌁ @example_bot → main'])
    expect(stripItems(rows).map(item => item.isHeld)).toEqual([false, true, false])
  })

  test('at 64 columns Flow 6 fits beside 0: stop all; narrower, the last names go into +N', () => {
    const items = stripItems(runRows(FLOW_6))
    expect(fitStrip(items, 64)).toEqual({ shown: items, more: 0 })
    const narrow = fitStrip(items, 40)
    expect(narrow.more).toBeGreaterThan(0)
    expect(narrow.shown.length + narrow.more).toBe(items.length)
    // The first name always shows.
    expect(fitStrip(items, 10).shown).toHaveLength(1)
  })
})

describe('Activity (§5.7)', () => {
  test('rows keep their order while it is open: one that stops stays, one that starts goes last', () => {
    const first = activityOrder({ rows: [], cursor: 0 }, runRows(FLOW_6))
    expect(first.map(one => one.label)).toEqual(['Dev Team', 'Contact B', '@example_bot'])
    // Dev Team stops; a follow on Contact A starts. The autopilot order would put nothing above the cursor.
    const A = peer(2001, 'Contact A')
    const later = runRows({ agents: [FLOW_6.agents[1] as RunInput['agents'][number]], follows: [{ peer: A, to: 'main', state: 'starting' }, ...FLOW_6.follows], tasks: FLOW_6.tasks })
    expect(activityOrder({ rows: first, cursor: 2 }, later).map(one => one.label)).toEqual(['Dev Team', 'Contact B', '@example_bot', 'Contact A'])
  })

  test('a row: glyphs, the name in a column, what it does; a stopped one says so; ⏎ opens the card or the chat', () => {
    const [group, contact, bot] = runRows(FLOW_6)
    expect(activityText(group ?? null, 'Dev Team')).toBe('⟳  Dev Team       auto 3/50 · listening')
    expect(activityText(contact ?? null, 'Contact B')).toBe('⚡  Contact B      delegate · listening · task 42 min · … edit src/pay/webhook.py')
    expect(activityText(bot ?? null, '@example_bot')).toBe('⌁  @example_bot   follows → main · live')
    expect(activityText(null, 'Dev Team')).toBe('■  Dev Team       stopped')
    expect([group, contact, bot, null].map(row => activityTarget(row ?? null))).toEqual(['card', 'chat', 'chat', 'chat'])
  })

  test('the log merges packets, bursts and stop events by time, newest first', () => {
    const packet = (seq: number, at: number): LedgerEntry => ({
      seq,
      at,
      peer: BOT,
      messageIds: [677791],
      to: { kind: 'main' },
      intent: 'fix',
      state: { kind: 'done', at },
      parents: 0,
      missing: [],
      masked: 0,
    })
    const burst = (seq: number, at: number, outcome: ApEntry['outcome']): ApEntry => ({
      seq,
      at,
      peer: GROUP,
      level: 'auto',
      incoming: [{ id: 1, text: 'merged?' }],
      reply: 'Merged, thanks',
      confidence: 0.93,
      topics: [],
      checks: [],
      outcome,
      undo: null,
    })
    const log = mergedLog(
      [packet(1, 1_000), packet(2, 4_000)],
      [burst(1, 3_000, { kind: 'sent', ids: [9], by: 'auto' }), burst(1_000_001, 2_000, { kind: 'stop', stops: ['publish'], what: 'git push', answer: 'no', why: 'you' })],
      5_000,
      64,
    )
    expect(log.map(row => row.key)).toEqual(['ledger:2', 'ap:entry:1', 'ap:entry:1000001', 'ledger:1'])
    expect(log.map(row => row.tone)).toEqual(['ok', 'plain', 'warn', 'ok'])
    expect(log[1]?.text).toMatch(/^\d\d:\d\d ⟳ Dev Team · → "Merged, thanks" · conf 0\.93 · ✓ sent$/)
    expect(log[0]?.text).toMatch(/^\d\d:\d\d ▣ #677791 @example_bot → main · Fix/)
  })
})
