import { describe, expect, test } from 'claude-code/testing'

import type { BotStep, PeerRef } from '../../types'
import { msg, REPLY, SENT } from '../packet/fixtures'
import { addStep, outcomeOf, scriptPath, startRecording, targetOf, toScript } from './recorder'

const START = Date.parse('2026-10-10T14:00:00Z')
const PEER: PeerRef = { id: 1001, arg: '@example_bot', label: '@example_bot', kind: 'bot' }
const send: BotStep = {
  kind: 'send',
  peer: '@example_bot',
  text: '/settings',
  wait_s: 10,
  at: START + 1000,
  outcome: outcomeOf({ exit: 0, sent: [SENT], replies: [REPLY], answer: null }, 1400),
}

describe('targetOf', () => {
  test('a message an earlier step printed is found by step and position', () => {
    const recording = addStep(startRecording(START, PEER), send)
    expect(targetOf(recording, REPLY.id)).toEqual({ id: REPLY.id, from: { step: 0, position: 2 } })
    expect(targetOf(recording, 5)).toEqual({ id: 5, from: null })
  })
})

test('the script replays send, then press on the reply read back from the output', () => {
  const recording = addStep(startRecording(START, PEER), send)
  const press: BotStep = {
    kind: 'press',
    peer: '@example_bot',
    target: targetOf(recording, REPLY.id),
    row: 0,
    col: 0,
    label: 'Retry',
    wait_s: 5,
    at: START + 5000,
    outcome: outcomeOf({ exit: 6, sent: [], replies: [], answer: null }, null),
  }
  const script = toScript(addStep(recording, press), START + 9000)
  expect(script).toContain('set -eu')
  expect(script).toContain('# 1. send /settings (took 1s)')
  expect(script).toContain('#   ⚠ Something went wrong  [Retry | Back]')
  expect(script).toContain('out1=$(tg send @example_bot /settings --plain --wait 10s)')
  expect(script).toContain('# 2. press "Retry" (0:0) on message 2 of step 1')
  expect(script).toContain('id=$(nth_id "$out1" 2)')
  expect(script).toContain('out2=$(tg press @example_bot "$id" --row 0 --col 0 --wait 5s) || [ $? -eq 6 ]')
})

test('quoting: spaces, quotes and a leading dash', () => {
  const step = (text: string): BotStep => ({ ...send, text, outcome: outcomeOf({ exit: 0, sent: [], replies: [], answer: null }, null) })
  const script = toScript(addStep(addStep(startRecording(START, PEER), step("it's on")), step('-5')), START)
  expect(script).toContain("tg send @example_bot 'it'\\''s on' --plain --wait 10s")
  expect(script).toContain("printf '%s' -5 | tg send @example_bot - --plain --wait 10s")
})

test('a press on a message from before the recording keeps its id and says so', () => {
  const press: BotStep = {
    kind: 'press',
    peer: '@example_bot',
    target: { id: 677700, from: null },
    row: 1,
    col: 0,
    label: 'Help',
    wait_s: 5,
    at: START,
    outcome: outcomeOf({ exit: 0, sent: [], replies: [msg({ id: 677801, text: 'Help text' })], answer: null }, null),
  }
  const script = toScript(addStep(startRecording(START, PEER), press), START)
  expect(script).toContain('#677700, a message from before the recording: its id is fixed')
  expect(script).toContain('out1=$(tg press @example_bot 677700 --row 1 --col 0 --wait 5s)')
})

test('scriptPath: start time and first peer under .tg-recordings', () => {
  expect(scriptPath(addStep(startRecording(START, PEER), send))).toMatch(/^\.tg-recordings\/20261010-\d{6}-example_bot\.sh$/)
})
