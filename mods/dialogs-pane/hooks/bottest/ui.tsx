// Bot-testing components (design §4 ButtonRow, §5 ideas 6–10), drawn like the pane's
// own: plain functions over the surface's element table, handlers as closures.
// Their keys (b n r f) are in ../ui/keys; the frame draws them.
import type { RenderElement } from 'claude-code'

import type { Button, MessageView } from '../packet/types'
import type { Els } from '../ui/components'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import { keyboardLines, type ReplyDiff } from './diff'
import { CHIP_GAP } from '../ui/thread'

/** The pane's chip address: `btn:<message>:<row>:<col>`; `b` moves the focus ring here. */
export function chipKey(messageId: number, button: Pick<Button, 'row' | 'col'>): string {
  return `btn:${messageId}:${button.row}:${button.col}`
}

/** Digits press the first nine chips of the cursor message (§3: only what is numbered on screen). */
export const MAX_DIGIT_CHIPS = 9

/**
 * A message's buttons as chips (§5.2, §8 T6). The cursor message's first nine
 * carry the digits that press them (`1: Retry  2: Back`); every other chip is
 * drawn in brackets (`[Settings] [Help]`), one space apart either way. Each chip
 * is one Button wherever the cursor is, so a move changes no ring stop above the
 * cursor row (§4.3 rule 1). The chips take their own width, so the stamp follows
 * one space after them; ./thread `chipsColumn` lines their left edges up on the
 * rows that carry them beside the text. Dim and marked `ro` where the pane will not press
 * (BotFather: a press explains). `isPressable` false (a chat with no presses, or
 * a layer holding the ring, rule 3): text, no stops.
 */
export function Chips(
  { Box, Button, Text }: Els,
  props: {
    message: MessageView
    labels: readonly (readonly string[])[]
    isDigits: boolean
    isPressable: boolean
    isReadOnly: boolean
    onChip: (button: Button) => void
  },
): RenderElement {
  const { message } = props
  const rows = message.buttons.filter(row => row.length > 0)
  let index = 0
  const items = rows.flatMap((row, rowIndex) => [
    ...(rowIndex === 0 ? [] : [<Text key={`sep:${message.id}:${rowIndex}`} dimColor>·</Text>]),
    ...row.map((button, col) => {
      const label = props.labels[rowIndex]?.[col] ?? button.text
      const digit = props.isDigits && index < MAX_DIGIT_CHIPS ? String(index + 1) : null
      index += 1
      const text = digit === null ? `[${label}]` : label
      if (!props.isPressable) {
        // A Box carries the chip's key, as a Text keeps none.
        return (
          <Box key={chipKey(message.id, button)}>
            <Text dimColor>{text}</Text>
          </Box>
        )
      }
      return (
        <Button key={chipKey(message.id, button)} plain hotkey={digit ?? undefined} dimColor={props.isReadOnly} onPress={() => props.onChip(button)}>
          {text}
        </Button>
      )
    }),
  ])
  return (
    <Box key={`chips:${message.id}`} flexDirection="row" columnGap={CHIP_GAP} flexShrink={0}>
      {...items}
      {props.isReadOnly ? <Text color={TOKEN.warn}>ro</Text> : null}
    </Box>
  )
}

/**
 * Recording stopped (§5.2, §8 T6): the recording is a test brief, not just a
 * file. It takes the action bar's place, four rows in the dock and two inline,
 * as the send sheet does: `1` hands it to an agent as a live test, `2` copies
 * the script's path, `d` discards it, ⏎ (its ringed Button) closes it.
 */
export function RecordedSheet(
  { Box, Button, Text }: Els,
  props: {
    seat: 'dock' | 'inline'
    width: number
    steps: number
    /** The script as the sheet names it, under the session's directory; null when it could not be written. */
    shown: string
    isWritten: boolean
    isFocused: boolean
    onHand: () => void
    onCopy: () => void
    onDiscard: () => void
    onOk: () => void
  },
): RenderElement {
  const dim = !props.isFocused
  const title = `recording stopped · ${props.steps} step${props.steps === 1 ? '' : 's'}`
  const where = props.isWritten ? `${props.shown} · git-ignored` : `${GLYPH.error} could not write ${props.shown}; 1 sends the steps alone`
  const discard = (
    <Button key="rec:discard" plain hotkey="d" dimColor={dim} onPress={props.onDiscard}>
      discard
    </Button>
  )
  const options = [
    <Button key="rec:hand" plain hotkey="1" dimColor={dim} onPress={props.onHand}>
      {props.seat === 'dock' ? 'hand to an agent as a live test' : 'hand to an agent'}
    </Button>,
    <Button key="rec:copy" plain hotkey="2" dimColor={dim} onPress={props.onCopy}>
      copy the path
    </Button>,
  ]
  const ok = (
    <Button key="rec:ok" plain autoFocus dimColor={dim} onPress={props.onOk}>
      ⏎ ok
    </Button>
  )
  if (props.seat === 'dock') {
    const rule = Math.max(1, props.width - title.length - 'd: discard'.length - 6)
    return (
      <Box key="rec:sheet" flexDirection="column">
        <Box flexDirection="row">
          <Text color={TOKEN.accent} dimColor>{`─ ${title} ${'─'.repeat(rule)} `}</Text>
          {discard}
          <Text color={TOKEN.accent} dimColor>
            {' ─'}
          </Text>
        </Box>
        <Text dimColor={props.isWritten} color={props.isWritten ? undefined : TOKEN.warn} wrap="truncate-end">
          {where}
        </Text>
        <Box flexDirection="row" columnGap={3}>
          {options}
        </Box>
        {ok}
      </Box>
    )
  }
  return (
    <Box key="rec:sheet" flexDirection="column">
      <Box flexDirection="row" columnGap={3}>
        <Text color={TOKEN.accent} wrap="truncate-end">{`${title} → ${props.isWritten ? props.shown : 'not written'}`}</Text>
        {discard}
      </Box>
      <Box flexDirection="row" columnGap={3}>
        {options}
        {ok}
      </Box>
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
      <Text color={TOKEN.accent} bold>{`diff #${diff.before} → #${diff.after} · f or h closes`}</Text>
      {...shown.map((line, index) => (
        <Text key={`diff:${index}`} color={OP_COLOR[line.op]} wrap="truncate-end">
          {oneLine(line.text, Math.max(10, props.width - 1))}
        </Text>
      ))}
    </Box>
  )
}
