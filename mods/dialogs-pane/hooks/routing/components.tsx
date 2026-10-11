// The routing components of design §4: RoutePicker with AgentChips (⏎ on a
// message opens it until the send sheet, T2, replaces it), the broadcast
// picker, the packet ledger and the drafted reply. Plain functions over the
// surface's element table, as ../ui/components.tsx draws; handlers come in as
// closures. Their letters are ../ui/keys'; digits pick what is numbered here.
import type { RenderElement } from 'claude-code'

import type { BroadcastRow, LedgerEntry, RadarEntry, ReplyDraft, RouteIntent } from '../../types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { agentChip, intentLabel, ledgerRowText, recipientLabel } from './route'

export type DraftHandlers = { onCheck: () => void; onSend: () => void; onDrop: () => void; onEdit: (text: string) => void }

function IntentChip(
  { Button, Text }: Els,
  props: { intent: RouteIntent; onPress: () => void; id: string; isShort?: boolean; hotkey?: string },
): RenderElement {
  return (
    <Button key={props.id} plain hotkey={props.hotkey} onPress={props.onPress}>
      <Text dimColor>{props.isShort === true ? '' : 'intent: '}</Text>
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
 * RoutePicker: main, live agents with their AgentChips, a new agent, broadcast.
 * A digit sends at once, under the intent and redaction shown.
 */
export function RoutePicker(
  els: Els,
  props: {
    ids: readonly number[]
    radar: readonly RadarEntry[]
    isMainBusy: boolean
    intent: RouteIntent
    isRedacted: boolean
    masked: number
    width: number
    onMain: () => void
    onAgent: (agent: RadarEntry) => void
    onNew: () => void
    onBroadcast: () => void
    onIntent: () => void
    onRedact: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const nameWidth = Math.max(8, Math.min(24, props.width - 34))
  const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
  let hotkey = 1
  const next = () => (hotkey <= 9 ? String(hotkey++) : undefined)
  return (
    <Box flexDirection="column">
      <Text color={TOKEN.accent} bold>{`send ${props.ids.length === 1 ? `#${props.ids[0]}` : `${props.ids.length} messages`} to`}</Text>
      <Button key="route:main" plain hotkey={next()} onPress={props.onMain}>
        {pad('main (this session)', nameWidth + 12)}
        <Text dimColor>{agentChip(props.isMainBusy ? 'running' : 'idle')}</Text>
      </Button>
      {props.radar.map(agent => (
        <Button key={`route:agent:${agent.agentId}`} plain hotkey={next()} dimColor={agent.state === 'done'} onPress={() => props.onAgent(agent)}>
          {pad(agent.label, nameWidth)} <Text dimColor>{pad(agent.type, 11)}</Text>
          <Text color={agent.state === 'done' ? TOKEN.ok : undefined} dimColor={agent.state !== 'done'}>
            {agentChip(agent.state)}
          </Text>
        </Button>
      ))}
      {props.radar.length === 0 ? <Text dimColor>  no other agents in this session</Text> : null}
      <Button key="route:new" plain hotkey={next()} onPress={props.onNew}>
        + new agent with this as its brief
      </Button>
      <Button key="route:broadcast" plain hotkey={next()} onPress={props.onBroadcast}>
        ⇉ broadcast with per-agent intent
      </Button>
      <Box flexDirection="row" gap={2}>
        {IntentChip(els, { intent: props.intent, onPress: props.onIntent, id: 'picker:intent', hotkey: 'i' })}
        <Button key="redact" plain onPress={props.onRedact}>
          <Text dimColor>redact: </Text>
          <Text color={props.isRedacted ? undefined : TOKEN.warn}>{props.isRedacted ? `on · ${props.masked} masked` : 'off'}</Text>
        </Button>
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
      <Text dimColor>digits toggle a leg; Enter on an intent cycles it</Text>
    </Box>
  )
}

/** The packet ledger: what went to whom, its state and age; Enter jumps to the message. */
export function Ledger(
  els: Els,
  props: {
    ledger: readonly LedgerEntry[]
    now: number
    rows: number
    width: number
    onJump: (entry: LedgerEntry) => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const shown = props.ledger.slice(-Math.max(1, props.rows - 2)).reverse()
  const color = (entry: LedgerEntry) =>
    entry.state.kind === 'done' ? TOKEN.ok : entry.state.kind === 'failed' ? TOKEN.danger : undefined
  return (
    <Box flexDirection="column">
      <Text color={TOKEN.accent} bold>{`ledger · ${props.ledger.length} packet${props.ledger.length === 1 ? '' : 's'}`}</Text>
      {shown.length === 0 ? <Text dimColor>Nothing sent yet: select messages, then send.</Text> : null}
      {shown.map(entry => (
        <Button key={`ledger:${entry.seq}`} plain onPress={() => props.onJump(entry)}>
          <Text color={color(entry)}>{oneLine(ledgerRowText(entry, props.now), Math.max(20, props.width - 2))}</Text>
        </Button>
      ))}
      <Text dimColor>⏎ on a row jumps to the message</Text>
    </Box>
  )
}
