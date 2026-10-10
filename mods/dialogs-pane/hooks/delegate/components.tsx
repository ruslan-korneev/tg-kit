// The delegate's components (docs/design/dialogs-pane.md §6 mockups): the
// grant and hard-stop rows of the autopilot card, the task card in the pane,
// its one-line form for Compact, and the band row of a hard stop waiting for
// your answer. Plain functions over the surface's element table.
import type { RenderElement } from 'claude-code'

import type { DgDialog, DgPending, DgTask } from '../../types'
import type { Els } from '../ui/components'
import { TOKEN, oneLine } from '../ui/model'
import { COMMANDS_LABEL, WEB_LABEL, durationText } from './grant'
import { untilText } from './skip'
import { cardLines, elapsedText, holdsOf, taskLine, type CardLine, type TaskView } from './task'

export type DelegateHandlers = {
  onWeb: () => void
  onCommands: () => void
  onRepos: (text: string) => void
  onDuration: (text: string) => void
  onSkip: (text: string) => void
  onConfirm: (text: string) => void
  onCancel: () => void
}

/** The one-time warning the card shows before delegate is picked for a dialog. */
export function warningText(label: string): string {
  return `⚡ delegate: whoever writes in ${label} steers an agent that has tools (your repos, the web). The grant limits what it can reach and the hard stops guard what cannot be undone, but use delegate only for contacts you trust, never a public group. Press 4 again to hand it over.`
}

function Label({ Box, Text }: Els, text: string): RenderElement {
  return (
    <Box width={10} flexShrink={0}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

function Field(els: Els, props: { id: string; label: string; value: string; placeholder: string; onSubmit: (text: string) => void }): RenderElement {
  const { Text } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (Input === undefined) return <Text>{`${props.label} ${props.value === '' ? props.placeholder : props.value}`}</Text>
  return <Input key={props.id} label={props.label} placeholder={props.placeholder} value={props.value} submitLabel="save" onSubmit={value => props.onSubmit(value)} />
}

/**
 * The card's delegate rows: web, commands, repos, duration, and the hard
 * stops; a skip waits for the dialog's name to be typed. w and c mean watch
 * and nothing in the pane (../ui/keys), so web and commands are pressed by
 * the ring until T3 turns them into Selects.
 */
export function DelegateRows(
  els: Els,
  props: { dg: DgDialog; label: string; noStops: string | null; pending: DgPending | null; now: number; guard: string | null } & DelegateHandlers,
): RenderElement {
  const { Box, Text, Button } = els
  const { grant, skip } = props.dg
  const skipText = skip === null || (skip.until !== null && skip.until <= props.now) ? null : `off: ${skip.stops.join(', ')} (${untilText(skip.until)})`
  return (
    <Box key="dg:rows" flexDirection="column">
      <Box flexDirection="row">
        {Label(els, 'guard:')}
        {props.guard === null ? <Text color={TOKEN.ok}>✓ dialogs-pane-guard answering</Text> : <Text color={TOKEN.danger} wrap="wrap">{`✗ ${props.guard}`}</Text>}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'web:')}
        <Button key="dg:web" plain onPress={props.onWeb}>
          {`${WEB_LABEL[grant.web]}`}
        </Button>
        <Text dimColor>{'  (off → read-only → full)'}</Text>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'commands:')}
        <Button key="dg:commands" plain onPress={props.onCommands}>
          {COMMANDS_LABEL[grant.commands]}
        </Button>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'repos:')}
        {Field(els, { id: 'dg:repos', label: 'paths', value: grant.repos.join(', '), placeholder: '~/code/app (a fresh worktree of each)', onSubmit: props.onRepos })}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'duration:')}
        {Field(els, { id: 'dg:duration', label: 'until', value: durationText(grant.duration), placeholder: 'done, or 2h / 90m', onSubmit: props.onDuration })}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'stops:')}
        <Box flexDirection="column">
          {skipText === null ? <Text color={TOKEN.ok}>on: money · publish · share · delete · commit-on-behalf</Text> : <Text color={TOKEN.danger} wrap="wrap">{skipText}</Text>}
          {props.noStops === null ? null : <Text color={TOKEN.danger} wrap="wrap">{props.noStops}</Text>}
          {props.pending === null ? (
            Field(els, { id: 'dg:skip', label: 'skip', value: '', placeholder: 'dangerouslySkipHardStops: all | publish,delete [24h|never]', onSubmit: props.onSkip })
          ) : (
            <Box flexDirection="column">
              <Text color={TOKEN.danger} wrap="wrap">{`Skip ${props.pending.skip.stops.join(', ')} for this dialog, ${untilText(props.pending.skip.until)}? Type "${props.label}" to confirm.`}</Text>
              <Box flexDirection="row" gap={2}>
                {Field(els, { id: 'dg:confirm', label: 'dialog name', value: '', placeholder: props.label, onSubmit: props.onConfirm })}
                <Button key="dg:cancel" plain dimColor onPress={props.onCancel}>
                  cancel
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

const TONE: Record<CardLine['tone'], { color?: string; dim: boolean }> = {
  ok: { color: TOKEN.ok, dim: false },
  dim: { dim: true },
  working: { color: TOKEN.accent, dim: false },
  stop: { color: TOKEN.warn, dim: false },
  danger: { color: TOKEN.danger, dim: false },
  plain: { dim: false },
}

/** The task card (design §6 mockup), in Wide: header, steps, the current action, hard stops, the last chat message. */
export function TaskCard(
  els: Els,
  props: { task: DgTask; view: TaskView; now: number; width: number; rows: number; noStops: string | null; onStop: () => void; onDismiss: () => void },
): RenderElement {
  const { Box, Text, Button } = els
  const { task } = props
  const isLive = task.status === 'starting' || task.status === 'working' || task.status === 'asking'
  const lines = cardLines(task, props.view, props.rows)
  const isHeld = isLive && holdsOf(task, props.view).length > 0
  return (
    <Box key={`dg:task:${task.id}`} flexDirection="column" borderStyle="round" borderColor={isHeld ? TOKEN.warn : TOKEN.accent} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={TOKEN.accent} bold wrap="truncate-end">{`⚡ ${task.peer.label} · ${oneLine(task.summary, Math.max(10, props.width - task.peer.label.length - 30))}`}</Text>
        <Box flexDirection="row" gap={2}>
          {props.noStops === null ? null : <Text color={TOKEN.danger}>{props.noStops}</Text>}
          <Text dimColor>{elapsedText(task.startedAt, props.now)}</Text>
          {isLive ? (
            <Button key={`dg:stop:${task.id}`} plain onPress={props.onStop}>
              <Text color={TOKEN.danger}>stop</Text>
            </Button>
          ) : (
            <Button key={`dg:dismiss:${task.id}`} plain dimColor onPress={props.onDismiss}>
              dismiss
            </Button>
          )}
        </Box>
      </Box>
      {...lines.map(line => (
        <Text key={`dg:line:${task.id}:${line.key}`} color={TONE[line.tone].color} dimColor={TONE[line.tone].dim} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** The task card's one line, for Compact. */
export function TaskRow({ Box, Text, Button }: Els, props: { task: DgTask; view: TaskView; noStops: string | null; onStop: () => void }): RenderElement {
  const { task } = props
  return (
    <Box key={`dg:row:${task.id}`} flexDirection="row" gap={1}>
      <Text color={holdsOf(task, props.view).length > 0 ? TOKEN.warn : TOKEN.accent} wrap="truncate-end">{taskLine(task, props.view)}</Text>
      {props.noStops === null ? null : <Text color={TOKEN.danger}>{props.noStops}</Text>}
      <Button key={`dg:row-stop:${task.id}`} plain onPress={props.onStop}>
        <Text color={TOKEN.danger}>stop</Text>
      </Button>
    </Box>
  )
}

/** A hard stop waiting in the engine's dialog, mirrored above the prompt. */
export function HoldBand({ Box, Text }: Els, props: { label: string; stops: readonly string[]; what: string; width: number }): RenderElement {
  return (
    <Box key="dg:band:hold" flexDirection="row" gap={2}>
      <Text color={TOKEN.warn} wrap="truncate-end">
        {`⏸ HARD STOP ${props.stops.join(' + ')}: ${oneLine(props.what, Math.max(20, props.width - 60))}? (answer in the dialog)`}
      </Text>
      <Text dimColor>{`⚡ ${props.label}`}</Text>
    </Box>
  )
}
