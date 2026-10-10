// Which dialogs triage keeps a watch on: the ones marked with `w`, kept in
// $.store. The children themselves are the watch hub's (register.tsx,
// ./watch/watch): one per peer, shared with bot testing and pins.
import type { PeerRef, TgPeerKind } from '../../types'

/** Each watch is one connection to Telegram; past this many, `w` asks to unwatch one first. */
export const MAX_WATCHED = 8

const KINDS: readonly TgPeerKind[] = ['self', 'user', 'bot', 'group', 'channel', 'supergroup', 'unknown']

/** Watched dialogs read back from $.store, each entry checked. */
export function parseWatched(stored: unknown): PeerRef[] {
  if (!Array.isArray(stored)) return []
  return stored
    .flatMap((v: unknown): PeerRef[] => {
      if (typeof v !== 'object' || v === null) return []
      const o: Record<string, unknown> = { ...v }
      const kind = KINDS.find(one => one === o.kind)
      if (!Number.isSafeInteger(o.id) || typeof o.id !== 'number') return []
      if (typeof o.arg !== 'string' || typeof o.label !== 'string' || kind === undefined) return []
      return [{ id: o.id, arg: o.arg, label: o.label, kind }]
    })
    .slice(0, MAX_WATCHED)
}
