// The autopilot's per-dialog settings (docs/design/dialogs-pane.md §6 "Levels"
// and "Limits"): defaults, quiet hours, and the narrowing of what $.store hands
// back. Pure. The card's Selects offer their values (./components).
import type { ApBrief, ApDialog, ApLevel, ApTopic, PeerRef } from '../../types'
import { peerKey, readPeerRef } from '../ui/model'

export const AP_LEVELS = ['listen', 'draft', 'auto', 'delegate'] as const satisfies readonly ApLevel[]
export const AP_TOPICS = ['money', 'dates', 'promises', 'opinions', 'personal'] as const satisfies readonly ApTopic[]

export const LEVEL_GLYPH = { listen: '◉', draft: '✎', auto: '⟳', delegate: '↯' } as const satisfies Record<ApLevel, string>

export const TOPIC_LABEL = {
  money: 'money',
  dates: 'dates',
  promises: 'promises',
  opinions: 'new opinions',
  personal: 'personal data',
} as const satisfies Record<ApTopic, string>

export const DEFAULT_PER_HOUR = 50
export const DEFAULT_GAP_S = 20
export const DEFAULT_THRESHOLD = 0.8

const EMPTY_BRIEF: ApBrief = { tone: '', promises: '', facts: '' }

export function defaultDialog(peer: PeerRef): ApDialog {
  return {
    peer,
    level: 'draft',
    brief: EMPTY_BRIEF,
    perHour: DEFAULT_PER_HOUR,
    gapS: DEFAULT_GAP_S,
    topics: [...AP_TOPICS],
    threshold: DEFAULT_THRESHOLD,
    quiet: null,
  }
}

/** `50/h`, `∞/h`. */
export function rateText(perHour: number | null): string {
  return `${perHour === null ? '∞' : perHour}/h`
}

export function toggleTopic(topics: readonly ApTopic[], topic: ApTopic): ApTopic[] {
  return topics.includes(topic) ? topics.filter(one => one !== topic) : AP_TOPICS.filter(one => one === topic || topics.includes(one))
}

// --- quiet hours ---

const pad = (n: number) => String(n).padStart(2, '0')

export function clockText(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

export function quietText(quiet: ApDialog['quiet']): string {
  return quiet === null ? 'off' : `${clockText(quiet.from)}–${clockText(quiet.to)}`
}

/** `22:00-08:00` (or with `–`); `off` or nothing turns quiet hours off. */
export function parseQuiet(text: string): { ok: true; value: ApDialog['quiet'] } | { ok: false } {
  const typed = text.trim().toLowerCase()
  if (typed === '' || typed === 'off') return { ok: true, value: null }
  const match = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(typed)
  if (match === null) return { ok: false }
  const [hFrom, mFrom, hTo, mTo] = match.slice(1).map(Number)
  if (hFrom === undefined || mFrom === undefined || hTo === undefined || mTo === undefined) return { ok: false }
  if (hFrom > 23 || hTo > 23 || mFrom > 59 || mTo > 59) return { ok: false }
  const from = hFrom * 60 + mFrom
  const to = hTo * 60 + mTo
  return from === to ? { ok: false } : { ok: true, value: { from, to } }
}

/** Whether `minutes` (local, of the day) falls in the range; a range may cross midnight. */
export function isQuiet(quiet: ApDialog['quiet'], minutes: number): boolean {
  if (quiet === null) return false
  return quiet.from < quiet.to ? minutes >= quiet.from && minutes < quiet.to : minutes >= quiet.from || minutes < quiet.to
}

// --- $.store ---

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
function minutesOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24 * 60 ? v : null
}

/** One stored dialog; a field that does not read keeps its default, a peer that does not drops it. */
function dialogOfStored(v: unknown): ApDialog | null {
  if (!isObj(v)) return null
  const peer = readPeerRef(v.peer)
  if (peer === null) return null
  const base = defaultDialog(peer)
  const brief = isObj(v.brief) ? { tone: str(v.brief.tone), promises: str(v.brief.promises), facts: str(v.brief.facts) } : base.brief
  const perHour = v.perHour === null ? null : typeof v.perHour === 'number' && Number.isInteger(v.perHour) && v.perHour >= 1 ? v.perHour : base.perHour
  const gapS = typeof v.gapS === 'number' && v.gapS >= 1 && v.gapS <= 600 ? v.gapS : base.gapS
  const threshold = typeof v.threshold === 'number' && v.threshold >= 0 && v.threshold <= 1 ? v.threshold : base.threshold
  const stored: unknown = v.topics
  const topics = Array.isArray(stored) ? AP_TOPICS.filter(topic => stored.includes(topic)) : base.topics
  const from = isObj(v.quiet) ? minutesOf(v.quiet.from) : null
  const to = isObj(v.quiet) ? minutesOf(v.quiet.to) : null
  return {
    peer,
    level: AP_LEVELS.find(one => one === v.level) ?? base.level,
    brief,
    perHour,
    gapS,
    topics,
    threshold,
    quiet: from === null || to === null || from === to ? null : { from, to },
  }
}

/** `autopilot.dialogs` as stored: peer key (a chat's id, or `chatId:topicId`) → settings. */
export function parseDialogs(v: unknown): Record<string, ApDialog> {
  if (!isObj(v)) return {}
  const out: Record<string, ApDialog> = {}
  for (const value of Object.values(v)) {
    const dialog = dialogOfStored(value)
    if (dialog !== null) out[peerKey(dialog.peer)] = dialog
  }
  return out
}
