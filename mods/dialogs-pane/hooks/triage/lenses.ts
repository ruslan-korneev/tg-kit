// Saved lenses (design idea 12): named filters kept in $.store, drawn as tabs
// after All / Bots / Unread on the digits 4–9. Pure.
import type { Lens, SavedLens, TgDialog, TgPeerKind } from '../../types'

/** Digits 1–3 are the built-in lenses; 4–9 leave room for six saved ones. */
export const MAX_LENSES = 6
export const FIRST_LENS_DIGIT = 4

/** The kind toggles the editor draws, each covering the tg kinds it names. */
export const KIND_GROUPS = {
  bots: ['bot'],
  people: ['user'],
  groups: ['group', 'supergroup'],
  channels: ['channel'],
  saved: ['self'],
} as const satisfies Record<string, readonly TgPeerKind[]>
export type KindGroup = keyof typeof KIND_GROUPS
export const KIND_GROUP_NAMES = ['bots', 'people', 'groups', 'channels', 'saved'] as const satisfies readonly KindGroup[]

export function lensMatches(lens: SavedLens, dialog: TgDialog): boolean {
  if (lens.kinds.length > 0 && !lens.kinds.includes(dialog.kind)) return false
  if (lens.isUnreadOnly && dialog.unread === 0) return false
  if (lens.dialogs.length > 0 && !lens.dialogs.includes(dialog.id)) return false
  const query = lens.query.trim().toLowerCase()
  return query === '' || `${dialog.title} ${dialog.username ?? ''}`.toLowerCase().includes(query)
}

/** A new lens starts from what the pane shows now, so "save this view" is one key. */
export function draftFrom(view: { lens: Lens; query: string }, taken: readonly SavedLens[], id: string): SavedLens {
  return {
    id,
    name: `Lens ${taken.length + 1}`,
    kinds: view.lens === 'bots' ? ['bot'] : [],
    isUnreadOnly: view.lens === 'unread',
    query: view.query,
    dialogs: [],
  }
}

export function hasGroup(lens: SavedLens, group: KindGroup): boolean {
  return KIND_GROUPS[group].every(kind => lens.kinds.includes(kind))
}

export function toggleGroup(lens: SavedLens, group: KindGroup): SavedLens {
  const kinds: readonly TgPeerKind[] = KIND_GROUPS[group]
  const next = hasGroup(lens, group) ? lens.kinds.filter(kind => !kinds.includes(kind)) : [...new Set([...lens.kinds, ...kinds])]
  return { ...lens, kinds: next }
}

export function togglePicked(lens: SavedLens, dialogId: number): SavedLens {
  const dialogs = lens.dialogs.includes(dialogId) ? lens.dialogs.filter(id => id !== dialogId) : [...lens.dialogs, dialogId]
  return { ...lens, dialogs }
}

/** Saves `lens` over the one with its id, or after the others when it is new. */
export function upsertLens(lenses: readonly SavedLens[], lens: SavedLens): SavedLens[] {
  const clean = { ...lens, name: lens.name.trim() === '' ? 'Lens' : lens.name.trim().slice(0, 16) }
  return lenses.some(one => one.id === lens.id) ? lenses.map(one => (one.id === lens.id ? clean : one)) : [...lenses, clean]
}

/** What the lens filters, for its empty state and the editor's header. */
export function describeLens(lens: SavedLens): string {
  const parts = [
    lens.kinds.length === 0 ? 'every kind' : KIND_GROUP_NAMES.filter(group => hasGroup(lens, group)).join(', '),
    lens.isUnreadOnly ? 'unread only' : '',
    lens.query === '' ? '' : `matching "${lens.query}"`,
    lens.dialogs.length === 0 ? '' : `${lens.dialogs.length} picked`,
  ]
  return parts.filter(part => part !== '').join(' · ')
}

const KINDS: readonly TgPeerKind[] = ['self', 'user', 'bot', 'group', 'channel', 'supergroup', 'unknown']

/** Lenses read back from $.store: whatever is stored is checked, and a bad entry is dropped. */
export function parseLenses(stored: unknown): SavedLens[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((v: unknown): SavedLens[] => {
    if (typeof v !== 'object' || v === null) return []
    const o: Record<string, unknown> = { ...v }
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.query !== 'string') return []
    const kinds: unknown = o.kinds
    const dialogs: unknown = o.dialogs
    if (!Array.isArray(kinds) || !Array.isArray(dialogs)) return []
    return [
      {
        id: o.id,
        name: o.name,
        kinds: KINDS.filter(kind => kinds.includes(kind)),
        isUnreadOnly: o.isUnreadOnly === true,
        query: o.query,
        dialogs: dialogs.filter((id): id is number => Number.isSafeInteger(id)),
      },
    ]
  }).slice(0, MAX_LENSES)
}
