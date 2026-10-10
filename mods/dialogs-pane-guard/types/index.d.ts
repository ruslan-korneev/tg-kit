// The dialogs-pane-guard contract: the values it keeps in $.state, which
// dialogs-pane reads (as external data, narrowed by its hooks/delegate/guard.ts)
// to draw the task card, the band, the status line and the ledger.
// Self-contained (no imports): the stop names and the peer mirror
// dialogs-pane's DgStop and PeerRef (its types/index.d.ts); register.ts
// assigns dialogs-pane's values to these, so tsc fails if they drift.

export type GuardStop = 'money' | 'publish' | 'share' | 'delete' | 'commit-on-behalf'

export type GuardPeer = { id: number; arg: string; label: string; kind: 'self' | 'user' | 'bot' | 'group' | 'channel' | 'supergroup' | 'unknown' }

/** The handshake: when the guard last answered, and the live task ids it guards. */
export type GuardArmedValue = { at: number; taskIds: number[] }

export type GuardStepValue = { text: string; count: number; state: 'done' | 'failed' }

/** A task's steps, read off its Worker's tool calls, and the call running now. */
export type GuardWorkValue = { taskId: number; steps: GuardStepValue[]; current: string | null }

/** A Worker's hard stop waiting in the engine's dialog. */
export type GuardHoldValue = { id: number; taskId: number; stops: GuardStop[]; what: string; since: number }

/** A Worker's hard stop met: asked (yes / no and who) or skipped. */
export type GuardEventValue = {
  seq: number
  at: number
  taskId: number
  peer: GuardPeer
  summary: string
  stops: GuardStop[]
  what: string
  answer: 'yes' | 'no' | 'skipped'
  why: string
}

declare module 'claude-code' {
  interface PluginState {
    'dialogs-pane-guard': {
      armed: GuardArmedValue
      work: GuardWorkValue[]
      holds: GuardHoldValue[]
      events: GuardEventValue[]
    }
  }
}
