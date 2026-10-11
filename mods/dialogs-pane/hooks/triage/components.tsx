// The triage pieces of the pane, plain functions over the surface's element
// table like ../ui/components: the watch mark, the summary block and the lens
// editor. Handlers come in as closures; their keys are in ../ui/keys.
import type { RenderElement } from 'claude-code'

import type { LensDraft, SavedLens, Summary, TgDialog, WatchHealth } from '../../types'
import { GLYPH, TOKEN, dialogGlyph, dialogLabel, oneLine } from '../ui/model'
import type { Els } from '../ui/components'
import { KIND_GROUP_NAMES, describeLens, hasGroup, type KindGroup } from './lenses'
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

/** Above a thread while `t` has run: the summary, or that it is coming, or why it failed. */
export function SummaryBlock({ Box, Text }: Els, props: { summary: Summary; width: number }): RenderElement {
  const { summary } = props
  const head =
    summary.status === 'loading'
      ? `${GLYPH.working} summarizing · t cancels`
      : summary.status === 'ok'
        ? `summary · ${summary.count} msgs · t hides`
        : `${GLYPH.error} ${summary.message} · t retries`
  return (
    <Box key="summary" flexDirection="column">
      <Text color={summary.status === 'error' ? TOKEN.danger : TOKEN.accent} dimColor={summary.status !== 'error'} wrap="truncate-end">
        {head}
      </Text>
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

/** Rows the summary block takes, so the thread below gets the rest. */
export function summaryRows(summary: Summary | null): number {
  if (summary === null) return 0
  return 1 + (summary.status === 'ok' ? summaryLines(summary.text).length : 0)
}

/**
 * The lens editor, in place of the dialog list: name, kinds, unread, query,
 * and the dialogs to pick (each row toggles). `z` saves; `h` (the frame's)
 * cancels.
 */
export function LensEditor(
  els: Els,
  props: {
    draft: LensDraft
    dialogs: readonly TgDialog[]
    rows: number
    onName: (name: string) => void
    onQuery: (query: string) => void
    onKind: (group: KindGroup) => void
    onUnread: () => void
    onPick: (dialogId: number) => void
    onSave: () => void
    onDelete: () => void
  },
): RenderElement {
  const { Box, Button, Text } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { lens } = props.draft
  const toggle = (key: string, label: string, isOn: boolean, onPress: () => void) =>
    isOn ? (
      <Button key={key} plain onPress={onPress}>
        <Text color={TOKEN.accent} bold>{`[${label}]`}</Text>
      </Button>
    ) : (
      <Button key={key} plain dimColor onPress={onPress}>
        {label}
      </Button>
    )
  // Chrome: title, name, kinds, query, actions: the picker gets what is left.
  const pickRows = Math.max(1, props.rows - 5)
  return (
    <Box key="lens-editor" flexDirection="column">
      <Text color={TOKEN.accent} wrap="truncate-end">
        {`lens · ${props.draft.isNew ? 'new' : lens.name} · ${describeLens(lens)}`}
      </Text>
      {Input === undefined ? (
        <Text dimColor>{`name: ${lens.name}`}</Text>
      ) : (
        <Input key="lens:name" label="name" value={lens.name} submitLabel="keep" onInput={value => props.onName(value)} onSubmit={value => props.onName(value)} />
      )}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>kinds:</Text>
        {KIND_GROUP_NAMES.map(group => toggle(`lens:kind:${group}`, group, hasGroup(lens, group), () => props.onKind(group)))}
        {toggle('lens:unread', 'unread only', lens.isUnreadOnly, props.onUnread)}
      </Box>
      {Input === undefined ? (
        <Text dimColor>{`query: ${lens.query}`}</Text>
      ) : (
        <Input key="lens:query" label="query" placeholder="title or @name" value={lens.query} submitLabel="keep" onInput={value => props.onQuery(value)} onSubmit={value => props.onQuery(value)} />
      )}
      {props.dialogs.slice(0, pickRows).map(dialog => {
        const isPicked = lens.dialogs.includes(dialog.id)
        const { glyph, color } = dialogGlyph(dialog.kind)
        return (
          <Button key={`pick:${dialog.id}`} plain onPress={() => props.onPick(dialog.id)}>
            <Text color={isPicked ? TOKEN.accent : undefined} dimColor={!isPicked}>
              {isPicked ? `${GLYPH.done} ` : '  '}
            </Text>
            <Text color={color}>{glyph} </Text>
            <Text dimColor={!isPicked}>{dialogLabel(dialog)}</Text>
          </Button>
        )
      })}
      <Box flexDirection="row" gap={2}>
        <Button key="lens:save" plain hotkey="z" onPress={props.onSave}>
          save
        </Button>
        {props.draft.isNew ? null : (
          <Button key="lens:delete" plain dimColor onPress={props.onDelete}>
            <Text color={TOKEN.danger}>delete</Text>
          </Button>
        )}
      </Box>
    </Box>
  )
}

/** The empty state of a saved lens: what it filters, and how to change it. */
export function EmptySavedLens({ Text }: Els, props: { lens: SavedLens }): RenderElement {
  return (
    <Text key="empty" dimColor wrap="wrap">
      {`No dialogs in ${props.lens.name} (${describeLens(props.lens)}). Press z to edit it, 1 for All.`}
    </Text>
  )
}
