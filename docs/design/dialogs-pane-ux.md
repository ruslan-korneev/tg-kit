# Dialogs Pane — UX

How the dialogs pane should look and respond, from the first `/tg` to `delegate`. It builds on
[`dialogs-pane.md`](dialogs-pane.md) (the modes, the packet, autopilot, the guard) and replaces its
keymap (§4) and modes (§2). The engines stay as built: the packet, the watch hub, the Speaker, the
Worker and the guard do not change. What changes is how a person finds them and drives them.

Status: design. Nothing here is built yet; §8 splits the work into tasks.

## 0. The new model in one paragraph

**⏎ does the obvious thing, `m` shows every key, `0` stops everything, and the footer always says
what runs.** ⏎ acts on the row under the cursor: it opens a chat, opens the send sheet for a
message, sends a draft, starts the agent in a card. A letter means one thing in every view and in
the band; digits only pick numbered options drawn on screen (a lens, a bot's button, an intent, a
level). The pane lays itself out for where the engine seats it (dock or inline) instead of asking
the person to pick a mode. One card per chat answers "what may an agent do here?" as a ladder from
*follow* to *delegate*. State lives in the prompt footer as a dim label, alarms in the status line,
and things that need the owner in a queue above the prompt.

## 1. How this was studied

- Read: the spec, every UI file of `mods/dialogs-pane` and `mods/dialogs-pane-guard`, and the 36
  commit bodies of `master..feat/dialogs-pane`.
- Engine surface: the `plugin-authoring` types of claude 2.1.296 (`Pane`, `AbovePrompt`,
  `PromptHint`, `SessionMode`, `UserMessage`, `CommandOutput`, `Button`, `Select`, `Input`,
  `$.ui.ask`, `$.ui.open`, `$.prompt.fill`, `$.command.register`).
- Live: the mods from this branch under `claude --plugin-dir`, the installed copies switched off
  with `--settings`, a fake `tg` on PATH (placeholder chats only: @example_bot, Dev Team, Contact
  A/B, Announcements, BotFather), in two terminals: fullscreen 180×50 (the pane docks at 64
  columns) and the main screen at 100×40 (the pane sits inline, 12 rows). Appendix A has the set-up.
- A throwaway probe mod checked the engine surfaces this design leans on. All five worked:

| Surface | Result |
| --- | --- |
| `SessionMode` | a mode label (`tg ⟳1 ✎2`) draws dim at the right end of the prompt footer |
| `PromptHint` `tail` | text joins the hint line under the prompt (`… · tg: ✎ 2 drafts wait · ctrl+x tab`) |
| `UserMessage` | a packet the pane sent draws as one row; ctrl+o still shows the whole `<tg-packet>` |
| `Pane` `isFocused` | flips on ctrl+x tab and redraws, so the pane can say who holds the keys |
| `Select` | draws `web: read-only ▾`; focused, it opens a list; ⏎ picks |

## 2. Audit of today's UX

Ranked by how much each one stops the owner. "Today" is `feat/dialogs-pane` at 3cbfb6b.

| # | Severity | Problem | Evidence |
| --- | --- | --- | --- |
| 1 | blocks | No way to learn the keys: 25 key labels at once, 13 letters change meaning between views, no help | live Wide capture below; `TOPIC_KEY` m/d/p/n/i in `autopilot/config.ts:20`; `hintsFor` shows navigation only (`ui/model.ts:212`) |
| 2 | blocks | The main action has no key: `[ send ]` has no hotkey, ⏎ on a message toggles the selection | `routing/components.tsx:108`; `register.tsx:589`; sending takes `x a 1 ⏎` |
| 3 | blocks | Nobody can see which site holds the keys; letters land in the prompt | live: letters meant for the pane typed into the composer twice (`❯ hkkkkkkkw`); `isFocused` unused |
| 4 | blocks | Autopilot and delegate are hidden and gated without saying so | `q` is a bare word "autopilot"; delegate is filtered out until allowlisted (`register.tsx:2994`); the card's "press 3 again" fails |
| 5 | safety | The kill switch is slow and hard to reach | "stop all" has no hotkey (`autopilot/components.tsx:244`); `/tg` is not `immediate` (`register.tsx:128`), so `/tg autopilot off` waits for main's turn |
| 6 | high | What runs and what needs the owner is not visible at a glance | Hidden shows unread and the last event; a running autopilot shows nowhere outside the pane (`register.tsx:3053`) |
| 7 | high | The mode cycle fights the engine | `m` cycles wide → compact → hidden, but placement is the engine's: Compact in fullscreen docks and still caps itself at 12 rows |
| 8 | high | Chrome eats the room; Compact hides its own keys | Wide thread: 13 rows of chrome; Compact thread at 100×12: the `j k x v h` row is cut off |
| 9 | medium | One packet floods the transcript | about 30 rows of XML per message sent to main |
| 10 | medium | Labels promise what keys do not do | the search field is labelled `/` (the engine owns `/`); `s: ⏎ start`; placeholders read as values (`repos: ~/code/app`) |
| 11 | medium | The status line reads as a warning | the engine draws a plugin's status as a yellow `⚠ dialogs-pane:` notice, even for `tg ● 22 unread` |
| 12 | low | Two ledgers, two meanings of `l` | packets (`l` in the pane) and bursts (`l` in the card) live apart |
| 13 | low | Delegate's glyph breaks columns | `⚡` (U+26A1) is East Asian Wide: two cells in a one-cell column |

### 2.1 Details

**1. No way to learn the keys.** The Wide thread view, live at 64 columns, draws 25 key labels at
once, one of them (`/`) a key the engine takes:

```text
tg · dialogs                                             m: wide
/: search               lens: 1: [All] 2: Bots 3: Unread y: you↑
w: watch @example_bot  z: save lens  ◎ 1 live
q: autopilot
  ◆ @example_bot                                 2     21:02
  …six more dialog rows…
─ @example_bot ─────────────────────────────────────────────────
t: summarize
  21:02     you   /settings                             #677790
▸ 21:02     bot   ⚠ Something went wrong            ⏱6s #677791
        [ Retry ] [ Back ]
b: buttons  n: send  r: rec  f: diff  ⏱ live
────────────────────────────────────────────────────────────────
packet · 0 msg
nothing selected: x selects, v a range, d the whole thread
a: → main  i: intent: [Fix]  redact: on  0 masked
[ send ]  d: all  c: clear  p: pin  l: ledger
j: down  k: up  x: select  v: range  h: back
```

The same letter means different things by view: `m` mode / money, `d` whole thread / dates, `p`
pin / promises, `n` send box / new opinions, `i` intent / personal data, `t` summary / quiet hours,
`s` search / start, `l` packet ledger / autopilot ledger, `w` watch / web, `c` clear / commands,
`q` open card / close card, `a` route picker / close picker, `x` select / dismiss (band). In the
card a muscle-memory `d` silently turns off the "dates" escalation. The hints row lists `j k o s m`
or `j k x v h`: keys one learns in a minute, while the rare ones have no home. There is no help.

**2. The main action has no key.** After `x`, ⏎ presses the ring's element, which is the message,
whose press toggles the selection again. `[ send ]` is pressed only by the ring or the mouse. The
ring reaches it through `a` + a digit (the picker moves it) or through `i` (which also changes the
intent). The owner's own path, select and send with an intent, is `x`, then `a` or `i`, then ⏎; the
spec says "⏎ send".

**3. Focus is invisible.** The pane, the band and the prompt take turns holding the keys; ctrl+x
tab cycles them, and nothing says where they are. In the live run, letters meant for the pane
were typed into the prompt twice (`❯ hkkkkkkkw`); not reproduced on demand, which is the point:
the person cannot tell either. Every band row prints `ctrl+x tab:` because it cannot know.

**4. Autopilot and delegate are hidden.** The entry is a dim `q: autopilot`. The card replaces the
whole pane (13 rows; 21 with delegate, at 64 columns). Delegate is not listed until the chat is in
allow.toml. Turning `auto` on for a chat that is not allowed says "run `! tg allow add 1004 --yes`
in the prompt, then press 3 again". Live, after adding it, 3 was refused again: `apIsAllowed`
(`register.tsx:2389`) reloads the allowlist only when none is cached, so only `q q` (close and
reopen) works. The grant's fields are reached by Tab or Shift+Tab through the card's 30 controls;
nothing says so. The `skip` field for `dangerouslySkipHardStops` sits in the card as an ordinary
input.

**5. The kill switch.** "stop all" shows only while something runs, and only Tab or a click reach
it. Esc is the engine's. `/tg autopilot off` is a slash command registered without `immediate`, so
typed while main is mid-turn it runs after that turn ends. That is the engine's `CommandSpec`
contract; the lab session had no model, so no turn ran to watch it happen.

**6. State at a glance.** Running work shows in the pane's rows (`◎ 1 live`, `⟳ 2 on`, marks on
dialog rows, task cards) and nowhere else, except a waiting draft or undo in the status line. In
Hidden a dialog on `auto` that is quietly working is invisible.

**7. Modes.** The engine docks the pane in fullscreen from 110 columns and puts it inline
otherwise; the mod only asks for a size. So "compact" in fullscreen is a 64-column dock showing 12
rows of a 42-row column (4 messages in the live run), and "wide" on the main screen is inline.

**8. Chrome.** Wide's thread view spends 13 rows on chrome (header, lens bar, watch row, autopilot
row, two dividers, summary key, bot bar, a 4-row tray even with nothing selected, hints). Compact's
thread view at 100×12, live:

```text
╭────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg · @example_bot                                                                     m: compact │
│ q: autopilot                                                                                     │
│ t: summarize  w: watch                                                                           │
│   20:11     bot   Hi! I am Example Bot. Pick an option:                             ⏱6s #677789  │
│         [ Settings ] [ Help ]                                                                    │
│   21:02     you   /settings                                                             #677790  │
│ ▸ 21:02     bot   ⚠ Something went wrong                                            ⏱6s #677791  │
│         [ Retry ] [ Back ]                                                                       │
│   21:03     bot   Main menu                                                         ⏱1m #677792  │
│         [ Settings ] [ Help ]                                                                    │
│ b: buttons  n: send  r: rec  f: diff  ⏱ live                                                     │
│ 0 selected a: → main i: [Fix] [ send ] d: all c: clear p: pin l: ledger                          │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The row with `j: down k: up x: select v: range h: back` is below the frame: Compact never shows
how to select or go back.

**9. Transcript.** One message sent to main is about 30 transcript rows of `<tg-packet>` XML. The
owner chose a visible prompt so the person sees what the model reads (94e042a); that stays true
with a one-row drawing, since ctrl+o shows the packet (probe, §1).

**10–13.** Seen live: `/: search` (the key is `s`), `s: ⏎ start`, `skip:dangerouslySkipHardStops:
all | publish,delete [… ` (label and placeholder run together), `repos: ~/code/app` (a placeholder,
not a setting). The status line is the engine's pinned-notice style, yellow with `⚠`, so routine
counts look like alarms. `⚡` is two cells wide where every other glyph is one.

## 3. Principles

1. **One letter, one meaning**, in every view of the pane and in the band. A sheet that needs more
   choices uses digits, never a reused letter.
2. **Digits pick what is numbered on screen**: a lens, a button of the message under the cursor,
   an intent, a target, a level. Only the active column's digits are live, so two Buttons never
   share a hotkey.
3. **⏎ is the primary action of the row under the cursor.** The focus ring always sits on that row;
   inside a sheet it sits on the sheet's main button.
4. **Show the verbs, not the navigation.** One action bar with at most seven keys for the current
   context; the menu (`m`) has the rest. A key that does nothing now is not drawn.
5. **Say who has the keys.** `● keys` when the pane holds them, `ctrl+x tab: keys` and a dim action
   bar when it does not.
6. **Calm by default.** Dim text for state, color only for what needs attention, the yellow status
   line only for alarms.
7. **The engine decides the seat; the pane fits it.** No mode to pick: dock gets two columns,
   inline gets one, closed is Hidden.

## 4. The new interaction model

### 4.1 What lives where

| Surface | When | Holds |
| --- | --- | --- |
| Pane, **dock** (fullscreen ≥ 110 columns) | open | chats on top, the open chat below, one action bar; a sheet or card takes the lower part |
| Pane, **inline** (main screen) | open | one view at a time: chats, a chat, a card; header and action bar around it |
| **Band** above the prompt | something needs the owner | a queue, most urgent first: hard stop (mirror), draft, undo window, watched reply, summary, task news |
| **Footer label** (`SessionMode`) | always, while anything is on | `tg 22 · ⟳1 ↯1 · 2 for you` |
| **Hint tail** (`PromptHint`) | while the band holds items | `tg: 2 for you · ctrl+x tab` |
| **Status line** (`$.ui.status`, yellow ⚠) | alarms only | a hard stop waiting, skipped stops while delegate runs, not logged in |
| **Transcript** | after a send | one row per packet (`UserMessage`); `/tg status` and `/tg help` as cards (`CommandOutput`) |
| **`/tg`** | any time, any focus | `/tg` open · `/tg stop` · `/tg status` · `/tg help` · `/tg hide`, registered `immediate` |

Hidden is the pane closed: the footer label, the hint tail and the band carry on alone. `q` or the
engine's ✕ hides; `/tg` opens.

### 4.2 Views

```text
/tg ──▶ Chats ──⏎──▶ Chat ──⏎ on a message──▶ Send sheet ──a──▶ Targets
          │            │                         └──i──▶ Inspect
          │            ├──a──▶ Agent card ──o──▶ Options: limits, topics, grant, danger zone
          │            └──f, r──▶ Diff · Recording stopped
          └──l──▶ Activity: running and log

Any view: h back one level · m menu · 0 stop everything · q hide the pane
```

`h` always goes one level up: clear the marks, close the sheet, close the card, leave the chat. Esc
stays the engine's: it hands the keys back to the prompt and leaves the pane as it is.

In the dock, Chats stay on screen above the chat, and the card, sheet, diff and activity take the
lower part. Inline, each view takes the body.

### 4.3 Input model

- **⏎** — the primary action of the cursor row (open, send…, send draft, start).
- **Letters** — verbs with one meaning each (§6).
- **Digits** — numbered options on screen; **0** — stop everything (drawn while something runs).
- **j/k and the arrows** — move; the cursor follows the ring, the ring follows the cursor.
- **Sheets** — a short strip that takes the action bar's place (send, targets, recording); its keys
  are drawn in it; ⏎ is its main button.
- **Menu (`m`)** — every key valid here, grouped (message, chat, chats, pane, safety); each label is
  a Button, so the menu is also the palette.
- **Mouse** — every key label is a Button, so a click does what the key does; a click on a row is ⏎.
- **Focus** — the header says `● keys` or `ctrl+x tab: keys`; the action bar dims without the keys.

### 4.4 Discoverability

| Layer | What it teaches |
| --- | --- |
| Action bar | the ≤ 7 verbs for the cursor row, in the engine's `k: label` form |
| Menu `m` | every key, and the ones that do not apply now dimmed with the reason ("needs two marked bot replies") |
| First open | a three-line "start here" block on Chats until `d` |
| Empty and error states | one sentence and one key: `Nothing unread. 1: All` |
| `/tg help`, `/tg status` | the same key table, and what runs, as cards in the transcript |
| Typeahead | `/tg  Telegram pane: chats, send to Claude, bots, agents · /tg stop` |
| Hint tail | `ctrl+x tab` appears under the prompt exactly when the band has something |

### 4.5 State at a glance

One summary, three places (the pane's header, the footer label, `/tg status`):
`tg 22 · ⌁1 ◉1 ✎1 ⟳1 ↯1 · ◎ 3 new · 2 for you`.

| Part | Means |
| --- | --- |
| `tg 22` | unread messages (the footer only; the pane shows them per chat) |
| `⌁1 ◉1 ✎1 ⟳1 ↯1` | chats with an agent on, by level: follow, summarize, draft, auto, delegate |
| `◎ 3 new` | new messages in watched chats |
| `2 for you` | drafts and hard stops waiting for the owner (yellow in the pane) |

Zero counts are left out. The band shows what the owner can act on, one item at a time with
`1/3 j: next`; an item already on screen in the pane is skipped. The status line turns yellow only
for: a hard stop waiting (`$.ui.notify` too), stops skipped while delegate runs, not logged in.

## 5. Core flows

Each flow: the steps today and in this design, then mockups at the real widths. Key counts start
with the pane holding the keys and the cursor on the right row. `[…]` in a mockup marks the focus
ring (the engine draws it inverse).

| Flow | Today | New |
| --- | --- | --- |
| Send a message to main (Fix) | `x a 1 ⏎` · 4 | `⏎ 1` · 2 (`⏎ ⏎` repeats the last intent) |
| … as Explain | `x i i ⏎` · 4 | `⏎ 3` · 2 |
| … to another agent as Test | `x a i i i 2 ⏎` · 7 | `⏎ a 2 4` · 4 |
| … from Hidden (a watched reply) | `ctrl+x tab ⏎` · 2 | `ctrl+x tab ⏎` · 2, the band says which intent |
| Press a bot's button | `b`, arrows, `⏎` · 2–3 | `1` · 1 |
| Recording → a test brief for an agent | `r … r`; no way to hand it over | `r … r 1`, then the sheet · 3 |
| Diff two replies | `x`, move, `x f` · 3 + moves | `f` · 1 (pairs with the last reply to the same message) |
| Watch · summary · rank | `w` · `t` · `y` · 1 each | the same keys, in the action bar or the menu |
| Autopilot `draft` on | find `q`, then `q s` · 2 | `a ⏎` · 2, every level shown |
| `auto` on a chat not in allow.toml | `q 3 Esc` type 25 chars `⏎ ctrl+x tab q q 3 s` · 9 + typing | `a 4 ⏎ Esc ⏎ ctrl+x tab ⏎` · 7, nothing typed |
| Send a waiting draft | `ctrl+x tab ⏎` · 2 | the same from Hidden; `⏎` on the draft row in the pane · 1 |
| `delegate` on, working in this repo | `q 4 4`, Tab or Shift+Tab to the repos field, type the path, `⏎ s` · 6 + Tabs + typing | `a 5 ⏎ ⏎` · 4 (the repo is filled in) |
| Stop everything | Tab to "stop all" ⏎, or `/tg autopilot off` after main's turn | `0` · 1; `/tg stop` runs at once |

### 5.0 Home

```text
Wide · dock, 64 columns · a bot thread open, the pane holds the keys
┌────────────────────────────────────────────────────────────────┐
│tg › @example_bot                                    ◎1   ● keys│
│All  Bots  Unread  Work  you↑                          s: search│
│›   ◆ @example_bot                            ◎     2      21:02│
│    # Dev Team                                      5      20:59│
│    • Contact A                                     1      20:49│
│    • Contact B                                            16:34│
│    ★ Saved Messages                                   yesterday│
│    ◆ @BotFather                              ro           10-08│
│    # Announcements                                14      19:19│
│─ @example_bot · bot · ◎ watched ───────────────────────────────│
│   20:11 you  /start                                            │
│   20:11 bot  Hi! I am Example Bot. Pick an option:             │
│              [Settings] [Help]                                 │
│   21:02 you  /settings                                         │
│▸  21:02 bot  ⚠ Something went wrong                ⏱6s  #677791│
│              1: Retry  2: Back                                 │
│   21:03 bot  Main menu                                         │
│              [Settings] [Help]                                 │
│                                                                │
│⏎ send…  1-2: press  n: write  r: rec  f: diff  x: mark  m: menu│
└────────────────────────────────────────────────────────────────┘
```

The dock: chats on top, the open chat below. `›` marks the open chat while the cursor (`▸`) is in
the thread. The lens row is live (digits) only while the cursor is in the list; here digits press
the message's buttons.

```text
Wide · the same pane while the prompt holds the keys
┌────────────────────────────────────────────────────────────────┐
│tg › @example_bot                          ◎1   ctrl+x tab: keys│
│  (rows as above, unchanged)                                    │
│ctrl+x tab, then: ⏎ send…  1-2 press  n write  r rec  m menu    │
└────────────────────────────────────────────────────────────────┘
```

```text
Compact · inline, 100 columns, 12 rows · chats
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › chats   1: All  2: Bots  3: Unread  y: you↑   s: search          ⟳1 ↯1 · 2 for you   ● keys │
│ ▸ ⟳ # Dev Team                                                                ◎     5      20:59 │
│     ◆ @example_bot                                                            ◎     2      21:02 │
│   ✎ • Contact A                                                                     1      20:49 │
│   ↯ • Contact B                                                                            16:34 │
│     ★ Saved Messages                                                                   yesterday │
│     ◆ @BotFather                                                              ro           10-08 │
│     # Announcements                                                                14      19:19 │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ open  a: agent  w: watch  y: you↑  l: activity  0: stop all  m: menu                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Compact · a bot thread (chips sit on the message row from 90 columns)
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › @example_bot · ◎ watched                                         ⟳1 ↯1 · 2 for you   ● keys │
│    20:11 you  /start                                                                             │
│    20:11 bot  Hi! I am Example Bot. Pick an option:                    [Settings] [Help]         │
│    21:02 you  /settings                                                                          │
│ ▸  21:02 bot  ⚠ Something went wrong                            1: Retry  2: Back   ⏱6s  #677791 │
│    21:03 bot  Main menu                                                [Settings] [Help]         │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ send…  1-2: press  n: write  r: rec  f: diff  x: mark  a: agent  h: chats  m: menu             │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Hidden · the pane is closed; 100 columns
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────
  ~/code/app (main)  Opus 5.5                                              tg 22 · ⟳1 ↯1 · 2 for you
  ⏵⏵ auto mode on (shift+tab to cycle) · tg: 2 for you · ctrl+x tab
```

```text
Wide · the first open (the block stays until d)
┌────────────────────────────────────────────────────────────────┐
│tg › chats                                                ● keys│
│─ start here ─────────────────────────────────────── d: got it ─│
│⏎ opens a chat · ⏎ on a message sends it to Claude              │
│a: hand a chat to an agent · w: notify me · 0: stop all         │
│m: every key, any time · keys work while ● keys shows           │
│────────────────────────────────────────────────────────────────│
│1: All  2: Bots  3: Unread  y: you↑                    s: search│
│▸   ◆ @example_bot                                  2      21:02│
│    # Dev Team                                      5      20:59│
│  …                                                             │
│⏎ open  a: agent  w: watch  y: you↑  l: activity  m: menu       │
└────────────────────────────────────────────────────────────────┘
```

```text
Wide · m: the menu (every key for here; each label is pressable)
┌────────────────────────────────────────────────────────────────┐
│tg › menu · @example_bot                                  ● keys│
│move      j k ↑ ↓ · ⏎ does the row's action                     │
│message   ⏎ send…  x: mark  v: range  1-9: press  i: inspect    │
│          mark the whole loaded thread                          │
│chat      a: agent…  w: watch  p: follow → main  t: summary     │
│          n: write  r: record  f: diff  b: buttons              │
│chats     1-9: lens  y: you↑  s: search  z: lenses…             │
│pane      l: activity  g: reload  h: back  q: hide              │
│safety    0: stop every agent and Worker · /tg stop             │
│keys      only while ● keys shows; ctrl+x tab hands them over   │
│          Esc gives them back to the prompt                     │
│h: back                                                         │
└────────────────────────────────────────────────────────────────┘
```

### 5.1 Select → send to main or an agent, with an intent

⏎ on a message opens the send sheet for it, or for the marked set when messages are marked (`x`,
`v`). Digits send at once with that intent; ⏎ sends the ringed one, the last used for this kind of
chat (bots start on Fix, people and groups on Ask). `a` picks another agent, `i` shows what the
agent will read. `6` asks in the owner's words: a field in the sheet, sent as the packet's intent
line, so nothing is typed in the prompt. The transcript keeps one row per packet.

```text
Flow 1 · Wide · ⏎ on a message opens the send sheet (it takes the action bar's place)
┌────────────────────────────────────────────────────────────────┐
│tg › @example_bot                                    ◎1   ● keys│
│  (list and thread as on the home screen)                       │
│▸  21:02 bot  ⚠ Something went wrong                ⏱6s  #677791│
│              [Retry] [Back]   (the sheet owns the digits now)  │
│   21:03 bot  Main menu                                         │
│─ send #677791 + 1 parent ────────────────────── → main · idle ─│
│[1: Fix]  2: Reproduce  3: Explain  4: Test  5: Draft reply     │
│6: Ask in my words…   a: another agent   i: inspect (3 masked)  │
│⏎ sends the ringed one (last used)   h: cancel                  │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 1 · Wide · a: another agent (the radar; digits pick)
┌────────────────────────────────────────────────────────────────┐
│─ send #677791 to ──────────────────────────────────────────────│
│1: main (this session)                                    · idle│
│2: tester          general-purpose                     … running│
│3: reviewer        teammate                               · idle│
│4: + a new agent, this packet as its brief                      │
│5: ⇉ several agents, an intent each                             │
│h: back                                                         │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 1 · Wide · i: inspect (what the agent will read)
┌────────────────────────────────────────────────────────────────┐
│─ inspect · main reads this ────────────────────────── h: back ─│
│@example_bot (bot) · Fix · redacted                             │
│#677791 bot  "⚠ Something went wrong" · buttons Retry, Back     │
│+ parent #677790 you  "/settings"                               │
│replay  tg send @example_bot /settings --wait 10s               │
│masked  1001 → [id-1] · 1003 → [id-2] · Me → [name-1]           │
│[redaction: on]   ⏎ turns it off for this packet                │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 1 · Wide · 6: Ask in my words (a field in the sheet; no trip to the prompt)
┌────────────────────────────────────────────────────────────────┐
│─ send #677791 + 1 parent ────────────────────── → main · idle ─│
│ask: why does Retry fail right after /settings?█                │
│⏎ sends with these words · ⏎ on an empty field goes back        │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 1 · Compact · the sheet takes the last two rows
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › @example_bot · ◎ watched                                                             ● keys │
│    20:11 you  /start                                                                             │
│    20:11 bot  Hi! I am Example Bot. Pick an option:                    [Settings] [Help]         │
│    21:02 you  /settings                                                                          │
│ ▸  21:02 bot  ⚠ Something went wrong                            [Retry] [Back]      ⏱6s  #677791 │
│    21:03 bot  Main menu                                                [Settings] [Help]         │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ send #677791 + 1 parent → main   [1: Fix]  2: Reproduce  3: Explain  4: Test  5: Draft  6: Ask…  │
│ ⏎ the ringed one   a: another agent   i: inspect (3 masked)   h: cancel                          │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Flow 1 · Hidden · a watched bot replied; ⏎ sends it to main; the transcript keeps one row
◆ @example_bot replied ⏱1.4s: "⚠ Something went wrong"                                  1/2  j: next
  ctrl+x tab ›  ⏎ send to main as Fix   o: open   d: dismiss
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 

transcript, after ⏎ (ctrl+o shows the whole packet):
› Prompt from the dialogs-pane plugin
▣ tg packet → main · Fix · @example_bot #677791 (+1 parent, 3 masked)   ctrl+o shows it
```

### 5.2 Bot testing: send, press, record, diff

The cursor message's buttons get the digits (`1: Retry 2: Back`); other messages draw theirs in
brackets. A chat not in allow.toml, or BotFather, draws them dim with `ro`, and a press says why
instead of running tg. `n` writes, `r` records, `f` diffs. Results land in place, with one notice
row instead of toasts.

```text
Flow 2 · Wide · 1 pressed Retry while recording
┌────────────────────────────────────────────────────────────────┐
│tg › @example_bot                               ● rec 3   ● keys│
│  (list as on the home screen)                                  │
│─ @example_bot · bot · ◎ watched ───────────────────────────────│
│   21:09 you  /settings                                         │
│   21:09 bot  ⚠ Something went wrong                       ⏱1.1s│
│▸  21:10 bot  Settings saved   (edited)           ⏱1.3s  #677801│
│              1: Back                                           │
│pressed Retry → edited in place · the bot said "Saved"          │
│⏎ send…  1: press  n: write  r: stop rec  f: diff  m: menu      │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 2 · Wide · f on a reply: diff against the last reply to the same message
┌────────────────────────────────────────────────────────────────┐
│─ diff #677791 → #677801 ──────────────────────────── f: close ─│
│- ⚠ Something went wrong                                        │
│+ Settings saved                                                │
│keyboard  row 0  [Retry] [Back] → [Back]                        │
│          - Retry  cb "retry"                                   │
│            Back   cb "back" (same)                             │
│x x then f compares any two marked replies                      │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 2 · Wide · r again: the recording is a test brief, not just a file
┌────────────────────────────────────────────────────────────────┐
│─ recording stopped · 3 steps ───────────────────── d: discard ─│
│.tg-recordings/2110-example_bot.sh (in this repo, git-ignored)  │
│1: hand to an agent as a live test   2: copy the path           │
│⏎ ok                                                            │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 2 · Compact · recording, latency on each reply
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › @example_bot · ◎ watched                                                   ● rec 3   ● keys │
│    21:09 you  /settings                                                                          │
│    21:09 bot  ⚠ Something went wrong                                                       ⏱1.1s │
│ ▸  21:10 bot  Settings saved   (edited)                                 1: Back   ⏱1.3s  #677801 │
│    21:10 you  /ping                                                                              │
│    21:10 bot  pong                                                                         ⏱0.4s │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ pressed Retry → edited in place · the bot said "Saved"                                           │
│ ⏎ send…  1: press  n: write  r: stop rec  f: diff  x: mark  h: chats  m: menu                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Hidden: a watched bot's reply is the band item of 5.1 (`◆ @example_bot replied ⏱1.4s`).

### 5.3 Triage: watch, summary, needs-you

`w` watches (the owner is told), `t` summarizes the open chat, `y` ranks chats and now says why
(`asks you`, `mentions you`, `fyi`, `noise`). Watched replies reach the band and the footer label
(`◎ 3 new`) in every mode.

```text
Flow 3 · Wide · y ranks the chats and says why; t summarizes the open one
┌────────────────────────────────────────────────────────────────┐
│tg › chats · you↑                                    ◎2   ● keys│
│1: All  2: Bots  3: Unread  y: you↑ on                 s: search│
│▸   • Contact A         asks you                    1      20:49│
│›   # Dev Team          mentions you          ◎     5      20:59│
│    ◆ @example_bot      fyi                   ◎     2      21:02│
│    # Announcements     noise                      14      19:19│
│─ Dev Team · group · ◎ watched ─────────────────────── t: hide ─│
│summary of 6: Member 2 opened a PR for the flaky checkout test; │
│Member 1 is reviewing; deploy is green. Nothing asks you.       │
│   20:58 Member 1 reviewing now                                 │
│   20:59 Member 1 deploy is green                               │
│⏎ open  a: agent  w: watch  t: summary  y: you↑  m: menu        │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 3 · Compact · ranked chats
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › chats · you↑   1: All  2: Bots  3: Unread  y: you↑ on   s: search               ◎2   ● keys │
│ ▸   • Contact A         asks you                                                    1      20:49 │
│     # Dev Team          mentions you                                          ◎     5      20:59 │
│     ◆ @example_bot      fyi                                                   ◎     2      21:02 │
│     # Announcements     noise                                                      14      19:19 │
│     • Contact B                                                                            16:34 │
│     ★ Saved Messages                                                                   yesterday │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ open  a: agent  w: watch  t: summary  y: you↑  l: activity  m: menu                            │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Flow 3 · Hidden · the band is a queue of what needs you, most urgent first
● Dev Team (◎ watched): Member 1 "can you review the PR?"                               1/3  j: next
  mentions you   ctrl+x tab ›  ⏎ open   d: dismiss
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────
  ~/code/app (main)  Opus 5.5                                            tg 22 · ◎ 3 new · 2 for you
```

### 5.4 Autopilot on for a chat, and drafts

`a` opens the agent card for the cursor's or the open chat: one question, "what may an agent do in
this chat?", and a ladder that shows every level with what it does. A digit picks a level, ⏎ starts
or stops it. Below the ladder only what matters for that level; the rest (limits, quiet hours,
topics) is behind `o`. `follow` is today's pin, `summarize` today's `listen`.

```text
Flow 4 · Wide · a: the agent card for a chat (it takes the thread's place; the list stays)
┌────────────────────────────────────────────────────────────────┐
│tg › agent for Contact A                          ○ off   ● keys│
│  (list rows)                                                   │
│─ what may an agent do in Contact A? ───────────────────────────│
│  1: ⌁ follow     new messages go to main's context             │
│  2: ◉ summarize  a summary above your prompt; never writes     │
│▸ 3: ✎ draft      drafts each reply; you send it                │
│  4: ⟳ auto       replies alone within limits; unsure → draft   │
│  5: ↯ delegate   replies and does the work · needs allow.toml  │
│brief  none yet · e: write one (tone, promises, facts)          │
│asks   money · dates · promises · opinions · personal data      │
│⏎ start draft   o: limits…   h: back                            │
└────────────────────────────────────────────────────────────────┘
```

When a level needs allow.toml, the card says so and ⏎ puts the command in the prompt
(`$.prompt.fill`); the human still runs it. The card re-reads the allowlist after any `!` command
(the stale cache of §2.4 is fixed).

```text
Flow 4 · Wide · 4: auto on a chat that is not in allow.toml
┌────────────────────────────────────────────────────────────────┐
│▸ 4: ⟳ auto       replies alone within limits; unsure → draft   │
│limits 50/h · one per burst · gap 20 s · conf ≥ 0.80   o: change│
│writes ✗ Contact A is not in allow.toml, and auto sends alone   │
│       ⏎ puts  ! tg allow add 1004 --yes  in your prompt        │
│       (Esc, then Enter runs it; this card notices)             │
└────────────────────────────────────────────────────────────────┘
```

A draft is a row of its chat's thread, so in the pane it needs no ctrl+x tab. The guard's verdict
shows before ⏎ (the dry run runs when the draft appears).

```text
Flow 4 · Wide · a draft waits in its thread; ⏎ sends it, e edits, d drops
┌────────────────────────────────────────────────────────────────┐
│tg › Contact A                           ✎1 · 1 for you   ● keys│
│  (list rows)                                                   │
│─ Contact A · person · ✎ draft ─────────────────────────────────│
│   18:40 you       the draft is in the shared folder            │
│   19:40 Contact A got it, reading                              │
│   20:49 Contact A Can we call tomorrow at 10?                  │
│▸  ✎ draft to Contact A                                         │
│   Tomorrow is packed, can I write after 18?                    │
│   dates · conf 0.62 · ✓ the guard allows it                    │
│⏎ send draft  e: edit  d: drop  a: agent  m: menu               │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 4 · Compact · the card in 12 rows
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › agent for Contact A                                                          ○ off   ● keys │
│   1: ⌁ follow     new messages go to main's context                                              │
│   2: ◉ summarize  a summary above your prompt; never writes                                      │
│ ▸ 3: ✎ draft      drafts each reply; you send it                                                 │
│   4: ⟳ auto       replies alone within limits; unsure → draft                                    │
│   5: ↯ delegate   replies and does the work, with tools you grant · needs allow.toml             │
│ brief  tone: short, friendly · may promise: nothing without asking me                    e: edit │
│ asks   money · dates · promises · opinions · personal data                                       │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ start draft   o: limits…   h: back   m: menu                                                   │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Flow 4 · Hidden · a draft, then an auto reply's undo window
✎ Contact A: "Can we call tomorrow at 10?" → "Tomorrow is packed, can I write after 18?"         1/2
  dates · conf 0.62   ctrl+x tab ›  ⏎ send   e: edit   d: drop   o: open   j: next

⟳ Dev Team replied "Merged, thanks" · conf 0.93
  ctrl+x tab ›  u: undo 28s   d: ok
```

### 5.5 Delegate: the grant, hard stops, the task card

`5` is always listed; while it cannot start, the row says why (`needs allow.toml`, `needs the
guard`). The warning is a step of its own. The grant is filled from where the owner is: the repo of
the session's working directory, web read-only, the repo's checks, until done. `↓` walks the
fields; Selects change them; `e` edits the repos. Skipping hard stops lives in `o` → danger zone,
with the typed confirmation as built.

```text
Flow 5 · Wide · 5: delegate asks once per chat
┌────────────────────────────────────────────────────────────────┐
│tg › agent for Contact B                          ○ off   ● keys│
│─ ↯ delegate Contact B? ────────────────────────────────────────│
│Whoever writes in Contact B steers an agent that has tools:     │
│your repos (a fresh worktree per task) and the web. The grant   │
│limits what it reaches; hard stops ask you before anything      │
│that cannot be undone. Use it for people you trust, never a     │
│group.                                                          │
│⏎ I understand, set it up   h: back                             │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 5 · Wide · the grant, filled from where you are; ↓ walks it, ⏎ changes a field
┌────────────────────────────────────────────────────────────────┐
│tg › agent for Contact B · ↯ delegate             ○ off   ● keys│
│grant    repos     ~/code/app (this session's repo)   e: edit   │
│         web       read-only ▾                                  │
│         commands  the repos' checks ▾                          │
│         until     the task is done ▾                           │
│stops    ask you: money · publish · share · delete · deadlines  │
│guard    ✓ dialogs-pane-guard answering                         │
│writes   ✓ in allow.toml                                        │
│⏎ start delegate   o: limits & safety…   h: back                │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 5 · Wide · a task runs: one line in the strip, the card on top of its thread
┌────────────────────────────────────────────────────────────────┐
│tg › Contact B                                    ↯1 ⟳1   ● keys│
│↯ Contact B · task 42 min · ⟳ Dev Team · auto 3/50   0: stop all│
│  (list rows)                                                   │
│─ Contact B · ↯ delegate ───────────────────────────────────────│
│↯ add a payment provider · 42 min                      ⏎ details│
│  ✓ read docs on docs.example.com (3)                           │
│  ✓ worktree app-task-3 · branch tg/add-payment-provider-3      │
│  … edit src/pay/webhook.py                                     │
│  chat: "on it, will send a PR link today" (14:10)              │
│   14:09 Contact B could you add a payment provider?            │
│⏎ send…  a: agent  l: activity  0: stop all  m: menu            │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 5 · Compact · the grant step in 12 rows
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › agent for Contact B · ↯ delegate                                             ○ off   ● keys │
│ grant    repos  ~/code/app (this session's repo)                                         e: edit │
│          web  read-only ▾      commands  the repos' checks ▾      until  the task is done ▾      │
│ stops    ask you: money · publish · share · delete · deadlines                                   │
│ guard    ✓ dialogs-pane-guard answering        writes  ✓ in allow.toml                           │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ start delegate   o: limits & safety…   h: back   m: menu                                       │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

A hard stop keeps the engine's dialog (No listed first). The pane, the band and the footer mirror
it; the status line is the alarm, and `$.ui.notify` reaches an owner who is in another window.

```text
Flow 5 · Hidden · a hard stop: the engine's dialog takes the keys; the status line is the alarm
╭─ HARD STOP ──────────────────────────────────────────────────────────────╮
│ HARD STOP publish (Worker for Contact B): git -C …/app-task-3 push -u    │
│ origin tg/add-payment-provider-3. Allow it?                              │
│ ❯ 1. No                                                                  │
│   2. Yes, allow it                                                       │
╰──────────────────────────────────────────────────────────────────────────╯
  ⚠ dialogs-pane: tg ⏸ HARD STOP publish · ↯ Contact B · answer in the dialog
  ~/code/app (main)  Opus 5.5                                              tg 22 · ⟳1 ↯1 · 1 for you
```

### 5.6 Stop everything

`0` stops every follow, autopilot and Worker from any view of the pane, whenever something runs (it
is drawn red only then). `/tg stop` does the same from the prompt and, being `immediate`, runs while
main is mid-turn. Settings stay; the card restarts a chat.

```text
Flow 6 · Wide · 0 stops every agent from any view of the pane
┌────────────────────────────────────────────────────────────────┐
│tg › chats                                     ⌁1 ⟳1 ↯1   ● keys│
│⌁ @example_bot → main · ⟳ Dev Team · ↯ Contact B     0: stop all│
│  …                                                             │
│─ after 0 ──────────────────────────────────────────────────────│
│tg › chats                                                ● keys│
│■ stopped: Dev Team (auto), Contact B (delegate, its Worker),   │
│  @example_bot (follow). Settings kept; a restarts one.         │
└────────────────────────────────────────────────────────────────┘
```

```text
Flow 6 · Compact · 0: stop all sits in the action bar while anything runs
╭───────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ tg › chats                                                                     ⌁1 ⟳1 ↯1   ● keys │
│   (chat rows)                                                                                    │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│                                                                                                  │
│ ⏎ open  a: agent  w: watch  l: activity  0: stop all  m: menu                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

```text
Flow 6 · Hidden · /tg stop runs at once, even while main is mid-turn (immediate)
❯ /tg stop
  ⎿  tg: stopped Dev Team (auto), Contact B (delegate and its Worker), @example_bot (follow).
      Settings are kept; /tg, then a, restarts one.
```

### 5.7 Activity

`l` merges the packet ledger, the autopilot ledger and the guard's stop events by time, under what
runs now. ⏎ on a running row opens its card or task.

```text
Activity · l: what runs and what happened, in one place
┌────────────────────────────────────────────────────────────────┐
│tg › activity                      ⌁1 ⟳1 ↯1 · 1 for you   ● keys│
│─ running ──────────────────────────────────────── 0: stop all ─│
│▸ ⟳ Dev Team       auto 3/50 · listening                        │
│  ↯ Contact B      task 42 min · edit src/pay/webhook.py        │
│  ⌁ @example_bot   follows → main · live                        │
│  ◎ watching       @example_bot · Dev Team                      │
│─ log ──────────────────────────────────────────────────────────│
│  21:14 ⟳ Dev Team   sent "Merged, thanks" · 0.93 · u: undo 28s │
│  21:10 ↯ Contact B  ⏸ publish: git push … → you said no        │
│  21:02 ▣ → main     #677791 @example_bot · Fix · ✓ done        │
│  20:58 ✎ Contact A  draft waits · dates · 0.62                 │
│⏎ open  d: dismiss  h: back  m: menu                            │
└────────────────────────────────────────────────────────────────┘
```

## 6. Keymap

In the pane; the band uses the same letters for the same things.

| Key | Means | Drawn |
| --- | --- | --- |
| `j` `k`, ↓ ↑ | move | menu |
| ⏎ | the primary action of the cursor row: open · send… · send draft · start | action bar, first |
| `h` | back one level: marks → sheet → card → chat → chats | action bar |
| `m` | menu: every key here, pressable | action bar, last |
| `q` | hide the pane (`/tg` reopens) | menu |
| `0` | stop every follow, autopilot and Worker | red, only while something runs |
| `1`–`9` | the numbered options on screen: lens (chats) · the cursor message's buttons (chat) · intent or target (sheet) · level (card) | next to each option |
| `x` | mark or unmark a message | chat |
| `v` | mark a range (start, then end) | chat |
| `a` | agent card for this chat; in the send sheet: another agent | chats, chat |
| `w` | watch: tell me about new messages here | chats, chat |
| `p` | follow → main (ladder level 1) on or off | menu |
| `t` | summary of the open chat | chat |
| `y` | rank chats by needs-you | chats |
| `s` | search chats | chats |
| `z` | lens editor | menu |
| `n` | write a message to this chat | chat |
| `b` | ring onto the buttons (past nine, or link buttons) | menu |
| `r` | record sends and presses; again stops | bot chats |
| `f` | diff two replies | bot chats |
| `i` | inspect what an agent would read | sheet, chat |
| `e` | edit the draft, brief or lens in focus | where one is |
| `d` | drop or dismiss: a draft, a notice, a finished task, the start block | where one is |
| `u` | undo the last auto reply (30 s) | while its window is open |
| `o` | open: the chat (chats, same as ⏎), the item's chat (band), the card's options | band, card |
| `l` | activity: running and log | chats |
| `g` | reload, retry after an error | error rows |
| `c` | not bound (kept free) | — |

Band (after ctrl+x tab): ⏎ the item's action · `e` edit · `d` drop or dismiss · `o` open in the
pane · `u` undo · `j` `k` next and previous item.

What changes for keys the owner already uses:

| Key | Today | New |
| --- | --- | --- |
| `j k o x v h s`, `1`–`3` | as today | as today |
| ⏎ on a message | toggle the selection | open the send sheet |
| `m` | mode cycle | menu (the layout follows the seat) |
| `a` | route picker | agent card (routing moves into the send sheet) |
| `i` | intent cycle | inspect (intents are digits in the sheet) |
| `d` | select the whole thread | drop or dismiss (whole thread: menu) |
| `c` | clear the selection | free (`h` clears) |
| `q` | autopilot card | hide the pane |
| `l` | packet ledger | activity (both ledgers) |
| `0` | — | stop everything |

## 7. Visual system

### 7.1 Tokens

The palette names stay (they follow the theme). What changes is when color is used.

| Token | Value | Only for |
| --- | --- | --- |
| `accent` | cyan | the location, the cursor `▸`, `● keys`, the chosen level, key letters (the engine's) |
| `bot` | magenta | the `◆` glyph |
| `unread` | bold | unread chat names and counts |
| `muted` | dim | time, ids, descriptions, the action bar without the keys, the footer label |
| `ok` | green | `✓` sent, done, allowed |
| `warn` | yellow | `for you` items, slow latency, flood wait, a watch retrying, `⏸` |
| `danger` | red | error replies, `✗` failures, `0: stop all`, `⚠ no stops` |

Marked messages get `▪` in the mark column, not inverse text: inverse is the engine's focus ring.

### 7.2 Glyphs

One glyph, one meaning, each one cell wide (checked with East Asian Width; `⚡` is two, so it goes).

| Group | Glyphs |
| --- | --- |
| Chat kind | `◆` bot · `#` group or channel · `•` person · `★` Saved Messages |
| Agent level | `⌁` follow · `◉` summarize · `✎` draft · `⟳` auto · `↯` delegate |
| For the owner | `◎` watched · `ro` read-only |
| Rows | `▸` cursor · `›` open chat (cursor elsewhere) · `▪` marked |
| State | `…` working · `✓` done · `✗` failed · `■` stopped · `⏸` waiting for you · `⚠` error · `○` off · `●` on |
| Things | `▣` packet · `⏱` latency |

### 7.3 Layout

Dialog row, both seats: cursor 2 · level 2 · kind 2 · name (flex) · watch 2 · unread 4 · time 10.

Message row: cursor 1 · mark 1 · time 5 · sender (3 in bot chats, up to 10 in groups) · text (flex)
· latency and id at the right, the id on the cursor row only. A day divider (`── yesterday ──`)
replaces dates in the time column. From 90 columns a message's buttons sit on its own row's right.

Budgets: the dock spends at most three rows on chrome (header, lens row while in Chats, action bar)
plus what is temporary (running strip, a sheet, one notice). Inline spends two (header, action bar).
Cards align their labels in a 7-column left column (`brief`, `limits`, `asks`, `writes`, `grant`,
`stops`, `guard`).

### 7.4 States

| State | Shows |
| --- | --- |
| loading | dim `…` rows, `…` in the header; no spinner |
| empty lens | what the lens shows and one key: `Nothing unread. 1: All` |
| error | one red line and `g: retry` |
| flood wait | yellow `Telegram asks to wait 23 s · retrying`, counting down |
| not logged in | `Not logged in. ⏎ puts ! tg login in your prompt` (login stays a human act) |
| tg missing | `tg is not on PATH. README → Install` and `g: retry` |
| read-only chat | dim buttons and `ro`; a press explains, runs nothing |
| guard missing | the card's `guard` row in red with how to install it; delegate dim |
| keys elsewhere | `ctrl+x tab: keys` in the header, the action bar dim |

## 8. Implementation plan

Tasks for builder agents, each on its own branch from `design/pane-ux` (the doc is its spec), in
its own worktree, with the repo's checks (`tsc -p mods/dialogs-pane`, `claude plugin validate`,
`claude plugin test`, `uv run pytest`) and a live run on the fake tg at 64-column dock and 100×12
inline. Each keeps its `$` code in its marked block of `register.tsx` as today.

```text
T0a fake tg          ─┐
T0b kill switch now  ─┤  independent and small: any time, before T1 is fine
T0c allowlist fix    ─┘
T1 frame, keys, menu, focus ──┬─▶ T2 send sheet ──┬─▶ T6 bot testing ──┐
                              ├─▶ T3 agent card    │                    ├─▶ T7 onboarding, states, docs
                              ├─▶ T4 running, stop │                    │
                              └─▶ T5 footer, band, transcript ─────────┘
```

With one builder at a time: T0b, T0c, T1, T4, T2, T5, T3, T6, T7. Safety first, then the flow the
owner uses most (send), then what runs at a glance, then the agent card.

**T0a — a fake tg for live runs** (½ h, optional). `mods/dialogs-pane/dev/fake-tg` answering
`dialogs`, `read`, `msg`, `whoami`, `allow list`, `send` (with `--dry-run`), `press`, `delete` and
`watch` (live events from a spool file) with placeholder chats only. Appendix A lists the calls.
Every builder before this one wrote their own.

**T0b — the kill switch, on today's pane** (1–2 h; before the redesign). Register `/tg` with
`immediate: true`; add `/tg stop` beside `/tg autopilot off`; give today's "stop all" Button the
hotkey `0` (free in the pane; only the broadcast overlay uses it, and that replaces the pane). Test:
`/tg stop` answers while a turn runs.

**T0c — the card re-reads the allowlist** (½ h). `apSetLevel` and `apToggleRun` read
`tg allow list` again before refusing, so "press 3 again" works after `! tg allow add`. Test: an
allowlist that grows between two presses lets the second through.

**T1 — frame, key table, menu, focus** (1–1.5 days; first, one agent).
- `hooks/ui/keys.ts` (pure): one table of every key: letter or digit, label, the views it serves,
  when it is enabled and why not. `actionBar(context)` picks ≤ 7; `menu(context)` groups the rest.
- `hooks/ui/frame.tsx`: Header (location, the §4.5 summary, `● keys` from `e.props.isFocused`),
  ActionBar (replaces HintsRow), Notice, Menu, and slots for the sheet, card, activity and diff that
  T2–T6 fill.
- Layout by `e.props.placement`: dock (two columns) and inline (one view), sized by `bodyColumns`
  and `scroll.bodyRows`. Remove the mode cycle; `/tg` opens, `q` and ✕ hide; `/tg wide|compact`
  stay as aliases of `/tg`, `/tg hidden` of `/tg hide`.
- The ring stays on the cursor row after every action; only the active column's digits are
  hotkeys; the always-on tray goes (a one-row marks line shows while messages are marked).
- Until T2 lands, ⏎ on a message opens today's route picker.
- Tests: no letter has two meanings; every drawn hotkey is in the table; no render draws two Buttons
  with one hotkey; the action bar holds ≤ 7; dock and inline layouts; `h` walks back; `m`; `q`;
  the focus chip.

**T2 — send sheet** (1 day; after T1).
- ⏎ on a message (or on the marked set) opens the sheet; `1`–`5` intents send at once; `6` Ask is
  an Input sent as the intent line (`{ id: 'raw', text }`); ⏎ sends the ringed intent, the last one
  per kind of chat, kept in `$.store`.
- `a`: targets from the radar, + new agent, ⇉ several (legs on digits; `0` is no longer "+ new
  agent"). `i`: inspect (packet facts, masks, a per-packet redaction toggle).
- `▪` marks; "mark the whole loaded thread" in the menu; the band's ⏎ names its intent.
- Tests: `⏎ 1` sends one Fix packet to main; `⏎ ⏎` repeats the last intent; `6` + words; `⏎ a 2 4`;
  marks; inspect.

**T3 — agent card** (1.5–2 days; after T1).
- `a` opens the card for the cursor's or the open chat, in the dock's lower part or the inline body.
- The ladder `1`–`5` (follow, summarize, draft, auto, delegate), every level listed, unavailable
  ones dim with the reason; ⏎ starts or stops. follow drives today's pin; summarize is `listen`
  (stored values unchanged); `LEVEL_GLYPH.delegate` becomes `↯`.
- Per level, only its essentials and a one-line "what happens"; `o` opens options: limits as
  Selects or fields, quiet hours, topics on digits, the danger zone (skip stops, typed name).
- Delegate: the warning step; the grant as Selects (web, commands, until) and a repos field filled
  with the session's repo when `git rev-parse --show-toplevel` answers in `$.session.cwd()`.
- allow.toml: ⏎ fills `! tg allow add PEER --yes` (`$.prompt.fill`); the allowlist is re-read after
  each `!` prompt and on every card open (fixes the stale cache).
- Drafts (autopilot's and routing's "Draft reply") as rows of their chat: ⏎ send, `e`, `d`, with
  the guard's verdict shown first.
- Tests: `a ⏎` starts draft; `a 4` on a chat not allowed fills the prompt and starts nothing; after
  the allow, ⏎ starts; `a 5 ⏎ ⏎` starts with the guard stand-in; every level is listed; skip stops
  only from options with the typed name; draft row keys.

**T4 — running, activity, the kill switch** (1 day; after T1).
- `0` stops every follow, autopilot and Worker, drawn red only while something runs.
- On top of T0b: `/tg stop` answers with what stopped, by name, and `0` moves into the frame.
- The running strip (dock, one row) and counts (inline); task cards leave the top of the pane: one
  line in the strip, the full card on top of their chat's thread.
- Activity (`l`): running rows (⏎ opens their card or task) and one log merged by time (packets,
  bursts, drafts, stop events), `u` on a row in its undo window, `d` dismisses finished tasks.
- Tests: `0` empties pins, running and live tasks (TaskStop called); `/tg stop` while a turn runs;
  the merged log's order.

**T5 — footer, band, transcript, `/tg`** (1 day; after T1).
- `SessionMode` label with the summary; `$.ui.status` only for the three alarms; `PromptHint` tail
  while the band has items; `$.ui.notify` when a hard stop starts waiting.
- The band as a queue: one item (two rows), `1/3 j: next`, priority hold > draft > undo > watched
  reply > summary > task news, keys ⏎ `e d o u j k`, one `ctrl+x tab ›`; skip what the pane shows.
- `UserMessage`: this plugin's packets as one row while not expanded (as the probe did).
- `/tg help` (the key table from `keys.ts`) and `/tg status` (the summary, what runs) as
  `CommandOutput` cards; the command's description and `argumentHint` list the subcommands.
- Tests: label text per state; the status line clears without an alarm; queue order and `j`; only
  this plugin's packets are compacted; `/tg help` matches the table.

**T6 — bot testing** (1 day; after T2).
- Digits press the cursor message's buttons on writable chats; `ro` explains; `b` walks past nine.
- Buttons on the message row from 90 columns; ids on the cursor row only; time 5 + day dividers.
- `f` with nothing marked diffs the cursor reply with the last reply to the same outgoing message.
- Recording stopped: `1` hands it to an agent as a live test (T2's sheet, intent Test, the steps
  and script path in the packet), `2` copies the path (`$.ui.copy`), `d` discards.
- Tests: a digit runs `tg press` with its row and col; `ro` runs nothing; `f` pairs; the hand-off
  builds a Test packet.

**T7 — onboarding, states, visual pass, docs** (½–1 day; last).
- The start block (a `$.store` flag, `d` dismisses); the §7.4 states with one key each; login via
  `$.prompt.fill`.
- Tokens and glyphs per §7; ranked rows say why (`asks you`, …).
- README's pane section: the keys that matter, `/tg stop`; `dialogs-pane.md` §2 and §4 point here.
- A live walkthrough of §5 on the fake tg, captured into the commit body.

Conflict points between parallel tasks: `keys.ts` (each task adds its rows), the Pane render's
slots (T1 makes them), `types/index.d.ts` (marked blocks, as today).

## 9. Decisions

Made with the owner (2026-10-10):

1. **allow.toml from the card goes through the prompt.** ⏎ fills `! tg allow add PEER --yes` and the
   owner runs it (7 keys, nothing typed). Rejected: the card running it after the engine's dialog
   (5 keys), which would change who writes allow.toml.
2. **Pin becomes ladder level 1, follow.** One level per chat, so a chat that follows main is not
   also on auto; today both can run at once.

Made here; the owner may revisit:

3. **`d` changes meaning** from "select the whole thread" to "drop or dismiss".
4. **No mode choice.** The layout follows the seat; `/tg wide|compact` stay only as aliases.

## 10. Rejected

- **Engine tabs for views** (several panes): the probe showed the tab strip, but reaching a tab
  takes Tab-walking; one pane with in-pane views keeps every view one key away.
- **A chord from the prompt via Button `action`**: only the engine's own actions can be named
  (`app:cycleDiffBase`); borrowing one would take it from the person (as bd0a4a4 found).
- **Digit hotkeys in the band**: a prompt that starts with a digit would press them (bd0a4a4).
- **Uppercase or symbols** (`?`, `+`, `=`, `A`): refused by the engine; `m` is the help key.
- **Asking in the prompt with a token** (`[tg #677791]` expanded at `prompt.submit`): it needs a
  trip to the prompt and back; the sheet's field covers one-line questions. Kept as a follow-up.

## Appendix A. The lab

- Terminals: `tmux new-session -d -s uxlab -x 180 -y 50` with `CLAUDE_CODE_NO_FLICKER=1` for the
  dock; `-x 100 -y 40` with `CLAUDE_CODE_NO_FLICKER=0` for inline (in tmux the main screen is the
  default).
- Session: `claude --plugin-dir mods/dialogs-pane --plugin-dir mods/dialogs-pane-guard --settings
  '{"enabledPlugins":{"dialogs-pane@tg-kit":false,"dialogs-pane-guard@tg-kit":false}}'`, so the
  installed copies do not load twice. A `--plugin-dir` run uses the store file
  `~/.claude/plugins/store/dialogs-pane_inline-*.json`: back it up first and restore it after.
- The fake tg answers: `dialogs --limit N --json` · `read PEER --limit N --reverse --json` ·
  `msg PEER ID… --json` (exit 4 for missing) · `whoami --json` · `allow list --json` ·
  `send PEER - --plain [--wait …] [--reply-to ID] --json [--dry-run]` (stdin text; exit 7 outside
  the allowlist) · `press PEER ID --row R --col C --wait 5s --json` · `delete PEER ID… --yes --json`
  · `watch PEER --jsonl [--after ID] [--idle-exit …]` (prints `ready`, then lines appended to a
  spool file). Placeholder chats only.
- Driving it: `tmux send-keys`, `tmux capture-pane -p` (`-e` shows the ring as inverse).
