import { expect, test } from 'claude-code/testing'

import { INTENT_IDS, INTENTS, intentLine } from './intents'

test('every intent has a label; templates name packet elements, never chat text', () => {
  for (const id of INTENT_IDS) expect(INTENTS[id].label.length).toBeGreaterThan(0)
  expect(intentLine({ id: 'fix' })).toMatch(/^Intent: Fix — find the handler/)
  expect(intentLine({ id: 'reproduce' })).toContain('<replay>')
  expect(intentLine({ id: 'test' })).toContain('callback data')
  expect(intentLine({ id: 'draft_reply' })).toContain('Do not send it')
  expect(intentLine({ id: 'explain' })).toMatch(/^Intent: Explain — /)
})

test('raw is the user\'s own instruction, trimmed', () => {
  expect(intentLine({ id: 'raw', text: '  check the copy \n' })).toBe('check the copy')
})
