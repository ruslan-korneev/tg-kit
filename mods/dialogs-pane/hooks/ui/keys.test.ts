import { describe, expect, test } from 'claude-code/testing'

import {
  CHAT_KINDS,
  KEYS,
  MAX_BAR,
  NO_FACTS,
  WHERES,
  actionBar,
  barCells,
  chatKind,
  exists,
  hiddenKeys,
  keyDef,
  menu,
  type ChatKind,
  type KeyContext,
  type KeyFacts,
  type Where,
} from './keys'

const at = (where: Where, kind: ChatKind | null, facts: Partial<KeyFacts> = {}, seat: 'dock' | 'inline' = 'dock'): KeyContext => ({
  where,
  seat,
  kind,
  facts: { ...NO_FACTS, rows: 3, ...facts },
})

const ids = (keys: readonly { id: string }[]) => keys.map(one => one.id)

describe('the key table', () => {
  test('a hotkey is one lowercase letter or one digit, and means one thing', () => {
    const hotkeys = KEYS.flatMap(def => (def.hotkey === null ? [] : [def.hotkey]))
    for (const key of hotkeys) expect(/^[a-z0-9]$/.test(key)).toBe(true)
    expect(hotkeys.filter((key, index) => hotkeys.indexOf(key) !== index)).toEqual([])
  })

  test('the engine’s own keys are never bound: Tab, Esc, Space and / are not letters or digits', () => {
    for (const def of KEYS) expect([' ', '/', '\t', '\u001b']).not.toContain(def.hotkey)
  })

  test('tg kinds map to §4.6 kinds; BotFather is a bot chat of its own', () => {
    expect(chatKind('bot', false)).toBe('bot')
    expect(chatKind('bot', true)).toBe('botfather')
    expect(chatKind('user', false)).toBe('person')
    expect(chatKind('supergroup', false)).toBe('group')
    expect(chatKind('self', false)).toBe('saved')
    expect(chatKind('channel', false)).toBe('channel')
    expect(chatKind('unknown', false)).toBe('channel')
  })

  // §4.6 "what exists in which chat": a dash means never here.
  const NEVER: Record<ChatKind, readonly string[]> = {
    bot: [],
    person: ['r', 'f', 'b'],
    group: ['r', 'f'],
    channel: ['n', 'r', 'f'],
    saved: ['w', 'a', 'p', 'r', 'f', 'b'],
    botfather: ['n', 'w', 'a', 'p', 'r', 'f'],
  }

  for (const kind of CHAT_KINDS) {
    test(`${kind}: the keys §4.6 rules out are neither in the bar, nor hidden, nor in the menu`, () => {
      const facts = { hasPair: true, hasButtons: true, marks: 2 }
      for (const seat of ['dock', 'inline'] as const) {
        const context = at('chat', kind, facts, seat)
        const reached = [...actionBar(context), ...hiddenKeys(context, new Set())].map(one => one.hotkey)
        const listed = menu(context).flatMap(section => section.entries.map(entry => entry.def.hotkey))
        for (const key of NEVER[kind]) {
          expect(reached).not.toContain(key)
          expect(listed).not.toContain(key)
        }
      }
    })
  }
})

describe('the action bar', () => {
  test('§4.6 orders: ⏎ first, m last, ≤ 7 in every view and kind', () => {
    for (const where of WHERES) {
      for (const kind of [...CHAT_KINDS, null]) {
        for (const seat of ['dock', 'inline'] as const) {
          const bar = actionBar(at(where, kind, { isRunning: true, undoLeft: 20, hasPair: true }, seat))
          expect(bar.length).toBeLessThanOrEqual(MAX_BAR)
          if (where !== 'band') expect(bar.at(-1)?.id).toBe('menu')
        }
      }
    }
    expect(ids(actionBar(at('chat', 'bot')))).toEqual(['send', 'write', 'record', 'mark', 'agent', 'menu'])
    expect(ids(actionBar(at('chat', 'person')))).toEqual(['send', 'write', 'agent', 'watch', 'mark', 'menu'])
    expect(ids(actionBar(at('chat', 'group')))).toEqual(['send', 'summary', 'watch', 'agent', 'write', 'menu'])
    expect(ids(actionBar(at('chat', 'channel')))).toEqual(['send', 'summary', 'watch', 'agent', 'mark', 'menu'])
    expect(ids(actionBar(at('chat', 'saved')))).toEqual(['send', 'write', 'mark', 'menu'])
    expect(ids(actionBar(at('chats', 'bot')))).toEqual(['open', 'summary', 'watch', 'agent', 'menu'])
    expect(ids(actionBar(at('chats', 'bot', {}, 'inline')))).toEqual(['open', 'search', 'summary', 'watch', 'agent', 'menu'])
  })

  test('f joins on a pair; 0 and u join while they work; back joins inline', () => {
    expect(ids(actionBar(at('chat', 'bot', { hasPair: true })))).toContain('diff')
    const busy = ids(actionBar(at('chat', 'bot', { isRunning: true, undoLeft: 12 }, 'inline')))
    expect(busy.slice(-4)).toEqual(['back', 'undo', 'stop', 'menu'])
    expect(busy).toHaveLength(MAX_BAR)
    expect(actionBar(at('chat', 'bot', { undoLeft: 12 })).find(one => one.id === 'undo')?.label).toBe('undo 12s')
  })

  test('narrow: verbs leave from the end; ⏎, h, u, 0 and m stay', () => {
    const context = at('chat', 'bot', { isRunning: true }, 'inline')
    const bar = actionBar(context, 40)
    const cells = bar.reduce((sum, key, index) => sum + barCells(key) + (index === 0 ? 0 : 2), 0)
    expect(cells).toBeLessThanOrEqual(40)
    expect(ids(bar)[0]).toBe('send')
    expect(ids(bar).slice(-3)).toEqual(['back', 'stop', 'menu'])
  })

  test('a key that waits for a step is off the bar: 0 with nothing running, f without a pair', () => {
    expect(ids(actionBar(at('chat', 'bot')))).not.toContain('stop')
    expect(ids(actionBar(at('chat', 'bot')))).not.toContain('diff')
  })
})

describe('hidden keys and the menu', () => {
  test('the live keys the bar does not draw stay pressable; drawn ones are not doubled', () => {
    const context = at('chat', 'bot')
    const bar = actionBar(context)
    const drawn = new Set(bar.flatMap(one => (one.hotkey === null ? [] : [one.hotkey])))
    const hidden = hiddenKeys(context, drawn)
    expect(ids(hidden)).toEqual(expect.arrayContaining(['down', 'up', 'range', 'follow', 'watch', 'summary', 'hide', 'activity', 'reload']))
    for (const key of hidden) expect(drawn.has(key.hotkey ?? '')).toBe(false)
    // Not live: f without a pair, 0 with nothing running, d without a notice.
    expect(ids(hidden)).not.toContain('diff')
    expect(ids(hidden)).not.toContain('stop')
    expect(ids(hidden)).not.toContain('dismiss')
  })

  test('the menu lists a key that waits, with its step; one that never works is not there', () => {
    const entries = menu(at('chat', 'bot')).flatMap(section => section.entries)
    expect(entries.find(entry => entry.def.id === 'diff')?.needs).toBe('needs two replies marked (x)')
    // 0 waits for something to run, but the menu lists it quietly: see the T4 tests below.
    expect(entries.find(entry => entry.def.id === 'stop')?.needs).toBe('nothing runs')
    expect(entries.find(entry => entry.def.id === 'mark')?.needs).toBeNull()
    expect(menu(at('chat', 'person')).flatMap(section => section.entries).some(entry => entry.def.id === 'record')).toBe(false)
    // h and m close the menu itself: they are its bar, not its entries.
    expect(entries.some(entry => entry.def.id === 'back' || entry.def.id === 'menu')).toBe(false)
  })

  test('the band shares the pane’s letters: o opens, d dismisses, e edits, u undoes', () => {
    for (const id of ['open', 'dismiss', 'edit', 'undo'] as const) expect(exists(keyDef(id), at('band', null))).toBe(true)
    expect(keyDef('dismiss').hotkey).toBe('d')
  })
})

describe('the send sheet (§5.1)', () => {
  test('a picks another agent in every kind of chat, Saved and BotFather too; there the card does not exist', () => {
    for (const kind of CHAT_KINDS) {
      const sheet = at('sheet', kind, { sheet: 'intents' })
      expect(exists(keyDef('agent'), sheet)).toBe(true)
      expect(keyDef('agent').label(sheet)).toBe('another agent')
    }
    expect(exists(keyDef('agent'), at('chat', 'saved'))).toBe(false)
    expect(exists(keyDef('agent'), at('chat', 'botfather'))).toBe(false)
  })

  test('its own keys and digits work on the intents; its other steps answer h', () => {
    const live = (where: Where, sheet: KeyFacts['sheet']) =>
      [...actionBar(at(where, 'bot', { sheet })), ...hiddenKeys(at(where, 'bot', { sheet }), new Set())].map(one => one.id)
    expect(live('sheet', 'intents')).toEqual(expect.arrayContaining(['agent', 'inspect', 'back']))
    for (const step of ['targets', 'inspect', 'ask', 'broadcast'] as const) {
      expect(live('sheet', step)).not.toContain('agent')
      expect(live('sheet', step)).not.toContain('inspect')
      expect(live('sheet', step)).toContain('back')
    }
    const entries = (sheet: KeyFacts['sheet']) => menu(at('sheet', 'bot', { sheet })).flatMap(section => section.entries)
    expect(entries('intents').find(entry => entry.def.id === 'intents')?.needs).toBeNull()
    expect(entries('intents').find(entry => entry.def.id === 'target')?.needs).toBe('needs a: another agent')
    expect(entries('targets').find(entry => entry.def.id === 'target')?.needs).toBeNull()
    expect(entries('targets').find(entry => entry.def.id === 'intents')?.needs).toBe('needs the intents (h)')
    expect(keyDef('back').label(at('sheet', 'bot', { sheet: 'intents' }))).toBe('cancel')
    expect(keyDef('back').label(at('sheet', 'bot', { sheet: 'targets' }))).toBe('back')
  })

  test('i inspects from a chat with messages, and is not the intent cycle any more', () => {
    expect(keyDef('inspect').hotkey).toBe('i')
    expect(ids(hiddenKeys(at('chat', 'person'), new Set()))).toContain('inspect')
    expect(ids(hiddenKeys(at('chat', 'person', { rows: 0 }), new Set()))).not.toContain('inspect')
    expect(KEYS.some(def => def.label(at('sheet', 'bot', { sheet: 'intents' })) === 'intent')).toBe(false)
  })
})

describe('what runs and the kill switch (§4.6, §5.6, T4)', () => {
  test('in the dock the running strip says 0: stop all, so the bar never does; inline the bar does', () => {
    for (const where of ['chats', 'chat', 'card', 'activity', 'diff'] as const) {
      expect(ids(actionBar(at(where, 'bot', { isRunning: true }, 'dock')))).not.toContain('stop')
      expect(ids(actionBar(at(where, 'bot', { isRunning: true }, 'inline')))).toContain('stop')
    }
    // Still live in the dock: the frame keeps it as a hidden hotkey.
    expect(ids(hiddenKeys(at('chat', 'bot', { isRunning: true }, 'dock'), new Set()))).toContain('stop')
  })

  test('the menu: 0 stays in safety, quiet while nothing runs; u is listed only while its window is open', () => {
    const idle = menu(at('chat', 'bot')).flatMap(section => section.entries)
    const stop = idle.find(entry => entry.def.id === 'stop')
    expect(stop?.label).toBe('stop every agent and Worker · /tg stop')
    expect(stop?.isQuiet).toBe(true)
    expect(idle.some(entry => entry.def.id === 'undo')).toBe(false)
    const busy = menu(at('chat', 'bot', { isRunning: true, undoLeft: 9 })).flatMap(section => section.entries)
    expect(busy.find(entry => entry.def.id === 'stop')?.needs).toBeNull()
    expect(busy.find(entry => entry.def.id === 'undo')?.label).toBe('undo 9s')
  })

  test('Activity: ⏎ open, d dismisses ended tasks once there is one, h back; j and k move among its rows', () => {
    expect(ids(actionBar(at('activity', null, { rows: 2 })))).toEqual(['open', 'back', 'menu'])
    expect(ids(actionBar(at('activity', null, { rows: 2, hasFinished: true })))).toEqual(['open', 'dismiss', 'back', 'menu'])
    expect(actionBar(at('activity', null, { rows: 2, hasFinished: true })).find(one => one.id === 'dismiss')?.label).toBe('dismiss ended tasks')
    expect(ids(actionBar(at('activity', null, { rows: 0 })))).toEqual(['back', 'menu'])
    for (const id of ['down', 'up'] as const) expect(exists(keyDef(id), at('activity', null))).toBe(true)
  })
})
