// The pane through the engine: /tg, the three modes, keys, and the states.
// tg is answered by a `process.run` hook beneath the plugin, so nothing runs.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { DIALOGS, MESSAGES } from './fixtures'

const PLUGIN = 'dialogs-pane'
const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

type World = {
  opened: string[]
  closed: string[]
  status: (string | undefined)[]
  toasts: string[]
  store: Map<string, unknown>
}

const json = (value: unknown): ProcessRunResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const failure = (exitCode: number, stderr: string): ProcessRunResult => ({
  exitCode,
  stdout: '',
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** The engine beneath the plugin: tg, panes, status line, toasts, store, clock. */
function world(on: On, tg: (argv: readonly string[]) => ProcessRunResult, store: Record<string, unknown> = {}): World {
  const seen: World = { opened: [], closed: [], status: [], toasts: [], store: new Map(Object.entries(store)) }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', (_$, e) => ({ value: tg(e.argv) }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
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

const happy = (argv: readonly string[]) => (argv[1] === 'dialogs' ? json(DIALOGS) : json(MESSAGES))

const runTg = (args = '', columns = 160) =>
  ({ command: 'tg', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns } }) as const

describe('the pane', () => {
  test('/tg opens wide on a wide fullscreen terminal and lists dialogs', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    const seen = world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const answer = await $.command.run(runTg())
    await clock.settle()
    expect(answer.text).toBe('tg pane open (wide).')
    expect(seen.opened).toEqual(['tg'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'tg', props: PANE_PROPS })
      expect((await ui.find({ key: 'mode' }))?.text).toBe('wide')
      expect((await ui.find({ key: 'dialog:1001' }))?.text).toContain('@example_bot')
      expect((await ui.find({ key: 'dialog:1003' }))?.text).toContain('Saved Messages')
      const hints = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('hint:'))
      expect(hints.length).toBeLessThanOrEqual(5)
      await ui.unmount()
    }
  })

  test('Enter opens a thread; x, v and d select; h clears then goes back', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg('compact'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'dialog:1001' })
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('Something went wrong')
    expect((await ui.find({ key: 'btn:677791:0:0' }))?.text).toContain('Retry')
    expect((await ui.find({ key: 'btn:677791:0:1' }))?.text).toContain('Back')

    // The cursor starts on the newest message; k moves up, x selects it.
    await ui.press({ key: 'hint:up' })
    await ui.press({ key: 'hint:select' })
    expect((await ui.find({ type: 'Text', text: '1 selected' }))).toBeDefined()

    await ui.press({ key: 'whole' })
    expect((await ui.find({ type: 'Text', text: '3 selected' }))).toBeDefined()

    await ui.press({ key: 'hint:back' })
    expect((await ui.find({ type: 'Text', text: '0 selected' }))).toBeDefined()

    // v at the cursor marks the start; k then v closes the range over two messages.
    await ui.press({ key: 'hint:range' })
    await ui.press({ key: 'hint:up' })
    await ui.press({ key: 'hint:range' })
    expect((await ui.find({ type: 'Text', text: '2 selected' }))).toBeDefined()

    await ui.press({ key: 'hint:back' })
    await ui.press({ key: 'hint:back' })
    expect(await ui.find({ key: 'dialog:1002' })).toBeDefined()
    await ui.unmount()
  })

  test('lenses filter and say how to leave an empty one', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, argv => (argv[1] === 'dialogs' ? json(DIALOGS.filter(d => d.kind !== 'bot')) : json([])))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg('compact'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'lens:bots' })
    expect(await ui.find({ type: 'Text', text: 'Press 1 for All' })).toBeDefined()
    await ui.press({ key: 'lens:unread' })
    expect(await ui.find({ key: 'dialog:1002' })).toBeDefined()
    expect(await ui.find({ key: 'dialog:1003' })).toBeUndefined()
    await ui.unmount()
  })

  test('the mode button cycles wide → compact → hidden and the store keeps it', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    const seen = world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    await ui.press({ key: 'mode' })
    expect((await ui.find({ key: 'mode' }))?.text).toBe('compact')
    expect(seen.store.get('mode')).toBe('compact')
    await ui.press({ key: 'mode' })
    expect(seen.closed).toEqual(['tg'])
    expect(seen.store.get('mode')).toBe('hidden')
    expect(seen.status.at(-1)).toBe('tg ● 7 unread')
    await ui.unmount()
  })
})

describe('states', () => {
  test('not logged in tells the person to run ! tg login', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    world(on, () => failure(3, 'error: not logged in\n  fix: tg login'))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg('compact'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: '! tg login' }))).toBeDefined()
    expect(await ui.find({ key: 'reload' })).toBeDefined()
    await ui.unmount()
  })

  test('a flood wait counts down and retries', async ($, on) => {
    let calls = 0
    const clock = mock.clock(on, { now: 0 })
    world(on, argv => {
      calls += 1
      if (argv[1] !== 'dialogs') return json([])
      return calls === 1 ? failure(5, 'error: FLOOD_WAIT 3s: Telegram asks to wait before retrying') : json(DIALOGS)
    })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg('compact'))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'Telegram asks to wait 3 s' }))).toBeDefined()
    await clock.advance(1000)
    expect((await ui.find({ type: 'Text', text: 'Telegram asks to wait 2 s' }))).toBeDefined()
    await clock.advance(2000)
    expect(await ui.find({ key: 'dialog:1001' })).toBeDefined()
    await ui.unmount()
  })

  test('loading shows dim … rows', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    // No /tg yet: nothing loaded, so the list is in its loading state.
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
    expect(await ui.find({ key: 'loading' })).toBeDefined()
    await ui.unmount()
  })
})

describe('hidden mode', () => {
  test('a dialog whose unread count grows raises the band; x dismisses it', async ($, on) => {
    let unread = 5
    const clock = mock.clock(on, { now: 0 })
    const { status } = world(on, () => json(DIALOGS.map(d => (d.id === 1002 ? { ...d, unread } : d))), { mode: 'hidden' })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(status.at(-1)).toBe('tg ● 7 unread')
    unread = 6
    // The slow poll: watched dialogs are live through tg watch, the rest every 5 min.
    await clock.advance(300_000)
    expect(status.at(-1)).toBe('tg ● 8 unread · Dev Team wrote')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 6,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 6 },
        view: {},
      },
    })
    expect((await band.find({ type: 'Text', text: 'Dev Team: "deploy is green"' }))).toBeDefined()
    await band.press({ key: 'band:dismiss' })
    expect(status.at(-1)).toBe('tg ● 8 unread')
    await band.unmount()
  })
})
