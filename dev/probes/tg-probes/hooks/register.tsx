// T11 engine probes (docs/design/dialogs-pane-ux.md §10.11, results in §1). Not shipped: kept to re-run
// after an engine upgrade. Load it in a lab session (Appendix A): claude --plugin-dir dev/probes/tg-probes,
// then /probe <view> opens the pane on one view and /probe-card on|off toggles the AbovePrompt card.
// Read the result with `tmux capture-pane -e -p`: colours are the escapes the engine wrote.
import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { ProbeView } from '../types'

const PANE = 'tg-probes'
const view = atom({ plugin: 'tg-probes', key: 'view' } as const, 'all' as ProbeView)
const card = atom({ plugin: 'tg-probes', key: 'card' } as const, false)
const presses = atom({ plugin: 'tg-probes', key: 'presses' } as const, [] as string[])
const cardRow = atom({ plugin: 'tg-probes', key: 'cardRow' } as const, 0)

const MAUVE = '#CBA6F7'
const GREEN = '#A6E3A1'
const SURFACE = '#45475A'
// §10.2's mocha column, in role order: accent unread mention held/saved ok person group channel bot dim subtext text surface.
const MOCHA = [['ac', '#CBA6F7'], ['un', '#F38BA8'], ['me', '#FAB387'], ['he', '#F9E2AF'], ['ok', '#A6E3A1'], ['pe', '#89B4FA'],
  ['gr', '#94E2D5'], ['ch', '#89DCEB'], ['bo', '#F5C2E7'], ['di', '#6C7086'], ['su', '#A6ADC8'], ['tx', '#CDD6F4'], ['sf', '#45475A'], ['ma', '#EBA0AC']] as const
// The 256-cell variant asked for after P7. The engine's downsample is 16 + 36r + 6g + b with each channel round(v / 51),
// so peach, yellow, blue, sky and red move to hex that rounds onto cells of their own: 216 229 111 117 211 (maroon stays 217).
const MOCHA256 = [['me', '#FAAF7A'], ['he', '#F9E6AF'], ['pe', '#7AAFFA'], ['ch', '#7ADCEB'], ['un', '#F37AA8'], ['ma', '#EBA0AC']] as const
// Every 16-colour name, to see which stay apart at 16 colours.
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright', 'gray'] as const
const VIEWS: readonly ProbeView[] = ['all', 'p2', 'p4hex', 'p4theme', 'p4fill', 'p6', 'p6unknown', 'p6status']

// The ten keys §10.2 already uses, the rest of ThemeKey, then keys a Claude Code theme may hold beyond the typed list.
const TYPED = ['claude', 'suggestion', 'success', 'permission', 'merged', 'warning', 'error', 'inactive', 'subtle', 'text',
  'inverseText', 'remember', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide',
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord']
const EXTRA = ['fastMode', 'rate_limit_fill', 'rate_limit_empty', 'professionalBlue', 'chromeYellow', 'clawd_body',
  'briefLabelYou', 'briefLabelClaude', 'selectionBg', 'userMessageBackground', 'secondaryText', 'secondaryBorder',
  'claudeShimmer', 'warningShimmer', 'permissionShimmer', 'background',
  'red_FOR_SUBAGENTS_ONLY', 'blue_FOR_SUBAGENTS_ONLY', 'green_FOR_SUBAGENTS_ONLY', 'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY', 'orange_FOR_SUBAGENTS_ONLY', 'pink_FOR_SUBAGENTS_ONLY', 'cyan_FOR_SUBAGENTS_ONLY']

const log = (who: string) => (list: string[]) => [...list, who].slice(-6)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: `T11: open the probe pane on a view (${VIEWS.join(' ')})` })
    await $.command.register({ name: 'probe-card', description: 'T11: the AbovePrompt card on or off' })
    return next(e)
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    const want = (e.args.trim() || 'all') as ProbeView
    if (!VIEWS.includes(want)) return { text: `views: ${VIEWS.join(' ')}` }
    await update($, view, () => want)
    $.ui.status(want === 'p6status' ? 'tg: 15 unread · @2 · autopilot 12/50' : undefined)
    const opened = await $.ui.open({ id: PANE, title: 'probes' })
    return { text: `probe view ${want}: ${opened.isPlaced ? 'placed' : 'not placed'}` }
  })

  on('command.run', { command: 'probe-card' }, async ($, e) => {
    const isOn = e.args.trim() !== 'off'
    await update($, card, () => isOn)
    return { text: `probe card ${isOn ? 'on' : 'off'}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const pressed = await read($, presses)
    const focused = e.props.isFocused
    const w = Math.min(44, e.props.bodyColumns)
    const press = (k: string) => () => void update($, presses, log(k))

    // P2: a title line as Text joined to a Box with no top border.
    // borderTop={false} is refused by the engine (`Box prop "borderTop" is not allowed`), so the probe now
    // tries the other join: a full round border with the title and the corner absolutely placed over its top edge.
    const titled = (title: string, color: string, rows: RenderElement[], corner?: string) => (
      <Box flexDirection="column" width={w}>
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={w}>
          {rows}
        </Box>
        <Box position="absolute" top={0} left={2}>
          <Text color={color} bold>{` ${title} `}</Text>
        </Box>
        {corner === undefined ? null : (
          <Box position="absolute" top={0} right={2}>
            <Text dimColor>{` ${corner} `}</Text>
          </Box>
        )}
      </Box>
    )
    // P2 fallback: every side drawn as Text.
    const sides = (title: string, color: string, lines: string[]) => {
      const inner = w - 4
      return (
        <Box flexDirection="column">
          <Text color={color}>{`╭─ ${title} ${'─'.repeat(Math.max(0, w - title.length - 5))}╮`}</Text>
          {lines.map(l => (
            <Text>
              <Text color={color}>│ </Text>
              {l.padEnd(inner).slice(0, inner)}
              <Text color={color}> │</Text>
            </Text>
          ))}
          <Text color={color}>{`╰${'─'.repeat(w - 2)}╯`}</Text>
        </Box>
      )
    }

    // P8: `ctrl+x tab: keys` text, then plain hotkey Buttons, dim without the keys.
    const keyLine = (
      <Box key="keyline" flexDirection="row" columnGap={2}>
        {focused ? null : <Text dimColor>ctrl+x tab: keys</Text>}
        <Button key="k:open" plain dimColor={!focused} onPress={press('enter')}>⏎ open</Button>
        <Button key="k:j" plain hotkey="j" dimColor={!focused} onPress={press('j')}>down</Button>
        <Button key="k:w" plain hotkey="w" dimColor={!focused} onPress={press('w')}>watch</Button>
        <Button key="k:m" plain hotkey="m" dimColor={!focused} onPress={press('m')}>menu</Button>
      </Box>
    )
    const status = <Text dimColor>{`view ${v} · focused ${focused} · ${e.props.placement} · cols ${e.props.bodyColumns} · presses ${pressed.join(',') || '-'}`}</Text>

    if (v === 'p2')
      return (
        <Box flexDirection="column">
          {status}
          {titled('FOR YOU · 2', '#FAB387', [<Text>row one</Text>, <Text>row two</Text>], 'y: all')}
          {titled('CHATS', 'permission', [<Text>theme key permission</Text>])}
          {sides('AUTOPILOT', GREEN, ['sides as Text', 'second line'])}
          {keyLine}
        </Box>
      )
    if (v === 'p4hex' || v === 'p4theme' || v === 'p4fill')
      return (
        <Box flexDirection="column" backgroundColor={v === 'p4theme' ? 'background' : '#1E1E2E'} height={v === 'p4fill' ? e.props.scroll.bodyRows : undefined} width="100%">
          {status}
          <Text>P4 root backgroundColor {v}</Text>
          {keyLine}
        </Box>
      )
    if (v === 'p6' || v === 'p6unknown')
      return (
        <Box flexDirection="column">
          {status}
          {(v === 'p6' ? [...TYPED, ...EXTRA] : ['nopeNotAKey', 'merged', 'yellow_FOR_SUBAGENTS_ONLY', 'purple_FOR_SUBAGENTS_ONLY', 'orange_FOR_SUBAGENTS_ONLY', 'pink_FOR_SUBAGENTS_ONLY', 'cyan_FOR_SUBAGENTS_ONLY', '#zzz', 'rgb(1,2,3)', 'ansi256(5)']).map(k => (
            <Text>
              <Text color={k}>■ {k}</Text>
              <Text color={k} bold>{' bold'}</Text>
            </Text>
          ))}
        </Box>
      )

    // all: P1, P5, P8
    return (
      <Box flexDirection="column">
        {status}
        <Text>
          P1 <Text color={MAUVE}>mauve #CBA6F7</Text> <Text color="merged">merged</Text> <Text color="magenta">magenta</Text>{' '}
          <Text color={GREEN}>green #A6E3A1</Text>
        </Text>
        <Text>
          {MOCHA.map(([name, hex]) => (
            <Text color={hex}>{`■${name} `}</Text>
          ))}
        </Text>
        <Text>
          {MOCHA256.map(([name, hex]) => (
            <Text color={hex}>{`▲${name} `}</Text>
          ))}
        </Text>
        <Text>
          {ANSI.map(name => (
            <Text color={name}>{`◆${name} `}</Text>
          ))}
        </Text>
        <Box borderStyle="round" borderColor={MAUVE} paddingX={1} width={w}>
          <Text>border #CBA6F7</Text>
        </Box>
        <Box borderStyle="round" borderColor={SURFACE} paddingX={1} width={w}>
          <Text>border #45475A surface</Text>
        </Box>
        <Text>P5 symbol column (3 cells), right border must align:</Text>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" width={30}>
          <Text>{'14:02 ○ Ivan Petrov    '}<Text color="red">{'  2'}</Text></Text>
          <Text>{'  Thu ● Infra          '}<Text color={GREEN}>{' ⚡'}</Text></Text>
          <Text>{'  Thu ● Infra          '}<Text color="success">{' ⚡'}</Text></Text>
          <Text>{'  Thu ● Infra          '}<Text color={GREEN}>{' ⚡︎'}</Text></Text>
          <Text>{'  Thu ● Infra          '}<Text color={GREEN}>{'  ↯'}</Text></Text>
          <Text>{'13:57 ⌗ Project team   '}<Text color="#FAB387">{' @1'}</Text></Text>
          <Text>{'  Thu ⬡ example_bot    '}<Text dimColor>{'  ◌'}</Text></Text>
          <Text>{'  Thu ◇ ▷ ★ ≡ ⊘ ▰▱━·■↻ '}<Text dimColor>{'  ⊘'}</Text></Text>
        </Box>
        {keyLine}
      </Box>
    )
  })

  // P1 in AbovePrompt, P3: a right-aligned narrow card chained through next(e), as statuspane draws its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, card))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e).catch(() => null)
    const row = await read($, cardRow)
    const pressed = await read($, presses)
    const width = Math.min(46, e.props.bodyColumns - 2)
    const rows = ['14:02 ○ Ivan Petrov     Can we call…   2', '13:57 ⌗ Project team    can you rev…  @1']
    const press = (k: string) => () => void update($, presses, log(`card:${k}`))
    const move = (by: number, k: string) => async () => {
      await update($, cardRow, r => Math.max(0, Math.min(1, r + by)))
      await update($, presses, log(`card:${k}`))
    }
    const ours = (
      <Box justifyContent="flex-end">
        <Box key="tgcard" width={width} flexDirection="column">
          <Box width={width} flexDirection="column" borderStyle="round" borderColor={MAUVE} paddingX={1}>
            <Text>
              <Text color="#FAB387">● 3 chats waiting</Text>   <Text color={GREEN}>⚡ ▰▰▱▱▱ 12/50</Text>
            </Text>
            {rows.map((r, i) =>
              i === row ? (
                <Button key={`card:row:${i}`} plain autoFocus onPress={press(`enter${i}`)}>{`▸ ${r}`}</Button>
              ) : (
                <Text>{`  ${r}`}</Text>
              ),
            )}
            <Text dimColor>{`presses ${pressed.join(',') || '-'}`}</Text>
            <Box display="none">
              <Button key="card:j" hotkey="j" onPress={move(1, 'j')}>j</Button>
              <Button key="card:k" hotkey="k" onPress={move(-1, 'k')}>k</Button>
              <Button key="card:q" hotkey="q" onPress={() => update($, card, () => false)}>q</Button>
            </Box>
          </Box>
          <Box position="absolute" top={0} left={2}>
            <Text color={MAUVE} bold>{' tg '}</Text>
          </Box>
          <Box position="absolute" bottom={0} left={2}>
            <Text dimColor>{' ⏎ open · q: hide '}</Text>
          </Box>
        </Box>
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {below}
        {ours}
      </Box>
    ) : (
      ours
    )
  })
}
