// The guard plugin's values as this plugin reads them: another plugin's
// $.state, so external data, narrowed here field by field. A value that does
// not read is empty (no steps, no holds); `armed` that does not read is "the
// guard did not answer", and delegate does not start. Pure.
import type { DgStep, DgStop, GuardArmed, GuardEvent, GuardHold, GuardWork, PeerRef, TgPeerKind } from '../../types'
import { stopsOf } from './grant'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const PEER_KINDS: readonly TgPeerKind[] = ['self', 'user', 'bot', 'group', 'channel', 'supergroup', 'unknown']

export function armedOf(v: unknown): GuardArmed | null {
  if (!isObj(v) || num(v.at) === null || !Array.isArray(v.taskIds)) return null
  return { at: num(v.at) ?? 0, taskIds: v.taskIds.filter((one): one is number => typeof one === 'number') }
}

function stepOf(v: unknown): DgStep | null {
  if (!isObj(v) || str(v.text) === null || num(v.count) === null || (v.state !== 'done' && v.state !== 'failed')) return null
  return { text: str(v.text) ?? '', count: num(v.count) ?? 1, state: v.state }
}

function stopsIn(v: unknown): DgStop[] | null {
  const stops = stopsOf(v)
  return stops.length === 0 ? null : stops
}

export function workOf(v: unknown): GuardWork[] {
  if (!Array.isArray(v)) return []
  return v.flatMap(one => {
    if (!isObj(one) || num(one.taskId) === null || !Array.isArray(one.steps)) return []
    const steps = one.steps.map(stepOf).filter((step): step is DgStep => step !== null)
    return [{ taskId: num(one.taskId) ?? 0, steps, current: str(one.current) }]
  })
}

export function holdsOf(v: unknown): GuardHold[] {
  if (!Array.isArray(v)) return []
  return v.flatMap(one => {
    const stops = isObj(one) ? stopsIn(one.stops) : null
    if (!isObj(one) || stops === null || num(one.id) === null || num(one.taskId) === null) return []
    return [{ id: num(one.id) ?? 0, taskId: num(one.taskId) ?? 0, stops, what: str(one.what) ?? '', since: num(one.since) ?? 0 }]
  })
}

function peerOf(v: unknown): PeerRef | null {
  if (!isObj(v) || num(v.id) === null || str(v.arg) === null || str(v.label) === null) return null
  const kind = PEER_KINDS.find(one => one === v.kind)
  return kind === undefined ? null : { id: num(v.id) ?? 0, arg: str(v.arg) ?? '', label: str(v.label) ?? '', kind }
}

export function eventsOf(v: unknown): GuardEvent[] {
  if (!Array.isArray(v)) return []
  return v.flatMap(one => {
    if (!isObj(one)) return []
    const peer = peerOf(one.peer)
    const stops = stopsIn(one.stops)
    const answer = one.answer === 'yes' || one.answer === 'no' || one.answer === 'skipped' ? one.answer : null
    if (peer === null || stops === null || answer === null || num(one.seq) === null || num(one.at) === null || num(one.taskId) === null) return []
    return [{ seq: num(one.seq) ?? 0, at: num(one.at) ?? 0, taskId: num(one.taskId) ?? 0, peer, summary: str(one.summary) ?? '', stops, what: str(one.what) ?? '', answer, why: str(one.why) ?? '' }]
  })
}
