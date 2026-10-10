// The instruction under a packet: one key instead of typing the same prompt again.
// Templates never quote chat content: the line sits outside <tg-packet>, where it would
// read as the user's own words. They point at the packet's elements instead.

export const INTENT_IDS = ['fix', 'reproduce', 'explain', 'test', 'draft_reply', 'raw'] as const
export type IntentId = (typeof INTENT_IDS)[number]

export type Intent = { id: Exclude<IntentId, 'raw'> } | { id: 'raw'; text: string }

type Template = { label: string; instruction: string }

export const INTENTS = {
  fix: {
    label: 'Fix',
    instruction:
      "find the handler that produced this reply and fix the cause. Search the repository for the reply's <text> and button labels; run the <replay> command before and after the fix.",
  },
  reproduce: {
    label: 'Reproduce',
    instruction:
      'run the <replay> command with the tg CLI (or the steps the messages imply) and report whether the same reply comes back. Change no code.',
  },
  explain: {
    label: 'Explain',
    instruction: 'explain what happened in these messages and which code path produced them. Change nothing.',
  },
  test: {
    label: 'Test',
    instruction:
      'write an automated test that reproduces this exchange (send, wait, press) and asserts the reply: text, buttons and callback data.',
  },
  draft_reply: {
    label: 'Draft reply',
    instruction: 'draft a reply to the last message for me to review. Do not send it.',
  },
  raw: { label: 'Raw', instruction: '' },
} as const satisfies Record<IntentId, Template>

/** The line printed after `</tg-packet>`: `Intent: Fix — …`, or the user's own words for Raw. */
export function intentLine(intent: Intent): string {
  switch (intent.id) {
    case 'raw':
      return intent.text.trim()
    case 'fix':
    case 'reproduce':
    case 'explain':
    case 'test':
    case 'draft_reply': {
      const t = INTENTS[intent.id]
      return `Intent: ${t.label} — ${t.instruction}`
    }
  }
}
