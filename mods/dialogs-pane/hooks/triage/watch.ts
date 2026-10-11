// Which dialogs triage keeps a watch on: the ones marked with `w`, kept in
// $.store. The children themselves are the watch hub's (register.tsx,
// ./watch/watch): one per peer, shared with bot testing and pins.
import type { PeerRef } from '../../types'
import { readPeerRef } from '../ui/model'

/** Each watch is one connection to Telegram; past this many, `w` asks to unwatch one first. */
export const MAX_WATCHED = 8

/** Watched dialogs and topics read back from $.store, each entry checked (../ui/model `readPeerRef`). */
export function parseWatched(stored: unknown): PeerRef[] {
  if (!Array.isArray(stored)) return []
  return stored
    .flatMap((v: unknown): PeerRef[] => {
      const peer = readPeerRef(v)
      return peer === null ? [] : [peer]
    })
    .slice(0, MAX_WATCHED)
}
