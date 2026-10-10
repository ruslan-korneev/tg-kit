// The autopilot's per-dialog settings (docs/design/dialogs-pane.md §6 "Levels"
// and "Limits"): defaults, the +/- ladders of the card, quiet hours, and the
// narrowing of what $.store hands back. Pure.
import type { ApBrief, ApDialog, ApLevel, ApTopic, PeerRef, TgPeerKind } from '../../types'

export const AP_LEVELS = ['listen', 'draft', 'auto', 'delegate'] as const satisfies readonly ApLevel[]
export const AP_TOPICS = ['money', 'dates', 'promises', 'opinions', 'personal'] as const satisfies readonly ApTopic[]

export const LEVEL_GLYPH = { listen: '◉', draft: '✎', auto: '⟳', delegate: '⚡' } as const satisfies Record<ApLevel, string>

export const TOPIC_LABEL = {
  money: 'money',
  dates: 'dates',
  promises: 'promises',
  opinions: 'new opinions',
  personal: 'personal data',
} as const satisfies Record<ApTopic, string>

/** The card's toggle key per topic: inside the card every letter is free. */
export const TOPIC_KEY = { money: 'm', dates: 'd', promises: 'p', opinions: 'n', personal: 'i' } as const satisfies Record<ApTopic, string>

/** Replies per hour, `-`/`+` in the card; Infinity stands for ∞ (stored as null). */
const RATE_STEPS: readonly number[] = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, Infinity]
/** The burst gap, in seconds. */
const GAP_STEPS: readonly number[] = [5, 10, 15, 20, 30, 45, 60, 120]
const CONF_STEP = 0.05

export const DEFAULT_PER_HOUR = 50
export const DEFAULT_GAP_S = 20
export const DEFAULT_THRESHOLD = 0.8
/** `t` in the card turns quiet hours on with this range; the field changes it. */
export const DEFAULT_QUIET = { from: 22 * 60, to: 8 * 60 } as const

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

/** The next rung up or down; a value off the ladder (typed in the card) moves to the nearest rung that way. */
function step(steps: readonly number[], current: number, by: 1 | -1): number {
  const next = by === 1 ? steps.find(one => one > current) : steps.findLast(one => one < current)
  return next ?? current
}

export function stepRate(perHour: number | null, by: 1 | -1): number | null {
  const next = step(RATE_STEPS, perHour ?? Infinity, by)
  return next === Infinity ? null : next
}

export function stepGap(gapS: number, by: 1 | -1): number {
  return step(GAP_STEPS, gapS, by)
}

export function stepThreshold(threshold: number, by: 1 | -1): number {
  return Math.round(Math.min(1, Math.max(0, threshold + by * CONF_STEP)) * 100) / 100
}

/** `50/h`, `∞/h`. */
export function rateText(perHour: number | null): string {
  return `${perHour === null ? '∞' : perHour}/h`
}

/** What the card's field takes: a whole number ≥ 1, or `∞` / `off` / `0` for no limit. */
export function parseRate(text: string): { ok: true; value: number | null } | { ok: false } {
  const typed = text.trim().toLowerCase()
  if (typed === '∞' || typed === 'off' || typed === 'inf' || typed === '0') return { ok: true, value: null }
  if (!/^\d+$/.test(typed)) return { ok: false }
  return { ok: true, value: Number(typed) }
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
const PEER_KINDS: readonly TgPeerKind[] = ['self', 'user', 'bot', 'group', 'channel', 'supergroup', 'unknown']

function peerOfStored(v: unknown): PeerRef | null {
  if (!isObj(v) || typeof v.id !== 'number' || typeof v.arg !== 'string' || typeof v.label !== 'string') return null
  const kind = PEER_KINDS.find(one => one === v.kind)
  return kind === undefined ? null : { id: v.id, arg: v.arg, label: v.label, kind }
}

function minutesOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24 * 60 ? v : null
}

/** One stored dialog; a field that does not read keeps its default, a peer that does not drops it. */
function dialogOfStored(v: unknown): ApDialog | null {
  if (!isObj(v)) return null
  const peer = peerOfStored(v.peer)
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

/** `autopilot.dialogs` as stored: dialog id → settings. */
export function parseDialogs(v: unknown): Record<string, ApDialog> {
  if (!isObj(v)) return {}
  const out: Record<string, ApDialog> = {}
  for (const value of Object.values(v)) {
    const dialog = dialogOfStored(value)
    if (dialog !== null) out[String(dialog.peer.id)] = dialog
  }
  return out
}
