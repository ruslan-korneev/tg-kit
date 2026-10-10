// Bot-testing components (design §4 ButtonRow, §5 ideas 6–10), drawn like the pane's
// own: plain functions over the surface's element table, handlers as closures.
import type { RenderElement } from 'claude-code'

import type { Notice, Recording, Timing } from '../../types'
import type { Button, MessageView } from '../packet/types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { keyboardLines, type ReplyDiff } from './diff'
import { chipLabel } from './keyboard'

/** The pane's chip address: `btn:<message>:<row>:<col>`; `b` moves the focus ring here. */
export function chipKey(messageId: number, button: Pick<Button, 'row' | 'col'>): string {
  return `btn:${messageId}:${button.row}:${button.col}`
}

/** Inline keyboards as pressable chips; dimmed and marked `ro` where the pane will not write. */
export function ChipRow(
  { Box, Button, Text }: Els,
  props: { message: MessageView; isReadOnly: boolean; width: number; onChip: (button: Button) => void },
): RenderElement {
  const { message } = props
  const count = message.buttons.flat().length
  // Indent(8), `ro`(3), and per chip its brackets(4) and gap(1): the labels share the rest.
  const room = Math.max(6, Math.floor((props.width - 11) / Math.max(1, count)) - 5)
  const chips = message.buttons.flatMap((row, index) => [
    ...(index === 0 ? [] : [<Text key={`sep:${message.id}:${index}`} dimColor>·</Text>]),
    ...row.map(button => (
      <Button key={chipKey(message.id, button)} dimColor={props.isReadOnly} onPress={() => props.onChip(button)}>
        {chipLabel(button, room)}
      </Button>
    )),
  ])
  return (
    <Box key={`chips:${message.id}`} flexDirection="row" gap={1}>
      <Text>{'       '}</Text>
      {...chips}
      {props.isReadOnly ? <Text color={TOKEN.warn}>ro</Text> : null}
    </Box>
  )
}

/** The bot-testing keys for an open thread, and what is running. */
export function BotBar(
  { Box, Button, Text }: Els,
  props: {
    recording: Recording | null
    busy: string | null
    watch: Timing['watch']
    onButtons: () => void
    onCompose: () => void
    onRecord: () => void
    onDiff: () => void
  },
): RenderElement {
  const status = props.busy !== null ? `${GLYPH.working} ${props.busy}` : props.watch === 'live' ? `${GLYPH.latency} live` : ''
  return (
    <Box key="bt:bar" flexDirection="row" gap={2}>
      <Button key="bt:buttons" plain hotkey="b" dimColor onPress={props.onButtons}>
        buttons
      </Button>
      <Button key="bt:compose" plain hotkey="n" dimColor onPress={props.onCompose}>
        send
      </Button>
      <Button key="bt:record" plain hotkey="r" dimColor onPress={props.onRecord}>
        {props.recording === null ? 'rec' : 'stop'}
      </Button>
      <Button key="bt:diff" plain hotkey="f" dimColor onPress={props.onDiff}>
        diff
      </Button>
      {props.recording === null ? null : <Text color={TOKEN.danger}>{`${GLYPH.unread} rec ${props.recording.steps.length}`}</Text>}
      <Text dimColor wrap="truncate-end">
        {status}
      </Text>
    </Box>
  )
}

const NOTICE_COLOR: Record<Notice['tone'], string | undefined> = { info: undefined, warn: TOKEN.warn, danger: TOKEN.danger }

export function NoticeRow({ Box, Text }: Els, props: { notice: Notice }): RenderElement {
  return (
    <Box key="bt:notice">
      <Text color={NOTICE_COLOR[props.notice.tone]} wrap="wrap">
        {props.notice.text}
      </Text>
    </Box>
  )
}

/** The one-line send box; null on a surface without an Input. */
export function SendBox(els: Els, props: { peer: string; onSend: (text: string) => void }): RenderElement | null {
  if (!('Input' in els)) return null
  const { Input } = els
  return <Input key="bt:send" label={`→ ${props.peer}`} placeholder="message to send" submitLabel="send" onSubmit={value => props.onSend(value)} />
}

const OP_COLOR = { same: undefined, del: TOKEN.danger, add: TOKEN.ok, change: TOKEN.warn } as const
const OP_MARK = { same: '  ', del: '- ', add: '+ ' } as const

/** The text diff, then the keyboard-shape diff, cut to `rows`. */
export function DiffView({ Box, Text }: Els, props: { diff: ReplyDiff; width: number; rows: number }): RenderElement {
  const { diff } = props
  const text = diff.text.map(line => ({ op: line.op, text: `${OP_MARK[line.op]}${line.text}` }))
  const lines = [...text, ...keyboardLines(diff)]
  const room = Math.max(2, props.rows - 1)
  const shown = lines.length > room ? [...lines.slice(0, room - 1), { op: 'same' as const, text: `… ${lines.length - room + 1} more lines` }] : lines
  return (
    <Box key="bt:diff-view" flexDirection="column">
      <Text color={TOKEN.accent} bold>{`diff #${diff.before} → #${diff.after} · f closes`}</Text>
      {...shown.map((line, index) => (
        <Text key={`diff:${index}`} color={OP_COLOR[line.op]} wrap="truncate-end">
          {oneLine(line.text, Math.max(10, props.width - 1))}
        </Text>
      ))}
    </Box>
  )
}
