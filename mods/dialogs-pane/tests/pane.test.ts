// The pane through the engine: /tg, the frame in both seats, the keys, the
// menu, the focus chip, and the states. tg is answered by a `process.run` hook beneath
// the plugin, so nothing runs. Design: docs/design/dialogs-pane-ux.md §4, §6, §7.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { KEYS, STRAY_KEYS, helpLines, hotkeyTable } from '../hooks/ui/keys'
import type { ApDraft, Autopilot, PeerRef, TgDialog, TgMessage } from '../types'
import { DIALOGS, MESSAGES, PERSON_MESSAGES, chatIds, chatKey, findChat, folderRun, messagesFor } from './fixtures'
import { FOOTER, HINT, bandKeyProblems, engineSites, siteText } from './surfaces'

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
  { id: 1004, kind: 'user', title: 'Contact A', username: null, unread: 1, mentions: 0, pinned: false, muted: false, last_id: 92, last_date: '2026-10-10T10:49:00Z', last_text: 'Can we call?' },
  { id: 1005, kind: 'channel', title: 'Announcements', username: null, unread: 0, mentions: 0, pinned: false, muted: false, last_id: 7, last_date: '2026-10-10T09:19:00Z', last_text: 'release' },
  { id: 1006, kind: 'bot', title: 'BotFather', username: 'BotFather', unread: 0, mentions: 0, pinned: false, muted: false, last_id: 3, last_date: '2026-10-08T09:00:00Z', last_text: 'Done!' },
]

type Ui = Mounted<'terminal', 'Pane'>

type World = {
  opened: string[]
  closed: string[]
  status: (string | undefined)[]
  toasts: string[]
  store: Map<string, unknown>
  /** What /tg registered: its description and argument hint list the subcommands. */
  registered: { description: string; argumentHint?: string }[]
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
  const seen: World = { opened: [], closed: [], status: [], toasts: [], store: new Map(Object.entries(store)), registered: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  // `tg folders`: the chats `tg dialogs` answers, as one All chats folder (an account without folders).
  on('process.run', (_$, e) => ({ value: e.argv[1] === 'folders' ? folderRun(e.argv, tg(['tg', 'dialogs', '--limit', '50', '--json'])) : tg(e.argv) }))
  on('command.register', (_$, e) => {
    seen.registered.push(e)
    return { value: { command: e.name } }
  })
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
  // `t`'s summary: the model's answer, the same for every chat.
  on('model.complete', () => ({ value: { isAnswered: true, text: '- they ask to call\n- at 10 tomorrow', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
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
/** The keys the view binds to something, by hotkey: every Button but the catch-all's (`stray:`), which say where a key works. */
async function hotkeys(ui: Ui): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.flatMap(button => (typeof button.props.hotkey === 'string' && button.key?.startsWith('stray:') !== true ? [button.props.hotkey] : []))
}

/** Every hotkey drawn, the catch-all's included. */
async function allHotkeys(ui: Ui): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).flatMap(button => (typeof button.props.hotkey === 'string' ? [button.props.hotkey] : []))
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

/** The strip's tabs as written: text, not ring stops (a Text keeps no key, so they are read off the strip's first Box). */
async function tabsOf(ui: Ui): Promise<string[]> {
  const strip = (await ui.find({ key: 'strip' })) as { children?: { children?: { type?: string; children?: unknown[] }[] }[] } | undefined
  return (strip?.children?.[0]?.children ?? []).flatMap(one => (one.type === 'Text' && typeof one.children?.[0] === 'string' ? [one.children[0]] : []))
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
  await ui.press({ key: await chatKey(ui, id) })
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
      expect((await findChat(ui, 1001))?.text).toContain('@example_bot')
      expect((await findChat(ui, 1003))?.text).toContain('Saved Messages')
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
    // An account without folders: All chats, then the pane's views; digits are live in Chats (§4.7).
    expect(await tabsOf(ui)).toEqual(['1: ‹All chats 3›', '2: For you', '3: Bots'])
    expect((await ui.find({ key: 'digit:1' }))?.props.hotkey).toBe('1')
    expect(await barKeys(ui)).toEqual(['open', 'back', 'summary', 'watch', 'agent', 'menu'])
    await openChat(ui, 1001)
    // Chats stay on screen above the thread; the open chat's row is marked.
    expect((await findChat(ui, 1001))?.text).toContain('›')
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('Something went wrong')
    expect(await ui.find({ type: 'Text', text: '@example_bot · bot' })).toBeDefined()
    // In the chat the strip's digits are not live: only the active column's are.
    expect(await ui.find({ key: 'digit:1' })).toBeUndefined()
    expect(await tabsOf(ui)).toEqual(['‹All chats 3›', 'For you', 'Bots'])
    expect(await barKeys(ui)).toEqual(['send', 'write', 'record', 'mark', 'agent', 'menu'])
    await ui.unmount()
  })

  test('inline: one view at a time, the strip in the header, h: chats in the bar', async ($, on) => {
    const { ui } = await openPane($, on, INLINE)
    expect((await ui.find({ key: 'header' }))?.text).toContain('1: ‹All chats 3›')
    expect(await barKeys(ui)).toEqual(['open', 'back', 'search', 'summary', 'watch', 'agent', 'menu'])
    await openChat(ui, 1001)
    expect(await findChat(ui, 1001)).toBeUndefined()
    expect(await ui.find({ key: 'strip' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › @example_bot')
    expect((await ui.find({ key: 'key:back' }))?.text).toContain('chats')
    expect(await barKeys(ui)).toContain('back')
    await ui.press({ key: 'key:back' })
    expect(await findChat(ui, 1001)).toBeDefined()
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
    expect(await findChat(ui, 1002)).toBeDefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
    // From the chat, h moves the cursor up to Chats; the chat stays open below.
    await ui.press({ key: 'key:back' })
    expect((await findChat(ui, 1001))?.text).toContain('▸')
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
    // T4b's layers: the send box and the search field in the bar's row, the summary over the lower part, marks on the bar.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        { name: `send box ${seat}`, props, steps: ['dialog:1001', 'key:write'] },
        { name: `search from a chat ${seat}`, props, steps: ['dialog:1001', 'key:search'] },
        { name: `summary ${seat}`, props, steps: ['dialog:1004', 'key:summary'] },
        { name: `summary menu ${seat}`, props, steps: ['dialog:1004', 'key:summary', 'key:menu'] },
        { name: `marked, range open ${seat}`, props, steps: ['dialog:1001', 'key:mark', 'key:up', 'key:range'] },
      ]
    }),
    // T9: the Folders list, For you and Bots, in both seats, and over them the menu.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        { name: `folders ${seat}`, props, steps: ['key:back'] },
        { name: `folders menu ${seat}`, props, steps: ['key:back', 'key:menu'] },
        { name: `for you ${seat}`, props, steps: ['key:foryou'] },
        { name: `for you menu ${seat}`, props, steps: ['key:foryou', 'key:menu'] },
        { name: `bots ${seat}`, props, steps: ['digit:3'] },
        { name: `a chat from bots ${seat}`, props, steps: ['digit:3', 'dialog:1001'] },
      ]
    }),
  ]

  for (const view of VIEWS) {
    test(`${view.name}: each of a–z and 0–9 has exactly one Button; the bound ones are the table's; the bar holds ≤ 7`, async ($, on) => {
      const { ui } = await openPane($, on, view.props)
      for (const key of view.steps) await ui.press({ key: key.startsWith('dialog:') ? await chatKey(ui, Number(key.slice('dialog:'.length))) : key })
      const drawn = await hotkeys(ui)
      for (const key of drawn) expect(/^[0-9]$/.test(key) || owners.has(key)).toBe(true)
      // Nothing falls through to the prompt (the T9 review's M1): what the view does not bind, the catch-all does, once.
      const every = await allHotkeys(ui)
      expect(every.filter((key, index) => every.indexOf(key) !== index)).toEqual([])
      expect([...every].sort()).toEqual([...STRAY_KEYS].sort())
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
    // Since T4b nothing rides on top of the list: the search field is a layer in the bar's row.
    await openChat(ui, 1001)
    const base = await stopsAbove(ui)
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
    expect(chatIds([base.key])).toEqual([1006])
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

/**
 * What the autopilot would have written, put into the pane's next write of
 * it: only the owner writes its state (host rule), and a hook beneath its
 * `state.set` may rewrite the value. `/tg stop` with nothing running is that
 * write, and changes nothing else.
 */
function autopilotWriter(on: On) {
  let change: ((value: Autopilot) => Autopilot) | null = null
  on('state.set', (_$, e, next) =>
    // The pane's own value, typed by its contract: Autopilot for this key.
    next(change !== null && e.plugin === PLUGIN && e.key === 'autopilot' ? { ...e, value: change(e.value as Autopilot) } : e),
  )
  return async ($: Engine, fn: (value: Autopilot) => Autopilot) => {
    change = fn
    await $.command.run(runTg('stop'))
    change = null
  }
}

/** Contact A's and Dev Team's drafts, Dev Team's undo window and summary: four items of the band, as the autopilot writes them. */
async function fillBand($: Engine, write: ReturnType<typeof autopilotWriter>): Promise<void> {
  const contact: PeerRef = { id: 1004, arg: '1004', label: 'Contact A', kind: 'user' }
  const group: PeerRef = { id: 1002, arg: '1002', label: 'Dev Team', kind: 'supergroup' }
  const draft = (seq: number, peer: PeerRef, text: string): ApDraft => ({ seq, peer, incoming: 'Can we call tomorrow at 10?', text, confidence: 0.62, reasons: ['dates'], state: { kind: 'ready' } })
  const now = Date.parse('2026-10-10T12:00:00Z')
  await write($, value => ({
    ...value,
    drafts: [draft(1, contact, 'Tomorrow is packed, can I write after 18?'), draft(2, group, 'Merging after lunch.')],
    undo: { seq: 3, peer: group, ids: [900], text: 'Merged, thanks', confidence: 0.93, until: now + 30_000 },
    notes: [{ seq: 4, peer: group, text: 'Release moved to Friday.' }],
    now,
  }))
}

const BAND_SITE: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

/** The band's Buttons in document order, and the rows it draws (a `display: none` Box draws none). */
async function bandShape(band: Mounted<'terminal', 'AbovePrompt'>) {
  const buttons = await band.findAll({ type: 'Button' })
  const root = (await band.drawn()) as { children?: { props?: { display?: string } }[] }
  return {
    first: buttons[0]?.props.key,
    isFirstRinged: buttons[0]?.props.autoFocus === true,
    hotkeys: buttons.flatMap(button => (typeof button.props.hotkey === 'string' ? [button.props.hotkey] : [])),
    rows: (root.children ?? []).filter(child => child.props?.display !== 'none').length,
  }
}

describe('rows that come and go keep the windows still (§4.3 rule 1, T4b)', () => {
  /** Contact A's thread, 40 messages long, theirs: Draft reply is one of its intents. */
  const PERSON_LONG: TgMessage[] = LONG.map(message => ({ ...message, chat_id: 1004, sender: fixture(PERSON_MESSAGES[1]).sender, out: false }))
  const stable = (argv: readonly string[]) =>
    argv[1] === 'read'
      ? json(argv[2] === '1004' ? PERSON_LONG : LONG)
      : argv[1] === 'dialogs'
        ? json(MANY)
        : argv[1] === 'send'
          ? failure(1, 'error: the fake refuses sends')
          : happy(argv)

  // Several heights of each seat: the windows' rounding hides a lost row at some of them.
  const SEATS = [
    ...[30, 31, 32, 33].map(bodyRows => ({ name: `dock ${bodyRows} rows`, props: { ...DOCK, scroll: { offset: 0, bodyRows } } })),
    ...[11, 12, 13].map(bodyRows => ({ name: `inline ${bodyRows} rows`, props: { ...INLINE, scroll: { offset: 0, bodyRows } } })),
  ]

  /** The pane with main and its turns answered beneath it. */
  async function openStable($: Engine, on: On, props: RenderPropsOf['Pane']) {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('ui.invalidate', () => ({ value: undefined }))
    return openPane($, on, props, stable)
  }

  /** The ring's place: the cursor row's key, the stops before it, and the first row of each window. */
  async function place(ui: Ui) {
    const buttons = (await ui.findAll({ type: 'Button' })).map(one => ({ key: String(one.props.key ?? ''), isFocus: one.props.autoFocus === true }))
    const key = buttons.find(one => one.isFocus && (one.key.startsWith('msg:') || one.key.startsWith('dialog:')))?.key ?? ''
    return { key, before: await stopsBefore(ui, key), message: (await rows(ui, 'msg:'))[0], chat: (await rows(ui, 'dialog:'))[0] }
  }

  /** Under a layer that holds the ring no row of a list is a ring stop; `alsoChats`: the list's rows too. */
  async function expectStatic(ui: Ui, alsoChats: boolean): Promise<void> {
    const keys = (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key ?? ''))
    expect(keys.filter(key => key.startsWith('msg:') || key.startsWith('btn:') || (alsoChats && key.startsWith('dialog:')))).toEqual([])
  }

  /** ⏎ on the newest message, Draft reply to main, main answers: the draft waits. */
  async function landDraft($: Engine, ui: Ui, beforeLanding: () => Promise<void> = async () => undefined): Promise<void> {
    await ui.press({ key: 'msg:700040' })
    await ui.press({ key: 'sheet:intent:draft_reply' })
    await $.turn.start({ text: '', turnId: 't-1' })
    await beforeLanding()
    await $.turn.complete({ answer: 'Sure, 10 works.', durationMs: 1, isAborted: false, turnId: 't-1', reason: 'answer' })
  }

  /**
   * Terminal rows a drawn tree takes, as the frame lays it out: a column Box
   * stacks its children, a row Box, a Button, a Text or an Input is one row, a
   * Box drawn `display: none` none. The kit lays nothing out, so this stands in
   * for the engine's fit of an inline frame to its tree (§7.3).
   */
  function rowsOf(node: unknown): number {
    if (typeof node !== 'object' || node === null) return 0
    const { type, props, children } = node as { type?: unknown; props?: { display?: unknown; flexDirection?: unknown }; children?: unknown }
    if (props?.display === 'none') return 0
    if (type === 'Box' && props?.flexDirection === 'column') return Array.isArray(children) ? children.reduce((sum: number, child) => sum + rowsOf(child), 0) : 0
    return 1
  }

  for (const bodyRows of [11, 12, 13]) {
    test(`inline ${bodyRows} rows, 60 chats: a notice shows and the frame still fits the room (the chrome counts its row)`, async ($, on) => {
      const { ui } = await openStable($, on, { ...INLINE, scroll: { offset: 0, bodyRows } })
      // No notice: its row is left free, and the engine fits the frame to what it holds.
      expect(rowsOf(await ui.drawn())).toBe(bodyRows - 1)
      await openChat(ui, 1004)
      await ui.press({ key: 'key:follow' })
      await ui.press({ key: 'key:back' })
      await $.command.run(runTg('stop'))
      expect((await ui.find({ key: 'notice' }))?.text).toBe('■ stopped: Contact A')
      // The list fills its room, so a notice the chrome did not count would push the bar past it.
      expect(rowsOf(await ui.drawn())).toBe(bodyRows)
      await ui.unmount()
    })
  }

  for (const seat of SEATS) {
    const inline = seat.props.placement === 'inline'
    test(`${seat.name}, the cursor on the newest of 40 messages: x, n (send, empty), s, t, a draft; nothing above the cursor moves`, async ($, on) => {
      const { ui, clock } = await openStable($, on, seat.props)
      await openChat(ui, 1004)
      const base = await place(ui)
      expect(base.key).toBe('msg:700040')
      // x: the marks ride the bar's row.
      await ui.press({ key: 'key:mark' })
      expect((await ui.find({ key: 'bar' }))?.text).toContain('▪ 1 marked')
      expect(await place(ui)).toEqual(base)
      await ui.press({ key: 'key:back' })
      // n, a send: the box is in the bar's row, the thread under it static; its notice takes no row of the thread.
      await ui.press({ key: 'key:write' })
      await expectStatic(ui, true)
      await ui.input({ key: 'bt:send', text: 'hello' })
      await clock.settle()
      expect(await ui.find({ key: 'notice' })).toBeDefined()
      expect(await place(ui)).toEqual(base)
      await ui.press({ key: 'key:dismiss' })
      expect(await ui.find({ key: 'notice' })).toBeUndefined()
      // Without d, a notice leaves after 15 s.
      await ui.press({ key: 'key:write' })
      await ui.input({ key: 'bt:send', text: 'again' })
      await clock.settle()
      expect(await ui.find({ key: 'notice' })).toBeDefined()
      await clock.advance(15_000)
      expect(await ui.find({ key: 'notice' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // n, ⏎ on the empty box: it closes.
      await ui.press({ key: 'key:write' })
      await ui.input({ key: 'bt:send', text: '' })
      expect(await ui.find({ key: 'bt:send' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // s, ⏎ on the field as it opened: it closes, and the cursor stays in the chat.
      await ui.press({ key: 'key:search' })
      await expectStatic(ui, true)
      await ui.input({ key: 'search', text: '' })
      expect(await ui.find({ key: 'search' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // t: the summary is a layer over the lower part; it lands; h closes it.
      await ui.press({ key: 'key:summary' })
      await clock.settle()
      expect((await ui.find({ key: 'summary' }))?.text).toContain('at 10 tomorrow')
      await expectStatic(ui, inline)
      await ui.press({ key: 'key:back' })
      expect(await ui.find({ key: 'summary' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // A drafted reply lands: it waits behind its notice; e opens it as a layer, h closes it and it waits on.
      await landDraft($, ui)
      expect((await ui.find({ key: 'notice' }))?.text).toBe('✎ draft for Contact A waits · e: open')
      expect(await place(ui)).toEqual(base)
      await ui.press({ key: 'key:edit' })
      expect((await ui.find({ key: 'draft' }))?.text).toContain('reply to #700040 in Contact A')
      await expectStatic(ui, inline)
      await ui.press({ key: 'key:back' })
      expect(await ui.find({ key: 'draft' })).toBeUndefined()
      expect((await ui.find({ key: 'notice' }))?.text).toBe('✎ draft for Contact A waits · e: open')
      expect(await place(ui)).toEqual(base)
      await ui.unmount()
    })

    test(`${seat.name}, the cursor mid-way down 60 chats: s, a notice, a draft landing, e and h; nothing above the cursor moves`, async ($, on) => {
      const { ui } = await openStable($, on, seat.props)
      await openChat(ui, 1004)
      await ui.press({ key: 'key:follow' })
      await landDraft($, ui, async () => {
        await ui.press({ key: 'key:back' })
        for (let i = 0; i < 5; i++) await ui.press({ key: 'key:down' })
      })
      // The draft landed while the cursor was in Chats: compare from there on.
      const base = await place(ui)
      expect(base.key).toMatch(/^dialog:/)
      expect((await ui.find({ key: 'notice' }))?.text).toBe('✎ draft for Contact A waits · e: open')
      await ui.press({ key: 'key:search' })
      await expectStatic(ui, true)
      await ui.input({ key: 'search', text: '' })
      expect(await place(ui)).toEqual(base)
      // A notice arrives with no key pressed in the pane: /tg stop says what it stopped.
      await $.command.run(runTg('stop'))
      expect((await ui.find({ key: 'notice' }))?.text).toBe('■ stopped: Contact A')
      expect(await place(ui)).toEqual(base)
      await ui.press({ key: 'key:edit' })
      expect(await ui.find({ key: 'draft' })).toBeDefined()
      await ui.press({ key: 'key:back' })
      expect(await place(ui)).toEqual(base)
      await ui.unmount()
    })

    test(`${seat.name}, the cursor on the newest of 40 messages: the band filling and the footer changing move nothing above it (T5)`, async ($, on) => {
      engineSites(on)
    const write = autopilotWriter(on)
      const { ui } = await openStable($, on, seat.props)
      await openChat(ui, 1004)
      const base = await place(ui)
      const footer = await siteText($, FOOTER)
      // What lands outside the pane while the cursor stays: two drafts, an undo window, a summary.
      await fillBand($, write)
      expect(await siteText($, FOOTER)).not.toBe(footer)
      expect(await siteText($, HINT)).toBe('? for shortcuts | tg: 2 for you · ctrl+x tab')
      expect(await place(ui)).toEqual(base)
      // The window keeps its first row and the ring its stop as the band empties again.
      await write($, value => ({ ...value, drafts: [], undo: null, notes: [] }))
      expect(await siteText($, HINT)).toBe('? for shortcuts')
      expect(await place(ui)).toEqual(base)
      await ui.unmount()
    })
  }
})

describe('outside the pane: the band, the footer, the transcript, /tg (§4.1, §4.5, §8 T5)', () => {
  test('the band is one queue: an item at a time, most urgent first, two rows each; j and k walk it and ⏎ is always the first stop', async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui } = await openPane($, on)
    await fillBand($, write)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_SITE })
    const seen: string[] = []
    // j round the whole queue and back to the first.
    for (let step = 0; step <= 5; step++) {
      const shape = await bandShape(band)
      seen.push(String(shape.first))
      // The ring keeps its place among the Buttons (§1): ⏎'s Button first in every item, so it stays on ⏎ (§4.3).
      expect(shape.isFirstRinged).toBe(true)
      expect(shape.rows).toBe(2)
      // One Button per hotkey, each the table's band meaning; no digits in the band (§10).
      expect(await bandKeyProblems(band)).toEqual([])
      expect(await band.find({ type: 'Text', text: `${(step % 4) + 1}/4  j: next` })).toBeDefined()
      await band.press({ key: 'band:next' })
    }
    // Drafts first (for you), then the undo window, then the summary; j wraps.
    expect(seen).toEqual(['ap:draft:send', 'ap:draft:send', 'ap:band:undo-press', 'ap:note:open', 'ap:draft:send', 'ap:draft:send'])
    // Six j's put it on the undo window; k goes back one, j forward two to the summary.
    expect((await bandShape(band)).first).toBe('ap:band:undo-press')
    await band.press({ key: 'band:prev' })
    expect(await band.find({ type: 'Text', text: '2/4  j: next' })).toBeDefined()
    await band.press({ key: 'band:next' })
    await band.press({ key: 'band:next' })
    expect(await band.find({ type: 'Text', text: 'Dev Team: Release moved to Friday.' })).toBeDefined()
    // d on the summary: it leaves, the queue shrinks, and ⏎ is the first stop of what shows next.
    await band.press({ key: 'ap:note:dismiss' })
    expect(await band.find({ type: 'Text', text: '1/3  j: next' })).toBeDefined()
    expect((await bandShape(band)).isFirstRinged).toBe(true)
    await band.unmount()
    await ui.unmount()
  })

  test('what the pane draws leaves the band: For you holds the drafts and the undo window', async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui } = await openPane($, on)
    await fillBand($, write)
    expect(await siteText($, HINT)).toBe('? for shortcuts | tg: 2 for you · ctrl+x tab')
    await ui.press({ key: 'key:foryou' })
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_SITE })
    expect((await bandShape(band)).first).toBe('ap:note:open')
    expect(await band.find({ type: 'Text', text: /j: next/ })).toBeUndefined()
    await band.unmount()
    await ui.unmount()
  })

  test('the footer label per state: the summary with the unread chats that are not muted; the status line stays clear', async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui, seen } = await openPane($, on)
    expect(await siteText($, FOOTER)).toBe('focus & tg 3')
    await fillBand($, write)
    expect(await siteText($, FOOTER)).toBe('focus & tg 3 · 2 for you')
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    expect(await siteText($, FOOTER)).toBe('focus & tg 3 · ⌁1 · 2 for you')
    expect(seen.status.filter(text => text !== undefined)).toEqual([])
    await ui.unmount()
  })

  test("only this plugin's packets become one row; ctrl+o shows the whole packet", async ($, on) => {
    engineSites(on)
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const { ui, clock } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'msg:677791' })
    await ui.press({ key: 'sheet:intent:fix' })
    await clock.settle()
    const packet = prompts[0] ?? ''
    expect(packet).toMatch(/^<tg-packet /)
    const row = (props: RenderPropsOf['UserMessage']) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'UserMessage', props })
    const ours: RenderPropsOf['UserMessage'] = { text: packet, origin: { kind: 'plugin', name: PLUGIN }, isExpanded: false }
    const one = await row(ours)
    expect((await one.find({ type: 'Text' }))?.text).toBe('▣ tg packet → main · Fix · @example_bot #677791 (+1 parent, 3 masked)   ctrl+o shows it')
    await one.unmount()
    for (const props of [
      { ...ours, isExpanded: true },
      { ...ours, origin: { kind: 'plugin', name: 'another-plugin' } },
      { ...ours, origin: { kind: 'plugin', name: PLUGIN, asUser: true } },
      { ...ours, origin: { kind: 'composer' } },
    ] satisfies RenderPropsOf['UserMessage'][]) {
      const shown = await row(props)
      expect((await shown.find({ type: 'Text' }))?.text).toBe(packet)
      await shown.unmount()
    }
    await ui.unmount()
  })

  test('/tg help is the key table, /tg status the summary and what runs, each a card; the command lists them', async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui, seen } = await openPane($, on)
    expect(seen.registered[0]?.argumentHint).toContain('status|help')
    expect(seen.registered[0]?.description).toContain('/tg status · /tg help')
    const help = await $.command.run(runTg('help'))
    expect(help.text).toBe(helpLines().join('\n'))
    await fillBand($, write)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    const status = await $.command.run(runTg('status'))
    expect(status.text?.split('\n')).toEqual([
      'tg status',
      'tg 3 · ⌁1 · 2 for you',
      'running',
      // The test's world spawns no `tg watch`, so the follow reads failed.
      '  ⌁  @example_bot   follows → main · failed',
      'watching  nothing',
      'waiting',
      '  ✎ draft for Contact A: "Tomorrow is packed, can I write after 18?"',
      '  ✎ draft for Dev Team: "Merging after lunch."',
      '  ⟳ Dev Team replied "Merged, thanks" · u: undo 30s',
      '  ◉ Dev Team: Release moved to Friday.',
    ])
    // The engine hands the row its text under the plugin's name (seen live); the card's title is the command's own.
    for (const args of ['help', 'status']) {
      const card = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'CommandOutput', props: { command: 'tg', args, text: `dialogs-pane: ${args === 'help' ? (help.text ?? '') : (status.text ?? '')}`, isErrored: false } })
      const drawn = await card.drawn()
      expect(drawn).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
      expect(await card.find({ type: 'Text', text: args === 'help' ? 'tg keys · one meaning per letter, in every view and in the band' : 'tg status' })).toBeDefined()
      await card.unmount()
    }
    // Any other /tg answer is the engine's own row.
    const other = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'CommandOutput', props: { command: 'tg', args: 'stop', text: 'tg: nothing was running.', isErrored: false } })
    expect((await other.find({ type: 'Text' }))?.text).toBe('tg: nothing was running.')
    await other.unmount()
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

  test('loading shows dim … rows', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    // No /tg yet: nothing loaded, so the list is in its loading state.
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
    expect(await ui.find({ key: 'loading' })).toBeDefined()
    await ui.unmount()
  })

  test('s searches every chat with tg dialogs --query; an empty search goes back to the folder', async ($, on) => {
    const searched = (argv: readonly string[]) => {
      const query = argv.includes('--query') ? argv[argv.indexOf('--query') + 1]?.toLowerCase() : undefined
      return argv[1] === 'dialogs' && query !== undefined ? json(KINDS.filter(one => one.title.toLowerCase().includes(query))) : happy(argv)
    }
    const { ui } = await openPane($, on, DOCK, searched)
    await ui.press({ key: 'key:search' })
    await ui.input({ key: 'search', text: 'dev' })
    expect(await findChat(ui, 1002)).toBeDefined()
    expect(await findChat(ui, 1001)).toBeUndefined()
    expect(await ui.find({ key: 'search' })).toBeUndefined()
    await ui.press({ key: 'key:search' })
    await ui.input({ key: 'search', text: '' })
    expect(await findChat(ui, 1001)).toBeDefined()
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
  const BAND: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} }

  test('/tg hidden before any list loaded: the footer counts unread chats that are not muted, the status line stays clear', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    engineSites(on)
    // A muted chat's unread would bury the rest (§4.5): Dev Team, muted, is left out.
    const { status } = world(on, argv => (argv[1] === 'dialogs' ? json(DIALOGS.map(d => (d.id === 1002 ? { ...d, muted: true } : d))) : json([])), { mode: 'open' })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(await siteText($, FOOTER)).toBe('focus & tg …')
    await $.command.run(runTg('hidden'))
    await clock.settle()
    expect(await siteText($, FOOTER)).toBe('focus & tg 1')
    expect(status.at(-1)).toBeUndefined()
  })

  test('not logged in: the footer says so and the status line holds the alarm; a later answer clears it', async ($, on) => {
    let isOut = true
    const clock = mock.clock(on, { now: 0 })
    engineSites(on)
    const { status } = world(on, argv => (argv[1] === 'dialogs' && isOut ? failure(3, 'error: not logged in\n') : happy(argv)), { mode: 'hidden' })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(status.at(-1)).toBe('tg ⚠ not logged in: ! tg login')
    expect(await siteText($, FOOTER)).toBe('focus & tg ⚠ not logged in')
    isOut = false
    await clock.advance(300_000)
    expect(status.at(-1)).toBeUndefined()
    expect(await siteText($, FOOTER)).toBe('focus & tg 3')
  })

  test("a watched chat whose unread count grows raises the band; a group's news opens (who wrote is unknown); d dismisses it", async ($, on) => {
    let unread = 5
    const clock = mock.clock(on, { now: 0 })
    engineSites(on)
    const watched = [{ id: 1002, arg: '1002', label: 'Dev Team', kind: 'supergroup' }]
    const { status } = world(on, argv => (argv[1] === 'dialogs' ? json(DIALOGS.map(d => (d.id === 1002 || d.id === 1001 ? { ...d, unread: d.unread + (unread - 5) } : d))) : json([])), {
      mode: 'hidden',
      'triage.watched': watched,
    })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(await siteText($, HINT)).toBe('? for shortcuts')
    unread = 6
    // The slow poll: watched dialogs are live through tg watch, the rest every 5 min.
    await clock.advance(300_000)
    expect(status.at(-1)).toBeUndefined()
    expect(await siteText($, HINT)).toBe('? for shortcuts | tg: 1 waiting · ctrl+x tab')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
    // The bot's count grew too, but it is not watched: only Dev Team's news reaches the band.
    expect(await band.find({ type: 'Text', text: '● Dev Team: "deploy is green"' })).toBeDefined()
    expect((await band.find({ key: 'band:main' }))?.text).toBe('⏎ open')
    // o, d and ⏎ reach the band only once it holds the keys: the band says how.
    expect(await band.find({ type: 'Text', text: '  ctrl+x tab ›' })).toBeDefined()
    expect((await band.find({ key: 'band:dismiss' }))?.props.hotkey).toBe('d')
    await band.press({ key: 'band:dismiss' })
    expect(await siteText($, HINT)).toBe('? for shortcuts')
    await band.unmount()
  })
})
