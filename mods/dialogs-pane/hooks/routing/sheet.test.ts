import { describe, expect, test } from 'claude-code/testing'

import type { TgMessage } from '../../types'
import { CHAT_KINDS, type ChatKind } from '../ui/keys'
import { BOT, REPLY, SENT, msg } from '../packet/fixtures'
import {
  FIRST_INTENT,
  SHEET_INTENTS,
  bandIntent,
  inspectView,
  isRemembered,
  legIntents,
  mainLegIntent,
  nextLegIntent,
  parseLastIntents,
  rememberedWith,
  ringedIntent,
  senderClass,
  setClass,
  sheetIntent,
  sheetTitle,
  targetText,
} from './sheet'

const person = (over: Partial<TgMessage> = {}) => msg({ id: 92, out: false, sender: { id: 1004, kind: 'user', username: null, name: 'Contact A' }, ...over })
const post = msg({ id: 7, out: false, sender: { id: 1005, kind: 'channel', username: null, name: 'Announcements' } })

describe('intents follow the sender (§4.6)', () => {
  test('the table: bot, people, everyone else; Ask always last', () => {
    expect(SHEET_INTENTS.bot).toEqual(['fix', 'reproduce', 'explain', 'test', 'raw'])
    expect(SHEET_INTENTS.person).toEqual(['do_it', 'explain', 'draft_reply', 'raw'])
    expect(SHEET_INTENTS.other).toEqual(['do_it', 'explain', 'raw'])
    for (const list of Object.values(SHEET_INTENTS)) expect(list.at(-1)).toBe('raw')
  })

  test("a bot's reply is a bot's in any chat, a group included", () => {
    for (const chat of CHAT_KINDS) expect(senderClass(REPLY, chat)).toBe('bot')
  })

  test('a person gets Draft reply only where the owner can write and someone reads it: not in Saved', () => {
    const writable: Record<ChatKind, boolean> = { bot: true, person: true, group: true, saved: false, channel: false, botfather: false }
    for (const chat of CHAT_KINDS) expect(senderClass(person(), chat)).toBe(writable[chat] ? 'person' : 'other')
  })

  test("the owner's own message and a channel's post get the rest", () => {
    expect(senderClass(SENT, 'bot')).toBe('other')
    expect(senderClass(person({ out: true }), 'person')).toBe('other')
    expect(senderClass(msg({ id: 1, out: false, sender: { id: 1, kind: 'self', username: null, name: 'Me' } }), 'saved')).toBe('other')
    expect(senderClass(post, 'channel')).toBe('other')
    expect(senderClass(msg({ id: 2, out: false, sender: { id: 1002, kind: 'supergroup', username: null, name: 'Dev Team' } }), 'group')).toBe('other')
  })

  test("a marked set takes its newest message's sender, whatever the order it came in", () => {
    expect(setClass([REPLY, person({ id: REPLY.id - 1 })], 'group')).toBe('bot')
    expect(setClass([person({ id: REPLY.id + 1 }), REPLY], 'group')).toBe('person')
    expect(setClass([], 'group')).toBe('other')
  })

  test('Explain is the bot template for bots and the people template otherwise; Ask carries the words', () => {
    expect(sheetIntent('explain', 'bot')).toEqual({ id: 'explain', audience: 'bot' })
    expect(sheetIntent('explain', 'person')).toEqual({ id: 'explain', audience: 'people' })
    expect(sheetIntent('explain', 'other')).toEqual({ id: 'explain', audience: 'people' })
    expect(sheetIntent('raw', 'bot', 'why?')).toEqual({ id: 'raw', text: 'why?' })
  })
})

describe('⏎ repeats the last intent per kind of sender', () => {
  test('bots start on Fix, people on Ask', () => {
    expect(FIRST_INTENT).toEqual({ bot: 'fix', person: 'raw', other: 'raw' })
    expect(parseLastIntents(undefined)).toEqual(FIRST_INTENT)
  })

  test('the store keeps one per sender; a value that is not that sender\'s intent is ignored', () => {
    const last = parseLastIntents({ bot: 'test', person: 'fix', other: 'explain', extra: 1 })
    expect(last).toEqual({ bot: 'test', person: 'raw', other: 'explain' })
    expect(ringedIntent(last, 'bot')).toBe('test')
    expect(ringedIntent(last, 'person')).toBe('raw')
    expect(parseLastIntents('nonsense')).toEqual(FIRST_INTENT)
    expect(isRemembered({ bot: 'test' }, 'bot')).toBe(true)
    expect(isRemembered({ person: 'fix' }, 'person')).toBe(false)
    expect(isRemembered(null, 'bot')).toBe(false)
  })

  test('using one sender\'s intent stores that one and keeps the others used before, never a default', () => {
    expect(rememberedWith(undefined, 'bot', 'explain')).toEqual({ bot: 'explain' })
    expect(rememberedWith({ bot: 'explain', person: 'fix' }, 'other', 'do_it')).toEqual({ bot: 'explain', other: 'do_it' })
    expect(isRemembered(rememberedWith(undefined, 'bot', 'explain'), 'person')).toBe(false)
  })

  test("a broadcast leg cycles its sender's intents without Ask; main's leg never starts on Ask", () => {
    expect(legIntents('person')).toEqual(['do_it', 'explain', 'draft_reply'])
    expect(nextLegIntent('bot', 'test')).toBe('fix')
    expect(nextLegIntent('other', 'explain')).toBe('do_it')
    expect(mainLegIntent(FIRST_INTENT, 'person')).toBe('do_it')
    expect(mainLegIntent({ ...FIRST_INTENT, bot: 'reproduce' }, 'bot')).toBe('reproduce')
  })

  test('the band names a real intent: the last one, but Fix or Explain where that is Ask', () => {
    expect(bandIntent('bot', FIRST_INTENT)).toEqual({ sender: 'bot', intent: 'fix' })
    expect(bandIntent('user', FIRST_INTENT)).toEqual({ sender: 'person', intent: 'explain' })
    expect(bandIntent('user', { ...FIRST_INTENT, person: 'do_it' })).toEqual({ sender: 'person', intent: 'do_it' })
    expect(bandIntent('supergroup', FIRST_INTENT)).toEqual({ sender: 'other', intent: 'explain' })
  })
})

describe('what the sheet says', () => {
  test('its title and target', () => {
    expect(sheetTitle([REPLY], 1)).toBe(`send #${REPLY.id} + 1 parent`)
    expect(sheetTitle([person()], 0)).toBe('send #92 from Contact A')
    expect(sheetTitle([SENT, REPLY], 2)).toBe('send 2 messages + 2 parents')
    expect(targetText({ kind: 'main' }, 'idle')).toBe('→ main · idle')
    expect(targetText({ kind: 'agent', agentId: 'a1', label: 'tester' }, 'running')).toBe('→ tester · …running')
    expect(targetText({ kind: 'new' }, 'idle')).toBe('→ + new agent')
  })

  test('inspect: the facts, each message with its buttons, the parents, the masks or that there are none', () => {
    const view = inspectView({
      peer: '@example_bot',
      kind: 'bot',
      intent: 'fix',
      isRedacted: true,
      shown: [REPLY],
      parents: [SENT],
      toFetch: 1,
      replay: 'tg send @example_bot /settings --wait 10s',
      redactions: [{ kind: 'id', original: String(BOT.id), placeholder: '[id-1]' }],
      width: 64,
    })
    expect(view.head).toBe('@example_bot (bot) · Fix · redacted')
    expect(view.messages[0]).toMatch(new RegExp(`^#${REPLY.id} bot  "`))
    expect(view.parents).toEqual([expect.stringMatching(new RegExp(`^\\+ parent #${SENT.id} you  "`)), '+ 1 parent tg fetches on send'])
    expect(view.masked).toBe(`${BOT.id} → [id-1]`)
    expect(inspectView({ ...{ peer: 'x', kind: 'bot', intent: 'fix', shown: [], parents: [], toFetch: 0, replay: null, redactions: [], width: 64 }, isRedacted: false }).masked).toBe(
      'nothing: redaction is off for this packet',
    )
  })
})
