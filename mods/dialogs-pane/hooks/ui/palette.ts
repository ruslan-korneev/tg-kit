// The pane's colours (docs/design/dialogs-pane-ux.md §10.2): code names a role,
// never a colour, and the `palette` option picks what each role draws. The
// palette reaches a component as an argument (`Colors`), the way the surface's
// element table does, never through module state. Pure: tests read it directly.
import type { Color, ThemeKey } from 'claude-code'

import { CATALOGUE } from './themes'

/** §10.2's 14 roles, in the catalogue's order. */
export const ROLES = CATALOGUE.roles
export type Role = (typeof ROLES)[number]

/** What a component is handed: each role's colour; `undefined` is the terminal's own foreground (`ansi`'s `text`). */
export type Colors = Readonly<Record<Role, Color | undefined>>

type Catalogue = typeof CATALOGUE.themes
/** A theme of the catalogue (palettes/themes.json, decision 9). */
export type ThemeName = keyof Catalogue
/** A theme with a `variant256`: only those have a `<name>256`. */
type With256 = { [Name in ThemeName]: Catalogue[Name] extends { variant256: unknown } ? Name : never }[ThemeName]

/**
 * `theme` follows Claude Code's theme; `ansi` is for 16 colours; a catalogue name draws
 * that theme's hex; `<name>256` moves the few that would share a cell in tmux's 256
 * colours (§10.2, decisions 8 and 9).
 */
export type Palette = 'theme' | 'ansi' | ThemeName | `${With256}256`

/** What palette.ts reads of a theme in palettes/themes.json (its schema is pinned by tests/unit/test_themes_shared.py). */
type Theme = {
  readonly roles: Readonly<Record<Role, string>>
  readonly topics: Readonly<Record<string, string>>
  readonly variant256?: {
    readonly roles: Readonly<Partial<Record<Role, string>>>
    readonly topics: Readonly<Record<string, string>>
  }
}
const THEMES: Readonly<Record<ThemeName, Theme>> = CATALOGUE.themes
const THEME_NAMES = Object.keys(THEMES) as ThemeName[] // Object.keys widens to string[]

/** Decision 9: the pane's default, as the CLI's. */
export const DEFAULT_PALETTE = 'tokyo-night' satisfies Palette

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

// Telegram's six `icon_color` values, keyed as the catalogue's `topicKeys` (6FB9F0, …).
const topicKey = (iconColor: number) => iconColor.toString(16).toUpperCase().padStart(6, '0')

// `theme` and `ansi` have no hex, so their topics stay here (§10.2's topic table). Red
// is redBright (91) apart from unread's red (31); theme's only red key is `error`,
// unread's own (a known gap, §10.2).
const CODE_TOPICS = {
  theme: { '6FB9F0': THEME.person, FFD67E: THEME.held, CB86DB: THEME.accent, '8EEE98': THEME.ok, FF93B2: THEME.bot, FB6F5F: 'error' },
  ansi: { '6FB9F0': ANSI.person, FFD67E: ANSI.held, CB86DB: ANSI.accent, '8EEE98': ANSI.ok, FF93B2: ANSI.bot, FB6F5F: 'redBright' },
} as const satisfies Record<'theme' | 'ansi', Record<(typeof CATALOGUE.topicKeys)[number], Color>>

/** What a palette draws: its roles, and its forum topics keyed by `icon_color` (§10.2). */
type Drawn = { readonly roles: Colors; readonly topics: Readonly<Record<string, Color>> }

// Each theme, then its `<name>256`: the theme with its `variant256` entries over it.
const FROM_CATALOGUE = THEME_NAMES.flatMap((name): [Palette, Drawn][] => {
  const { roles, topics, variant256 } = THEMES[name]
  if (variant256 === undefined) return [[name, { roles, topics }]]
  // `variant256` is set, so `name` is one of With256, which the type cannot narrow to.
  const variant = `${name}256` as Palette
  return [
    [name, { roles, topics }],
    [variant, { roles: { ...roles, ...variant256.roles }, topics: { ...topics, ...variant256.topics } }],
  ]
})

const DRAWN = Object.fromEntries([
  ['theme', { roles: THEME, topics: CODE_TOPICS.theme }],
  ['ansi', { roles: ANSI, topics: CODE_TOPICS.ansi }],
  ...FROM_CATALOGUE,
]) as Readonly<Record<Palette, Drawn>> // one entry per Palette: theme, ansi, and FROM_CATALOGUE's

/** The `palette` option's values, as plugin.json lists them: theme, ansi, then each theme and its 256 variant. */
export const PALETTE_NAMES = Object.keys(DRAWN) as readonly Palette[]

export const PALETTES: Readonly<Record<Palette, Colors>> = Object.fromEntries(PALETTE_NAMES.map(name => [name, DRAWN[name].roles])) as Record<Palette, Colors>

/**
 * A forum topic's colour, keyed by palette and then by `icon_color` (Telegram has six).
 * A catalogue theme's red topic is its second red where it has one, so the dot never
 * reads as an unread count.
 */
export const TOPIC_COLOR: Readonly<Record<Palette, Readonly<Record<string, Color>>>> = Object.fromEntries(
  PALETTE_NAMES.map(name => [name, DRAWN[name].topics]),
) as Record<Palette, Record<string, Color>>

/** A topic's colour in a palette; any `icon_color` outside Telegram's six draws `dim`. */
export function topicColor(palette: Palette, iconColor: number): Color | undefined {
  return TOPIC_COLOR[palette][topicKey(iconColor)] ?? PALETTES[palette].dim
}

const isPalette = (value: unknown): value is Palette => PALETTE_NAMES.some(name => name === value)

/** The `palette` option as read in `register`; anything else is the default, `tokyo-night`. */
export function readPalette(value: unknown): Palette {
  return isPalette(value) ? value : DEFAULT_PALETTE
}
