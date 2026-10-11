import { describe, expect, test } from 'claude-code/testing'

import { PALETTES, PALETTE_NAMES, ROLES, TOPIC_COLOR, readPalette, topicColor, type Palette, type Role } from './palette'
import { CATALOGUE } from './themes'

const HEX = /^#[0-9A-F]{6}$/

/** tmux's downsample to 256 colours (§10.2, P7): `16 + 36·r + 6·g + b`, each channel round(v / 51). */
function cell256(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => Math.round(parseInt(hex.slice(at, at + 2), 16) / 51))
  return 16 + 36 * (r ?? 0) + 6 * (g ?? 0) + (b ?? 0)
}

/** The 16-colour codes T11 measured for each name (§10.2). */
const ANSI_CODE: Readonly<Record<string, number>> = {
  black: 30,
  blackBright: 30,
  red: 31,
  green: 32,
  greenBright: 32,
  blue: 34,
  magenta: 35,
  cyan: 36,
  cyanBright: 36,
  gray: 37,
  redBright: 91,
  yellow: 93,
  yellowBright: 93,
  magentaBright: 95,
  blueBright: 96,
  white: 97,
  whiteBright: 97,
}

/** Roles that share a colour on purpose (§10.2): one each for mention, held and saved, and for dim and surface. */
const SHARED_ANSI: readonly (readonly Role[])[] = [
  ['mention', 'held', 'saved'],
  ['dim', 'surface'],
]
const sharesOnPurpose = (a: Role, b: Role) => SHARED_ANSI.some(group => group.includes(a) && group.includes(b))

/** T12's mocha and mocha256, as they were before the catalogue (T17): the rename keeps every value. */
const T12_MOCHA = {
  accent: '#CBA6F7',
  unread: '#F38BA8',
  mention: '#FAB387',
  held: '#F9E2AF',
  ok: '#A6E3A1',
  person: '#89B4FA',
  group: '#94E2D5',
  channel: '#89DCEB',
  bot: '#F5C2E7',
  saved: '#F9E2AF',
  dim: '#6C7086',
  subtext: '#A6ADC8',
  text: '#CDD6F4',
  surface: '#45475A',
}
const T12_MOCHA256 = {
  ...T12_MOCHA,
  unread: '#F37AA8',
  mention: '#FAAF7A',
  held: '#F9E6AF',
  person: '#7AAFFA',
  channel: '#7ADCEB',
  saved: '#F9E6AF',
}
const T12_MOCHA_TOPICS = { '6FB9F0': '#89B4FA', FFD67E: '#F9E2AF', CB86DB: '#CBA6F7', '8EEE98': '#A6E3A1', FF93B2: '#F5C2E7', FB6F5F: '#EBA0AC' }
const T12_MOCHA256_TOPICS = { ...T12_MOCHA_TOPICS, '6FB9F0': '#7AAFFA', FFD67E: '#F9E6AF' }

/** Telegram's six icon_color values, in the catalogue's topicKeys order. */
const ICON_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f]

type CatalogueTheme = {
  roles: Readonly<Record<Role, string>>
  topics: Readonly<Record<string, string>>
  variant256?: { roles: Readonly<Partial<Record<Role, string>>>; topics: Readonly<Record<string, string>> }
}
const THEMES: Readonly<Record<string, CatalogueTheme>> = CATALOGUE.themes
const CATALOGUE_PALETTES = PALETTE_NAMES.filter(name => name !== 'theme' && name !== 'ansi')

describe('palette (§10.2)', () => {
  test('the option lists theme, ansi, then each catalogue theme and its 256 variant where it has variant256', () => {
    const expected = ['theme', 'ansi']
    for (const [name, theme] of Object.entries(THEMES)) expected.push(...(theme.variant256 ? [name, `${name}256`] : [name]))
    expect([...PALETTE_NAMES]).toEqual(expected)
    expect(PALETTE_NAMES).toContain('catppuccin-mocha256')
    expect(PALETTE_NAMES).toContain('kanagawa256')
    // tokyo-night has no variant256, and decision 9 renamed mocha with no alias.
    for (const gone of ['tokyo-night256', 'mocha', 'mocha256']) expect(PALETTE_NAMES).not.toContain(gone)
  })

  test('every role has a value in every palette; only ansi leaves text to the terminal', () => {
    expect([...ROLES]).toEqual([...CATALOGUE.roles])
    for (const name of PALETTE_NAMES) {
      const colors = PALETTES[name]
      expect(`${name} ${Object.keys(colors).sort().join(' ')}`).toBe(`${name} ${[...ROLES].sort().join(' ')}`)
      const unset = ROLES.filter(role => colors[role] === undefined)
      expect(`${name} ${unset.join(' ')}`).toBe(name === 'ansi' ? 'ansi text' : `${name} `)
    }
  })

  test('every catalogue role and topic is #RRGGBB: a hex the engine cannot parse draws black (P6)', () => {
    for (const name of CATALOGUE_PALETTES) {
      for (const role of ROLES) expect(`${name}.${role} ${PALETTES[name][role]}`).toMatch(/ #[0-9A-F]{6}$/)
      for (const iconColor of ICON_COLORS) expect(`${name} ${iconColor} ${topicColor(name, iconColor)}`).toMatch(/ #[0-9A-F]{6}$/)
    }
  })

  test('a catalogue palette draws its theme; a 256 one applies its variant256 entries and only those', () => {
    for (const name of CATALOGUE_PALETTES) {
      const base = name.endsWith('256') ? name.slice(0, -3) : name
      const theme = THEMES[base]
      if (theme === undefined) throw new Error(`${name}: no theme ${base}`)
      const variant = base === name ? {} : (theme.variant256?.roles ?? {})
      const topics = base === name ? {} : (theme.variant256?.topics ?? {})
      for (const role of ROLES) expect(`${name}.${role} ${PALETTES[name][role]}`).toBe(`${name}.${role} ${variant[role] ?? theme.roles[role]}`)
      for (const key of CATALOGUE.topicKeys) {
        expect(`${name} ${key} ${topicColor(name, parseInt(key, 16))}`).toBe(`${name} ${key} ${topics[key] ?? theme.topics[key]}`)
      }
    }
    // The variant bites where the file moves a role: kanagawa256's surface, nord256's group and dim.
    expect(PALETTES.kanagawa256.surface).not.toBe(PALETTES.kanagawa.surface)
    expect([PALETTES.nord256.group, PALETTES.nord256.dim]).not.toEqual([PALETTES.nord.group, PALETTES.nord.dim])
    expect(topicColor('nord256', 0xfb6f5f)).not.toBe(topicColor('nord', 0xfb6f5f))
  })

  test("catppuccin-mocha and catppuccin-mocha256 keep T12's mocha and mocha256, topics too", () => {
    expect(PALETTES['catppuccin-mocha']).toEqual(T12_MOCHA)
    expect(PALETTES['catppuccin-mocha256']).toEqual(T12_MOCHA256)
    expect(TOPIC_COLOR['catppuccin-mocha']).toEqual(T12_MOCHA_TOPICS)
    expect(TOPIC_COLOR['catppuccin-mocha256']).toEqual(T12_MOCHA256_TOPICS)
  })

  test("catppuccin-mocha256's values land on cells of their own in tmux, bar held and saved", () => {
    const colors = PALETTES['catppuccin-mocha256']
    const owner = new Map<number, Role>()
    for (const role of ROLES) {
      const cell = cell256(colors[role] ?? '')
      const before = owner.get(cell)
      if (before !== undefined) expect(`${before} ${role}`).toBe('held saved')
      owner.set(cell, role)
    }
    // T11's cells for the five it moved, and maroon's apart from unread.
    expect([colors.mention, colors.held, colors.person, colors.channel, colors.unread].map(hex => cell256(hex ?? ''))).toEqual([216, 229, 111, 117, 211])
    expect(cell256(topicColor('catppuccin-mocha256', 0xfb6f5f) ?? '')).toBe(217)
  })

  test("catppuccin-mocha's own collisions in tmux are what its 256 variant exists for", () => {
    const colors = PALETTES['catppuccin-mocha']
    expect(cell256(colors.mention ?? '')).toBe(cell256(colors.held ?? ''))
    expect(cell256(colors.person ?? '')).toBe(cell256(colors.channel ?? ''))
  })

  test('ansi uses measured names only, no pair that merges at 16 colours, and no black', () => {
    const colors = PALETTES.ansi
    for (const role of ROLES) {
      const value = colors[role]
      if (value === undefined) continue
      expect(`${role} ${value} ${value in ANSI_CODE}`).toBe(`${role} ${value} true`)
      expect(ANSI_CODE[value]).not.toBe(30)
    }
    for (const [i, a] of ROLES.entries()) {
      for (const b of ROLES.slice(i + 1)) {
        const [x, y] = [colors[a], colors[b]]
        if (x === undefined || y === undefined || sharesOnPurpose(a, b)) continue
        expect(`${a}/${b} ${ANSI_CODE[x] === ANSI_CODE[y]}`).toBe(`${a}/${b} false`)
      }
    }
  })

  test("a topic's colour by icon_color; red is a second red where the palette has one; any other value is dim", () => {
    expect(topicColor('catppuccin-mocha', 0x6fb9f0)).toBe(PALETTES['catppuccin-mocha'].person)
    expect(topicColor('theme', 0xffd67e)).toBe('warning')
    expect(topicColor('catppuccin-mocha', 0xfb6f5f)).toBe('#EBA0AC')
    expect(topicColor('ansi', 0xfb6f5f)).toBe('redBright')
    // theme's second red is diffRemovedWord, apart from unread's error (§10.2); rose-pine-moon and dracula have a single red (the known gap).
    expect(topicColor('theme', 0xfb6f5f)).toBe('diffRemovedWord')
    expect(PALETTES.theme.unread).toBe('error')
    const sharesUnread = PALETTE_NAMES.filter(name => topicColor(name, 0xfb6f5f) === PALETTES[name].unread)
    expect([...sharesUnread]).toEqual(['rose-pine-moon', 'rose-pine-moon256', 'dracula', 'dracula256'])
    for (const name of PALETTE_NAMES) expect(`${name} ${topicColor(name, 0x123456)}`).toBe(`${name} ${PALETTES[name].dim}`)
    for (const name of PALETTE_NAMES) expect(`${name} ${Object.keys(TOPIC_COLOR[name]).join(' ')}`).toBe(`${name} ${CATALOGUE.topicKeys.join(' ')}`)
  })

  test('the option: every listed name is itself; anything else, the old mocha names included, is tokyo-night', () => {
    for (const name of PALETTE_NAMES) expect(readPalette(name)).toBe(name)
    const others: unknown[] = [undefined, '', 'pastel', 'MOCHA', 'mocha', 'mocha256', 'tokyo-night256', 'Nord', 7, null]
    for (const other of others) expect(readPalette(other)).toBe('tokyo-night' satisfies Palette)
  })
})
