// The types the delegate rules use, from dialogs-pane's contract (this
// plugin's `dependencies`). The rules in this folder are byte-identical copies
// of mods/dialogs-pane/hooks/delegate (the engine loads no file from outside a
// plugin's folder); only this file differs between the two.
export type { DgDialog, DgDuration, DgGrant, DgSkip, DgStep, DgStop, DgTask, DgWeb, DgWorktree, GuardHold, GuardWork } from 'dialogs-pane'
