// The pane through the engine: /tg, the frame in both seats, the keys, the
// menu, the focus chip, and the states. tg is answered by a `process.run` hook beneath
// the plugin, so nothing runs. Design: docs/design/dialogs-pane-ux.md §4, §6, §7.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { KEYS, hotkeyTable } from '../hooks/ui/keys'
import type { TgDialog, TgMessage } from '../types'
import { DIALOGS, MESSAGES, messagesFor } from './fixtures'

const PLUGIN = 'dialogs-pane'
const SURFACES = ['terminal', 'desktop'] as const

const DOCK: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const INLINE: RenderPropsOf['Pane'] = { ...DOCK, bodyColumns: 96, placement: 'inline', scroll: { offset: 0, bodyRows: 12 } }

/** One placeholder chat of every kind §4.6 tells apart. */
const KINDS: TgDialog[] = [
  ...DIALOGS,
  { id: 1004, kind: 'user', title: 'Contact A', username: null, unread: 1, last_id: 92, last_date: '2026-10-10T10:49:00Z', last_text: 'Can we call?' },
  { id: 1005, kind: 'channel', title: 'Announcements', username: null, unread: 0, last_id: 7, last_date: '2026-10-10T09:19:00Z', last_text: 'release' },
  { id: 1006, kind: 'bot', title: 'BotFather', username: 'BotFather', unread: 0, last_id: 3, last_date: '2026-10-08T09:00:00Z', last_text: 'Done!' },
]

type Ui = Mounted<'terminal', 'Pane'>

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

/** The engine beneath the plugin: tg, panes, the ring, status line, toasts, store, clock. */
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

const happy = (argv: readonly string[]) =>
  argv[1] === 'dialogs' ? json(KINDS) : argv[1] === 'allow' ? json([]) : argv[1] === 'whoami' ? json({ username: null, name: 'Me' }) : json(messagesFor(argv[2]))

const runTg = (args = '', columns = 160) =>
  ({ command: 'tg', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns } }) as const

/** Every Button drawn, shown or kept as a hidden hotkey, by its hotkey. */
async function hotkeys(ui: Ui): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.flatMap(button => (typeof button.props.hotkey === 'string' ? [button.props.hotkey] : []))
}

/** The bar's keys as drawn: the `key:<id>` Buttons inside the bar. */
async function barKeys(ui: Ui): Promise<string[]> {
  const ids: string[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { type, props, children } = node as { type?: unknown; props?: { key?: unknown }; children?: unknown }
    const key = props?.key
    if (type === 'Button' && typeof key === 'string' && key.startsWith('key:')) ids.push(key.slice(4).replace(/:enter$/, ''))
    if (Array.isArray(children)) for (const child of children) walk(child)
  }
  walk(await ui.find({ key: 'bar' }))
  return ids
}

async function openPane($: Engine, on: On, props = DOCK, tg = happy) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
  const seen = world(on, tg)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(runTg())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props })
  return { clock, seen, ui }
}

/** ⏎ on a chat's row in Chats. */
async function openChat(ui: Ui, id: number): Promise<void> {
  await ui.press({ key: `dialog:${id}` })
}

describe('the frame', () => {
  test('/tg opens the pane, asking for the dock width and the inline rows at once', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    const seen = world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const answer = await $.command.run(runTg())
    await clock.settle()
    expect(answer.text).toBe('tg pane open. m lists every key.')
    expect(seen.opened).toEqual(['tg'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'tg', props: DOCK })
      expect((await ui.find({ key: 'header' }))?.text).toContain('tg › chats')
      expect((await ui.find({ key: 'dialog:1001' }))?.text).toContain('@example_bot')
      expect((await ui.find({ key: 'dialog:1003' }))?.text).toContain('Saved Messages')
      await ui.unmount()
    }
  })

  test('/tg wide and /tg compact are aliases of /tg, /tg hidden of /tg hide: no mode to pick', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const seen = world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    for (const args of ['wide', 'compact']) expect((await $.command.run(runTg(args))).text).toBe('tg pane open. m lists every key.')
    expect((await $.command.run(runTg('hidden'))).text).toContain('hidden')
    expect((await $.command.run(runTg('hide'))).text).toContain('hidden')
    await clock.settle()
    expect(seen.opened).toEqual(['tg', 'tg'])
    expect(seen.closed).toEqual(['tg', 'tg'])
    expect(seen.store.get('mode')).toBe('hidden')
    expect((await $.command.run(runTg('nope'))).text).toContain('Usage')
  })

  test('dock: the strip, Chats on top and the open chat below', async ($, on) => {
    const { ui } = await openPane($, on)
    expect(await ui.find({ key: 'strip' })).toBeDefined()
    expect((await ui.find({ key: 'lens:all' }))?.props.hotkey).toBe('1')
    expect(await barKeys(ui)).toEqual(['open', 'summary', 'watch', 'agent', 'menu'])
    await openChat(ui, 1001)
    // Chats stay on screen above the thread; the open chat's row is marked.
    expect((await ui.find({ key: 'dialog:1001' }))?.text).toContain('›')
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('Something went wrong')
    expect(await ui.find({ type: 'Text', text: '@example_bot · bot' })).toBeDefined()
    // In the chat the strip's digits are not live: only the active column's are.
    expect((await ui.find({ key: 'lens:all' }))?.props.hotkey).toBeUndefined()
    expect(await barKeys(ui)).toEqual(['send', 'write', 'record', 'mark', 'agent', 'menu'])
    await ui.unmount()
  })

  test('inline: one view at a time, the strip in the header, h: chats in the bar', async ($, on) => {
    const { ui } = await openPane($, on, INLINE)
    expect((await ui.find({ key: 'header' }))?.text).toContain('‹All›')
    expect(await barKeys(ui)).toEqual(['open', 'search', 'summary', 'watch', 'agent', 'menu'])
    await openChat(ui, 1001)
    expect(await ui.find({ key: 'dialog:1001' })).toBeUndefined()
    expect(await ui.find({ key: 'strip' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › @example_bot')
    expect((await ui.find({ key: 'key:back' }))?.text).toContain('chats')
    expect(await barKeys(ui)).toContain('back')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'dialog:1001' })).toBeDefined()
    await ui.unmount()
  })

  test('the focus chip: ● keys while the pane holds them; ctrl+x tab: keys and a dim bar when not', async ($, on) => {
    const { ui } = await openPane($, on)
    expect((await ui.find({ key: 'header' }))?.text).toContain('● keys')
    expect((await ui.find({ key: 'key:menu' }))?.props.dimColor).toBe(false)
    await ui.redraw({ ...DOCK, isFocused: false })
    expect((await ui.find({ key: 'header' }))?.text).toContain('ctrl+x tab: keys')
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('● keys')
    expect((await ui.find({ key: 'key:menu' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('the keys the bar does not show are in a Box the surface does not draw', async ($, on) => {
    const { ui } = await openPane($, on)
    const hidden = await ui.find({ key: 'keys:hidden' })
    expect(hidden?.props.display).toBe('none')
    expect(hidden?.text).toContain('down')
    // Chats' ⏎ is drawn as `⏎ open`; o is one of the hidden keys.
    expect((await ui.find({ key: 'key:open:enter' }))?.text).toBe('⏎ open')
    expect((await ui.find({ key: 'key:open' }))?.props.hotkey).toBe('o')
    await ui.unmount()
  })

  test('q hides the pane; the store keeps it hidden', async ($, on) => {
    const { ui, seen } = await openPane($, on)
    await ui.press({ key: 'key:hide' })
    expect(seen.closed).toEqual(['tg'])
    expect(seen.store.get('mode')).toBe('hidden')
    await ui.unmount()
  })
})

describe('keys', () => {
  test('h walks back: the marks, the sheet one step at a time, the card, then up to Chats', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:mark' })
    expect(await ui.find({ type: 'Text', text: '▪ 1 marked' })).toBeDefined()
    expect((await ui.find({ key: 'key:back' }))?.text).toContain('clear')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'marks' })).toBeUndefined()
    // ⏎ on a message opens the send sheet in the bar's place; a and i open its steps, h walks back.
    await ui.press({ key: 'msg:677791' })
    expect(await ui.find({ key: 'sheet' })).toBeDefined()
    expect(await ui.find({ key: 'bar' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › @example_bot')
    expect((await ui.find({ key: 'key:back' }))?.text).toBe('cancel')
    await ui.press({ key: 'key:agent' })
    expect(await ui.find({ key: 'route:main' })).toBeDefined()
    expect((await ui.find({ key: 'key:back' }))?.text).toBe('back')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'route:main' })).toBeUndefined()
    await ui.press({ key: 'key:inspect' })
    expect(await ui.find({ key: 'inspect' })).toBeDefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'sheet:intent:fix' })).toBeDefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'sheet' })).toBeUndefined()
    expect(await ui.find({ key: 'bar' })).toBeDefined()
    // a: the agent card takes the lower part, the list stays; h closes it.
    await ui.press({ key: 'key:agent' })
    expect(await ui.find({ key: 'ap:card' })).toBeDefined()
    expect(await ui.find({ key: 'dialog:1002' })).toBeDefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
    // From the chat, h moves the cursor up to Chats; the chat stays open below.
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'dialog:1001' }))?.text).toContain('▸')
    expect(await ui.find({ key: 'msg:677791' })).toBeDefined()
    await ui.unmount()
  })

  test("x, v and the menu's whole-thread mark; ⏎ with marks opens the sheet for them", async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:range' })
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:range' })
    expect(await ui.find({ type: 'Text', text: '▪ 2 marked' })).toBeDefined()
    await ui.press({ key: 'key:menu' })
    await ui.press({ key: 'menu:whole' })
    expect(await ui.find({ type: 'Text', text: '▪ 3 marked' })).toBeDefined()
    await ui.press({ key: 'msg:677791' })
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('send 3 messages')
    await ui.unmount()
  })

  test('m: the menu lists what this chat can do, pressable; a key it runs closes it', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:menu' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › menu · @example_bot')
    for (const key of ['menu:mark', 'menu:range', 'menu:record', 'menu:follow', 'menu:watch', 'menu:summary', 'menu:hide']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    // f waits for two marked replies: listed dim with the step, not as a Button.
    const diff = await ui.find({ key: 'menu:diff' })
    expect(diff?.type).toBe('Box')
    expect(diff?.text).toContain('needs two replies marked')
    // The menu takes the body; its bar is h and m.
    expect(await barKeys(ui)).toEqual(['back', 'menu'])
    await ui.press({ key: 'menu:watch' })
    expect(await ui.find({ key: 'menu' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '◎ watched' })).toBeDefined()
    await ui.unmount()
  })
})

describe('one meaning per key, and only where it works (§4.6)', () => {
  const owners = hotkeyTable()

  test('the table gives each hotkey one meaning', () => {
    const letters = KEYS.flatMap(def => (def.hotkey === null ? [] : [def.hotkey]))
    expect(letters.filter((key, index) => letters.indexOf(key) !== index)).toEqual([])
  })

  /** Every view the pane draws in T1, by the presses that reach it. */
  const VIEWS: { name: string; props: RenderPropsOf['Pane']; steps: string[] }[] = [
    { name: 'chats', props: DOCK, steps: [] },
    { name: 'chats inline', props: INLINE, steps: [] },
    ...[1001, 1002, 1003, 1004, 1005, 1006].flatMap(id => [
      { name: `chat ${id}`, props: DOCK, steps: [`dialog:${id}`] },
      { name: `chat ${id} inline`, props: INLINE, steps: [`dialog:${id}`] },
      { name: `menu ${id}`, props: DOCK, steps: [`dialog:${id}`, 'key:menu'] },
    ]),
    // The send sheet (T2) and its steps, for each sender §4.6 tells apart, in both seats.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        { name: `sheet bot ${seat}`, props, steps: ['dialog:1001', 'msg:677791'] },
        { name: `sheet person ${seat}`, props, steps: ['dialog:1004', 'msg:92'] },
        { name: `sheet channel ${seat}`, props, steps: ['dialog:1005', 'msg:7'] },
        { name: `sheet group member ${seat}`, props, steps: ['dialog:1002', 'msg:499'] },
        { name: `sheet Saved ${seat}`, props, steps: ['dialog:1003', 'msg:677791'] },
        { name: `sheet BotFather ${seat}`, props, steps: ['dialog:1006', 'msg:677791'] },
        { name: `sheet targets ${seat}`, props, steps: ['dialog:1001', 'msg:677791', 'key:agent'] },
        { name: `sheet inspect ${seat}`, props, steps: ['dialog:1001', 'msg:677791', 'key:inspect'] },
        { name: `sheet ask ${seat}`, props, steps: ['dialog:1001', 'msg:677791', 'sheet:intent:raw'] },
        { name: `sheet several ${seat}`, props, steps: ['dialog:1001', 'msg:677791', 'key:agent', 'route:broadcast'] },
        { name: `sheet menu ${seat}`, props, steps: ['dialog:1004', 'msg:92', 'key:menu'] },
      ]
    }),
    { name: 'card', props: DOCK, steps: ['dialog:1004', 'key:agent'] },
    { name: 'card menu', props: DOCK, steps: ['dialog:1004', 'key:agent', 'key:menu'] },
    { name: 'activity', props: INLINE, steps: ['key:activity'] },
    // Something runs (T4): the dock's strip says 0 and the bar does not; inline the bar does.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        { name: `following ${seat}`, props, steps: ['dialog:1001', 'key:follow'] },
        { name: `following, chats ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'key:back'] },
        { name: `following, menu ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'key:menu'] },
        { name: `following, sheet ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'msg:677791'] },
        { name: `following, activity ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'key:activity'] },
        { name: `following, activity menu ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'key:activity', 'key:menu'] },
        { name: `following, card ${seat}`, props, steps: ['dialog:1001', 'key:follow', 'key:agent'] },
      ]
    }),
    { name: 'search', props: DOCK, steps: ['key:search'] },
    { name: 'lens editor', props: DOCK, steps: ['key:lenses'] },
    { name: 'lens editor inline', props: INLINE, steps: ['key:lenses'] },
  ]

  for (const view of VIEWS) {
    test(`${view.name}: no two Buttons share a hotkey, each is the table's, the bar holds ≤ 7`, async ($, on) => {
      const { ui } = await openPane($, on, view.props)
      for (const key of view.steps) await ui.press({ key })
      const drawn = await hotkeys(ui)
      expect(drawn.filter((key, index) => drawn.indexOf(key) !== index)).toEqual([])
      for (const key of drawn) expect(/^[0-9]$/.test(key) || owners.has(key)).toBe(true)
      expect((await barKeys(ui)).length).toBeLessThanOrEqual(7)
      await ui.unmount()
    })
  }

  const ABSENT: { id: number; name: string; absent: string[] }[] = [
    { id: 1004, name: 'a person chat', absent: ['r', 'f', 'b'] },
    { id: 1005, name: 'a channel', absent: ['n', 'r', 'f'] },
    { id: 1006, name: 'BotFather', absent: ['n', 'a', 'w', 'r', 'f', 'p'] },
    { id: 1003, name: 'Saved Messages', absent: ['w', 'a', 'r', 'f', 'p'] },
    { id: 1002, name: 'a group', absent: ['r', 'f'] },
  ]

  for (const { id, name, absent } of ABSENT) {
    test(`${name} neither draws nor lists ${absent.join(' ')}`, async ($, on) => {
      const { ui } = await openPane($, on)
      await openChat(ui, id)
      const drawn = await hotkeys(ui)
      for (const key of absent) expect(drawn).not.toContain(key)
      await ui.press({ key: 'key:menu' })
      for (const key of absent) expect(await ui.find({ key: `menu:${owners.get(key) ?? key}` })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('a bot chat has r and n; f joins once two replies are marked', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    let drawn = await hotkeys(ui)
    expect(drawn).toContain('r')
    expect(drawn).toContain('n')
    expect(drawn).not.toContain('f')
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:mark' })
    drawn = await hotkeys(ui)
    expect(drawn).toContain('f')
    expect(await barKeys(ui)).toContain('diff')
    await ui.unmount()
  })
})

const fixture = <T,>(one: T | undefined): T => {
  if (one === undefined) throw new Error('a fixture is missing')
  return one
}
/** A thread and a list longer than their windows: both scroll. */
const LONG: TgMessage[] = Array.from({ length: 40 }, (_, index) => ({
  ...fixture(MESSAGES.at(-1)),
  id: 700001 + index,
  text: `reply ${index + 1}`,
  date: `2026-10-10T11:${String(index).padStart(2, '0')}:00Z`,
}))
const MANY: TgDialog[] = [
  ...KINDS,
  ...Array.from({ length: 54 }, (_, index) => ({ ...fixture(KINDS[3]), id: 3000 + index, title: `Contact ${index + 10}` })),
]
const long = (argv: readonly string[]) => (argv[1] === 'read' ? json(LONG) : argv[1] === 'dialogs' ? json(MANY) : happy(argv))

/** The ids of the rows drawn as `prefix:<id>` Buttons, in order. */
async function rows(ui: Ui, prefix: string): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).flatMap(button => {
    const key = String(button.props.key ?? '')
    return key.startsWith(prefix) ? [key] : []
  })
}

describe('long lists scroll at the edges (the ring keeps its place among the Buttons)', () => {

  for (const list of [
    { name: 'a thread', prefix: 'msg:', open: true, step: 'key:up' },
    { name: 'Chats', prefix: 'dialog:', open: false, step: 'key:down' },
  ] as const) {
    test(`${list.name}: moves inside the window keep its first row; one past the edge shifts it by one`, async ($, on) => {
      const { ui } = await openPane($, on, DOCK, long)
      if (list.open) await openChat(ui, 1001)
      const before = await rows(ui, list.prefix)
      expect(before.length).toBeGreaterThan(3)
      expect(before.length).toBeLessThan(list.open ? LONG.length : MANY.length)
      // The cursor starts at one edge (the newest message, the first chat): walk to the other one.
      for (let i = 0; i < before.length - 1; i++) {
        await ui.press({ key: list.step })
        expect(await rows(ui, list.prefix)).toEqual(before)
      }
      await ui.press({ key: list.step })
      const after = await rows(ui, list.prefix)
      expect(after).toEqual(list.open ? [list.prefix + String(Number(before[0]?.slice(4)) - 1), ...before.slice(0, -1)] : [...before.slice(1), after.at(-1)])
      expect(after).not.toEqual(before)
      await ui.unmount()
    })
  }
})

/**
 * Ring stops (Buttons, Inputs, Selects) drawn before the first node `isEnd`
 * picks, in document order: the engine keeps the ring at that place.
 */
async function stopsBeforeNode(ui: Ui, isEnd: (node: { type?: unknown; props?: { key?: unknown }; children?: unknown }) => boolean): Promise<number> {
  let count = 0
  let isDone = false
  const walk = (node: unknown) => {
    if (isDone || typeof node !== 'object' || node === null) return
    const one = node as { type?: unknown; props?: { key?: unknown }; children?: unknown }
    if (isEnd(one)) {
      isDone = true
      return
    }
    if (one.type === 'Button' || one.type === 'Input' || one.type === 'Select') count += 1
    if (Array.isArray(one.children)) for (const child of one.children) walk(child)
  }
  walk(await ui.drawn())
  return count
}

/** Ring stops above the dock's divider (`─ @example_bot · bot ─`). */
async function stopsAbove(ui: Ui): Promise<number> {
  return stopsBeforeNode(ui, node => node.type === 'Text' && Array.isArray(node.children) && typeof node.children[0] === 'string' && node.children[0].startsWith('─ '))
}

/** Ring stops above the element keyed `key`: where the ring is while it sits there. */
async function stopsBefore(ui: Ui, key: string): Promise<number> {
  return stopsBeforeNode(ui, node => node.props?.key === key)
}

describe('a layer opening or closing keeps the ring stops above the chat (the ring keeps its place)', () => {

  // More chats than the list's window, so a list sized by what the sheet leaves would lose rows.
  const many = (argv: readonly string[]) =>
    argv[1] === 'dialogs' ? json([...KINDS, ...Array.from({ length: 54 }, (_, index) => ({ ...KINDS[3], id: 3000 + index, title: `Contact ${index + 10}` }))]) : happy(argv)

  test('the sheet and each of its steps, and the card, open and close over the same stops', async ($, on) => {
    const { ui } = await openPane($, on, DOCK, many)
    // The search field is up (it sits on top), so the rows on top count as well as the strip.
    await ui.press({ key: 'key:search' })
    await openChat(ui, 1001)
    const base = await stopsAbove(ui)
    expect(await ui.find({ key: 'search' })).toBeDefined()
    for (const steps of [['msg:677792'], ['msg:677792', 'key:agent'], ['msg:677792', 'key:inspect'], ['msg:677792', 'sheet:intent:raw'], ['key:agent']]) {
      for (const key of steps) await ui.press({ key })
      expect(await stopsAbove(ui)).toBe(base)
      while ((await ui.find({ key: 'sheet' })) !== undefined || (await ui.find({ key: 'targets' })) !== undefined || (await ui.find({ key: 'inspect' })) !== undefined || (await ui.find({ key: 'ap:card' })) !== undefined) {
        if ((await ui.find({ key: 'sheet:ask' })) !== undefined) await ui.input({ key: 'sheet:ask', text: '' })
        else await ui.press({ key: 'key:back' })
      }
      expect(await stopsAbove(ui)).toBe(base)
    }
    await ui.unmount()
  })
})

describe('the running strip comes and goes over the same ring stops (§4.3 rule 1, §5.6)', () => {
  /** What the ring's place depends on: the stops above the cursor row and the divider, and both windows. */
  async function place(ui: Ui) {
    const cursor = (await ui.findAll({ type: 'Button' })).find(button => button.props.autoFocus === true)
    const key = String(cursor?.props.key ?? '')
    return { key, before: await stopsBefore(ui, key), above: await stopsAbove(ui), messages: await rows(ui, 'msg:'), chats: await rows(ui, 'dialog:') }
  }

  // Several dock heights: the windows' rounding hides a lost row at some of them.
  const HEIGHTS = [30, 31, 32, 33].map(bodyRows => ({ ...DOCK, scroll: { offset: 0, bodyRows } }))

  for (const props of HEIGHTS) test(`${props.scroll.bodyRows} rows, the cursor in a long thread: p starts a follow, p stops it, /tg stop stops it; nothing above the cursor moves`, async ($, on) => {
    const { ui } = await openPane($, on, props, long)
    await openChat(ui, 1001)
    for (let i = 0; i < 4; i++) await ui.press({ key: 'key:up' })
    const base = await place(ui)
    expect(base.key).toBe('msg:700036')
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    await ui.press({ key: 'key:follow' })
    const strip = await ui.find({ key: 'running' })
    expect(strip?.text).toContain('⌁ @example_bot → main')
    expect(strip?.text).toContain('0: stop all')
    expect(await place(ui)).toEqual(base)
    await ui.press({ key: 'key:follow' })
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    expect(await place(ui)).toEqual(base)
    await ui.press({ key: 'key:follow' })
    await $.command.run(runTg('stop'))
    expect((await ui.find({ key: 'running' }))?.text).toBe('■ stopped: @example_bot')
    expect(await place(ui)).toEqual(base)
    await ui.unmount()
  })

  for (const props of HEIGHTS) test(`${props.scroll.bodyRows} rows, the cursor in a long Chats list: the strip going away keeps the rows above it`, async ($, on) => {
    const { ui, clock } = await openPane($, on, props, long)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    await ui.press({ key: 'key:back' })
    for (let i = 0; i < 5; i++) await ui.press({ key: 'key:down' })
    const base = await place(ui)
    expect(base.key).toBe('dialog:1006')
    await $.command.run(runTg('stop'))
    expect(await place(ui)).toEqual(base)
    // The notice goes after its 15 s; nothing moves then either.
    await clock.advance(15_000)
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    expect(await place(ui)).toEqual(base)
    await ui.unmount()
  })

  test('the strip draws no ring stop: 0 is the hidden key and the menu’s, never the bar’s in the dock', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    const strip = await ui.find({ key: 'running' })
    expect(strip).toBeDefined()
    expect(await ui.findAll({ type: 'Button' }).then(all => all.filter(one => String(one.props.key ?? '').startsWith('running')))).toEqual([])
    expect(await barKeys(ui)).not.toContain('stop')
    expect((await ui.find({ key: 'keys:hidden' }))?.text).toContain('stop all')
    expect((await hotkeys(ui)).filter(key => key === '0')).toEqual(['0'])
    await ui.press({ key: 'key:menu' })
    expect((await ui.find({ key: 'menu:stop' }))?.text).toBe('stop every agent and Worker · /tg stop')
    await ui.unmount()
  })

  test('inline: no strip, the header counts ⌁1 and the bar carries 0', async ($, on) => {
    const { ui } = await openPane($, on, INLINE)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('⌁1')
    expect(await barKeys(ui)).toContain('stop')
    await ui.unmount()
  })
})

describe('Activity (l, §5.7)', () => {
  test('running rows, the ring on the first; j moves it; ⏎ opens that chat; a row that stops stays, drawn stopped', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    await ui.press({ key: 'key:back' })
    await openChat(ui, 1002)
    await ui.press({ key: 'key:follow' })
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › activity')
    expect((await ui.find({ key: 'act:1001' }))?.text).toMatch(/^▸ ⌁ {2}@example_bot {3}follows → main · /)
    expect((await ui.find({ key: 'act:1001' }))?.props.autoFocus).toBe(true)
    expect(await barKeys(ui)).toEqual(['open', 'back', 'menu'])
    const above = await stopsBefore(ui, 'act:1002')
    await $.command.run(runTg('stop'))
    // Both rows stay, so nothing above the second one moved.
    expect((await ui.find({ key: 'act:1001' }))?.text).toContain('■  @example_bot   stopped')
    expect(await stopsBefore(ui, 'act:1002')).toBe(above)
    await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: 'act:1002' }))?.props.autoFocus).toBe(true)
    await ui.press({ key: 'act:1002' })
    expect(await ui.find({ key: 'activity' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › Dev Team')
    await ui.unmount()
  })

  test('h closes it; from the agent card, l closes the card and opens it', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1004)
    await ui.press({ key: 'key:agent' })
    expect(await ui.find({ key: 'ap:card' })).toBeDefined()
    await ui.press({ key: 'key:activity' })
    expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
    expect((await ui.find({ key: 'activity' }))?.text).toContain('Nothing runs.')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'activity' })).toBeUndefined()
    expect(await ui.find({ key: 'msg:92' })).toBeDefined()
    await ui.unmount()
  })
})

describe('states', () => {
  test('not logged in tells the person to run ! tg login', async ($, on) => {
    const { ui } = await openPane($, on, DOCK, () => failure(3, 'error: not logged in\n  fix: tg login'))
    expect(await ui.find({ type: 'Text', text: '! tg login' })).toBeDefined()
    expect(await ui.find({ key: 'reload' })).toBeDefined()
    // g is drawn by the error row; the hidden keys do not draw it twice.
    expect((await hotkeys(ui)).filter(key => key === 'g')).toEqual(['g'])
    await ui.unmount()
  })

  test('a flood wait counts down and retries', async ($, on) => {
    let calls = 0
    const { ui, clock } = await openPane($, on, DOCK, argv => {
      if (argv[1] !== 'dialogs') return json([])
      calls += 1
      return calls === 1 ? failure(5, 'error: FLOOD_WAIT 3s: Telegram asks to wait before retrying') : json(DIALOGS)
    })
    expect(await ui.find({ type: 'Text', text: 'Telegram asks to wait 3 s' })).toBeDefined()
    await clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: 'Telegram asks to wait 2 s' })).toBeDefined()
    await clock.advance(2000)
    expect(await ui.find({ key: 'dialog:1001' })).toBeDefined()
    await ui.unmount()
  })

  test('loading shows dim … rows', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    // No /tg yet: nothing loaded, so the list is in its loading state.
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
    expect(await ui.find({ key: 'loading' })).toBeDefined()
    await ui.unmount()
  })

  test('lenses filter and say how to leave an empty one', async ($, on) => {
    const { ui } = await openPane($, on, DOCK, argv => (argv[1] === 'dialogs' ? json(DIALOGS.filter(d => d.kind !== 'bot')) : json([])))
    await ui.press({ key: 'lens:bots' })
    expect(await ui.find({ type: 'Text', text: 'Press 1 for All' })).toBeDefined()
    await ui.press({ key: 'lens:unread' })
    expect(await ui.find({ key: 'dialog:1002' })).toBeDefined()
    expect(await ui.find({ key: 'dialog:1003' })).toBeUndefined()
    await ui.unmount()
  })

  test('s opens the search field; a search filters, an empty one clears', async ($, on) => {
    const { ui } = await openPane($, on)
    await ui.press({ key: 'key:search' })
    await ui.input({ key: 'search', text: 'dev' })
    expect(await ui.find({ key: 'dialog:1002' })).toBeDefined()
    expect(await ui.find({ key: 'dialog:1001' })).toBeUndefined()
    expect(await ui.find({ key: 'search' })).toBeUndefined()
    await ui.press({ key: 'key:search' })
    await ui.input({ key: 'search', text: '' })
    expect(await ui.find({ key: 'dialog:1001' })).toBeDefined()
    await ui.unmount()
  })

  test('a hot reload keeps this session’s mode, not the last one another session stored', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    const seen = world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg())
    await clock.settle()
    // $.store is shared by every session: another one's `/tg hide` lands here.
    seen.store.set('mode', 'hidden')
    // A hot reload fires session.start again; $.state kept this session's mode,
    // so the status line stays the open pane's, not Hidden's unread count.
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(seen.status.some(text => text?.includes('unread') === true)).toBe(false)
  })
})

describe('hidden mode', () => {
  test('/tg hidden before any list loaded shows the real status, not tg …', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const { status } = world(on, argv => (argv[1] === 'dialogs' ? json(DIALOGS) : json([])), { mode: 'open' })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(runTg('hidden'))
    await clock.settle()
    expect(status.at(-1)).toBe('tg ● 7 unread')
  })

  test('a dialog whose unread count grows raises the band; d dismisses it', async ($, on) => {
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
    expect(await band.find({ type: 'Text', text: 'Dev Team: "deploy is green"' })).toBeDefined()
    // o, d and ⏎ reach the band only once it holds the keys: the band says how.
    expect(await band.find({ type: 'Text', text: 'ctrl+x tab:' })).toBeDefined()
    expect((await band.find({ key: 'band:dismiss' }))?.props.hotkey).toBe('d')
    await band.press({ key: 'band:dismiss' })
    expect(status.at(-1)).toBe('tg ● 8 unread')
    await band.unmount()
  })
})
