// dialogs-pane-guard: the grant and the hard stops of a dialogs-pane delegate
// Worker (docs/design/dialogs-pane.md §6 "delegate").
//
// Why a plugin of its own: every event of a loop a plugin spawned runs under
// that plugin's frame, and the engine runs no hook of a plugin under its own
// frame (re-entry; the .catch is asked instead, with `$` refused). Measured
// live on 2.1.296: dialogs-pane's own tool.call hook never saw its Worker's
// calls, and a `git push` reached the remote. This plugin did not spawn the
// Worker, so its tool.call hook runs on every one of the Worker's calls.
//
// It reads dialogs-pane's `delegate` (tasks, grants, skips) and writes only
// its own values: `armed` (the handshake: dialogs-pane starts a Worker only
// once its task is named here, and stops every Worker when this goes silent),
// `work` (steps), `holds` and `events` (hard stops), which dialogs-pane draws.
// A hard stop waits in the engine's dialog ($.ui.ask: a `$` call, so the wait
// is not billed to the hook's 10 s budget) and runs only on "Yes"; anything
// else, a stopped task or a passed deadline is "no". Fail closed: a call of a
// subagent this guard could not place is refused when the hook fails.
import { atom, update } from 'claude-code'
import type { EngineInterface, Next, Register, ToolCallInput, ToolCallResult } from 'claude-code'
import type { Delegate, DgTask } from 'dialogs-pane'

import type { GuardArmedValue, GuardEventValue, GuardHoldValue, GuardWorkValue } from '../types'
import { checkGrant, type Scope } from './delegate/grant'
import { resolvePath } from './delegate/paths'
import { skippedStops } from './delegate/skip'
import { callHits, partition, stopQuestion, type StopHit, type ToolUse } from './delegate/stops'
import { addStep, isLive, stepOf } from './delegate/task'

type $ = EngineInterface

const PLUGIN = 'dialogs-pane-guard'
const WORKER_PREFIX = 'dialogs-pane:worker-'
/** dialogs-pane reads a guard silent for 30 s as gone; this beats well inside that. */
const HEARTBEAT_MS = 10_000
const EVENTS_MAX = 200
/** The dialog lists No first, so a stray Enter is a no (seen live: an Enter meant for the prompt took the first option). */
const ASK_YES = 'Yes, allow it'
const ASK_NO = 'No'

const armed = atom({ plugin: 'dialogs-pane-guard', key: 'armed' } as const, { at: 0, taskIds: [] })
const work = atom({ plugin: 'dialogs-pane-guard', key: 'work' } as const, [])
const holds = atom({ plugin: 'dialogs-pane-guard', key: 'holds' } as const, [])
const events = atom({ plugin: 'dialogs-pane-guard', key: 'events' } as const, [])

// Module state: a reload starts these over; the tasks are dialogs-pane's.
let home = '/'
/** tg-kit's config directory, where dialogs-pane puts the worktrees; the Worker never reaches the rest of it. */
let configDir = '/.config/tg-kit'
let holdSeq = 0
/** Subagents placed: a Worker's agent id → its task id; and the ones that are no Worker. */
const workers = new Map<string, number>()
const notWorkers = new Set<string>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? '/'
    // The same root dialogs-pane's worktrees are made under.
    configDir = resolvePath((await $.env.get('TG_KIT_CONFIG_DIR')) ?? `${home}/.config/tg-kit`, '/', home)
    await beat($)
    $.clock.every(HEARTBEAT_MS, () => {
      beat($).catch(() => {
        // A missed beat is made up by the next; dialogs-pane waits three.
      })
    })
    return started
  })

  // The handshake: every write of dialogs-pane's tasks is answered with the ids guarded now.
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    if (e.plugin === 'dialogs-pane' && e.key === 'delegate') await arm($, delegateOf(e.value))
    return done
  }).catch(($, e, next) => next(e)) // A missed answer only delays a start: dialogs-pane refuses to spawn without it.

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || notWorkers.has(e.agentId)) return next(e)
    const state = (await $.state.get({ plugin: 'dialogs-pane', key: 'delegate' })).value
    const task = await taskOf($, e.agentId, state?.tasks ?? [])
    if (task === null) return next(e)
    return guard($, task, state ?? null, e, next)
  }).catch(($, e, next) => {
    // Fail closed: a subagent's call this guard did not clear is refused.
    if (next.called) return next(e)
    return e.agentId === undefined || notWorkers.has(e.agentId) ? next(e) : { deny: `The ${PLUGIN} hook failed, so this call is refused.` }
  })
}

/** dialogs-pane's `delegate` value as the state.set event carries it (typed by its contract). */
function delegateOf(value: unknown): Delegate | null {
  // The event's value is the declared type for this pair; a missing or foreign shape guards nothing.
  return typeof value === 'object' && value !== null && 'tasks' in value && Array.isArray(value.tasks) ? (value as Delegate) : null
}

async function beat($: $): Promise<void> {
  await arm($, (await $.state.get({ plugin: 'dialogs-pane', key: 'delegate' })).value ?? null)
}

async function arm($: $, state: Delegate | null): Promise<void> {
  const at = await $.clock.now()
  const value: GuardArmedValue = { at, taskIds: (state?.tasks ?? []).filter(isLive).map(task => task.id) }
  await update($, armed, () => value)
}

/** The task a subagent works for: by its recorded agentId, or by its Worker type while the spawn is still answering. */
async function taskOf($: $, agentId: string, tasks: readonly DgTask[]): Promise<DgTask | null> {
  const known = tasks.find(task => task.agentId === agentId) ?? tasks.find(task => task.id === workers.get(agentId))
  if (known !== undefined) {
    workers.set(agentId, known.id)
    return known
  }
  const info = (await $.agent.list()).find(one => one.id === agentId)
  if (info === undefined || !info.type.startsWith(WORKER_PREFIX)) {
    notWorkers.add(agentId)
    return null
  }
  const taskId = Number(info.type.slice(WORKER_PREFIX.length))
  workers.set(agentId, taskId)
  // A Worker type with no task (its card dismissed, a reload) is refused as over.
  return tasks.find(task => task.id === taskId) ?? gone(taskId)
}

function gone(taskId: number): DgTask {
  return {
    id: taskId,
    peer: { id: 0, arg: '', label: '', kind: 'unknown' },
    summary: '',
    agentId: null,
    startedAt: 0,
    deadline: null,
    grant: { web: 'off', repos: [], commands: 'checks', duration: { kind: 'done' } },
    worktrees: [],
    holds: [],
    question: null,
    chat: null,
    status: 'stopped',
    reason: 'its task is gone',
  }
}

async function setWork($: $, taskId: number, change: (one: GuardWorkValue) => GuardWorkValue): Promise<void> {
  await update($, work, value => {
    const current = value.find(one => one.taskId === taskId) ?? { taskId, steps: [], current: null }
    return [...value.filter(one => one.taskId !== taskId), change(current)]
  })
}

async function logStop($: $, task: DgTask, hits: readonly StopHit[], answer: GuardEventValue['answer'], why: string): Promise<void> {
  if (hits.length === 0) return
  const at = await $.clock.now()
  await update($, events, value => {
    const seq = value.reduce((top, one) => Math.max(top, one.seq), 0) + 1
    const event: GuardEventValue = { seq, at, taskId: task.id, peer: task.peer, summary: task.summary, stops: hits.map(hit => hit.stop), what: hits.map(hit => hit.what).join('; '), answer, why }
    return [...value, event].slice(-EVENTS_MAX)
  })
}

/** Asks you in the engine's dialog and waits; anything but "Yes" (No, free text, a dismissal, `-p`) is no. */
async function ask($: $, task: DgTask, hits: readonly StopHit[]): Promise<{ yes: boolean; why: string }> {
  holdSeq += 1
  const hold: GuardHoldValue = { id: holdSeq, taskId: task.id, stops: hits.map(hit => hit.stop), what: hits.map(hit => hit.what).join('; '), since: await $.clock.now() }
  await update($, holds, value => [...value, hold])
  let answer: string
  try {
    answer = await $.ui.ask(stopQuestion(hits, `Worker for ${task.peer.label}`), { options: [ASK_NO, ASK_YES], header: 'HARD STOP' })
  } catch (error) {
    answer = `(no answer: ${error instanceof Error ? error.message : String(error)})`
  } finally {
    await update($, holds, value => value.filter(one => one.id !== hold.id))
  }
  // Stopped, finished or past its deadline while it waited: no, whatever was answered.
  const now = (await $.state.get({ plugin: 'dialogs-pane', key: 'delegate' })).value?.tasks.find(one => one.id === task.id)
  if (now === undefined || !isLive(now)) return { yes: false, why: `the task was ${now?.status ?? 'removed'} while it waited` }
  if (now.deadline !== null && now.deadline <= (await $.clock.now())) return { yes: false, why: 'the deadline passed while it waited' }
  return answer === ASK_YES ? { yes: true, why: 'you' } : { yes: false, why: answer === ASK_NO ? 'you' : answer }
}

/**
 * One tool call of a Worker: refused once the task is over or outside the
 * grant; held in the engine's dialog when it meets a hard stop that is not
 * skipped; then run, and its step written for the task card.
 */
async function guard($: $, task: DgTask, state: Delegate | null, e: ToolCallInput, next: Next<'tool.call'>): Promise<ToolCallResult> {
  if (!isLive(task)) return { deny: `This task is ${task.status} (${task.reason}). Stop here; end your turn.` }
  const at = await $.clock.now()
  if (task.deadline !== null && task.deadline <= at) return { deny: 'The task deadline passed. Stop here; end your turn.' }
  const use: ToolUse = { tool: e.tool, input: e }
  const scope: Scope = {
    worktrees: task.worktrees.map(tree => tree.path),
    home,
    checkouts: task.worktrees.flatMap(tree => (tree.repo === '' ? [] : [tree.repo])),
    checks: task.worktrees.flatMap(tree => tree.checks),
    configDir,
  }
  const step = stepOf(use, task.worktrees, home)
  const granted = checkGrant(use, task.grant, scope)
  if (!granted.ok) {
    await setWork($, task.id, one => ({ ...one, steps: addStep(one.steps, `refused: ${step}`, 'failed') }))
    return { deny: granted.reason }
  }
  const skipped = skippedStops({ always: state?.alwaysSkip ?? [], session: state?.sessionSkip ?? [], dialog: state?.dialogs[String(task.peer.id)]?.skip ?? null, now: at })
  const split = partition(callHits(use, scope), skipped)
  await logStop($, task, split.skipped, 'skipped', 'dangerouslySkipHardStops')
  if (split.ask.length > 0) {
    const answer = await ask($, task, split.ask)
    await logStop($, task, split.ask, answer.yes ? 'yes' : 'no', answer.why)
    if (!answer.yes) {
      await setWork($, task.id, one => ({ ...one, steps: addStep(one.steps, `held: ${step}`, 'failed') }))
      return {
        deny: `Hard stop ${split.ask.map(hit => hit.stop).join(' + ')}: the owner did not allow it (${answer.why}). Do not look for another way to do it: go on without it, or end your turn with "FAIL: <why>".`,
      }
    }
  }
  await setWork($, task.id, one => ({ ...one, current: step }))
  const result = await next(e)
  const isFailed = result.deny !== undefined || result.isError === true
  await setWork($, task.id, one => ({ ...one, current: null, steps: addStep(one.steps, step, isFailed ? 'failed' : 'done') }))
  return result
}
