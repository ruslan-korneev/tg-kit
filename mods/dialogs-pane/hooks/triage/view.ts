// The dialog list the pane shows once triage has its say: the built-in lens or
// a saved one, the search, then needs-you ranking when it is on. Pure.
import type { Nav, TgDialog, Triage } from '../../types'
import { visibleDialogs } from '../ui/model'
import { lensMatches } from './lenses'
import { rank, type Me } from './needs'

export const NO_ME: Me = { username: null, name: null }

export function triageDialogs(list: readonly TgDialog[], nav: Pick<Nav, 'lens' | 'query'>, state: Triage, me: Me): TgDialog[] {
  const saved = state.lenses.find(lens => lens.id === state.lens)
  const shown =
    saved === undefined
      ? visibleDialogs(list, nav)
      : visibleDialogs(list, { lens: 'all', query: nav.query }).filter(dialog => lensMatches(saved, dialog))
  return state.isRanked ? rank(shown, me, state.verdicts, state.repliedToYou) : shown
}
