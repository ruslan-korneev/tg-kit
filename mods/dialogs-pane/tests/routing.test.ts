// Routing through the engine: the send sheet (dialogs-pane-ux.md §5.1, §8 T2)
// with its intents by sender, its targets from the radar, inspect and marks;
// new agent, broadcast, the ledger, live pins, the Hidden band and drafted
// replies. tg, the agents and the session are answered beneath the plugin.
import type { AgentInfo, On, ProcessRunResult, RenderPropsOf, SessionSendInput } from 'claude-code'
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import { hotkeyTable } from '../hooks/ui/keys'
import { DIALOGS, MESSAGES, MORE_DIALOGS, PERSON_MESSAGES, chatKey, findChat, folderRun, messagesFor } from './fixtures'

const PLUGIN = 'dialogs-pane'

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'tg · dialogs',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

const run = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})
const json = (value: unknown) => run(0, JSON.stringify(value))

type Ran = { argv: readonly string[]; stdin?: string }

type World = {
  runs: Ran[]
  spawns: (readonly string[])[]
  sends: Pick<SessionSendInput, 'to' | 'text'>[]
  spawned: string[]
  prompts: string[]
  toasts: string[]
  logs: string[]
  agents: AgentInfo[]
  store: Map<string, unknown>
}

const ALL_DIALOGS = [...DIALOGS, ...MORE_DIALOGS]

/** tg answers: dialogs, each chat's thread, `tg msg` from them (exit 4 when one is missing). */
function tgAnswer(argv: readonly string[]): ProcessRunResult {
  if (argv[1] === 'dialogs') return json(ALL_DIALOGS)
  if (argv[1] === 'folders') return folderRun(argv, json(ALL_DIALOGS))
  if (argv[1] === 'read') return json(messagesFor(argv[2]))
  if (argv[1] === 'msg') {
    const ids = argv.slice(3, -1).map(Number)
    const found = messagesFor(argv[2]).filter(message => ids.includes(message.id))
    return found.length === ids.length ? json(found) : run(4, JSON.stringify(found), 'error: no message in @example_bot')
  }
  return run(1, '', `error: unexpected ${argv.join(' ')}`)
}

function world(
  on: On,
  options: {
    tg?: (ran: Ran) => ProcessRunResult
    /** As `tg`, for a run that has to wait on something, such as a turn finishing meanwhile. */
    tgAsync?: (ran: Ran) => Promise<ProcessRunResult>
    watch?: readonly string[]
    /** A prompt.submit hook refuses every prompt with this reason. */
    drop?: string
    /** Each watch prints `ready`, waits for this, then prints `watch` and exits. */
    gate?: Promise<void>
    store?: Record<string, unknown>
  } = {},
): World {
  const store = new Map(Object.entries(options.store ?? {}))
  const seen: World = { runs: [], spawns: [], sends: [], spawned: [], prompts: [], toasts: [], logs: [], agents: [], store }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    const ran: Ran = { argv: e.argv, stdin: e.init?.stdin }
    seen.runs.push(ran)
    const answer = options.tgAsync ?? (async (one: Ran) => (options.tg ?? (two => tgAnswer(two.argv)))(one))
    // `tg folders`: the chats this world's `tg dialogs` answers, as one All chats folder.
    if (e.argv[1] === 'folders') return { value: folderRun(e.argv, await answer({ argv: ['tg', 'dialogs', '--limit', '50', '--json'], stdin: undefined })) }
    return { value: await answer(ran) }
  })
  on('process.spawn', async function* (_$, e) {
    seen.spawns.push(e.argv)
    if (options.gate !== undefined) {
      yield { stream: 'stdout', text: `${JSON.stringify({ event: 'ready', peers: [] })}\n` }
      await options.gate
    }
    for (const line of options.watch ?? []) yield { stream: 'stdout', text: `${line}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: seen.agents }))
  on('session.send', (_$, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  // The kit keeps `agentId` for core alone: a plugin's spawn here resolves without one.
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e.prompt)
    return { model: 'test' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('prompt.submit', (_$, e) => {
    seen.prompts.push(e.text)
    return options.drop === undefined ? { text: e.text } : { drop: options.drop }
  })
  return seen
}

const NOW = Date.parse('2026-10-10T12:00:00Z')
const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const WIDE = { command: 'tg', args: 'wide', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const TESTER: AgentInfo = { id: 'agent-1', name: 'tester', description: 'run the tests', type: 'general-purpose', status: 'running' }

/** /tg, open @example_bot, select #677791 (it replies to #677790, already loaded). */
async function openAndSelect($: Engine, clock: MockClock) {
  await $.session.start(START)
  await $.command.run(WIDE)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
  await ui.press({ key: await chatKey(ui, 1001) })
  await ui.press({ key: 'key:up' })
  await ui.press({ key: 'key:mark' })
  return ui
}

type Ui = Awaited<ReturnType<typeof openAndSelect>>

/**
 * The send sheet (§5.1): ⏎ (the bar's `send…`), then `a` and a target digit
 * when the target is not main, then the intent's digit, which sends at once.
 */
async function sendTo(ui: Ui, target = 'route:main', intent = 'fix') {
  await ui.press({ key: 'key:send' })
  if (target !== 'route:main') {
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: target })
  }
  await ui.press({ key: `sheet:intent:${intent}` })
}

/** The sheet's intent Buttons in digit order: `1: fix`, … as hotkey and key. */
async function sheetIntents(ui: Ui): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.flatMap(button => {
    const key = String(button.props.key ?? '')
    return key.startsWith('sheet:intent:') ? [`${String(button.props.hotkey)}: ${key.slice('sheet:intent:'.length)}`] : []
  })
}

/** The Button ⏎ presses: the one the sheet draws autoFocus (openSheet moves the ring there too). */
async function ringed(ui: Ui): Promise<string | undefined> {
  const buttons = await ui.findAll({ type: 'Button' })
  const key = buttons.find(button => String(button.props.key ?? '').startsWith('sheet:') && button.props.autoFocus === true)?.props.key
  return key === undefined ? undefined : String(key)
}

/** ⏎ in the sheet: the engine presses the ringed Button. */
async function enter(ui: Ui) {
  const key = await ringed(ui)
  if (key === undefined) throw new Error('nothing ringed in the sheet')
  await ui.press({ key })
}

/** /tg, then ⏎ on chat `id`'s row and the cursor on message `message` (Chats open on the bot). */
async function openChatAt($: Engine, clock: MockClock, id: number, message: number) {
  await $.session.start(START)
  await $.command.run(WIDE)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: PANE_PROPS })
  await ui.press({ key: await chatKey(ui, id) })
  for (let i = 0; i < 5 && !((await ui.find({ key: `msg:${message}` }))?.text ?? '').includes('▸'); i++) await ui.press({ key: 'key:up' })
  return ui
}

describe('the send sheet: send to main', () => {
  test('⏎ 1 sends one Fix packet to main: the packet and its intent line as a visible prompt (2 steps)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const session = mock.session(on)
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    // The sheet takes the bar's place under the chat: the thread stays, its cursor ▸ too.
    expect(await ui.find({ key: 'bar' })).toBeUndefined()
    expect((await ui.find({ key: 'card:677791' }))?.text).toContain('Something went wrong')
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('send #677791 + 1 parent')
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('→ main · idle')
    expect(await sheetIntents(ui)).toEqual(['1: fix', '2: reproduce', '3: explain', '4: test', '5: raw'])
    expect((await ui.find({ key: 'sheet:intent:raw' }))?.text).toBe('Ask in my words…')
    // Bots start on Fix: ⏎ would send it.
    expect(await ringed(ui)).toBe('sheet:intent:fix')
    await ui.press({ key: 'sheet:intent:fix' })

    // One prompt, the packet whole: what the transcript shows is what the model reads.
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toMatch(/^<tg-packet v="1" intent="fix"/)
    expect(seen.prompts[0]).toContain('<message id="677790"')
    expect(seen.prompts[0]).toMatch(/\nIntent: Fix — /)
    // No hidden row and no separate wake-up line.
    expect(session.appended()).toEqual([])
    expect(seen.logs).toEqual([])
    // The parent was in the thread: no tg msg ran.
    expect(seen.runs.some(one => one.argv[1] === 'msg')).toBe(false)
    // Delivered everywhere: the marks are cleared, the sheet is gone, the bar is back.
    expect(await ui.find({ key: 'marks' })).toBeUndefined()
    expect(await ui.find({ key: 'sheet' })).toBeUndefined()
    expect(await ui.find({ key: 'bar' })).toBeDefined()

    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('#677791 @example_bot → main · Fix · · sent')
    await $.turn.start({ text: '', turnId: 't-1' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('…working')
    await $.turn.complete({ answer: 'fixed', durationMs: 10, isAborted: false, turnId: 't-1', reason: 'answer' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('✓ done')
    await ui.unmount()
  })

  test('⏎ ⏎ repeats the last intent used for this kind of sender, kept in $.store', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    // ⏎ 3: Explain, two steps.
    await ui.press({ key: 'msg:677791' })
    await ui.press({ key: 'sheet:intent:explain' })
    expect(seen.prompts[0]).toMatch(/\nIntent: Explain — explain what happened in these messages and which code path/)
    expect(seen.store.get('send.intents')).toEqual({ bot: 'explain' })
    // ⏎ ⏎: the ring is on Explain now, so the second ⏎ sends it again.
    await ui.press({ key: 'msg:677791' })
    expect(await ringed(ui)).toBe('sheet:intent:explain')
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('last used for bots')
    await enter(ui)
    expect(seen.prompts).toHaveLength(2)
    expect(seen.prompts[1]).toContain('intent="explain"')
    await ui.unmount()
  })

  test('the remembered intent comes from $.store, so another session rings it too', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on, { store: { 'send.intents': { bot: 'test', person: 'nonsense' } } })
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    expect(await ringed(ui)).toBe('sheet:intent:test')
    await ui.unmount()
  })

  test('Ask: the last digit opens a field; its words are the intent line; an empty one goes back', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'sheet:intent:raw' })
    expect(await ui.find({ key: 'sheet:intents' })).toBeUndefined()
    expect((await ui.find({ key: 'sheet:ask' }))?.props.autoFocus).toBe(true)
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('⏎ on an empty field goes back')
    await ui.input({ key: 'sheet:ask', text: '   ' })
    expect(await ui.find({ key: 'sheet:intents' })).toBeDefined()
    expect(seen.prompts).toEqual([])
    await ui.press({ key: 'sheet:intent:raw' })
    await ui.input({ key: 'sheet:ask', text: 'why does Retry fail right after /settings?' })
    expect(seen.prompts).toHaveLength(1)
    expect(seen.prompts[0]).toContain('intent="raw"')
    expect(seen.prompts[0]).toMatch(/<\/tg-packet>\nwhy does Retry fail right after \/settings\?$/)
    expect(seen.prompts[0]).not.toContain('Intent:')
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('→ main · Ask')
    await ui.unmount()
  })

  test('a busy main gets the packet as its next prompt; the ledger waits for that turn', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await $.turn.start({ text: 'working on something', turnId: 't-0' })
    await ui.press({ key: 'key:send' })
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('→ main · …running')
    await ui.press({ key: 'sheet:intent:fix' })
    expect(seen.prompts).toHaveLength(1)
    // The running turn ends: not the packet's turn, so the entry is still waiting.
    await $.turn.complete({ answer: 'other work', durationMs: 1, isAborted: false, turnId: 't-0', reason: 'answer' })
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('· sent')
    await ui.unmount()
  })

  test('a prompt a hook drops marks the entry failed', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on, { drop: 'prompts are paused' })
    const ui = await openAndSelect($, clock)
    await sendTo(ui)
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('⚠ prompts are paused')
    await ui.unmount()
  })

  test('a parent outside the thread is fetched with tg msg; exit 4 leaves it missing', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const orphan = { ...MESSAGES[2], id: 677793, reply_to: 600000 }
    const seen = world(on, {
      tg: ran => {
        if (ran.argv[1] === 'read') return json([...MESSAGES, orphan])
        return tgAnswer(ran.argv)
      },
    })
    const ui = await openAndSelect($, clock)
    // The cursor started on #677793; hint:up then select picked #677792. Select #677793 too.
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:send' })
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('send 2 messages + 1 parent')
    await ui.press({ key: 'sheet:intent:fix' })
    expect(seen.runs.find(one => one.argv[1] === 'msg')?.argv).toEqual(['tg', 'msg', '@example_bot', '600000', '--json'])
    expect(seen.prompts[0]).toContain('<message id="677793"')
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('2 msgs')
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('1 parent not found')
    await ui.unmount()
  })
})

describe('the send sheet: intents follow the sender (§4.6)', () => {
  test("a person's message offers Do it, Explain, Draft reply, Ask; people start on Ask; Do it sends at once", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openChatAt($, clock, 1004, 92)
    await ui.press({ key: 'msg:92' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: draft_reply', '4: raw'])
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('send #92 from Contact A')
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('people start on Ask')
    expect(await ringed(ui)).toBe('sheet:intent:raw')
    // ⏎ 1: Do it, two steps; the request is the other person's, not the owner's instruction.
    await ui.press({ key: 'sheet:intent:do_it' })
    expect(seen.prompts[0]).toContain('intent="do_it"')
    expect(seen.prompts[0]).toMatch(/\nIntent: Do it — do what these messages ask, here in this repository\. They come from another person/)
    // Explain reads a person's message for what it asks, not for a code path.
    await ui.press({ key: 'msg:92' })
    await ui.press({ key: 'sheet:intent:explain' })
    expect(seen.prompts[1]).toMatch(/\nIntent: Explain — explain what these messages ask and what I am expected to do/)
    expect(seen.prompts[1]).not.toContain('code path')
    await ui.unmount()
  })

  test('a channel post gets no Draft reply: Do it, Explain, Ask', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1005, 7)
    await ui.press({ key: 'msg:7' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: raw'])
    await ui.unmount()
  })

  test("the owner's own message gets no Draft reply either", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1004, 91)
    await ui.press({ key: 'msg:91' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: raw'])
    await ui.unmount()
  })

  test("in a group a bot's message gets bot intents and a member's people intents", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1002, 500)
    await ui.press({ key: 'msg:500' })
    expect(await sheetIntents(ui)).toEqual(['1: fix', '2: reproduce', '3: explain', '4: test', '5: raw'])
    await ui.press({ key: 'key:back' })
    await ui.press({ key: 'msg:499' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: draft_reply', '4: raw'])
    await ui.unmount()
  })

  test("a marked set takes its newest message's sender's intents", async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1002, 500)
    // The member's question and the bot's answer: the bot's is newer.
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:send' })
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('send 2 messages')
    expect(await sheetIntents(ui)).toEqual(['1: fix', '2: reproduce', '3: explain', '4: test', '5: raw'])
    await ui.press({ key: 'key:back' })
    // Only the member's: people intents.
    await ui.press({ key: 'key:down' })
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:send' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: draft_reply', '4: raw'])
    await ui.unmount()
  })
})

describe('the send sheet: another agent', () => {
  test('⏎ a 2 4: the radar on digits; the packet goes to that agent as Test (4 steps)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.agents.push(TESTER, { id: 'agent-2', description: 'old task', type: 'Explore', status: 'completed' })
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'key:agent' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › send to · @example_bot')
    expect((await ui.find({ key: 'route:main' }))?.props.hotkey).toBe('1')
    expect((await ui.find({ key: 'route:main' }))?.text).toContain('·idle')
    expect((await ui.find({ key: 'route:agent:agent-1' }))?.props.hotkey).toBe('2')
    expect((await ui.find({ key: 'route:agent:agent-1' }))?.text).toContain('…running')
    expect((await ui.find({ key: 'route:agent:agent-2' }))?.text).toContain('✓ done')
    expect((await ui.find({ key: 'route:new' }))?.text).toBe('+ a new agent, this packet as its brief')
    expect((await ui.find({ key: 'route:broadcast' }))?.text).toBe('⇉ several agents, an intent each')
    await ui.press({ key: 'route:agent:agent-1' })
    // Back on the intents, now sending to tester; nothing went yet.
    expect(seen.sends).toEqual([])
    expect((await ui.find({ key: 'sheet' }))?.text).toContain('→ tester · …running')
    await ui.press({ key: 'sheet:intent:test' })
    expect(seen.sends.map(one => one.to)).toEqual(['agent-1'])
    expect(seen.sends[0]?.text).toContain('<tg-packet v="1" intent="test"')

    // The radar: running → working; the agent's own turn ending → done.
    await clock.advance(5000)
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('→ tester · Test · …working')
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'agent-1' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('✓ done')
    await ui.unmount()
  })

  test('+ new agent spawns one whose brief is the packet', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await sendTo(ui, 'route:new')
    expect(seen.spawned).toHaveLength(1)
    expect(seen.spawned[0]).toContain('<tg-packet v="1" intent="fix"')
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'ledger:1' }))?.text).toContain('→ +tg Fix #677791 · Fix · · sent')
    await ui.unmount()
  })

  test('⇉ several agents: one packet, an intent per leg from the sender\'s own; legs on digits', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    seen.agents.push(TESTER)
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'route:broadcast' })
    expect((await ui.find({ key: 'leg:1:on' }))?.props.hotkey).toBe('2')
    // h goes back to the targets, and a picks the legs again.
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'route:main' })).toBeDefined()
    await ui.press({ key: 'route:broadcast' })
    // Rows: main (on, Fix), tester (off, Reproduce), new agent (off, Test).
    await ui.press({ key: 'leg:1:on' })
    await ui.press({ key: 'leg:2:on' })
    // A bot's legs cycle bot intents: Test → Fix, never Draft reply.
    await ui.press({ key: 'leg:2:intent' })
    await ui.press({ key: 'broadcast:done' })
    expect(seen.prompts[0]).toContain('intent="fix"')
    expect(seen.sends[0]?.text).toContain('intent="reproduce"')
    expect(seen.spawned[0]).toContain('intent="fix"')
    await ui.unmount()
  })
})

describe('the send sheet: inspect, marks', () => {
  test('redaction off in inspect holds for every leg of ⇉ several agents', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'key:inspect' })
    await ui.press({ key: 'sheet:redact' })
    await ui.press({ key: 'key:back' })
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'route:broadcast' })
    await ui.press({ key: 'leg:1:on' })
    await ui.press({ key: 'broadcast:done' })
    expect(seen.prompts[0]).toContain('redacted="false"')
    expect(seen.spawned[0]).toContain('redacted="false"')
    await ui.unmount()
  })

  test('i shows what the agent reads: facts, the masks; ⏎ turns redaction off for this packet only', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on)
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:send' })
    // #677790 is from Me: its name and ids are masked; the bot stays readable.
    expect((await ui.find({ key: 'key:inspect' }))?.text).toBe('inspect (3 masked)')
    await ui.press({ key: 'key:inspect' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › inspect · @example_bot')
    const shown = (await ui.find({ key: 'inspect' }))?.text ?? ''
    expect(shown).toContain('inspect · main reads this')
    expect(shown).toContain('@example_bot (bot) · Fix · redacted')
    expect(shown).toContain('#677791 bot  "⚠ Something went wrong" · buttons Retry, Back')
    expect(shown).toContain('+ parent #677790 you  "/settings"')
    expect(shown).toContain('tg send @example_bot /settings')
    expect(shown).toContain('1003 → [id-')
    expect(shown).toContain('Me → [name-')
    await ui.press({ key: 'sheet:redact' })
    expect((await ui.find({ key: 'inspect' }))?.text).toContain('nothing: redaction is off for this packet')
    // h: back to the intents, which say so; the digit sends this packet unredacted.
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'key:inspect' }))?.text).toBe('inspect (not redacted)')
    await ui.press({ key: 'sheet:intent:fix' })
    expect(seen.prompts[0]).toContain('intent="fix" source="dialogs-pane" redacted="false"')
    // The next packet is redacted again: the toggle was this packet's.
    await ui.press({ key: 'msg:677791' })
    await ui.press({ key: 'sheet:intent:fix' })
    expect(seen.prompts[1]).toContain('redacted="true"')
    await ui.unmount()
  })

  test('i in a chat opens the sheet on inspect for the cursor message; h then shows its intents', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1004, 92)
    await ui.press({ key: 'key:inspect' })
    expect((await ui.find({ key: 'inspect' }))?.text).toContain('Contact A (person) · Ask · redacted')
    // A person's name is masked in what the agent reads.
    expect((await ui.find({ key: 'inspect' }))?.text).toContain('#92 [name-')
    await ui.press({ key: 'key:back' })
    expect(await sheetIntents(ui)).toEqual(['1: do_it', '2: explain', '3: draft_reply', '4: raw'])
    await ui.press({ key: 'key:back' })
    expect(await ui.find({ key: 'sheet' })).toBeUndefined()
    await ui.unmount()
  })

  test('marks are ▪ in their own column, never inverse text', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openAndSelect($, clock)
    const row = await ui.find({ key: 'msg:677791' })
    expect(row?.text.startsWith('▸▪')).toBe(true)
    expect(JSON.stringify(row)).not.toContain('"inverse":true')
    await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: 'msg:677791' }))?.text.startsWith(' ▪')).toBe(true)
    expect((await ui.find({ key: 'msg:677792' }))?.text.startsWith('▸ ')).toBe(true)
    await ui.unmount()
  })
})

describe('the send sheet keeps the ring on ▸ (the engine keeps it by place among the stops)', () => {
  const stops = async (ui: Ui) =>
    (await ui.findAll({ type: 'Button' })).flatMap(button => {
      const key = String(button.props.key ?? '')
      return key.startsWith('msg:') || key.startsWith('btn:') ? [key] : []
    })

  test('under the intents and the Ask field the chat is drawn without stops, ▸ kept; h or a send brings the cursor row back ringed', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1001, 677791)
    expect(await stops(ui)).toContain('btn:677791:0:0')
    await ui.press({ key: 'key:send' })
    expect(await stops(ui)).toEqual([])
    expect((await ui.find({ key: 'row:677791' }))?.text.startsWith('▸')).toBe(true)
    expect((await ui.find({ key: 'card:677791' }))?.text).toContain('[ Retry ]')
    await ui.press({ key: 'sheet:intent:raw' })
    expect(await stops(ui)).toEqual([])
    await ui.input({ key: 'sheet:ask', text: '' })
    await ui.press({ key: 'key:back' })
    expect((await ui.find({ key: 'msg:677791' }))?.props.autoFocus).toBe(true)
    expect(await stops(ui)).toContain('btn:677791:0:0')
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'sheet:intent:fix' })
    expect((await ui.find({ key: 'msg:677791' }))?.props.autoFocus).toBe(true)
    await ui.unmount()
  })

  test('targets and inspect take the lower part; back on the intents the chat has no stops again', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const ui = await openChatAt($, clock, 1001, 677791)
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'key:agent' })
    await ui.press({ key: 'key:back' })
    expect(await stops(ui)).toEqual([])
    await ui.unmount()
  })
})

describe('the packet ledger, in Activity (§5.7)', () => {
  test('a packet that left the pane is a line of the log, not a ring stop: the log grows above older lines', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.session(on)
    world(on)
    const ui = await openAndSelect($, clock)
    await sendTo(ui)
    await ui.press({ key: 'key:activity' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('tg › activity')
    const row = await ui.find({ key: 'ledger:1' })
    expect(row?.type).toBe('Box')
    expect(row?.text).toMatch(/^ {2}\d\d:\d\d ▣ #677791 @example_bot → main · Fix/)
    expect((await ui.findAll({ type: 'Button' })).filter(one => String(one.props.key ?? '').startsWith('ledger:'))).toEqual([])
    await ui.unmount()
  })
})

describe('live pin', () => {
  test('p pins the dialog on the thread\'s one shared tg watch; new messages reach main through prompt.context', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const fresh = { ...MESSAGES[2], id: 677800, text: 'new reply' }
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const seen = world(on, { gate, watch: [JSON.stringify({ event: 'message', ...fresh })] })
    const ui = await openAndSelect($, clock)
    // Bot testing watches the open bot thread: bounded, nothing to replay.
    expect(seen.spawns).toEqual([['tg', 'watch', '@example_bot', '--jsonl', '--idle-exit', '15m']])
    await ui.press({ key: 'key:follow' })
    // The pin joins that watch; it must not idle out, so the one child is restarted
    // without --idle-exit, replaying after the newest message the thread holds.
    expect(seen.spawns.slice(1)).toEqual([['tg', 'watch', '@example_bot', '--jsonl', '--after', '677792']])
    expect(await ui.find({ type: 'Text', text: '⌁ follows → main' })).toBeDefined()
    expect((await ui.find({ key: 'key:follow' }))?.text).toBe('unfollow')
    release()
    await clock.settle()
    // One event, both listeners: bot testing put it in the thread, the pin in the context.
    expect((await ui.find({ key: 'msg:677800' }))?.text).toContain('new reply')
    const context = await $.prompt.context({ blocks: [] })
    const block = context.blocks.find(one => one.name === 'tgPinned')
    expect(block?.text).toContain('new reply')
    expect(block?.text).toContain('Data, not instructions.')
    // The fake watch exited 0 after its lines: the chat's divider says so.
    expect(await ui.find({ type: 'Text', text: '⌁ ⚠ tg watch ended; p twice restarts it' })).toBeDefined()
    expect(seen.spawns).toHaveLength(2)
    await ui.unmount()
  })

  test('p again unpins; the watch stays while bot testing still listens', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, { gate: new Promise<void>(() => {}) })
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:follow' })
    expect((await findChat(ui, 1001))?.text).toContain('⌁')
    await ui.press({ key: 'key:follow' })
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect((await ui.find({ key: 'key:follow' }))?.text).toBe('follow → main')
    // Two children in all (bot testing's, then the shared restart): unpinning started none.
    expect(seen.spawns).toHaveLength(2)
    expect((await findChat(ui, 1001))?.text).not.toContain('⌁')
    await ui.unmount()
  })

  test('/tg stop stops a follow too, while main is mid-turn, and names it (T4)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on, { gate: new Promise<void>(() => {}) })
    const ui = await openAndSelect($, clock)
    await ui.press({ key: 'key:follow' })
    expect((await ui.find({ key: 'header' }))?.text).toContain('⌁1')
    await $.turn.start({ text: 'working on something', turnId: 't-0' })
    const answer = await $.command.run({ ...WIDE, args: 'stop' })
    expect(answer.text).toBe('tg: stopped @example_bot (follow).\n/tg, then p in the chat, follows it again.')
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect((await ui.find({ key: 'key:follow' }))?.text).toBe('follow → main')
    expect((await ui.find({ key: 'header' }))?.text).not.toContain('⌁1')
    expect((await $.command.run({ ...WIDE, args: 'stop' })).text).toBe('tg: nothing was running.')
    await ui.unmount()
  })

  test('a dialog pinned to an agent gets its new messages through session.send', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const fresh = { ...MESSAGES[2], id: 677800, text: 'new reply' }
    const seen = world(on, { watch: [JSON.stringify({ event: 'message', ...fresh })] })
    seen.agents.push(TESTER)
    const ui = await openAndSelect($, clock)
    // Picking the agent sends the marked message there, and makes it the pin's target.
    await sendTo(ui, 'route:agent:agent-1')
    await ui.press({ key: 'key:follow' })
    await clock.advance(1500)
    expect(seen.sends.map(one => one.to)).toEqual(['agent-1', 'agent-1'])
    expect(seen.sends[1]?.text).toContain('new reply')
    await ui.unmount()
  })
})

describe('hidden band', () => {
  // Only a watched chat's news reaches the band (§8 T5: the band is what needs the owner).
  const WATCHED_BOT = [{ id: 1001, arg: '@example_bot', label: '@example_bot', kind: 'bot' }]

  test('⏎ sends the newest message of the watched dialog that wrote to main', async ($, on) => {
    let unread = 2
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, {
      store: { mode: 'hidden', 'triage.watched': WATCHED_BOT },
      tg: ran => (ran.argv[1] === 'dialogs' ? json(DIALOGS.map(d => (d.id === 1001 ? { ...d, unread } : d))) : tgAnswer(ran.argv)),
    })
    await $.session.start(START)
    await clock.settle()
    unread = 3
    // The dialogs poll is 5 min since triage made watched dialogs live.
    await clock.advance(300_000)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    // The band names the intent its ⏎ sends: a bot's chat, bots' last intent (Fix before any).
    expect((await band.find({ key: 'band:main' }))?.text).toBe('⏎ send to main as Fix')
    await band.press({ key: 'band:main' })
    expect(seen.prompts[0]).toContain('<message id="677792"')
    expect(seen.prompts[0]).toMatch(/\nIntent: Fix — /)
    await band.unmount()
  })

  test("the band's ⏎ follows the sheet's last intent, but never Ask, which needs words", async ($, on) => {
    let unread = 2
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, {
      store: { mode: 'hidden', 'send.intents': { bot: 'explain', person: 'raw', other: 'raw' }, 'triage.watched': WATCHED_BOT },
      tg: ran => (ran.argv[1] === 'dialogs' ? json(ALL_DIALOGS.map(d => (d.id === 1001 ? { ...d, unread } : d))) : tgAnswer(ran.argv)),
    })
    await $.session.start(START)
    await clock.settle()
    unread = 3
    await clock.advance(300_000)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ key: 'band:main' }))?.text).toBe('⏎ send to main as Explain')
    seen.store.set('send.intents', { bot: 'raw', person: 'raw', other: 'raw' })
    await band.redraw()
    expect((await band.find({ key: 'band:main' }))?.text).toBe('⏎ send to main as Fix')
    await band.unmount()
  })
})

describe('drafted reply: a row of its chat (§8 T3)', () => {
  // Draft reply is a people intent (§4.6): every chat here reads as Contact A's thread.
  const personTg = (argv: readonly string[]) => (argv[1] === 'read' ? json(PERSON_MESSAGES) : tgAnswer(argv))

  const draftRun = (plan: { allowed: boolean; reason: string }) => (ran: Ran) => {
    // tg's guard: --yes confirms a target outside allow.toml; `readonly = true` refuses either way.
    if (ran.argv[1] !== 'send') return personTg(ran.argv)
    const guard = plan.allowed || plan.reason.startsWith('readonly') || !ran.argv.includes('--yes') ? plan : { allowed: true, reason: 'confirmed with --yes' }
    if (ran.argv.includes('--dry-run')) return json({ action: 'send', target: {}, steps: [], guard })
    return json({ sent: [{ id: 677900 }] })
  }

  /** The draft's row, its head the Button ⏎ acts on; its verdict the line under its text. */
  const ROW = 'draft:reply'
  const rowText = async (ui: Ui) => (await ui.find({ key: `card:${ROW}` }))?.text ?? ''

  /** Draft reply on Contact A's #92; main answers; the draft lands as a row after #92, and j puts the cursor on it. */
  async function drafted($: Engine, on: On, plan: { allowed: boolean; reason: string }, dialogs = ALL_DIALOGS, answer = 'On it, fixing now.') {
    const clock = mock.clock(on, { now: NOW })
    const seen = world(on, { tg: ran => (ran.argv[1] === 'dialogs' ? json(dialogs) : draftRun(plan)(ran)) })
    const ui = await openChatAt($, clock, 1004, 92)
    await sendTo(ui, 'route:main', 'draft_reply')
    await $.turn.start({ text: '', turnId: 't-1' })
    await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't-1', reason: 'answer' })
    // No notice and no layer: the row joins the thread after #92, below the cursor.
    expect(await ui.find({ key: 'notice' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').filter(key => key.startsWith('msg:') || key.startsWith('draft:'))).toEqual(['msg:91', 'msg:92', ROW])
    await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: ROW }))?.props.autoFocus).toBe(true)
    return { ui, seen }
  }

  test('the cursor on the row: ⏎ send draft, e, d; one Button per hotkey, each the table’s, the field open too', async ($, on) => {
    const { ui } = await drafted($, on, { allowed: true, reason: 'allowlisted' })
    const owners = hotkeyTable()
    for (const step of ['row', 'field'] as const) {
      if (step === 'field') await ui.press({ key: 'key:edit' })
      // The catch-all's Buttons (`stray:`) bind what nothing else does; they say where a key works.
      const drawn = (await ui.findAll({ type: 'Button' })).flatMap(button => (typeof button.props.hotkey === 'string' && button.key?.startsWith('stray:') !== true ? [button.props.hotkey] : []))
      expect(drawn.filter((key, index) => drawn.indexOf(key) !== index)).toEqual([])
      for (const key of drawn) expect(/^[0-9]$/.test(key) || owners.has(key)).toBe(true)
    }
    expect(await ui.find({ key: `${ROW}:text` })).toBeDefined()
    await ui.unmount()
  })

  test('the guard checks it as it lands; ⏎ on its row sends the same tg send, and the row leaves the thread', async ($, on) => {
    const { ui, seen } = await drafted($, on, { allowed: true, reason: 'allowlisted' })
    const dry = seen.runs.find(one => one.argv.includes('--dry-run'))
    expect(dry?.argv).toEqual(['tg', 'send', '1004', '-', '--reply-to', '92', '--plain', '--json', '--yes', '--dry-run'])
    expect(dry?.stdin).toBe('On it, fixing now.')
    expect(await rowText(ui)).toContain('✎ draft to Contact A · from main')
    expect(await rowText(ui)).toContain('✓ the guard allows it')
    expect((await ui.find({ key: 'key:senddraft' }))?.text).toBe('⏎ send draft')
    await ui.press({ key: ROW })
    const real = seen.runs.filter(one => one.argv[1] === 'send').at(-1)
    expect(real?.argv).toEqual(dry?.argv.slice(0, -1))
    expect(await ui.find({ key: ROW })).toBeUndefined()
    await ui.unmount()
  })

  test("outside allow.toml: the owner's check and send carry --yes, the guard allows it, and the whole text shows, wrapped, before ⏎", async ($, on) => {
    const long = 'On it: the handler crashed on an empty callback payload, the fix is merged and deployed, so please press Settings once more and tell me what you see.'
    const { ui, seen } = await drafted($, on, { allowed: false, reason: 'target is not in the allowlist' }, ALL_DIALOGS, long)
    expect(await rowText(ui)).toContain('✓ the guard allows it')
    // Longer than the pane is wide: drawn whole and wrapped, not as a one-line field or a truncated line.
    expect(await ui.find({ type: 'Text', text: long })).toMatchObject({ props: { wrap: 'wrap' } })
    expect(await ui.find({ key: `${ROW}:text` })).toBeUndefined()
    await ui.press({ key: 'key:senddraft' })
    expect(seen.runs.filter(one => one.argv[1] === 'send').map(one => one.argv.slice(-2))).toEqual([
      ['--yes', '--dry-run'],
      ['--json', '--yes'],
    ])
    await ui.unmount()
  })

  // The sheet offers Draft reply in no bot chat, so this BotFather is a user-kind chat with its
  // username: the refusal by name, checked before tg runs, must hold however a draft came to be.
  test('BotFather: the check and ⏎ run nothing, whatever the guard would say', async ($, on) => {
    const dialogs = ALL_DIALOGS.map(one => (one.id === 1004 ? { ...one, username: 'BotFather', title: 'BotFather' } : one))
    const { ui, seen } = await drafted($, on, { allowed: true, reason: 'allowlisted' }, dialogs)
    expect(await rowText(ui)).toContain('BotFather is read-only')
    await ui.press({ key: ROW })
    expect(seen.runs.filter(one => one.argv[1] === 'send')).toEqual([])
    await ui.unmount()
  })

  test('readonly = true: the guard refuses even with --yes; ⏎ sends nothing', async ($, on) => {
    const { ui, seen } = await drafted($, on, { allowed: false, reason: 'readonly = true in config.toml: every write is refused' })
    expect(await rowText(ui)).toContain('✗ the guard refuses: readonly = true in config.toml: every write is refused')
    expect(await rowText(ui)).not.toContain('tg allow add')
    await ui.press({ key: ROW })
    expect(seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run'))).toEqual([])
    await ui.unmount()
  })

  test('e edits it in place: the field takes the text’s place, its ⏎ keeps the new text and the guard checks it again; d drops it', async ($, on) => {
    const { ui, seen } = await drafted($, on, { allowed: true, reason: 'allowlisted' })
    await ui.press({ key: 'key:edit' })
    expect((await ui.find({ key: `${ROW}:text` }))?.props.value).toBe('On it, fixing now.')
    await ui.input({ key: `${ROW}:text`, text: 'On it, fixing it now.' })
    expect(await ui.find({ key: `${ROW}:text` })).toBeUndefined()
    expect(seen.runs.filter(one => one.argv.includes('--dry-run')).map(one => one.stdin)).toEqual(['On it, fixing now.', 'On it, fixing it now.'])
    expect(await rowText(ui)).toContain('On it, fixing it now.')
    await ui.press({ key: 'key:dismiss' })
    expect(await ui.find({ key: ROW })).toBeUndefined()
    expect((await ui.find({ key: 'msg:92' }))?.props.autoFocus).toBe(true)
    expect(seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run'))).toEqual([])
    await ui.unmount()
  })

  test('with the pane hidden it is a band item (T5\'s N1): two rows, and ⏎ sends one that fits as the owner\'s own', async ($, on) => {
    const { ui, seen } = await drafted($, on, { allowed: true, reason: 'allowlisted' })
    await $.command.run({ ...WIDE, args: 'hide' })
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    expect((await band.find({ key: 'band:row1' }))?.text).toContain('✎ Contact A: "reply to #92" · from main')
    expect((await band.find({ key: 'band:row2' }))?.text).toBe('  → On it, fixing now.')
    expect((await band.find({ key: 'ap:draft:send' }))?.text).toBe('⏎ send')
    await band.press({ key: 'ap:draft:send' })
    expect(seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run')).map(one => one.argv)).toEqual([['tg', 'send', '1004', '-', '--reply-to', '92', '--plain', '--json', '--yes']])
    await band.unmount()
    await ui.unmount()
  })

  test('For you lists it beside autopilot\'s drafts: e edits it in its row, ⏎ sends one whose whole text the row shows', async ($, on) => {
    const { ui, seen } = await drafted($, on, { allowed: true, reason: 'allowlisted' })
    await ui.press({ key: 'key:back' })
    await ui.press({ key: 'key:foryou' })
    const row = (await ui.findAll({ type: 'Button' })).find(one => one.key?.startsWith('fy:') === true)
    expect(row?.text).toContain('draft reply')
    expect(row?.text).toContain('from main')
    await ui.press({ key: 'key:edit' })
    const field = (await ui.findAll({ type: 'Input' })).find(one => one.key?.endsWith(':edit') === true)
    expect(field?.props.value).toBe('On it, fixing now.')
    await ui.input({ key: field?.key ?? '', text: 'On it.' })
    await ui.press({ key: 'key:senddraft' })
    expect(seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run')).map(one => one.stdin)).toEqual(['On it.'])
    await ui.unmount()
  })

  /**
   * A first draft for Contact A, checked as it landed; a second Draft reply
   * packet (from `second`) that main is working on; the cursor back on the
   * first draft's row. `tgAsync` sees every run from the second packet on.
   */
  async function twoDrafts($: Engine, on: On, tgAsync: (ran: Ran) => Promise<ProcessRunResult>, second: number) {
    const clock = mock.clock(on, { now: NOW })
    let isArmed = false
    const seen = world(on, { tgAsync: async ran => (isArmed ? tgAsync(ran) : ran.argv[1] === 'send' && ran.argv.includes('--dry-run') ? json({ action: 'send', target: {}, steps: [], guard: { allowed: true, reason: 'confirmed with --yes' } }) : tgAsync(ran)) })
    const ui = await openChatAt($, clock, 1004, 92)
    await sendTo(ui, 'route:main', 'draft_reply')
    await $.turn.start({ text: '', turnId: 't-1' })
    await $.turn.complete({ answer: 'First draft.', durationMs: 1, isAborted: false, turnId: 't-1', reason: 'answer' })
    if (second !== 1004) await ui.press({ key: await chatKey(ui, second) })
    await sendTo(ui, 'route:main', 'draft_reply')
    await $.turn.start({ text: '', turnId: 't-2' })
    if (second !== 1004) await ui.press({ key: await chatKey(ui, 1004) })
    await ui.press({ key: 'key:down' })
    expect((await ui.find({ key: ROW }))?.props.autoFocus).toBe(true)
    isArmed = true
    return { ui, seen }
  }

  const finishSecond = ($: Engine) =>
    $.turn.complete({ answer: 'Second draft.', durationMs: 1, isAborted: false, turnId: 't-2', reason: 'answer' })

  test('a draft that lands while a check runs gets no plan of its own, and BotFather is never sent to', async ($, on) => {
    // As above: BotFather by username in a chat whose newest message is a person's.
    const dialogs = ALL_DIALOGS.map(one => (one.id === 1002 ? { ...one, kind: 'user' as const, username: 'BotFather', title: 'BotFather' } : one))
    let isFinished = false
    const { ui, seen } = await twoDrafts($, on, async ran => {
      if (ran.argv[1] === 'dialogs') return json(dialogs)
      if (ran.argv[1] !== 'send') return personTg(ran.argv)
      if (ran.argv.includes('--dry-run') && !isFinished) {
        isFinished = true
        await finishSecond($) // main answers the BotFather packet while the first draft's dry run is out
      }
      return ran.argv.includes('--dry-run') ? json({ action: 'send', target: {}, steps: [], guard: { allowed: true, reason: 'confirmed with --yes' } }) : json({ sent: [{ id: 677900 }] })
    }, 1002)
    // An edit of the first draft checks it again; the second packet's answer lands meanwhile.
    await ui.press({ key: 'key:edit' })
    await ui.input({ key: `${ROW}:text`, text: 'First draft, again.' })
    await ui.press({ key: await chatKey(ui, 1002) })
    expect(await rowText(ui)).toContain('✎ draft to @BotFather')
    expect(await rowText(ui)).toContain('BotFather is read-only')
    await ui.press({ key: ROW })
    expect(seen.runs.filter(one => one.argv[1] === 'send' && one.argv[2] === '@BotFather')).toEqual([])
    await ui.unmount()
  })

  test('a draft that lands while a send runs is not marked sent: it waits as a row', async ($, on) => {
    let isFinished = false
    const { ui, seen } = await twoDrafts($, on, async ran => {
      if (ran.argv[1] !== 'send') return personTg(ran.argv)
      if (ran.argv.includes('--dry-run')) return json({ action: 'send', target: {}, steps: [], guard: { allowed: true, reason: 'confirmed with --yes' } })
      if (!isFinished) {
        isFinished = true
        await finishSecond($) // main answers the second packet while the first draft is being sent
      }
      return json({ sent: [{ id: 677900 }] })
    }, 1004)
    await ui.press({ key: ROW })
    expect(seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run')).map(one => one.stdin)).toEqual(['First draft.'])
    expect(await rowText(ui)).toContain('Second draft.')
    expect(await rowText(ui)).toContain('✓ the guard allows it')
    await ui.unmount()
  })
})
