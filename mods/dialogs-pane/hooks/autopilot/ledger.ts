// The autopilot ledger (docs/design/dialogs-pane.md §6 "Safety model"): every
// burst with its incoming messages, the reply, the confidence, the level, each
// check-before-send choice, the escalation and the undo state; and the lines
// the status line and the band draw from it. Pure.
import type { ApCheck, ApDraft, ApEntry, ApOutcome, ApUndo, ApUndoWindow, Autopilot } from '../../types'
import { GLYPH, oneLine } from '../ui/model'
import { LEVEL_GLYPH } from './config'

/** `u` deletes an auto reply this long after it went out. */
export const UNDO_MS = 30_000
const LEDGER_MAX = 200

export const NO_AUTOPILOT: Autopilot = {
  dialogs: {},
  running: [],
  phase: {},
  view: { kind: 'none' },
  ledger: [],
  drafts: [],
  notes: [],
  undo: null,
  now: 0,
}

export function addEntry(ledger: readonly ApEntry[], entry: Omit<ApEntry, 'seq'>): ApEntry[] {
  const seq = ledger.reduce((top, one) => Math.max(top, one.seq), 0) + 1
  return [...ledger, { ...entry, seq }].slice(-LEDGER_MAX)
}

export function patchEntry(ledger: readonly ApEntry[], seq: number, patch: Partial<Omit<ApEntry, 'seq'>>): ApEntry[] {
  return ledger.map(entry => (entry.seq === seq ? { ...entry, ...patch } : entry))
}

export function logCheck(ledger: readonly ApEntry[], seq: number, check: ApCheck): ApEntry[] {
  return ledger.map(entry => (entry.seq === seq ? { ...entry, checks: [...entry.checks, check] } : entry))
}

/** One draft per dialog: a newer one replaces it. */
export function putDraft(drafts: readonly ApDraft[], draft: ApDraft): ApDraft[] {
  return [...drafts.filter(one => one.peer.id !== draft.peer.id), draft]
}

/** Seconds left in the undo window, rounded up; 0 once closed. */
export function undoLeft(undo: ApUndoWindow | null, now: number): number {
  return undo === null ? 0 : Math.max(0, Math.ceil((undo.until - now) / 1000))
}

const confText = (confidence: number | null) => (confidence === null ? '' : ` · conf ${confidence.toFixed(2)}`)

/** `tg ⟳ dev-team replied "Merged, thanks" · conf 0.93 · u undo 28s` (design §6 mockup). */
export function undoStatus(undo: ApUndoWindow, now: number): string {
  return `tg ${LEVEL_GLYPH.auto} ${undo.peer.label} replied "${oneLine(undo.text, 32)}"${confText(undo.confidence)} · u undo ${undoLeft(undo, now)}s`
}

/** The status line's autopilot tail: drafts waiting for you. */
export function draftsTail(drafts: readonly ApDraft[]): string {
  return drafts.length === 0 ? '' : ` · ${LEVEL_GLYPH.draft} ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`
}

function outcomeText(outcome: ApOutcome): string {
  switch (outcome.kind) {
    case 'working':
      return `${GLYPH.working}working`
    case 'sent':
      return `${GLYPH.done} sent${outcome.by === 'you' ? ' by you' : ''}`
    case 'drafted':
      return `${LEVEL_GLYPH.draft} draft${outcome.reasons.length === 0 ? '' : ` (${outcome.reasons.join(' · ')})`}`
    case 'dropped':
      return 'draft dropped'
    case 'listened':
      return `${LEVEL_GLYPH.listen} summarized`
    case 'skipped':
      return `skipped: ${outcome.reason}`
    case 'failed':
      return `${GLYPH.error} ${outcome.reason}`
    // ── delegate ──
    case 'stop':
      return outcome.answer === 'skipped'
        ? `skipped stop: ${outcome.stops.join(', ')} ${outcome.what}`
        : `HARD STOP ${outcome.stops.join(' + ')}: ${outcome.what} → ${outcome.answer} (${outcome.why})`
  }
}

function undoText(undo: ApUndo | null, now: number): string {
  if (undo === null) return ''
  switch (undo.state) {
    case 'open':
      return ` · u undo ${Math.max(0, Math.ceil((undo.until - now) / 1000))}s`
    case 'undone':
      return ' · undone'
    case 'expired':
      return ''
    case 'failed':
      return ` · undo failed: ${undo.reason}`
  }
}

const CHECK_LABEL: Record<ApCheck, string> = { send: 'send as is', regenerate: 'regenerate', send_then_answer: 'send, then answer' }

/** LedgerRow, two lines: what came in, and what the autopilot did with it. */
export function entryLines(entry: ApEntry, now: number, width: number): [string, string] {
  // ── delegate ── a hard stop has no incoming message: its task is the head.
  if (entry.outcome.kind === 'stop') return [`${LEVEL_GLYPH[entry.level]} ${entry.peer.label} · ${oneLine(entry.reply, Math.max(10, width - entry.peer.label.length - 6))}`, `  ${outcomeText(entry.outcome)}`]
  const first = entry.incoming[0]?.text ?? ''
  const more = entry.incoming.length > 1 ? ` +${entry.incoming.length - 1}` : ''
  const head = `${LEVEL_GLYPH[entry.level]} ${entry.peer.label} ← "${oneLine(first, Math.max(10, width - entry.peer.label.length - 12))}"${more}`
  const checks = entry.checks.length === 0 ? '' : ` · check: ${entry.checks.map(one => CHECK_LABEL[one]).join(' → ')}`
  const reply = entry.reply === '' ? '' : `→ "${oneLine(entry.reply, 40)}"`
  const tail = `${confText(entry.confidence)}${checks} · ${outcomeText(entry.outcome)}${undoText(entry.undo, now)}`
  return [head, `  ${reply}${tail}`.replace(/^ {2} · /, '  ')]
}
