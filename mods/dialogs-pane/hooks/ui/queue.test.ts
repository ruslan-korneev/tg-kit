import { describe, expect, test } from 'claude-code/testing'

import type { ApNote, ApUndoWindow, BandEvent, LedgerEntry, PeerRef } from '../../types'
import { buildPacket } from '../packet/build'
import { BOT, PERSON, REPLY, SENT } from '../packet/fixtures'
import { apDraftView, type DraftView } from './drafts'
import { KEYS, helpLines } from './keys'
import {
  NOTHING_ON_SCREEN,
  bandQueue,
  draftFits,
  footerLabel,
  hintTail,
  packetRow,
  positionText,
  shownIndex,
  statusAlarm,
  stepKey,
  unreadChats,
  type QueueInput,
} from './queue'

const peer = (id: number, label: string, kind: PeerRef['kind'] = 'user'): PeerRef => ({ id, arg: String(id), label, kind })
const A = peer(1004, 'Contact A')
const B = peer(2002, 'Contact B')
const GROUP = peer(1002, 'Dev Team', 'supergroup')
const BOT_PEER = peer(1001, '@example_bot', 'bot')

const NONE = { levels: '', watched: '', forYou: '' }

describe('the footer label (§4.5)', () => {
  test('per state: loading, nothing, counts, every part; zero counts left out', () => {
    expect(footerLabel({ kind: 'loading' }, NONE)).toBe('tg …')
    expect(footerLabel({ kind: 'count', unread: 0 }, NONE)).toBe('tg')
    expect(footerLabel({ kind: 'count', unread: 22 }, NONE)).toBe('tg 22')
    expect(footerLabel({ kind: 'count', unread: 22 }, { levels: '⌁1 ⟳1 ↯1', watched: '◎ 3 new', forYou: '2 for you' })).toBe('tg 22 · ⌁1 ⟳1 ↯1 · ◎ 3 new · 2 for you')
    expect(footerLabel({ kind: 'count', unread: 0 }, { ...NONE, forYou: '1 for you' })).toBe('tg · 1 for you')
    expect(footerLabel({ kind: 'failed', isLoggedOut: true }, NONE)).toBe('tg ⚠ not logged in')
    expect(footerLabel({ kind: 'failed', isLoggedOut: false }, { ...NONE, levels: '⟳1' })).toBe('tg ⚠ · ⟳1')
  })

  test('tg N counts unread chats that are not muted, not their messages', () => {
    expect(unreadChats([{ unread: 14, muted: false }, { unread: 3, muted: true }, { unread: 0, muted: false }, { unread: 1, muted: false }])).toBe(2)
  })
})

describe('the status line holds alarms only (§4.1)', () => {
  test('nothing to alarm clears it', () => {
    expect(statusAlarm({ hold: null, noStops: null, isLoggedOut: false })).toBeUndefined()
  })

  test('a hard stop waiting, skipped stops, not logged in; together in that order', () => {
    expect(statusAlarm({ hold: 'tg ⏸ HARD STOP publish: git push · ↯ Contact B · answer in the dialog', noStops: null, isLoggedOut: false })).toBe(
      'tg ⏸ HARD STOP publish: git push · ↯ Contact B · answer in the dialog',
    )
    expect(statusAlarm({ hold: null, noStops: '⚠ no stops: publish', isLoggedOut: false })).toBe('tg ⚠ no stops: publish')
    expect(statusAlarm({ hold: null, noStops: null, isLoggedOut: true })).toBe('tg ⚠ not logged in: ! tg login')
    expect(statusAlarm({ hold: 'tg ⏸ HARD STOP x', noStops: '⚠ no stops', isLoggedOut: true })).toBe('tg ⏸ HARD STOP x · tg ⚠ no stops · tg ⚠ not logged in: ! tg login')
  })
})

const draft = (seq: number, who: PeerRef, text = 'After 18?'): DraftView =>
  apDraftView({ seq, peer: who, incoming: 'Can we call?', text, confidence: 0.62, reasons: ['dates'], state: { kind: 'ready' }, check: { kind: 'planned', isAllowed: true, reason: 'confirmed with --yes' }, at: seq, after: 92 })
const undo: ApUndoWindow = { seq: 7, peer: GROUP, ids: [900], text: 'Merged, thanks', confidence: 0.93, until: 30_000 }
const reply: BandEvent = { dialogId: 1001, label: '@example_bot', kind: 'bot', text: '⚠ Something went wrong', sender: 'bot' }
const note: ApNote = { seq: 3, peer: GROUP, text: 'Release moved to Friday.' }

const FULL: QueueInput = {
  holds: [{ key: 'hold:g:1:1', peer: B, stops: ['publish'], what: 'git push' }],
  drafts: [draft(4, A), draft(5, GROUP)],
  undo,
  reply,
  watched: [1001],
  notes: [note],
  tasks: [
    { id: 1, peer: B, status: 'done', reason: 'PR opened' },
    { id: 2, peer: GROUP, status: 'stopped', reason: 'stopped by you' },
    { id: 3, peer: A, status: 'working', reason: '' },
  ],
  dismissed: [],
  onScreen: NOTHING_ON_SCREEN,
}

describe('the band: one queue, most urgent first (§8 T5)', () => {
  test('hold > draft > undo > watched reply > summary > task news', () => {
    expect(bandQueue(FULL).map(item => item.key)).toEqual(['hold:g:1:1', 'draft:ap:4', 'draft:ap:5', 'undo:7', 'reply:1001', 'note:3', 'task:1:done'])
  })

  test('only a watched chat reaches it, and only a task that ended done or failed', () => {
    const keys = bandQueue({ ...FULL, watched: [] }).map(item => item.key)
    expect(keys).not.toContain('reply:1001')
    expect(keys.filter(key => key.startsWith('task:'))).toEqual(['task:1:done'])
  })

  test('what the pane draws is skipped: a draft whose row it draws, For you\'s undo window, a thread its reply and its task news; a hold never', () => {
    expect(bandQueue({ ...FULL, onScreen: { chat: null, isForYou: true, drafts: ['draft:ap:4', 'draft:ap:5'] } }).map(item => item.key)).toEqual(['hold:g:1:1', 'reply:1001', 'note:3', 'task:1:done'])
    expect(bandQueue({ ...FULL, onScreen: { chat: 1001, isForYou: false, drafts: [] } }).map(item => item.key)).not.toContain('reply:1001')
    expect(bandQueue({ ...FULL, onScreen: { chat: B.id, isForYou: false, drafts: [] } }).map(item => item.key)).toEqual(['hold:g:1:1', 'draft:ap:4', 'draft:ap:5', 'undo:7', 'reply:1001', 'note:3'])
    // A thread drawn with one draft's row in its window: that one is the pane's, the other the band's.
    expect(bandQueue({ ...FULL, onScreen: { chat: A.id, isForYou: false, drafts: ['draft:ap:4'] } }).map(item => item.key)).toEqual(['hold:g:1:1', 'draft:ap:5', 'undo:7', 'reply:1001', 'note:3', 'task:1:done'])
  })

  test('d puts news away by key', () => {
    expect(bandQueue({ ...FULL, dismissed: ['task:1:done'] }).map(item => item.key)).not.toContain('task:1:done')
  })

  test('j and k step round the queue; a key no longer queued shows the first', () => {
    const items = bandQueue(FULL)
    expect(stepKey(items, null, 1)).toBe('draft:ap:4')
    expect(stepKey(items, 'task:1:done', 1)).toBe('hold:g:1:1')
    expect(stepKey(items, 'hold:g:1:1', -1)).toBe('task:1:done')
    expect(shownIndex(items, 'undo:7')).toBe(3)
    expect(shownIndex(items, 'draft:ap:99')).toBe(0)
    expect(stepKey([], null, 1)).toBeNull()
    expect(positionText(1, 3)).toBe('2/3  j: next')
    expect(positionText(0, 1)).toBeNull()
  })

  test('the hint tail shows exactly while the band holds items (§4.4)', () => {
    expect(hintTail(0, 0)).toBeUndefined()
    expect(hintTail(3, 2)).toBe('tg: 2 for you · ctrl+x tab')
    expect(hintTail(1, 0)).toBe('tg: 1 waiting · ctrl+x tab')
  })
})

describe("a draft's row (decision 9: ⏎ sends only what was read)", () => {
  test('at 64 columns: whole on its own row, or not', () => {
    // `  → ` and 60 cells fill 64 columns exactly.
    expect(draftFits('x'.repeat(60), 64)).toBe(true)
    expect(draftFits('x'.repeat(61), 64)).toBe(false)
    expect(draftFits('Tomorrow is packed with reviews, can I write after 18:00?', 64)).toBe(true)
  })

  test('newlines drawn as ⏎ and wide characters count as drawn, erring wide', () => {
    expect(draftFits('After 18?\nOr Friday.', 64)).toBe(true)
    expect(draftFits('明天很忙'.repeat(8), 64)).toBe(false)
    expect(draftFits('Завтра занят', 64)).toBe(true)
    expect(draftFits(`${'x'.repeat(58)} ✅`, 64)).toBe(false)
    expect(draftFits(`${'x'.repeat(57)} ✅`, 64)).toBe(true)
  })
})

describe('the transcript: one row per packet (§5.1)', () => {
  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    seq: 1,
    at: 0,
    peer: BOT_PEER,
    messageIds: [REPLY.id],
    to: { kind: 'main' },
    intent: 'fix',
    state: { kind: 'sent' },
    parents: 1,
    missing: [],
    masked: 3,
    ...over,
  })

  test('the ledger names the chat, the parents and the masks', () => {
    const packet = buildPacket({ messages: [REPLY], context: [SENT], peer: BOT, intent: { id: 'fix' } })
    expect(packetRow(packet.text, [entry()])).toBe('▣ tg packet → main · Fix · @example_bot #677791 (+1 parent, 3 masked)   ctrl+o shows it')
    // The row as the engine hands it: under its framing of a plugin's prompt.
    expect(packetRow(`The dialogs-pane plugin sent a message:\n${packet.text}`, [entry()])).toBe(packetRow(packet.text, [entry()]))
    expect(packetRow(`The other plugin sent a message:\n${packet.text}`, [entry()])).toBeNull()
  })

  test('without the ledger (a resumed session), the packet itself: a person masked stays masked', () => {
    const person = { id: PERSON.id, kind: 'user', username: null, name: 'Contact A' } as const
    const packet = buildPacket({ messages: [{ ...REPLY, sender: person }], peer: { ...PERSON, username: null }, intent: { id: 'explain', audience: 'people' } })
    expect(packetRow(packet.text, [])).toMatch(/^▣ tg packet → main · Explain · \[name-1\] #677791 \(\d masked\)   ctrl\+o shows it$/)
    const several = buildPacket({ messages: [SENT, REPLY], peer: BOT, intent: { id: 'raw', text: 'why?' }, redact: false })
    expect(packetRow(several.text, [])).toBe('▣ tg packet → main · Ask · @example_bot 2 messages   ctrl+o shows it')
  })

  test('nothing else is a packet row: another source, plain text, a broken head', () => {
    expect(packetRow('fix this please', [])).toBeNull()
    expect(packetRow('<tg-packet v="1" intent="fix" source="elsewhere">', [])).toBeNull()
    expect(packetRow('<tg-packet v="1" intent="bogus" source="dialogs-pane">', [])).toBeNull()
  })
})

describe('/tg help is the key table (§4.4)', () => {
  test('every key the table has, with what it does', () => {
    const text = helpLines().join('\n')
    for (const def of KEYS) {
      if (def.key === '') continue
      expect(text).toContain(` ${def.key} `)
    }
    expect(helpLines()[0]).toBe('tg keys · one meaning per letter, in every view and in the band')
    expect(text).toMatch(/r +rec +a chat · a bot chat only/)
    expect(text).toMatch(/n +write +Chats or a chat · a bot chat, a person chat, a group or Saved Messages only/)
  })
})
