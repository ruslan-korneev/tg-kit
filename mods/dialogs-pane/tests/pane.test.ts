// The pane through the engine: /tg, the frame in both seats, the keys, the
// menu, the focus chip, and the states. tg is answered by a `process.run` hook beneath
// the plugin, so nothing runs. Design: docs/design/dialogs-pane-ux.md §4, §6, §7.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { KEYS, STRAY_KEYS, helpLines, hotkeyTable } from '../hooks/ui/keys'
import { defaultDialog } from '../hooks/autopilot/config'
import { PALETTES } from '../hooks/ui/palette'
import type { ApDraft, Autopilot, PeerRef, TgDialog, TgMessage } from '../types'
import { DIALOGS, LEGEND_TEXT, STARTED, MESSAGES, PERSON_MESSAGES, borderOf, chatIds, chatKey, cornerOf, findChat, folderRun, legendOf, messagesFor, reachChat, tabsOf, titleOf } from './fixtures'
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
  /** Whether the engine placed the pane: false is a terminal too narrow for it. */
  isPlaced: boolean
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
  const seen: World = { opened: [], closed: [], status: [], toasts: [], store: new Map(Object.entries({ ...STARTED, ...store })), registered: [], isPlaced: true }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  // `tg folders`: the chats `tg dialogs` answers, as one All chats folder (an account without folders).
  // git: the session's directory is no repo, so delegate's grant starts with no repos.
  on('process.run', (_$, e) =>
    e.argv[0] === 'git'
      ? { value: failure(128, 'fatal: not a git repository') }
      : { value: e.argv[1] === 'folders' ? folderRun(e.argv, tg(['tg', 'dialogs', '--limit', '50', '--json'])) : tg(e.argv) },
  )
  on('session.cwd', () => ({ value: '/tmp' }))
  // Starting an agent takes the chat's lease, named by the session (delegate's lease, at every rung).
  on('session.id', () => ({ value: 'session-a' }))
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
  // The panes this world opened and did not close, placed and shown unless a test says otherwise.
  const isOpen = (id: string) => seen.opened.filter(one => one === id).length > seen.closed.filter(one => one === id).length
  on('ui.panes', () => ({ value: [...new Set(seen.opened)].filter(isOpen).map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: seen.isPlaced })) }))
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

/** A first open: the store has no `d` for the start block (§8 T7). */
const FIRST_OPEN: Record<string, unknown> = { 'start.dismissed': undefined }

async function openPane($: Engine, on: On, props = DOCK, tg = happy, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
  const seen = world(on, tg, store)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(runTg())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props })
  return { clock, seen, ui }
}

/** ⏎ on a chat's row in Chats, moving the cursor to it first when the window does not hold it. */
async function openChat(ui: Ui, id: number): Promise<void> {
  await ui.press({ key: await reachChat(ui, id) })
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
      expect((await ui.find({ key: 'header' }))?.text).toBe('TG · 3 UNREAD')
      expect(await titleOf(ui, 'card:chats')).toBe('CHATS  All chats 3  For you  Bots')
      expect((await findChat(ui, 1001))?.text).toContain('Example Bot')
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

  test('dock: CHATS with the folder tabs in its title, and the open chat in a card below (§10.5)', async ($, on) => {
    const { ui } = await openPane($, on)
    // An account without folders: All chats, then the pane's views; no digit is drawn, the current tab is accent and bold (§4.7).
    expect(await tabsOf(ui)).toEqual(['All chats 3', 'For you', 'Bots'])
    expect((await ui.find({ key: 'digit:1' }))?.props.hotkey).toBe('1')
    expect(await cornerOf(ui, 'card:chats')).toBe('1-3 folders')
    // The key line holds what fits 64 columns, m last; a: agent waits in the menu and on its hotkey.
    expect(await barKeys(ui)).toEqual(['open', 'back', 'search', 'summary', 'watch', 'menu'])
    await openChat(ui, 1001)
    // CHATS keeps three rows above the chat's card; the open chat's row is marked.
    expect((await rows(ui, 'dialog:')).length).toBe(3)
    expect((await findChat(ui, 1001))?.text).toContain('›')
    expect((await ui.find({ key: 'msg:677791' }))?.text).toContain('Something went wrong')
    expect(await titleOf(ui, 'card:chat')).toBe('⬡ Example Bot · @example_bot')
    // In the chat the digits are not live: only the active column's are, and the corner says so.
    expect(await ui.find({ key: 'digit:1' })).toBeUndefined()
    expect(await cornerOf(ui, 'card:chats')).toBeUndefined()
    // The cursor on "Main menu", a second reply to /settings: f has its pair and joins before x (§8 T6).
    expect(await barKeys(ui)).toEqual(['send', 'write', 'record', 'diff', 'mark', 'menu'])
    await ui.unmount()
  })

  test('inline: one view at a time, its card titled after it, h: chats in the key line', async ($, on) => {
    const { ui } = await openPane($, on, INLINE)
    expect((await ui.find({ key: 'header' }))?.text).toBe('TG · 3 UNREAD')
    expect(await tabsOf(ui)).toEqual(['All chats 3', 'For you', 'Bots'])
    expect(await barKeys(ui)).toEqual(['open', 'back', 'search', 'summary', 'watch', 'agent', 'menu'])
    await openChat(ui, 1001)
    expect(await findChat(ui, 1001)).toBeUndefined()
    expect(await ui.find({ key: 'card:chats' })).toBeUndefined()
    expect(await titleOf(ui, 'card:chat')).toBe('⬡ Example Bot · @example_bot')
    expect((await ui.find({ key: 'key:back' }))?.text).toContain('chats')
    expect(await barKeys(ui)).toContain('back')
    await ui.press({ key: 'key:back' })
    expect(await findChat(ui, 1001)).toBeDefined()
    await ui.unmount()
  })

  test('focus by colour (§10.5): the cursor card accent while the pane holds the keys; without them every border surface, and ctrl+x tab: keys leads a dim key line', async ($, on) => {
    const { ui } = await openPane($, on)
    const theme = PALETTES.theme
    expect(await borderOf(ui, 'card:chats')).toBe(theme.accent)
    expect((await ui.find({ key: 'bar' }))?.text).not.toContain('ctrl+x tab: keys')
    expect((await ui.find({ key: 'key:menu' }))?.props.dimColor).toBe(false)
    await openChat(ui, 1001)
    // ▸ moved into the chat: its card is lit, CHATS takes its section's role.
    expect(await borderOf(ui, 'card:chat')).toBe(theme.accent)
    expect(await borderOf(ui, 'card:chats')).toBe(theme.person)
    await ui.redraw({ ...DOCK, isFocused: false })
    expect(await borderOf(ui, 'card:chat')).toBe(theme.surface)
    expect(await borderOf(ui, 'card:chats')).toBe(theme.surface)
    expect((await ui.find({ key: 'bar' }))?.text).toMatch(/^ctrl\+x tab: keys/)
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('keys')
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
    expect(await titleOf(ui, 'card:chat')).toBe('⬡ Example Bot · @example_bot')
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
    // From the chat, h moves the cursor up to Chats: the dock's sections come back, the chat stays loaded, marked on its row
    // only by ▸ now, and ⏎ brings its card back (§10.5, the layout follows the cursor).
    await ui.press({ key: 'key:back' })
    expect((await findChat(ui, 1001))?.text).toContain('▸')
    expect(await ui.find({ key: 'card:chat' })).toBeUndefined()
    expect(await ui.find({ key: 'msg:677791' })).toBeUndefined()
    await openChat(ui, 1001)
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
    // On the first reply to /settings, which has no earlier reply to pair with.
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:menu' })
    expect(await titleOf(ui, 'card:menu')).toBe('MENU')
    for (const key of ['menu:mark', 'menu:range', 'menu:record', 'menu:follow', 'menu:watch', 'menu:summary', 'menu:hide']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    // f waits for a reply with a pair: listed dim with the step, not as a Button.
    const diff = await ui.find({ key: 'menu:diff' })
    expect(diff?.type).toBe('Box')
    expect(diff?.text).toContain('needs a reply with an earlier pair')
    // The menu takes the body; its bar is h and m.
    expect(await barKeys(ui)).toEqual(['back', 'menu'])
    await ui.press({ key: 'menu:watch' })
    expect(await ui.find({ key: 'menu' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '◎ watched' })).toBeDefined()
    await ui.unmount()
  })
})

describe('the agent card (§5.4, §4.6, decisions 2 and 8)', () => {
  /** The rungs the card draws, by their keys. */
  async function rungs(ui: Ui): Promise<string[]> {
    return (await ui.findAll({ type: 'Button' })).flatMap(one => (String(one.props.key ?? '').startsWith('ap:level:') ? [String(one.props.key).slice('ap:level:'.length)] : []))
  }

  test('a person lists five rungs, a group four, a bot and a channel two, each on its own digit; Saved Messages and BotFather have no card', async ($, on) => {
    const { ui } = await openPane($, on)
    const LADDERS: [number, string[]][] = [
      [1004, ['follow', 'listen', 'draft', 'auto', 'delegate']],
      [1002, ['follow', 'listen', 'draft', 'auto']],
      [1001, ['follow', 'listen']],
      [1005, ['follow', 'listen']],
    ]
    for (const [id, ladder] of LADDERS) {
      await openChat(ui, id)
      await ui.press({ key: 'key:agent' })
      expect(await rungs(ui)).toEqual(ladder)
      // The digits keep their rungs: 2 is summarize everywhere.
      expect((await ui.find({ key: 'ap:level:listen' }))?.props.hotkey).toBe('2')
      if (ladder.includes('delegate')) expect((await ui.find({ key: 'ap:level:delegate' }))?.props.hotkey).toBe('5')
      await ui.press({ key: 'key:back' })
      await ui.press({ key: 'key:back' })
    }
    for (const id of [1003, 1006]) {
      await openChat(ui, id)
      expect(await ui.find({ key: 'key:agent' })).toBeUndefined()
      expect((await allHotkeys(ui)).filter(key => key === 'a')).toHaveLength(1)
      await ui.press({ key: 'stray:a' })
      expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
      await ui.press({ key: 'key:back' })
    }
    await ui.unmount()
  })

  test("a bot chat's bar leaves a to the menu: the menu's a is pressable and opens the card on follow and summarize (T7)", async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    expect(await barKeys(ui)).not.toContain('agent')
    // Live all the same: a hidden key under the bar.
    expect((await ui.find({ key: 'key:agent' }))?.props.hotkey).toBe('a')
    await ui.press({ key: 'key:menu' })
    const entry = await ui.find({ key: 'menu:agent' })
    expect(entry?.type).toBe('Button')
    expect(entry?.props.hotkey).toBe('a')
    await ui.press({ key: 'menu:agent' })
    expect(await ui.find({ key: 'menu' })).toBeUndefined()
    expect(await rungs(ui)).toEqual(['follow', 'listen'])
    await ui.unmount()
  })

  test('a channel: follow and summarize only, summarize picked, and the card says why nothing writes', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1005)
    await ui.press({ key: 'key:agent' })
    expect((await ui.find({ key: 'ap:rung:listen' }))?.text).toMatch(/^▸ ◉ summarize/)
    expect((await ui.find({ key: 'ap:level:follow' }))?.text).toContain("new posts go to main's context")
    expect(await ui.find({ type: 'Text', text: 'a channel: nobody answers in it, so nothing writes here' })).toBeDefined()
    expect((await ui.find({ key: 'key:start' }))?.text).toBe('⏎ start summarize')
    await ui.unmount()
  })

  test('a ⏎ starts draft, outside allow.toml too (2 keys); the card closes and ✎1 counts it; on its card ⏎ stops it', async ($, on) => {
    const { ui, seen } = await openPane($, on)
    await openChat(ui, 1004)
    await ui.press({ key: 'key:agent' })
    expect(await titleOf(ui, 'card:agent')).toBe('AGENT · Contact A · 1004')
    expect(await cornerOf(ui, 'card:agent')).toBe('○ off')
    expect((await ui.find({ key: 'ap:rung:draft' }))?.text).toMatch(/^▸ ✎ draft/)
    expect(await ui.find({ type: 'Text', text: '✓ you send each draft yourself: no allow.toml needed' })).toBeDefined()
    expect(await barKeys(ui)).toEqual(['start', 'open', 'edit', 'back', 'menu'])
    await ui.press({ key: 'key:start' })
    expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('AUTOPILOT 1 CHATS')
    expect(seen.toasts.at(-1)).toBe('tg: ✎ draft on for Contact A. 0 or /tg stop stops every chat.')
    await ui.press({ key: 'key:agent' })
    expect((await ui.find({ key: 'ap:level:draft' }))?.text).toContain('● on')
    expect((await ui.find({ key: 'key:start' }))?.text).toBe('⏎ stop draft')
    await ui.press({ key: 'key:start' })
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('AUTOPILOT')
    expect(await cornerOf(ui, 'card:agent')).toBe('○ off')
    await ui.unmount()
  })

  test('one rung per chat: a 1 ⏎ follows; a 3 ⏎ switches to draft and the follow stops; p then says what runs and follows nothing', async ($, on) => {
    on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
    on('ui.invalidate', () => ({ value: undefined }))
    const { ui, seen } = await openPane($, on)
    await openChat(ui, 1004)
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'ap:level:follow' })
    expect(await ui.find({ type: 'Text', text: /^main, every turn/ })).toBeDefined()
    await ui.press({ key: 'key:start' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('⌁ 1')
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'ap:level:draft' })
    expect((await ui.find({ key: 'key:start' }))?.text).toBe('⏎ switch to draft')
    await ui.press({ key: 'key:start' })
    expect(seen.toasts.at(-1)).toBe('tg: ✎ draft on for Contact A (follow off). 0 or /tg stop stops every chat.')
    const header = (await ui.find({ key: 'header' }))?.text ?? ''
    expect(header).toContain('AUTOPILOT 1 CHATS')
    expect(header).not.toContain('⌁')
    await ui.press({ key: 'key:follow' })
    expect(await ui.find({ type: 'Text', text: /^p: Contact A runs ✎ draft · a: its card switches to follow/ })).toBeDefined()
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('⌁')
    await ui.unmount()
  })

  test('o: limits and quiet hours as Selects, topics on digits, the brief as fields; e rings the brief; h goes back to the ladder', async ($, on) => {
    const { ui, seen } = await openPane($, on)
    await openChat(ui, 1004)
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'key:open' })
    expect(await titleOf(ui, 'card:agent')).toBe('AGENT · Contact A · 1004 · options')
    expect((await ui.find({ key: 'ap:rate' }))?.props.value).toBe('50')
    await ui.select({ key: 'ap:rate', value: '10' })
    await ui.select({ key: 'ap:gap', value: '30' })
    await ui.select({ key: 'ap:conf', value: '0.90' })
    await ui.select({ key: 'ap:quiet', value: '22:00-08:00' })
    expect((await ui.find({ key: 'ap:topic:dates' }))?.props.hotkey).toBe('2')
    await ui.press({ key: 'ap:topic:dates' })
    await ui.input({ key: 'ap:tone', text: 'short, friendly' })
    expect(seen.store.get('autopilot.dialogs')).toMatchObject({ '1004': { perHour: 10, gapS: 30, threshold: 0.9, quiet: { from: 22 * 60, to: 8 * 60 }, topics: ['money', 'promises', 'opinions', 'personal'], brief: { tone: 'short, friendly' } } })
    // A person's chat has delegate, so its options end in the danger zone.
    expect(await ui.find({ key: 'dg:danger' })).toBeDefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'ap:card' })).toBeDefined()
    await ui.press({ key: 'ap:level:auto' })
    expect(await ui.find({ type: 'Text', text: '10/h · one per burst · gap 30 s · conf ≥ 0.90 · quiet 22:00–08:00   o: change' })).toBeDefined()
    await ui.unmount()
  })

  test('a group has no danger zone, as it has no delegate', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1002)
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'key:open' })
    expect(await ui.find({ key: 'ap:options' })).toBeDefined()
    expect(await ui.find({ key: 'dg:danger' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('one meaning per key, and only where it works (§4.6)', () => {
  const owners = hotkeyTable()

  test('the table gives each hotkey one meaning', () => {
    const letters = KEYS.flatMap(def => (def.hotkey === null ? [] : [def.hotkey]))
    expect(letters.filter((key, index) => letters.indexOf(key) !== index)).toEqual([])
  })

  /** A press brings nothing back: enough for a recording to have a step (T6). */
  const pressing = (argv: readonly string[]) => (argv[1] === 'press' ? json({ button: {}, answer: null, replies: [] }) : happy(argv))
  const RECORD = ['dialog:1001', 'key:record', 'key:up', 'btn:677791:0:0', 'key:record']

  /** Every view the pane draws in T1, by the presses that reach it. */
  const VIEWS: { name: string; props: RenderPropsOf['Pane']; steps: string[]; tg?: typeof happy; store?: Record<string, unknown>; start?: boolean }[] = [
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
    // The agent card (T3): the ladder for every kind that has one, its options, delegate's warning and grant, and their menus.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        ...[1001, 1002, 1004, 1005].map(id => ({ name: `card ${id} ${seat}`, props, steps: [`dialog:${id}`, 'key:agent'] })),
        { name: `card menu ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'key:menu'] },
        { name: `card options ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'key:open'] },
        { name: `card options menu ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'key:open', 'key:menu'] },
        { name: `card options, a bot ${seat}`, props, steps: ['dialog:1001', 'key:agent', 'key:open'] },
        { name: `card warning ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'ap:level:delegate'] },
        { name: `card warning menu ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'ap:level:delegate', 'key:menu'] },
        { name: `card grant ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'ap:level:delegate', 'key:start:warning'] },
        { name: `card grant menu ${seat}`, props, steps: ['dialog:1004', 'key:agent', 'ap:level:delegate', 'key:start:warning', 'key:menu'] },
        { name: `card from Chats ${seat}`, props, steps: ['key:down', 'key:agent'] },
      ]
    }),
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
    // T6: the cursor on a message with buttons (its chips carry 1 and 2), BotFather's ro chips, the diff, the
    // recording-stopped sheet and its menu, the hand-off sheet on a bot outside allow.toml.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      return [
        { name: `chips ${seat}`, props, steps: ['dialog:1001', 'key:up'] },
        { name: `chips BotFather ${seat}`, props, steps: ['dialog:1006', 'key:up'] },
        { name: `chips, marked ${seat}`, props, steps: ['dialog:1001', 'key:up', 'key:mark'] },
        { name: `diff ${seat}`, props, steps: ['dialog:1001', 'key:diff'] },
        { name: `diff menu ${seat}`, props, steps: ['dialog:1001', 'key:diff', 'key:menu'] },
        { name: `recorded ${seat}`, props, steps: RECORD, tg: pressing },
        { name: `recorded menu ${seat}`, props, steps: [...RECORD, 'key:menu'], tg: pressing },
        { name: `hand-off ${seat}`, props, steps: [...RECORD, 'rec:hand'], tg: pressing },
        { name: `hand-off targets ${seat}`, props, steps: [...RECORD, 'rec:hand', 'key:agent'], tg: pressing },
      ]
    }),
    // T7: the first open's start block, over Chats and the views it shows with, and once d put it away.
    ...[DOCK, INLINE].flatMap(props => {
      const seat = props === DOCK ? 'dock' : 'inline'
      // The dock draws it in the lower part while no chat is open; inline, over the chat list only.
      const isDock = props === DOCK
      return [
        { name: `start ${seat}`, props, steps: [], store: FIRST_OPEN, start: true },
        { name: `start menu ${seat}`, props, steps: ['key:menu'], store: FIRST_OPEN, start: false },
        { name: `start, search ${seat}`, props, steps: ['key:search'], store: FIRST_OPEN, start: true },
        { name: `start, folders ${seat}`, props, steps: ['key:back'], store: FIRST_OPEN, start: isDock },
        { name: `start, for you ${seat}`, props, steps: ['key:foryou'], store: FIRST_OPEN, start: isDock },
        { name: `start, a chat ${seat}`, props, steps: ['dialog:1001'], store: FIRST_OPEN, start: false },
        { name: `start put away ${seat}`, props, steps: ['key:dismiss'], store: FIRST_OPEN, start: false },
      ]
    }),
  ]

  for (const view of VIEWS) {
    test(`${view.name}: each of a–z and 0–9 has exactly one Button; the bound ones are the table's; no card above CHATS draws one; m ends the key line`, async ($, on) => {
      const { ui, clock } = await openPane($, on, view.props, view.tg, view.store)
      for (const key of view.steps) {
        await ui.press({ key: key.startsWith('dialog:') ? await reachChat(ui, Number(key.slice('dialog:'.length))) : key })
        await clock.settle()
      }
      if (view.start !== undefined) expect((await ui.find({ key: 'start' })) !== undefined).toBe(view.start)
      if (/^recorded (dock|inline)$/.test(view.name)) expect(await ui.find({ key: 'rec:sheet' })).toBeDefined()
      if (/^hand-off (dock|inline)$/.test(view.name)) expect(await ui.find({ key: 'sheet:intent:test' })).toBeDefined()
      if (view.name.startsWith('chips ')) expect((await ui.find({ key: 'btn:677791:0:1' }))?.props.hotkey).toBe('2')
      const drawn = await hotkeys(ui)
      for (const key of drawn) expect(/^[0-9]$/.test(key) || owners.has(key)).toBe(true)
      // Nothing falls through to the prompt (the T9 review's M1): what the view does not bind, the catch-all does, once.
      const every = await allHotkeys(ui)
      expect(every.filter((key, index) => every.indexOf(key) !== index)).toEqual([])
      expect([...every].sort()).toEqual([...STRAY_KEYS].sort())
      // The header, the legend row and every section over CHATS are text: the stops above the list stay put (§4.3 rule 1, §10.5).
      if ((await ui.find({ key: 'card:chats' })) !== undefined) expect(await stopsBefore(ui, 'card:chats')).toBe(0)
      const line = await barKeys(ui)
      if (line.length > 0) expect(line.at(-1)).toBe('menu')
      await ui.unmount()
    })
  }

  // A draft's row (§8 T3): the cursor on it, and its field open, in both seats; its keys are ⏎ e d a.
  for (const props of [DOCK, INLINE]) {
    test(`a draft's row and its field, ${props.placement}: each of a–z and 0–9 has exactly one Button; the bar is the draft's`, async ($, on) => {
      const write = autopilotWriter(on)
      const { ui } = await openPane($, on, props)
      await fillBand($, write)
      await openChat(ui, 1004)
      await ui.press({ key: 'key:down' })
      expect((await ui.find({ key: 'draft:ap:1' }))?.props.autoFocus).toBe(true)
      // fillBand's undo window is open: u joins, as everywhere while it is (§4.6).
      expect(await barKeys(ui)).toEqual(['senddraft', 'edit', 'dismiss', 'agent', ...(props === INLINE ? ['back'] : []), 'undo', 'menu'])
      for (const step of ['row', 'field'] as const) {
        if (step === 'field') await ui.press({ key: 'key:edit' })
        const drawn = await hotkeys(ui)
        for (const key of drawn) expect(/^[0-9]$/.test(key) || owners.has(key)).toBe(true)
        const every = await allHotkeys(ui)
        expect(every.filter((key, index) => every.indexOf(key) !== index)).toEqual([])
        expect([...every].sort()).toEqual([...STRAY_KEYS].sort())
      }
      expect(await ui.find({ key: 'draft:ap:1:text' })).toBeDefined()
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

  test('a bot chat has r and n; f on a reply with a pair, or once two replies are marked', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    // The cursor on "Main menu", the second reply to /settings: f pairs it with the first.
    let drawn = await hotkeys(ui)
    expect(drawn).toContain('r')
    expect(drawn).toContain('n')
    expect(drawn).toContain('f')
    // The first reply to /settings has nothing earlier to pair with.
    await ui.press({ key: 'key:up' })
    drawn = await hotkeys(ui)
    expect(drawn).not.toContain('f')
    await ui.press({ key: 'key:mark' })
    drawn = await hotkeys(ui)
    expect(drawn).not.toContain('f')
    await ui.press({ key: 'key:down' })
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

describe('a chat opens on its own window', () => {
  test("after a 40-message thread, a two-message chat shows both: the last chat's window start does not carry over", async ($, on) => {
    const twoAfterLong = (argv: readonly string[]) => (argv[1] === 'read' && argv[2] === '1004' ? json(PERSON_MESSAGES) : long(argv))
    const { ui } = await openPane($, on, DOCK, twoAfterLong)
    await openChat(ui, 1001)
    expect((await rows(ui, 'msg:')).length).toBeGreaterThan(3)
    // A move keeps the window's start where the drawing put it, deep in the long thread.
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:back' })
    await openChat(ui, 1004)
    expect(await rows(ui, 'msg:')).toEqual(['msg:91', 'msg:92'])
    await ui.unmount()
  })
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

/** The dock's top cards (§10.5); every other `card:` is the lower one, a chat's or a layer's. */
const TOP_CARDS = ['card:foryou-section', 'card:chats', 'card:folders', 'card:foryou', 'card:start', 'card:autopilot', 'card:log']

/** Ring stops above the dock's lower card (the open chat's, or the layer's in its place). */
async function stopsAbove(ui: Ui): Promise<number> {
  return stopsBeforeNode(ui, node => typeof node.props?.key === 'string' && node.props.key.startsWith('card:') && !TOP_CARDS.includes(node.props.key))
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

describe('the legend row says what runs over the same ring stops (§4.3 rule 1, §5.6, §10.5)', () => {
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
    expect(await legendOf(ui)).toBe(LEGEND_TEXT)
    await ui.press({ key: 'key:follow' })
    // The AUTOPILOT card is folded while a chat is open: the row says what runs, and carries 0: stop all.
    expect(await legendOf(ui)).toBe('⌁ Example Bot → main0: stop all')
    expect(await place(ui)).toEqual(base)
    await ui.press({ key: 'key:follow' })
    expect(await legendOf(ui)).toBe(LEGEND_TEXT)
    expect(await place(ui)).toEqual(base)
    await ui.press({ key: 'key:follow' })
    await $.command.run(runTg('stop'))
    expect(await legendOf(ui)).toBe('■ stopped: Example Bot')
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
    expect(await legendOf(ui)).toBe(LEGEND_TEXT)
    expect(await place(ui)).toEqual(base)
    await ui.unmount()
  })

  test('the legend row draws no ring stop: 0 is the hidden key and the menu’s, never the key line’s', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    expect(await legendOf(ui)).toContain('0: stop all')
    // The header and the legend row hold no stop: none is drawn before the cards' slot.
    expect(await stopsBefore(ui, 'slot')).toBe(0)
    expect(await barKeys(ui)).not.toContain('stop')
    expect((await ui.find({ key: 'keys:hidden' }))?.text).toContain('stop all')
    expect((await hotkeys(ui)).filter(key => key === '0')).toEqual(['0'])
    await ui.press({ key: 'key:menu' })
    expect((await ui.find({ key: 'menu:stop' }))?.text).toBe('stop every agent and Worker · /tg stop')
    await ui.unmount()
  })

  test('inline: no legend row, the header counts ⌁ 1, and 0 stays a hidden key: never on the key line (§10.10)', async ($, on) => {
    const { ui } = await openPane($, on, INLINE)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    expect(await ui.find({ key: 'legend' })).toBeUndefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('⌁ 1')
    expect(await barKeys(ui)).not.toContain('stop')
    expect((await hotkeys(ui)).filter(key => key === '0')).toEqual(['0'])
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
    expect(await ui.find({ key: 'activity' })).toBeDefined()
    expect((await ui.find({ key: 'act:1001' }))?.text).toMatch(/^▸ ⌁ {2}Example Bot {4}follows → main · /)
    expect((await ui.find({ key: 'act:1001' }))?.props.autoFocus).toBe(true)
    expect(await barKeys(ui)).toEqual(['open', 'back', 'menu'])
    const above = await stopsBefore(ui, 'act:1002')
    await $.command.run(runTg('stop'))
    // Both rows stay, so nothing above the second one moved.
    expect((await ui.find({ key: 'act:1001' }))?.text).toMatch(/■ {2}Example Bot +stopped/)
    expect(await stopsBefore(ui, 'act:1002')).toBe(above)
    await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: 'act:1002' }))?.props.autoFocus).toBe(true)
    await ui.press({ key: 'act:1002' })
    expect(await ui.find({ key: 'activity' })).toBeUndefined()
    expect(await titleOf(ui, 'card:chat')).toBe('◇ Dev Team')
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
  // As the autopilot lands them: after the newest message of their chat, the guard's verdict in.
  const draft = (seq: number, peer: PeerRef, text: string): ApDraft => ({
    seq,
    peer,
    incoming: 'Can we call tomorrow at 10?',
    text,
    confidence: 0.62,
    reasons: ['dates'],
    state: { kind: 'ready' },
    check: { kind: 'planned', isAllowed: true, reason: 'confirmed with --yes' },
    at: seq,
    after: 10_000_000,
  })
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
   * Box drawn `display: none` or laid over another (`position: absolute`) none,
   * and a card's bordered Box its height. The kit lays nothing out, so this stands in
   * for the engine's fit of an inline frame to its tree (§7.3).
   */
  function rowsOf(node: unknown): number {
    if (typeof node !== 'object' || node === null) return 0
    const { type, props, children } = node as { type?: unknown; props?: { display?: unknown; flexDirection?: unknown; position?: unknown; borderStyle?: unknown; height?: unknown }; children?: unknown }
    if (props?.display === 'none') return 0
    // A card's title and corner sit over its border; the bordered Box is as tall as it says (§10.5).
    if (props?.position === 'absolute') return 0
    if (props?.borderStyle !== undefined && typeof props.height === 'number') return props.height
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

  // T6: a bot thread longer than the window, a day divider a quarter of the way in, chips on every fourth message.
  const KEYBOARD = [
    [
      { row: 0, col: 0, type: 'cb', text: 'Retry', data_b64: 'cmV0cnk=' },
      { row: 0, col: 1, type: 'cb', text: 'Back', data_b64: 'YmFjaw==' },
    ],
  ]
  const CHIPPED: TgMessage[] = LONG.map((message, index) => ({
    ...message,
    date: index < 10 ? message.date.replace('2026-10-10', '2026-10-09') : message.date,
    keyboard: index % 4 === 1 ? ('inline' as const) : null,
    buttons: index % 4 === 1 ? KEYBOARD : [],
  }))
  const chipped = (argv: readonly string[]) =>
    argv[1] === 'read' ? json(CHIPPED) : argv[1] === 'press' ? json({ button: {}, answer: { alert: null, toast: 'Saved', url: null }, replies: [] }) : stable(argv)
  /** The thread's ring stops, in order: its messages and their chips. */
  const threadStops = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('msg:') === true || one.key?.startsWith('btn:') === true ? [one.key] : []))

  for (const seat of SEATS) {
    test(`${seat.name}, a 40-message bot thread with chips and day dividers: k across the window, a digit's press, f and its diff, r … r and its sheet; the ring stays on ▸ (T6)`, async ($, on) => {
      const { ui, clock } = await openPane($, on, seat.props, chipped)
      await openChat(ui, 1001)
      // k up the thread: a move inside the window changes no stop (every chip is a Button wherever the cursor is), so the
      // ring the engine keeps by its place lands on ▸; a move past the edge scrolls by the rows it needs.
      let chipRow: string | null = null
      for (let move = 0; move < 14; move++) {
        const before = { first: (await rows(ui, 'msg:'))[0], stops: await threadStops(ui) }
        await ui.press({ key: 'key:up' })
        const after = { first: (await rows(ui, 'msg:'))[0], stops: await threadStops(ui) }
        if (after.first === before.first) expect(after.stops).toEqual(before.stops)
        const ringed = (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true && one.key?.startsWith('msg:') === true)?.key ?? ''
        const id = Number(ringed.slice(4))
        if (CHIPPED.find(one => one.id === id)?.buttons.length !== 0 && chipRow === null) chipRow = ringed
        if (chipRow !== null) break
      }
      expect(chipRow).not.toBeNull()
      const id = Number(chipRow?.slice(4))
      expect((await ui.find({ key: `btn:${id}:0:1` }))?.props.hotkey).toBe('2')
      const base = await place(ui)
      // A digit's press: its answer lands in the notice row, which takes no row of the thread.
      await ui.press({ key: `btn:${id}:0:0` })
      await clock.settle()
      expect((await ui.find({ key: 'notice' }))?.text).toBe('toast: Saved')
      expect(await place(ui)).toEqual(base)
      // f on two marked replies: the diff is a layer over the lower part; h closes it, h clears the marks.
      await ui.press({ key: 'key:mark' })
      await ui.press({ key: 'key:down' })
      await ui.press({ key: 'key:mark' })
      const marked = await place(ui)
      await ui.press({ key: 'key:diff' })
      expect(await ui.find({ key: 'bt:diff-view' })).toBeDefined()
      await expectStatic(ui, false)
      await ui.press({ key: 'key:back' })
      expect(await ui.find({ key: 'bt:diff-view' })).toBeUndefined()
      expect(await place(ui)).toEqual(marked)
      await ui.press({ key: 'key:back' })
      await ui.press({ key: 'key:up' })
      expect(await place(ui)).toEqual(base)
      // r, a press, r: the recording-stopped sheet takes the bar's place, the thread under it static; ⏎ ok closes it.
      await ui.press({ key: 'key:record' })
      await ui.press({ key: `btn:${id}:0:1` })
      await clock.settle()
      await ui.press({ key: 'key:record' })
      await clock.settle()
      expect(await ui.find({ key: 'rec:sheet' })).toBeDefined()
      await expectStatic(ui, false)
      await ui.press({ key: 'rec:ok' })
      expect(await ui.find({ key: 'rec:sheet' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      await ui.unmount()
    })
  }

  /** Ring stops inside the header: its text changes as the thread scrolls, so it must hold none (§4.3 rule 1). */
  async function headerStops(ui: Ui): Promise<number> {
    let count = 0
    const walk = (node: unknown) => {
      if (typeof node !== 'object' || node === null) return
      const one = node as { type?: unknown; children?: unknown }
      if (one.type === 'Button' || one.type === 'Input' || one.type === 'Select') count += 1
      if (Array.isArray(one.children)) for (const child of one.children) walk(child)
    }
    walk(await ui.find({ key: 'header' }))
    return count
  }

  for (const seat of SEATS) {
    test(`${seat.name}, a 40-message bot thread over two days: k to the top; the chat card's corner names the top row's day once its divider scrolled off, and no stop comes with it (T7, §10.5)`, async ($, on) => {
      const { ui } = await openPane($, on, seat.props, chipped)
      await openChat(ui, 1001)
      const named = new Set<string>()
      for (let move = 0; move < CHIPPED.length; move++) {
        const first = Number((await rows(ui, 'msg:'))[0]?.slice('msg:'.length))
        const index = CHIPPED.findIndex(one => one.id === first)
        // Ten messages of the day before, then thirty of today, a divider before the first of each: the header names a day
        // only while the window's top row is past the divider of its day.
        const day = index === 0 || index === 10 ? null : index < 10 ? 'yesterday' : 'today'
        const corner = (await cornerOf(ui, 'card:chat')) ?? ''
        if (day === null) expect(corner).not.toMatch(/^(today|yesterday)/)
        else {
          expect(corner).toMatch(new RegExp(`^${day}`))
          named.add(day)
        }
        expect(await headerStops(ui)).toBe(0)
        const before = { first, stops: await threadStops(ui) }
        await ui.press({ key: 'key:up' })
        const after = { first: Number((await rows(ui, 'msg:'))[0]?.slice('msg:'.length)), stops: await threadStops(ui) }
        if (after.first === before.first) expect(after.stops).toEqual(before.stops)
      }
      expect([...named].sort()).toEqual(['today', 'yesterday'])
      // At the top the first divider is drawn, so the header names no day.
      expect((await rows(ui, 'msg:'))[0]).toBe(`msg:${CHIPPED[0]?.id}`)
      expect((await cornerOf(ui, 'card:chat')) ?? '').not.toMatch(/^(today|yesterday)/)
      await ui.unmount()
    })
  }

  for (const seat of SEATS) {
    const inline = seat.props.placement === 'inline'
    test(`${seat.name}, the cursor on the newest of 40 messages: x, n (send, empty), s, t, a draft landing; nothing above the cursor moves`, async ($, on) => {
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
      // A drafted reply lands (§8 T3): a row of the thread after its newest message, below the cursor, so
      // nothing above it moves; no notice, no layer. The band has it while the thread's window does not hold it.
      await landDraft($, ui)
      expect(await ui.find({ key: 'notice' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // j onto it: the window scrolls at its edge to hold the draft whole; e opens its field in its place, the
      // field's ⏎ keeps the text, and the cursor and the rows above stay where j put them.
      await ui.press({ key: 'key:down' })
      const onDraft = await place(ui)
      expect((await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key).toBe('draft:reply')
      expect(await ui.find({ type: 'Text', text: 'Sure, 10 works.' })).toBeDefined()
      await ui.press({ key: 'key:edit' })
      expect(await ui.find({ key: 'draft:reply:text' })).toBeDefined()
      await ui.input({ key: 'draft:reply:text', text: 'Sure, 10 works for me.' })
      expect(await ui.find({ key: 'draft:reply:text' })).toBeUndefined()
      expect(await place(ui)).toEqual(onDraft)
      // d drops it: the cursor goes back to the newest message, the window keeps its first row.
      await ui.press({ key: 'key:dismiss' })
      expect((await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key).toBe('msg:700040')
      expect((await place(ui)).message).toBe(onDraft.message)
      await ui.unmount()
    })

    test(`${seat.name}, the cursor on the newest of 40 messages: the card and each of its steps open and close over the same stops (T3)`, async ($, on) => {
      const { ui } = await openStable($, on, seat.props)
      await openChat(ui, 1004)
      const base = await place(ui)
      const list = await rows(ui, 'dialog:')
      await ui.press({ key: 'key:agent' })
      // The card is a layer: the dock's list above it keeps its rows, and a digit changes no stop above the bar's ⏎.
      expect(await rows(ui, 'dialog:')).toEqual(inline ? [] : list)
      const enter = await stopsBefore(ui, 'key:start')
      for (const rung of ['follow', 'listen', 'draft', 'auto']) {
        await ui.press({ key: `ap:level:${rung}` })
        expect(await stopsBefore(ui, 'key:start')).toBe(enter)
      }
      await ui.press({ key: 'key:open' })
      expect(await ui.find({ key: 'ap:rate' })).toBeDefined()
      expect(await ui.find({ key: 'key:start' })).toBeUndefined()
      // The ring starts on `⏎ done`, a Button: on a Select no letter is a hotkey, so h would not work there.
      expect((await ui.find({ key: 'key:start:options' }))?.props.autoFocus).toBe(true)
      expect((await ui.findAll({ type: 'Select' })).filter(one => one.props.autoFocus === true)).toEqual([])
      await ui.press({ key: 'key:back' })
      expect(await stopsBefore(ui, 'key:start')).toBe(enter)
      // delegate's steps key their ⏎ by step, so the ring waits for each step's own drawing.
      await ui.press({ key: 'ap:level:delegate' })
      expect(await ui.find({ key: 'key:start:warning' })).toBeDefined()
      expect(await ui.find({ key: 'key:start' })).toBeUndefined()
      await ui.press({ key: 'key:start:warning' })
      expect(await ui.find({ key: 'key:start:grant' })).toBeDefined()
      await ui.press({ key: 'key:back' })
      expect(await stopsBefore(ui, 'key:start')).toBe(enter)
      expect(await rows(ui, 'dialog:')).toEqual(inline ? [] : list)
      await ui.press({ key: 'key:back' })
      expect(await ui.find({ key: 'ap:card' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      await ui.unmount()
    })

    test(`${seat.name}, the cursor mid-way down 60 chats: s, a notice, a draft landing; nothing above the cursor moves`, async ($, on) => {
      const { ui } = await openStable($, on, seat.props)
      await openChat(ui, 1004)
      await ui.press({ key: 'key:follow' })
      await landDraft($, ui, async () => {
        await ui.press({ key: 'key:back' })
        for (let i = 0; i < 5; i++) await ui.press({ key: 'key:down' })
      })
      // The draft landed while the cursor was in Chats: a row of its chat, no notice; compare from there on.
      const base = await place(ui)
      expect(base.key).toMatch(/^dialog:/)
      expect(await ui.find({ key: 'notice' })).toBeUndefined()
      await ui.press({ key: 'key:search' })
      await expectStatic(ui, true)
      await ui.input({ key: 'search', text: '' })
      expect(await place(ui)).toEqual(base)
      // A notice arrives with no key pressed in the pane: /tg stop says what it stopped.
      await $.command.run(runTg('stop'))
      expect((await ui.find({ key: 'notice' }))?.text).toBe('■ stopped: Contact A')
      expect(await place(ui)).toEqual(base)
      // e means nothing in Chats now: it says where it works and keeps the keys in the pane.
      await ui.press({ key: 'stray:e' })
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

describe('the dock\'s sections hold their rows for a layout generation (§10.5 "Heights hold still", T13)', () => {
  const at = Date.parse('2026-10-10T12:00:00Z')
  const contact: PeerRef = { id: 1004, arg: '1004', label: 'Contact A', kind: 'user' }
  /** A sent reply in the autopilot's ledger: a line of LOG. */
  const sent = (seq: number) => ({ seq, at, peer: contact, level: 'auto' as const, incoming: [{ id: 92, text: 'Can we call?' }], reply: 'Sure, 10 works.', confidence: 0.93, topics: [], checks: [], outcome: { kind: 'sent' as const, ids: [900 + seq], by: 'auto' as const }, undo: null })
  const HEIGHTS = [30, 31, 32, 33].map(bodyRows => ({ ...DOCK, scroll: { offset: 0, bodyRows } }))

  /** The ring's place in Chats: the cursor row, the stops before it, the window's first row. */
  async function place(ui: Ui) {
    const key = (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key ?? ''
    return { key, before: await stopsBefore(ui, key), first: (await rows(ui, 'dialog:'))[0] }
  }

  /** The cursor down 60 chats past the window's first edge, where a lost row would move it. */
  async function deep(ui: Ui) {
    for (let i = 0; i < 30; i++) await ui.press({ key: 'key:down' })
  }

  for (const props of HEIGHTS) {
    test(`${props.scroll.bodyRows} rows, 60 chats, the cursor in CHATS: a FOR YOU item arriving, an agent starting and a log entry landing wait, and g lets them in`, async ($, on) => {
      const write = autopilotWriter(on)
      const { ui } = await openPane($, on, props, long)
      await deep(ui)
      const base = await place(ui)
      expect(base.key).toMatch(/^dialog:/)
      // The people who wait already fill FOR YOU over CHATS; its rows are held from here on.
      const forYou = (await ui.find({ key: 'card:foryou-section' }))?.props.height
      expect(await ui.find({ key: 'card:autopilot' })).toBeUndefined()
      expect(await ui.find({ key: 'card:log' })).toBeUndefined()
      // Two drafts land for the owner: the header counts them, FOR YOU keeps its rows and counts the rest.
      await fillBand($, write)
      expect((await ui.find({ key: 'header' }))?.text).toContain('2 FOR YOU')
      expect((await ui.find({ key: 'card:foryou-section' }))?.props.height).toBe(forYou)
      expect(await place(ui)).toEqual(base)
      // An agent starts: the header counts it at once, the card waits for the next generation.
      await write($, value => ({ ...value, running: [1004], dialogs: { ...value.dialogs, '1004': { ...defaultDialog(contact), level: 'draft' } } }))
      expect((await ui.find({ key: 'header' }))?.text).toContain('AUTOPILOT 1 CHATS')
      expect(await ui.find({ key: 'card:autopilot' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // A log entry lands: the same.
      await write($, value => ({ ...value, running: [1004], dialogs: { ...value.dialogs, '1004': { ...defaultDialog(contact), level: 'draft' } }, ledger: [sent(1)] }))
      expect(await ui.find({ key: 'card:log' })).toBeUndefined()
      expect(await place(ui)).toEqual(base)
      // g starts a generation: FOR YOU takes its rows over CHATS, the other two under it, and nothing above CHATS draws a stop.
      await ui.press({ key: 'key:reload' })
      // The agents' drafts lead FOR YOU (§5.3).
      expect((await ui.find({ key: 'card:foryou-section' }))?.text).toContain('draft: Tomorrow is packe')
      expect(await ui.find({ key: 'card:autopilot' })).toBeDefined()
      expect(await ui.find({ key: 'card:log' })).toBeDefined()
      expect(await stopsBefore(ui, 'card:chats')).toBe(0)
      await ui.unmount()
    })
  }

  test('a section that empties keeps its rows until the next generation; h then lets it go', async ($, on) => {
    const write = autopilotWriter(on)
    const { ui } = await openPane($, on, DOCK, long)
    await write($, value => ({ ...value, ledger: [sent(1)] }))
    await ui.press({ key: 'key:reload' })
    expect(await ui.find({ key: 'card:log' })).toBeDefined()
    const base = await place(ui)
    await write($, value => ({ ...value, ledger: [] }))
    expect(await ui.find({ key: 'card:log' })).toBeDefined()
    expect(await place(ui)).toEqual(base)
    await ui.press({ key: 'key:back' })
    await ui.press({ key: 'key:open' })
    expect(await ui.find({ key: 'card:log' })).toBeUndefined()
    await ui.unmount()
  })

  test('0: stop all is drawn once: in the AUTOPILOT corner while the card shows, else in the legend row', async ($, on) => {
    const { ui } = await openPane($, on, DOCK, long)
    // ✎ draft on Contact A from its card, then h twice: back in Chats, the chat still open.
    await openChat(ui, 1004)
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'ap:level:draft' })
    await ui.press({ key: 'key:start' })
    // ▸ in the chat folds the AUTOPILOT card: the legend row carries the label.
    expect(await ui.find({ key: 'card:autopilot' })).toBeUndefined()
    expect(await legendOf(ui)).toContain('0: stop all')
    // h: ▸ back in Chats, the sections back; the card's corner carries it, the legend row does not.
    await ui.press({ key: 'key:back' })
    expect(await cornerOf(ui, 'card:autopilot')).toBe('0: stop all')
    expect(await legendOf(ui)).not.toContain('0: stop')
    await ui.unmount()
  })
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
      // One Button per hotkey, each the table's band meaning; no digits in the band (§11).
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

  test("a draft whose row the open thread's window holds leaves the band; the other chat's stays (§8 T3)", async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui } = await openPane($, on)
    await fillBand($, write)
    await openChat(ui, 1004)
    expect(await ui.find({ key: 'draft:ap:1' })).toBeDefined()
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_SITE })
    expect((await band.find({ key: 'band:row1' }))?.text).toContain('Dev Team')
    expect(await band.find({ type: 'Text', text: /1\/3 {2}j: next/ })).toBeDefined()
    await band.unmount()
    await ui.unmount()
  })

  test('an open pane the engine has not placed draws nothing: the band keeps For you\'s drafts', async ($, on) => {
    engineSites(on)
    const write = autopilotWriter(on)
    const { ui, seen } = await openPane($, on)
    await fillBand($, write)
    await ui.press({ key: 'key:foryou' })
    // A terminal too narrow for the pane: open, but not drawn.
    seen.isPlaced = false
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_SITE })
    expect((await bandShape(band)).first).toBe('ap:draft:send')
    expect(await band.find({ type: 'Text', text: '1/4  j: next' })).toBeDefined()
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
      '  ⌁  Example Bot    follows → main · failed',
      'watching  nothing',
      'waiting',
      '  ✎ draft for Contact A · 1004: "Tomorrow is packed, can I write after 18?"',
      '  ✎ draft for Dev Team · 1002: "Merging after lunch."',
      '  ⟳ Dev Team · 1002 replied "Merged, thanks" · u: undo 30s',
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
    expect(await ui.find({ type: 'Text', text: 'Not logged in: type ! tg login in your prompt' })).toBeDefined()
    expect((await ui.find({ key: 'reload' }))?.text).toBe('retry')
    // g is drawn by the error row; the hidden keys do not draw it twice.
    expect((await hotkeys(ui)).filter(key => key === 'g')).toEqual(['g'])
    await ui.unmount()
  })

  test('loading shows dim … rows, and … in the header', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-10T12:00:00Z') })
    world(on, happy)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    // No /tg yet: nothing loaded, so the list is in its loading state.
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
    expect(await ui.find({ key: 'loading' })).toBeDefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('…')
    await ui.unmount()
  })

  test('once the list is in, the header drops its …', async ($, on) => {
    const { ui } = await openPane($, on)
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('…')
    await ui.unmount()
  })

  test('an error is one red line (the unread role) and g: retry; g runs it again', async ($, on) => {
    let isBroken = true
    engineSites(on)
    const { ui, clock } = await openPane($, on, DOCK, argv => (isBroken && argv[1] === 'dialogs' ? failure(1, 'error: the fake is down') : happy(argv)))
    const line = await ui.find({ type: 'Text', text: 'tg: the fake is down' })
    expect(line?.props.color).toBe('error')
    // Nothing is on its way: no `…` in the header, and the footer says it failed.
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('…')
    expect(await siteText($, FOOTER)).toBe('focus & tg ⚠')
    expect((await ui.find({ key: 'reload' }))?.text).toBe('retry')
    expect((await ui.find({ key: 'reload' }))?.props.hotkey).toBe('g')
    isBroken = false
    // Inside the 60 s since the failed pass, g queues the next one (§8 T9); it lands when they are up.
    await ui.press({ key: 'reload' })
    await clock.advance(60_000)
    await clock.settle()
    expect(await findChat(ui, 1001)).toBeDefined()
    await ui.unmount()
  })

  test('a flood wait is yellow (the held role) and counts down; it retries by itself, so no g', async ($, on) => {
    engineSites(on)
    const { ui } = await openPane($, on, DOCK, argv => (argv[1] === 'dialogs' ? failure(5, 'error: FLOOD_WAIT 23s: Telegram asks to wait before retrying') : happy(argv)))
    // Telegram's 23 s fall inside the 60 s a pass waits after the last one: the count is to the retry.
    const line = await ui.find({ type: 'Text', text: 'Telegram asks to wait 23 s · retrying in 60 s' })
    expect(line?.props.color).toBe('warning')
    expect(await ui.find({ key: 'reload' })).toBeUndefined()
    // Said once: the list says it, so the notice row does not; a wait is not a failure, so the footer waits too.
    expect((await legendOf(ui)) ?? '').not.toContain('asks to wait')
    expect((await legendOf(ui)) ?? '').not.toContain('refreshing in')
    expect(await siteText($, FOOTER)).toBe('focus & tg …')
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

describe('the first open: START HERE until d (§4.4, §8 T7, §10.5)', () => {
  /** Ring stops inside the start block: none, so drawing it or putting it away moves no stop (§4.3 rule 1). */
  async function blockStops(ui: Ui): Promise<number> {
    let count = 0
    const walk = (node: unknown) => {
      if (typeof node !== 'object' || node === null) return
      const one = node as { type?: unknown; children?: unknown }
      if (one.type === 'Button' || one.type === 'Input' || one.type === 'Select') count += 1
      if (Array.isArray(one.children)) for (const child of one.children) walk(child)
    }
    walk(await ui.find({ key: 'start' }))
    return count
  }

  /** The list's generation, read off the drawn row keys (`dialog:<gen>:<id>`). */
  async function genOf(ui: Ui): Promise<string> {
    return (await rows(ui, 'dialog:'))[0]?.split(':')[1] ?? ''
  }

  test('dock: a card under CHATS while no chat is open, three lines, text only, and Chats keep their rows; d puts it away for this session and the next', async ($, on) => {
    const { ui, seen, clock } = await openPane($, on, DOCK, happy, FIRST_OPEN)
    const block = await ui.find({ key: 'start' })
    expect(await titleOf(ui, 'start')).toBe('START HERE')
    expect(await cornerOf(ui, 'start')).toBe('d: got it')
    for (const line of ['⏎ opens a chat · ⏎ on a message sends it to Claude', '1-9: your Telegram folders · h: all of them · y: for you', 'a: hand a chat to an agent · w: notify me · 0: stop all']) {
      expect(block?.text).toContain(line)
    }
    expect(block?.text).not.toContain('● keys')
    expect(await blockStops(ui)).toBe(0)
    expect(await ui.find({ type: 'Text', text: '⏎ on a chat opens it here.' })).toBeUndefined()
    const listed = await rows(ui, 'dialog:')
    // d is the table's dismiss key, kept live under the bar; the menu names it.
    expect((await ui.find({ key: 'key:dismiss' }))?.props.hotkey).toBe('d')
    expect(await barKeys(ui)).not.toContain('dismiss')
    await ui.press({ key: 'key:menu' })
    expect((await ui.find({ key: 'menu:dismiss' }))?.text).toBe('put the start block away')
    await ui.press({ key: 'key:menu' })
    await ui.press({ key: 'key:dismiss' })
    expect(await ui.find({ key: 'start' })).toBeUndefined()
    expect(seen.store.get('start.dismissed')).toBe(true)
    expect(await ui.find({ type: 'Text', text: '⏎ on a chat opens it here.' })).toBeUndefined()
    // The chats above kept their rows: the card was under them.
    expect((await rows(ui, 'dialog:')).map(key => key.split(':')[2])).toEqual(listed.map(key => key.split(':')[2]))
    // The next session (or a hot reload) reads the d from $.store.
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(await ui.find({ key: 'start' })).toBeUndefined()
    await ui.unmount()
  })

  test('a chat opening takes the lower part; with it open, d in Chats has nothing of the block to put away', async ($, on) => {
    const { ui, seen } = await openPane($, on, DOCK, happy, FIRST_OPEN)
    await openChat(ui, 1004)
    expect(await ui.find({ key: 'start' })).toBeUndefined()
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'start' })).toBeUndefined()
    // d is the notice's only: with none up it waits, so the catch-all says what it needs.
    expect(await ui.find({ key: 'key:dismiss' })).toBeUndefined()
    await ui.press({ key: 'stray:d' })
    expect(seen.store.get('start.dismissed')).toBeUndefined()
    await ui.unmount()
  })

  test('a notice up: d dismisses the notice first, then the block', async ($, on) => {
    const { ui, seen } = await openPane($, on, DOCK, happy, FIRST_OPEN)
    await ui.press({ key: 'stray:c' })
    expect(await legendOf(ui)).toContain('c: not a key')
    await ui.press({ key: 'key:dismiss' })
    expect((await legendOf(ui)) ?? '').not.toContain('c: not a key')
    expect(await ui.find({ key: 'start' })).toBeDefined()
    await ui.press({ key: 'key:dismiss' })
    expect(await ui.find({ key: 'start' })).toBeUndefined()
    expect(seen.store.get('start.dismissed')).toBe(true)
    await ui.unmount()
  })

  for (const bodyRows of [11, 12, 13]) {
    test(`inline ${bodyRows} rows, 60 chats: the block sits over the list; j and k inside the window keep its first row; d gives the rows back under a new generation, the ring on the cursor's chat`, async ($, on) => {
      const props = { ...INLINE, scroll: { offset: 0, bodyRows } }
      const { ui } = await openPane($, on, props, long, FIRST_OPEN)
      expect(await ui.find({ key: 'start' })).toBeDefined()
      expect(await blockStops(ui)).toBe(0)
      const shown = (await rows(ui, 'dialog:')).length
      // To the list's end: past it the window holds the last rows, so the rows the block gives back go above the cursor.
      for (let i = 0; i < MANY.length; i++) {
        const before = await rows(ui, 'dialog:')
        const cursor = (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key ?? ''
        await ui.press({ key: 'key:down' })
        const after = await rows(ui, 'dialog:')
        const isEdge = before.at(-1) === cursor
        if (!isEdge) expect(after).toEqual(before)
      }
      const cursor = chatIds([(await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key])[0]
      expect(cursor).toBe(MANY.at(-1)?.id)
      const gen = await genOf(ui)
      await ui.press({ key: 'key:dismiss' })
      expect(await ui.find({ key: 'start' })).toBeUndefined()
      expect((await rows(ui, 'dialog:')).length).toBe(shown + 5)
      // New keys: $.ui.focus waits for the drawing that brings them, and lands on the same chat.
      expect(await genOf(ui)).not.toBe(gen)
      const ringed = (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key
      expect(chatIds([ringed])).toEqual([cursor])
      await ui.unmount()
    })
  }
})

describe('the visual pass (§7, T7)', () => {
  /** The Text nodes under a drawn element, with their props, in order. */
  async function texts(ui: Ui, key: string): Promise<{ text: string; props: Record<string, unknown> }[]> {
    const found: { text: string; props: Record<string, unknown> }[] = []
    const walk = (node: unknown) => {
      if (typeof node !== 'object' || node === null) return
      const one = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
      if (one.type === 'Text' && Array.isArray(one.children) && one.children.every(child => typeof child === 'string')) found.push({ text: one.children.join(''), props: one.props ?? {} })
      if (Array.isArray(one.children)) for (const child of one.children) walk(child)
    }
    walk(await ui.find({ key }))
    return found
  }

  test("a chat row's name keeps its column when an agent starts: the row's columns are fixed (§10.4)", async ($, on) => {
    const { ui } = await openPane($, on)
    const before = (await findChat(ui, 1001))?.text ?? ''
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    await ui.press({ key: 'key:back' })
    const after = (await findChat(ui, 1001))?.text ?? ''
    expect(after).toContain('⬡ Example Bot')
    expect(after.indexOf('Example Bot')).toBe(before.indexOf('Example Bot'))
    await ui.unmount()
  })

  test("BotFather's row ends in ro, in the held role (§10.3)", async ($, on) => {
    const { ui } = await openPane($, on)
    expect((await findChat(ui, 1006))?.text).toMatch(/ BotFather .* ro$/)
    expect((await texts(ui, await chatKey(ui, 1006))).find(one => one.text.trim() === 'ro')?.props.color).toBe('warning')
    await ui.unmount()
  })

  test("a muted chat's count is dim, an unmuted one's in the unread role (§10.3, decision 5); an unread name bold", async ($, on) => {
    const muted = (argv: readonly string[]) => (argv[1] === 'dialogs' ? json(KINDS.map(one => (one.id === 1002 ? { ...one, muted: true, unread: 14 } : one))) : happy(argv))
    const { ui } = await openPane($, on, DOCK, muted)
    const group = await texts(ui, await chatKey(ui, 1002))
    expect(group.find(one => one.text.trim() === '14')?.props.color).toBe('inactive')
    // A muted chat's name is not bold: its count would bury the rest (§4.7).
    expect(group.find(one => one.text.includes('Dev Team'))?.props.bold).toBe(false)
    const bot = await texts(ui, await chatKey(ui, 1001))
    expect(bot.find(one => one.text.trim() === '2')?.props.color).toBe('error')
    expect(bot.find(one => one.text.includes('Example Bot'))?.props.bold).toBe(true)
    await ui.unmount()
  })

  test('0: stop all is in the unread role, key and all, in the legend row; and in the menu while it has something to stop', async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    await ui.press({ key: 'key:follow' })
    const stop = (await texts(ui, 'legend')).find(one => one.text === '0: stop all')
    expect(stop?.props.color).toBe(PALETTES.theme.unread)
    await ui.press({ key: 'key:menu' })
    expect((await texts(ui, 'menu:stop')).map(one => one.props.color)).toEqual([PALETTES.theme.unread])
    await ui.unmount()
  })

  test("a bot's sender column is plain: the bot token is the ◆ glyph's alone (§7.1)", async ($, on) => {
    const { ui } = await openPane($, on)
    await openChat(ui, 1001)
    const sender = (await texts(ui, 'msg:677792')).find(one => one.text.trim() === 'bot')
    expect(sender).toBeDefined()
    expect(sender?.props.color).toBeUndefined()
    await ui.unmount()
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
