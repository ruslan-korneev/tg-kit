// The send sheet's rules (docs/design/dialogs-pane-ux.md §4.6, §5.1, §8 T2):
// whose message it is decides its intents, digits pick them in this order,
// ⏎ repeats the last one used for that kind of sender, and inspect says what
// the agent will read. Pure: register.tsx runs every `$` call.
import type { AgentState, Recipient, RouteIntent, SenderClass, TgMessage, TgPeerKind } from '../../types'
import type { Audience, Intent } from '../packet/intents'
import type { Redaction } from '../packet/redact'
import { CHAT_KIND_WRITE, type ChatKind } from '../ui/keys'
import { GLYPH, oneLine, senderLabel } from '../ui/model'
import { intentLabel } from './route'

export const SENDER_CLASSES = ['bot', 'person', 'other'] as const satisfies readonly SenderClass[]

/** §4.6 "the send sheet, by sender": the intents in digit order; Ask is always the last digit. */
export const SHEET_INTENTS: Record<SenderClass, readonly RouteIntent[]> = {
  bot: ['fix', 'reproduce', 'explain', 'test', 'raw'],
  person: ['do_it', 'explain', 'draft_reply', 'raw'],
  other: ['do_it', 'explain', 'raw'],
}

/** Where ⏎ starts before anything was sent (§5.1: bots start on Fix, people on Ask). */
export const FIRST_INTENT: Record<SenderClass, RouteIntent> = { bot: 'fix', person: 'raw', other: 'raw' }

/** How the sheet names who it remembers the last intent for. */
export const CLASS_LABEL: Record<SenderClass, string> = { bot: 'bots', person: 'people', other: 'this sender' }

/**
 * §4.6: the sender, not the chat, picks the intents, so in a group a bot's
 * message gets bot intents and a member's gets people intents. Draft reply
 * needs a person who reads it in a chat the owner can write to; the owner's
 * own messages, a channel's posts and a group posting as itself get the rest.
 */
export function senderClass(message: Pick<TgMessage, 'out' | 'sender'>, chat: ChatKind): SenderClass {
  if (message.out || message.sender.kind === 'self') return 'other'
  if (message.sender.kind === 'bot') return 'bot'
  if (message.sender.kind === 'user') return CHAT_KIND_WRITE.includes(chat) ? 'person' : 'other'
  return 'other'
}

/** A marked set takes the intents of its newest message's sender (§4.6). */
export function setClass(messages: readonly Pick<TgMessage, 'id' | 'out' | 'sender'>[], chat: ChatKind): SenderClass {
  const newest = messages.reduce<Pick<TgMessage, 'id' | 'out' | 'sender'> | undefined>((top, one) => (top === undefined || one.id > top.id ? one : top), undefined)
  return newest === undefined ? 'other' : senderClass(newest, chat)
}

export const audienceOf = (sender: SenderClass): Audience => (sender === 'bot' ? 'bot' : 'people')

/** The packet's intent for a sheet's choice: Ask carries the owner's words, Explain its sender's template. */
export function sheetIntent(intent: RouteIntent, sender: SenderClass, words = ''): Intent {
  return intent === 'raw' ? { id: 'raw', text: words } : { id: intent, audience: audienceOf(sender) }
}

export type LastIntents = Record<SenderClass, RouteIntent>

/** What `$.store` keeps (`send.intents`): the last intent per kind of sender, each one of its own. */
export function parseLastIntents(stored: unknown): LastIntents {
  const last: LastIntents = { ...FIRST_INTENT }
  if (typeof stored !== 'object' || stored === null) return last
  for (const sender of SENDER_CLASSES) {
    // A non-null object from the store: reading a key as unknown claims nothing; the find below checks it.
    const value: unknown = (stored as Record<string, unknown>)[sender]
    const known = SHEET_INTENTS[sender].find(one => one === value)
    if (known !== undefined) last[sender] = known
  }
  return last
}

/** Whether the store holds a last intent of this sender's own, so the sheet can say "last used". */
export function isRemembered(stored: unknown, sender: SenderClass): boolean {
  if (typeof stored !== 'object' || stored === null || !(sender in stored)) return false
  // As in parseLastIntents: the key exists, its value is checked here.
  const value: unknown = (stored as Record<string, unknown>)[sender]
  return SHEET_INTENTS[sender].some(one => one === value)
}

/** What the store keeps after `intent` was used for `sender`: only intents actually used, so "last used" never names a default. */
export function rememberedWith(stored: unknown, sender: SenderClass, intent: RouteIntent): Partial<LastIntents> {
  const last = parseLastIntents(stored)
  const kept: Partial<LastIntents> = {}
  for (const one of SENDER_CLASSES) if (isRemembered(stored, one)) kept[one] = last[one]
  return { ...kept, [sender]: intent }
}

/** The intent ⏎ sends: the last one used for this kind of sender. */
export function ringedIntent(last: LastIntents, sender: SenderClass): RouteIntent {
  return SHEET_INTENTS[sender].includes(last[sender]) ? last[sender] : FIRST_INTENT[sender]
}

/** The intents a broadcast leg cycles through: the sender's, without Ask (a leg has no words). */
export function legIntents(sender: SenderClass): readonly RouteIntent[] {
  return SHEET_INTENTS[sender].filter(one => one !== 'raw')
}

export function nextLegIntent(sender: SenderClass, intent: RouteIntent): RouteIntent {
  const list = legIntents(sender)
  return list[(list.indexOf(intent) + 1) % list.length] ?? list[0] ?? 'explain'
}

/** Idea 18's split, per sender: the other legs get the intents main does not. */
export function legSplit(sender: SenderClass): readonly RouteIntent[] {
  switch (sender) {
    case 'bot':
      return ['reproduce', 'test', 'explain']
    case 'person':
      return ['explain', 'draft_reply', 'do_it']
    case 'other':
      return ['explain', 'do_it']
  }
}

/** Main's leg in a broadcast: the ringed intent, or the sender's first when that is Ask. */
export function mainLegIntent(last: LastIntents, sender: SenderClass): RouteIntent {
  const ringed = ringedIntent(last, sender)
  return ringed === 'raw' ? (legIntents(sender)[0] ?? 'explain') : ringed
}

/**
 * The Hidden band's ⏎ (§8 T2: the band names its intent). It sees a chat, not a
 * sender: a bot chat's newest message is the bot's, a person's chat a person's,
 * anything else the rest. Ask needs words the band has no field for, so then
 * it sends Fix to a bot and Explain otherwise: Explain changes nothing.
 */
export function bandIntent(kind: TgPeerKind, last: LastIntents): { sender: SenderClass; intent: RouteIntent } {
  const sender: SenderClass = kind === 'bot' ? 'bot' : kind === 'user' ? 'person' : 'other'
  const ringed = ringedIntent(last, sender)
  return { sender, intent: ringed !== 'raw' ? ringed : sender === 'bot' ? 'fix' : 'explain' }
}

/** `send #677791 + 1 parent`, `send 3 messages`, `send #92 from Contact A`. */
export function sheetTitle(selected: readonly Pick<TgMessage, 'id' | 'out' | 'sender'>[], parents: number): string {
  const first = selected[0]
  const what = selected.length === 1 && first !== undefined ? `#${first.id}` : `${selected.length} messages`
  const plus = parents === 0 ? '' : ` + ${parents} parent${parents === 1 ? '' : 's'}`
  const from = selected.length === 1 && first !== undefined && first.sender.kind !== 'bot' && !first.out ? ` from ${senderLabel(first)}` : ''
  return `send ${what}${plus}${from}`
}

/** `→ main · idle`, `→ tester · …running`, `→ + new agent`. */
export function targetText(to: Recipient, state: AgentState): string {
  if (to.kind === 'new') return '→ + new agent'
  const label = to.kind === 'main' ? 'main' : to.label
  const word = state === 'running' ? `${GLYPH.working}running` : state === 'done' ? `${GLYPH.done} done` : 'idle'
  return `→ ${label} · ${word}`
}

/** One intent of the sheet: its digit and its label; Ask is the field's way in. */
export function intentText(intent: RouteIntent, isShort: boolean): string {
  if (intent === 'raw') return isShort ? 'Ask in words…' : 'Ask in my words…'
  return intentLabel(intent)
}

export type InspectView = {
  head: string
  messages: string[]
  parents: string[]
  replay: string | null
  masked: string
}

/** One line per message the agent reads: `#677791 bot  "⚠ Something went wrong" · buttons Retry, Back`. */
function messageLine(message: TgMessage, width: number): string {
  const buttons = message.buttons.flat().map(button => button.text)
  const tail = buttons.length === 0 ? '' : ` · buttons ${buttons.join(', ')}`
  const head = `#${message.id} ${senderLabel(message)}  `
  return `${head}"${oneLine(message.text, Math.max(8, width - head.length - tail.length - 2))}"${tail}`
}

/**
 * i: what the agent will read (§5.1 "inspect"). `shown` and `parents` are the
 * messages as the packet carries them (masked when redaction is on); `toFetch`
 * the parents a send asks tg for first.
 */
export function inspectView(input: {
  peer: string
  kind: string
  intent: RouteIntent
  isRedacted: boolean
  shown: readonly TgMessage[]
  parents: readonly TgMessage[]
  toFetch: number
  replay: string | null
  redactions: readonly Redaction[]
  width: number
}): InspectView {
  const masked = input.isRedacted
    ? input.redactions.length === 0
      ? 'nothing to mask'
      : input.redactions.map(one => `${one.original} → ${one.placeholder}`).join(' · ')
    : 'nothing: redaction is off for this packet'
  return {
    head: `${input.peer} (${input.kind}) · ${intentLabel(input.intent)} · ${input.isRedacted ? 'redacted' : 'not redacted'}`,
    messages: input.shown.map(message => messageLine(message, input.width)),
    parents: [
      ...input.parents.map(message => `+ parent ${messageLine(message, input.width - 9)}`),
      ...(input.toFetch === 0 ? [] : [`+ ${input.toFetch} parent${input.toFetch === 1 ? '' : 's'} tg fetches on send`]),
    ],
    replay: input.replay,
    masked,
  }
}
