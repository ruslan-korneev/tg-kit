// The dock's section rows, the header's parts and the CHATS title (docs/design/dialogs-pane-ux.md §10.5).
import { describe, expect, test } from 'claude-code/testing'

import { CARD_CHROME, chatsTitle, fitTitle, headerParts, titleRoom, type HeaderCounts } from './frame'
import { MIN_CHATS, OPEN_CHATS, dockLayout, type DockInput } from './layout'

const QUIET: DockInput = { room: 27, isOpen: false, isStart: false, forYou: 0, autopilot: 0, log: 0, list: 60 }
const card = (rows: number) => (rows > 0 ? rows + CARD_CHROME : 0)
const used = (layout: ReturnType<typeof dockLayout>) => card(layout.forYou) + card(layout.chats) + card(layout.start) + card(layout.autopilot) + card(layout.log) + card(layout.lower)

describe('the dock\'s sections', () => {
  test('a section with nothing takes no room; CHATS takes the rest, so the cards fill the pane', () => {
    const layout = dockLayout(QUIET)
    expect(layout).toEqual({ forYou: 0, chats: 25, start: 0, autopilot: 0, log: 0, lower: 0 })
    expect(used(layout)).toBe(27)
  })

  test('FOR YOU takes 1-3, AUTOPILOT what it asks, LOG the rest from 2 on: the last card grows to the bottom', () => {
    const layout = dockLayout({ ...QUIET, forYou: 5, autopilot: 4, log: 9, list: 7 })
    expect(layout.forYou).toBe(3)
    expect(layout.autopilot).toBe(4)
    expect(layout.chats).toBe(7)
    expect(layout.log).toBe(27 - card(3) - card(7) - card(4) - CARD_CHROME)
    expect(used(layout)).toBe(27)
  })

  test('with no LOG the AUTOPILOT card grows; with neither, CHATS', () => {
    expect(dockLayout({ ...QUIET, autopilot: 3, list: 7 }).autopilot).toBe(27 - card(7) - CARD_CHROME)
    expect(dockLayout({ ...QUIET, list: 3 }).chats).toBe(25)
  })

  test('a 60-chat folder keeps CHATS at its five rows at least; a short pane gives way LOG first, then FOR YOU, START HERE, AUTOPILOT', () => {
    const tight = dockLayout({ ...QUIET, room: 20, forYou: 3, autopilot: 5, log: 4 })
    expect(tight.chats).toBeGreaterThanOrEqual(MIN_CHATS)
    expect(tight.log).toBe(0)
    expect(used(tight)).toBe(20)
    const tighter = dockLayout({ ...QUIET, room: 16, forYou: 3, autopilot: 5, log: 4, isStart: true })
    expect(tighter).toMatchObject({ log: 0, forYou: 1, start: 0 })
    expect(tighter.chats).toBeGreaterThanOrEqual(MIN_CHATS)
  })

  test('START HERE: three lines under CHATS on the first open', () => {
    const layout = dockLayout({ ...QUIET, isStart: true, list: 7 })
    expect(layout.start).toBe(3)
    expect(used(layout)).toBe(27)
  })

  test('a chat open: CHATS keeps three rows, the lower card the rest, the other sections fold', () => {
    const layout = dockLayout({ ...QUIET, isOpen: true, forYou: 2, autopilot: 4, log: 9 })
    expect(layout).toEqual({ forYou: 0, chats: OPEN_CHATS, start: 0, autopilot: 0, log: 0, lower: 27 - card(OPEN_CHATS) - CARD_CHROME })
  })
})

const ZERO: HeaderCounts = { unread: 0, mentions: 0, forYou: 0, agents: 0, isHolding: false, follows: 0, watched: 0 }
const words = (counts: HeaderCounts, short = false) => headerParts(counts, short).map(part => part.text).join(' · ')

describe('the header', () => {
  test('zero parts are left out', () => {
    expect(words(ZERO)).toBe('TG')
    expect(words({ ...ZERO, unread: 15, forYou: 2, agents: 2 })).toBe('TG · 15 UNREAD · 2 FOR YOU · AUTOPILOT 2 CHATS')
    expect(words({ ...ZERO, agents: 1, follows: 1, watched: 3 })).toBe('TG · AUTOPILOT 1 CHATS · ⌁ 1 · ◎ 3 NEW')
  })

  test('@N stands in for FOR YOU only while that part is out', () => {
    expect(words({ ...ZERO, mentions: 2 })).toBe('TG · @2')
    expect(words({ ...ZERO, mentions: 2, forYou: 1 })).toBe('TG · 1 FOR YOU')
  })

  test('each part in its role; AUTOPILOT in held while an agent holds something; short drops CHATS', () => {
    const roles = headerParts({ ...ZERO, unread: 1, forYou: 1, agents: 1, follows: 1 }).map(part => part.role)
    expect(roles).toEqual(['accent', 'unread', 'mention', 'ok', 'dim'])
    expect(headerParts({ ...ZERO, agents: 1, isHolding: true }).at(-1)?.role).toBe('held')
    expect(words({ ...ZERO, agents: 2 }, true)).toBe('TG · AUTOPILOT 2')
  })
})

describe('the CHATS title', () => {
  const tabs = ['Personal', 'Work 15', 'Bots']

  test('the tabs after CHATS, the current one accent and bold; no digit, no ‹›', () => {
    const title = chatsTitle({ tabs, current: 1, start: 0, end: 3, query: '' })
    expect(title.map(part => part.text).join('')).toBe('CHATS  Personal  Work 15  Bots')
    expect(title.find(part => part.text === 'Work 15')).toMatchObject({ role: 'accent', bold: true })
    expect(title.find(part => part.text === 'Personal')?.bold).not.toBe(true)
  })

  test('› and ‹ for the tabs past each edge', () => {
    expect(chatsTitle({ tabs, current: 1, start: 1, end: 2, query: '' }).map(part => part.text).join('')).toBe('CHATS  ‹  Work 15  ›')
  })

  test('a search shows its query instead', () => {
    expect(chatsTitle({ tabs, current: 1, start: 0, end: 3, query: 'anna' }).map(part => part.text).join('')).toBe('CHATS  "anna"')
  })

  test('the title fits beside the corner: `╭─ ` title ` ─…─ ` corner ` ─╮`', () => {
    expect(titleRoom(60, null)).toBe(54)
    expect(titleRoom(60, '1-9 folders')).toBe(40)
    expect(fitTitle([{ text: 'CHATS' }, { text: '  Personal' }], 10).map(part => part.text)).toEqual(['CHATS', '  Pe…'])
  })
})
