// The dock's section cards and their rows (docs/design/dialogs-pane-ux.md
// §10.5): FOR YOU, CHATS, START HERE, AUTOPILOT and LOG with no chat open;
// CHATS at three rows over the lower card with one. A section with nothing
// takes no room, and the last card drawn grows to the bottom. Pure: the frame
// holds one answer for a layout generation, so nothing above the CHATS list
// changes its room while the cursor stays.
import { CARD_CHROME } from './frame'

/** What the sections hold at a generation's start. */
export type DockInput = {
  /** Rows for the cards: the pane's, less the header, the legend row and the key line's rows. */
  room: number
  /** A chat or a layer takes the lower part: CHATS keeps three rows and the other sections fold. */
  isOpen: boolean
  /** START HERE shows: the first open, until `d`. */
  isStart: boolean
  /** FOR YOU's items; 0 while the For you view is the top card. */
  forYou: number
  /** Content rows the AUTOPILOT card asks for (./activity `autopilotRows`); 0 with no agent on. */
  autopilot: number
  /** LOG's entries; 0 draws no card. */
  log: number
  /** Rows the top list has: its chats, or 1 for an empty folder's sentence or a load state. */
  list: number
}

/** Content rows per card; 0 is a card not drawn. `lower` is the lower card's while a chat is open. */
export type DockLayout = { forYou: number; chats: number; start: number; autopilot: number; log: number; lower: number }

/** CHATS' rows while a chat is open. */
export const OPEN_CHATS = 3
/** CHATS' rows at least, with no chat open. */
export const MIN_CHATS = 5
/** FOR YOU's rows at most. */
export const MAX_FOR_YOU = 3
/** LOG's rows at least. */
export const MIN_LOG = 2
/** START HERE's lines. */
export const START_CARD = 3

const card = (rows: number) => (rows > 0 ? rows + CARD_CHROME : 0)

export function dockLayout(input: DockInput): DockLayout {
  const room = Math.max(0, input.room)
  if (input.isOpen) {
    const chats = OPEN_CHATS
    return { forYou: 0, chats, start: 0, autopilot: 0, log: 0, lower: Math.max(1, room - card(chats) - CARD_CHROME) }
  }
  const parts = {
    forYou: Math.min(MAX_FOR_YOU, Math.max(0, input.forYou)),
    start: input.isStart ? START_CARD : 0,
    autopilot: Math.max(0, input.autopilot),
    log: input.log > 0 ? MIN_LOG : 0,
  }
  const others = () => card(parts.forYou) + card(parts.start) + card(parts.autopilot) + card(parts.log)
  // A short pane: LOG goes first, then FOR YOU keeps one row, then START HERE, then AUTOPILOT, until CHATS has its five.
  const giveWay: (() => void)[] = [
    () => (parts.log = 0),
    () => (parts.forYou = Math.min(1, parts.forYou)),
    () => (parts.start = 0),
    () => (parts.autopilot = 0),
  ]
  for (const step of giveWay) {
    if (room - others() - CARD_CHROME >= MIN_CHATS) break
    step()
  }
  const most = Math.max(1, room - others() - CARD_CHROME)
  let chats = Math.min(most, Math.max(MIN_CHATS, input.list))
  const rest = Math.max(0, room - others() - card(chats))
  // The last card drawn grows to the bottom: LOG, else AUTOPILOT, else CHATS (START HERE's lines are fixed).
  if (parts.log > 0) parts.log += rest
  else if (parts.autopilot > 0) parts.autopilot += rest
  else chats += rest
  return { ...parts, chats, lower: 0 }
}

/** Inline: the view's one card takes the room the header, the notice row and the key line leave. */
export function inlineCardRows(room: number): number {
  return Math.max(1, room - CARD_CHROME)
}
