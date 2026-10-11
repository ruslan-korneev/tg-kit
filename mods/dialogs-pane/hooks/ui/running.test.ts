import { describe, expect, test } from 'claude-code/testing'

import type { ApDialog, ApEntry, LedgerEntry, PeerRef } from '../../types'
import { defaultDialog } from '../autopilot/config'
import {
  CELL_ROLE,
  KIND_ROLE,
  activityOrder,
  activityTarget,
  activityText,
  autopilotRows,
  autopilotTitle,
  cardCells,
  cellOf,
  cells,
  fitStrip,
  gauge,
  gaugeBar,
  gaugeLine,
  gaugePair,
  gaugeSegs,
  isRunning,
  laneLine,
  lanes,
  logLine,
  mergedLog,
  minSec,
  runRows,
  stopAnswer,
  stopNotice,
  stoppedOf,
  stripItems,
  stripLine,
  type CellKind,
  type Gauge,
  type Lane,
  type LaneInput,
  type LogRow,
  type RunInput,
  type Seg,
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
    expect(stopAnswer({ stopped: stoppedOf(runRows(FLOW_6)), failed: [] })).toBe(
      'tg: stopped Dev Team (auto), Contact B (delegate and its Worker), @example_bot (follow).\nSettings are kept; /tg, then a (p for a follow), restarts one.',
    )
  })

  test('the dock’s notice lists the names that fit, then +N; the toast says the rest', () => {
    const names = stoppedOf(runRows(FLOW_6)).map(one => one.label)
    expect(stopNotice(names, 0, 64)).toBe('■ stopped: Dev Team, Contact B, @example_bot')
    expect(stopNotice(names, 0, 36)).toBe('■ stopped: Dev Team, Contact B +1')
    expect(stopNotice(names, 1, 40)).toBe('■ stopped: Dev Team +2 · ⚠ 1 failed')
    expect(stopNotice(names, 0, 10)).toBe('■ stopped: Dev Team +2')
  })

  test('nothing, a follow alone, two Workers, a follow beside a level', () => {
    expect(stopAnswer({ stopped: [], failed: [] })).toBe('tg: nothing was running.')
    expect(stopAnswer({ stopped: stoppedOf(runRows({ agents: [], follows: FLOW_6.follows, tasks: [] })), failed: [] })).toBe('tg: stopped @example_bot (follow).\n/tg, then p in the chat, follows it again.')
    const two = runRows({
      agents: [{ peer: B, level: 'delegate', tail: 'delegate', phase: 'listening' }],
      follows: [{ peer: B, to: 'main', state: 'live' }],
      tasks: [
        { peer: B, isLive: true, isHeld: false, tail: 'a' },
        { peer: B, isLive: true, isHeld: false, tail: 'b' },
      ],
    })
    expect(stopAnswer({ stopped: stoppedOf(two), failed: [] }).split('\n')[0]).toBe('tg: stopped Contact B (delegate and its 2 Workers, follow).')
  })
})

describe('a part that failed is named, after what did stop', () => {
  test('the answer keeps the stopped names and says what failed', () => {
    expect(stopAnswer({ stopped: stoppedOf(runRows({ agents: [], follows: FLOW_6.follows, tasks: [] })), failed: ['@example_bot (follow): watch would not end'] })).toBe(
      'tg: stopped @example_bot (follow).\n⚠ not stopped cleanly: @example_bot (follow): watch would not end.\n/tg, then p in the chat, follows it again.',
    )
  })
})

describe('the running strip (dock)', () => {
  test('one item a running chat: a follow says where it goes, a held task ⏸', () => {
    const rows = runRows({ ...FLOW_6, tasks: [{ ...FLOW_6.tasks[0], peer: B, isHeld: true } as RunInput['tasks'][number]] })
    expect(stripItems(rows).map(item => item.text)).toEqual(['⟳ Dev Team', '↯ Contact B ⏸', '⌁ @example_bot → main'])
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
    expect(activityText(contact ?? null, 'Contact B')).toBe('↯  Contact B      delegate · listening · task 42 min · … edit src/pay/webhook.py')
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
    )
    expect(log.map(row => row.key)).toEqual(['ledger:2', 'ap:entry:1', 'ap:entry:1000001', 'ledger:1'])
    expect(log.map(row => row.tone)).toEqual(['ok', 'ok', 'mention', 'ok'])
    // The time and the chat are columns of their own (§10.6): the text carries neither, nor a level glyph.
    expect(log[1]?.peer).toEqual({ label: 'Dev Team', kind: 'supergroup' })
    expect(log[1]?.text).toBe('sent "Merged, thanks" · 0.93')
    expect(log[0]?.text).toBe('▣ #677791 → main · Fix · ✓ done')
    expect(log[2]?.text).toBe('asked publish: git push → no (you)')
  })
})

// --- the AUTOPILOT card and the log (§10.6, T14) ---

const NOW = new Date(2026, 9, 11, 14, 2, 0).getTime()
const MIN = 60_000
const DEV = peer(3001, 'Dev chat', 'supergroup')
const IVAN = peer(3002, 'Ivan Petrov')

const dialog = (p: PeerRef, perHour: number | null, level: ApDialog['level'] = 'auto'): ApDialog => ({ ...defaultDialog(p), level, perHour })

let seq = 0
const entry = (p: PeerRef, at: number, outcome: ApEntry['outcome'], reply = 'ok', confidence: number | null = 0.9): ApEntry => ({
  seq: ++seq,
  at,
  peer: p,
  level: 'auto',
  incoming: [{ id: seq, text: 'hi' }],
  reply,
  confidence,
  topics: [],
  checks: [],
  outcome,
  undo: null,
})
const sent = (p: PeerRef, at: number, by: 'auto' | 'you' = 'auto') => entry(p, at, { kind: 'sent', ids: [1], by })
const text = (segs: readonly Seg[]) => segs.map(seg => seg.text).join('')

describe('the gauge: the chat nearest its limit (§10.6)', () => {
  test('picks the tightest chat by sends over perHour, and names it', () => {
    const ledger = [sent(DEV, NOW - 50 * MIN), sent(DEV, NOW - 10 * MIN), sent(IVAN, NOW - 5 * MIN)]
    // Dev chat 2/10 = 0.2 beats Ivan 1/50 = 0.02, though Ivan sent more recently.
    expect(gauge([dialog(IVAN, 50), dialog(DEV, 10)], ledger, NOW)).toMatchObject({ peer: DEV, sent: 2, perHour: 10 })
  })

  test('only the gate’s count: auto sends in the last hour; a send by you or an older one does not count', () => {
    const ledger = [sent(DEV, NOW - 61 * MIN), sent(DEV, NOW - 5 * MIN, 'you'), entry(DEV, NOW - MIN, { kind: 'drafted', reasons: [] })]
    expect(gauge([dialog(DEV, 50)], ledger, NOW)).toEqual({ peer: DEV, sent: 0, perHour: 50, freeInMs: null })
  })

  test('none with perHour null (∞/h): no gauge; a limited chat beside one still gets it', () => {
    expect(gauge([dialog(DEV, null)], [sent(DEV, NOW - MIN)], NOW)).toBeNull()
    expect(gauge([dialog(DEV, null), dialog(IVAN, 50)], [sent(DEV, NOW - MIN)], NOW)?.peer).toEqual(IVAN)
  })

  test('↻ is the oldest counted send plus 60 min, minus now', () => {
    const ledger = [sent(DEV, NOW - 19 * MIN - 1_000), sent(DEV, NOW - 3 * MIN)]
    const g = gauge([dialog(DEV, 50)], ledger, NOW)
    expect(g?.freeInMs).toBe(NOW - 19 * MIN - 1_000 + 60 * MIN - NOW)
    expect(minSec(41 * MIN)).toBe('41:00')
    expect(minSec(41_000)).toBe('0:41')
  })

  test('five cells: ok, held from 80 %, unread at the limit; any send fills one', () => {
    const g = (n: number): Gauge => ({ peer: DEV, sent: n, perHour: 50, freeInMs: null })
    expect(gaugeBar(g(0))).toEqual({ filled: 0, role: 'ok' })
    expect(gaugeBar(g(1))).toEqual({ filled: 1, role: 'ok' })
    expect(gaugeBar(g(12))).toEqual({ filled: 2, role: 'ok' })
    expect(gaugeBar(g(40))).toEqual({ filled: 4, role: 'held' })
    expect(gaugeBar(g(50))).toEqual({ filled: 5, role: 'unread' })
    expect(text(gaugeSegs(g(12)))).toBe('▰▰▱▱▱ 12/50')
    expect(gaugePair(g(12))).toBe('12/50')
  })

  test('the row at 56 and 40 inner cells (60- and 44-column panes)', () => {
    const g: Gauge = { peer: DEV, sent: 12, perHour: 50, freeInMs: 41_000 }
    expect(text(gaugeLine(g, 56))).toBe('▰▰▱▱▱ 12/50 per hour · Dev chat  ↻ 0:41')
    expect(text(gaugeLine(g, 40))).toBe('▰▰▱▱▱ 12/50 · Dev chat ↻ 0:41')
  })
})

describe('the cell strip (§10.6)', () => {
  const OUTCOMES: [ApEntry['outcome'], CellKind | null][] = [
    [{ kind: 'sent', ids: [1], by: 'auto' }, 'sent'],
    [{ kind: 'drafted', reasons: [] }, 'held'],
    [{ kind: 'stop', stops: ['money'], what: 'pay', answer: 'yes', why: 'you' }, 'asked'],
    [{ kind: 'failed', reason: 'x' }, 'refused'],
    [{ kind: 'skipped', reason: 'x' }, 'refused'],
    [{ kind: 'working' }, null],
    [{ kind: 'listened' }, null],
    [{ kind: 'dropped' }, null],
    [{ kind: 'allowed', line: 'x' }, null],
  ]

  test('each ApOutcome kind maps to its cell, or to none', () => {
    for (const [outcome, cell] of OUTCOMES) expect(cellOf(outcome)).toBe(cell)
    expect(CELL_ROLE).toEqual({ sent: 'ok', held: 'held', asked: 'mention', refused: 'unread' })
  })

  test('cut to the room, it keeps the newest (newest at the right); the counts cover every event', () => {
    const ledger = [
      sent(DEV, NOW - 5 * MIN),
      entry(DEV, NOW - 4 * MIN, { kind: 'drafted', reasons: [] }),
      entry(DEV, NOW - 3 * MIN, { kind: 'listened' }),
      entry(DEV, NOW - 2 * MIN, { kind: 'failed', reason: 'x' }),
      sent(DEV, NOW - MIN),
    ]
    expect(cells(ledger, 2)).toEqual({ cells: ['refused', 'sent'], counts: { sent: 2, held: 1, asked: 0, refused: 1 } })
    expect(cells([...ledger].reverse(), 10).cells).toEqual(['sent', 'held', 'refused', 'sent'])
  })

  test('the row: words in their roles at 56, numbers only at 40, zeros left out', () => {
    const ledger = [sent(DEV, NOW - 3 * MIN), entry(DEV, NOW - 2 * MIN, { kind: 'drafted', reasons: [] }), sent(DEV, NOW - MIN)]
    const wide = stripLine(ledger, 56)
    expect(text(wide)).toBe('■■■  sent 2 · held 1')
    expect(wide.map(seg => seg.role)).toEqual(['ok', 'held', 'ok', null, 'ok', 'dim', 'held'])
    expect(text(stripLine(ledger, 40))).toBe('■■■  2 · 1')
    expect(text(stripLine([], 56))).toBe('no replies yet')
  })
})

describe('the lanes (§10.6)', () => {
  const lane = (over: Partial<LaneInput>): LaneInput => ({ peer: DEV, level: 'auto', phase: 'gathering', gapS: 20, burstAt: null, latest: null, hasDraft: false, taskAt: null, ...over })

  test('at 0, 10 and 20 s of a 20 s gap: empty, half, full', () => {
    const [at0, at10, at20] = lanes([lane({ burstAt: NOW }), lane({ burstAt: NOW - 10_000 }), lane({ burstAt: NOW - 20_000 })], NOW)
    expect([at0?.gap, at10?.gap, at20?.gap]).toEqual([0, 0.5, 1])
    // No burst waiting: no gap to fill, an idle lane all `·`.
    expect(lanes([lane({})], NOW)[0]?.gap).toBeNull()
    expect(text(laneLine(at0 as Lane, 56))).toBe(`⟳ Dev chat     ${'·'.repeat(20)}  listening`)
    expect(text(laneLine(at10 as Lane, 56))).toBe(`⟳ Dev chat     ${'━'.repeat(10)}${'·'.repeat(10)}  listening`)
    expect(text(laneLine(at20 as Lane, 56))).toBe(`⟳ Dev chat     ${'━'.repeat(20)}  listening`)
  })

  test('the state, first that holds: drafting, draft waits, a task, a send under five minutes, listening', () => {
    const working = entry(DEV, NOW - 12_000, { kind: 'working' })
    const done = sent(DEV, NOW - MIN)
    const states = lanes(
      [
        lane({ phase: 'thinking', latest: working, hasDraft: true }),
        lane({ hasDraft: true, latest: done }),
        lane({ level: 'delegate', taskAt: NOW - 42 * MIN, latest: done }),
        lane({ latest: { ...done, confidence: 0.93 } }),
        lane({ latest: sent(DEV, NOW - 6 * MIN) }),
        lane({ latest: done, burstAt: NOW - 1_000 }),
      ],
      NOW,
    ).map(one => one.state)
    expect(states).toEqual([
      { kind: 'drafting', ms: 12_000 },
      { kind: 'waits' },
      { kind: 'task', minutes: 42 },
      { kind: 'sent', confidence: 0.93 },
      { kind: 'listening' },
      { kind: 'listening' },
    ])
  })

  test('the row at 56 and 40: the mockup’s columns; narrow, drafting keeps its clock only', () => {
    const [dev, ivan] = lanes(
      [lane({ phase: 'thinking', burstAt: NOW - 10_000, latest: entry(DEV, NOW - 12_000, { kind: 'working' }) }), lane({ peer: IVAN, level: 'draft', phase: 'listening' })],
      NOW,
    )
    expect(text(laneLine(dev as Lane, 56))).toBe(`⟳ Dev chat     ${'━'.repeat(10)}${'·'.repeat(10)}  drafting 0:12`)
    expect(text(laneLine(ivan as Lane, 56))).toBe(`✎ Ivan Petrov  ${'·'.repeat(20)}  listening`)
    expect(text(laneLine(dev as Lane, 40))).toBe(`⟳ Dev chat    ${'━'.repeat(6)}${'·'.repeat(6)} 0:12`)
    expect(text(laneLine(ivan as Lane, 40))).toBe(`✎ Ivan Petrov ${'·'.repeat(12)} listening`)
  })

  test('at most three lanes on the card, the rest counted in the title', () => {
    expect([0, 1, 3, 5].map(n => autopilotRows(n))).toEqual([0, 3, 5, 5])
    expect(autopilotRows(5, Number.POSITIVE_INFINITY)).toBe(7)
    expect(autopilotTitle(2, 2, 56)).toBe('AUTOPILOT · 2 chats')
    expect(autopilotTitle(5, 3, 56)).toBe('AUTOPILOT · 5 chats · +2')
    expect(autopilotTitle(2, 2, 40)).toBe('AUTOPILOT · 2')
    expect(autopilotTitle(5, 3, 40)).toBe('AUTOPILOT · 5 · +2')
  })
})

describe('the log’s columns (§10.6)', () => {
  const row: LogRow = { key: 'k', at: NOW, peer: { label: 'Dev chat', kind: 'supergroup' }, text: 'sent "Merged, thanks" · 0.93', tone: 'ok' }

  test('at 56 inner cells (a 60-column pane): time, a 13-cell name in its kind role, the text in its tone', () => {
    const segs = logLine(row, 56)
    expect(text(segs)).toBe('14:02  Dev chat      sent "Merged, thanks" · 0.93')
    expect(segs.map(seg => seg.role)).toEqual(['dim', 'group', 'ok'])
    expect(logLine({ ...row, peer: { label: 'Ivan Petrov', kind: 'user' } }, 56)[1]).toEqual({ text: 'Ivan Petrov   ', role: 'person' })
  })

  test('at 40 (a 44-column pane): a 12-cell name, the text cut to the row', () => {
    const segs = logLine(row, 40)
    expect(text(segs)).toBe('14:02  Dev chat     sent "Merged, thank…')
    expect(cardCells(text(segs))).toBe(40)
    expect(text(logLine({ ...row, peer: { label: 'Project team members', kind: 'group' } }, 40))).toMatch(/^14:02 {2}Project tea… sent/)
  })

  test('kinds take their roles', () => {
    expect(KIND_ROLE).toMatchObject({ user: 'person', bot: 'bot', group: 'group', supergroup: 'group', channel: 'channel', self: 'saved' })
  })
})
