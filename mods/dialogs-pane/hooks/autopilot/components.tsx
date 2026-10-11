// The autopilot's components (docs/design/dialogs-pane.md §6 mockups): the
// card that hands a dialog over (the band's items are ../ui/band's). Plain functions over
// the surface's element table, as ../ui/components.tsx. Their letters are
// ../ui/keys' (one meaning each, the band's included); the card's digits pick
// a level, and its other controls are reached by the ring until T3.
import type { RenderElement } from 'claude-code'

import type { ApDialog, ApLevel, ApPhase, ApTopic } from '../../types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN } from '../ui/model'
import { AP_LEVELS, AP_TOPICS, LEVEL_GLYPH, TOPIC_LABEL, quietText, rateText } from './config'

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
          <Button key="ap:quiet" plain onPress={props.onQuiet}>
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
              <Button key={`ap:topic:${topic}`} plain dimColor={!isOn} onPress={() => props.onTopic(topic)}>
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
    </Box>
  )
}
