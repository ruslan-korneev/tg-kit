// The triage pieces of the pane, plain functions over the surface's element
// table like ../ui/components: the watch mark and the summary block. Handlers come in as closures; their keys are in ../ui/keys.
import type { RenderElement } from 'claude-code'

import type { Summary, WatchHealth } from '../../types'
import { GLYPH, TOKEN, oneLine } from '../ui/model'
import type { Els } from '../ui/components'
import { summaryLines } from './summary'

export const WATCH_GLYPH = '◎'

/** The row mark for a watched dialog, colored by how its watch is doing. */
export function watchMark(health: WatchHealth | undefined): { text: string; color?: string } {
  switch (health) {
    case 'live':
      return { text: WATCH_GLYPH, color: TOKEN.accent }
    case 'retrying':
      return { text: WATCH_GLYPH, color: TOKEN.warn }
    case 'failed':
      return { text: WATCH_GLYPH, color: TOKEN.danger }
    case 'connecting':
    case undefined:
      return { text: WATCH_GLYPH }
  }
}

/** `t`'s summary as a layer (T4b): the summary, or that it is coming, or why it failed; its close Button holds the ring. */
export function SummaryBlock({ Box, Text, Button }: Els, props: { summary: Summary; width: number; onClose: () => void }): RenderElement {
  const { summary } = props
  const head =
    summary.status === 'loading'
      ? `${GLYPH.working} summarizing · t or h cancels`
      : summary.status === 'ok'
        ? `summary · ${summary.count} msgs · t or h closes`
        : `${GLYPH.error} ${summary.message} · t retries · h closes`
  return (
    <Box key="summary" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text color={summary.status === 'error' ? TOKEN.danger : TOKEN.accent} dimColor={summary.status !== 'error'} wrap="truncate-end">
          {head}
        </Text>
        <Button key="summary:close" plain dimColor onPress={props.onClose}>
          ⏎ close
        </Button>
      </Box>
      {summary.status === 'ok'
        ? summaryLines(summary.text).map((line, index) => (
            <Text key={`summary:${index}`} wrap="truncate-end">
              {oneLine(line, Math.max(10, props.width - 1))}
            </Text>
          ))
        : null}
    </Box>
  )
}
