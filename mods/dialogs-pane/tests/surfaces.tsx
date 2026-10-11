// The engine's own drawing of the sites the pane rewrites (§8 T5): the footer
// label (SessionMode), the hint line (PromptHint), a transcript row
// (UserMessage) and a command's output row (CommandOutput), each drawn as one
// Text of the props it was handed, so a test reads what the plugin passed on.
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { KEYS, hotkeyTable } from '../hooks/ui/keys'

export function engineSites(on: On): void {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="modes">{e.props.modes.join(' & ')}</Text>
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="hint">{`${e.props.hint}${e.props.tail === undefined ? '' : ` | ${e.props.tail}`}`}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="row">{e.props.text}</Text>
  })
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="row">{e.props.text}</Text>
  })
}

/** Another plugin's card above the prompt, beneath this one (statuspane's, §10.7 P3): one Text keyed `beneath`. */
export function beneathCard(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="beneath">another card</Text>
  })
}

export const FOOTER = { component: 'SessionMode', props: { modes: ['focus'] } } as const
export const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

/** What the engine would draw at a site now: the one Text of `engineSites`. */
export async function siteText($: Engine, site: typeof FOOTER | typeof HINT): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'dialogs-pane', surface: 'terminal', ...site })
  const text = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return text
}

/**
 * The band's hotkeys as drawn and kept hidden, checked against §6 "Band": one
 * Button per hotkey, each a key the table gives the band, no digit (§11: a
 * prompt that starts with a digit would press it). Returns the problems.
 */
export async function bandKeyProblems(band: { findAll: (query: { type: 'Button' }) => Promise<{ props: { hotkey?: unknown } }[]> }): Promise<string[]> {
  const keys = (await band.findAll({ type: 'Button' })).flatMap(button => (typeof button.props.hotkey === 'string' ? [button.props.hotkey] : []))
  const owners = hotkeyTable()
  return keys.flatMap((key, index) => {
    const def = KEYS.find(one => one.id === owners.get(key))
    if (keys.indexOf(key) !== index) return [`${key} twice`]
    if (def === undefined || !(def.where as readonly string[]).includes('band')) return [`${key} is not a band key`]
    return []
  })
}
