// dangerouslySkipHardStops (docs/design/dialogs-pane.md §6): three scopes, one
// dialog (the card, confirmed by typing the dialog's name, 24 h by default),
// the session (`/tg autopilot --dangerously-skip-hard-stops[=…]`) and always
// (the mod option). What is skipped is the union of the three, and it shows
// in red wherever the dialog does. Pure.
import type { DgSkip, DgStop } from './contract'
import { DG_STOPS } from './stops'

export const SKIP_FLAG = '--dangerously-skip-hard-stops'
export const DEFAULT_SKIP_HOURS = 24
const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, d: 86_400_000 }

/**
 * A list of stop names, `all`, or `none` / `on` (nothing skipped); the
 * option's value arrives as one string or a list of them. Unknown names fail.
 */
export function parseStops(value: string | readonly string[]): { ok: true; stops: DgStop[] } | { ok: false; unknown: string[] } {
  const words = (typeof value === 'string' ? [value] : value).flatMap(one => one.split(/[,\s]+/)).map(one => one.trim().toLowerCase()).filter(one => one !== '')
  if (words.includes('all') || words.includes('true')) return { ok: true, stops: [...DG_STOPS] }
  const known = words.filter(word => word !== 'none' && word !== 'on' && word !== 'false')
  const unknown = known.filter(word => !DG_STOPS.some(stop => stop === word))
  if (unknown.length > 0) return { ok: false, unknown }
  return { ok: true, stops: DG_STOPS.filter(stop => known.includes(stop)) }
}

/** `/tg autopilot --dangerously-skip-hard-stops[=publish,delete]`: the stops, or null when the flag is not there. */
export function parseSkipFlag(args: string): { ok: true; stops: DgStop[] } | { ok: false; unknown: string[] } | null {
  const word = args.split(/\s+/).find(one => one === SKIP_FLAG || one.startsWith(`${SKIP_FLAG}=`))
  if (word === undefined) return null
  return word === SKIP_FLAG ? { ok: true, stops: [...DG_STOPS] } : parseStops(word.slice(SKIP_FLAG.length + 1))
}

/**
 * The card's field: `all` or names, then optionally how long: `24h` (the
 * default), `8h`, `30m`, or `never` (no expiry). `on` turns stops back on.
 */
export function parseDialogSkip(text: string, now: number): { ok: true; skip: DgSkip | null } | { ok: false; why: string } {
  const words = text.trim().toLowerCase().split(/\s+/).filter(one => one !== '')
  if (words.length === 0 || words[0] === 'on') return { ok: true, skip: null }
  const last = words.at(-1) ?? ''
  const span = /^(\d+)(h|m|d)$/.exec(last)
  const isNever = last === 'never'
  const names = span !== null || isNever ? words.slice(0, -1) : words
  const parsed = parseStops(names.length === 0 ? ['all'] : names)
  if (!parsed.ok) return { ok: false, why: `unknown stop ${parsed.unknown.join(', ')}: use ${DG_STOPS.join(', ')} or all` }
  if (parsed.stops.length === 0) return { ok: true, skip: null }
  const ms = span === null ? DEFAULT_SKIP_HOURS * 3_600_000 : Number(span[1]) * (UNIT_MS[span[2] ?? 'h'] ?? 3_600_000)
  return { ok: true, skip: { stops: parsed.stops, until: isNever ? null : now + ms } }
}

/** A dialog's own skip while it lasts. */
export function liveSkip(skip: DgSkip | null, now: number): DgStop[] {
  return skip === null || (skip.until !== null && skip.until <= now) ? [] : skip.stops
}

/** Every stop skipped for a dialog now: the option's, the session's and the dialog's. */
export function skippedStops(input: { always: readonly DgStop[]; session: readonly DgStop[]; dialog: DgSkip | null; now: number }): DgStop[] {
  const all = new Set<DgStop>([...input.always, ...input.session, ...liveSkip(input.dialog, input.now)])
  return DG_STOPS.filter(stop => all.has(stop))
}

/** The red mark: `⚠ no stops` (all), `⚠ no stops: publish, delete`; `· no permissions` under bypass. */
export function noStopsLabel(stops: readonly DgStop[], permissionMode: string | null): string | null {
  const isBypass = permissionMode === 'bypassPermissions'
  if (stops.length === 0) return null
  const which = stops.length === DG_STOPS.length ? '⚠ no stops' : `⚠ no stops: ${stops.join(', ')}`
  return isBypass ? `${which} · no permissions` : which
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `until 10-11 14:00`, `never expires`. */
export function untilText(until: number | null): string {
  if (until === null) return 'never expires'
  const date = new Date(until)
  return `until ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
