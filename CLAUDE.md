# tg-kit

`tg`: a CLI that drives a Telegram **user** account over MTProto (Telethon), mainly so agents
can test bots (send → `--wait` → `press`). It replaces the `mcp-telegram` MCP server. The agent
skill is `skills/telegram/` (Agent Skills format, installable into any agent with
`npx skills add`). The installed skill is a copy (`~/.agents/skills/telegram`, which
`~/.claude/skills/telegram` links to), so after editing `skills/telegram/` reinstall it:
`npx skills add . --skill telegram -g -y`. Keep it in step with the CLI and agent-neutral: no
Claude-only syntax as the main instruction.

## Commands

```bash
uv run pytest                              # unit (no network)
TG_KIT_LIVE=1 uv run pytest tests/live     # parallel tg runs against the logged-in account
uv run ruff check src tests && uv run ruff format --check src tests
uv run mypy                                # strict; Telethon is untyped (Any at the adapter edge)
uv tool install --editable . --reinstall   # refresh the `tg` on PATH
```

## Where things are

- **Contracts:** the output format and JSON schema are in `render.py` and README "Output". The
  exit codes are in `errors.py`. The guard rules are in `guard.py`. `--wait` semantics are in
  `waiter.py`. Changing any of them is a contract change: update the README and the skill in
  the same change.
- **Telethon boundary:** `client.py` (connect, errors → `TgError`), `session.py`, `peers.py`
  (resolve), `convert.py` (Message → `MessageView`), `raw.py`, `plan.py` (execute). Nothing
  else touches Telethon types. `render`, `buttons`, `guard`, `waiter.collect` and `texts` stay
  pure.
- **Writes:** every write builds a `WritePlan`. `--dry-run` prints that object, and the real run
  executes the same object. Never add a write path that bypasses `make_plan` → `authorize`.
- **State:** `~/.config/tg-kit/` (`TG_KIT_CONFIG_DIR`). `session.py` owns `sessions/`.
  `allowlist.py` (via `tg allow`) owns `allow.toml`. tg only reads `config.toml`.

## Rules for this repo

- Releases: the version in `pyproject.toml` and `tg_kit/__init__.py` equals the git tag
  (`v0.1.0`), and the install lines in `skills/telegram/SKILL.md` and README pin that tag
  (`…/tg-kit@vX.Y.Z`). Bump all of them together, then push the commit and the tag;
  `tests/unit/test_release_pins.py` fails on a mismatch.

- Telethon 1.45 / layer 229: buttons are `Keyboard[Inline]Button(text, type=…)`. Verify TL shapes
  against the installed source, not from memory.
- Never import an auth key from another client (AUTH_KEY_DUPLICATED). Login is a human action.
- No real contacts, ids, phones or usernames in code, tests or docs. Use `@example_bot`.
- Live tests message only `me`. BotFather gets read-only navigation. Other bots only when the
  owner names them.
