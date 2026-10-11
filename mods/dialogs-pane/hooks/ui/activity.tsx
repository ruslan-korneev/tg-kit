// The dock's running strip, which carries the notices too (T4b), and Activity
// (docs/design/dialogs-pane-ux.md §5.6, §5.7), drawn from ./running. Plain functions over the surface's element
// table, as ./components draws; handlers come in as closures.
//
// The strip sits above the chat and the chats, and comes and goes as things
// start and stop, mostly while the cursor stays: it draws no ring stop, so the
// stops above the cursor row keep their count (§4.3 rule 1). Its `0: stop all`
// is a label; the `0` Button is the frame's hidden one, and the menu's.
import type { RenderElement } from 'claude-code'

import type { Notice } from '../../types'
import type { Els } from './components'
import { Divider } from './components'
import { GLYPH, TOKEN } from './model'
import { STOP_LABEL, STRIP_SEP, type LogRow, type LogTone, type StripItem } from './running'

const NOTICE_COLOR: Record<Notice['tone'], string | undefined> = { info: undefined, warn: TOKEN.warn, danger: TOKEN.danger }

/**
 * The dock's row under the header: a notice when there is one (a write's
 * result, `… pressing`, what `0` stopped, a draft that waits), else what runs;
 * `0: stop all` at the right while something runs, either way (T4b).
 */
export function RunningStrip({ Box, Text }: Els, props: { shown: readonly StripItem[]; more: number; notice: Notice | null; isRunning: boolean }): RenderElement {
  const left =
    props.notice !== null ? (
      <Box key="notice" flexShrink={1}>
        <Text color={NOTICE_COLOR[props.notice.tone]} wrap="truncate-end">
          {props.notice.text}
        </Text>
      </Box>
    ) : (
      <Text wrap="truncate-end">
        {...props.shown.map((item, index) => (
          <Text key={`running:${item.key}`} color={item.isHeld ? TOKEN.warn : undefined}>
            {`${index === 0 ? '' : STRIP_SEP}${item.text}`}
          </Text>
        ))}
        {props.more === 0 ? null : <Text dimColor>{` +${props.more}`}</Text>}
      </Text>
    )
  return (
    <Box key="running" flexDirection="row" justifyContent="space-between" columnGap={2}>
      {left}
      {props.isRunning ? (
        // The kill switch is the danger token's, key and all (§7.1): it is the one red thing the strip says.
        <Text color={TOKEN.danger}>{STOP_LABEL}</Text>
      ) : null}
    </Box>
  )
}

const LOG_COLOR: Record<LogTone, string | undefined> = { plain: undefined, ok: TOKEN.ok, warn: TOKEN.warn, danger: TOKEN.danger }

/**
 * Activity: what runs, one Button a chat (⏎ opens its card or its chat), the
 * chats watched, and the log, newest first. The log is Text: it grows in the
 * background, so as Buttons its rows would move under the ring.
 */
export function Activity(
  els: Els,
  props: {
    rows: readonly { id: number; text: string; isStopped: boolean }[]
    cursor: number
    watching: string | null
    log: readonly LogRow[]
    rowsLeft: number
    width: number
    onOpen: (index: number) => void
  },
): RenderElement {
  const { Box, Text, Button } = els
  const logRoom = Math.max(1, props.rowsLeft - 3 - props.rows.length - (props.watching === null ? 0 : 1))
  return (
    <Box key="activity" flexDirection="column">
      {Divider(els, { label: 'running', width: props.width })}
      {props.rows.length === 0 ? <Text dimColor>Nothing runs. a on a chat hands it to an agent; p follows it into main.</Text> : null}
      {...props.rows.map((row, index) => (
        <Button key={`act:${row.id}`} plain autoFocus={index === props.cursor ? true : undefined} dimColor={row.isStopped} onPress={() => props.onOpen(index)}>
          <Text color={TOKEN.accent}>{index === props.cursor ? `${GLYPH.cursor} ` : '  '}</Text>
          <Text>{row.text}</Text>
        </Button>
      ))}
      {props.watching === null ? null : (
        <Text dimColor wrap="truncate-end">
          {`  ◎  ${'watching'.padEnd(14)} ${props.watching}`}
        </Text>
      )}
      {Divider(els, { label: 'log', width: props.width })}
      {props.log.length === 0 ? <Text dimColor>Nothing yet: packets, bursts, drafts and hard stops show here.</Text> : null}
      {...props.log.slice(0, logRoom).map(row => (
        <Box key={row.key}>
          <Text color={LOG_COLOR[row.tone]} wrap="truncate-end">{`  ${row.text}`}</Text>
        </Box>
      ))}
    </Box>
  )
}
