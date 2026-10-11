// The agent card's ladder (docs/design/dialogs-pane-ux.md §4.6, §5.4, §5.5,
// decisions 2, 8 and 9): one card per chat answers "what may an agent do
// here?" with the rungs that fit the chat's kind, each on its own digit, and
// what ⏎ does with the one picked. Pure: register.tsx reads the state and makes
// every `$` call.
import type { ApRung, CardStep } from '../../types'
import type { ChatKind } from '../ui/keys'
import { GLYPH } from '../ui/model'
import { LEVEL_GLYPH } from './config'

/** follow → summarize → draft → auto → delegate; the digits keep their rungs, so 2 is summarize everywhere. */
export const RUNGS = ['follow', 'listen', 'draft', 'auto', 'delegate'] as const satisfies readonly ApRung[]

/** `follow` is today's pin (⌁), `summarize` today's `listen` (stored values unchanged). */
export const RUNG_GLYPH: Record<ApRung, string> = { follow: GLYPH.pinned, ...LEVEL_GLYPH }
export const RUNG_NAME: Record<ApRung, string> = { follow: 'follow', listen: 'summarize', draft: 'draft', auto: 'auto', delegate: 'delegate' }

export function rungDigit(rung: ApRung): string {
  return String(RUNGS.indexOf(rung) + 1)
}

const READS: readonly ApRung[] = ['follow', 'listen']

/**
 * §4.6 "a: agent levels": a channel or a bot never answers an agent, so only
 * the rungs that read; a group all but delegate, which is steered by whoever
 * writes, so it needs one person the owner trusts (decision 8); Saved
 * Messages and BotFather get no card.
 */
const LADDER: Record<ChatKind, readonly ApRung[]> = {
  person: RUNGS,
  group: ['follow', 'listen', 'draft', 'auto'],
  bot: READS,
  channel: READS,
  saved: [],
  botfather: [],
}

export function ladderFor(kind: ChatKind): readonly ApRung[] {
  return LADDER[kind]
}

/** auto and delegate send on their own, so allow.toml gates them; a draft is sent by the owner's own key (decision 9). */
export function sendsAlone(rung: ApRung): boolean {
  return rung === 'auto' || rung === 'delegate'
}

/** The rung's one line of what happens. */
export function rungWhat(rung: ApRung, kind: ChatKind): string {
  switch (rung) {
    case 'follow':
      return kind === 'channel' ? "new posts go to main's context" : "new messages go to main's context"
    case 'listen':
      return 'a summary above your prompt; never writes'
    case 'draft':
      return 'drafts each reply; you send it'
    case 'auto':
      return 'replies alone within limits; unsure → draft'
    case 'delegate':
      return 'replies and does the work, with tools you grant'
  }
}

/** Why nothing writes in this kind of chat, for the card's last row; null where something may. */
export function readOnlyKindText(kind: ChatKind): string | null {
  if (kind === 'channel') return 'a channel: nobody answers in it, so nothing writes here'
  if (kind === 'bot') return 'a bot: it answers your own keys, so an agent here only reads'
  return null
}

/** What the card knows of allow.toml for the chat: on its way, read, or a read that failed (§7.4). */
export type AllowView = { kind: 'loading' } | { kind: 'ok'; isAllowed: boolean } | { kind: 'error'; text: string }

/** Why a rung that fits the chat cannot start now (drawn dim beside it), or null. */
export function rungBlock(rung: ApRung, allow: AllowView, isGuardUp: boolean): string | null {
  if (!sendsAlone(rung)) return null
  if (allow.kind === 'error') return 'could not read allow.toml'
  if (allow.kind === 'ok' && !allow.isAllowed) return 'needs allow.toml'
  if (rung === 'delegate' && !isGuardUp) return 'needs the guard'
  return null
}

/** What ⏎ does on the card now. */
export type CardAction =
  | { kind: 'start' }
  | { kind: 'stop' }
  /** Another rung runs here: ⏎ stops it and starts the picked one (one rung per chat, decision 2). */
  | { kind: 'switch'; from: ApRung }
  /** auto or delegate on a chat outside allow.toml: ⏎ fills `! tg allow add PEER --yes` in the prompt (decision 1). */
  | { kind: 'allow' }
  /** The allowlist could not be read: ⏎, as `g`, reads it again. */
  | { kind: 'retry' }
  | { kind: 'reading' }
  /** delegate, first time for this chat: the warning step. */
  | { kind: 'warn' }
  /** delegate: the grant step. */
  | { kind: 'grant' }
  /** delegate while dialogs-pane-guard does not answer: ⏎ says so, nothing starts. */
  | { kind: 'guard' }
  /** The options step: ⏎ belongs to its fields. */
  | { kind: 'none' }

export type CardInput = {
  step: CardStep
  pick: ApRung
  /** The rung running in this chat, if one does. */
  running: ApRung | null
  allow: AllowView
  isGuardUp: boolean
  isWarned: boolean
}

/**
 * ⏎ on the card (§5.4, §5.5): stop the rung that runs when it is the one
 * picked; delegate goes through its warning (once per chat) and its grant;
 * a rung that sends alone needs allow.toml, which ⏎ puts in the prompt for
 * the owner to run; otherwise start, or switch from the rung that runs.
 */
export function cardAction(input: CardInput): CardAction {
  const { step, pick, running, allow } = input
  if (step === 'options') return { kind: 'none' }
  if (step !== 'warning' && running === pick) return { kind: 'stop' }
  if (step === 'warning') return { kind: 'grant' }
  if (step === 'ladder' && pick === 'delegate') return input.isWarned ? { kind: 'grant' } : { kind: 'warn' }
  if (sendsAlone(pick)) {
    if (allow.kind === 'loading') return { kind: 'reading' }
    if (allow.kind === 'error') return { kind: 'retry' }
    if (!allow.isAllowed) return { kind: 'allow' }
  }
  if (pick === 'delegate' && !input.isGuardUp) return { kind: 'guard' }
  return running === null ? { kind: 'start' } : { kind: 'switch', from: running }
}

/** The bar's `⏎ …` for the action: `⏎ start draft`, `⏎ stop auto`, `⏎ allow in the prompt…`. */
export function actionLabel(action: CardAction, pick: ApRung, step: CardStep): string {
  const name = RUNG_NAME[pick]
  switch (action.kind) {
    case 'start':
    case 'guard':
      return `start ${name}`
    case 'stop':
      return `stop ${name}`
    case 'switch':
      return `switch to ${name}`
    case 'allow':
      return 'allow in the prompt…'
    case 'retry':
      return 'read allow.toml again'
    case 'reading':
      return 'reading allow.toml…'
    case 'warn':
      return 'set up delegate…'
    case 'grant':
      return step === 'warning' ? 'I understand, set it up' : 'set up delegate…'
    case 'none':
      return ''
  }
}

/** What ⏎ puts in the prompt: the human runs it, and allow.toml stays theirs (decision 1). */
export function allowCommand(arg: string): string {
  return `! tg allow add ${arg} --yes`
}

/** The rung a chat runs: a follow (pin) or the autopilot's level; one at most (decision 2). */
export function runningRung(isFollowed: boolean, level: ApRung | null): ApRung | null {
  return level ?? (isFollowed ? 'follow' : null)
}

/** The rung the card rings when it opens: the one that runs, else the stored level when it fits, else summarize. */
export function firstPick(ladder: readonly ApRung[], running: ApRung | null, stored: ApRung): ApRung {
  if (running !== null && ladder.includes(running)) return running
  if (ladder.includes(stored)) return stored
  return 'listen'
}
