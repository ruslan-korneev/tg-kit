// A forum's topics in the pane (docs/design/dialogs-pane-ux.md §10.9, §8 T16):
// ⏎ on a forum's row opens Topics, a topic's thread or the merged stream,
// h comes back up; every write into a topic names it with --topic, a closed
// one takes none; an agent on a topic watches and answers that topic alone;
// the packet names the chat and the topic. tg is answered by process.run and
// process.spawn hooks beneath the plugin, so nothing real runs.
import type { ModelCompleteInput, ModelCompleteResult, On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import { STRAY_KEYS } from '../hooks/ui/keys'
import { DEFAULT_PALETTE, PALETTES, topicColor } from '../hooks/ui/palette'
import type { TgDialog, TgMessage, Topic } from '../types'
import { DIALOGS, FORUM, FORUM_MESSAGES, STARTED, TOPICS, cornerOf, findChat, folderRun, forumRead, legendOf, reachChat, titleOf, topicKey, type FolderSpec } from './fixtures'

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

const ROWS: TgDialog[] = [FORUM, ...DIALOGS]
const FOLDERS: FolderSpec[] = [{ id: 2, title: 'Work', kind: 'folder', chats: ROWS.map(one => one.id) }]

const run = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
const json = (value: unknown) => run(0, JSON.stringify(value))
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answer = (value: unknown): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })

type Child = { argv: readonly string[]; line: (value: unknown) => void; isKilled: boolean }
type Ran = { argv: readonly string[]; stdin?: string }

type World = {
  runs: Ran[]
  children: Child[]
  asked: ModelCompleteInput[]
  prompts: string[]
  store: Map<string, unknown>
  /** What `tg topics 1008` answers; a test changes it between passes. */
  topics: Topic[]
  /** The forum's messages `tg read` answers; a test appends to it. */
  messages: TgMessage[]
}

function world(on: On, options: { allow?: number[] } = {}): World {
  const seen: World = { runs: [], children: [], asked: [], prompts: [], store: new Map(Object.entries(STARTED)), topics: TOPICS, messages: [...FORUM_MESSAGES] }
  let nextSent = 900
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'session-a' }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const ran: Ran = { argv: e.argv, stdin: e.init?.stdin }
    seen.runs.push(ran)
    const [, cmd, peer] = e.argv
    if (e.argv[0] === 'git') return { value: run(128, '', 'fatal: not a git repository') }
    if (cmd === 'dialogs') return { value: json(ROWS) }
    if (cmd === 'folders') return { value: folderRun(e.argv, json(ROWS), FOLDERS) }
    if (cmd === 'topics') return { value: peer === String(FORUM.id) ? json(seen.topics) : run(2, '', 'error: not a forum') }
    if (cmd === 'read' && peer === String(FORUM.id)) {
      const at = e.argv.indexOf('--topic')
      return { value: json(at < 0 ? seen.messages : seen.messages.filter(one => one.topic_id === Number(e.argv[at + 1]))) }
    }
    if (cmd === 'read') return { value: json([]) }
    if (cmd === 'msg') return { value: json(seen.messages.filter(one => e.argv.slice(3).includes(String(one.id)))) }
    if (cmd === 'allow') return { value: json((options.allow ?? []).map(id => ({ id }))) }
    if (cmd === 'whoami') return { value: json({ username: null, name: 'Me' }) }
    if (cmd === 'send' && e.argv.includes('--dry-run')) return { value: json({ action: 'send', target: { id: Number(peer) }, steps: [], guard: { allowed: true, reason: 'allowlisted' } }) }
    if (cmd === 'send') {
      const at = e.argv.indexOf('--topic')
      const topic = at < 0 ? 1 : Number(e.argv[at + 1])
      const sent: TgMessage = { ...forumRead([])[0]!, id: nextSent++, date: '2026-10-10T12:05:00Z', out: true, text: ran.stdin ?? '', topic_id: topic, reply_to: topic === 1 ? null : topic }
      seen.messages.push(sent)
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
    return { value: answer({ action: 'reply', text: 'Looks good', confidence: 0.93, topics: [], reason: 'plain ack' }) }
  })
  on('prompt.submit', (_$, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  return seen
}

const tgCommand = { command: 'tg', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

async function openPane($: Engine, on: On, options: { allow?: number[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, options)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(tgCommand)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'tg', props: DOCK })
  return { clock, seen, ui }
}

type Ui = Awaited<ReturnType<typeof openPane>>['ui']

/** ⏎ on the forum's row: its Topics. */
async function openTopics(ui: Ui, clock: MockClock) {
  await ui.press({ key: await reachChat(ui, FORUM.id) })
  await clock.settle()
}

/** The cursor onto a row of Topics by j, then ⏎ on it. */
async function openTopic(ui: Ui, clock: MockClock, id: number | 'all') {
  for (let i = 0; i < 8 && (await ringed(ui)) !== (await topicKey(ui, id)); i++) await ui.press({ key: 'key:down' })
  await ui.press({ key: await topicKey(ui, id) })
  await clock.settle()
}

/** The Button the ring is on. */
async function ringed(ui: Ui): Promise<string | undefined> {
  return (await ui.findAll({ type: 'Button' })).find(one => one.props.autoFocus === true)?.key
}

/** Topics' rows as drawn, by topic id (`all` for `≡ all topics`), in order. */
async function topicIds(ui: Ui): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('topic:') === true ? [one.key.split(':')[3] ?? ''] : []))
}

const writes = (seen: World) => seen.runs.filter(one => one.argv[1] === 'send' && !one.argv.includes('--dry-run'))
const reads = (seen: World) => seen.runs.filter(one => one.argv[1] === 'read').map(one => one.argv.join(' '))

/** Every hotkey drawn, the catch-all's included. */
async function allHotkeys(ui: Ui): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).flatMap(button => (typeof button.props.hotkey === 'string' ? [button.props.hotkey] : []))
}

describe('Topics (§10.9)', () => {
  test("⏎ on a forum's row: Topics, ≡ all topics first, then tg's order, each ● in its colour; h back to Chats, whose row now sums the topics", async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    // Before `tg topics` ran this session, the forum's row shows the pass's own counts.
    expect((await findChat(ui, FORUM.id))?.text).toMatch(/⌗ Project team .* 2$/)
    await openTopics(ui, clock)
    expect(seen.runs.at(-1)?.argv).toEqual(['tg', 'topics', '1008', '--json'])
    // No thread is read: Topics are the forum's next level, not its messages.
    expect(reads(seen)).toEqual([])
    expect(await titleOf(ui, 'card:topics')).toBe('tg › Work › Project team')
    expect(await cornerOf(ui, 'card:topics')).toBe('5 topics')
    // CHATS stays above, three rows, the forum's row marked open.
    expect(await ui.find({ key: 'card:chats' })).toBeDefined()
    expect(await topicIds(ui)).toEqual(['all', '12', '20', '1', '30', '40'])
    expect(await ringed(ui)).toBe(await topicKey(ui, 'all'))
    expect((await ui.find({ key: await topicKey(ui, 'all') }))?.text).toMatch(/≡ all topics +Design review · can you … +@1$/)
    expect((await ui.find({ key: await topicKey(ui, 1) }))?.text).toMatch(/# General +morning +3$/)
    expect((await ui.find({ key: await topicKey(ui, 40) }))?.text).toMatch(/● Old roadmap +archived +⊘$/)
    // Each topic's ● in its icon_color; Infra's colour is none of Telegram's six, so dim.
    const dots = (await ui.findAll({ type: 'Text', text: '●' })).map(one => one.props.color)
    expect(dots).toEqual([topicColor(DEFAULT_PALETTE, 0x6fb9f0), topicColor(DEFAULT_PALETTE, 0xff93b2), PALETTES[DEFAULT_PALETTE].dim, topicColor(DEFAULT_PALETTE, 0xfb6f5f)])
    expect(new Set(dots).size).toBe(4)
    await ui.press({ key: 'key:back' })
    await clock.settle()
    expect(await ui.find({ key: 'card:topics' })).toBeUndefined()
    expect(await ringed(ui)).toBe(await reachChat(ui, FORUM.id))
    // Read this session: the row sums every topic, a mention first.
    expect((await findChat(ui, FORUM.id))?.text).toMatch(/⌗ Project team .* @1$/)
    await ui.unmount()
  })

  test('⏎ on a topic reads it with --topic; its title is the breadcrumb; h is Topics with the ring on it, h again Chats', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    await openTopics(ui, clock)
    await openTopic(ui, clock, 20)
    expect(reads(seen)).toEqual(['tg read 1008 --limit 30 --reverse --topic 20 --json'])
    expect(await ui.find({ key: 'msg:707' })).toBeDefined()
    expect(await ui.find({ key: 'msg:705' })).toBeUndefined()
    expect(await titleOf(ui, 'card:chat')).toBe('tg › Work › Project team › Design review')
    await ui.press({ key: 'key:back' })
    await clock.settle()
    expect(await titleOf(ui, 'card:topics')).toBe('tg › Work › Project team')
    expect(await ringed(ui)).toBe(await topicKey(ui, 20))
    await ui.press({ key: 'key:back' })
    await clock.settle()
    expect(await ui.find({ key: 'card:topics' })).toBeUndefined()
    expect(await ringed(ui)).toBe(await reachChat(ui, FORUM.id))
    await ui.unmount()
  })

  test('≡ all topics: every topic\'s messages, each labelled with its topic; n there names no topic, so it waits', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    await openTopics(ui, clock)
    await openTopic(ui, clock, 'all')
    expect(reads(seen)).toEqual(['tg read 1008 --limit 30 --reverse --json'])
    expect(await titleOf(ui, 'card:chat')).toBe('tg › Work › Project team › all topics')
    expect((await ui.find({ key: 'msg:705' }))?.text).toContain('Releases  ')
    expect((await ui.find({ key: 'msg:707' }))?.text).toContain('Design re… ')
    expect((await ui.find({ key: 'msg:703' }))?.text).toContain('General   ')
    expect(await ui.find({ key: 'key:write' })).toBeUndefined()
    await ui.press({ key: 'stray:n' })
    await clock.settle()
    expect(await legendOf(ui)).toContain('n: write · open a topic')
    expect(writes(seen)).toEqual([])
    await ui.unmount()
  })

  test('n in a topic sends into it, named with --topic', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    await openTopics(ui, clock)
    await openTopic(ui, clock, 20)
    const composing = ui.press({ key: 'key:write' })
    await clock.advance(50)
    await composing
    await ui.input({ key: 'bt:send', text: 'on it' })
    await clock.settle()
    expect(writes(seen)).toEqual([{ argv: ['tg', 'send', '1008', '-', '--plain', '--topic', '20', '--wait', '10s', '--json', '--yes'], stdin: 'on it' }])
    await ui.unmount()
  })

  test('a closed topic: no n, its key says why and runs nothing; the agent card offers reads only', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on, { allow: [FORUM.id] })
    await openTopics(ui, clock)
    await openTopic(ui, clock, 40)
    expect(reads(seen)).toEqual(['tg read 1008 --limit 30 --reverse --topic 40 --json'])
    expect(await ui.find({ key: 'key:write' })).toBeUndefined()
    await ui.press({ key: 'stray:n' })
    await clock.settle()
    expect(await legendOf(ui)).toContain('n: closed topic')
    expect(writes(seen)).toEqual([])
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    expect(await ui.find({ key: 'ap:level:auto' })).toBeUndefined()
    expect(await ui.find({ key: 'ap:level:draft' })).toBeUndefined()
    await ui.unmount()
  })

  test('a: agent on ≡ all topics waits for a topic', async ($, on) => {
    const { ui, clock } = await openPane($, on)
    await openTopics(ui, clock)
    // Not live there: the catch-all's a says why.
    expect(await ui.find({ key: 'key:agent' })).toBeUndefined()
    await ui.press({ key: 'stray:a' })
    await clock.settle()
    expect(await legendOf(ui)).toContain('a: agent · open a topic')
    expect(await ui.find({ key: 'ap:level:auto' })).toBeUndefined()
    await ui.unmount()
  })

  test('auto on a topic watches that topic alone and answers into it with --topic; the packet names the chat and the topic', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on, { allow: [FORUM.id] })
    await openTopics(ui, clock)
    for (let i = 0; i < 2; i++) await ui.press({ key: 'key:down' })
    expect(await ringed(ui)).toBe(await topicKey(ui, 20))
    await ui.press({ key: 'key:agent' })
    await clock.settle()
    await ui.press({ key: 'ap:level:auto' })
    await ui.press({ key: 'key:start' })
    await clock.settle()
    const child = seen.children.find(one => one.argv[1] === 'watch')
    expect(child?.argv).toEqual(['tg', 'watch', '1008', '--jsonl', '--topic', '20'])
    expect(seen.store.get('autopilot.dialogs')).toMatchObject({ '1008:20': { level: 'auto', peer: { id: 1008, topic: { id: 20, title: 'Design review', isClosed: false } } } })
    await ui.unmount()
    child?.line({ event: 'ready', date: '2026-10-10T12:00:00Z', peers: [] })
    const asked: TgMessage = { ...FORUM_MESSAGES.at(-1)!, id: 710, date: '2026-10-10T12:00:05Z', text: 'header ok now?' }
    seen.messages.push(asked)
    child?.line({ event: 'message', ...asked })
    await clock.advance(20_000)
    await clock.settle()
    expect(seen.asked).toHaveLength(1)
    expect(seen.asked[0]?.prompt).toMatch(/^<tg-packet v="1" intent="raw" source="dialogs-pane" redacted="false" topic="20" topic_title="Design review"/)
    expect(seen.asked[0]?.prompt).toContain('<message id="710"')
    expect(seen.asked[0]?.prompt).toMatch(/<message id="710"[^>]* topic="20"/)
    // Read again right before sending: that topic alone.
    expect(reads(seen).at(-1)).toBe('tg read 1008 --limit 10 --reverse --topic 20 --json')
    expect(writes(seen)).toEqual([{ argv: ['tg', 'send', '1008', '-', '--plain', '--topic', '20', '--json'], stdin: 'Looks good' }])
  })

  test('a topic that moves while the cursor stays waits (↑N in the corner); its counts change in place; g applies it, the ring on its topic', async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    await openTopics(ui, clock)
    for (let i = 0; i < 2; i++) await ui.press({ key: 'key:down' })
    expect(await ringed(ui)).toBe(await topicKey(ui, 20))
    // Infra gets a new message: tg now lists it second.
    const [releases, design, general, infra, roadmap] = TOPICS
    seen.topics = [releases!, { ...infra!, unread: 2, last_date: '2026-10-10T12:00:30Z', last_text: 'disk at 95%' }, design!, general!, roadmap!]
    await clock.advance(60_000)
    await clock.settle()
    expect(seen.runs.filter(one => one.argv[1] === 'topics')).toHaveLength(2)
    expect(await topicIds(ui)).toEqual(['all', '12', '20', '1', '30', '40'])
    expect((await ui.find({ key: await topicKey(ui, 30) }))?.text).toMatch(/● Infra +disk at 95% +2$/)
    expect(await cornerOf(ui, 'card:topics')).toMatch(/^↑\d · 5 topics$/)
    expect(await ringed(ui)).toBe(await topicKey(ui, 20))
    await ui.press({ key: 'key:reload' })
    await clock.settle()
    expect(await topicIds(ui)).toEqual(['all', '12', '30', '20', '1', '40'])
    expect(await cornerOf(ui, 'card:topics')).toBe('5 topics')
    expect(await ringed(ui)).toBe(await topicKey(ui, 20))
    await ui.unmount()
  })

  test("the merged stream's packet: one topic's messages name it; a mixed set keeps each message's own", async ($, on) => {
    const { ui, clock, seen } = await openPane($, on)
    await openTopics(ui, clock)
    await openTopic(ui, clock, 'all')
    // The cursor on the newest message (Design review's): sent alone, the packet is that topic's.
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'sheet:intent:explain' })
    await clock.settle()
    expect(seen.prompts.at(-1)).toMatch(/^<tg-packet [^>]*topic="20" topic_title="Design review"/)
    // Two topics marked: no topic on the packet, each message keeps its own.
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:up' })
    await ui.press({ key: 'key:mark' })
    await ui.press({ key: 'key:send' })
    await ui.press({ key: 'sheet:intent:explain' })
    await clock.settle()
    const mixed = seen.prompts.at(-1) ?? ''
    expect(mixed).toMatch(/^<tg-packet v="1" intent="explain" source="dialogs-pane" redacted="(true|false)">/)
    expect(mixed).toMatch(/<message id="707"[^>]* topic="20"/)
    expect(mixed).toMatch(/<message id="705"[^>]* topic="12"/)
    await ui.unmount()
  })

  const SWEEPS: { name: string; steps: (number | 'all')[] }[] = [
    { name: 'Topics', steps: [] },
    { name: 'a topic', steps: [20] },
    { name: 'a closed topic', steps: [40] },
    { name: 'the merged stream', steps: ['all'] },
  ]
  for (const sweep of SWEEPS) {
    test(`${sweep.name}: each of a–z and 0–9 has exactly one Button`, async ($, on) => {
      const { ui, clock } = await openPane($, on)
      await openTopics(ui, clock)
      for (const id of sweep.steps) await openTopic(ui, clock, id)
      const every = await allHotkeys(ui)
      expect(every.filter((key, index) => every.indexOf(key) !== index)).toEqual([])
      expect([...every].sort()).toEqual([...STRAY_KEYS].sort())
      await ui.unmount()
    })
  }

  test('a digit in Topics says where folders are', async ($, on) => {
    const { ui, clock } = await openPane($, on)
    await openTopics(ui, clock)
    await ui.press({ key: 'stray:1' })
    expect(await legendOf(ui)).toContain('1-9: folders, from Chats')
    expect(await ui.find({ key: 'card:topics' })).toBeDefined()
    await ui.unmount()
  })
})
