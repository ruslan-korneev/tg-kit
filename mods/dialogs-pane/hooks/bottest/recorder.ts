// Recorder (docs/design/dialogs-pane.md §5 idea 7): the sends and presses made from
// the pane, kept as steps and exported as a shell script of `tg` calls. Pure.
//
// A replay cannot reuse message ids: they differ on every run. So a press names the
// message by where it appeared, the Nth message in an earlier step's output, and the
// script reads its id back out of that output (`#ID` starts each message line).
import type { BotStep, Recording, StepMessage, StepOutcome, StepTarget } from '../../types'
import { shellQuote } from '../packet/replay'
import type { MessageView } from '../packet/types'
import { latencyText } from './latency'

export const RECORDINGS_DIR = '.tg-recordings'

const TEXT_IN_COMMENT = 60

function stepMessage(message: MessageView): StepMessage {
  return { id: message.id, out: message.out, text: message.text, buttons: message.buttons.map(row => row.map(b => b.text)) }
}

/** What a step printed, in tg's order: what was sent, then the replies (exit 6: none came). */
export function outcomeOf(
  result: { exit: number; sent: readonly MessageView[]; replies: readonly MessageView[]; answer: string | null },
  latencyMs: number | null,
): StepOutcome {
  return {
    exit: result.exit,
    messages: [...result.sent, ...result.replies].map(stepMessage),
    answer: result.answer,
    latency_ms: latencyMs,
  }
}

/** Where `id` was last printed in this recording: the step and its 1-based position. */
export function targetOf(recording: Recording, id: number): StepTarget {
  for (let step = recording.steps.length - 1; step >= 0; step--) {
    const position = recording.steps[step]?.outcome.messages.findIndex(one => one.id === id) ?? -1
    if (position >= 0) return { id, from: { step, position: position + 1 } }
  }
  return { id, from: null }
}

export function startRecording(at: number): Recording {
  return { startedAt: at, steps: [] }
}

export function addStep(recording: Recording, step: BotStep): Recording {
  return { ...recording, steps: [...recording.steps, step] }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function stampOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** `.tg-recordings/20261010-140200-example_bot.sh`: when it started, and the first peer. */
export function scriptPath(recording: Recording): string {
  const peer = recording.steps[0]?.peer.replace(/^@/, '').replace(/[^A-Za-z0-9_-]/g, '_') ?? 'empty'
  return `${RECORDINGS_DIR}/${stampOf(recording.startedAt)}-${peer}.sh`
}

/** Comment text: one line, cut, and never able to end the comment. */
function said(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return flat.length > TEXT_IN_COMMENT ? `${flat.slice(0, TEXT_IN_COMMENT - 1)}…` : flat
}

function expectLines(outcome: StepOutcome): string[] {
  const replies = outcome.messages.filter(one => !one.out)
  const lines = replies.map(one => {
    const keyboard = one.buttons.length === 0 ? '' : `  [${one.buttons.map(row => row.join(' | ')).join(' / ')}]`
    return `#   ${said(one.text)}${keyboard}`
  })
  if (outcome.answer !== null) lines.unshift(`#   ${said(outcome.answer)}`)
  if (outcome.exit === 6) lines.push('#   (no reply within the wait: tg exits 6)')
  return lines.length === 0 ? [] : ['# expect:', ...lines]
}

/** Whole seconds: a step may be recorded before the watch has timed its reply. */
function latencyNote(outcome: StepOutcome): string {
  return outcome.latency_ms === null ? '' : ` (took ${latencyText(outcome.latency_ms, false)})`
}

/** The command for one step; `$id` holds the pressed message's id when it came from an earlier step. */
function commandOf(step: BotStep): string {
  if (step.kind === 'send') {
    const wait = `--plain --wait ${step.wait_s}s`
    // A leading dash would read as an option; stdin carries such text verbatim.
    return step.text.startsWith('-')
      ? `printf '%s' ${shellQuote(step.text)} | tg send ${shellQuote(step.peer)} - ${wait}`
      : `tg send ${shellQuote(step.peer)} ${shellQuote(step.text)} ${wait}`
  }
  const id = step.target.from === null ? String(step.target.id) : '"$id"'
  return `tg press ${shellQuote(step.peer)} ${id} --row ${step.row} --col ${step.col} --wait ${step.wait_s}s`
}

/**
 * The recording as a POSIX shell script. Each step's output is kept in `$outN` and
 * printed; a step that got no reply when recorded is allowed exit 6, any other
 * failure stops the script (`set -e`).
 */
export function toScript(recording: Recording, stoppedAt: number): string {
  const head = [
    '#!/bin/sh',
    `# Recorded in the tg-kit dialogs pane, ${new Date(recording.startedAt).toISOString()} → ${new Date(stoppedAt).toISOString()}.`,
    `# ${recording.steps.length} step${recording.steps.length === 1 ? '' : 's'}. Run: sh ${scriptPath(recording)}`,
    '# Message ids differ on every run, so a pressed message is read back from the',
    '# output of the step that printed it (the Nth line starting with #ID).',
    'set -eu',
    '',
    'nth_id() { printf \'%s\\n\' "$1" | awk -v n="$2" \'/^#[0-9]+ / { if (++i == n) { print substr($1, 2); exit } }\'; }',
  ]
  const body = recording.steps.flatMap((step, index) => {
    const n = index + 1
    const what =
      step.kind === 'send'
        ? `send ${said(step.text)}`
        : `press "${said(step.label)}" (${step.row}:${step.col}) on ${
            step.target.from === null
              ? `#${step.target.id}, a message from before the recording: its id is fixed`
              : `message ${step.target.from.position} of step ${step.target.from.step + 1}`
          }`
    const bind = step.kind === 'press' && step.target.from !== null ? [`id=$(nth_id "$out${step.target.from.step + 1}" ${step.target.from.position})`] : []
    const allowNoReply = step.outcome.exit === 6 ? ' || [ $? -eq 6 ]' : ''
    return [
      '',
      `# ${n}. ${what}${latencyNote(step.outcome)}`,
      ...expectLines(step.outcome),
      ...bind,
      `out${n}=$(${commandOf(step)})${allowNoReply}`,
      `printf '%s\\n' "$out${n}"`,
    ]
  })
  return [...head, ...body, ''].join('\n')
}
