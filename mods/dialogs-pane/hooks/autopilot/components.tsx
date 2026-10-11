// The agent card (docs/design/dialogs-pane-ux.md §5.4, §7.3): the ladder of
// rungs that fit the chat, each on its digit, with only the picked rung's
// essentials under it; and `o`'s options (limits, quiet hours, topics on
// digits, the brief). Plain functions over the surface's element table, as
// ../ui/components.tsx. The card is a layer over the lower part (dock) or the
// body (inline); its ⏎ is the bar's (../ui/keys), so the rows under the ladder
// are text: picking a rung never changes the ring stops above the bar (§4.3).
// delegate's warning, grant and danger zone are ../delegate/components'.
import type { RenderElement } from 'claude-code'

import type { ApDialog, ApPhase, ApRung, ApTopic } from '../../types'
import type { Els } from '../ui/components'
import type { ChatKind } from '../ui/keys'
import { GLYPH, TOKEN } from '../ui/model'
import { AP_TOPICS, TOPIC_LABEL, clockText, quietText, rateText } from './config'
import { RUNG_GLYPH, RUNG_NAME, allowCommand, readOnlyKindText, rungBlock, rungDigit, rungWhat, type AllowView } from './ladder'

/** §7.3: cards align their labels in a 7-column left column (brief, limits, asks, writes, grant, stops, guard). */
export const LABEL_COLUMN = 7

export function Label({ Box, Text }: Els, text: string): RenderElement {
  return (
    <Box width={LABEL_COLUMN} flexShrink={0}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

/** A labelled row of the card; its text wraps beside the label column. */
export function Row(els: Els, label: string, text: string, color?: string): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={`ap:row:${label}:${text.slice(0, 12)}`} flexDirection="row">
      {Label(els, label)}
      <Text color={color} dimColor={color === undefined} wrap="wrap">
        {text}
      </Text>
    </Box>
  )
}

const PHASE_TEXT: Record<ApPhase, string> = {
  listening: 'listening',
  gathering: 'waiting for the burst to end',
  typing: 'they are typing',
  thinking: `${GLYPH.working}writing`,
  checking: `${GLYPH.working}checking before send`,
  sending: `${GLYPH.working}sending`,
}

/** The header's chip for the card's chat: `○ off`, or `● draft · listening` while a rung runs. */
export function cardChip(running: ApRung | null, phase: ApPhase | undefined): { text: string; color?: string } {
  if (running === null) return { text: '○ off' }
  return { text: `${GLYPH.unread} ${RUNG_NAME[running]}${running === 'follow' ? '' : ` · ${PHASE_TEXT[phase ?? 'listening']}`}`, color: TOKEN.ok }
}

/** `writes` for a rung that sends alone: in allow.toml, how ⏎ puts it there, or why the allowlist could not be read. */
export function writesRows(els: Els, props: { label: string; arg: string; rung: ApRung; allow: AllowView }): RenderElement[] {
  const { rung, allow } = props
  switch (allow.kind) {
    case 'loading':
      return [Row(els, 'writes', `${GLYPH.working}reading tg allow list`)]
    case 'error':
      // §7.4's error state: one red line and `g: retry`; never "must be in allow.toml" for a read that failed.
      return [Row(els, 'writes', `${GLYPH.error} could not read allow.toml · g: retry`, TOKEN.danger), Row(els, '', allow.text)]
    case 'ok':
      return allow.isAllowed
        ? [Row(els, 'writes', `${GLYPH.done} in allow.toml`, TOKEN.ok)]
        : [
            Row(els, 'writes', `✗ ${props.label} is not in allow.toml, and ${RUNG_NAME[rung]} sends alone`, TOKEN.warn),
            Row(els, '', `⏎ puts  ${allowCommand(props.arg)}  in your prompt`),
            Row(els, '', '(Esc, then Enter runs it; this card notices)'),
          ]
  }
}

function briefText(dialog: ApDialog): string {
  const { tone, promises, facts } = dialog.brief
  const parts = [...(tone === '' ? [] : [`tone: ${tone}`]), ...(promises === '' ? [] : [`may promise: ${promises}`]), ...(facts === '' ? [] : [`facts: ${facts}`])]
  return parts.length === 0 ? 'none yet · e: write one (tone, promises, facts)' : `${parts.join(' · ')}   e: edit`
}

function asksText(dialog: ApDialog): string {
  return dialog.topics.length === 0 ? 'nothing: every reply within the limits may go out' : dialog.topics.map(topic => TOPIC_LABEL[topic]).join(' · ')
}

/** `50/h · one per burst · gap 20 s · conf ≥ 0.80`, and quiet hours when on. */
export function limitsText(dialog: ApDialog): string {
  const quiet = dialog.quiet === null ? '' : ` · quiet ${quietText(dialog.quiet)}`
  return `${rateText(dialog.perHour)} · one per burst · gap ${dialog.gapS} s · conf ≥ ${dialog.threshold.toFixed(2)}${quiet}`
}

/** Under the ladder, only what matters for the rung picked (§5.4); the rest is behind `o`. */
function essentials(els: Els, props: LadderProps): RenderElement[] {
  const { dialog, pick } = props
  switch (pick) {
    case 'follow':
      return [Row(els, 'to', `${props.followTo} · p in the chat does the same`)]
    case 'listen':
      return [Row(els, 'writes', 'never: each burst becomes a summary in the band')]
    case 'draft':
      return [Row(els, 'brief', briefText(dialog)), Row(els, 'asks', asksText(dialog)), Row(els, 'writes', `${GLYPH.done} you send each draft with ⏎ on its row: no allow.toml needed`, TOKEN.ok)]
    case 'auto':
      return [Row(els, 'limits', `${limitsText(dialog)}   o: change`), Row(els, 'asks', asksText(dialog)), ...writesRows(els, { label: dialog.peer.label, arg: dialog.peer.arg, rung: pick, allow: props.allow })]
    case 'delegate':
      return [
        ...writesRows(els, { label: dialog.peer.label, arg: dialog.peer.arg, rung: pick, allow: props.allow }),
        props.isGuardUp ? Row(els, 'guard', `${GLYPH.done} dialogs-pane-guard answering`, TOKEN.ok) : Row(els, 'guard', '✗ dialogs-pane-guard is not loaded or not answering: it holds the Worker’s hard stops', TOKEN.danger),
      ]
  }
}

type LadderProps = {
  dialog: ApDialog
  kind: ChatKind
  ladder: readonly ApRung[]
  pick: ApRung
  running: ApRung | null
  allow: AllowView
  isGuardUp: boolean
  /** Where a follow sends the chat's messages: `main, every turn`, or the agent the route names. */
  followTo: string
  notice: string | null
  onPick: (rung: ApRung) => void
}

/**
 * The ladder (§5.4): every rung that fits the chat, on its own digit; the one
 * picked marked ▸, one that cannot start now dim with why, the one that runs
 * `● on`. A digit (or a click) picks; the bar's ⏎ starts or stops.
 */
export function CardLadder(els: Els, props: LadderProps): RenderElement {
  const { Box, Text, Button } = els
  const note = readOnlyKindText(props.kind)
  return (
    <Box key="ap:card" flexDirection="column">
      {...props.ladder.map(rung => {
        const isPick = rung === props.pick
        const block = rungBlock(rung, props.allow, props.isGuardUp)
        const head = `${rungDigit(rung)}: ${RUNG_GLYPH[rung]} ${RUNG_NAME[rung].padEnd(10)}`
        return (
          <Button key={`ap:level:${rung}`} plain hotkey={rungDigit(rung)} onPress={() => props.onPick(rung)}>
            <Text color={TOKEN.accent}>{isPick ? `${GLYPH.cursor} ` : '  '}</Text>
            <Text color={isPick ? TOKEN.accent : undefined} bold={isPick} dimColor={!isPick && block !== null}>
              {head}
            </Text>
            <Text dimColor wrap="truncate-end">
              {` ${rungWhat(rung, props.kind)}${block === null ? '' : ` · ${block}`}`}
            </Text>
            {rung === props.running ? <Text color={TOKEN.ok}>{`  ${GLYPH.unread} on`}</Text> : null}
          </Button>
        )
      })}
      {...essentials(els, props)}
      {note === null ? null : (
        <Text key="ap:kind" dimColor wrap="wrap">
          {note}
        </Text>
      )}
      {props.notice === null ? null : (
        <Text key="ap:notice" color={TOKEN.warn} wrap="wrap">
          {props.notice}
        </Text>
      )}
    </Box>
  )
}

// --- `o`: options ---

/** Replies per hour, the burst gap, the confidence and quiet hours, as the Selects offer them; the stored value always among them. */
const RATE_CHOICES: readonly (number | null)[] = [5, 10, 20, 50, 100, 200, null]
const GAP_CHOICES: readonly number[] = [5, 10, 15, 20, 30, 45, 60, 120]
const CONF_CHOICES: readonly number[] = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
const QUIET_CHOICES: readonly ({ from: number; to: number } | null)[] = [null, { from: 22 * 60, to: 8 * 60 }, { from: 23 * 60, to: 7 * 60 }, { from: 0, to: 9 * 60 }, { from: 21 * 60, to: 9 * 60 }]

export type SelectChoice = { value: string; label: string }

/** A Select's choices with `current` among them, in order, once. */
function withCurrent<T>(choices: readonly T[], current: T, key: (one: T) => string, label: (one: T) => string): SelectChoice[] {
  const all = choices.some(one => key(one) === key(current)) ? choices : [...choices, current]
  return all.map(one => ({ value: key(one), label: label(one) }))
}

export const rateKey = (perHour: number | null) => (perHour === null ? 'none' : String(perHour))
export const quietKey = (quiet: ApDialog['quiet']) => (quiet === null ? 'off' : `${clockText(quiet.from)}-${clockText(quiet.to)}`)

export function rateChoices(current: number | null): SelectChoice[] {
  return withCurrent(RATE_CHOICES, current, rateKey, one => `${rateText(one)} replies`)
}
export function gapChoices(current: number): SelectChoice[] {
  return withCurrent(GAP_CHOICES, current, String, one => `gap ${one} s`)
}
export function confChoices(current: number): SelectChoice[] {
  return withCurrent(CONF_CHOICES, current, one => one.toFixed(2), one => `conf ≥ ${one.toFixed(2)}`)
}
export function quietChoices(current: ApDialog['quiet']): SelectChoice[] {
  return withCurrent(QUIET_CHOICES, current, quietKey, one => (one === null ? 'off' : quietText(one)))
}

export type OptionHandlers = {
  onRate: (value: string) => void
  onGap: (value: string) => void
  onConf: (value: string) => void
  onQuiet: (value: string) => void
  onTopic: (topic: ApTopic) => void
  onBrief: (field: keyof ApDialog['brief'], text: string) => void
}

/**
 * `o` on the card (§5.4): limits and quiet hours as Selects, the escalation
 * topics on digits (each toggles), the brief as fields; delegate's danger
 * zone (`extra`) after them. The ring starts on the first Select.
 */
export function CardOptions(els: Els, props: { dialog: ApDialog; notice: string | null; extra: RenderElement | null } & OptionHandlers): RenderElement {
  const { Box, Text, Button } = els
  const Select = 'Select' in els ? els.Select : undefined
  const Input = 'Input' in els ? els.Input : undefined
  const { dialog } = props
  const select = (key: string, choices: SelectChoice[], value: string, onSelect: (value: string) => void) =>
    Select === undefined ? <Text>{choices.find(one => one.value === value)?.label ?? value}</Text> : <Select key={key} options={choices} value={value} onSelect={next => onSelect(next)} />
  const field = (key: keyof ApDialog['brief'], label: string, placeholder: string) =>
    Input === undefined ? (
      <Text>{`${label} ${dialog.brief[key] === '' ? placeholder : dialog.brief[key]}`}</Text>
    ) : (
      <Input key={`ap:${key}`} label={label} placeholder={placeholder} value={dialog.brief[key]} submitLabel="save" onSubmit={value => props.onBrief(key, value)} />
    )
  return (
    <Box key="ap:options" flexDirection="column">
      <Box flexDirection="row">
        {Label(els, 'limits')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {select('ap:rate', rateChoices(dialog.perHour), rateKey(dialog.perHour), props.onRate)}
          {select('ap:gap', gapChoices(dialog.gapS), String(dialog.gapS), props.onGap)}
          {select('ap:conf', confChoices(dialog.threshold), dialog.threshold.toFixed(2), props.onConf)}
        </Box>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'quiet')}
        {select('ap:quiet', quietChoices(dialog.quiet), quietKey(dialog.quiet), props.onQuiet)}
      </Box>
      <Box flexDirection="row">
        {Label(els, 'asks')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {AP_TOPICS.map((topic, index) => {
            const isOn = dialog.topics.includes(topic)
            return (
              <Button key={`ap:topic:${topic}`} plain hotkey={String(index + 1)} dimColor={!isOn} onPress={() => props.onTopic(topic)}>
                {isOn ? <Text color={TOKEN.accent}>{TOPIC_LABEL[topic]}</Text> : <Text strikethrough>{TOPIC_LABEL[topic]}</Text>}
              </Button>
            )
          })}
        </Box>
      </Box>
      <Box flexDirection="row">
        {Label(els, 'brief')}
        <Box flexDirection="column">
          {field('tone', 'tone', 'short, friendly')}
          {field('promises', 'may promise', 'nothing without asking me')}
          {field('facts', 'facts', "I'm busy until 18:00")}
        </Box>
      </Box>
      {props.extra}
      {props.notice === null ? null : (
        <Text key="ap:notice" color={TOKEN.warn} wrap="wrap">
          {props.notice}
        </Text>
      )}
    </Box>
  )
}
