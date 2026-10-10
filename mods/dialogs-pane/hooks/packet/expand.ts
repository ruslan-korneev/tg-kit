// Reply-chain expansion: a selected reply never travels without the message it answers.
// The fetch is injected (the pane passes `tg msg PEER ID… --json`), so this stays pure.

import type { MessageView } from './types'

export type FetchMessages = (ids: number[]) => Promise<MessageView[]>

export type ExpandOptions = {
  /** How many reply hops to follow up from the selection. */
  depth?: number
  /** Messages the pane already holds (the visible thread); used before fetching. */
  known?: readonly MessageView[]
}

export type Expanded = {
  /** The selection, by id, unchanged. */
  messages: MessageView[]
  /** The parents pulled in, by id, without the selected ones. */
  context: MessageView[]
  /** Parents the fetch did not return (deleted, or out of reach). */
  missing: number[]
  /** Parents left unfetched because the depth limit was reached. */
  truncated: number[]
}

export const DEFAULT_REPLY_DEPTH = 5

const byId = (a: MessageView, b: MessageView): number => a.id - b.id

export async function expandReplyChain(
  selected: readonly MessageView[],
  fetch: FetchMessages,
  options: ExpandOptions = {},
): Promise<Expanded> {
  const depth = options.depth ?? DEFAULT_REPLY_DEPTH
  const have = new Map<number, MessageView>(selected.map(m => [m.id, m]))
  const known = new Map<number, MessageView>((options.known ?? []).map(m => [m.id, m]))
  const context = new Map<number, MessageView>()
  const missing = new Set<number>()

  let level: MessageView[] = [...selected]
  for (let hop = 0; hop < depth && level.length > 0; hop++) {
    const wanted = parentsOf(level).filter(id => !have.has(id) && !missing.has(id))
    if (wanted.length === 0) break
    const next: MessageView[] = []
    const toFetch: number[] = []
    for (const id of wanted) {
      const m = known.get(id)
      if (m === undefined) toFetch.push(id)
      else next.push(m)
    }
    if (toFetch.length > 0) {
      const fetched = await fetch(toFetch)
      for (const m of fetched) if (toFetch.includes(m.id)) next.push(m)
      const got = new Set(fetched.map(m => m.id))
      for (const id of toFetch) if (!got.has(id)) missing.add(id)
    }
    for (const m of next) {
      have.set(m.id, m)
      context.set(m.id, m)
    }
    level = next
  }

  const truncated = parentsOf(level).filter(id => !have.has(id) && !missing.has(id))
  return {
    messages: [...selected].sort(byId),
    context: [...context.values()].sort(byId),
    missing: [...missing].sort((a, b) => a - b),
    truncated: [...new Set(truncated)].sort((a, b) => a - b),
  }
}

function parentsOf(messages: readonly MessageView[]): number[] {
  const ids = new Set<number>()
  for (const m of messages) if (m.reply_to !== null) ids.add(m.reply_to)
  return [...ids]
}
