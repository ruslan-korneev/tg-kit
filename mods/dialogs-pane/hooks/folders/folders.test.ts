// The pure folder rules (docs/design/dialogs-pane-ux.md §4.7, §8 T9): the
// pass and the views it makes, what waits, the strip's window, when a pass
// runs, and what $.store keeps. Placeholder data only.
import { describe, expect, test } from 'claude-code/testing'

import type { FolderChats, TgDialog } from '../../types'
import { parseFolderPass, parseFolders } from '../packet/types'
import {
  HIDDEN_GAP_MS,
  NO_PASS,
  PASS_GAP_MS,
  TEXT_MAX,
  bump,
  cutCells,
  cutRow,
  forYouPeople,
  parseStored,
  passMap,
  passPlan,
  recount,
  stripEntries,
  stripWindow,
  tabText,
  viewRows,
  waitingCount,
} from './folders'

const row = (id: number, over: Partial<TgDialog> = {}): TgDialog => ({
  id,
  kind: 'user',
  title: `Contact ${id}`,
  username: null,
  unread: 0,
  mentions: 0,
  pinned: false,
  muted: false,
  last_id: 1,
  last_date: `2026-10-10T10:${String(id % 60).padStart(2, '0')}:00Z`,
  last_text: 'placeholder',
  ...over,
})

const folder = (id: number, chats: number[], pinned: number[] = []): FolderChats => ({ id, title: `Folder ${id}`, kind: 'folder', unread: 0, pinned, chats })
const NOBODY = { username: null, name: null }

describe('the pass', () => {
  test('tg folders --chats --json parses into folders and rows; a bad shape is refused', () => {
    const pass = parseFolderPass({
      at: '2026-10-11T09:30:00+00:00',
      scan: 500,
      folders: [{ id: 0, title: 'All chats', kind: 'all', unread: 1, pinned: [1], chats: [1, 2] }],
      dialogs: [row(1), row(2)],
    })
    expect(pass.folders[0]?.chats).toEqual([1, 2])
    expect(() => parseFolderPass({ at: 'x', scan: 500, folders: [{ id: 0, title: 'x', kind: 'tab', unread: 0, pinned: [], chats: [] }], dialogs: [] })).toThrow()
    expect(parseFolders([{ id: 2, title: 'Work', kind: 'folder' }])).toEqual([{ id: 2, title: 'Work', kind: 'folder', unread: null }])
  })

  test("a folder's view is its chats in its order; Bots, every bot newest first; the Archive is not cached", () => {
    const map = passMap({ at: '', scan: 500, folders: [folder(2, [3, 1])], dialogs: [row(1, { kind: 'bot' }), row(3), row(4, { kind: 'bot', last_date: '2026-10-10T11:00:00Z' })] })
    expect(viewRows(map, { kind: 'folder', id: 2 })?.map(one => one.id)).toEqual([3, 1])
    expect(viewRows(map, { kind: 'bots' })?.map(one => one.id)).toEqual([4, 1])
    expect(viewRows(map, { kind: 'archive' })).toBeNull()
    expect(viewRows(map, { kind: 'folder', id: 9 })).toBeNull()
    expect(viewRows(null, { kind: 'folder', id: 2 })).toBeNull()
  })

  test('$.state keeps last_text cut to 120 characters', () => {
    expect(cutRow(row(1, { last_text: 'x'.repeat(300) })).last_text).toHaveLength(TEXT_MAX)
    const short = row(1)
    expect(cutRow(short)).toBe(short)
  })
})

describe('between passes', () => {
  test("a watch event moves the chat to the top of every folder's unpinned part; the pins stay above it", () => {
    const map = passMap({ at: '', scan: 500, folders: [folder(1, [9, 1, 2, 3], [9]), folder(2, [1, 2]), folder(3, [3, 4])], dialogs: [] })
    const after = bump(map, 3)
    expect(after.folders.map(one => one.chats)).toEqual([[9, 3, 1, 2], [1, 2], [3, 4]])
    // A pinned chat keeps its place.
    expect(bump(map, 9).folders[0]?.chats).toEqual([9, 1, 2, 3])
  })

  test('counts are the unread chats that are not muted', () => {
    const map = passMap({ at: '', scan: 500, folders: [folder(1, [1, 2, 3])], dialogs: [row(1, { unread: 2 }), row(2, { unread: 5, muted: true }), row(3)] })
    expect(recount(map).folders[0]?.unread).toBe(1)
  })

  test('what waits counts the chats that moved, joined or left, not every row a move passed', () => {
    expect(waitingCount(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toBe(0)
    expect(waitingCount(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])).toBe(1)
    expect(waitingCount(['a', 'b', 'c'], ['a', 'b', 'c', 'e'])).toBe(1)
    expect(waitingCount(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
    expect(waitingCount(['a', 'b'], ['c', 'b', 'a'])).toBe(2)
  })
})

describe('For you', () => {
  test('mentions and person chats with unread messages that are not muted, ranked with why; noise left out', () => {
    const rows = [
      row(1, { kind: 'supergroup', unread: 3, mentions: 1, last_text: 'can you review?' }),
      row(2, { unread: 1, last_text: 'free tomorrow?' }),
      row(3, { unread: 1, last_text: 'hm' }),
      row(4, { unread: 1, muted: true, last_text: 'are you there?' }),
      row(5, { kind: 'channel', unread: 9 }),
      row(6, { unread: 1, last_text: 'lol' }),
    ]
    const people = forYouPeople(rows, NOBODY, { '6:1': 'noise' }, {})
    expect(people.rows.map(one => one.id)).toEqual([2, 1, 3])
    expect(people.why).toEqual({ '1': 'mentions you', '2': 'asks you', '3': 'fyi' })
  })
})

describe('the strip', () => {
  const list = ['Personal', 'Work', 'All chats', 'News', 'Family', 'Study', 'Travel', 'Dev', 'Old', 'Music'].map((title, index) => ({
    id: index === 2 ? 0 : index + 1,
    title,
    kind: title === 'All chats' ? ('all' as const) : ('folder' as const),
    unread: index === 1 ? 3 : 0,
  }))

  test("Telegram's folders, then For you and Bots; digits on the first nine entries", () => {
    const entries = stripEntries(list)
    expect(entries.map(one => one.title).slice(-3)).toEqual(['Music', 'For you', 'Bots'])
    expect(entries.map(one => one.digit)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null])
    // An account without folders: All chats, For you, Bots.
    expect(stripEntries([{ id: 0, title: 'All chats', kind: 'all', unread: 4 }]).map(one => `${one.digit}: ${one.title}`)).toEqual(['1: All chats', '2: For you', '3: Bots'])
  })

  test('a tab: the digit while live, the count, the current one marked; titles cut to 12 cells, an emoji counting two', () => {
    const [personal, work] = stripEntries(list)
    if (personal === undefined || work === undefined) throw new Error('no entries')
    expect(tabText(work, true, true)).toBe('2: ‹Work 3›')
    expect(tabText(work, false, false)).toBe('Work 3')
    expect(tabText(personal, false, true)).toBe('1: Personal')
    expect(cutCells('Reading list for later', 12)).toBe('Reading lis…')
    expect(cutCells('🎵🎵🎵🎵🎵🎵🎵', 12)).toBe('🎵🎵🎵🎵🎵…')
  })

  test('the window holds the current tab, with +N for the entries past each edge', () => {
    const texts = stripEntries(list).map(one => tabText(one, false, true))
    const first = stripWindow(texts, 0, 50)
    expect(first.start).toBe(0)
    expect(first.end).toBeLessThan(texts.length)
    const late = stripWindow(texts, 10, 50)
    expect(late.start).toBeGreaterThan(0)
    expect(late.end).toBeGreaterThan(10)
    expect(stripWindow(texts, 0, 500)).toEqual({ start: 0, end: texts.length })
  })
})

describe('when a pass runs', () => {
  const at = 1_000_000
  const ran = { ...NO_PASS, startedAt: at, hasOpened: true }

  test('opening runs one unless one started within 60 s', () => {
    expect(passPlan(NO_PASS, at, 'open', true)).toBe('run')
    expect(passPlan(ran, at + 30_000, 'open', true)).toBe('skip')
    expect(passPlan(ran, at + PASS_GAP_MS, 'open', true)).toBe('run')
    expect(passPlan({ ...ran, isRunning: true }, at + 90_000, 'open', true)).toBe('skip')
  })

  test('g inside the 60 s queues one; a second g adds none; the queued one runs when they are up', () => {
    expect(passPlan(ran, at + 20_000, 'g', true)).toBe('queue')
    const queued = { ...ran, queuedFor: at + PASS_GAP_MS }
    expect(passPlan(queued, at + 30_000, 'g', true)).toBe('skip')
    expect(passPlan(queued, at + 59_000, 'tick', true)).toBe('skip')
    expect(passPlan(queued, at + PASS_GAP_MS, 'tick', true)).toBe('run')
  })

  test('the cadence: every 60 s open, every 5 min hidden after a first open, never before one', () => {
    expect(passPlan(ran, at + PASS_GAP_MS, 'tick', true)).toBe('run')
    expect(passPlan(ran, at + PASS_GAP_MS, 'tick', false)).toBe('skip')
    expect(passPlan(ran, at + HIDDEN_GAP_MS, 'tick', false)).toBe('run')
    expect(passPlan({ ...ran, hasOpened: false }, at + HIDDEN_GAP_MS, 'tick', false)).toBe('skip')
  })

  test('a flood wait holds every pass until it is over', () => {
    const flooded = { ...ran, floodUntil: at + 90_000, queuedFor: at + 90_000 }
    expect(passPlan(flooded, at + 60_000, 'tick', true)).toBe('skip')
    expect(passPlan(flooded, at + 60_000, 'g', true)).toBe('skip')
    expect(passPlan(flooded, at + 90_000, 'tick', true)).toBe('run')
  })
})

describe('$.store', () => {
  test('the snapshot is checked: bad folders and rows drop, a bad view drops the whole', () => {
    const stored = parseStored({
      list: [{ id: 2, title: 'Work', kind: 'folder', unread: 3 }, { id: 'x' }],
      view: { kind: 'folder', id: 2 },
      rows: [row(1, { last_text: 'y'.repeat(200) }), { id: 2 }],
    })
    expect(stored?.list).toEqual([{ id: 2, title: 'Work', kind: 'folder', unread: 3 }])
    expect(stored?.rows.map(one => one.last_text.length)).toEqual([TEXT_MAX])
    expect(parseStored({ list: [], view: { kind: 'tab' }, rows: [] })).toBeNull()
    expect(parseStored(undefined)).toBeNull()
  })
})
