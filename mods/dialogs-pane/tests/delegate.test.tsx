// delegate through the engine, dialogs-pane's half: level 4 in the card and its
// warning, the handshake with the guard plugin, the task (worktree, Worker type,
// spawn), what the guard reports drawn on the card, the band, the status line and
// the ledger, the Speaker's outgoing check, dangerouslySkipHardStops in its three
// scopes, the relay of ASK and the forward of the answer, the kill switch, the
// deadline and the cross-session lease. The guard's own half (grant, holds) is
// tested in mods/dialogs-pane-guard; here an inline plugin of its name answers
// the handshake and writes what the real one would. tg, git, the model and the
// dialog are answered by hooks beneath the plugins; nothing real runs.
import type { ModelCompleteInput, ModelCompleteResult, On, ProcessRunResult, RenderPropsOf, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test, type Engine, type MockClock, type Plugin } from 'claude-code/testing'

import type { TgMessage } from '../types'
import { DIALOGS } from './fixtures'

const PLUGIN = 'dialogs-pane'
const NOW = Date.parse('2026-10-10T12:00:00Z')
const GROUP = 1002
const HOME = '/home/me'
const REPO = `${HOME}/code/app`
const WT = `${HOME}/.config/tg-kit/worktrees/app-task-1`
const WORKER = 'agent-worker-1'

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

const run = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
const json = (value: unknown) => run(0, JSON.stringify(value))
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answer = (value: unknown): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })

const alice = { id: 2001, kind: 'user', username: null, name: 'Contact A' } as const
const me = { id: 1003, kind: 'self', username: null, name: 'Me' } as const

function message(id: number, text: string, over: Partial<TgMessage> = {}): TgMessage {
  return {
    id,
    chat_id: GROUP,
    date: '2026-10-10T12:00:00Z',
    sender: over.out === true ? me : alice,
    out: false,
    text,
    reply_to: null,
    forward: null,
    edited: null,
    edits: 0,
    pinned: false,
    service: null,
    via_bot: null,
    media: null,
    keyboard: null,
    buttons: [],
    reactions: [],
    links: [],
    ...over,
  }
}

type Child = { argv: readonly string[]; line: (value: unknown) => void; isKilled: boolean }
type Ran = { argv: readonly string[]; stdin?: string }
/** What the engine's dialog answers: a label, or a dismissal. */
type Dialog = 'Yes, allow it' | 'No' | 'dismiss'

type World = {
  runs: Ran[]
  children: Child[]
  asked: ModelCompleteInput[]
  status: (string | undefined)[]
  toasts: string[]
  store: Map<string, unknown>
  history: TgMessage[]
  registered: { name: string; tools?: readonly string[]; prompt: string }[]
  spawned: Record<string, unknown>[]
  sent: { to: unknown; text: string }[]
  /** Questions the engine's dialog was asked, and what it answers next. */
  questions: string[]
  dialog: Dialog
  /** Worker tool calls that reached the tool beneath every hook. */
  ran: string[]
  stopped: string[]
}

const START_TASK = { action: 'start_task', text: 'on it', task: 'add a /health endpoint', confidence: 0.95, topics: [], reason: 'work request' }

function world(
  on: On,
  options: {
    model?: (e: ModelCompleteInput, seen: World) => ModelCompleteResult
    allow?: number[]
    session?: string
    /** Runs while the engine's dialog is up, before it is answered. */
    whileAsked?: () => Promise<void>
  } = {},
): World {
  const seen: World = {
    runs: [],
    children: [],
    asked: [],
    status: [],
    toasts: [],
    store: new Map(),
    history: [message(498, 'can you add a health check?')],
    registered: [],
    spawned: [],
    sent: [],
    questions: [],
    dialog: 'Yes, allow it',
    ran: [],
    stopped: [],
  }
  let nextSent = 900
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: options.session ?? 'session-a' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === `${WT}/pyproject.toml` || e.path === `${WT}/uv.lock` }))
  on('fs.read', () => ({ value: '[project]\nname = "app"\n' }))
  on('process.run', (_$, e) => {
    const ran: Ran = { argv: e.argv, stdin: e.init?.stdin }
    seen.runs.push(ran)
    const [tool, cmd] = e.argv
    if (tool === 'git') return { value: e.argv.includes('rev-parse') ? run(0, `${REPO}\n`) : run(0, '') }
    if (tool === 'mkdir') return { value: run(0, '') }
    if (cmd === 'dialogs') return { value: json(DIALOGS) }
    if (cmd === 'read') return { value: json(seen.history) }
    if (cmd === 'allow') return { value: json((options.allow ?? [GROUP]).map(id => ({ id }))) }
    if (cmd === 'send') {
      const sent = message(nextSent++, ran.stdin ?? '', { out: true })
      seen.history.push(sent)
      return { value: json({ sent: [sent], replies: [] }) }
    }
    return { value: run(1, '', `error: unexpected ${e.argv.join(' ')}`) }
  })
  on('process.spawn', async function* (_$, e, next) {
    const queue: string[] = []
    let wake: () => void = () => undefined
    const child: Child = {
      argv: e.argv,
      isKilled: false,
      line: value => {
        queue.push(`${JSON.stringify(value)}\n`)
        wake()
      },
    }
    seen.children.push(child)
    next.signal.addEventListener('abort', () => {
      child.isKilled = true
      wake()
    })
    for (;;) {
      while (queue.length === 0 && !child.isKilled) await new Promise<void>(resolve => (wake = resolve))
      const text = queue.shift()
      if (child.isKilled || text === undefined) return { value: { code: null, signal: 'SIGTERM' } }
      yield { stream: 'stdout' as const, text }
    }
  })
  on('model.complete', (_$, e) => {
    seen.asked.push(e)
    return { value: options.model?.(e, seen) ?? answer(START_TASK) }
  })
  on('agent.register', (_$, e) => {
    seen.registered.push({ name: e.name, tools: e.tools, prompt: e.prompt })
    return { value: { agent: `${PLUGIN}:${e.name}` } }
  })
  on('agent.spawn', (_$, e) => {
    // Beneath a test the spawn arrives as the Agent tool's input (`subagent_type`, `run_in_background`).
    seen.spawned.push({ ...e })
    return { model: 'claude-sonnet-5-5' }
  })
  // Core sets the spawn's agentId; beneath a test the session's list names the Worker by its type.
  on('agent.list', () => ({ value: seen.spawned.map(e => ({ id: WORKER, description: String(e.description), type: String(e.subagent_type), status: 'running' as const })) }))
  on('session.send', (_$, e) => {
    seen.sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  // The engine's dialog: what the person answers.
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    await options.whileAsked?.()
    const question = e.tool === 'AskUserQuestion' ? (e.questions[0]?.question ?? '') : ''
    seen.questions.push(question)
    if (seen.dialog === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: [], answers: { [question]: seen.dialog } } as never }
  })
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    seen.stopped.push(e.tool === 'TaskStop' ? (e.task_id ?? '') : '')
    return { result: { message: 'stopped', task_id: '', task_type: 'agent' } as never }
  })
  // The Worker's tools themselves: they record what ran.
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.ran.push(e.tool === 'Bash' ? e.command : '')
    return { result: { stdout: 'ok', stderr: '', interrupted: false } as never }
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    seen.ran.push(e.tool)
    return { result: {} as never }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

/**
 * The guard plugin's stand-in, an inline plugin of its name (its module is
 * shipped on its own, so everything it uses is inside `register`). Modes, set
 * with `/fake-guard {"mode": …}`: `on` answers the handshake on every
 * `delegate` write and beats every 10 s; `beats` only beats (it never names a
 * task); `silent` stops beating. `/fake-guard {"key": …, "value": …}` writes
 * what the real guard writes (steps, holds, stop events).
 */
const fakeGuard: Plugin = {
  name: 'dialogs-pane-guard',
  register: on => {
    let mode = 'on'
    let taskIds: number[] = []
    on('session.start', async ($, e, next) => {
      const done = await next(e)
      await $.state.set({ plugin: 'dialogs-pane-guard', key: 'armed' } as never, { at: await $.clock.now(), taskIds } as never)
      $.clock.every(10_000, () => {
        if (mode === 'silent') return
        $.clock
          .now()
          .then(at => $.state.set({ plugin: 'dialogs-pane-guard', key: 'armed' } as never, { at, taskIds } as never))
          .catch(() => undefined)
      })
      return done
    })
    on('state.set', async ($, e, next) => {
      const done = await next(e)
      if (mode !== 'on' || e.plugin !== 'dialogs-pane' || e.key !== 'delegate') return done
      const value: unknown = e.value
      const tasks = typeof value === 'object' && value !== null && 'tasks' in value && Array.isArray(value.tasks) ? value.tasks : []
      taskIds = tasks.flatMap((task: unknown) =>
        typeof task === 'object' && task !== null && 'id' in task && 'status' in task && typeof task.id === 'number' && ['starting', 'working', 'asking'].includes(String(task.status)) ? [task.id] : [],
      )
      await $.state.set({ plugin: 'dialogs-pane-guard', key: 'armed' } as never, { at: await $.clock.now(), taskIds } as never)
      return done
    })
    on('command.run', { command: 'fake-guard' }, async ($, e) => {
      const asked: unknown = JSON.parse(e.args)
      if (typeof asked !== 'object' || asked === null) return { text: 'bad' }
      if ('mode' in asked && typeof asked.mode === 'string') mode = asked.mode
      if ('key' in asked && 'value' in asked) {
        if (asked.key === 'work') await $.state.set({ plugin: 'dialogs-pane-guard', key: 'work' } as never, asked.value as never)
        if (asked.key === 'holds') await $.state.set({ plugin: 'dialogs-pane-guard', key: 'holds' } as never, asked.value as never)
        if (asked.key === 'events') await $.state.set({ plugin: 'dialogs-pane-guard', key: 'events' } as never, asked.value as never)
      }
      return { text: 'ok' }
    })
  },
}

const fakeGuardRun = (args: unknown) => ({ command: 'fake-guard', args: JSON.stringify(args), origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as never
/** Writes one of the guard's values, as the real guard would. */
const report = ($: Engine, key: 'work' | 'holds' | 'events', value: unknown) => $.command.run(fakeGuardRun({ key, value }))
const guardMode = ($: Engine, mode: 'on' | 'beats' | 'silent') => $.command.run(fakeGuardRun({ mode }))

const WITH_GUARD = { plugins: [fakeGuard] }

const tgCommand = (args: string) => ({ command: 'tg', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

/** /tg wide, Dev Team's card, 4 twice (the warning, then the level), the repo, ⏎ start. */
async function handOver($: Engine, clock: MockClock, seen: World) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(tgCommand('wide'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
  await ui.press({ key: 'key:down' })
  await ui.press({ key: 'key:agent' })
  await clock.settle()
  await ui.press({ key: 'ap:level:delegate' })
  await ui.press({ key: 'ap:level:delegate' })
  await ui.input({ key: 'dg:repos', text: REPO })
  await ui.press({ key: 'key:start' })
  await clock.settle()
  const child = seen.children.at(-1)
  child?.line({ event: 'ready', date: '2026-10-10T12:00:00Z', peers: [] })
  await clock.settle()
  return { ui, child }
}

/** A burst asks for work; the Speaker starts a task; the Worker is spawned. */
async function startTask($: Engine, clock: MockClock, seen: World) {
  const handed = await handOver($, clock, seen)
  handed.child?.line({ event: 'message', ...message(500, 'please add a /health endpoint to the app') })
  await clock.advance(20_000)
  await clock.settle()
  return handed
}

const worker = async ($: Engine, command: string): Promise<ToolCallResult> =>
  // agentId rides along as the Worker's loop carries it.
  $.tool.call({ tool: 'Bash', command, agentId: WORKER } as never)

const sends = (seen: World) => seen.runs.filter(one => one.argv[1] === 'send').map(one => one.stdin)

describe('the card', () => {
  test('delegate is offered only for a dialog in allow.toml', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on, { allow: [] })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand('wide'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    expect(await ui.find({ key: 'ap:level:auto' })).toBeDefined()
    expect(await ui.find({ key: 'ap:level:delegate' })).toBeUndefined()
    await ui.unmount()
  })

  test('the first 4 shows the warning once; the next hands it over; the grant rows and the guard row show', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand('wide'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    await ui.press({ key: 'ap:level:delegate' })
    expect(await ui.find({ type: 'Text', text: /whoever writes in Dev Team steers an agent that has tools/ })).toBeDefined()
    expect(await ui.find({ key: 'dg:web' })).toBeUndefined()
    await ui.press({ key: 'ap:level:delegate' })
    expect((await ui.find({ key: 'ap:level:delegate' }))?.text).toBe('[⚡ delegate]')
    expect(await ui.find({ type: 'Text', text: '✓ dialogs-pane-guard answering' })).toBeDefined()
    expect((await ui.find({ key: 'dg:web' }))?.text).toBe('read-only')
    await ui.press({ key: 'dg:web' })
    expect((await ui.find({ key: 'dg:web' }))?.text).toBe('full')
    expect((await ui.find({ key: 'dg:commands' }))?.text).toBe("the repos' checks")
    expect(seen.store.get('delegate.dialogs')).toMatchObject({ [String(GROUP)]: { isWarned: true, grant: { web: 'full' } } })
    await ui.unmount()
  })
})

describe('the handshake with the guard plugin', () => {
  test('without the guard loaded, delegate does not start, and the card says why', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand('wide'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    await ui.press({ key: 'ap:level:delegate' })
    await ui.press({ key: 'ap:level:delegate' })
    expect(await ui.find({ type: 'Text', text: /✗ delegate needs the dialogs-pane-guard plugin loaded and answering/ })).toBeDefined()
    await ui.press({ key: 'key:start' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /Not started: delegate needs the dialogs-pane-guard plugin/ })).toBeDefined()
    expect(seen.children).toHaveLength(0)
    await ui.unmount()
  })

  test('a guard that beats but does not name the task: the task fails before any Worker is spawned', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await guardMode($, 'beats')
    await startTask($, clock, seen)
    expect(seen.spawned).toEqual([])
    expect(seen.toasts.at(-1)).toContain('the dialogs-pane-guard plugin is not loaded or did not answer for this task')
  })

  test('a guard gone silent stops every Worker; the Worker’s next call is refused here too', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await startTask($, clock, seen)
    expect((await worker($, 'uv run pytest')).deny).toBeUndefined()
    await guardMode($, 'silent')
    await clock.advance(60_000)
    await clock.settle()
    expect(seen.stopped).toEqual([WORKER])
    expect(seen.toasts).toContain('tg: ⚡ every Worker stopped: the dialogs-pane-guard plugin stopped answering.')
    expect((await worker($, 'uv run pytest')).deny).toContain('This task is over')
  })
})

describe('a task', () => {
  test('start_task: the ack goes out, a worktree of the repo, a Worker type with the granted tools, the spawn in the worktree', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    expect(seen.asked[0]?.system).toContain('This dialog is DELEGATED')
    expect(sends(seen)).toEqual(['on it'])
    expect(seen.runs.filter(one => one.argv[0] === 'git').map(one => one.argv.join(' '))).toEqual([
      `git -C ${REPO} rev-parse --show-toplevel`,
      `git -C ${REPO} worktree add -b tg/add-a-health-endpoint-1 ${WT} HEAD`,
    ])
    expect(seen.registered).toEqual([{ name: 'worker-1', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite', 'WebFetch', 'WebSearch'], prompt: expect.stringContaining(`${WT} (branch tg/add-a-health-endpoint-1, from ${REPO})`) }])
    expect(seen.registered[0]?.prompt).toContain('uv run pytest')
    expect(seen.spawned[0]).toMatchObject({ subagent_type: 'dialogs-pane:worker-1', cwd: WT, prompt: expect.stringContaining('Task: add a /health endpoint') })
    expect(String(seen.spawned[0]?.prompt)).toContain('<tg-packet')
    // The task's card sits on top of its chat's thread (T4), not on top of the pane.
    expect(await ui.find({ key: 'dg:task:1' })).toBeUndefined()
    await ui.press({ key: 'dialog:1002' })
    expect(await ui.find({ type: 'Text', text: '✓ worktree app-task-1 · branch tg/add-a-health-endpoint-1' })).toBeDefined()
    expect(seen.status.at(-1)).toContain('⚡ 1 task')
    await ui.unmount()
  })

  test("the guard's steps, hold and stop events show on the card, the band, the status line and the ledger", WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    await report($, 'work', [{ taskId: 1, steps: [{ text: 'read the code', count: 3, state: 'done' }], current: 'ran uv run pytest' }])
    await report($, 'holds', [{ id: 1, taskId: 1, stops: ['publish'], what: 'git push origin tg/x', since: NOW }])
    await report($, 'events', [{ seq: 1, at: NOW + 1, taskId: 1, peer: { id: GROUP, arg: '1002', label: 'Dev Team', kind: 'supergroup' }, summary: 'add a /health endpoint', stops: ['publish'], what: 'git push origin tg/y', answer: 'skipped', why: 'dangerouslySkipHardStops' }])
    await clock.settle()
    await ui.press({ key: 'dialog:1002' })
    expect(await ui.find({ type: 'Text', text: '✓ read the code (3)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '… ran uv run pytest' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⏸ HARD STOP publish: git push origin tg/x? (answer in the dialog)' })).toBeDefined()
    expect(seen.status.at(-1)).toBe('tg ⏸ HARD STOP publish: git push origin tg/x · ⚡ Dev Team · answer in the dialog')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ type: 'Text', text: /⏸ HARD STOP/ }))?.text).toBe('⏸ HARD STOP publish: git push origin tg/x? (answer in the dialog)')
    await band.unmount()
    await ui.press({ key: 'key:activity' })
    expect(await ui.find({ type: 'Text', text: /^ {2}\d\d:\d\d ⚡ Dev Team · skipped stop: publish git push origin tg\/y$/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('dangerouslySkipHardStops', () => {
  test('per session: the stops named are skipped for the guard, and the row and the status line show it in red', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    expect((await $.command.run(tgCommand('autopilot --dangerously-skip-hard-stops=publish'))).text).toContain('⚠ hard stops skipped until this session ends: publish')
    expect((await ui.find({ key: 'dialog:1002' }))?.text).toContain('⚠ no stops: publish')
    expect(seen.status.at(-1)).toContain('⚠ no stops: publish')
    expect((await $.command.run(tgCommand('autopilot --dangerously-skip-hard-stops=none'))).text).toBe('tg autopilot: hard stops are on again for this session.')
    expect((await ui.find({ key: 'dialog:1002' }))?.text).not.toContain('⚠')
    await ui.unmount()
  })

  test('per dialog: confirmed only by typing the dialog name; 24 h by default', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await handOver($, clock, seen)
    await ui.press({ key: 'key:agent' })
    await ui.input({ key: 'dg:skip', text: 'all' })
    await ui.input({ key: 'dg:confirm', text: 'dev team' })
    expect(await ui.find({ type: 'Text', text: /Not confirmed: type the dialog's name exactly, "Dev Team"/ })).toBeDefined()
    expect(seen.store.get('delegate.dialogs')).toMatchObject({ [String(GROUP)]: { skip: null } })
    await ui.input({ key: 'dg:confirm', text: 'Dev Team' })
    expect(seen.store.get('delegate.dialogs')).toMatchObject({ [String(GROUP)]: { skip: { stops: ['money', 'publish', 'share', 'delete', 'commit-on-behalf'], until: NOW + 24 * 3_600_000 } } })
    expect(await ui.find({ type: 'Text', text: /off: money, publish, share, delete, commit-on-behalf \(until/ })).toBeDefined()
    await ui.unmount()
  })

  test('bypass permissions alone, with every stop on, adds no mark', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'bypassPermissions' })
    await clock.settle()
    expect((await ui.find({ key: 'dialog:1002' }))?.text).not.toContain('⚠')
    await ui.unmount()
  })

  test('the mod option ["all"] is mirrored for the guard; under bypass the mark adds no permissions', { ...WITH_GUARD, options: { dangerouslySkipHardStops: ['all'] } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'bypassPermissions' })
    await clock.settle()
    expect((await ui.find({ key: 'dialog:1002' }))?.text).toContain('⚠ no stops · no permissions')
    expect(seen.status.at(-1)).toContain('⚠ no stops · no permissions')
    await ui.unmount()
  })
})

describe('the Speaker in a delegate dialog', () => {
  test('commit-on-behalf in its own reply asks; No keeps it as a draft, nothing sent', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, { model: () => answer({ action: 'reply', text: 'sure, done by Friday', confidence: 0.95, topics: [], reason: '' }) })
    const { child } = await handOver($, clock, seen)
    seen.dialog = 'No'
    child?.line({ event: 'message', ...message(500, 'can you finish it this week?') })
    await clock.advance(20_000)
    await clock.settle()
    expect(seen.questions).toEqual(['HARD STOP commit-on-behalf (reply in Dev Team): "sure, done by Friday". Allow it?'])
    expect(sends(seen)).toEqual([])
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /HARD STOP commit-on-behalf: not sent \(you\)/ })).toBeDefined()
    await band.unmount()
  })

  test('a share stop skipped by name sends unasked and is logged as skipped', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, { model: () => answer({ action: 'reply', text: 'write to someone@example.com', confidence: 0.95, topics: [], reason: '' }) })
    const { ui, child } = await handOver($, clock, seen)
    await $.command.run(tgCommand('autopilot --dangerously-skip-hard-stops=share'))
    child?.line({ event: 'message', ...message(500, 'who do I ask?') })
    await clock.advance(20_000)
    await clock.settle()
    expect(seen.questions).toEqual([])
    expect(sends(seen)).toEqual(['write to someone@example.com'])
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'key:activity' })
    expect(await ui.find({ type: 'Text', text: /^ {2}\d\d:\d\d ⚡ Dev Team · skipped stop: share personal data in/ })).toBeDefined()
    await ui.unmount()
  })

  test("the Worker's ASK goes to the chat; the chat's answer is forwarded to the Worker", WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let turn = 0
    const seen = world(on, {
      model: e => {
        turn += 1
        if (e.prompt.includes('<worker kind="ask">')) return answer({ action: 'reply', text: 'which port should it listen on?', confidence: 0.9, topics: [], reason: '' })
        if (turn > 1) return answer({ action: 'forward', text: 'thanks', task: 'port 8080', confidence: 0.9, topics: [], reason: '' })
        return answer(START_TASK)
      },
    })
    const { child } = await startTask($, clock, seen)
    await $.turn.complete({ answer: 'Read the code.\nASK: which port?', durationMs: 1, isAborted: false, turnId: 't1', agentId: WORKER, reason: 'answer' })
    await clock.settle()
    expect(sends(seen)).toEqual(['on it', 'which port should it listen on?'])
    child?.line({ event: 'message', ...message(510, '8080') })
    await clock.advance(20_000)
    await clock.settle()
    expect(seen.asked.at(-1)?.prompt).toContain('<task status="asking"><summary>add a /health endpoint</summary><question>which port?</question></task>')
    expect(seen.sent).toEqual([{ to: WORKER, text: expect.stringContaining("The Speaker's reading: port 8080") }])
    expect(sends(seen)).toEqual(['on it', 'which port should it listen on?', 'thanks'])
    // Delegate's replies are an agent's writes: allow.toml decides, never --yes (decision 9).
    expect(seen.runs.filter(one => one.argv[1] === 'send').map(one => one.argv.includes('--yes'))).toEqual([false, false, false])
  })
})

describe('stopping', () => {
  test('the kill switch stops the Worker; its next call is refused here as well as by the guard', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await startTask($, clock, seen)
    expect((await $.command.run(tgCommand('autopilot off'))).text).toBe('tg: stopped Dev Team (delegate and its Worker).\nSettings are kept; /tg, then a, restarts one.')
    expect(seen.stopped).toEqual([WORKER])
    expect((await worker($, 'uv run pytest')).deny).toContain('This task is over')
    expect(seen.ran).toEqual([])
  })

  test('a deadline in the grant stops the Worker when it passes', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand('wide'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    await ui.press({ key: 'ap:level:delegate' })
    await ui.press({ key: 'ap:level:delegate' })
    await ui.input({ key: 'dg:duration', text: '30m' })
    await ui.press({ key: 'key:start' })
    await clock.settle()
    seen.children.at(-1)?.line({ event: 'ready', date: '2026-10-10T12:00:00Z', peers: [] })
    seen.children.at(-1)?.line({ event: 'message', ...message(500, 'please add a /health endpoint') })
    await clock.advance(20_000)
    await clock.settle()
    expect((await worker($, 'ls')).deny).toBeUndefined()
    await clock.advance(30 * 60_000)
    await clock.settle()
    expect(seen.stopped).toEqual([WORKER])
    expect((await worker($, 'ls')).deny).toContain('This task is over')
    await ui.unmount()
  })
})
describe('what runs: the strip, the kill switch, Activity, the card on top of its chat (T4)', () => {
  /** Ring stops before the element keyed `key`, in document order. */
  async function stopsBefore(ui: Awaited<ReturnType<typeof handOver>>['ui'], key: string): Promise<number> {
    let count = 0
    let isDone = false
    const walk = (node: unknown) => {
      if (isDone || typeof node !== 'object' || node === null) return
      const one = node as { type?: unknown; props?: { key?: unknown }; children?: unknown }
      if (one.props?.key === key) {
        isDone = true
        return
      }
      if (one.type === 'Button' || one.type === 'Input' || one.type === 'Select') count += 1
      if (Array.isArray(one.children)) for (const child of one.children) walk(child)
    }
    walk(await ui.drawn())
    return count
  }

  /** The bar's keys as drawn: the `key:<id>` Buttons inside the bar. */
  async function barKeys(ui: Awaited<ReturnType<typeof handOver>>['ui']): Promise<string[]> {
    const ids: string[] = []
    const walk = (node: unknown) => {
      if (typeof node !== 'object' || node === null) return
      const { type, props, children } = node as { type?: unknown; props?: { key?: unknown }; children?: unknown }
      if (type === 'Button' && typeof props?.key === 'string' && props.key.startsWith('key:')) ids.push(props.key.slice(4).replace(/:enter$/, ''))
      if (Array.isArray(children)) for (const child of children) walk(child)
    }
    walk(await ui.find({ key: 'bar' }))
    return ids
  }

  test('0 empties the follows, the running dialogs and the live tasks (TaskStop), and says what it stopped', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
    on('ui.invalidate', () => ({ value: undefined }))
    const { ui } = await startTask($, clock, seen)
    await ui.press({ key: 'dialog:1001' })
    await ui.press({ key: 'key:follow' })
    await clock.settle()
    expect((await ui.find({ key: 'running' }))?.text).toBe('⚡ Dev Team · ⌁ @example_bot → main0: stop all')
    await ui.press({ key: 'key:stop' })
    await clock.settle()
    expect(seen.stopped).toEqual([WORKER])
    expect((await ui.find({ key: 'running' }))?.text).toBe('■ stopped: Dev Team (delegate and its Worker), @example_bot (follow). Settings kept; a restarts one.')
    expect(seen.toasts.at(-1)).toBe('tg: stopped Dev Team (delegate and its Worker), @example_bot (follow). Settings are kept; /tg, then a (p for a follow), restarts one.')
    // Empty: no follow (prompt.context has no pinned block), no dialog, no live task.
    expect((await $.prompt.context({ blocks: [] })).blocks.filter(block => block.name === 'tgPinned')).toEqual([])
    expect((await $.command.run(tgCommand('autopilot'))).text).toBe('tg autopilot: off. Open a chat in the pane and press a.')
    expect((await $.command.run(tgCommand('stop'))).text).toBe('tg: nothing was running.')
    expect(await ui.find({ key: 'key:stop' })).toBeUndefined()
    await ui.unmount()
  })

  test('a task starting while the cursor is in its chat’s thread puts the card on top, and nothing above the cursor moves', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    // A thread longer than its window, so a window that shrank would scroll.
    seen.history = Array.from({ length: 40 }, (_, index) => message(400 + index, `line ${index}`))
    const { ui, child } = await handOver($, clock, seen)
    await ui.press({ key: 'dialog:1002' })
    await clock.settle()
    // Off the newest row, which a new message moves the cursor past.
    for (let i = 0; i < 3; i++) await ui.press({ key: 'key:up' })
    const cursor = 'msg:436'
    expect((await ui.find({ key: cursor }))?.props.autoFocus).toBe(true)
    const before = { stops: await stopsBefore(ui, cursor), rows: (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key)).filter(key => key.startsWith('msg:')) }
    const all = (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key))
    const keysBefore = all.slice(0, all.indexOf(cursor))
    expect(await ui.find({ key: 'dg:task:1' })).toBeUndefined()
    child?.line({ event: 'message', ...message(500, 'please add a /health endpoint to the app') })
    await clock.advance(20_000)
    await clock.settle()
    expect(await ui.find({ key: 'dg:task:1' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' }).then(all => all.filter(one => String(one.props.key ?? '').startsWith('dg:')))).toEqual([])
    const rows = (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key)).filter(key => key.startsWith('msg:'))
    const keysNow = (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key))
    expect(keysNow.slice(0, keysNow.indexOf(cursor))).toEqual(keysBefore)
    expect({ stops: await stopsBefore(ui, cursor), rows: rows.slice(0, before.rows.length) }).toEqual(before)
    await ui.unmount()
  })

  test('Activity: ⏎ on a task’s row opens its chat with the card; after it ended, d dismisses it', WITH_GUARD, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const { ui } = await startTask($, clock, seen)
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'act:1002' }))?.text).toMatch(/^▸ ⚡ {2}Dev Team {7}delegate · listening · task 0 min · … starting$/)
    // The ack "on it" went out a moment ago: its undo window is open.
    expect(await barKeys(ui)).toEqual(['open', 'back', 'undo', 'menu'])
    await ui.press({ key: 'act:1002' })
    expect(await ui.find({ key: 'dg:task:1' })).toBeDefined()
    await ui.press({ key: 'key:stop' })
    await clock.settle()
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'act:1002' }))?.text).toContain('task 0 min · stopped')
    expect(await barKeys(ui)).toEqual(['open', 'dismiss', 'back', 'undo', 'menu'])
    await ui.press({ key: 'key:dismiss' })
    expect((await ui.find({ key: 'act:1002' }))?.text).toContain('■  Dev Team       stopped')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'dg:task:1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the cross-session lease', () => {
  test('a dialog running in another session does not start here; a stale lease is free', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.store.set(`autopilot.lease.${GROUP}`, { session: 'session-b-1234', beat: NOW - 10_000 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand('wide'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    await ui.press({ key: 'ap:level:draft' })
    await ui.press({ key: 'key:start' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /Not started: Dev Team is running in another session \(session-/ })).toBeDefined()
    expect(seen.children).toHaveLength(0)
    seen.store.set(`autopilot.lease.${GROUP}`, { session: 'session-b-1234', beat: NOW - 120_000 })
    await ui.press({ key: 'key:start' })
    await clock.settle()
    expect(seen.children).toHaveLength(1)
    expect(seen.store.get(`autopilot.lease.${GROUP}`)).toEqual({ session: 'session-a', beat: NOW })
    await clock.advance(30_000)
    expect(seen.store.get(`autopilot.lease.${GROUP}`)).toEqual({ session: 'session-a', beat: NOW + 30_000 })
    expect((await $.command.run(tgCommand('autopilot off'))).text).toBe('tg: stopped Dev Team (draft).\nSettings are kept; /tg, then a, restarts one.')
    expect(seen.store.has(`autopilot.lease.${GROUP}`)).toBe(false)
    await ui.unmount()
  })
})
