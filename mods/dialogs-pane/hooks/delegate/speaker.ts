// The Speaker of a delegate dialog: the autopilot's Speaker (one model call, no
// tools, a JSON answer) with task actions. start_task hands work to a Worker,
// forward passes the chat's answer (or more of the task) to it, and the relay
// prompt phrases the Worker's question or result for the chat. The Speaker
// still never touches a tool; the Worker never writes to Telegram. Pure.
import type { ApDialog, DgTask } from '../../types'
import { escapeText } from '../packet/build'
import { jsonObject, parseSpoken, speakerSystem, type Spoken } from '../autopilot/speaker'
import type { WorkerSaid } from './task'

/** What the Speaker asked of the task, beside its chat text. */
export type TaskAction = { kind: 'start'; summary: string } | { kind: 'forward'; text: string }

export type DelegateSpoken = { spoken: Spoken; task: TaskAction | null }

const RULES = [
  '',
  'This dialog is DELEGATED: besides answering, you can hand work to a Worker, an agent with tools (the granted repos, the web)',
  'that never writes in the chat. Two more actions:',
  '- "start_task": the messages ask the owner for work the Worker can do (code, docs, research). "task": the task for the',
  '  Worker in plain words, with the links and details from the chat. "text": a short ack for the chat ("on it"), or "".',
  '- "forward": a task is running and the messages answer its question or add to it. "task": what to pass on. "text": a short',
  '  ack, or "".',
  'Only what the chat plainly asks for goes into "task". Money, publishing, sharing files and deadlines are the owner\'s',
  'to decide: never promise them in "text".',
]

/** The autopilot Speaker's rules and brief, with the delegate actions. */
export function delegateSystem(dialog: ApDialog): string {
  return [speakerSystem(dialog), ...RULES].join('\n')
}

/** What the reply prompt adds: the running task, if any, so the Speaker can forward answers to it. */
export function taskContext(task: DgTask | null): string {
  if (task === null) return '<task status="none"/>'
  const question = task.question === null ? '' : `<question>${escapeText(task.question)}</question>`
  return `<task status="${task.status}"><summary>${escapeText(task.summary)}</summary>${question}</task>`
}

export function delegateInstructions(task: DgTask | null): string {
  return [
    taskContext(task),
    'The answer JSON has one more field for the delegate actions: {"action": "...", "text": "...", "task": "...", "confidence": 0.0, "topics": [], "reason": "..."}',
    task === null || task.status === 'done' || task.status === 'failed' || task.status === 'stopped'
      ? 'No task is running: "forward" is not available.'
      : 'A task is running: use "forward" for answers to its question; a new, different request is "escalate".',
  ].join('\n')
}

/** The Speaker's answer with the task actions; null when it is not one. */
export function parseDelegate(reply: string): DelegateSpoken | null {
  const data = jsonObject(reply)
  if (data === null) return null
  const task = typeof data.task === 'string' ? data.task.trim() : ''
  if (data.action === 'start_task' || data.action === 'forward') {
    if (task === '') return null
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    // The ack goes out as a reply would; an empty one sends nothing.
    const spoken = parseSpoken(JSON.stringify({ ...data, action: text === '' ? 'none' : 'reply', text }))
    if (spoken === null) return null
    return { spoken, task: data.action === 'start_task' ? { kind: 'start', summary: task.slice(0, 2000) } : { kind: 'forward', text: task.slice(0, 4000) } }
  }
  const spoken = parseSpoken(reply)
  return spoken === null ? null : { spoken, task: null }
}

/** Phrases the Worker's question, result or failure for the chat. */
export function relayPrompt(input: { said: WorkerSaid; task: DgTask; packet: string }): string {
  const what = { ask: 'needs to ask the chat', done: 'finished; tell the chat the result', fail: 'could not finish' }[input.said.kind]
  return [
    input.packet,
    `<task><summary>${escapeText(input.task.summary)}</summary></task>`,
    `<worker kind="${input.said.kind}">${escapeText(input.said.text)}</worker>`,
    '',
    `The Worker ${what}. Write the owner's message to the chat about it, as the owner, short and in the chat's language.`,
    'Nothing about a Worker, an agent or AI. Keep links, branch names and commands as the Worker wrote them.',
    'Reply with one JSON object and nothing else: {"action": "reply" | "draft" | "escalate", "text": "...", "confidence": 0.0, "topics": [], "reason": "..."}',
  ].join('\n')
}
