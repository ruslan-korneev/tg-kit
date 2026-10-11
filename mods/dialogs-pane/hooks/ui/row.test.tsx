import { describe, expect, test } from 'claude-code/testing'

import type { TgDialog } from '../../types'
import { ChatRow } from './components'
import {
  GLYPH,
  NARROW_GLYPHS,
  dialogLabel,
  dialogRow,
  labelCells,
  peerArg,
  peerConfirmLabel,
  rowSymbol,
  rowTime,
  rowWidths,
} from './model'
import { PALETTES } from './palette'

const chat = (over: Partial<TgDialog>): TgDialog => ({
  id: 2001,
  kind: 'user',
  title: 'Ivan Petrov',
  username: 'ivan_example',
  unread: 0,
  mentions: 0,
  pinned: false,
  muted: false,
  last_id: 1,
  last_date: null,
  last_text: 'Can we call tomorrow at 10?',
  ...over,
})

// Sunday 11 Oct 2026, 15:00 local: the time column is local time.
const NOW = new Date(2026, 9, 11, 15, 0).getTime()
const at = (days: number, hours = 14, minutes = 2) => new Date(2026, 9, 11 - days, hours, minutes).toISOString()

describe('the chat row (§10.4)', () => {
  test('time: 14:02 today, the weekday within six days, Oct 4 at seven, the year before this one; 6 cells at most', () => {
    expect(rowTime(at(0), NOW)).toBe('14:02')
    expect(rowTime(at(6), NOW)).toBe('Mon')
    expect(rowTime(at(7, 23, 59), NOW)).toBe('Oct 4')
    expect(rowTime(new Date(2025, 11, 31, 23, 0).toISOString(), NOW)).toBe('2025')
    expect(rowTime(new Date(2026, 9, 1).toISOString(), new Date(2026, 11, 13).getTime())).toBe('Oct 1')
    expect(rowTime(new Date(2026, 9, 13).toISOString(), new Date(2026, 11, 13).getTime())).toHaveLength(6)
    expect(rowTime(null, NOW)).toBe('')
    expect(rowTime('not a date', NOW)).toBe('')
  })

  test('one symbol by priority: no stops, mention, unread, ⚡, ro, ✎, muted', () => {
    const symbol = (over: Partial<TgDialog>, agent: Parameters<typeof rowSymbol>[1] = null, extra = {}) => rowSymbol(chat(over), agent, extra)
    expect(symbol({ mentions: 2, unread: 12 }, 'no-stops')).toEqual({ text: GLYPH.error, role: 'unread' })
    expect(symbol({ mentions: 2, unread: 12 }, 'on')).toEqual({ text: '@2', role: 'mention' })
    // Telegram notifies mentions in a muted chat, so they keep their colour (decision 5).
    expect(symbol({ mentions: 1, unread: 3, muted: true })).toEqual({ text: '@1', role: 'mention' })
    expect(symbol({ mentions: 150 })).toEqual({ text: '@9+', role: 'mention' })
    expect(symbol({ unread: 12 }, 'on')).toEqual({ text: '12', role: 'unread' })
    expect(symbol({ unread: 12, muted: true })).toEqual({ text: '12', role: 'dim' })
    expect(symbol({ unread: 100 })).toEqual({ text: '99+', role: 'unread' })
    expect(symbol({}, 'on', { isClosed: true })).toEqual({ text: GLYPH.closed, role: 'dim' })
    expect(symbol({}, 'on')).toEqual({ text: GLYPH.agent, role: 'ok' })
    expect(symbol({}, 'holding')).toEqual({ text: GLYPH.agent, role: 'held' })
    expect(symbol({ muted: true }, 'on')).toEqual({ text: GLYPH.agent, role: 'ok' })
    expect(symbol({ kind: 'bot', username: 'BotFather' })).toEqual({ text: 'ro', role: 'held' })
    expect(symbol({}, null, { hasDraft: true })).toEqual({ text: GLYPH.draft, role: 'held' })
    expect(symbol({ muted: true })).toEqual({ text: GLYPH.muted, role: 'dim' })
    expect(symbol({})).toBeNull()
  })

  test('name and preview widths: the preview gives way first', () => {
    expect(rowWidths(56)).toEqual({ name: 20, preview: 21 })
    expect(rowWidths(40)).toEqual({ name: 13, preview: 12 })
    expect(rowWidths(30)).toEqual({ name: 15, preview: 0 })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a drawn row is exactly its width at 56, 40 and 30 cells, an emoji name counted by cells (${surface})`, async ($, on) => {
      const rows: { key: string; width: number; dialog: TgDialog; agent: 'on' | null }[] = [
        { key: 'plain', width: 56, dialog: chat({ unread: 2, last_date: at(0) }), agent: null },
        { key: 'emoji', width: 40, dialog: chat({ title: '🎉🎉🎉 Ivan Petrov party', last_date: at(3) }), agent: 'on' },
        { key: 'narrow', width: 30, dialog: chat({ kind: 'self', title: 'Me', username: null, last_date: at(40) }), agent: null },
      ]
      on('ui.render', { component: 'UserMessage' }, ($, e) => {
        const els = $.ui.resolve(e)
        const { Box } = els
        return (
          <Box key="rows" flexDirection="column">
            {rows.map(row => ChatRow(els, PALETTES['catppuccin-mocha'], { ...dialogRow(row.dialog, { now: NOW, agent: row.agent }), rowKey: row.key, width: row.width, isCursor: row.key === 'plain', isOpen: false, onPress: () => {} }))}
          </Box>
        )
      })
      const ui = await $.ui.mount({ plugin: 'dialogs-pane', surface, component: 'UserMessage', props: { text: '', origin: { kind: 'composer' }, isExpanded: false } })
      const text = async (key: string) => (await ui.find({ key }))?.text ?? ''
      expect(await text('plain')).toBe(`${GLYPH.cursor} 14:02 ○ Ivan Petrov          Can we call tomorrow…   2`)
      // 🎉 is two cells: 13 cells of name hold three of them and six letters, then the cut.
      expect(await text('emoji')).toBe('    Thu ○ 🎉🎉🎉 Ivan … Can we call…  ⚡')
      expect(await text('narrow')).toBe('  Sep 1 ★ Saved Messages      ')
      for (const row of rows) expect(labelCells(await text(row.key))).toBe(row.width)
      await ui.unmount()
    })
  }

  test('no row shows @username; peerArg is unchanged for a user, a bot and self', () => {
    const user = chat({})
    const bot = chat({ id: 1001, kind: 'bot', title: 'Example Bot', username: 'example_bot' })
    const self = chat({ id: 1003, kind: 'self', title: 'Me', username: null })
    const group = chat({ id: 1002, kind: 'supergroup', title: 'Project team', username: null })
    for (const one of [user, bot, self, group]) {
      expect(dialogRow(one, { now: NOW, agent: null }).name).not.toContain('@')
    }
    expect([user, bot, self, group].map(dialogLabel)).toEqual(['Ivan Petrov', 'Example Bot', 'Saved Messages', 'Project team'])
    expect([user, bot, self, group].map(peerArg)).toEqual(['@ivan_example', '@example_bot', 'me', '1002'])
  })

  test('where the owner confirms, the name carries its handle: names are not unique', () => {
    expect(peerConfirmLabel({ label: 'Ivan Petrov', arg: '@ivan_example' })).toBe('Ivan Petrov · @ivan_example')
    expect(peerConfirmLabel({ label: 'Project team', arg: '-1001234' })).toBe('Project team · -1001234')
    expect(peerConfirmLabel({ label: 'Saved Messages', arg: 'me' })).toBe('Saved Messages')
  })

  test("every glyph of §10.3 draws in one cell but ⚡, which is two", () => {
    const glyphs = ['○', '◇', '▷', '⬡', '★', '⌗', '●', '≡', '⊘', '◌', '✎', '⚠', '⌁', '◉', '⟳', '↯', '◎', '▪', '▣', '✓', '✗', '…', '■', '▰', '▱', '━', '↻']
    for (const glyph of glyphs) expect(`${glyph} ${NARROW_GLYPHS.has(glyph)}`).toBe(`${glyph} true`)
    expect(NARROW_GLYPHS.has(GLYPH.agent)).toBe(false)
    expect(labelCells(GLYPH.agent)).toBe(2)
    expect(labelCells('#')).toBe(1)
  })
})
