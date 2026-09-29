"""Pins the CLI value parsers: durations, --since, TEXT|- input, and long-text splitting.

Not covered: how typer routes these values; that is exercised in test_cli.py.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta, timezone

import pytest

from tg_kit.errors import UsageError
from tg_kit.parsing import parse_duration, parse_since, read_text
from tg_kit.texts import split_text

NOW = datetime(2026, 9, 29, 14, 0, tzinfo=timezone(timedelta(hours=3)))


@pytest.mark.parametrize(
    ("value", "seconds"),
    [
        ("500ms", 0.5),
        ("5s", 5.0),
        ("2m", 120.0),
        ("1h", 3600.0),
        ("10", 10.0),
        ("1.5", 1.5),
        ("1.5s", 1.5),
        (" 3S ", 3.0),
    ],
)
def test_duration_is_parsed_to_seconds(value: str, seconds: float) -> None:
    assert parse_duration(value) == seconds


@pytest.mark.parametrize("value", ["", "fast", "5x", "-1s", "1m30s", "s"])
def test_invalid_duration_is_refused_with_examples(value: str) -> None:
    with pytest.raises(UsageError, match="500ms, 5s, 2m"):
        parse_duration(value)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("30m", datetime(2026, 9, 29, 10, 30, tzinfo=UTC)),
        ("2h", datetime(2026, 9, 29, 9, 0, tzinfo=UTC)),
        ("3d", datetime(2026, 9, 26, 11, 0, tzinfo=UTC)),
        ("1w", datetime(2026, 9, 22, 11, 0, tzinfo=UTC)),
        # A naive date is local midnight (UTC+3 here), not UTC midnight.
        ("2026-09-01", datetime(2026, 8, 31, 21, 0, tzinfo=UTC)),
        ("2026-09-01T12:00:00+00:00", datetime(2026, 9, 1, 12, 0, tzinfo=UTC)),
    ],
)
def test_since_accepts_relative_and_iso(value: str, expected: datetime) -> None:
    assert parse_since(value, now=NOW) == expected


def test_since_rejects_garbage() -> None:
    with pytest.raises(UsageError, match="invalid --since"):
        parse_since("yesterday", now=NOW)


def test_dash_reads_multiline_stdin_without_trailing_newline() -> None:
    assert read_text("-", io.StringIO("line 1\nline 2\n")) == "line 1\nline 2"


def test_text_argument_is_used_verbatim() -> None:
    assert read_text("hi *there*", io.StringIO("ignored")) == "hi *there*"


@pytest.mark.parametrize(("value", "stdin"), [("", ""), ("   ", ""), ("-", "\n")])
def test_empty_text_is_refused(value: str, stdin: str) -> None:
    with pytest.raises(UsageError, match="empty message text"):
        read_text(value, io.StringIO(stdin))


def test_short_text_is_one_chunk() -> None:
    assert split_text("hello", limit=10) == ["hello"]


def test_split_prefers_paragraph_then_line_then_word() -> None:
    assert split_text("aaaa\n\nbbbb", limit=7) == ["aaaa", "bbbb"]
    assert split_text("aaaa\nbbbb", limit=7) == ["aaaa", "bbbb"]
    assert split_text("aaaa bbbb", limit=7) == ["aaaa", "bbbb"]


def test_unbroken_run_is_cut_hard_and_nothing_is_lost() -> None:
    chunks = split_text("x" * 25, limit=10)
    assert chunks == ["x" * 10, "x" * 10, "x" * 5]


def test_every_chunk_respects_the_limit() -> None:
    text = ("word " * 50 + "\n") * 40
    chunks = split_text(text, limit=300)
    assert all(len(c) <= 300 for c in chunks)
    assert "".join(chunks).replace(" ", "").replace("\n", "") == text.replace(" ", "").replace(
        "\n", ""
    )
