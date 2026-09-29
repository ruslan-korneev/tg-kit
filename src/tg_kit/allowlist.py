"""`~/.config/tg-kit/allow.toml` — peers writable without --yes. Owned here.

Only `tg allow add/remove` writes this file. Decisions use `id` alone; `kind`,
`username` and `name` are labels for the human reading the file, as they were
when the peer was added (usernames move, ids do not).

    [[peer]]
    id = 123456
    kind = "bot"
    username = "example_bot"
    name = "Example"
    added = "2026-09-29"
"""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path

from tg_kit.errors import UsageError
from tg_kit.session import atomic_write

__all__ = ["AllowEntry", "Allowlist", "load_allowlist", "save_allowlist"]

_HEADER = """\
# tg-kit write allowlist: peers writable without --yes.
# Managed by `tg allow add/remove`. Decisions use `id` only; kind/username/name
# are labels for humans, as of `added` (a username can later move to someone else).
"""
_KEYS = {"id", "kind", "username", "name", "added"}


@dataclass(frozen=True)
class AllowEntry:
    id: int
    kind: str
    username: str | None
    name: str
    added: str  # ISO date

    def label(self) -> str:
        handle = f"@{self.username}" if self.username else "-"
        return f"{self.id}  {self.kind}  {handle}  {self.name}  (added {self.added})"


@dataclass(frozen=True)
class Allowlist:
    entries: tuple[AllowEntry, ...] = ()

    @property
    def ids(self) -> frozenset[int]:
        return frozenset(e.id for e in self.entries)

    def with_entry(self, entry: AllowEntry) -> Allowlist:
        """Add, or refresh the labels of an id already present."""
        kept = tuple(e for e in self.entries if e.id != entry.id)
        return replace(self, entries=(*kept, entry))

    def without(self, peer_id: int) -> Allowlist:
        return replace(self, entries=tuple(e for e in self.entries if e.id != peer_id))


def load_allowlist(path: Path) -> Allowlist:
    if not path.exists():
        return Allowlist()
    try:
        raw = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise UsageError(f"{path}: invalid TOML ({exc})") from exc
    peers = raw.get("peer", [])
    if set(raw) - {"peer"} or not isinstance(peers, list):
        raise UsageError(
            f"{path}: expected only [[peer]] tables", hint="edit it with tg allow add/remove"
        )
    entries = []
    for i, p in enumerate(peers):
        if not isinstance(p, dict) or set(p) - _KEYS or not isinstance(p.get("id"), int):
            raise UsageError(f"{path}: peer #{i} needs an integer id and only {sorted(_KEYS)}")
        entries.append(
            AllowEntry(
                id=p["id"],
                kind=str(p.get("kind", "unknown")),
                username=p.get("username"),
                name=str(p.get("name", "")),
                added=str(p.get("added", "")),
            )
        )
    return Allowlist(tuple(entries))


def save_allowlist(path: Path, allowlist: Allowlist) -> None:
    blocks = []
    for e in allowlist.entries:
        lines = ["[[peer]]", f"id = {e.id}", f"kind = {_toml_str(e.kind)}"]
        if e.username:
            lines.append(f"username = {_toml_str(e.username)}")
        lines += [f"name = {_toml_str(e.name)}", f"added = {_toml_str(e.added)}"]
        blocks.append("\n".join(lines))
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, _HEADER + "".join(f"\n{b}\n" for b in blocks))


def _toml_str(value: str) -> str:
    # A JSON string is a valid TOML basic string (same escapes); keep non-ASCII readable.
    return json.dumps(value, ensure_ascii=False)
