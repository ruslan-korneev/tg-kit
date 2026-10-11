import { describe, expect, test } from 'claude-code/testing'

import type { Topic } from '../../types'
import { PALETTES, PALETTE_NAMES, topicColor } from './palette'
import { allTopicsRow, breadcrumb, forumSymbol, newestTopic, topicColumn, topicRow, topicRowKey, topicSums, topicsInPlace, topicsWaiting } from './topics'

const topic = (over: Partial<Topic> & Pick<Topic, 'id' | 'title'>): Topic => ({
  icon_color: null,
  unread: 0,
  mentions: 0,
  pinned: false,
  closed: false,
  hidden: false,
  last_id: null,
  last_date: null,
  last_text: '',
  ...over,
})

// Placeholder topics of the placeholder forum "Project team" (repo rule).
const RELEASES = topic({ id: 12, title: 'Releases', icon_color: 0x6fb9f0, unread: 5, pinned: true, last_date: '2026-10-10T11:40:00Z', last_text: 'v2.4 is tagged' })
const DESIGN = topic({ id: 20, title: 'Design review', icon_color: 0xff93b2, unread: 1, mentions: 1, last_date: '2026-10-10T11:52:00Z', last_text: 'can you look at the header?' })
const GENERAL = topic({ id: 1, title: 'General', unread: 3, last_date: '2026-10-10T10:00:00Z', last_text: 'morning' })
const ROADMAP = topic({ id: 40, title: 'Old roadmap', icon_color: 0xfb6f5f, closed: true, last_date: '2026-09-01T09:00:00Z', last_text: 'archived' })
const TOPICS = [RELEASES, DESIGN, GENERAL, ROADMAP]

const NOW = new Date(2026, 9, 10, 15, 0).getTime()

describe('forum topics (§10.9)', () => {
  test("the forum's sums: every topic's unread and mentions added; a mention outranks unread", () => {
    expect(topicSums(TOPICS)).toEqual({ unread: 9, mentions: 1 })
    expect(forumSymbol(TOPICS, null)).toEqual({ text: '@1', role: 'mention' })
    expect(forumSymbol([RELEASES, GENERAL], null)).toEqual({ text: '8', role: 'unread' })
    expect(forumSymbol([ROADMAP], null)).toBeNull()
  })

  test('≡ all topics: the group glyph, the newest topic named in its preview, the sums as its symbol', () => {
    expect(newestTopic(TOPICS)).toBe(DESIGN)
    const row = allTopicsRow(TOPICS, NOW)
    expect(row.glyph).toEqual({ text: '≡', role: 'group' })
    expect(row.name).toBe('all topics')
    expect(row.preview.text).toBe('Design review · can you look at the header?')
    expect(row.symbol).toEqual({ text: '@1', role: 'mention' })
    expect(row.isUnread).toBe(true)
    expect(allTopicsRow([], NOW).preview.text).toBe('')
  })

  test("a topic's row: ● in its icon_color, General # dim, ⊘ once closed and read", () => {
    const blue = topicColor('theme', 0x6fb9f0)
    expect(blue).toBe(PALETTES.theme.person)
    expect(topicRow(RELEASES, { now: NOW, agent: null, color: blue }).glyph).toEqual({ text: '●', role: 'dim', color: blue })
    expect(topicRow(GENERAL, { now: NOW, agent: null, color: undefined }).glyph).toEqual({ text: '#', role: 'dim' })
    expect(topicRow(ROADMAP, { now: NOW, agent: null, color: undefined }).symbol).toEqual({ text: '⊘', role: 'dim' })
    // Unread outranks closed, as on any row (§10.3).
    expect(topicRow({ ...ROADMAP, unread: 2 }, { now: NOW, agent: null, color: undefined }).symbol).toEqual({ text: '2', role: 'unread' })
    expect(topicRow(GENERAL, { now: NOW, agent: 'on', color: undefined }).symbol).toEqual({ text: '3', role: 'unread' })
    expect(topicRow({ ...GENERAL, unread: 0 }, { now: NOW, agent: 'on', color: undefined }).symbol?.role).toBe('ok')
  })

  test('icon_color: each of the six in every palette; any other value, or none, is dim', () => {
    for (const color of [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f]) {
      for (const palette of PALETTE_NAMES) expect(topicColor(palette, color)).not.toBe(PALETTES[palette].dim)
    }
    expect(topicColor('theme', 0x123456)).toBe(PALETTES.theme.dim)
    expect(topicColor('catppuccin-mocha', -1)).toBe(PALETTES['catppuccin-mocha'].dim)
  })

  test('topics in place: counts change on their rows, the order drawn stays, one gone keeps its row; ↑N counts what moved', () => {
    const latest = [{ ...DESIGN, unread: 4 }, RELEASES, GENERAL, ROADMAP]
    expect(topicsInPlace(TOPICS, latest).map(one => [one.id, one.unread])).toEqual([
      [12, 5],
      [20, 4],
      [1, 3],
      [40, 0],
    ])
    expect(topicsWaiting(TOPICS, TOPICS)).toBe(0)
    expect(topicsWaiting(TOPICS, latest)).toBeGreaterThan(0)
    expect(topicsInPlace(TOPICS, [RELEASES, DESIGN, GENERAL]).at(-1)).toBe(ROADMAP)
    expect(topicsWaiting(TOPICS, [RELEASES, DESIGN, GENERAL])).toBe(1)
  })

  test('row keys carry the generation, the chat and the topic', () => {
    expect(topicRowKey(3, 1008, 'all')).toBe('topic:3:1008:all')
    expect(topicRowKey(3, 1008, 20)).toBe('topic:3:1008:20')
  })

  test('the breadcrumb: tg › folder › forum › topic; under 52 columns tg › goes first', () => {
    expect(breadcrumb({ folder: 'Work', forum: 'Project team', topic: 'Design review' }, true)).toBe('tg › Work › Project team › Design review')
    expect(breadcrumb({ folder: 'Work', forum: 'Project team', topic: null }, true)).toBe('tg › Work › Project team')
    expect(breadcrumb({ folder: null, forum: 'Project team', topic: 'all topics' }, false)).toBe('Project team › all topics')
  })

  test("the merged stream's topic column: 10 cells and a space's worth of padding, ? for a topic the list lacks", () => {
    expect(topicColumn('Releases')).toBe('Releases  ')
    expect(topicColumn('Design review')).toHaveLength(10)
    expect(topicColumn(undefined)).toBe('?         ')
  })
})
