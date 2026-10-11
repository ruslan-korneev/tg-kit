// The agent card's ladder, pure (dialogs-pane-ux.md §4.6, §5.4, §5.5, decisions 1, 2, 8, 9).
import { describe, expect, test } from 'claude-code/testing'

import type { ApRung } from '../../types'
import { CHAT_KINDS, KEYS, exists, keyDef, NO_FACTS } from '../ui/keys'
import { actionLabel, allowCommand, cardAction, firstPick, ladderFor, rungBlock, runningRung, sendsAlone, type AllowView, type CardInput } from './ladder'

const ALLOWED: AllowView = { kind: 'ok', isAllowed: true }
const OUTSIDE: AllowView = { kind: 'ok', isAllowed: false }
const input = (over: Partial<CardInput> = {}): CardInput => ({ step: 'ladder', pick: 'draft', running: null, allow: ALLOWED, isGuardUp: true, isWarned: true, ...over })

describe('the ladder by kind', () => {
  test('a person gets all five rungs, a group all but delegate, a bot and a channel follow and summarize, Saved and BotFather none', () => {
    expect(ladderFor('person')).toEqual(['follow', 'listen', 'draft', 'auto', 'delegate'])
    expect(ladderFor('group')).toEqual(['follow', 'listen', 'draft', 'auto'])
    expect(ladderFor('bot')).toEqual(['follow', 'listen'])
    expect(ladderFor('channel')).toEqual(['follow', 'listen'])
    expect(ladderFor('saved')).toEqual([])
    expect(ladderFor('botfather')).toEqual([])
  })

  test('delegate exists only in person chats (decision 8)', () => {
    expect(CHAT_KINDS.filter(kind => ladderFor(kind).includes('delegate'))).toEqual(['person'])
  })

  test('a is the card exactly where a ladder exists: the key table and the ladder agree', () => {
    const agent = keyDef('agent')
    for (const kind of CHAT_KINDS) {
      expect(exists(agent, { where: 'chat', seat: 'dock', kind, facts: NO_FACTS })).toBe(ladderFor(kind).length > 0)
    }
    expect(KEYS.find(def => def.id === 'level')?.key).toBe('1-5')
  })
})

describe('what ⏎ does on the card', () => {
  test('draft never needs allow.toml; auto and delegate send alone, so outside it ⏎ puts the allow in the prompt (decisions 1, 9)', () => {
    expect(sendsAlone('draft')).toBe(false)
    expect(cardAction(input({ pick: 'draft', allow: OUTSIDE }))).toEqual({ kind: 'start' })
    expect(cardAction(input({ pick: 'auto', allow: OUTSIDE }))).toEqual({ kind: 'allow' })
    expect(cardAction(input({ step: 'grant', pick: 'delegate', allow: OUTSIDE }))).toEqual({ kind: 'allow' })
    expect(cardAction(input({ pick: 'auto' }))).toEqual({ kind: 'start' })
    expect(allowCommand('1004')).toBe('! tg allow add 1004 --yes')
  })

  test('a read of allow.toml that failed is a retry, never "not in allow.toml" (§7.4); one on its way waits', () => {
    expect(cardAction(input({ pick: 'auto', allow: { kind: 'error', text: 'tg is not on PATH' } }))).toEqual({ kind: 'retry' })
    expect(rungBlock('auto', { kind: 'error', text: 'x' }, true)).toBe('could not read allow.toml')
    expect(cardAction(input({ pick: 'auto', allow: { kind: 'loading' } }))).toEqual({ kind: 'reading' })
    expect(rungBlock('auto', OUTSIDE, true)).toBe('needs allow.toml')
    expect(rungBlock('draft', OUTSIDE, false)).toBeNull()
    expect(rungBlock('delegate', ALLOWED, false)).toBe('needs the guard')
  })

  test('delegate: the warning once, then the grant; the grant starts it only while the guard answers', () => {
    expect(cardAction(input({ pick: 'delegate', isWarned: false }))).toEqual({ kind: 'warn' })
    expect(cardAction(input({ step: 'warning', pick: 'delegate', isWarned: false }))).toEqual({ kind: 'grant' })
    expect(cardAction(input({ pick: 'delegate' }))).toEqual({ kind: 'grant' })
    expect(cardAction(input({ step: 'grant', pick: 'delegate' }))).toEqual({ kind: 'start' })
    expect(cardAction(input({ step: 'grant', pick: 'delegate', isGuardUp: false }))).toEqual({ kind: 'guard' })
    expect(actionLabel({ kind: 'grant' }, 'delegate', 'warning')).toBe('I understand, set it up')
    expect(actionLabel({ kind: 'start' }, 'delegate', 'grant')).toBe('start delegate')
  })

  test('one rung per chat: ⏎ stops the rung that runs when it is picked, and switches from it otherwise (decision 2)', () => {
    expect(cardAction(input({ running: 'draft' }))).toEqual({ kind: 'stop' })
    expect(cardAction(input({ step: 'grant', pick: 'delegate', running: 'delegate', allow: OUTSIDE }))).toEqual({ kind: 'stop' })
    expect(cardAction(input({ pick: 'auto', running: 'follow' }))).toEqual({ kind: 'switch', from: 'follow' })
    expect(actionLabel({ kind: 'switch', from: 'follow' }, 'auto', 'ladder')).toBe('switch to auto')
    expect(cardAction(input({ step: 'options' }))).toEqual({ kind: 'none' })
    expect(runningRung(true, null)).toBe('follow')
    expect(runningRung(true, 'auto')).toBe('auto')
    expect(runningRung(false, null)).toBeNull()
  })

  test('the card opens on the rung that runs, else the stored level where it fits, else summarize', () => {
    const person = ladderFor('person')
    expect(firstPick(person, 'follow', 'draft')).toBe('follow')
    expect(firstPick(person, null, 'auto')).toBe('auto')
    const stored: ApRung = 'draft'
    expect(firstPick(ladderFor('channel'), null, stored)).toBe('listen')
    expect(firstPick(ladderFor('group'), null, 'delegate')).toBe('listen')
  })
})
