---
name: telegram
description: Read and send Telegram messages as the user's own account through the `tg` CLI (tg-kit). Use it to check a Telegram chat, channel or group, read or search messages, send a message or a file, download media, or call an MTProto method. Above all, use it to test a Telegram bot end to end (send a command, wait for the reply, press inline buttons, try inline mode, /start deep links). Prefer `tg` over any Telegram MCP tools.
---

# Telegram via `tg`

`tg` acts as the user's **real Telegram account**, not as a bot. Everything it sends really
comes from them, so where a message goes matters more than what it says.

Prefer `tg` over any Telegram MCP tools (such as `mcp__telegram__*`). Its output shows buttons,
`--wait` catches the reply and in-place edits, and `press` handles callback data for you.

## Before the first command

```bash
command -v tg || uv tool install 'git+https://github.com/ruslan-korneev/tg-kit'
tg whoami
```

Installing needs [uv](https://docs.astral.sh/uv/). Add the `[qr]` extra for QR-code login:
`uv tool install 'tg-kit[qr] @ git+https://github.com/ruslan-korneev/tg-kit'`.

- **Exit 3** (not logged in): logging in is interactive and **only the user can do it**. Ask them
  to run `tg login` in their own terminal (in Claude Code they can type `! tg login` in the
  prompt), then retry. Never try to log in for them, and never copy session files or auth keys
  from another tool.
- **No app credentials**: ask the user to run `tg auth set-app --api-id N` in their
  terminal (it prompts for the api_hash), with the app credentials from <https://my.telegram.org>.

## Testing a bot: the loop

```bash
tg send @example_bot /start --wait 10s       # 1. send; prints your message, then the reply
#677790 09-29 14:02 me: /start
#677791 09-29 14:02 @example_bot: Choose an option      ← press on THIS id
  [0:0 cb "Settings"] [0:1 cb "Help"] [0:2 cb "»"]
tg press @example_bot 677791 "Settings"      # 2. press; prints the edited message and replies
tg press @example_bot 677791 --row 0 --col 1 #    or by index, when labels repeat
                                             #    an edited message keeps its id: press it again
tg read @example_bot --after 677791          # 3. anything that arrived later, oldest first
                                             #    (empty output + exit 0 = nothing new)
```

- `--wait` subscribes **before** sending and returns once the chat goes quiet (1.5 s), capped at
  the given budget. It includes **edits**: bots like @BotFather edit the same message instead of
  sending a new one, and it shows up with `✎`. `press` waits the same way, with a 5 s budget by
  default. Pass `--wait 15s` for slow bots. Wall time includes the 1.5 s quiet window, so
  don't report tg's total time as the bot's latency. `press` first prints `pressed [r:c …]` on stderr.
- **`send`, `press`, `start` and `inline --pick` are all writes** and go through the guard. A
  bot is a third party unless it's in the allowlist (`tg allow list`). Without that, each of these
  exits 7. Once the user OKs `--yes` for that bot, pass it on **every** call; tg keeps no memory
  of the OK. For the user's own bots under test, suggest allowlisting them once (see below).
- **Never poll in a loop with `sleep`.** Use a longer `--wait`, then `tg read PEER --after ID`.
- Exit **6** means no reply within the wait. Say that the bot didn't answer. Don't retry blindly.
- Exit **4** from `press` means no button matched, or several did. The error lists every button
  with its `r:c` index, so pick one from that list. Labels match on the whole label, never on a
  prefix or substring: exactly first, then case-insensitively, then ignoring emoji, spaces and
  punctuation. So `"settings"` finds `⚙️ Settings`, and `"«"` doesn't find `« Back`. Symbol-only
  labels (`»`, `«`) work as the label, or use `--row/--col`.
- Deep links: `tg start @example_bot PAYLOAD --wait 10s`. Inline mode: `tg inline @example_bot
  "query"`, then `--pick N --to PEER` to send a result.
- Raw callback data: `tg press @example_bot ID --data "cmd:1"` (or `--data-hex`).
- `url`/`webapp`/`login` buttons only print the URL. Phone, location, payment and 2FA buttons are
  refused (exit 7) because they share personal data or spend money.

## Reading

```bash
tg dialogs -n 20 [--unread] [--query name]
tg read PEER -n 20 [--since 2h] [--from PEER] [--full]
tg msg PEER ID [ID…]                          # full text, links, buttons, media, reactions
tg search PEER "text" [--filter photo|doc|link|voice|…]   |   tg search --global "text"
tg resolve SPEC                               # what a spec points at: kind, id, @username
tg info PEER                                  # bio / bot description + commands / members
tg download PEER ID [--out DIR]               # prints the saved path
```

PEER is any of: `me` (Saved Messages), `@username`, `t.me/name`, `t.me/c/123/45`, a numeric id
(`-100…` for channels), `+phone` (contacts only), or `title:Chat Name`. Add `--json` when you need
to parse the output; stdout is then a single JSON document.

## Output legend

`#id MM-DD HH:MM sender markers: [media] text {reactions}`: the whole message is on one line,
with buttons on indented lines as `[r:c type "label"]`, and links hidden behind text as
`[link "text" → url]`. Markers: `↩ID` reply, `⤳X` forwarded
from X, `via @bot`, `✎` edited at some point (while waiting: `✎×N` = N edits seen during the wait), `📌`
pinned. `⏎` is tg's marker for a newline in the text, not a character the sender typed. Long
text is cut at 300 characters with `(+N chars, tg msg PEER ID)`, so run `tg msg` for the full
text.

## Writing, and staying safe

```bash
tg send PEER "text" [--reply-to ID] [--plain|--html] [--no-preview] [--silent]
tg send PEER - <<'EOF'                        # multi-line text: use stdin, not shell escaping
line one
line two
EOF
tg send-file PEER ./file.pdf --caption "…"
tg edit PEER ID "new text"   ·   tg react PEER ID 👍   ·   tg draft PEER "…"   ·   tg mark-read PEER
tg forward FROM ID… --to PEER   ·   tg delete PEER ID… --yes
```

1. **Unsure of the target? Resolve it first** with `tg resolve SPEC`. Every write, including a
   refused one or a dry run, prints `→ @name (kind, id N)` on stderr first, so read that line.
2. **Anything non-trivial gets `--dry-run` first.** It prints the exact plan as JSON on stdout,
   sends nothing, and **exits 0 even when the real run would be refused**. The verdict is only
   on stderr: `dry run: would send` or `dry run: would be REFUSED (exit 7)`.
3. **Exit 7** means the guard refused and nothing was sent. The target isn't in the allowlist
   (`tg allow list`). **Never add `--yes` for a third party (any person, chat or bot not in the
   allowlist) unless the user explicitly said so in this conversation.** Show them the target
   and the text, and ask.
4. Don't delete, forward, leave chats or ban anyone unless asked. `delete` always needs `--yes`.
5. Don't print phone numbers. Don't message people as a test: test in `me`, or in bots the user
   named.

## The allowlist

```bash
tg allow list                                # id  kind  @username  name  (added …)
tg allow add @example_bot --yes              # ONLY when the user asked to allow this peer
tg allow remove @example_bot                 # or by the id from `tg allow list`
```

It lives in `~/.config/tg-kit/allow.toml`, and `tg allow` is its only writer. The guard decides by
**peer id**. Username and name are stored next to the id so the user can see who a number is.
Adding a peer lifts `--yes` for every later write to it, so run `tg allow add … --yes` only when
the user said, in this conversation, to allow that peer. Check the printed
`+ id kind @username name` line against what they meant. `remove` needs no confirmation.

## Exit codes

| Code | Meaning | Your move |
|---|---|---|
| 0 | ok | |
| 1 | unexpected error or timeout | read stderr. For a send that timed out, check `tg read PEER -n 3` before resending |
| 2 | bad arguments | fix the command |
| 3 | not logged in | ask the user to run `tg login` in their terminal |
| 4 | peer, message or button not found, or ambiguous | use the listing in the error, or `tg resolve` |
| 5 | FLOOD_WAIT | wait the printed seconds; don't hammer |
| 6 | `--wait` got no reply | report that the bot stayed silent |
| 7 | refused by the guard | ask the user; `--yes` only with their explicit OK |

## Anything else: `tg raw`

`tg raw METHOD '{json}'` calls any MTProto method, such as channel admin logs, stories, folders
or full chat info. Peer params take peer specs, bytes go as `{"$hex": …}`, and TL objects as
`{"_": "Name", …}`. Only Get/Search/Check/Resolve methods are reads. Everything else, including
Export*, auth.* and state-changing Gets like GetBotCallbackAnswer, is a write. Writes need
`--yes`, which falls under rule 3 above. See `references/raw.md` for the params format and
the common methods.

```bash
tg raw channels.GetFullChannel '{"channel": "@example_news"}'
tg raw messages.GetHistory '{"peer": "@example_bot", "limit": 5}'
```
