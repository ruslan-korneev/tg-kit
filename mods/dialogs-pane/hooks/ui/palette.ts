// The pane's colours (docs/design/dialogs-pane-ux.md §10.2): code names a role,
// never a colour, and the `palette` option picks what each role draws. The
// palette reaches a component as an argument (`Colors`), the way the surface's
// element table does, never through module state. Pure: tests read it directly.
import type { Color, ThemeKey } from 'claude-code'

export const PALETTE_NAMES = ['theme', 'mocha', 'mocha256', 'ansi'] as const
/** `theme` follows Claude Code's theme; `mocha` is Catppuccin Mocha; `mocha256` keeps it apart in tmux's 256 colours; `ansi` is for 16 colours (decision 8). */
export type Palette = (typeof PALETTE_NAMES)[number]

export const ROLES = [
  'accent',
  'unread',
  'mention',
  'held',
  'ok',
  'person',
  'group',
  'channel',
  'bot',
  'saved',
  'dim',
  'subtext',
  'text',
  'surface',
] as const
export type Role = (typeof ROLES)[number]

/** What a component is handed: each role's colour; `undefined` is the terminal's own foreground (`ansi`'s `text`). */
export type Colors = Readonly<Record<Role, Color | undefined>>

// §10.2's role table, column by column. `theme` names typed ThemeKeys only (P6, decision 7).
const THEME = {
  accent: 'merged',
  unread: 'error',
  mention: 'warning',
  held: 'warning',
  ok: 'success',
  person: 'permission',
  group: 'planMode',
  channel: 'ide',
  bot: 'claude',
  saved: 'warning',
  dim: 'inactive',
  subtext: 'inactive',
  text: 'text',
  surface: 'subtle',
} as const satisfies Record<Role, ThemeKey>

const MOCHA = {
  accent: '#CBA6F7', // mauve
  unread: '#F38BA8', // red
  mention: '#FAB387', // peach
  held: '#F9E2AF', // yellow
  ok: '#A6E3A1', // green
  person: '#89B4FA', // blue
  group: '#94E2D5', // teal
  channel: '#89DCEB', // sky
  bot: '#F5C2E7', // pink
  saved: '#F9E2AF', // yellow
  dim: '#6C7086', // overlay
  subtext: '#A6ADC8', // subtext
  text: '#CDD6F4', // text
  surface: '#45475A', // surface
} as const satisfies Record<Role, string>

// tmux draws 256 colours by `16 + 36·r + 6·g + b`, each channel round(v / 51) (P7):
// five of mocha's values move so that every role but held/saved lands on a cell of its own.
const MOCHA256 = {
  ...MOCHA,
  unread: '#F37AA8', // 211
  mention: '#FAAF7A', // 216
  held: '#F9E6AF', // 229
  person: '#7AAFFA', // 111
  channel: '#7ADCEB', // 117
  saved: '#F9E6AF', // 229
} as const satisfies Record<Role, string>

// The 16 names, chosen so no two roles merge at 16 colours (T11's measure, §10.2):
// cyanBright would be cyan, so channel is blueBright; borders are gray, never a black.
const ANSI = {
  accent: 'magenta',
  unread: 'red',
  mention: 'yellow',
  held: 'yellow',
  ok: 'green',
  person: 'blue',
  group: 'cyan',
  channel: 'blueBright',
  bot: 'magentaBright',
  saved: 'yellow',
  dim: 'gray',
  subtext: 'white',
  text: undefined,
  surface: 'gray',
} as const satisfies Record<Role, string | undefined>

export const PALETTES = {
  theme: THEME,
  mocha: MOCHA,
  mocha256: MOCHA256,
  ansi: ANSI,
} as const satisfies Record<Palette, Colors>

/**
 * A forum topic's `icon_color` (Telegram has six) in each palette (§10.2). Red is
 * maroon, so a topic's dot never reads as an unread count. Any other value draws `dim`.
 */
export const TOPIC_COLOR: Readonly<Record<number, Readonly<Record<Palette, Color>>>> = {
  0x6fb9f0: { theme: THEME.person, mocha: MOCHA.person, mocha256: MOCHA256.person, ansi: ANSI.person },
  0xffd67e: { theme: THEME.held, mocha: MOCHA.held, mocha256: MOCHA256.held, ansi: ANSI.held },
  0xcb86db: { theme: THEME.accent, mocha: MOCHA.accent, mocha256: MOCHA256.accent, ansi: ANSI.accent },
  0x8eee98: { theme: THEME.ok, mocha: MOCHA.ok, mocha256: MOCHA256.ok, ansi: ANSI.ok },
  0xff93b2: { theme: THEME.bot, mocha: MOCHA.bot, mocha256: MOCHA256.bot, ansi: ANSI.bot },
  // Maroon is its own cell (217) in tmux, apart from unread's 211; redBright (91) is apart from red (31).
  0xfb6f5f: { theme: 'error', mocha: '#EBA0AC', mocha256: '#EBA0AC', ansi: 'redBright' },
}

export function topicColor(palette: Palette, iconColor: number): Color | undefined {
  return TOPIC_COLOR[iconColor]?.[palette] ?? PALETTES[palette].dim
}

const isPalette = (value: unknown): value is Palette => PALETTE_NAMES.some(name => name === value)

/** The `palette` option as read in `register`; anything else is the default, `theme`. */
export function readPalette(value: unknown): Palette {
  return isPalette(value) ? value : 'theme'
}
