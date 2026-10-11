// Drafts as rows of their chat, pure (dialogs-pane-ux.md §4.3, §5.4, §8 T3, decision 9).
import { describe, expect, test } from 'claude-code/testing'

import type { ApDraft, PeerRef, ReplyDraft } from '../../types'
import { msg } from '../packet/fixtures'
import { apDraftView, draftHeight, draftViews, fitsRow, keptCursor, replyDraftView, threadRowKey, threadRows, windowCount, windowStart, wrapRows } from './drafts'

const PEER: PeerRef = { id: 1004, arg: '1004', label: 'Contact A', kind: 'user' }
const apDraft = (over: Partial<ApDraft> = {}): ApDraft => ({
  seq: 7,
  peer: PEER,
  incoming: 'Can we call tomorrow at 10?',
  text: 'Tomorrow is packed, can I write after 18?',
  confidence: 0.62,
  reasons: ['dates'],
  state: { kind: 'ready' },
  check: { kind: 'planned', isAllowed: true, reason: 'confirmed with --yes' },
  at: 10,
  after: 92,
  ...over,
})
const reply = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({ peer: PEER, replyTo: 91, text: 'On it.', from: 'main', step: { kind: 'draft' }, at: 20, after: 91, isEditing: false, ...over })

describe('a draft as a row', () => {
  test('autopilot’s and routing’s drafts read the same way; ⏎ sends only once the guard allowed the text', () => {
    expect(apDraftView(apDraft())).toMatchObject({ key: 'draft:ap:7', why: 'dates · conf 0.62', canSend: true, verdict: { text: '✓ the guard allows it', tone: 'ok' } })
    expect(apDraftView(apDraft({ check: { kind: 'checking' } }))).toMatchObject({ canSend: false, isBusy: true })
    expect(apDraftView(apDraft({ check: { kind: 'planned', isAllowed: false, reason: 'readonly = true' } }))).toMatchObject({ canSend: false, verdict: { text: '✗ the guard refuses: readonly = true', tone: 'danger' } })
    expect(apDraftView(apDraft({ state: { kind: 'failed', reason: 'flood' } })).verdict.text).toBe('✗ not sent: flood')
    expect(replyDraftView(reply())).toMatchObject({ key: 'draft:reply', why: 'from main', incoming: 'reply to #91', canSend: false })
    expect(replyDraftView(reply({ step: { kind: 'planned', isAllowed: true, reason: 'allowlisted' } }))?.canSend).toBe(true)
    expect(replyDraftView(reply({ step: { kind: 'sent', ids: [1] } }))).toBeNull()
    expect(draftViews([apDraft()], reply({ at: 5 })).map(one => one.key)).toEqual(['draft:reply', 'draft:ap:7'])
  })

  test('each lands after the message that was newest when it landed: never above it, and later messages go after it (§4.3)', () => {
    const messages = [msg({ id: 90 }), msg({ id: 91 }), msg({ id: 92 }), msg({ id: 93 })]
    const rows = threadRows(messages, draftViews([apDraft({ after: 92 })], reply({ after: 91, at: 30 })))
    expect(rows.map(threadRowKey)).toEqual(['msg:90', 'msg:91', 'draft:reply', 'msg:92', 'draft:ap:7', 'msg:93'])
    // Older than every loaded message: first. Newer than all: last.
    expect(threadRows(messages, draftViews([apDraft({ after: 12 })], null)).map(threadRowKey)[0]).toBe('draft:ap:7')
    expect(threadRows(messages, draftViews([apDraft({ after: 500 })], null)).map(threadRowKey).at(-1)).toBe('draft:ap:7')
  })
})

describe('rows on screen', () => {
  test('a text wraps word by word, erring tall; a draft takes its head, its text and its verdict', () => {
    expect(wrapRows('one two three', 13)).toBe(1)
    expect(wrapRows('one two three', 12)).toBe(2)
    expect(wrapRows('a\nb', 10)).toBe(2)
    expect(wrapRows('x'.repeat(25), 10)).toBe(3)
    expect(wrapRows('ab ' + 'x'.repeat(25), 10)).toBe(4)
    // Wide symbols count two cells: a draft that might not fit never counts as one that does.
    expect(wrapRows('✅'.repeat(5), 9)).toBe(2)
    expect(draftHeight(apDraftView(apDraft()), 64)).toBe(3)
    expect(draftHeight(apDraftView(apDraft({ text: 'word '.repeat(30).trim() })), 40)).toBe(2 + wrapRows('word '.repeat(30).trim(), 37))
    expect(draftHeight(apDraftView(apDraft({ state: { kind: 'editing' } })), 20)).toBe(3)
    expect(fitsRow('"After 18?"', 11)).toBe(true)
    expect(fitsRow('"After 18?"', 10)).toBe(false)
    expect(fitsRow('a\nb', 80)).toBe(false)
  })

  test('the window holds whole rows and moves only when the cursor leaves it; a row coming or going under the cursor moves nothing above it', () => {
    const heights = [1, 1, 2, 1, 1, 4]
    // The cursor on row 4 fits from 0 (1+1+2+1+1 = 6 rows); the draft under it (4 rows) does not, and is not drawn.
    expect(windowStart(0, 4, heights, 6)).toBe(0)
    expect(windowCount(0, heights, 6)).toBe(5)
    // j onto the draft: the window starts where the draft fits whole (1 + 1 + 4).
    expect(windowStart(0, 5, heights, 6)).toBe(3)
    expect(windowCount(3, heights, 6)).toBe(3)
    // A row taken away under the cursor (the draft sent) leaves the start where it was.
    expect(windowStart(3, 4, heights.slice(0, 5), 6)).toBe(3)
    // Up past the top edge: the start follows the cursor.
    expect(windowStart(3, 2, heights, 6)).toBe(2)
    expect(windowCount(0, [9], 3)).toBe(1)
    // A row that would be cut at the bottom is not drawn at all: a draft is drawn whole or not.
    expect(windowCount(0, heights, 7)).toBe(5)
  })

  test('rows that come or go keep the cursor and the window on their rows; the cursor\'s own row gives way to the next, or the one before at the end', () => {
    const before = ['msg:1', 'draft:ap:7', 'msg:2', 'msg:3']
    // A draft above the cursor leaves (sent from the band): the cursor stays on msg:2, the window on msg:1.
    expect(keptCursor(before, ['msg:1', 'msg:2', 'msg:3'], 2, 0)).toEqual({ cursor: 1, start: 0 })
    // The window's first row leaves: it starts on the row the cursor can still see.
    expect(keptCursor(before, ['msg:1', 'msg:2', 'msg:3'], 3, 1)).toEqual({ cursor: 2, start: 1 })
    // The cursor's own row leaves: the next row takes its place; at the end, the one before.
    expect(keptCursor(before, ['msg:1', 'msg:2', 'msg:3'], 1, 0)).toEqual({ cursor: 1, start: 0 })
    expect(keptCursor(['msg:1', 'draft:ap:7'], ['msg:1'], 1, 0)).toEqual({ cursor: 0, start: 0 })
    // A draft landing below the cursor moves nothing.
    expect(keptCursor(['msg:1', 'msg:2'], ['msg:1', 'msg:2', 'draft:reply'], 1, 0)).toEqual({ cursor: 1, start: 0 })
  })
})
