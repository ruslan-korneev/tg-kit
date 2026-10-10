import { describe, expect, test } from 'claude-code/testing'

import { expandReplyChain } from './expand'
import { msg } from './fixtures'
import type { MessageView } from './types'

/** A chain 1 ← 2 ← 3 ← 4 ← 5 (each replies to the one before). */
const CHAIN = [1, 2, 3, 4, 5].map(id => msg({ id, reply_to: id === 1 ? null : id - 1, text: `m${id}` }))

function store(messages: readonly MessageView[]) {
  const calls: number[][] = []
  const fetch = async (ids: number[]): Promise<MessageView[]> => {
    calls.push(ids)
    return messages.filter(m => ids.includes(m.id))
  }
  return { calls, fetch }
}

describe('expandReplyChain', () => {
  test('pulls missing parents, one fetch per hop, sorted, without the selection', async () => {
    const s = store(CHAIN)
    const last = CHAIN[4]
    if (last === undefined) throw new Error('fixture')
    const out = await expandReplyChain([last], s.fetch)
    expect(out.context.map(m => m.id)).toEqual([1, 2, 3, 4])
    expect(out.messages.map(m => m.id)).toEqual([5])
    expect(s.calls).toEqual([[4], [3], [2], [1]])
    expect(out.missing).toEqual([])
    expect(out.truncated).toEqual([])
  })

  test('stops at the depth limit and reports what it left', async () => {
    const s = store(CHAIN)
    const out = await expandReplyChain(CHAIN.slice(4), s.fetch, { depth: 2 })
    expect(out.context.map(m => m.id)).toEqual([3, 4])
    expect(out.truncated).toEqual([2])
  })

  test('uses known messages before fetching, and never fetches a selected one', async () => {
    const s = store(CHAIN)
    const out = await expandReplyChain(CHAIN.slice(3), s.fetch, { known: CHAIN.slice(1, 3) })
    // 5 → 4 is selected; 4 → 3 and 3 → 2 are known; only 1 is fetched.
    expect(s.calls).toEqual([[1]])
    expect(out.context.map(m => m.id)).toEqual([1, 2, 3])
  })

  test('a parent the fetch does not return is missing, not retried', async () => {
    const s = store(CHAIN.filter(m => m.id !== 3))
    const out = await expandReplyChain(CHAIN.slice(4), s.fetch)
    expect(out.missing).toEqual([3])
    expect(out.context.map(m => m.id)).toEqual([4])
    expect(s.calls).toEqual([[4], [3]])
  })

  test('shared parents are fetched once; nothing to do means no fetch', async () => {
    const root = msg({ id: 1 })
    const a = msg({ id: 2, reply_to: 1 })
    const b = msg({ id: 3, reply_to: 1 })
    const s = store([root])
    const out = await expandReplyChain([b, a], s.fetch)
    expect(s.calls).toEqual([[1]])
    expect(out.messages.map(m => m.id)).toEqual([2, 3])
    const none = store([])
    await expandReplyChain([root], none.fetch)
    expect(none.calls).toEqual([])
  })

  test('a fetch failure propagates', async () => {
    const failing = async (): Promise<MessageView[]> => {
      throw new Error('tg exited 3')
    }
    await expect(expandReplyChain(CHAIN.slice(4), failing)).rejects.toThrow('tg exited 3')
  })
})
