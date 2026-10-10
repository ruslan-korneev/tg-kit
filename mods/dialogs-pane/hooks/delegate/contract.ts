// The types the delegate rules use, from this plugin's contract. The rules in
// this folder are shared with mods/dialogs-pane-guard as byte-identical copies
// (the engine loads no file from outside a plugin's folder); each plugin has
// its own contract.ts, so only this file differs between the two.
export type { DgCommands, DgDialog, DgDuration, DgGrant, DgSkip, DgStep, DgStop, DgTask, DgWeb, DgWorktree, GuardHold, GuardWork } from '../../types'
