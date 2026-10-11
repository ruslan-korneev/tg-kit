// The delegate's components (docs/design/dialogs-pane-ux.md §5.5): the card's
// warning and grant steps and the danger zone under `o`, the task card on top
// of its chat's thread, its one-line form inline, and the band row of a hard
// stop waiting for your answer. Plain functions over the surface's element table.
import type { RenderElement } from 'claude-code'

import type { DgDialog, DgGrant, DgPending, DgTask } from '../../types'
import { Label, Row, writesRows, type SelectChoice } from '../autopilot/components'
import type { AllowView } from '../autopilot/ladder'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { COMMANDS_LABEL, DG_WEB, WEB_LABEL, durationText } from './grant'
import { untilText } from './skip'
import { cardLines, elapsedText, holdsOf, taskLine, type CardLine, type TaskView } from './task'

/** The warning step (§5.5): once per chat, before the grant; the divider or the header names it. ⏎ is the bar's `I understand, set it up`. */
export function DelegateWarning({ Box, Text }: Els, props: { label: string }): RenderElement {
  return (
    <Box key="dg:warning" flexDirection="column">
      <Text wrap="wrap">
        {`Whoever writes in ${props.label} steers an agent that has tools: your repos (a fresh worktree per task) and the web. The grant limits what it reaches; hard stops ask you before anything that cannot be undone. Person chats only: in a group, every member could steer it.`}
      </Text>
    </Box>
  )
}

const DURATION_CHOICES: readonly string[] = ['done', '30m', '1h', '2h', '4h', '8h']

/** `until` as the Select offers it: the stored duration always among the choices. */
export function durationChoices(grant: DgGrant): SelectChoice[] {
  const current = grant.duration.kind === 'done' ? 'done' : durationText(grant.duration)
  const all = DURATION_CHOICES.includes(current) ? DURATION_CHOICES : [...DURATION_CHOICES, current]
  return all.map(value => ({ value, label: value === 'done' ? 'the task is done' : value }))
}

export function durationValue(grant: DgGrant): string {
  return grant.duration.kind === 'done' ? 'done' : durationText(grant.duration)
}

export type GrantHandlers = {
  onRepos: (text: string) => void
  onWeb: (value: string) => void
  onCommands: (value: string) => void
  onDuration: (value: string) => void
}

/**
 * The grant step (§5.5), filled from where the owner is: the repos field
 * (the session's repo when it has one; `e` rings it), web, commands and until
 * as Selects; then the hard stops, the guard and allow.toml. The fields are
 * always drawn, so the ring stops above the bar's ⏎ never change while it is up.
 */
export function DelegateGrant(
  els: Els,
  props: { dg: DgDialog; label: string; arg: string; sessionRepo: string | null; skipped: string | null; noStops: string | null; isGuardUp: boolean; guardText: string; allow: AllowView; notice: string | null } & GrantHandlers,
): RenderElement {
  const { Box, Text } = els
  const Select = 'Select' in els ? els.Select : undefined
  const Input = 'Input' in els ? els.Input : undefined
  const { grant } = props.dg
  const repos = grant.repos.join(', ')
  const isSessionRepo = props.sessionRepo !== null && grant.repos.length === 1 && grant.repos[0] === props.sessionRepo
  const select = (key: string, label: string, choices: SelectChoice[], value: string, onSelect: (value: string) => void) =>
    Select === undefined ? (
      <Text>{`${label} ${choices.find(one => one.value === value)?.label ?? value}`}</Text>
    ) : (
      <Select key={key} label={label} options={choices} value={value} onSelect={next => onSelect(next)} />
    )
  return (
    <Box key="dg:grant" flexDirection="column">
      <Box flexDirection="row">
        {Label(els, 'grant')}
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" columnGap={2}>
            {Input === undefined ? (
              <Text>{`repos ${repos}`}</Text>
            ) : (
              <Input key="dg:repos" label="repos" placeholder="~/code/app (a fresh worktree of each)" value={repos} submitLabel="save" onSubmit={value => props.onRepos(value)} />
            )}
            {isSessionRepo ? <Text dimColor>(this session's repo)</Text> : null}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {select('dg:web', 'web', DG_WEB.map(web => ({ value: web, label: WEB_LABEL[web] })), grant.web, props.onWeb)}
            {select('dg:commands', 'commands', (['checks', 'any'] as const).map(one => ({ value: one, label: COMMANDS_LABEL[one] })), grant.commands, props.onCommands)}
            {select('dg:duration', 'until', durationChoices(grant), durationValue(grant), props.onDuration)}
          </Box>
        </Box>
      </Box>
      {props.skipped === null
        ? Row(els, 'stops', 'ask you: money · publish · share · delete · commit-on-behalf')
        : Row(els, 'stops', props.skipped, TOKEN.danger)}
      {props.noStops === null ? null : Row(els, '', props.noStops, TOKEN.danger)}
      {props.isGuardUp ? Row(els, 'guard', `${GLYPH.done} dialogs-pane-guard answering`, TOKEN.ok) : Row(els, 'guard', `✗ ${props.guardText}`, TOKEN.danger)}
      {...writesRows(els, { label: props.label, arg: props.arg, rung: 'delegate', allow: props.allow })}
      {props.notice === null ? null : (
        <Text key="dg:notice" color={TOKEN.warn} wrap="wrap">
          {props.notice}
        </Text>
      )}
    </Box>
  )
}

/**
 * The danger zone under `o` (§5.5), person chats only: dangerouslySkipHardStops
 * for this chat, which waits for the chat's name typed exactly.
 */
export function DangerZone(els: Els, props: { dg: DgDialog; label: string; pending: DgPending | null; now: number; onSkip: (text: string) => void; onConfirm: (text: string) => void; onCancel: () => void }): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { skip } = props.dg
  const skipText = skip === null || (skip.until !== null && skip.until <= props.now) ? null : `off: ${skip.stops.join(', ')} (${untilText(skip.until)})`
  const field = (key: string, label: string, placeholder: string, onSubmit: (text: string) => void) =>
    Input === undefined ? <Text>{`${label} ${placeholder}`}</Text> : <Input key={key} label={label} placeholder={placeholder} value="" submitLabel="save" onSubmit={value => onSubmit(value)} />
  return (
    <Box key="dg:danger" flexDirection="row">
      {Label(els, 'danger')}
      <Box flexDirection="column" flexShrink={1}>
        {skipText === null ? <Text dimColor>every hard stop asks you</Text> : <Text color={TOKEN.danger} wrap="wrap">{skipText}</Text>}
        {props.pending === null ? (
          field('dg:skip', 'skip', 'dangerouslySkipHardStops: all | publish,delete [24h|never]', props.onSkip)
        ) : (
          <Box flexDirection="column">
            <Text color={TOKEN.danger} wrap="wrap">{`Skip ${props.pending.skip.stops.join(', ')} for this chat, ${untilText(props.pending.skip.until)}? Type "${props.label}" to confirm.`}</Text>
            <Box flexDirection="row" gap={2}>
              {field('dg:confirm', 'chat name', props.label, props.onConfirm)}
              <Button key="dg:cancel" plain dimColor onPress={props.onCancel}>
                cancel
              </Button>
            </Box>
          </Box>
        )}
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

/**
 * The task card on top of its chat's thread, drawn as dialogs-pane-ux.md §5.5
 * has it, without a border: a header, then at most `lines` of steps, the
 * current action, hard stops, the last chat message and how it ended. Text
 * only: it sits above the thread's cursor row, so it carries no ring stop
 * (§4.3 rule 1); `0` stops it, the agent card stops its chat, `d` in Activity
 * dismisses it once it ended.
 */
export function TaskCard(els: Els, props: { task: DgTask; view: TaskView; now: number; width: number; lines: number; noStops: string | null }): RenderElement {
  const { Box, Text } = els
  const { task } = props
  const isLive = task.status === 'starting' || task.status === 'working' || task.status === 'asking'
  const lines = fitLines(cardLines(task, props.view, props.lines), props.lines)
  const isHeld = isLive && holdsOf(task, props.view).length > 0
  return (
    <Box key={`dg:task:${task.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={isHeld ? TOKEN.warn : TOKEN.accent} bold wrap="truncate-end">{`↯ ${task.peer.label} · ${oneLine(task.summary, Math.max(10, props.width - task.peer.label.length - 30))}`}</Text>
        <Box flexDirection="row" gap={2} flexShrink={0}>
          {props.noStops === null ? null : <Text color={TOKEN.danger}>{props.noStops}</Text>}
          <Text dimColor>{elapsedText(task.startedAt, props.now)}</Text>
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

/** Lines a docked chat's task card gets, from the lower part's height: at most 6, and a third of it with its header. */
export function chatCardLines(lower: number): number {
  return Math.min(6, Math.floor(lower / 3) - 1)
}

/** Rows a chat's task takes: the card's header and its lines, or one TaskRow when fewer than 2 lines fit. */
export function chatTaskRows(lines: number): number {
  return lines < 2 ? 1 : 1 + lines
}

/** At most `max` lines: the oldest steps go first, then the worktrees, then the oldest of the rest. */
export function fitLines(lines: readonly CardLine[], max: number): CardLine[] {
  const kept = [...lines]
  for (const prefix of ['step:', 'wt:']) {
    while (kept.length > max) {
      const index = kept.findIndex(line => line.key.startsWith(prefix))
      if (index === -1) break
      kept.splice(index, 1)
    }
  }
  return kept.slice(-Math.max(0, max))
}

/** The task's one line on top of its chat's thread, inline: Text, as the card. */
export function TaskRow({ Box, Text }: Els, props: { task: DgTask; view: TaskView; noStops: string | null }): RenderElement {
  const { task } = props
  return (
    <Box key={`dg:row:${task.id}`} flexDirection="row" gap={1}>
      <Text color={holdsOf(task, props.view).length > 0 ? TOKEN.warn : TOKEN.accent} wrap="truncate-end">{taskLine(task, props.view)}</Text>
      {props.noStops === null ? null : <Text color={TOKEN.danger}>{props.noStops}</Text>}
    </Box>
  )
}
