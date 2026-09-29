"""Pins allow.toml: round trip, labels kept for humans, re-adding refreshes labels,
removal, and refusal of a malformed file.

Not covered: `tg allow add` resolving peers (live check).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tg_kit.allowlist import AllowEntry, Allowlist, load_allowlist, save_allowlist
from tg_kit.errors import UsageError

BOT = AllowEntry(
    id=123456, kind="bot", username="example_bot", name="Пример «бот»", added="2026-09-29"
)
ME = AllowEntry(id=1, kind="self", username=None, name="Saved Messages", added="2026-09-29")


def test_round_trip_keeps_ids_and_human_labels(tmp_path: Path) -> None:
    path = tmp_path / "allow.toml"
    save_allowlist(path, Allowlist((ME, BOT)))
    text = path.read_text()
    assert "Decisions use `id` only" in text
    assert 'name = "Пример «бот»"' in text  # readable, not \\u-escaped
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    loaded = load_allowlist(path)
    assert loaded.entries == (ME, BOT)
    assert loaded.ids == frozenset({1, 123456})


def test_missing_file_is_an_empty_allowlist(tmp_path: Path) -> None:
    assert load_allowlist(tmp_path / "allow.toml").ids == frozenset()


def test_readding_an_id_refreshes_its_labels_without_duplicating() -> None:
    renamed = AllowEntry(
        id=123456, kind="bot", username="example_bot2", name="New", added="2026-10-01"
    )
    allowlist = Allowlist((BOT, ME)).with_entry(renamed)
    assert [e.id for e in allowlist.entries] == [1, 123456]
    assert allowlist.entries[-1].username == "example_bot2"


def test_remove_by_id() -> None:
    assert Allowlist((BOT, ME)).without(123456).ids == frozenset({1})


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ('[[peer]]\nid = "123"\n', "integer id"),
        ("[[peer]]\nid = 1\ncolour = 2\n", "integer id and only"),
        ('allow = ["me"]\n', "only \\[\\[peer\\]\\]"),
        ("[[peer]\n", "invalid TOML"),
    ],
)
def test_malformed_file_is_refused(tmp_path: Path, content: str, message: str) -> None:
    path = tmp_path / "allow.toml"
    path.write_text(content)
    with pytest.raises(UsageError, match=message):
        load_allowlist(path)
