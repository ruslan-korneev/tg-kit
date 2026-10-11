// Bot testing through the engine: chips, the guard, the send box, the recorder,
// the reply diff and latency stamps. tg is answered beneath the plugin: nothing runs.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type TestBody } from 'claude-code/testing'

import type { BotTest } from '../types'
import { DIALOGS, MESSAGES } from './fixtures'

const PLUGIN = 'dialogs-pane'
const PROPS: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const NOW = Date.parse('2026-10-10T12:00:00Z')
const BOT_ID = 1001

const out = (exitCode: number, value: unknown, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout: value === undefined ? '' : JSON.stringify(value),
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

type Runs = { argv: readonly string[]; stdin?: string }[]

/** The engine beneath the plugin. `writes` answers tg send / press; everything else is fixtures. */
function world(
  on: On,
  options: {
    allow?: number[]
    dialogs?: typeof DIALOGS
    messages?: typeof MESSAGES
    writes?: (argv: readonly string[]) => ProcessRunResult
  } = {},
) {
  const runs: Runs = []
  const files = new Map<string, string>()
  const saved: { bottest: BotTest | null } = { bottest: null }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/example-bot' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'bottest') saved.bottest = e.value as BotTest // the contract's type for this key
    return next(e)
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }) })
    const [, command, sub] = e.argv
    if (command === 'dialogs') return { value: out(0, options.dialogs ?? DIALOGS) }
    if (command === 'read') return { value: out(0, options.messages ?? MESSAGES) }
    if (command === 'allow' && sub === 'list') return { value: out(0, (options.allow ?? [BOT_ID]).map(id => ({ id, kind: 'bot' }))) }
    return { value: options.writes?.(e.argv) ?? out(2, undefined, 'error: unexpected call') }
  })
  return { runs, files, saved }
}

async function openBot($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tg', args: 'wide', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PROPS })
  await ui.press({ key: 'dialog:1001' })
  await clock.settle()
  return ui
}

const writes = (runs: Runs) => runs.filter(run => run.argv[1] === 'press' || run.argv[1] === 'send')

const EDITED = { ...MESSAGES[1], text: 'Settings saved', edited: '2026-10-10T11:01:12Z', buttons: [] }

describe('pressable buttons', () => {
  test('Enter on a chip runs tg press and the edited message appears in place', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { runs } = world(on, { writes: () => out(0, { button: {}, answer: { alert: null, toast: 'Saved', url: null }, replies: [EDITED] }) })
    const ui = await openBot($, clock)
    await ui.press({ key: 'btn:677791:0:0' })
    await clock.settle()
    expect(writes(runs).map(run => run.argv)).toEqual([
      ['tg', 'press', '@example_bot', '677791', '--row', '0', '--col', '0', '--wait', '5s', '--json', '--yes'],
    ])
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('Settings saved')
    expect(await ui.find({ key: 'btn:677791:0:0' })).toBeUndefined()
    expect((await ui.find({ key: 'notice' }))?.text).toBe('toast: Saved')
    await ui.unmount()
  })

  test("a chat outside allow.toml: the owner's press and n are their own writes, with --yes (decision 9)", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { runs } = world(on, { allow: [], writes: () => out(0, { sent: [], replies: [] }) })
    const ui = await openBot($, clock)
    expect((await ui.find({ key: 'chips:677791' }))?.text).not.toContain('ro')
    await ui.press({ key: 'btn:677791:0:0' })
    await clock.settle()
    const composing = ui.press({ key: 'key:write' })
    await clock.advance(50)
    await composing
    await ui.input({ key: 'bt:send', text: '/start' })
    await clock.settle()
    expect(writes(runs)).toEqual([
      { argv: ['tg', 'press', '@example_bot', '677791', '--row', '0', '--col', '0', '--wait', '5s', '--json', '--yes'] },
      { argv: ['tg', 'send', '@example_bot', '-', '--plain', '--wait', '10s', '--json', '--yes'], stdin: '/start' },
    ])
    await ui.unmount()
  })

  test('BotFather is read-only even when allowlisted: chips dim with ro, a press runs nothing, n is not there', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const dialogs = DIALOGS.map(one => (one.id === BOT_ID ? { ...one, username: 'BotFather', title: 'BotFather' } : one))
    const { runs } = world(on, { dialogs })
    const ui = await openBot($, clock)
    expect((await ui.find({ key: 'chips:677791' }))?.text).toContain('ro')
    await ui.press({ key: 'btn:677791:0:0' })
    await clock.settle()
    expect((await ui.find({ key: 'notice' }))?.text).toContain('BotFather is read-only')
    // Nothing to write to BotFather (design §4.6): no n, drawn or kept as a hotkey.
    expect(await ui.find({ key: 'key:write' })).toBeUndefined()
    expect(writes(runs)).toEqual([])
    await ui.unmount()
  })

  test('a URL chip shows its URL and opens nothing; a phone button is refused', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const keyboard = [
      [{ row: 0, col: 0, type: 'url', text: 'Docs', url: 'https://example.com/docs' }],
      [{ row: 1, col: 0, type: 'phone', text: 'Share phone' }],
    ]
    const messages = MESSAGES.map(one => (one.id === 677792 ? { ...one, keyboard: 'reply' as const, buttons: keyboard } : one))
    const { runs } = world(on, { messages })
    const ui = await openBot($, clock)
    expect((await ui.find({ key: 'btn:677792:0:0' }))?.text).toContain('Docs → https://example.com/docs')
    await ui.press({ key: 'btn:677792:0:0' })
    expect((await ui.find({ key: 'notice' }))?.text).toBe('url "Docs" → https://example.com/docs (not opened)')
    await ui.press({ key: 'btn:677792:1:0' })
    expect((await ui.find({ key: 'notice' }))?.text).toContain('tg does not press phone buttons')
    expect(writes(runs)).toEqual([])
    await ui.unmount()
  })

  test('b moves the cursor to the newest message with buttons', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openBot($, clock)
    // The cursor starts on the newest message, which has no buttons.
    expect((await ui.find({ key: 'msg:677792' }))?.text).toContain('▸')
    await ui.press({ key: 'key:buttons' })
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('▸')
    await ui.unmount()
  })
})

describe('recorder', () => {
  test('r, a send from the box, a press, r: a script under .tg-recordings and the steps in state', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const sent = { ...MESSAGES[0], id: 677800, text: '/settings' }
    const reply = { ...MESSAGES[1], id: 677801, reply_to: 677800 }
    const { runs, files, saved } = world(on, {
      writes: argv =>
        argv[1] === 'send'
          ? out(0, { sent: [sent], replies: [reply] })
          : out(6, { button: {}, answer: null, replies: [] }, 'error: no reply within 5s'),
    })
    const ui = await openBot($, clock)
    await ui.press({ key: 'key:record' })
    // n gives the box a frame to draw before it moves the ring into it.
    const composing = ui.press({ key: 'key:write' })
    await clock.advance(50)
    await composing
    await ui.input({ key: 'bt:send', text: '/settings' })
    await clock.settle()
    expect(writes(runs)[0]).toEqual({ argv: ['tg', 'send', '@example_bot', '-', '--plain', '--wait', '10s', '--json', '--yes'], stdin: '/settings' })
    await ui.press({ key: 'btn:677801:0:0' })
    await clock.settle()
    expect((await ui.find({ key: 'notice' }))?.text).toContain('no reply within 5s')
    expect((await ui.find({ key: 'header' }))?.text).toContain('rec 2')
    await ui.press({ key: 'key:record' })
    await clock.settle()

    const path = [...files.keys()].find(one => one.endsWith('.sh'))
    expect(path).toMatch(/^\/work\/example-bot\/\.tg-recordings\/\d{8}-\d{6}-example_bot\.sh$/)
    expect(files.get('/work/example-bot/.tg-recordings/.gitignore')).toBe('*\n')
    const script = files.get(path ?? '') ?? ''
    expect(script).toContain('out1=$(tg send @example_bot /settings --plain --wait 10s)')
    expect(script).toContain('id=$(nth_id "$out1" 2)')
    expect(script).toContain('out2=$(tg press @example_bot "$id" --row 0 --col 0 --wait 5s) || [ $? -eq 6 ]')
    // The live steps were the owner's (--yes); the script is an agent's to replay, so allow.toml gates it.
    expect(writes(runs).every(run => run.argv.includes('--yes'))).toBe(true)
    expect(script).not.toContain('--yes')

    expect(saved.bottest?.recorded?.steps.map(step => step.kind)).toEqual(['send', 'press'])
    expect(saved.bottest?.recorded?.path).toBe(path)
    expect((await ui.find({ key: 'notice' }))?.text).toContain(`2 steps → .tg-recordings/`)
    await ui.unmount()
  })
})

describe('reply diff', () => {
  test('x on two bot replies, then f: text and keyboard-shape diff; f again closes it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openBot($, clock)
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:diff' })
    const view = (await ui.find({ key: 'bt:diff-view' }))?.text ?? ''
    expect(view).toContain('diff #677791 → #677792')
    expect(view).toContain('- ⚠ Something went wrong')
    expect(view).toContain('+ Main menu')
    expect(view).toContain('keyboard: 1 → 0 rows (2 → none)')
    expect(view).toContain('- 0:0 "Retry" cb retry')
    await ui.press({ key: 'key:diff' })
    expect(await ui.find({ key: 'bt:diff-view' })).toBeUndefined()
    await ui.unmount()
  })

  test('with one reply marked f is not drawn; the menu says the step it needs', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openBot($, clock)
    await ui.press({ key: 'key:mark' })
    expect(await ui.find({ key: 'key:diff' })).toBeUndefined()
    await ui.press({ key: 'key:menu' })
    expect((await ui.find({ key: 'menu:diff' }))?.text).toBe('f: diff · needs two replies marked (x)')
    await ui.unmount()
  })
})

describe('latency stamps', () => {
  test('without a watch: the date difference, slow ones in warn', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openBot($, clock)
    // 11:01:00 → 11:01:07: over 3 s.
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('⏱7s')
    await ui.unmount()
  })

  test('with tg watch: local timing, and the live reply joins the thread', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const line = (value: unknown) => `${JSON.stringify(value)}\n`
    const mine = { ...MESSAGES[0], id: 677810, text: '/ping' }
    const pong = { ...MESSAGES[2], id: 677811, text: 'pong', reply_to: 677810 }
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: line({ event: 'ready', peers: [] }) }
      yield { stream: 'stdout' as const, text: line({ event: 'message', ...mine }) }
      await gate
      yield { stream: 'stdout' as const, text: line({ event: 'message', ...pong }) }
      return { value: { code: 0, signal: null } }
    })
    const ui = await openBot($, clock)
    await clock.advance(1400)
    release()
    await clock.settle()
    expect((await ui.find({ key: 'msg:677811' }))?.text).toContain('⏱1.4s')
    await ui.unmount()
  })

  test('a send from the box times the live reply from the local send, whatever the dates say', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // Dates 59 min apart, as a fake tg's fixed ones are; the watch never echoes the send.
    const mine = { ...MESSAGES[0], id: 677820, text: '/ping', date: '2026-10-10T11:01:00Z' }
    const pong = { ...MESSAGES[2], id: 677821, text: 'pong', reply_to: 677820, date: '2026-10-10T12:00:00Z' }
    world(on, { writes: () => out(0, { sent: [mine], replies: [] }) })
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const line = (value: unknown) => `${JSON.stringify(value)}\n`
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: line({ event: 'ready', peers: [] }) }
      await gate
      yield { stream: 'stdout' as const, text: line({ event: 'message', ...pong }) }
      return { value: { code: 0, signal: null } }
    })
    const ui = await openBot($, clock)
    const composing = ui.press({ key: 'key:write' })
    await clock.advance(50)
    await composing
    await ui.input({ key: 'bt:send', text: '/ping' })
    await clock.advance(1400)
    release()
    await clock.settle()
    expect((await ui.find({ key: 'msg:677821' }))?.text).toContain('⏱1.4s')
    await ui.unmount()
  })
})
