// Reply diff (docs/design/dialogs-pane.md §5 idea 8): two bot replies, before and
// after, as a text diff and a keyboard-shape diff. Pure.
import type { Button, MessageView } from '../packet/types'
import { callbackData } from './keyboard'

export type LineOp = { op: 'same' | 'del' | 'add'; text: string }

/** One keyboard position (`row:col`) compared across the two replies. */
export type KeyChange =
  | { op: 'same'; at: string; before: Chip; after: Chip }
  | { op: 'changed'; at: string; before: Chip; after: Chip; fields: ChipField[] }
  | { op: 'added'; at: string; after: Chip }
  | { op: 'removed'; at: string; before: Chip }

export type ChipField = 'label' | 'type' | 'data' | 'url'
export type Chip = { label: string; type: string; data: string; url: string }

export type ReplyDiff = {
  before: number
  after: number
  text: LineOp[]
  rows: [number, number]
  /** Buttons per row, before and after: the keyboard's shape. */
  shape: [number[], number[]]
  keys: KeyChange[]
}

/** Which two messages `=` compares, older first; or why it cannot. */
export function diffPair(
  ids: readonly number[],
  messages: readonly MessageView[],
): { ok: true; pair: [number, number] } | { ok: false; reason: string } {
  if (ids.length !== 2) return { ok: false, reason: `select exactly two bot replies with x (now ${ids.length})` }
  const chosen = messages.filter(one => ids.includes(one.id))
  if (chosen.length !== 2 || chosen.some(one => one.out || one.sender.kind !== 'bot')) {
    return { ok: false, reason: 'both selected messages must be bot replies' }
  }
  const [a, b] = [...ids].sort((x, y) => x - y)
  return a === undefined || b === undefined ? { ok: false, reason: 'select two messages' } : { ok: true, pair: [a, b] }
}

export function replyDiff(before: MessageView, after: MessageView): ReplyDiff {
  const keys = keyboardDiff(before.buttons, after.buttons)
  return {
    before: before.id,
    after: after.id,
    text: lineDiff(before.text.split('\n'), after.text.split('\n')),
    rows: [before.buttons.length, after.buttons.length],
    shape: [before.buttons.map(row => row.length), after.buttons.map(row => row.length)],
    keys,
  }
}

/** Longest-common-subsequence line diff; replies are short, so O(n·m) is fine. */
export function lineDiff(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length
  const m = b.length
  // lcs[i][j]: the LCS length of a[i:] and b[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i]
      if (row !== undefined) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: LineOp[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    const left = a[i]
    const right = b[j]
    if (left !== undefined && right !== undefined && left === right) {
      out.push({ op: 'same', text: left })
      i += 1
      j += 1
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      // Removals print before additions, as unified diffs read.
      out.push({ op: 'del', text: left })
      i += 1
    } else if (right !== undefined) {
      out.push({ op: 'add', text: right })
      j += 1
    }
  }
  return out
}

function chip(button: Button): Chip {
  return { label: button.text, type: button.type, data: callbackData(button), url: button.url ?? '' }
}

/** Compares the keyboards position by position (row, col): labels, types, callback data, URLs. */
export function keyboardDiff(before: readonly Button[][], after: readonly Button[][]): KeyChange[] {
  const index = (rows: readonly Button[][]) => new Map(rows.flat().map(button => [`${button.row}:${button.col}`, chip(button)]))
  const was = index(before)
  const now = index(after)
  const positions = [...new Set([...was.keys(), ...now.keys()])].sort(byPosition)
  return positions.flatMap((at): KeyChange[] => {
    const b = was.get(at)
    const a = now.get(at)
    if (b === undefined && a !== undefined) return [{ op: 'added', at, after: a }]
    if (a === undefined && b !== undefined) return [{ op: 'removed', at, before: b }]
    if (a === undefined || b === undefined) return []
    const fields = (['label', 'type', 'data', 'url'] as const).filter(field => a[field] !== b[field])
    return [fields.length === 0 ? { op: 'same', at, before: b, after: a } : { op: 'changed', at, before: b, after: a, fields }]
  })
}

function byPosition(x: string, y: string): number {
  const [xr = 0, xc = 0] = x.split(':').map(Number)
  const [yr = 0, yc = 0] = y.split(':').map(Number)
  return xr - yr || xc - yc
}

/** One chip as the diff prints it: `"Retry" cb retry`. */
export function chipText(one: Chip): string {
  const extra = one.data !== '' ? ` ${one.data}` : one.url !== '' ? ` ${one.url}` : ''
  return `"${one.label}" ${one.type}${extra}`
}

export type DiffLine = { op: 'same' | 'del' | 'add' | 'change'; text: string }

/** The keyboard part as lines: the shape, then each position that is not the same. */
export function keyboardLines(diff: ReplyDiff): DiffLine[] {
  const [rowsBefore, rowsAfter] = diff.rows
  const shape = (rows: number[]) => (rows.length === 0 ? 'none' : rows.join('+'))
  const head: DiffLine =
    rowsBefore === rowsAfter && shape(diff.shape[0]) === shape(diff.shape[1])
      ? { op: 'same', text: `keyboard: ${rowsAfter} rows (${shape(diff.shape[1])}), same shape` }
      : { op: 'change', text: `keyboard: ${rowsBefore} → ${rowsAfter} rows (${shape(diff.shape[0])} → ${shape(diff.shape[1])})` }
  const lines = diff.keys.flatMap((change): DiffLine[] => {
    switch (change.op) {
      case 'same':
        return []
      case 'added':
        return [{ op: 'add', text: `+ ${change.at} ${chipText(change.after)}` }]
      case 'removed':
        return [{ op: 'del', text: `- ${change.at} ${chipText(change.before)}` }]
      case 'changed':
        return [{ op: 'change', text: `~ ${change.at} ${chipText(change.before)} → ${chipText(change.after)} (${change.fields.join(', ')})` }]
    }
  })
  const same = diff.keys.filter(change => change.op === 'same').length
  const unchanged: DiffLine[] = same > 0 ? [{ op: 'same', text: `  ${same} button${same === 1 ? '' : 's'} unchanged` }] : []
  return [head, ...lines, ...unchanged]
}
