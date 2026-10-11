import { describe, expect, test } from 'claude-code/testing'

import { PALETTES, PALETTE_NAMES, ROLES, TOPIC_COLOR, readPalette, topicColor, type Role } from './palette'

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

describe('palette (§10.2)', () => {
  test('every role has a value in every palette; only ansi leaves text to the terminal', () => {
    for (const name of PALETTE_NAMES) {
      const colors = PALETTES[name]
      expect(Object.keys(colors).sort()).toEqual([...ROLES].sort())
      const unset = ROLES.filter(role => colors[role] === undefined)
      expect(unset).toEqual(name === 'ansi' ? ['text'] : [])
    }
  })

  test('every mocha and mocha256 value is #RRGGBB: a hex the engine cannot parse draws black (P6)', () => {
    for (const name of ['mocha', 'mocha256'] as const) {
      for (const role of ROLES) expect(`${name}.${role} ${PALETTES[name][role]}`).toMatch(/ #[0-9A-F]{6}$/)
    }
    for (const iconColor of Object.keys(TOPIC_COLOR).map(Number)) {
      expect(topicColor('mocha', iconColor)).toMatch(HEX)
      expect(topicColor('mocha256', iconColor)).toMatch(HEX)
    }
  })

  test("mocha256's values land on cells of their own in tmux, bar held and saved", () => {
    const colors = PALETTES.mocha256
    const owner = new Map<number, Role>()
    for (const role of ROLES) {
      const cell = cell256(colors[role])
      const before = owner.get(cell)
      if (before !== undefined) expect(`${before} ${role}`).toBe('held saved')
      owner.set(cell, role)
    }
    // T11's cells for the five it moved, and maroon's apart from unread.
    expect([colors.mention, colors.held, colors.person, colors.channel, colors.unread].map(cell256)).toEqual([216, 229, 111, 117, 211])
    expect(cell256(topicColor('mocha256', 0xfb6f5f) ?? '')).toBe(217)
  })

  test("mocha's own collisions in tmux are what mocha256 exists for", () => {
    const colors = PALETTES.mocha
    expect(cell256(colors.mention)).toBe(cell256(colors.held))
    expect(cell256(colors.person)).toBe(cell256(colors.channel))
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

  test("a topic's colour by icon_color; red is maroon, apart from unread's where a palette has one; any other value is dim", () => {
    expect(topicColor('mocha', 0x6fb9f0)).toBe(PALETTES.mocha.person)
    expect(topicColor('theme', 0xffd67e)).toBe('warning')
    expect(topicColor('mocha', 0xfb6f5f)).toBe('#EBA0AC')
    // theme has no typed second red, so §10.2 gives the red topic `error`, unread's own key.
    for (const name of ['mocha', 'mocha256', 'ansi'] as const) expect(topicColor(name, 0xfb6f5f)).not.toBe(PALETTES[name].unread)
    expect(topicColor('theme', 0xfb6f5f)).toBe('error')
    for (const name of PALETTE_NAMES) expect(topicColor(name, 0x123456)).toBe(PALETTES[name].dim)
    expect(Object.keys(TOPIC_COLOR)).toHaveLength(6)
  })

  test('the option: each of the four names, anything else theme', () => {
    for (const name of PALETTE_NAMES) expect(readPalette(name)).toBe(name)
    for (const other of [undefined, '', 'pastel', 'MOCHA', 7, null]) expect(readPalette(other)).toBe('theme')
  })
})
