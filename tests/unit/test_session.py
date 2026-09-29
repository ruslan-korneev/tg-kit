"""Pins the split session: auth file written only on change and atomically, entity
cache shared across connections (WAL, no "database is locked"), collectible
usernames, account selection, and config validation.

The cross-process test uses real OS processes on a tmp_path cache. Not covered:
Telegram accepting the auth key (live smoke test).
"""

from __future__ import annotations

import multiprocessing
import sqlite3
from pathlib import Path

import pytest
from telethon.crypto import AuthKey
from telethon.tl import types

from tg_kit.config import Config, load_config
from tg_kit.errors import AuthRequiredError, NotFoundError, UsageError
from tg_kit.session import AccountMeta, SessionStore, TgSession


def session(tmp_path: Path) -> TgSession:
    return TgSession(tmp_path / "a.session", tmp_path / "a.cache.db")


def test_auth_is_written_once_and_read_back(tmp_path: Path) -> None:
    s = session(tmp_path)
    s.set_dc(2, "149.154.167.51", 443)
    s.auth_key = AuthKey(b"k" * 256)
    s.save()
    auth = tmp_path / "a.session"
    assert oct(auth.stat().st_mode & 0o777) == "0o600"
    before = auth.stat().st_mtime_ns
    s.save()  # unchanged → no rewrite
    assert auth.stat().st_mtime_ns == before

    loaded = session(tmp_path)
    assert (loaded.dc_id, loaded.server_address, loaded.port) == (2, "149.154.167.51", 443)
    assert loaded.auth_key.key == b"k" * 256


def test_session_without_key_writes_nothing(tmp_path: Path) -> None:
    session(tmp_path).save()
    assert not (tmp_path / "a.session").exists()


def test_entities_are_cached_with_kind_and_original_case(tmp_path: Path) -> None:
    s = session(tmp_path)
    bot = types.User(id=5, bot=True, username="Example_Bot", first_name="Ex", access_hash=9)
    chan = types.Channel(
        id=7, title="News", photo=types.ChatPhotoEmpty(), date=None, broadcast=True, access_hash=3
    )
    s.process_entities(
        types.contacts.ResolvedPeer(peer=types.PeerUser(5), chats=[chan], users=[bot])
    )
    row = s.find(username="example_bot")
    assert row is not None
    assert (row.id, row.hash, row.username, row.kind) == (5, 9, "Example_Bot", "bot")
    assert s.find(peer_id=-1000000000007).kind == "channel"  # type: ignore[union-attr]
    # Telethon's own lookups (lowercased usernames, exact/inexact ids) keep working.
    assert s.get_entity_rows_by_username("example_bot") == (5, 9)
    assert s.get_entity_rows_by_id(7, exact=False) == (-1000000000007, 3)
    assert oct((tmp_path / "a.cache.db").stat().st_mode & 0o777) == "0o600"
    assert sqlite3.connect(tmp_path / "a.cache.db").execute("pragma journal_mode").fetchone() == (
        "wal",
    )


def test_collectible_username_is_cached_when_username_is_empty(tmp_path: Path) -> None:
    s = session(tmp_path)
    user = types.User(
        id=8,
        first_name="C",
        access_hash=1,
        username=None,
        usernames=[
            types.Username(username="old_name", active=False),
            types.Username(username="Collectible", active=True),
        ],
    )
    s.process_entities(types.contacts.ResolvedPeer(peer=types.PeerUser(8), chats=[], users=[user]))
    assert s.find(username="collectible") is not None


def test_bare_input_peer_row_keeps_known_details(tmp_path: Path) -> None:
    s = session(tmp_path)
    bot = types.User(id=5, bot=True, username="example_bot", first_name="Ex", access_hash=9)
    s.process_entities([bot])
    s.process_entities([types.InputPeerUser(5, 10)])  # Telethon's self-marker style row
    row = s.find(peer_id=5)
    assert row is not None
    assert (row.hash, row.username, row.kind) == (10, "example_bot", "bot")


def _writer(cache: str, start: int) -> None:
    s = TgSession(Path(cache).with_suffix(".session"), Path(cache))
    for i in range(start, start + 200):
        s.process_entities([types.User(id=i, first_name="u", access_hash=i)])
    s.close()


def test_parallel_processes_share_the_cache_without_locking_errors(tmp_path: Path) -> None:
    cache = tmp_path / "a.cache.db"
    session(tmp_path).process_entities([types.User(id=1, first_name="u", access_hash=1)])
    ctx = multiprocessing.get_context("spawn")
    procs = [ctx.Process(target=_writer, args=(str(cache), 1000 * (n + 1))) for n in range(4)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(60)
    assert [p.exitcode for p in procs] == [0, 0, 0, 0]
    count = sqlite3.connect(cache).execute("select count(*) from entities").fetchone()[0]
    assert count == 1 + 4 * 200


def _store(tmp_path: Path, *names: str) -> SessionStore:
    store = SessionStore(tmp_path)
    store.ensure_dir()
    for n in names:
        (tmp_path / "sessions" / f"{n}.session").write_text("x")
        store.save_meta(n, AccountMeta(user_id=1, username=None, name=n, phone=None))
    return store


def test_single_account_is_used_implicitly(tmp_path: Path) -> None:
    assert _store(tmp_path, "main").select(None, None) == "main"


def test_several_accounts_need_a_choice(tmp_path: Path) -> None:
    store = _store(tmp_path, "main", "work")
    assert store.select(None, "work") == "work"
    assert store.select("main", "work") == "main"
    with pytest.raises(UsageError, match=r"several accounts are logged in \(main, work\)"):
        store.select(None, None)


def test_unknown_account_lists_the_known_ones(tmp_path: Path) -> None:
    with pytest.raises(NotFoundError, match=r"no account named 'x' \(logged in: main\)"):
        _store(tmp_path, "main").select("x", None)


def test_no_accounts_means_auth_required(tmp_path: Path) -> None:
    with pytest.raises(AuthRequiredError, match="not logged in"):
        SessionStore(tmp_path).select(None, None)


def test_aborted_login_is_not_an_account(tmp_path: Path) -> None:
    store = _store(tmp_path)
    (tmp_path / "sessions" / "main.session").write_text("unauthorized key")
    assert store.accounts() == []


def test_sessions_dir_is_private(tmp_path: Path) -> None:
    _store(tmp_path)
    assert oct((tmp_path / "sessions").stat().st_mode & 0o777) == "0o700"


def test_config_reads_settings(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('default_account = "main"\nreadonly = true\nflood_sleep_threshold = 10\n')
    assert load_config(path) == Config(
        default_account="main", readonly=True, flood_sleep_threshold=10
    )


def test_missing_config_is_the_empty_policy(tmp_path: Path) -> None:
    assert load_config(tmp_path / "none.toml") == Config()


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("readonly = 1\n", "readonly must be true or false"),
        ("colour = 1\n", "unknown keys \\['colour'\\]"),
        ('[write]\nallow = ["me"]\n', "allowlist lives in allow.toml"),
        ("flood_sleep_threshold = -1\n", "non-negative integer"),
        ("readonly = \n", "invalid TOML"),
    ],
)
def test_bad_config_is_refused_with_what_is_valid(
    tmp_path: Path, content: str, message: str
) -> None:
    path = tmp_path / "config.toml"
    path.write_text(content)
    with pytest.raises(UsageError, match=message):
        load_config(path)
