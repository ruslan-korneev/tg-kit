// The routing components of design §4 and dialogs-pane-ux.md §5.1: the send
// sheet (⏎ on a message), its targets, inspect, the broadcast legs and the
// drafted reply (the packet ledger is in Activity, ../ui/activity). Plain
// functions over the surface's element table, as ../ui/components.tsx draws; handlers come in as
// closures. Their letters are ../ui/keys'; digits pick what is numbered here.
import type { RenderElement } from 'claude-code'

import type { BroadcastRow, RadarEntry, Recipient, ReplyDraft, RouteIntent } from '../../types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { agentChip, intentLabel, recipientLabel } from './route'
import { intentText, type InspectView } from './sheet'

export type DraftHandlers = { onCheck: () => void; onSend: () => void; onDrop: () => void; onEdit: (text: string) => void }

function IntentChip({ Button, Text }: Els, props: { intent: RouteIntent; onPress: () => void; id: string }): RenderElement {
  return (
    <Button key={props.id} plain onPress={props.onPress}>
      <Text dimColor>intent: </Text>
      <Text color={TOKEN.accent} bold>{`[${intentLabel(props.intent)}]`}</Text>
    </Button>
  )
}

/**
 * The drafted reply: check (dry run, the WritePlan and the guard), then send, or drop.
 * Planned, the text is drawn whole and wrapped above "send reply": the owner sends it
 * with --yes as their own (decision 9), so they read all of it first; `edit` reopens it.
 */
export function DraftRow(
  els: Els,
  props: { draft: ReplyDraft; width: number } & DraftHandlers,
): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { draft } = props
  const head = `✎ reply to #${draft.replyTo} in ${draft.peer.label} (from ${draft.from})`
  const step = draft.step
  const status = (() => {
    switch (step.kind) {
      case 'draft':
        return { text: 'check runs tg send --dry-run: the plan and the guard first', color: undefined }
      case 'checking':
        return { text: `${GLYPH.working} checking`, color: undefined }
      case 'planned':
        return step.isAllowed
          ? { text: `plan ok: ${step.reason}; send runs it`, color: TOKEN.ok }
          : { text: `${GLYPH.error} the guard refuses: ${step.reason}; nothing is sent.`, color: TOKEN.danger }
      case 'sending':
        return { text: `${GLYPH.working} sending`, color: undefined }
      case 'sent':
        return { text: `${GLYPH.done} sent ${step.ids.map(id => `#${id}`).join(' ')}`, color: TOKEN.ok }
      case 'failed':
        return { text: `${GLYPH.error} ${step.reason}`, color: TOKEN.danger }
    }
  })()
  const isEditable = step.kind === 'draft' || step.kind === 'failed'
  return (
    <Box key="draft" flexDirection="column">
      <Text color={TOKEN.accent} wrap="truncate-end">
        {head}
      </Text>
      {step.kind === 'planned' ? (
        <Text wrap="wrap">{draft.text}</Text>
      ) : Input !== undefined && isEditable ? (
        <Input key="draft:text" label="✎" value={draft.text} submitLabel="keep" onSubmit={value => props.onEdit(value)} />
      ) : (
        <Text wrap="truncate-end">{`"${oneLine(draft.text, Math.max(10, props.width - 4))}"`}</Text>
      )}
      <Text color={status.color} dimColor={status.color === undefined} wrap="wrap">
        {status.text}
      </Text>
      <Box flexDirection="row" gap={2}>
        {step.kind === 'planned' && step.isAllowed ? (
          <Button key="draft:send" variant="primary" onPress={props.onSend}>
            send reply
          </Button>
        ) : step.kind === 'sent' ? null : (
          <Button key="draft:check" variant="primary" onPress={props.onCheck}>
            check
          </Button>
        )}
        {step.kind === 'planned' ? (
          <Button key="draft:edit" plain dimColor onPress={() => props.onEdit(draft.text)}>
            edit
          </Button>
        ) : null}
        <Button key="draft:drop" plain dimColor onPress={props.onDrop}>
          {step.kind === 'sent' ? 'close' : 'drop'}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * The send sheet (§5.1): the sender's intents on digits, the ringed one the last
 * used for this kind of sender, so ⏎ repeats it; `a` another agent, `i` inspect,
 * `h` cancel. It takes the action bar's place: four rows in the dock, two inline.
 * The last digit, Ask, swaps the intents for a field whose words are the intent
 * line.
 */
export function SendSheet(
  els: Els,
  props: {
    seat: 'dock' | 'inline'
    width: number
    title: string
    target: string
    intents: readonly RouteIntent[]
    ringed: RouteIntent
    /** How the hint names whose last intent is ringed, and whether one was used yet. */
    who: string
    isRemembered: boolean
    masked: number
    isRedacted: boolean
    isAsking: boolean
    isFocused: boolean
    onIntent: (intent: RouteIntent) => void
    onAsk: (words: string) => void
    onAgent: () => void
    onInspect: () => void
    onBack: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const isDock = props.seat === 'dock'
  const dim = !props.isFocused
  const intents = (
    <Box key="sheet:intents" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {props.intents.map((intent, index) => (
        <Button
          key={`sheet:intent:${intent}`}
          plain
          hotkey={String(index + 1)}
          autoFocus={intent === props.ringed ? true : undefined}
          dimColor={dim}
          onPress={() => props.onIntent(intent)}
        >
          {intentText(intent, !isDock)}
        </Button>
      ))}
    </Box>
  )
  const masked = props.isRedacted ? `inspect (${props.masked} masked)` : 'inspect (not redacted)'
  const keys = [
    <Button key="key:agent" plain hotkey="a" dimColor={dim} onPress={props.onAgent}>
      another agent
    </Button>,
    <Button key="key:inspect" plain hotkey="i" dimColor={dim} onPress={props.onInspect}>
      {masked}
    </Button>,
    <Button key="key:back" plain hotkey="h" dimColor={dim} onPress={props.onBack}>
      cancel
    </Button>,
  ]
  const ask =
    Input === undefined ? (
      <Text key="sheet:ask" dimColor>
        this surface has no field: send from the prompt
      </Text>
    ) : (
      <Input key="sheet:ask" label="ask" autoFocus placeholder="your words go under the packet" value="" submitLabel="send" onSubmit={words => props.onAsk(words)} />
    )
  const askHint = <Text dimColor wrap="truncate-end">⏎ sends with these words · ⏎ on an empty field goes back</Text>
  const since = props.isRemembered ? `last used for ${props.who}` : `${props.who} start on ${intentText(props.ringed, true).replace('…', '')}`
  if (isDock) {
    const head = ` ${props.title} `
    const tail = ` ${props.target} `
    const rule = Math.max(1, props.width - head.length - tail.length - 2)
    return (
      <Box key="sheet" flexDirection="column">
        <Text color={TOKEN.accent} dimColor wrap="truncate-end">{`─${head}${'─'.repeat(rule)}${tail}─`}</Text>
        {props.isAsking ? ask : intents}
        {props.isAsking ? askHint : <Box flexDirection="row" columnGap={3}>{keys}</Box>}
        {props.isAsking ? null : <Text dimColor wrap="truncate-end">{`⏎ sends the ringed one (${since})`}</Text>}
      </Box>
    )
  }
  return (
    <Box key="sheet" flexDirection="column">
      <Box flexDirection="row" columnGap={3}>
        <Text color={TOKEN.accent} wrap="truncate-end">{`${props.title} ${props.target.replace(/ · .*$/, '')}`}</Text>
        {props.isAsking ? null : intents}
      </Box>
      {props.isAsking ? ask : null}
      {props.isAsking ? (
        askHint
      ) : (
        <Box flexDirection="row" columnGap={3}>
          <Text dimColor>⏎ the ringed one</Text>
          {keys}
        </Box>
      )}
    </Box>
  )
}

/**
 * `a` in the sheet: where the packet goes (§5.1 "the radar; digits pick"):
 * main, the live agents with their state, a new agent, several agents.
 */
export function TargetList(
  els: Els,
  props: {
    title: string
    to: Recipient
    radar: readonly RadarEntry[]
    isMainBusy: boolean
    width: number
    onMain: () => void
    onAgent: (agent: RadarEntry) => void
    onNew: () => void
    onSeveral: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const nameWidth = Math.max(8, Math.min(24, props.width - 34))
  const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
  let hotkey = 1
  const next = () => (hotkey <= 9 ? String(hotkey++) : undefined)
  const isTo = (key: string) => (props.to.kind === 'main' ? key === 'main' : props.to.kind === 'new' ? key === 'new' : key === props.to.agentId)
  return (
    <Box key="targets" flexDirection="column">
      <Text color={TOKEN.accent} bold>{`${props.title} to`}</Text>
      <Button key="route:main" plain hotkey={next()} autoFocus={isTo('main') ? true : undefined} onPress={props.onMain}>
        {pad('main (this session)', nameWidth + 12)}
        <Text dimColor>{agentChip(props.isMainBusy ? 'running' : 'idle')}</Text>
      </Button>
      {props.radar.map(agent => (
        <Button
          key={`route:agent:${agent.agentId}`}
          plain
          hotkey={next()}
          autoFocus={isTo(agent.agentId) ? true : undefined}
          dimColor={agent.state === 'done'}
          onPress={() => props.onAgent(agent)}
        >
          {pad(agent.label, nameWidth)} <Text dimColor>{pad(agent.type, 11)}</Text>
          <Text color={agent.state === 'done' ? TOKEN.ok : undefined} dimColor={agent.state !== 'done'}>
            {agentChip(agent.state)}
          </Text>
        </Button>
      ))}
      {props.radar.length === 0 ? <Text dimColor>  no other agents in this session</Text> : null}
      <Button key="route:new" plain hotkey={next()} autoFocus={isTo('new') ? true : undefined} onPress={props.onNew}>
        + a new agent, this packet as its brief
      </Button>
      <Button key="route:broadcast" plain hotkey={next()} onPress={props.onSeveral}>
        ⇉ several agents, an intent each
      </Button>
    </Box>
  )
}

/** `i` in the sheet: what the agent will read, and this packet's redaction toggle (§5.1 "inspect"). */
export function Inspect(
  els: Els,
  props: { target: string; view: InspectView; isRedacted: boolean; width: number; onRedact: () => void },
): RenderElement {
  const { Box, Text, Button } = els
  const line = (key: string, label: string, text: string) => (
    <Box key={`inspect:${key}`} flexDirection="row">
      <Box width={7} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text wrap="wrap">{text}</Text>
    </Box>
  )
  return (
    <Box key="inspect" flexDirection="column">
      <Text color={TOKEN.accent} bold wrap="truncate-end">{`inspect · ${props.target} reads this`}</Text>
      <Text wrap="truncate-end">{props.view.head}</Text>
      {props.view.messages.map((text, index) => (
        <Text key={`inspect:msg:${index}`} wrap="truncate-end">
          {text}
        </Text>
      ))}
      {props.view.parents.map((text, index) => (
        <Text key={`inspect:parent:${index}`} dimColor wrap="truncate-end">
          {text}
        </Text>
      ))}
      {props.view.replay === null ? null : line('replay', 'replay', props.view.replay)}
      {line('masked', 'masked', props.view.masked)}
      <Box flexDirection="row" columnGap={3}>
        <Button key="sheet:redact" plain autoFocus onPress={props.onRedact}>
          <Text dimColor>redaction: </Text>
          <Text color={props.isRedacted ? undefined : TOKEN.warn}>{props.isRedacted ? 'on' : 'off'}</Text>
        </Button>
        <Text dimColor>{`⏎ turns it ${props.isRedacted ? 'off' : 'on'} for this packet`}</Text>
      </Box>
    </Box>
  )
}

/** Broadcast: each leg on or off with an intent of its own; done sets the route. */
export function BroadcastPicker(
  els: Els,
  props: {
    count: number
    rows: readonly BroadcastRow[]
    width: number
    onToggle: (index: number) => void
    onIntent: (index: number) => void
    onAdd: () => void
    onDone: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const on = props.rows.filter(row => row.isOn).length
  return (
    <Box flexDirection="column">
      <Text color={TOKEN.accent} bold>{`broadcast ${props.count} message${props.count === 1 ? '' : 's'}: one packet, an intent per agent; ⏎ sends`}</Text>
      {props.rows.map((row, index) => (
        <Box key={`leg:${index}`} flexDirection="row" gap={1}>
          <Button key={`leg:${index}:on`} plain hotkey={index < 9 ? String(index + 1) : undefined} onPress={() => props.onToggle(index)}>
            {row.isOn ? '[x] ' : '[ ] '}
            {recipientLabel(row.to).padEnd(16)}
          </Button>
          {IntentChip(els, { intent: row.intent, onPress: () => props.onIntent(index), id: `leg:${index}:intent` })}
        </Box>
      ))}
      <Box flexDirection="row" gap={2}>
        <Button key="broadcast:done" variant="primary" onPress={props.onDone}>
          {`send to ${on}`}
        </Button>
        <Button key="broadcast:add" plain dimColor onPress={props.onAdd}>
          + new agent
        </Button>
      </Box>
      <Text dimColor>digits turn a leg on or off; ⏎ on an intent cycles it</Text>
    </Box>
  )
}
