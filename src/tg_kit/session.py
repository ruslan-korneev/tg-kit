"""Per-account session state, split so parallel `tg` processes never lock each other.

Telethon's `SQLiteSession` keeps the auth key, update state and entity cache in
one SQLite file and holds a write transaction across the run, so two processes
on one session fail with `database is locked`. Here the state is split by how
it is written:

- `<name>.session` — the auth key + DC, in Telethon's StringSession format.
  Written at login (and on a DC migration), read-only on every other run, so
  concurrent readers need no lock. Written atomically (temp file + rename).
- `<name>.cache.db` — the entity cache (id → access hash, username, name,
  kind). SQLite in WAL mode with a busy timeout; every write is one short
  autocommit statement batch, so writers queue for milliseconds instead of
  failing. Numeric-id resolution depends on it surviving between runs.
- `<name>.json` — who the account is (id, username, name, phone), for
  `tg accounts` without a network round trip. Written at login and by whoami.

Update state (pts/qts) is kept in memory only: tg never catches up on missed
updates, it subscribes fresh for each `--wait`.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from telethon.sessions import MemorySession, StringSession
from telethon.tl import types

from tg_kit.errors import AuthRequiredError, NotFoundError, UsageError

__all__ = [
    "AccountMeta",
    "EntityRow",
    "SessionStore",
    "TgSession",
    "atomic_write",
    "entity_kind",
]

# How long a cache write waits for another process's write before failing.
# Writes are single short batches (well under 10 ms), so 5 s only matters under
# pathological contention; it is far below any command timeout.
_BUSY_TIMEOUT_MS = 5000

_SCHEMA = """
create table if not exists entities (
    id integer primary key,
    hash integer not null,
    username text,
    phone text,
    name text,
    kind text,
    date integer not null
);
create index if not exists entities_username on entities(lower(username));
create index if not exists entities_phone on entities(phone);
"""

# A full entity (kind known) replaces the row; a bare InputPeer (kind unknown,
# e.g. Telethon's self-id marker row) only refreshes the hash.
_UPSERT = """
insert into entities (id, hash, username, phone, name, kind, date)
values (?, ?, ?, ?, ?, ?, ?)
on conflict(id) do update set
    hash = excluded.hash,
    username = case when excluded.kind is null then username else excluded.username end,
    phone = case when excluded.kind is null then phone else excluded.phone end,
    name = case when excluded.kind is null then name else excluded.name end,
    kind = coalesce(excluded.kind, kind),
    date = excluded.date
"""

_FIND_BY_ID = "select id, hash, username, phone, name, kind from entities where id = ?"
_FIND_BY_USERNAME = (
    "select id, hash, username, phone, name, kind from entities"
    " where lower(username) = ? order by date desc limit 1"
)
_FIND_BY_PHONE = "select id, hash, username, phone, name, kind from entities where phone = ?"

_ACCOUNT_NAME_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_-")


@dataclass(frozen=True)
class EntityRow:
    """One cached peer. `id` is Telethon's marked id (-100… channels, -… chats)."""

    id: int
    hash: int
    username: str | None
    phone: str | None
    name: str | None
    kind: str | None  # user | bot | group | channel | supergroup; None = only the hash is known


@dataclass(frozen=True)
class AccountMeta:
    user_id: int
    username: str | None
    name: str
    phone: str | None


def entity_kind(entity: Any) -> str | None:
    """user | bot | group | channel | supergroup for a Telethon User/Chat/Channel."""
    if isinstance(entity, types.User):
        return "bot" if entity.bot else "user"
    if isinstance(entity, types.Chat | types.ChatForbidden):
        return "group"
    if isinstance(entity, types.Channel | types.ChannelForbidden):
        return "supergroup" if entity.megagroup else "channel"
    return None


class TgSession(MemorySession):  # type: ignore[misc]  # Telethon is untyped
    """A MemorySession whose auth lives in a file and whose entity cache is shared SQLite."""

    def __init__(self, auth_path: Path, cache_path: Path) -> None:
        super().__init__()
        self._auth_path = auth_path
        self._cache_path = cache_path
        self._loaded_auth = ""
        self._db: sqlite3.Connection | None = None
        if auth_path.exists():
            self._loaded_auth = auth_path.read_text().strip()
            if self._loaded_auth:
                loaded = StringSession(self._loaded_auth)
                self.set_dc(loaded.dc_id, loaded.server_address, loaded.port)
                self.auth_key = loaded.auth_key

    # --- auth -------------------------------------------------------------

    def save(self) -> None:
        """Persist the auth key only when it changed (login, DC migration)."""
        if not self.auth_key:
            return
        current = StringSession.save(self)
        if current == self._loaded_auth:
            return
        atomic_write(self._auth_path, current)
        self._loaded_auth = current

    def delete(self) -> None:
        self.close()
        for path in (self._auth_path, self._cache_path, *_sqlite_sidecars(self._cache_path)):
            path.unlink(missing_ok=True)

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    # --- entity cache -----------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        if self._db is None:
            fresh = not self._cache_path.exists()
            db = sqlite3.connect(
                self._cache_path, timeout=_BUSY_TIMEOUT_MS / 1000, isolation_level=None
            )
            db.execute(f"pragma busy_timeout = {_BUSY_TIMEOUT_MS}")
            db.execute("pragma journal_mode = wal")
            db.execute("pragma synchronous = normal")
            db.executescript(_SCHEMA)
            if fresh:
                self._cache_path.chmod(0o600)
            self._db = db
        return self._db

    def _entity_to_row(self, e: Any) -> tuple[Any, ...] | None:
        row = super()._entity_to_row(e)
        if row is None:
            return None
        marked_id, access_hash, _lowered, phone, name = row
        # Keep the username's own case for display (lookups compare lower()), and
        # fall back to the first active collectible username: such accounts have
        # username=None and their handles only in `usernames`.
        username = getattr(e, "username", None)
        if username is None:
            active = [u.username for u in getattr(e, "usernames", None) or [] if u.active]
            username = active[0] if active else None
        return (marked_id, access_hash, username, phone, name, entity_kind(e))

    def process_entities(self, tlo: Any) -> None:
        rows = self._entities_to_rows(tlo)
        if not rows:
            return
        now = int(time.time())
        db = self._conn()
        with db:  # one short transaction per batch; WAL lets readers through
            db.executemany(_UPSERT, [(*row, now) for row in rows])

    def _one(self, sql: str, *args: object) -> tuple[int, int] | None:
        row = self._conn().execute(sql, args).fetchone()
        return (row[0], row[1]) if row else None

    def get_entity_rows_by_phone(self, phone: str) -> tuple[int, int] | None:
        return self._one("select id, hash from entities where phone = ?", phone)

    def get_entity_rows_by_username(self, username: str) -> tuple[int, int] | None:
        return self._one(
            "select id, hash from entities where lower(username) = ? order by date desc limit 1",
            username.lower(),
        )

    def get_entity_rows_by_name(self, name: str) -> tuple[int, int] | None:
        return self._one("select id, hash from entities where name = ?", name)

    def get_entity_rows_by_id(self, id: int, exact: bool = True) -> tuple[int, int] | None:  # noqa: A002 — Telethon's method signature
        if exact:
            return self._one("select id, hash from entities where id = ?", id)
        return self._one(
            "select id, hash from entities where id in (?, ?, ?)",
            id,
            -id,
            -(10**12 + id),
        )

    # --- tg-kit lookups (full rows, for display and kind) -----------------

    def find(
        self, *, peer_id: int | None = None, username: str | None = None, phone: str | None = None
    ) -> EntityRow | None:
        """The cached row for exactly one of: marked id, username (any case), phone."""
        if peer_id is not None:
            row = self._conn().execute(_FIND_BY_ID, (peer_id,)).fetchone()
        elif username is not None:
            row = self._conn().execute(_FIND_BY_USERNAME, (username.lower(),)).fetchone()
        elif phone is not None:
            row = self._conn().execute(_FIND_BY_PHONE, (phone,)).fetchone()
        else:
            msg = "find() needs peer_id, username or phone"
            raise ValueError(msg)
        return EntityRow(*row) if row else None


class SessionStore:
    """Owns `<config>/sessions/`: which accounts exist and where their files live."""

    def __init__(self, root: Path) -> None:
        self._dir = root / "sessions"

    @property
    def directory(self) -> Path:
        return self._dir

    def ensure_dir(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        self._dir.chmod(0o700)

    def accounts(self) -> list[str]:
        if not self._dir.exists():
            return []
        # The .json is written only after a completed login; a .session alone may
        # hold the unauthorized key of an aborted login and is not an account.
        return sorted(
            p.stem for p in self._dir.glob("*.json") if (self._dir / f"{p.stem}.session").exists()
        )

    def select(self, requested: str | None, default: str | None) -> str:
        """The account a command acts on. Never a silent guess among several."""
        names = self.accounts()
        if requested is not None:
            if requested not in names:
                listing = ", ".join(names) or "none"
                msg = f"no account named {requested!r} (logged in: {listing})"
                raise NotFoundError(msg, hint=f"run: tg login --account {requested}")
            return requested
        if not names:
            msg = "not logged in"
            raise AuthRequiredError(msg, hint="ask the account owner to run: tg login")
        if len(names) == 1:
            return names[0]
        if default in names:
            return default
        msg = f"several accounts are logged in ({', '.join(names)}) and none is chosen"
        raise UsageError(msg, hint="pass --account NAME or set default_account in config.toml")

    def open(self, name: str) -> TgSession:
        validate_account_name(name)
        self.ensure_dir()
        return TgSession(self._dir / f"{name}.session", self._dir / f"{name}.cache.db")

    def meta(self, name: str) -> AccountMeta | None:
        path = self._dir / f"{name}.json"
        if not path.exists():
            return None
        raw = json.loads(path.read_text())
        return AccountMeta(
            user_id=int(raw["user_id"]),
            username=raw.get("username"),
            name=str(raw.get("name", "")),
            phone=raw.get("phone"),
        )

    def save_meta(self, name: str, meta: AccountMeta) -> None:
        self.ensure_dir()
        atomic_write(self._dir / f"{name}.json", json.dumps(asdict(meta)))

    def remove(self, name: str) -> None:
        """Remove what `log_out()` leaves behind (it deletes the session files itself)."""
        base = self._dir / name
        for suffix in (".session", ".cache.db", ".json"):
            Path(f"{base}{suffix}").unlink(missing_ok=True)
        for path in _sqlite_sidecars(Path(f"{base}.cache.db")):
            path.unlink(missing_ok=True)


def validate_account_name(name: str) -> None:
    if not name or not set(name) <= _ACCOUNT_NAME_CHARS:
        msg = f"invalid account name {name!r}: use lowercase letters, digits, '-' and '_'"
        raise UsageError(msg)


def _sqlite_sidecars(db: Path) -> tuple[Path, Path]:
    return Path(f"{db}-wal"), Path(f"{db}-shm")


def atomic_write(path: Path, content: str) -> None:
    """Temp file in the same dir, 0600, then rename: readers never see half a file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(content)
        Path(tmp).replace(path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            Path(tmp).unlink()
        raise
