// The cross-session lock on an autopilot dialog. $.store is one file shared by
// every session that loads the mod, so it carries a lease per dialog (its own
// key, so two sessions writing different dialogs do not overwrite each other):
// the owning session and its last heartbeat. A second session sees a fresh
// lease and does not start; a lease whose heartbeat stopped (its session closed
// or crashed) is free after LEASE_TTL_MS. Applies to every level. Pure.

export const LEASE_PREFIX = 'autopilot.lease.'
export const HEARTBEAT_MS = 30_000
/** Three missed heartbeats. */
export const LEASE_TTL_MS = 90_000

export type Lease = { session: string; beat: number }

/** By peer key: a chat's id, or `chatId:topicId` for a forum topic's agent (§10.9). */
export const leaseKey = (key: string) => `${LEASE_PREFIX}${key}`

export function leaseOf(v: unknown): Lease | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const session: unknown = 'session' in v ? v.session : undefined
  const beat: unknown = 'beat' in v ? v.beat : undefined
  return typeof session === 'string' && typeof beat === 'number' ? { session, beat } : null
}

/** Who holds the dialog now: `free`, this session, or another one with a live heartbeat. */
export function holder(lease: Lease | null, session: string, now: number): { kind: 'free' } | { kind: 'mine' } | { kind: 'other'; session: string; ageMs: number } {
  if (lease === null || now - lease.beat > LEASE_TTL_MS) return { kind: 'free' }
  if (lease.session === session) return { kind: 'mine' }
  return { kind: 'other', session: lease.session, ageMs: Math.max(0, now - lease.beat) }
}
