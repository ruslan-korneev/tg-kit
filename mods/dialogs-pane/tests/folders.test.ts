// Telegram's folders in the pane (docs/design/dialogs-pane-ux.md §4.7, §8 T9):
// the strip, the Folders list, For you's people, one pass for everything and
// when it runs, what $.state and $.store keep, and the ring rules for lists
// that change while the cursor stays (§4.3). tg is answered by process.run and
// process.spawn hooks beneath the plugin, so nothing real runs. For you's
// agent rows are in autopilot.test.tsx, where the drafts come from.
import type { On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import type { TgDialog } from '../types'
import { DIALOGS, STARTED, MESSAGES, chatIds, chatKey, findChat, folderRun, type FolderSpec } from './fixtures'

const PLUGIN = 'dialogs-pane'
const NOW = Date.parse('2026-10-10T12:00:00Z')

const DOCK: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const INLINE: RenderPropsOf['Pane'] = { ...DOCK, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 12 } }

type Ui = Mounted<'terminal', 'Pane'>

const row = (id: number, over: Partial<TgDialog> = {}): TgDialog => ({
  id,
  kind: 'user',
  title: `Contact ${id - 3000 + 10}`,
  username: null,
  unread: 0,
  mentions: 0,
  pinned: false,
  muted: false,
  last_id: id,
  last_date: `2026-10-10T${String(11 - Math.floor((id - 3000) / 60)).padStart(2, '0')}:${String(59 - ((id - 3000) % 60)).padStart(2, '0')}:00Z`,
  last_text: `placeholder note ${id}`,
  ...over,
})

/** Work's 60 people, newest first, as a pass lists them. */
const MANY: TgDialog[] = Array.from({ length: 60 }, (_, index) => row(3000 + index))
/** A muted channel with 14 unread, for the dim count. */
const CHANNEL: TgDialog = { ...row(1005), kind: 'channel', title: 'Announcements', unread: 14, muted: true }
const ROWS: TgDialog[] = [...DIALOGS, CHANNEL, ...MANY]

/** Telegram's order, All chats third as the owner put it, and enough folders to overflow the strip. */
const FOLDERS: FolderSpec[] = [
  { id: 1, title: 'Personal', kind: 'folder', chats: [3002, 1003] },
  { id: 2, title: 'Work', kind: 'folder', chats: MANY.map(one => one.id) },
  { id: 0, title: 'All chats', kind: 'all', chats: ROWS.map(one => one.id) },
  { id: 11, title: 'News', kind: 'shared', chats: [1005] },
  ...['Clients', 'Family', 'Study', 'Travel', 'Reading', 'Dev', 'Old', 'Music'].map((title, index) => ({ id: 20 + index, title, kind: 'folder' as const, chats: [1003] })),
]

const json = (value: unknown): ProcessRunResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const failure = (exitCode: number, stderr: string): ProcessRunResult => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

type Child = { argv: readonly string[]; line: (value: unknown) => void; isKilled: boolean }

type World = {
  runs: (readonly string[])[]
  store: Map<string, unknown>
  children: Child[]
  /** The plugin's $.state values as last written, by key. */
  state: Map<string, unknown>
  /** What the next pass answers; a test changes it between passes. */
  pass: { rows: TgDialog[]; folders: FolderSpec[]; answer?: ProcessRunResult | Promise<ProcessRunResult> }
}

const passes = (seen: World) => seen.runs.filter(argv => argv[1] === 'folders' && argv.includes('--chats')).length
const tgCalls = (seen: World) => seen.runs.filter(argv => argv[0] === 'tg').length

function world(on: On, store: Record<string, unknown> = {}): World {
  const seen: World = { runs: [], store: new Map(Object.entries({ ...STARTED, ...store })), children: [], state: new Map(), pass: { rows: ROWS, folders: FOLDERS } }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('state.set', (_$, e, next) => {
    if (e.plugin === PLUGIN) seen.state.set(e.key, e.value)
    return next(e)
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    seen.runs.push(e.argv)
    const [, cmd] = e.argv
    if (cmd === 'folders') {
      const answer = e.argv.includes('--chats') ? seen.pass.answer : undefined
      return { value: answer === undefined ? folderRun(e.argv, json(seen.pass.rows), seen.pass.folders) : await answer }
    }
    if (cmd === 'dialogs') {
      const at = e.argv.indexOf('--query')
      const query = at < 0 ? undefined : e.argv[at + 1]?.toLowerCase()
      if (e.argv.includes('--archived')) return { value: json([]) }
      return { value: json(query === undefined ? seen.pass.rows.slice(0, 50) : seen.pass.rows.filter(one => one.title.toLowerCase().includes(query))) }
    }
    if (cmd === 'whoami') return { value: json({ username: 'owner_handle', name: 'Owner Example' }) }
    if (cmd === 'allow') return { value: json([]) }
    return { value: json(MESSAGES) }
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
  on('model.complete', () => ({ value: { isAnswered: true, text: '1 fyi', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return seen
}

const tgCommand = (args = '') => ({ command: 'tg', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

async function openPane($: Engine, on: On, options: { props?: RenderPropsOf['Pane']; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, options.store)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(tgCommand())
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: options.props ?? DOCK })
  return { clock, seen, ui }
}

/** The strip's tabs as written: text, not ring stops (a Text keeps no key, so they are read off the strip's first Box). */
async function tabsOf(ui: Ui): Promise<string[]> {
  const strip = (await ui.find({ key: 'strip' })) as { children?: { children?: { type?: string; children?: unknown[] }[] }[] } | undefined
  return (strip?.children?.[0]?.children ?? []).flatMap(one => (one.type === 'Text' && typeof one.children?.[0] === 'string' ? [one.children[0]] : []))
}

/** The chat rows drawn, by id, in order. */
async function drawnIds(ui: Ui): Promise<number[]> {
  return chatIds((await ui.findAll({ type: 'Button' })).map(one => one.key))
}

/** The Folders list's row for `id` (`f2`, `archive`, `foryou`, `bots`), under the list's generation. */
async function folderKey(ui: Ui, id: string): Promise<string> {
  return (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').find(key => key.startsWith('folder:') && key.endsWith(`:${id}`)) ?? `folder:none:${id}`
}

/** The list's generation, read off a drawn row's key. */
async function genOf(ui: Ui): Promise<number> {
  const key = (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').find(one => one.startsWith('dialog:'))
  return Number(key?.split(':')[1])
}

/** A message from a watched chat, shaped as render.py prints it. */
function incoming(chatId: number, id: number, text: string) {
  return {
    event: 'message',
    id,
    chat_id: chatId,
    date: '2026-10-10T12:30:00Z',
    sender: { id: chatId, kind: 'user', username: null, name: 'Contact' },
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
  }
}

const peerOf = (dialog: TgDialog) => ({ id: dialog.id, arg: String(dialog.id), label: dialog.title, kind: dialog.kind })

describe('the strip and the Folders list (§4.7)', () => {
  test("Telegram's order with All chats where the owner put it, digits on the first nine, +N past the edge", async ($, on) => {
    const { ui } = await openPane($, on)
    // The first open lands on Telegram's first folder.
    // ‹ and › draw in one cell each (ui/model NARROW_GLYPHS): at 64 columns four tabs fit, and +10.
    expect(await tabsOf(ui)).toEqual(['1: ‹Personal›', '2: Work', '3: All chats 2', '4: News', '+10'])
    expect(await drawnIds(ui)).toEqual([3002, 1003])
    // The ninth tab: scrolled into view, with the ones before it past the left edge.
    await ui.press({ key: 'digit:9' })
    const tabs = await tabsOf(ui)
    expect(tabs).toContain('9: ‹Reading›')
    expect(tabs).not.toContain('1: Personal')
    expect(tabs[0]).toMatch(/^\+\d+$/)
    // A muted chat's count is dim, marked ·.
    await ui.press({ key: 'digit:4' })
    const channel = await findChat(ui, 1005)
    expect(channel?.text).toContain('·14')
    expect(JSON.stringify(channel)).toContain('"dimColor":true')
    await ui.unmount()
  })

  test('switching folders, For you and Bots runs no tg call', async ($, on) => {
    const { ui, seen, clock } = await openPane($, on)
    await clock.settle()
    const before = tgCalls(seen)
    await ui.press({ key: 'digit:2' })
    expect((await drawnIds(ui)).slice(0, 3)).toEqual([3000, 3001, 3002])
    await ui.press({ key: 'digit:3' })
    expect(await findChat(ui, 1001)).toBeDefined()
    // Bots and For you: pane views after Telegram's folders, in the Folders list.
    await ui.press({ key: 'key:back' })
    for (let i = 0; i < 14; i++) await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: await folderKey(ui, 'bots') }))?.text).toContain('▸')
    await ui.press({ key: 'key:open' })
    expect(await drawnIds(ui)).toEqual([1001])
    await ui.press({ key: 'key:foryou' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › for you')
    expect(tgCalls(seen)).toBe(before)
    await ui.unmount()
  })

  test('h goes up to every folder, shared marked, the Archive, then the pane views; ⏎ comes down into one', async ($, on) => {
    const { ui } = await openPane($, on)
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › folders')
    // A key the Folders list does not bind is caught: a notice says where it works (T9 review M1).
    await ui.press({ key: 'stray:x' })
    expect((await ui.find({ key: 'running' }))?.text).toContain('x: mark works in a chat')
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › folders')
    const rows = (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').filter(key => key.startsWith('folder:'))
    expect(rows.slice(0, 4).map(key => key.split(':')[2])).toEqual(['f1', 'f2', 'f0', 'f11'])
    expect((await ui.find({ key: rows[3] ?? '' }))?.text).toContain('4: News · shared')
    expect((await ui.find({ key: 'bar' }))?.text).toContain('1-9: folder')
    // The cursor starts on the folder it came from; j and ⏎ open the next one.
    expect((await ui.find({ key: rows[0] ?? '' }))?.text).toContain('▸')
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:open' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › chats')
    expect((await drawnIds(ui)).length).toBeGreaterThan(5)
    // h in the Folders list, the top, goes back down to the chats; it never falls through to the prompt.
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'key:back' }))?.text).toBe('chats')
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › chats')
    // y from the Folders list opens For you.
    await ui.press({ key: 'key:back' })
    await ui.press({ key: 'key:foryou' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › for you')
    await ui.unmount()
  })

  test('inline: the Folders list in two columns; the strip shares the header row', async ($, on) => {
    const { ui } = await openPane($, on, { props: INLINE })
    expect((await ui.find({ key: 'header' }))?.text).toContain('1: ‹Personal›')
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'folders:columns' })).toBeDefined()
    expect((await ui.find({ key: 'folders:right' }))?.text).toContain('Bots')
    await ui.unmount()
  })

  test('the last folder used is remembered; the next session paints its rows before its first pass', async ($, on) => {
    const first = await openPane($, on)
    await first.ui.press({ key: 'digit:2' })
    const stored = first.seen.store.get('folders') as { view: unknown; rows: TgDialog[]; list: unknown[] }
    expect(stored.view).toEqual({ kind: 'folder', id: 2 })
    expect(stored.rows.map(one => one.id).slice(0, 2)).toEqual([3000, 3001])
    await first.ui.unmount()
  })

  test('a new session with a stored folder shows it at once, while its first pass is still out', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const work = MANY.slice(0, 5)
    const seen = world(on, { folders: { list: [{ id: 1, title: 'Personal', kind: 'folder', unread: 0 }, { id: 2, title: 'Work', kind: 'folder', unread: 2 }], view: { kind: 'folder', id: 2 }, rows: work } })
    seen.pass.answer = new Promise(() => undefined)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
    // `…`: the pass is on its way (§7.4).
    expect(await tabsOf(ui)).toEqual(['1: Personal', '2: ‹Work 2›', '3: For you', '4: Bots', '…'])
    expect(await drawnIds(ui)).toEqual(work.map(one => one.id))
    expect(passes(seen)).toBe(1)
    await ui.unmount()
  })

  test('s searches every chat with tg dialogs --query, not the folder; h goes back to the folder', async ($, on) => {
    const { ui, seen } = await openPane($, on)
    await ui.press({ key: 'key:search' })
    await ui.input({ key: 'search', text: 'contact 6' })
    expect(seen.runs.some(argv => argv[1] === 'dialogs' && argv.includes('--query') && argv.includes('contact 6'))).toBe(true)
    // Contact 60 to 69 are in Work, not in Personal, the folder on screen.
    expect((await drawnIds(ui)).length).toBe(10)
    await ui.press({ key: 'key:back' })
    expect(await drawnIds(ui)).toEqual([3002, 1003])
    await ui.unmount()
  })
})

describe('passes (§8 T9)', () => {
  test('one on opening; a second within 60 s does not run; the cadence runs one every 60 s while open', async ($, on) => {
    const { seen, clock } = await openPane($, on)
    expect(passes(seen)).toBe(1)
    await $.command.run(tgCommand('hide'))
    await $.command.run(tgCommand())
    await clock.advance(30_000)
    expect(passes(seen)).toBe(1)
    await clock.advance(30_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
  })

  test('g inside the 60 s queues one pass for when they are up, says refreshing in N s; a second g adds none', async ($, on) => {
    const { ui, seen, clock } = await openPane($, on)
    await clock.advance(20_000)
    await ui.press({ key: 'key:reload' })
    expect(passes(seen)).toBe(1)
    expect((await ui.find({ key: 'running' }))?.text).toContain('refreshing in 40 s')
    await clock.advance(10_000)
    await ui.press({ key: 'key:reload' })
    expect((await ui.find({ key: 'running' }))?.text).toContain('refreshing in 30 s')
    await clock.advance(30_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
    await clock.advance(1_000)
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    await ui.unmount()
  })

  test('every 5 min while hidden once the pane was opened; never before', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, { mode: 'hidden' })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(10 * 60_000)
    expect(passes(seen)).toBe(0)
    await $.command.run(tgCommand())
    await clock.settle()
    await $.command.run(tgCommand('hide'))
    expect(passes(seen)).toBe(1)
    await clock.advance(4 * 60_000)
    expect(passes(seen)).toBe(1)
    await clock.advance(60_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
  })

  test('a hot reload keeps the 60 s: the last start is in $.state', async ($, on) => {
    const { seen, clock } = await openPane($, on)
    await clock.advance(10_000)
    // A hot reload fires session.start again; the module starts over, $.state stays.
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand())
    await clock.settle()
    expect(passes(seen)).toBe(1)
    await clock.advance(50_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
  })

  test('exit 5 keeps the pass, shows the wait counting down, and holds the next pass until it is over', async ($, on) => {
    const { ui, seen, clock } = await openPane($, on)
    const shown = await drawnIds(ui)
    seen.pass.answer = failure(5, 'error: FLOOD_WAIT 90s: Telegram asks to wait before retrying')
    await clock.advance(60_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
    expect(await drawnIds(ui)).toEqual(shown)
    expect((await ui.find({ key: 'running' }))?.text).toContain('Telegram asks to wait 90 s · retrying')
    await clock.advance(1_000)
    expect((await ui.find({ key: 'running' }))?.text).toContain('Telegram asks to wait 89 s · retrying')
    seen.pass.answer = undefined
    await clock.advance(60_000)
    expect(passes(seen)).toBe(2)
    await clock.advance(29_000)
    await clock.settle()
    expect(passes(seen)).toBe(3)
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    await ui.unmount()
  })

  test('a first open whose pass floods for less than the 60 s gap: the list counts down to the retry, which runs once, at 60 s (T7)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.pass.answer = failure(5, 'error: FLOOD_WAIT 40s: Telegram asks to wait before retrying')
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run(tgCommand())
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
    expect(passes(seen)).toBe(1)
    expect(await ui.find({ type: 'Text', text: 'Telegram asks to wait 60 s; retrying then.' })).toBeDefined()
    seen.pass.answer = undefined
    // Past Telegram's 40 s the pass is still inside its 60 s gap: no pass, and the count goes on.
    await clock.advance(45_000)
    await clock.settle()
    expect(passes(seen)).toBe(1)
    expect(await ui.find({ type: 'Text', text: 'Telegram asks to wait 15 s; retrying then.' })).toBeDefined()
    await clock.advance(15_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
    expect((await drawnIds(ui)).length).toBeGreaterThan(0)
    await clock.advance(5_000)
    await clock.settle()
    expect(passes(seen)).toBe(2)
    await ui.unmount()
  })

  test('any other failure keeps the pass and says so with g: retry; the cadence goes on', async ($, on) => {
    const { ui, seen, clock } = await openPane($, on)
    seen.pass.answer = failure(1, 'error: the network is down')
    await clock.advance(60_000)
    await clock.settle()
    expect(await drawnIds(ui)).toEqual([3002, 1003])
    expect((await ui.find({ key: 'running' }))?.text).toContain('tg: the network is down · g: retry')
    seen.pass.answer = undefined
    await clock.advance(60_000)
    await clock.settle()
    expect(passes(seen)).toBe(3)
    expect(await ui.find({ key: 'running' })).toBeUndefined()
    await ui.unmount()
  })

  test("$.state holds only the view on screen, each last_text cut to 120; $.store the same view's rows", async ($, on) => {
    const { ui, seen, clock } = await openPane($, on)
    seen.pass.rows = ROWS.map(one => (one.id === 3001 ? { ...one, last_text: 'x'.repeat(300) } : one))
    await clock.advance(60_000)
    await clock.settle()
    await ui.press({ key: 'digit:2' })
    const viewRows = () => {
      const view = seen.state.get('dialogs') as { status: string; value?: TgDialog[] } | undefined
      return view?.status === 'ok' ? (view.value ?? []) : []
    }
    const rows = viewRows()
    expect(rows.map(one => one.id)).toEqual(MANY.map(one => one.id))
    expect(Math.max(...rows.map(one => one.last_text.length))).toBeLessThanOrEqual(120)
    expect(rows.find(one => one.id === 3001)?.last_text).toBe('x'.repeat(120))
    await ui.press({ key: 'digit:1' })
    expect(viewRows().map(one => one.id)).toEqual([3002, 1003])
    expect((seen.store.get('folders') as { rows: TgDialog[] }).rows.map(one => one.id)).toEqual([3002, 1003])
    await ui.unmount()
  })

  test("a watch event moves its chat up in every folder that lists it, in the module's map, under the folder's pins", async ($, on) => {
    const { ui, seen, clock } = await openPane($, on, { store: { 'triage.watched': [peerOf(row(3040))] } })
    seen.pass.folders = FOLDERS.map(one => (one.id === 1 ? { ...one, chats: [1003, 3002, 3040], pinned: [1003] } : one))
    await clock.advance(60_000)
    await clock.settle()
    await ui.press({ key: 'digit:2' })
    seen.children.find(child => child.argv.includes('3040'))?.line(incoming(3040, 9001, 'a new message'))
    await clock.settle()
    // Work, on screen: nothing moves while the cursor stays.
    expect((await drawnIds(ui)).slice(0, 2)).toEqual([3000, 3001])
    // Personal, from the module's map: 3040 is now first after the pinned chat.
    await ui.press({ key: 'digit:1' })
    expect(await drawnIds(ui)).toEqual([1003, 3040, 3002])
    // Work again: it switched from the map, so 3040 is on top.
    await ui.press({ key: 'digit:2' })
    expect((await drawnIds(ui)).slice(0, 2)).toEqual([3040, 3000])
    await ui.unmount()
  })
})

// --- the ring keeps its place (§4.3, §8 T9) ---

/** Ring stops (Buttons, Inputs, Selects) before the element keyed `key`, in document order. */
async function stopsBefore(ui: Ui, key: string): Promise<number> {
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

/** The ring's place: the cursor row's chat, the stops before it, and the window's first chat. */
async function place(ui: Ui) {
  const cursor = (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true && one.key?.startsWith('dialog:') === true)
  const key = cursor?.key ?? ''
  return { chat: chatIds([key])[0], before: await stopsBefore(ui, key), first: (await drawnIds(ui))[0] }
}

const SEATS = [
  ...[30, 31, 32, 33].map(bodyRows => ({ name: `dock ${bodyRows} rows`, props: { ...DOCK, scroll: { offset: 0, bodyRows } } })),
  ...[11, 12, 13].map(bodyRows => ({ name: `inline ${bodyRows} rows`, props: { ...INLINE, scroll: { offset: 0, bodyRows } } })),
]

describe('a list that changes while the cursor stays keeps the ring (§4.3, §8 T9)', () => {
  /** Work, the cursor on its seventh chat; 3002 to 3004, above it, are watched. */
  async function inWork($: Engine, on: On, props: RenderPropsOf['Pane']) {
    const opened = await openPane($, on, { props, store: { 'triage.watched': [3002, 3003, 3004].map(id => peerOf(row(id))) } })
    await opened.ui.press({ key: 'digit:2' })
    for (let i = 0; i < 6; i++) await opened.ui.press({ key: 'key:down' })
    return opened
  }

  for (const seat of SEATS) {
    const inline = seat.props.placement === 'inline'
    test(`${seat.name}: a watch event that would move a chat above the cursor waits (↑1); its count changes in place`, async ($, on) => {
      const { ui, seen, clock } = await inWork($, on, seat.props)
      const base = await place(ui)
      expect(base.chat).toBe(3006)
      const gen = await genOf(ui)
      seen.children.find(child => child.argv.includes('3002'))?.line(incoming(3002, 9001, 'a new message'))
      await clock.settle()
      expect(await place(ui)).toEqual(base)
      expect(await genOf(ui)).toBe(gen)
      // The count changes in place, after the watch column's ◎ (§7.3).
      expect((await findChat(ui, 3002))?.text).toMatch(/Contact 12 +◎ +1 /)
      if (inline) expect((await ui.find({ key: 'notice' }))?.text).toBe('↑ 1 moved · g: apply')
      else expect((await ui.find({ key: 'strip' }))?.text).toContain('↑1')
      await ui.unmount()
    })

    test(`${seat.name}: a pass landing while the cursor is in Chats changes counts in place only`, async ($, on) => {
      const { ui, seen, clock } = await inWork($, on, seat.props)
      const base = await place(ui)
      const ids = await drawnIds(ui)
      // The next pass: 3050 moved to the top with news, 3001 has 4 unread.
      seen.pass.rows = ROWS.map(one => (one.id === 3050 ? { ...one, unread: 2, last_date: '2026-10-10T12:30:00Z' } : one.id === 3001 ? { ...one, unread: 4 } : one))
      seen.pass.folders = FOLDERS.map(one => (one.id === 2 ? { ...one, chats: [3050, ...one.chats.filter(id => id !== 3050)] } : one))
      await clock.advance(60_000)
      await clock.settle()
      expect(passes(seen)).toBe(2)
      expect(await place(ui)).toEqual(base)
      expect(await drawnIds(ui)).toEqual(ids)
      expect((await findChat(ui, 3001))?.text).toMatch(/Contact 11 +4 /)
      await ui.unmount()
    })

    test(`${seat.name}: ⏎ into a chat, h, a folder switch and g each apply what waits; new keys, the ring on the cursor's chat`, async ($, on) => {
      const { ui, seen, clock } = await inWork($, on, seat.props)
      /** A watched chat above the cursor writes: it would move to the top, and waits. */
      const wait = async (id: number) => {
        seen.children.find(child => child.argv.includes(String(id)))?.line(incoming(id, 9000 + id, `news ${id}`))
        await clock.settle()
      }
      /** The cursor row as drawn: the ring's target is its key, so it carries the list's generation. */
      const ringed = async () => (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key
      // g: the list reshapes under a new generation; the cursor stays on its chat, the ring on that chat's new key.
      await wait(3002)
      const gen = await genOf(ui)
      await ui.press({ key: 'key:reload' })
      expect(await genOf(ui)).toBeGreaterThan(gen)
      expect((await drawnIds(ui))[0]).toBe(3002)
      expect(await ringed()).toBe(`dialog:${await genOf(ui)}:3006`)
      // ⏎ into a chat applies; h back applies what came meanwhile.
      await wait(3003)
      const gen2 = await genOf(ui)
      await ui.press({ key: 'key:open' })
      await wait(3004)
      await ui.press({ key: 'key:back' })
      expect(await genOf(ui)).toBeGreaterThan(gen2 + 1)
      expect((await drawnIds(ui))[0]).toBe(3004)
      expect(await ringed()).toBe(`dialog:${await genOf(ui)}:3006`)
      // A folder switch: 3002 is in Work and in Personal, and its row comes back under a new key.
      const gen3 = await genOf(ui)
      await ui.press({ key: 'digit:1' })
      expect(await genOf(ui)).toBeGreaterThan(gen3)
      expect(await ringed()).toBe(`dialog:${await genOf(ui)}:3002`)
      // h up to the Folders list and down again: Work, as the module's map has it.
      await ui.press({ key: 'key:back' })
      await ui.press({ key: 'key:down' })
      await ui.press({ key: 'key:open' })
      expect((await drawnIds(ui)).slice(0, 3)).toEqual([3004, 3003, 3002])
      await ui.unmount()
    })
  }
})
