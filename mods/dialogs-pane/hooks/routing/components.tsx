// The routing components of design §4: the tray with its chips (route,
// IntentChip, redaction, pin), RoutePicker with AgentChips, the broadcast
// picker, LedgerRow and the drafted reply. Plain functions over the surface's
// element table, as ../ui/components.tsx draws; handlers come in as closures.
import type { RenderElement } from 'claude-code'

import type {
  BroadcastRow,
  LedgerEntry,
  Pin,
  RadarEntry,
  ReplyDraft,
  Route,
  RouteIntent,
  Selection,
  TgMessage,
} from '../../types'
import type { Redaction } from '../packet/redact'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { agentChip, intentLabel, ledgerRowText, recipientLabel, routeLabel } from './route'

/** What the tray knows about the packet before anything runs. */
export type TrayPreview = {
  selected: readonly TgMessage[]
  /** Reply-chain parents in the thread, and the ones a send fetches. */
  parents: number
  toFetch: number
  redactions: readonly Redaction[]
}

export type TrayProps = {
  size: 'full' | 'line'
  selection: Selection
  preview: TrayPreview
  route: Route
  intent: RouteIntent
  isRedacted: boolean
  isMaskShown: boolean
  pin: Pin | null
  draft: ReplyDraft | null
  width: number
  onSend: () => void
  onWhole: () => void
  onClear: () => void
  onRoute: () => void
  onIntent: () => void
  onRedact: () => void
  onMask: () => void
  onPin: () => void
  onLedger: () => void
  onDraft: DraftHandlers
}

export type DraftHandlers = { onCheck: () => void; onSend: () => void; onDrop: () => void; onEdit: (text: string) => void }

function summaryOf(preview: TrayPreview): string {
  const { selected } = preview
  if (selected.length === 0) return 'nothing selected: x selects, v a range, d the whole thread'
  const ids = selected
    .slice(0, 4)
    .map(message => `#${message.id}`)
    .join(' ')
  const more = selected.length > 4 ? ` +${selected.length - 4}` : ''
  const buttons = selected.reduce((sum, message) => sum + message.buttons.flat().length, 0)
  const media = selected.filter(message => message.media !== null).length
  const parents = preview.parents + preview.toFetch
  const chain = parents === 0 ? '' : ` · +${parents} reply-chain${preview.toFetch > 0 ? ` (${preview.toFetch} via tg msg)` : ''}`
  return `${ids}${more} · ${buttons} buttons · ${media === 0 ? 'no media' : `${media} media`}${chain}`
}

/** What redaction masked, `original → placeholder`, on one line. */
function maskedText(redactions: readonly Redaction[]): string {
  if (redactions.length === 0) return 'masked: nothing in this selection'
  return `masked: ${redactions.map(one => `${one.original} → ${one.placeholder}`).join(' · ')}`
}

function IntentChip(
  { Button, Text }: Els,
  props: { intent: RouteIntent; onPress: () => void; hotkey?: string; id: string; isShort?: boolean },
): RenderElement {
  return (
    <Button key={props.id} plain hotkey={props.hotkey} onPress={props.onPress}>
      <Text dimColor>{props.isShort === true ? '' : 'intent: '}</Text>
      <Text color={TOKEN.accent} bold>{`[${intentLabel(props.intent)}]`}</Text>
    </Button>
  )
}

/** How a pin's `tg watch` stands: starting, live (nothing to say) or stopped and why. */
function watchMark(pin: Pin): string {
  switch (pin.watch.status) {
    case 'starting':
      return ` ${GLYPH.working}`
    case 'live':
      return ''
    case 'failed':
      return ` ${GLYPH.error} ${pin.watch.reason}`
  }
}

/** The packet tray: what is selected, where it goes, under which intent, masked or not. */
export function RoutedTray(els: Els, props: TrayProps): RenderElement {
  const { Box, Text, Button } = els
  const count = props.selection.ids.length
  const pinned = props.pin === null ? 'pin' : `${GLYPH.pinned} pinned → ${recipientLabel(props.pin.to)}${watchMark(props.pin)}`
  const send = (
    <Button key="send" variant="primary" onPress={props.onSend}>
      send
    </Button>
  )
  const routeChip = (
    <Button key="route" plain hotkey="a" onPress={props.onRoute}>
      <Text color={TOKEN.accent}>{routeLabel(props.route)}</Text>
    </Button>
  )
  const draft = props.draft === null ? null : DraftRow(els, { draft: props.draft, width: props.width, ...props.onDraft })
  if (props.size === 'line') {
    return (
      <Box flexDirection="column">
        {draft}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color={TOKEN.accent}>{`${count} selected`}</Text>
          {routeChip}
          {IntentChip(els, { intent: props.intent, onPress: props.onIntent, hotkey: 'i', id: 'intent', isShort: true })}
          {send}
          <Button key="whole" plain hotkey="d" dimColor onPress={props.onWhole}>
            all
          </Button>
          <Button key="clear" plain hotkey="c" dimColor onPress={props.onClear}>
            clear
          </Button>
          <Button key="pin" plain hotkey="p" dimColor={props.pin === null} onPress={props.onPin}>
            {props.pin === null ? 'pin' : GLYPH.pinned}
          </Button>
          <Button key="ledger" plain hotkey="l" dimColor onPress={props.onLedger}>
            ledger
          </Button>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {draft}
      <Text color={TOKEN.accent}>{`packet · ${count} msg`}</Text>
      <Text dimColor wrap="truncate-end">
        {summaryOf(props.preview)}
      </Text>
      <Box flexDirection="row" gap={2}>
        {routeChip}
        {IntentChip(els, { intent: props.intent, onPress: props.onIntent, hotkey: 'i', id: 'intent' })}
        <Button key="redact" plain onPress={props.onRedact}>
          <Text dimColor>redact: </Text>
          <Text color={props.isRedacted ? undefined : TOKEN.warn}>{props.isRedacted ? 'on' : 'off'}</Text>
        </Button>
        {props.isRedacted ? (
          <Button key="masked" plain dimColor onPress={props.onMask}>
            {props.isMaskShown ? 'hide masked' : `${props.preview.redactions.length} masked`}
          </Button>
        ) : null}
      </Box>
      {props.isRedacted && props.isMaskShown ? (
        <Text dimColor wrap="wrap">
          {maskedText(props.preview.redactions)}
        </Text>
      ) : null}
      <Box flexDirection="row" gap={2}>
        {send}
        <Button key="whole" plain hotkey="d" dimColor onPress={props.onWhole}>
          all
        </Button>
        <Button key="clear" plain hotkey="c" dimColor onPress={props.onClear}>
          clear
        </Button>
        <Button key="pin" plain hotkey="p" dimColor={props.pin === null} onPress={props.onPin}>
          {pinned}
        </Button>
        <Button key="ledger" plain hotkey="l" dimColor onPress={props.onLedger}>
          ledger
        </Button>
      </Box>
    </Box>
  )
}

/** The drafted reply: check (dry run, the WritePlan and the guard), then send, or drop. */
function DraftRow(
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
          : { text: `${GLYPH.error} the guard refuses: ${step.reason}. Run \`! tg allow add ${draft.peer.arg}\` if you trust it.`, color: TOKEN.danger }
      case 'sending':
        return { text: `${GLYPH.working} sending`, color: undefined }
      case 'sent':
        return { text: `${GLYPH.done} sent ${step.ids.map(id => `#${id}`).join(' ')}`, color: TOKEN.ok }
      case 'failed':
        return { text: `${GLYPH.error} ${step.reason}`, color: TOKEN.danger }
    }
  })()
  const isEditable = step.kind === 'draft' || step.kind === 'planned' || step.kind === 'failed'
  return (
    <Box key="draft" flexDirection="column">
      <Text color={TOKEN.accent} wrap="truncate-end">
        {head}
      </Text>
      {Input !== undefined && isEditable ? (
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
        <Button key="draft:drop" plain dimColor onPress={props.onDrop}>
          {step.kind === 'sent' ? 'close' : 'drop'}
        </Button>
      </Box>
    </Box>
  )
}

/** RoutePicker: main, live agents with their AgentChips, a new agent, broadcast. */
export function RoutePicker(
  els: Els,
  props: {
    count: number
    radar: readonly RadarEntry[]
    isMainBusy: boolean
    intent: RouteIntent
    width: number
    onMain: () => void
    onAgent: (agent: RadarEntry) => void
    onNew: () => void
    onBroadcast: () => void
    onIntent: () => void
    onClose: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const nameWidth = Math.max(8, Math.min(24, props.width - 34))
  const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
  let hotkey = 1
  const next = () => (hotkey <= 9 ? String(hotkey++) : undefined)
  return (
    <Box flexDirection="column">
      <Text color={TOKEN.accent} bold>{`send ${props.count} message${props.count === 1 ? '' : 's'} to`}</Text>
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
        {IntentChip(els, { intent: props.intent, onPress: props.onIntent, hotkey: 'i', id: 'picker:intent' })}
        <Button key="picker:close" plain hotkey="a" dimColor onPress={props.onClose}>
          close
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
    onBack: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const on = props.rows.filter(row => row.isOn).length
  return (
    <Box flexDirection="column">
      <Text color={TOKEN.accent} bold>{`broadcast ${props.count} message${props.count === 1 ? '' : 's'}: one packet, an intent per agent`}</Text>
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
          {`route to ${on}`}
        </Button>
        <Button key="broadcast:add" plain hotkey="0" dimColor onPress={props.onAdd}>
          + new agent
        </Button>
        <Button key="broadcast:back" plain hotkey="a" dimColor onPress={props.onBack}>
          back
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
    onClose: () => void
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
      <Box flexDirection="row" gap={2}>
        <Text dimColor>Enter jumps to the message</Text>
        <Button key="ledger:close" plain hotkey="l" dimColor onPress={props.onClose}>
          close
        </Button>
      </Box>
    </Box>
  )
}
