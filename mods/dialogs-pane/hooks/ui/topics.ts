// A forum's Topics (docs/design/dialogs-pane-ux.md §10.9): the rows, the sums
// the forum's row and `≡ all topics` show, what waits while the cursor stays,
// the breadcrumb, and the merged stream's topic column. Pure: register.tsx
// reads `tg topics` and makes every `$` call.
import type { Color } from 'claude-code'

import type { Topic, TopicRef } from '../../types'
import { cutCells, waitingCount } from '../folders/folders'
import { GLYPH, cells, rowSymbol, rowTime, type AgentMark } from './model'
import type { Role } from './palette'

/** General is topic 1 in every forum (README "Forum topics"). */
export const GENERAL_ID = 1

/** The merged stream's topic column (§10.9): 10 cells, then a space. */
export const TOPIC_COLUMN = 10

/** The topic as a peer is narrowed to it. */
export function topicRef(topic: Pick<Topic, 'id' | 'title' | 'closed'>): TopicRef {
  return { id: topic.id, title: topic.title, isClosed: topic.closed }
}

/** What every topic adds up to: the forum's row and `≡ all topics` show it (mentions first, then unread). */
export function topicSums(topics: readonly Pick<Topic, 'unread' | 'mentions'>[]): { unread: number; mentions: number } {
  return topics.reduce((sum, topic) => ({ unread: sum.unread + topic.unread, mentions: sum.mentions + topic.mentions }), { unread: 0, mentions: 0 })
}

/** The forum's row symbol from its topics: a mention outranks unread, as on any row (§10.3). */
export function forumSymbol(topics: readonly Pick<Topic, 'unread' | 'mentions'>[], agent: AgentMark | null): { text: string; role: Role } | null {
  return rowSymbol({ ...topicSums(topics), muted: false, username: null }, agent)
}

/** The topic most recently written in: `≡ all topics` previews its last message. */
export function newestTopic<T extends Pick<Topic, 'last_date'>>(topics: readonly T[]): T | undefined {
  return topics.reduce<T | undefined>((top, topic) => ((topic.last_date ?? '') > (top?.last_date ?? '') ? topic : top), undefined)
}

/** A row as ChatRow draws it; `glyph.color` is a topic's own colour, over its role. */
export type TopicRowLook = {
  time: string
  glyph: { text: string; role: Role; color?: Color }
  name: string
  isUnread: boolean
  preview: { text: string }
  symbol: { text: string; role: Role } | null
}

/** `≡ all topics`: the newest message labelled with its topic, and every topic's counts summed. */
export function allTopicsRow(topics: readonly Topic[], now: number): TopicRowLook {
  const newest = newestTopic(topics)
  const sums = topicSums(topics)
  return {
    time: rowTime(newest?.last_date ?? null, now),
    glyph: { text: GLYPH.allTopics, role: 'group' },
    name: 'all topics',
    isUnread: sums.unread > 0,
    preview: { text: newest === undefined ? '' : `${newest.title} · ${newest.last_text}` },
    symbol: forumSymbol(topics, null),
  }
}

/**
 * One topic's row (§10.9): `●` in its colour (`color`: the palette's for its
 * `icon_color`), General `#` dim; the symbol by §10.3's order, `⊘` once closed.
 */
export function topicRow(topic: Topic, context: { now: number; agent: AgentMark | null; color: Color | undefined }): TopicRowLook {
  const isGeneral = topic.id === GENERAL_ID
  return {
    time: rowTime(topic.last_date, context.now),
    glyph: isGeneral ? { text: GLYPH.general, role: 'dim' } : { text: GLYPH.topic, role: 'dim', ...(context.color === undefined ? {} : { color: context.color }) },
    name: topic.title,
    isUnread: topic.unread > 0,
    preview: { text: topic.last_text },
    symbol: rowSymbol({ unread: topic.unread, mentions: topic.mentions, muted: false, username: null }, context.agent, { isClosed: topic.closed }),
  }
}

/**
 * The topics as drawn, each as `latest` has it now, in the order drawn: counts
 * and the last message change in place while the cursor stays. A topic gone
 * from `latest` keeps its row until the owner's next move (§4.3 rule 1).
 */
export function topicsInPlace(drawn: readonly Topic[], latest: readonly Topic[]): Topic[] {
  const now = new Map(latest.map(topic => [topic.id, topic]))
  return drawn.map(topic => now.get(topic.id) ?? topic)
}

/** `↑N`: the topics that moved, joined or left since the list was drawn (as Chats count theirs). */
export function topicsWaiting(drawn: readonly Pick<Topic, 'id'>[], latest: readonly Pick<Topic, 'id'>[]): number {
  return waitingCount(
    drawn.map(topic => String(topic.id)),
    latest.map(topic => String(topic.id)),
  )
}

/** A Topics row's key: the generation, the chat and the topic (`all` for `≡ all topics`), so a reshaped list brings new keys. */
export function topicRowKey(gen: number, chatId: number, topicId: number | 'all'): string {
  return `topic:${gen}:${chatId}:${topicId}`
}

/**
 * The card's breadcrumb (§10.9): `tg › Work › Project team`, then `› Design
 * review` (or `› all topics`) once a stream is open. A narrow card (under 52
 * columns) drops `tg ›` first; the card's title cuts the rest.
 */
export function breadcrumb(parts: { folder: string | null; forum: string; topic: string | null }, isWide: boolean): string {
  const tail = [parts.folder, parts.forum, parts.topic].filter((part): part is string => part !== null && part !== '').join(' › ')
  return isWide ? `tg › ${tail}` : tail
}

/** The merged stream's topic column: its title cut to 10 cells and padded (§10.9); `?` for one the list lacks. */
export function topicColumn(title: string | undefined): string {
  const cut = cutCells(title ?? '?', TOPIC_COLUMN)
  return cut + ' '.repeat(Math.max(0, TOPIC_COLUMN - cells(cut)))
}
