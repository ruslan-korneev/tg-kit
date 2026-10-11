# tg-kit

`tg` drives a **Telegram user account** over MTProto from the command line. It's built for
agents testing Telegram bots: send a command, wait for the reply, press inline buttons, and read
the result, with one command per step and compact output that always shows buttons.

It isn't a chat client and it isn't a Bot API library. Anything without a dedicated command
goes through `tg raw`, which covers the whole MTProto API.

## Install

```bash
uv tool install 'git+https://github.com/ruslan-korneev/tg-kit@v0.2.0'                # puts `tg` on PATH
uv tool install 'tg-kit[qr] @ git+https://github.com/ruslan-korneev/tg-kit@v0.2.0'   # + QR-code login
```

From a local checkout, for development:

```bash
uv tool install --editable .          # or --editable '.[qr]'
```

## Use with any AI agent

The agent skill lives in [`skills/telegram/`](skills/telegram/SKILL.md) and follows the
[Agent Skills](https://agentskills.io) format, so the [`skills`](https://skills.sh) CLI installs it
into Claude Code, Codex, Cursor, Gemini CLI, OpenCode and the other agents it supports:

```bash
npx skills add ruslan-korneev/tg-kit -g                             # every detected agent, user-wide
npx skills add ruslan-korneev/tg-kit -g -a claude-code -a codex     # chosen agents
```

Leave out `-g` to install into the current project instead (`.claude/skills/`, `.agents/skills/`,
…). The skill needs the `tg` CLI on PATH (see Install) and a logged-in account (see Log in).

## Dialogs pane (Claude Code mod)

A Telegram pane inside Claude Code. Your Telegram folders and chats sit next to the session; ⏎ on
a message hands it to Claude; a bot is tested with single keys; and any chat can be given to an
agent, from "follow it" to "do the work it asks for". The pane reads and writes Telegram only
through `tg`.

### Install the pane

It is two plugins from this repository's marketplace. `dialogs-pane` is the pane.
`dialogs-pane-guard` holds a `delegate` Worker to its grant and hard stops. Without the guard
everything works except `delegate`, which does not start.

```bash
claude plugin marketplace add ruslan-korneev/tg-kit      # or a local checkout's path
claude plugin install dialogs-pane@tg-kit
claude plugin install dialogs-pane-guard@tg-kit
```

The pane needs `tg` v0.2.0 or later on PATH (it uses `tg watch` and `tg folders`) and a
logged-in account (see Log in). `tg folders --help` tells you whether yours has them.

### First run

Type `/tg` in a session. The pane opens on your first Telegram folder. In fullscreen, from 110
columns, it docks beside the transcript: the chat list on top, the open chat below. In a narrower
terminal it sits above the prompt and shows one view at a time. A "start here" block names the
keys that matter until you press `d`.

- The pane takes the keys while its header shows `● keys`. `ctrl+x tab` hands them over, and `Esc`
  gives them back to the prompt.
- `m` lists every key the current view can use, and each entry is pressable. `/tg help` prints the
  same table in the transcript; `/tg status` shows what runs.
- `h` goes one level up. `q` hides the pane; the footer then keeps the unread count and what runs.
  `/tg` brings the pane back.

### What you do with it

- **Folders and chats.** `1`–`9` open your first nine Telegram folders, in Telegram's order. `h`
  from the chat list lists every folder, the Archive, For you and Bots. `s` searches every chat.
  `y` (For you) gathers what waits for you: agents' drafts first, then people who mention you or
  wrote to you.
- **Hand a message to Claude.** ⏎ on a message opens the send sheet, and a digit sends it with an
  intent: `⏎ 1` sends a bot's reply as Fix. The intents follow who wrote the message: Fix,
  Reproduce, Explain and Test for a bot; Do it, Explain and Draft reply for a person. `a` picks
  another agent, `i` shows what it will read, and `x` or `v` mark several messages first. Claude
  gets a `<tg-packet>`: the whole message record, with phone numbers, usernames, ids and names
  masked.
- **Test a bot.** In a bot chat, digits press the buttons of the message under the cursor, and `n`
  writes to the bot. `r … r` records your sends and presses into a script under `.tg-recordings/`;
  `1` on the sheet that follows hands it to an agent as a live test. `f` diffs a reply with the
  last reply to the same message. `⏱` marks each reply's latency.
- **Watch and summarize.** `w` tells you about new messages in a chat, above the prompt too while
  the pane is hidden. `t` summarizes a chat.
- **Give a chat to an agent.** `a` opens the chat's agent card, a ladder: `1` follow (new messages
  go to Claude's context), `2` summarize, `3` draft (the agent drafts, you send with ⏎), `4` auto
  (it replies within limits) and `5` delegate (it replies and does the work in your repo). Each
  kind of chat gets only the levels that fit: in a bot chat or a channel an agent only reads, and
  delegate is for person chats. A draft waits as a row of its chat, in For you and above the
  prompt.

### Safety

- **Stop everything:** `0` stops every follow, autopilot and Worker at once, from any view.
  `/tg stop` does the same from the prompt, even while Claude is mid-turn. Settings stay, and the
  card restarts a chat.
- **Your keys, your writes.** What you send with your own key goes out as yours: a message after
  `n`, a draft you read whole, a button press. What an agent sends on its own (auto, delegate, an
  agent replaying a recording) needs the chat in `allow.toml`. The pane never adds it silently:
  the card asks in Claude Code's dialog, No first, showing the exact `tg allow add … --yes`, and
  only your Yes runs it. The add is kept; `tg allow remove` takes it out. BotFather stays
  read-only, and `readonly = true` in tg's config refuses every write.
- **What `delegate` may do.** The Worker works in a fresh git worktree of each repo you grant,
  never in your checkout. It runs only the repo's own checks (read off `package.json`,
  `pyproject.toml` with `uv.lock`, `Makefile`, `justfile`, `Cargo.toml`, `go.mod`), local git and
  read-only commands. Everything else is refused, `sh -c`, `eval` and scripts it writes included.
  It never runs `tg` and never reads tg-kit's config, so the chat has one voice: the agent that
  replies as you. Spending money, pushing, merging, deploying, sharing your files, deleting outside
  the worktree and agreeing to a deadline or price on your behalf stop and ask you (hard stops).
  The one thing the guard cannot read around: a check you allow runs the repository's own code.
  Grant a check only to code you trust to run.

The design is in [`docs/design/dialogs-pane.md`](docs/design/dialogs-pane.md) (the packet,
autopilot, delegate and its guard) and
[`docs/design/dialogs-pane-ux.md`](docs/design/dialogs-pane-ux.md) (the views, the keys, the
states, and decisions 1–12).

## Log in

1. Store the app credentials from <https://my.telegram.org> in the system keychain once:

   ```bash
   tg auth set-app --api-id 123456          # prompts for api_hash (hidden)
   ```

   Or set `TG_KIT_API_ID` / `TG_KIT_API_HASH` in the environment, which takes precedence.

2. Log in. This step is interactive (code + 2FA), so a person runs it:

   ```bash
   tg login                   # account "main"; --account NAME for more; --qr for QR login
   tg whoami
   ```

Each login creates a **new device session** named `tg-kit` (it shows up in Telegram → Settings →
Devices). Don't copy auth keys from other tools. One key used by two clients at once risks
`AUTH_KEY_DUPLICATED`, and then Telegram revokes the key for both.

`tg logout --yes` ends the session on Telegram's side and deletes the local files.

## Testing a bot

```bash
tg send @example_bot /start --wait 10s     # send, then print the reply (with buttons)
#677791 09-29 14:02 @example_bot: Choose an option
  [0:0 cb "Settings"] [0:1 cb "Help"]
  [1:0 url "Docs" → https://example.com]

tg press @example_bot 677791 "Settings"    # press; prints the edited message / new replies
tg press @example_bot 677791 --row 0 --col 1
tg read @example_bot --after 677791        # anything that arrived later, oldest first
```

`--wait` subscribes to the chat **before** sending, then collects new messages *and edits*
until nothing new arrives for `--quiet` (1.5 s by default) or the budget runs out. A message
edited several times is shown once, in its final state, as `✎×N`. If nothing arrives, the
command exits **6**. `press` always waits (5 s by default). Only incoming messages count, so
`tg send me … --wait` always exits 6: Saved Messages never replies.

Button labels match exactly first, then case-insensitively, then ignoring emoji, spaces and
punctuation. If a label matches nothing or more than one button, the command exits 4 and lists
every button. Pressing a button depends on its type:

| Type | Result |
|---|---|
| callback (`cb`), `game` | `GetBotCallbackAnswer`; prints `toast:` / `alert:` / `url:`, then the effects. A bot that never answers the callback triggers a warning, not a failure |
| reply keyboard (`reply`) | sends the label as a message, as the Telegram app does |
| `url`, `login`, `webapp`, `switch`, `copy`, `profile` | prints what the button holds and presses nothing |
| `phone`, `geo`, `peer`, `poll`, `buy`, `disabled`, 🔒 (needs 2FA) | refused, exit 7 |

## Commands

```bash
# read
tg dialogs [-n 30] [--unread] [--query TEXT] [--archived | --folder ID|TITLE]
tg folders [--counts | --chats]          # Telegram folders in Telegram's order
tg read PEER [-n 20] [--before ID] [--after ID] [--since 2h|2026-09-01] [--from PEER] [--reverse] [--full]
tg msg PEER ID [ID…]                     # full messages, never truncated
tg search PEER QUERY [--filter photo|video|doc|link|voice|music|gif|round|…] [--since …] [--from PEER]
tg search --global QUERY
tg resolve SPEC                          # what a peer spec points at; check before writing
tg info PEER                             # bio / description / bot commands / members / linked chat
tg download PEER ID [--out DIR] [--max-size 200]   # prints the path; never overwrites
tg drafts
tg transcribe PEER ID                    # voice → text (Premium or its trial)
tg watch PEER… [--jsonl] [--events message,edit,typing,delete] [--after ID | --since 2h] [--idle-exit 30s]

# write: every command supports --dry-run and goes through the guard
tg send PEER TEXT|- [--reply-to ID] [--no-preview] [--md|--html|--plain] [--silent] [--wait 10s]
tg send-file PEER PATH|URL [--caption TEXT] [--as-doc] [--wait …]
tg edit PEER ID TEXT|-
tg delete PEER ID… [--only-me] --yes
tg forward FROM ID… --to PEER
tg react PEER ID 👍                      # "" removes the reaction
tg draft PEER TEXT|-
tg mark-read PEER

# bots
tg press PEER ID (BUTTON | --row R --col C | --data STR | --data-hex HEX) [--wait 5s]
tg start @bot [PAYLOAD] [--wait …]       # /start, or messages.StartBot with a deep-link payload
tg inline @bot QUERY [--peer PEER]       # list results
tg inline @bot QUERY --pick N --to PEER  # send result N

# allowlist (writes to these peers skip --yes)
tg allow add PEER… --yes   ·   tg allow list   ·   tg allow remove ID|PEER…

# anything else
tg raw METHOD [PARAMS_JSON|-]
```

Global options work before or after the command: `--account/-a NAME`, `--json`,
`--timeout SECONDS` (default 30, plus any `--wait`, plus `flood_sleep_threshold` so that an
allowed flood-wait sleep is never cut short), `-v` (debug logs and tracebacks).

For multi-line text, use `-` with stdin instead of shell escaping:

```bash
tg send @example_bot - <<'EOF'
line one
line two
EOF
```

Text longer than 4096 characters is split at paragraph, line or word boundaries and sent as
several messages, and every id is printed. A caption over 1024 characters is refused (exit 2):
send the file with a short caption, then reply to it with the text.

### Peer specs

`me` / `self` (Saved Messages) · `@username` or `username` · `t.me/username` · `t.me/username/45`
or `t.me/c/123/45` (a message link, where commands that take an ID accept it) · a numeric user id ·
`-100…` for channels and supergroups · `-…` for basic groups · `+phone` (contacts only) ·
`title:Chat Name` (must match exactly one dialog title; writes also need `--yes`).

A numeric id needs an access hash. tg looks it up in the local entity cache first, and on a miss
scans the latest 500 dialogs once. If it's still missing, the command exits 4 and suggests
resolving by `@username`.

## Output

The default is compact, one line per message, with buttons on indented lines below it:

```
#677791 09-29 14:02 @example_bot: Choose a bot ⏎ second line
  [0:0 cb "My bot"] [0:1 cb "Back"]
  [1:0 url "Docs" → https://example.com/docs]
#677792 09-29 14:02 me ↩677791: /start
#677793 09-29 14:03 Alex K. [photo 1280×720 214KB] caption text
#677794 09-29 14:05 @example_bot ✎×2: updated text {👍3 ❤️1}
```

Legend: `#id`, local time (with the year if it isn't the current one), then the sender (`me`,
`@username`, a display name, or the channel title). Markers: `↩ID` reply, `⤳X` forwarded from
X, `via @bot`, `✎` edited (`✎×N` edits seen while waiting), `📌` pinned. `⏎` stands for a newline
in the text. Media tags: `[photo W×H SIZE]`, `[video …]`, `[gif …]`, `[voice 0:12]`,
`[videonote 0:09]`, `[audio NAME 3:05]`, `[sticker 😀]`, `[document NAME SIZE]`, `[poll "…"]`,
`[geo]`, `[contact "…"]`, `[dice 🎲=4]`, `[service pin_message]`. `{👍3}` are reactions. Links
hidden behind text show on an indented line as `[link "text" → url]`, above the buttons. `✎`
marks every edited message, including bot edits that the Telegram apps don't label. `edited` in
JSON is the last edit time, and `edits` counts only the edits seen during a `--wait`.

Listings cut text at 300 characters and append `… (+N chars, tg msg PEER ID)`. `--full` and
`tg msg` never cut. Each call prints at most 200 messages.

### JSON (`--json`)

stdout carries a single JSON document and nothing else. Each message has this shape:

```json
{
  "id": 677791, "chat_id": 123456, "date": "2026-09-29T11:02:00Z",
  "sender": {"id": 123456, "kind": "bot", "username": "example_bot", "name": "Example"},
  "out": false, "text": "Choose an option", "reply_to": null,
  "forward": {"from_id": -1000000000777, "from_name": "@example_news", "date": "…"} ,
  "edited": null, "edits": 0, "pinned": false, "service": null, "via_bot": null,
  "media": {"type": "photo", "size": 219136, "name": null, "mime": "image/jpeg",
            "duration": null, "width": 1280, "height": 720},
  "keyboard": "inline",
  "buttons": [[{"row": 0, "col": 0, "type": "cb", "text": "Settings", "data_b64": "c2V0"}]],
  "reactions": [{"emoji": "👍", "count": 3}],
  "links": [{"text": "Privacy policy", "url": "https://example.com/privacy"}]
}
```

- `sender.kind` is one of `self` `user` `bot` `group` `channel` `supergroup` `unknown`.
- `media` keeps only the keys that are set. `media.type` is `photo` `video` `gif` `videonote`
  `voice` `audio` `sticker` `document` `poll` `geo` `contact` `dice` `game` `invoice` `webpage`,
  or a new kind's TL name.
- Button objects may also carry `url`, `query` + `same_peer`, `user_id`, `copy_text` and
  `requires_password`.
- Global search adds `chat_title`.

Per command:

| Command | Document |
|---|---|
| `read`, `msg`, `search` | a list of messages |
| `dialogs` | a list of chats (below) |
| `folders` | a list of folders (below) |
| `send`, `send-file`, `edit`, `forward`, `start` | `{"sent": [...]}`, plus `"replies": [...]` with `--wait` |
| `press` | `{"button": {...}, "answer": {"alert", "toast", "url"} \| null, "replies": [...]}` |
| `raw` | the TL result's `to_dict()`, with bytes as base64 and dates as ISO |
| `--dry-run` | the plan: `{"action", "target", "steps": [{"method", "params"}], "guard"}` |

`tg watch` streams, so it takes `--jsonl` instead of `--json` (see below).

### Dialogs and folders

`tg dialogs` prints one chat per line: id, kind, `@username` or title, `📌` pinned, `🔕` muted,
`[N unread, M mentions]`, then the last message. With `--json` each chat is:

```json
{"id": 123456, "kind": "bot", "title": "Example", "username": "example_bot",
 "unread": 2, "mentions": 0, "pinned": true, "muted": false,
 "last_id": 677791, "last_date": "2026-09-29T11:02:00+00:00", "last_text": "Choose an option"}
```

- `kind` is one of `self` `user` `bot` `group` `supergroup` `channel` `unknown`.
- `mentions` is Telegram's count of unread mentions of you.
- `muted`: the chat's own mute, or, when it has none, your default for that kind of chat
  (private chats, groups, channels). If Telegram does not return a default, that kind counts as
  not muted and a note goes to stderr.
- `pinned` is pinned in the list shown: the chat list, the archive (`--archived`), or the folder
  (`--folder`).

`tg folders` lists your Telegram folders in Telegram's order, All chats wherever you put it:

```
2 Work [3 unread]
0 All chats [41 unread]
11 Team Projects (shared)
```

```json
[{"id": 2, "title": "Work", "kind": "folder", "unread": 3},
 {"id": 0, "title": "All chats", "kind": "all", "unread": 41},
 {"id": 11, "title": "Team Projects", "kind": "shared", "unread": 0}]
```

- `kind`: `all` (All chats, always id 0), `folder`, or `shared` (a folder joined or shared by an
  invite link).
- `unread` comes only with `--counts`: the folder's unread chats that are not muted. It looks at
  the latest 500 chats of the chat list and of the Archive, plus the chats the folders list by
  name.
- `tg folders --chats` is one pass for every folder. It implies `--counts` and makes the same
  Telegram calls. Each text line ends in ` · N chats`. With `--json` it prints one document:

  ```json
  {"at": "2026-10-11T09:30:00+00:00", "scan": 500,
   "folders": [
     {"id": 2, "title": "Work", "kind": "folder", "unread": 1,
      "pinned": [-1000000000205], "chats": [-1000000000205, 123456]},
     {"id": 0, "title": "All chats", "kind": "all", "unread": 1,
      "pinned": [123456], "chats": [123456, -1000000000205, 202]},
     {"id": 11, "title": "Team", "kind": "shared", "unread": 0, "pinned": [], "chats": [202]}],
   "dialogs": [{"id": 123456, "kind": "bot", …}, {"id": -1000000000205, …}, {"id": 202, …}]}
  ```

  `chats` holds every member in the folder's order, ids only: pinned first, then newest last
  message first. `pinned` holds the folder's pinned chats; for All chats, the chat list's pins.
  `dialogs` has one `tg dialogs` row for every chat in some `chats` list, and no other chat. A
  row's `pinned` is Telegram's own pin for the chat. `scan` is how many of the latest chats
  were looked at, in the chat list and again in the Archive. All chats and chat types see only
  those; listed chats are always fetched. `at` is when the pass ran, in UTC. A FLOOD_WAIT longer
  than `flood_sleep_threshold` exits 5.
- `tg dialogs --folder ID|TITLE` lists one folder's chats: its pinned chats first, in its order,
  then by last message. A title matches exactly, then case-insensitively. An unknown folder exits
  4 with the list of folders.
- Membership follows Telegram's rule: pinned or included chats are in; excluded ones are out;
  otherwise the folder's chat types (contacts, non-contacts, groups, channels, bots), minus muted,
  read or archived chats when the folder says so. An unread mention keeps a muted or read chat
  in. A shared folder holds only its listed chats. Chats joining by type come from the latest 500
  of the chat list and of the Archive.
- Listed chats are fetched by id, so an old one still shows. Telegram rate-limits that by chats:
  about 180 in 30 seconds. Past that, tg sleeps out the FLOOD_WAIT or exits 5. A listed chat
  Telegram refuses (left, banned, deleted) is left out and not asked for again for 6 hours.
- `--archived` is the Archive, which is not a folder, so it does not combine with `--folder`.

### `tg watch` (`--jsonl`)

`tg watch PEER…` stays connected and prints each event in the watched chats as it arrives: one
JSON object per line with `--jsonl` (flushed per line), compact lines without it. It runs until
Ctrl-C or SIGTERM (exit 0), until `--idle-exit DURATION` passes with nothing printed (exit 0),
or until the process reading its stdout pipe exits (exit 0). It is read-only.

```jsonl
{"event": "message", "id": 677795, "chat_id": 123456, "date": "2026-09-29T11:06:00Z", "sender": {"id": 123456, "kind": "bot", "username": "example_bot", "name": "Example"}, "out": false, "text": "Done", …}
{"event": "ready", "date": "2026-09-29T11:06:01.5Z", "peers": [{"chat_id": 123456, "kind": "bot", "username": "example_bot", "title": "Example"}]}
{"event": "typing", "chat_id": 123456, "date": "2026-09-29T11:06:10.2Z", "sender": {"id": 123456, "kind": "bot", "username": "example_bot", "name": "Example"}, "action": "typing"}
{"event": "message", "id": 677796, "chat_id": 123456, …}
{"event": "edit", "id": 677796, "chat_id": 123456, "edited": "2026-09-29T11:06:14Z", …}
{"event": "delete", "chat_id": 123456, "date": "2026-09-29T11:06:20.9Z", "ids": [677796]}
```

- `message` and `edit` are the message object above plus `"event"`. An `edit` carries the
  message's whole new state. `edits` is always 0 here. Both directions count: `out` is true for
  your own messages, including ones sent from another device.
- `typing`: `action` is `typing`, `cancel` (stopped), `record_audio`, `record_video`,
  `record_round`, `upload_photo`, `upload_video`, `upload_audio`, `upload_document`,
  `upload_round`, `choose_sticker`, `choose_contact`, `geo_location`, `game_play`,
  `text_draft`, … (the TL action name in snake_case, so new kinds still come through). Telegram
  repeats a `typing` about every 5 s while it lasts and treats it as over after about 6 s without
  one. `sender` comes from the local cache and may be `{"kind": "unknown", "name": "<id>"}`.
  `date` is when tg received it.
- `delete`: `date` is when tg received it. In private chats and basic groups Telegram does not
  say which chat a deletion is in, so tg reports deletions there only for messages this watch has
  printed. Channels and supergroups report every deletion.
- `ready` is printed once, after tg has subscribed and replayed. Lines before it are the replay
  of `--after ID` (one PEER) or `--since 2h|2026-09-01`: up to 200 messages per chat, oldest
  first, as `message` events. Lines after it are live. A message that shows up in both is printed
  once. `chat_id` in `ready` is the id that events carry: for `me` that is your own user id.
- `--events message,edit,typing,delete` picks the kinds (default all). `ready` is always printed.
- Connecting, resolving and the replay must finish within `--timeout`; after `ready` there is no
  deadline. A lost connection exits 1 with `error: lost the connection to Telegram`; rerun with
  `--after LAST_ID` to replay what was missed.

Compact lines, with `[chat]` added when several chats are watched:

```
ready: watching @example_bot
#677795 09-29 14:06 @example_bot: Done
~ 09-29 14:06 @example_bot: typing
✗ 09-29 14:06 deleted #677796
```

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | |
| 1 | unexpected error or timeout | read the message; a send that timed out may still have been delivered, so check with `tg read` |
| 2 | usage: bad arguments | fix the command |
| 3 | not logged in / session revoked | a person runs `tg login` |
| 4 | peer, message, button or account not found, or ambiguous | use the listing printed with the error |
| 5 | FLOOD_WAIT longer than the auto-sleep threshold | wait the printed number of seconds |
| 6 | `--wait` got no reply | the bot is down or slow; `--wait` longer, or `tg read --after ID` later |
| 7 | refused by the guard or a policy; nothing was sent | see Safety |

Errors go to stderr as one line (`error: …`) followed by `  fix: …`. There are no tracebacks
unless you pass `-v`. Ctrl-C exits 130 and SIGTERM exits 143, both after a clean disconnect;
`tg watch` exits 0 on both, since stopping is how it is meant to end.

## Safety

`~/.config/tg-kit/config.toml` holds your settings (override the directory with
`TG_KIT_CONFIG_DIR`). tg only reads it:

```toml
default_account = "main"          # needed only with several accounts
readonly = false                  # true → every write exits 7 (allowlist changes and logout too)
flood_sleep_threshold = 30        # sleep through FLOOD_WAITs up to this many seconds
```

The write allowlist lives in `~/.config/tg-kit/allow.toml`, and `tg allow` is its only writer:

```bash
tg allow add @example_bot --yes   # resolves the peer and stores its id with labels
tg allow list                     # 123456  bot  @example_bot  Example Bot  (added 2026-09-29)
tg allow remove @example_bot      # or the id from the list
```

```toml
[[peer]]
id = 123456                       # the guard decides by this only
kind = "bot"                      # labels for humans, as of `added`
username = "example_bot"
name = "Example Bot"
added = "2026-09-29"
```

- A write (send, edit, react, press, start, inline --pick, …) to a peer whose id isn't in the
  allowlist needs `--yes`. Without it, tg prints the resolved target and the exact plan, then
  exits 7.
- `tg allow add` needs `--yes` or an interactive confirmation, because an allowlisted peer skips
  `--yes` for good. `remove` only tightens the guard, so it needs neither.
- `delete`, `logout` and `raw` write methods always need `--yes`, and `readonly` blocks them
  all. A raw method is a read only when its name starts with `Get`/`Search`/`Check`/`Resolve`.
  There are exceptions:
  - every `auth.*` method is a write;
  - every `Export*` method is a write (it mints tokens and invites), except
    `channels.ExportMessageLink` and `stories.ExportStoryLink`;
  - a few read-named methods that change state or touch the 2FA password are writes:
    `messages.GetBotCallbackAnswer`, `messages.GetMessagesViews`, `contacts.GetLocated`,
    `account.GetTmpPassword`, …. The full list is `raw.py::_WRITES_NAMED_AS_READS`.
- Usernames of write targets are always resolved over the network, never from the cache. A
  username that moved to another account can't carry an allowlisted write to the new owner.
- A `title:` target always needs `--yes`.
- The first stderr line of every write names its target: `→ @example_bot (bot, id 123456)`.
- `--dry-run` prints the plan object that the real run would execute, then sends nothing.
- There's no "allow all my own bots" switch. No reliable API says which bots the account owns,
  so add them with `tg allow add`.

## `tg raw`

```bash
tg raw users.GetFullUser '{"id": "me"}'
tg raw messages.GetHistory '{"peer": "@example_bot", "limit": 5}'
tg raw messages.GetBotCallbackAnswer '{"peer": "@example_bot", "msgId": 5, "data": {"$hex": "6f6b"}}'
tg raw messages.SendReaction '{"peer":"me","msg_id":5,"reaction":[{"_":"ReactionEmoji","emoticon":"👍"}]}' --yes
```

- Method names: `messages.GetHistory`, `messages.GetHistoryRequest` and `messages.getHistory` all
  work. An unknown name exits 2 and suggests close matches.
- Params: snake_case or camelCase keys.
- Peer-typed params (InputPeer, InputUser, InputChannel and InputDialogPeer, decided from the
  request's own annotations) take a peer spec. InputMessage params take a bare id.
- Bytes: a plain string (UTF-8), `{"$bytes": …}`, `{"$hex": …}` or `{"$b64": …}`.
- TL objects: `{"_": "InputMessageID", "id": 5}`. Dates: ISO or unix time.
- An omitted required integer (offsets, `hash`) becomes 0, an omitted nullable param becomes
  null, and `random_id` is generated.

## How state is kept

Everything lives under `~/.config/tg-kit/sessions/` (the directory is `0700`, the files `0600`):

| File | Content | Written |
|---|---|---|
| `NAME.session` | auth key + DC (Telethon StringSession format) | at login and on a DC migration; read-only otherwise |
| `NAME.cache.db` | entity cache: id → access hash, username, name, kind | SQLite in WAL mode with a busy timeout, one short transaction per batch |
| `NAME.json` | who the account is (for `tg accounts`) | at login and by `whoami` |

`allow.toml` (the allowlist) sits next to `config.toml` and is shared by all accounts, since peer
ids are global.

This split is what lets parallel `tg` processes work. Telethon's default `SQLiteSession` holds
one database for everything, and a second process then fails with `database is locked`. Here,
concurrent runs read the auth file without a lock and queue on the cache for milliseconds.
Update state isn't persisted: `--wait` subscribes fresh each time and never catches up.

## Development

```bash
uv sync
uv run pytest                                  # unit tests: no network
TG_KIT_LIVE=1 uv run pytest tests/live         # parallel runs against the logged-in account
uv run ruff check src tests && uv run ruff format --check src tests
uv run mypy                                    # strict
```
