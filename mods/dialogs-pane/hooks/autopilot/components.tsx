// The autopilot's components (docs/design/dialogs-pane.md §6 mockups): the
// card that hands a dialog over, its ledger tab, the pane's autopilot row, and
// the band rows for a draft, an undoable auto reply and a `listen` summary.
// Plain functions over the surface's element table, as ../ui/components.tsx.
import type { RenderElement } from 'claude-code'

import type { ApDialog, ApDraft, ApEntry, ApLevel, ApNote, ApPhase, ApTopic, ApUndoWindow } from '../../types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { AP_LEVELS, AP_TOPICS, LEVEL_GLYPH, TOPIC_KEY, TOPIC_LABEL, quietText, rateText } from './config'
import { entryLines, undoLeft } from './ledger'

/** What the card says about allow.toml for the dialog. */
export type AllowView = { kind: 'loading' } | { kind: 'ok'; isAllowed: boolean } | { kind: 'error'; text: string }

export type CardHandlers = {
  onLevel: (level: ApLevel) => void
  onBrief: (field: keyof ApDialog['brief'], text: string) => void
  onRate: (by: 1 | -1) => void
  onRateText: (text: string) => void
  onGap: (by: 1 | -1) => void
  onConf: (by: 1 | -1) => void
  onTopic: (topic: ApTopic) => void
  onQuiet: () => void
  onQuietText: (text: string) => void
  onStart: () => void
  onEditBrief: () => void
  onLedger: () => void
  onClose: () => void
}

const PHASE_TEXT: Record<ApPhase, string> = {
  listening: 'listening',
  gathering: 'waiting for the burst to end',
  typing: 'they are typing',
  thinking: `${GLYPH.working}writing`,
  checking: `${GLYPH.working}checking before send`,
  sending: `${GLYPH.working}sending`,
}

/** The card's left column: fixed, so a long row wraps beside it instead of squeezing it. */
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

function allowText(allow: AllowView, arg: string): { text: string; color?: string } {
  switch (allow.kind) {
    case 'loading':
      return { text: `${GLYPH.working}reading tg allow list` }
    case 'error':
      return { text: `${GLYPH.error} ${allow.text}`, color: TOKEN.warn }
    case 'ok':
      return allow.isAllowed
        ? { text: `${GLYPH.done} in allow.toml`, color: TOKEN.ok }
        : { text: `not in allow.toml: auto and delegate need it. Run \`! tg allow add ${arg} --yes\` in the prompt`, color: TOKEN.warn }
  }
}

/** `autopilot · Contact A`: the level, the brief, the limits, quiet hours, escalation, the allowlist. */
export function AutopilotCard(
  els: Els,
  props: {
    dialog: ApDialog
    isRunning: boolean
    phase: ApPhase | undefined
    allow: AllowView
    notice: string | null
    width: number
    /** ── delegate ── the levels offered (delegate only for dialogs in allow.toml), and its rows under the limits. */
    levels: readonly ApLevel[]
    extra: RenderElement | null
  } & CardHandlers,
): RenderElement {
  const { Box, Text, Button } = els
  const { dialog } = props
  const allow = allowText(props.allow, dialog.peer.arg)
  const state = props.isRunning ? `${GLYPH.unread} running · ${PHASE_TEXT[props.phase ?? 'listening']}` : '○ stopped'
  return (
    <Box key="ap:card" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={TOKEN.accent} bold wrap="truncate-end">{`autopilot · ${dialog.peer.label}`}</Text>
        <Text color={props.isRunning ? TOKEN.ok : undefined} dimColor={!props.isRunning}>{state}</Text>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'level:')}
        <Box flexDirection="row" columnGap={2}>
          {...AP_LEVELS.flatMap((level, index) =>
            props.levels.includes(level)
              ? [
                  <Button key={`ap:level:${level}`} plain hotkey={String(index + 1)} dimColor={level !== dialog.level} onPress={() => props.onLevel(level)}>
                    {level === dialog.level ? <Text color={TOKEN.accent} bold>{`[${LEVEL_GLYPH[level]} ${level}]`}</Text> : `${LEVEL_GLYPH[level]} ${level}`}
                  </Button>,
                ]
              : [],
          )}
        </Box>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'brief:')}
        {Field(els, { id: 'ap:tone', label: 'tone', value: dialog.brief.tone, placeholder: 'short, friendly', onSubmit: text => props.onBrief('tone', text) })}
      </Box>
      <Box flexDirection="row">
        {Label(els, '')}
        {Field(els, { id: 'ap:promises', label: 'may promise', value: dialog.brief.promises, placeholder: 'nothing without asking me', onSubmit: text => props.onBrief('promises', text) })}
      </Box>
      <Box flexDirection="row">
        {Label(els, '')}
        {Field(els, { id: 'ap:facts', label: 'facts', value: dialog.brief.facts, placeholder: "I'm busy until 18:00", onSubmit: text => props.onBrief('facts', text) })}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'limits:')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="ap:rate:-" plain dimColor onPress={() => props.onRate(-1)}>-</Button>
          <Text>{rateText(dialog.perHour)}</Text>
          <Button key="ap:rate:+" plain dimColor onPress={() => props.onRate(1)}>+</Button>
          <Text dimColor>· 1 per burst, gap</Text>
          <Button key="ap:gap:-" plain dimColor onPress={() => props.onGap(-1)}>-</Button>
          <Text>{`${dialog.gapS}s`}</Text>
          <Button key="ap:gap:+" plain dimColor onPress={() => props.onGap(1)}>+</Button>
          <Text dimColor>· conf ≥</Text>
          <Button key="ap:conf:-" plain dimColor onPress={() => props.onConf(-1)}>-</Button>
          <Text>{dialog.threshold.toFixed(2)}</Text>
          <Button key="ap:conf:+" plain dimColor onPress={() => props.onConf(1)}>+</Button>
        </Box>
      </Box>
      <Box flexDirection="row">
        {Label(els, '')}
        {Field(els, { id: 'ap:rate', label: 'per hour', value: dialog.perHour === null ? '∞' : String(dialog.perHour), placeholder: '50, or ∞', onSubmit: props.onRateText })}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'quiet:')}
        <Box flexDirection="row" columnGap={2}>
          <Button key="ap:quiet" plain hotkey="t" onPress={props.onQuiet}>
            {dialog.quiet === null ? 'off' : 'on'}
          </Button>
          {Field(els, { id: 'ap:quiet:range', label: 'hours', value: quietText(dialog.quiet), placeholder: '22:00-08:00', onSubmit: props.onQuietText })}
        </Box>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'escalate:')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {AP_TOPICS.map(topic => {
            const isOn = dialog.topics.includes(topic)
            return (
              <Button key={`ap:topic:${topic}`} plain hotkey={TOPIC_KEY[topic]} dimColor={!isOn} onPress={() => props.onTopic(topic)}>
                {isOn ? <Text color={TOKEN.accent}>{TOPIC_LABEL[topic]}</Text> : <Text strikethrough>{TOPIC_LABEL[topic]}</Text>}
              </Button>
            )
          })}
        </Box>
      </Box>
      {props.extra}
      <Box flexDirection="row">
        {Label(els, 'allow:')}
        <Text color={allow.color} wrap="wrap">{allow.text}</Text>
      </Box>
      {props.notice === null ? null : (
        <Text color={TOKEN.warn} wrap="wrap">{props.notice}</Text>
      )}
      <Box flexDirection="row" gap={2}>
        <Button key="ap:start" plain hotkey="s" autoFocus onPress={props.onStart}>
          {props.isRunning ? '⏎ stop' : '⏎ start'}
        </Button>
        <Button key="ap:brief" plain hotkey="e" dimColor onPress={props.onEditBrief}>
          edit brief
        </Button>
        <Button key="ap:ledger" plain hotkey="l" dimColor onPress={props.onLedger}>
          ledger
        </Button>
        <Button key="ap:close" plain hotkey="q" dimColor onPress={props.onClose}>
          close
        </Button>
      </Box>
    </Box>
  )
}

/** The autopilot ledger tab: newest first, two lines a burst. */
export function AutopilotLedger(
  { Box, Text, Button }: Els,
  props: { ledger: readonly ApEntry[]; now: number; rows: number; width: number; onCard: (() => void) | null; onClose: () => void },
): RenderElement {
  const shown = [...props.ledger].reverse().slice(0, Math.max(1, Math.floor((props.rows - 2) / 2)))
  return (
    <Box key="ap:ledger" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={TOKEN.accent} bold>{`autopilot ledger · ${props.ledger.length} burst${props.ledger.length === 1 ? '' : 's'}`}</Text>
        <Box flexDirection="row" gap={2}>
          {props.onCard === null ? null : (
            <Button key="ap:ledger:card" plain hotkey="l" dimColor onPress={props.onCard}>
              card
            </Button>
          )}
          <Button key="ap:ledger:close" plain hotkey="q" dimColor onPress={props.onClose}>
            close
          </Button>
        </Box>
      </Box>
      {shown.length === 0 ? <Text dimColor>Nothing yet: a burst shows here once the autopilot handled it.</Text> : null}
      {...shown.map(entry => {
        const [head, tail] = entryLines(entry, props.now, props.width)
        const color = entry.outcome.kind === 'failed' ? TOKEN.danger : entry.outcome.kind === 'drafted' ? TOKEN.warn : undefined
        return (
          <Box key={`ap:entry:${entry.seq}`} flexDirection="column">
            <Text wrap="truncate-end">{head}</Text>
            <Text color={color} dimColor={color === undefined} wrap="truncate-end">{tail}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** The pane's autopilot row: q opens the card; what runs; undo; stop all (0). */
export function AutopilotRow(
  { Box, Text, Button }: Els,
  props: { running: number; drafts: number; undo: ApUndoWindow | null; now: number; onCard: () => void; onUndo: () => void; onStopAll: () => void },
): RenderElement {
  const left = undoLeft(props.undo, props.now)
  return (
    <Box key="ap:row" flexDirection="row" gap={2}>
      <Button key="ap:card-open" plain hotkey="q" dimColor onPress={props.onCard}>
        autopilot
      </Button>
      {props.running === 0 ? null : <Text color={TOKEN.accent}>{`${LEVEL_GLYPH.auto} ${props.running} on`}</Text>}
      {props.drafts === 0 ? null : <Text color={TOKEN.warn}>{`${LEVEL_GLYPH.draft} ${props.drafts} draft${props.drafts === 1 ? '' : 's'}`}</Text>}
      {left === 0 ? null : (
        <Button key="ap:undo" plain hotkey="u" onPress={props.onUndo}>
          {`undo ${left}s`}
        </Button>
      )}
      {props.running === 0 ? null : (
        // 0 is free in the pane: only the broadcast overlay draws it, and that replaces the pane.
        <Button key="ap:stop-all" plain hotkey="0" onPress={props.onStopAll}>
          <Text color={TOKEN.danger}>stop all</Text>
        </Button>
      )}
    </Box>
  )
}

/**
 * The band's line for a draft, and whether it shows the whole draft. Decision 9
 * (design doc §9): ⏎ sends only a draft the owner has read, so a draft cut short
 * by `oneLine` or by the band's width is opened first.
 */
export function draftLine(draft: Pick<ApDraft, 'peer' | 'incoming' | 'text'>, width: number): { body: string; isWhole: boolean } {
  const room = Math.max(12, Math.floor((width - draft.peer.label.length - 20) / 2))
  const shown = oneLine(draft.text, room)
  const body = `${draft.peer.label}: "${oneLine(draft.incoming, room)}"  → draft: "${shown}"`
  return { body, isWhole: shown === oneLine(draft.text, Infinity) && cells(`${LEVEL_GLYPH.draft} ${body}`) <= width }
}

/** Terminal cells, erring wide: CJK, Hangul and emoji take two; `truncate-end` cuts by cells. */
function cells(text: string): number {
  let count = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    count += (point >= 0x1100 && point <= 0x115f) || point >= 0x2e80 ? 2 : 1
  }
  return count
}

/**
 * A draft waiting for you (design §6 mockup); `e` swaps its second line for the
 * text field. Band keys reach it once the band holds them (ctrl+x tab), as the
 * triage band says too. ⏎ sends a draft shown whole; one cut short unfolds first.
 */
export function DraftBand(
  els: Els,
  props: {
    draft: ApDraft
    more: number
    width: number
    onSend: () => void
    onUnfold: () => void
    onEdit: () => void
    onSave: (text: string) => void
    onDrop: () => void
    onOpen: () => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { draft } = props
  const why = [...draft.reasons, ...(draft.confidence === null ? [] : [`conf ${draft.confidence.toFixed(2)}`])].join(' · ')
  const state = draft.state
  const line = draftLine(draft, props.width)
  const isUnfolded = state.kind === 'unfolded'
  // ⏎ sends what the band shows whole; a draft cut short opens first (decision 9).
  const canSend = line.isWhole || isUnfolded
  return (
    <Box key="ap:band:draft" flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={TOKEN.warn}>{`${LEVEL_GLYPH.draft} `}</Text>
        {line.body}
      </Text>
      {isUnfolded && !line.isWhole ? (
        <Text wrap="wrap">{draft.text}</Text>
      ) : null}
      {state.kind === 'editing' && Input !== undefined ? (
        <Input key="ap:draft:text" label="draft" value={draft.text} submitLabel="save" autoFocus onSubmit={value => props.onSave(value)} />
      ) : (
        <Box flexDirection="row" gap={2}>
          <Text dimColor wrap="truncate-end">{why === '' ? ' ' : `  ${why}`}</Text>
          {state.kind === 'sending' ? <Text dimColor>{`${GLYPH.working}sending`}</Text> : null}
          {state.kind === 'failed' ? <Text color={TOKEN.danger} wrap="truncate-end">{`${GLYPH.error} ${state.reason}`}</Text> : null}
          <Text dimColor>ctrl+x tab:</Text>
          <Button key="ap:draft:send" plain autoFocus onPress={canSend ? props.onSend : props.onUnfold}>
            {canSend ? '⏎ send' : '⏎ open'}
          </Button>
          <Button key="ap:draft:edit" plain hotkey="e" dimColor onPress={props.onEdit}>
            edit
          </Button>
          <Button key="ap:draft:drop" plain hotkey="x" dimColor onPress={props.onDrop}>
            drop
          </Button>
          <Button key="ap:draft:open" plain hotkey="o" dimColor onPress={props.onOpen}>
            open
          </Button>
          {props.more === 0 ? null : <Text dimColor>{`+${props.more} more`}</Text>}
        </Box>
      )}
    </Box>
  )
}

/** An auto reply that just went out, while `u` can still delete it. */
export function UndoBand(
  { Box, Text, Button }: Els,
  props: { undo: ApUndoWindow; now: number; onUndo: () => void; onDismiss: () => void },
): RenderElement {
  const { undo } = props
  const conf = undo.confidence === null ? '' : ` · conf ${undo.confidence.toFixed(2)}`
  return (
    <Box key="ap:band:undo" flexDirection="row" gap={2}>
      <Text wrap="truncate-end">
        <Text color={TOKEN.accent}>{`${LEVEL_GLYPH.auto} `}</Text>
        {`${undo.peer.label} replied "${oneLine(undo.text, 40)}"${conf}`}
      </Text>
      <Text dimColor>ctrl+x tab:</Text>
      <Button key="ap:band:undo-press" plain hotkey="u" autoFocus onPress={props.onUndo}>
        {`undo ${undoLeft(undo, props.now)}s`}
      </Button>
      <Button key="ap:band:undo-dismiss" plain hotkey="x" dimColor onPress={props.onDismiss}>
        dismiss
      </Button>
    </Box>
  )
}

/** A `listen` dialog's summary. */
export function NoteBand({ Box, Text, Button }: Els, props: { note: ApNote; width: number; onDismiss: () => void; onOpen: () => void }): RenderElement {
  return (
    <Box key="ap:band:note" flexDirection="row" gap={2}>
      <Text wrap="truncate-end">
        <Text color={TOKEN.accent}>{`${LEVEL_GLYPH.listen} `}</Text>
        {`${props.note.peer.label}: ${oneLine(props.note.text, Math.max(20, props.width - props.note.peer.label.length - 30))}`}
      </Text>
      <Text dimColor>ctrl+x tab:</Text>
      <Button key="ap:note:open" plain hotkey="o" dimColor onPress={props.onOpen}>
        open
      </Button>
      <Button key="ap:note:dismiss" plain hotkey="x" dimColor autoFocus onPress={props.onDismiss}>
        dismiss
      </Button>
    </Box>
  )
}
