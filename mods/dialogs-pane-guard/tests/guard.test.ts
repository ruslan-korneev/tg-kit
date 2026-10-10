// dialogs-pane-guard through the engine: the handshake, the grant, the hard
// stops held in the engine's dialog (AskUserQuestion answered beneath), the
// three skip scopes, a task stopped or past its deadline, a Worker placed by
// its type, and the re-entry rule that made this a plugin of its own. An
// inline plugin named dialogs-pane owns `delegate` (`/fake-pane …` writes it
// and reads the guard's values back); nothing real runs.
import type { DgTask, Delegate } from 'dialogs-pane'
import type { On, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Plugin } from 'claude-code/testing'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const HOME = '/home/me'
const REPO = `${HOME}/code/app`
const WT = `${HOME}/.config/tg-kit/worktrees/app-task-1`
const WORKER = 'agent-worker-1'

const TASK: DgTask = {
  id: 1,
  peer: { id: 1002, arg: '1002', label: 'Dev Team', kind: 'supergroup' },
  summary: 'add a /health endpoint',
  agentId: WORKER,
  startedAt: NOW,
  deadline: null,
  grant: { web: 'read', repos: [REPO], commands: 'checks', duration: { kind: 'done' } },
  worktrees: [{ repo: REPO, path: WT, branch: 'tg/add-a-health-endpoint-1', checks: ['uv run pytest', 'uv run ruff check'] }],
  holds: [],
  question: null,
  chat: null,
  status: 'working',
  reason: '',
}

const DELEGATE: Delegate = { dialogs: {}, tasks: [TASK], sessionSkip: [], alwaysSkip: [], permissionMode: null, pending: null }

/**
 * dialogs-pane's stand-in: `/fake-pane {"delegate": …}` writes its value (as
 * dialogs-pane does, which the guard answers), `/fake-pane {"read": key}` says
 * one of the guard's values; `/fake-pane {"push": true}` raises a Worker's
 * Bash call from this plugin, so under its origin.
 */
const fakePane: Plugin = {
  name: 'dialogs-pane',
  register: on => {
    on('command.run', { command: 'fake-pane' }, async ($, e) => {
      const asked: unknown = JSON.parse(e.args)
      if (typeof asked !== 'object' || asked === null) return { text: 'bad' }
      if ('delegate' in asked) await $.state.set({ plugin: 'dialogs-pane', key: 'delegate' } as never, asked.delegate as never)
      if ('read' in asked) {
        const key = asked.read
        const value =
          key === 'armed'
            ? (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'armed' })).value
            : key === 'holds'
              ? (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'holds' })).value
              : key === 'events'
                ? (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'events' })).value
                : (await $.state.get({ plugin: 'dialogs-pane-guard', key: 'work' })).value
        return { text: JSON.stringify(value ?? null) }
      }
      if ('push' in asked) {
        const result = await $.tool.call({ tool: 'Bash', command: 'git push origin tg/x', agentId: 'agent-worker-1' } as never)
        return { text: JSON.stringify({ deny: result.deny ?? null }) }
      }
      return { text: 'ok' }
    })
  },
}

const WITH_PANE = { plugins: [fakePane] }

const pane = async ($: Engine, args: unknown): Promise<string> =>
  (await $.command.run({ command: 'fake-pane', args: JSON.stringify(args), origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)).text ?? ''
const guardValue = async ($: Engine, key: 'armed' | 'holds' | 'events' | 'work'): Promise<unknown> => JSON.parse(await pane($, { read: key })) as unknown

type Dialog = 'Yes, allow it' | 'No' | 'dismiss'
type World = { ran: string[]; questions: string[]; dialog: Dialog; list: { id: string; type: string }[] }

function world(on: On, options: { whileAsked?: () => Promise<void> } = {}): World {
  const seen: World = { ran: [], questions: [], dialog: 'Yes, allow it', list: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('agent.list', () => ({ value: seen.list.map(one => ({ ...one, description: '', status: 'running' as const })) }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    await options.whileAsked?.()
    const question = e.tool === 'AskUserQuestion' ? (e.questions[0]?.question ?? '') : ''
    seen.questions.push(question)
    if (seen.dialog === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: [], answers: { [question]: seen.dialog } } as never }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.ran.push(e.tool === 'Bash' ? e.command : '')
    return { result: { stdout: 'ok', stderr: '', interrupted: false } as never }
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    seen.ran.push(e.tool)
    return { result: {} as never }
  })
  return seen
}

async function start($: Engine, delegate: Delegate = DELEGATE): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await pane($, { delegate })
}

const worker = ($: Engine, command: string, agentId = WORKER): Promise<ToolCallResult> => $.tool.call({ tool: 'Bash', command, agentId } as never)

describe('the handshake', () => {
  test('every write of delegate is answered with the live task ids', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    await start($)
    expect(await guardValue($, 'armed')).toEqual({ at: NOW, taskIds: [1] })
    await pane($, { delegate: { ...DELEGATE, tasks: [{ ...TASK, status: 'done' }] } })
    expect(await guardValue($, 'armed')).toEqual({ at: NOW, taskIds: [] })
  })

  test('it beats every 10 s, so dialogs-pane can tell it is alive', WITH_PANE, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    await start($)
    await clock.advance(10_000)
    expect(await guardValue($, 'armed')).toEqual({ at: NOW + 10_000, taskIds: [1] })
  })
})

describe('the grant', () => {
  test('a write outside the worktree, the owner checkout and an ungranted command are refused; the checks run', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($)
    const outside = await $.tool.call({ tool: 'Edit', file_path: `${REPO}/main.py`, old_string: 'a', new_string: 'b', agentId: WORKER } as never)
    expect(outside.deny).toContain("the owner's own checkout")
    expect((await worker($, 'python3 -c "print(1)"')).deny).toContain("not one of the repo's checks")
    expect((await worker($, 'W=/tmp; printf x >> $W/app.py')).deny).toBeDefined()
    expect((await worker($, 'uv run pytest -q')).deny).toBeUndefined()
    expect(seen.ran).toEqual(['uv run pytest -q'])
    expect(await guardValue($, 'work')).toEqual([
      {
        taskId: 1,
        steps: [
          { text: `refused: edit ${REPO}/main.py`, count: 1, state: 'failed' },
          { text: 'refused: ran python3 -c print(1)', count: 1, state: 'failed' },
          { text: 'refused: ran printf x >> $W/app.py', count: 1, state: 'failed' },
          { text: 'ran uv run pytest', count: 1, state: 'done' },
        ],
        current: null,
      },
    ])
  })

  test("a subagent that is no Worker is not the guard's", WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.list = [{ id: 'agent-other', type: 'general-purpose' }]
    await start($)
    expect((await worker($, 'python3 -c "print(1)"', 'agent-other')).deny).toBeUndefined()
  })

  test('a Worker is placed by its type while dialogs-pane has not recorded its id yet', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.list = [{ id: 'agent-new', type: 'dialogs-pane:worker-1' }]
    await start($, { ...DELEGATE, tasks: [{ ...TASK, agentId: null }] })
    expect((await worker($, 'python3 -c "print(1)"', 'agent-new')).deny).toContain("not one of the repo's checks")
  })
})

describe('hard stops', () => {
  test('git push waits in the dialog; Yes runs it, and the event is logged', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($)
    const result = await worker($, 'git push origin tg/add-a-health-endpoint-1')
    expect(seen.questions).toEqual(['HARD STOP publish (Worker for Dev Team): git push origin tg/add-a-health-endpoint-1. Allow it?'])
    expect(result.deny).toBeUndefined()
    expect(seen.ran).toEqual(['git push origin tg/add-a-health-endpoint-1'])
    expect(await guardValue($, 'events')).toEqual([
      { seq: 1, at: NOW, taskId: 1, peer: TASK.peer, summary: TASK.summary, stops: ['publish'], what: 'git push origin tg/add-a-health-endpoint-1', answer: 'yes', why: 'you' },
    ])
    expect(await guardValue($, 'holds')).toEqual([])
  })

  test('No refuses it: the push never runs', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($)
    seen.dialog = 'No'
    expect((await worker($, 'git push origin tg/x')).deny).toContain('the owner did not allow it (you)')
    expect(seen.ran).toEqual([])
  })

  test('a dismissed dialog is a no too (fail closed)', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($)
    seen.dialog = 'dismiss'
    expect((await worker($, 'git branch -D main')).deny).toContain('Hard stop delete')
    expect(seen.ran).toEqual([])
  })

  test('the hold is in the guard state while the dialog is up', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    let during: unknown = null
    world(on, {
      whileAsked: async () => {
        during = await guardValue($, 'holds')
      },
    })
    await start($)
    await worker($, 'git push origin tg/x')
    expect(during).toEqual([{ id: 1, taskId: 1, stops: ['publish'], what: 'git push origin tg/x', since: NOW }])
    expect(await guardValue($, 'holds')).toEqual([])
  })

  test('a task stopped while the dialog is up is a no, whatever was answered', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on, {
      whileAsked: async () => {
        await pane($, { delegate: { ...DELEGATE, tasks: [{ ...TASK, status: 'stopped', reason: 'kill switch' }] } })
      },
    })
    await start($)
    expect((await worker($, 'git push origin tg/x')).deny).toContain('the task was stopped while it waited')
    expect(seen.ran).toEqual([])
  })
})

describe('dangerouslySkipHardStops', () => {
  test('per session: the named stop passes unasked and is logged as skipped; the others still ask', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($, { ...DELEGATE, sessionSkip: ['publish'] })
    expect((await worker($, 'git push origin tg/x')).deny).toBeUndefined()
    expect(seen.questions).toEqual([])
    expect(seen.ran).toEqual(['git push origin tg/x'])
    expect(await guardValue($, 'events')).toEqual([expect.objectContaining({ stops: ['publish'], what: 'git push origin tg/x', answer: 'skipped', why: 'dangerouslySkipHardStops' })])
    seen.dialog = 'No'
    expect((await worker($, 'git branch -D main')).deny).toContain('Hard stop delete')
  })

  test('always (the option, mirrored by dialogs-pane) and per dialog until it expires', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($, { ...DELEGATE, alwaysSkip: ['delete'], dialogs: { '1002': { grant: TASK.grant, skip: { stops: ['publish'], until: NOW - 1 }, isWarned: true } } })
    expect((await worker($, 'git branch -D old')).deny).toBeUndefined()
    // The dialog's skip expired a moment ago: publish asks again.
    seen.dialog = 'No'
    expect((await worker($, 'git push origin tg/x')).deny).toContain('Hard stop publish')
    expect(seen.ran).toEqual(['git branch -D old'])
  })
})

describe('the task is over', () => {
  test('a stopped task and one past its deadline refuse every call', WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($, { ...DELEGATE, tasks: [{ ...TASK, status: 'stopped', reason: 'kill switch' }] })
    expect((await worker($, 'ls')).deny).toBe('This task is stopped (kill switch). Stop here; end your turn.')
    await pane($, { delegate: { ...DELEGATE, tasks: [{ ...TASK, deadline: NOW - 1 }] } })
    expect((await worker($, 'ls')).deny).toBe('The task deadline passed. Stop here; end your turn.')
    expect(seen.ran).toEqual([])
  })
})

describe('why the guard is a plugin of its own', () => {
  // Live (2.1.296), a Worker that dialogs-pane spawned ran `git push` past
  // dialogs-pane's own tool.call hook: the loop is that plugin's spawn's work,
  // where the engine runs none of its hooks (re-entry, cause 'lent'). The kit
  // cannot raise that case: a spawn beneath a test is answered, no loop runs.
  // What it can show is the other half: a call raised under dialogs-pane's
  // origin still meets this plugin's hook.
  test("a Worker's call raised under dialogs-pane's origin is held by this plugin", WITH_PANE, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = world(on)
    await start($)
    seen.dialog = 'No'
    expect(JSON.parse(await pane($, { push: true }))).toEqual({ deny: expect.stringContaining('Hard stop publish: the owner did not allow it') })
    expect(seen.questions).toEqual(['HARD STOP publish (Worker for Dev Team): git push origin tg/x. Allow it?'])
    expect(seen.ran).toEqual([])
  })
})
