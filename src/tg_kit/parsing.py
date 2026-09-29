"""Pure parsers for CLI values: durations, `--since`, message text input."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TextIO

from tg_kit.errors import UsageError

__all__ = ["parse_duration", "parse_since", "read_text"]

_DURATION = re.compile(r"^(\d+(?:\.\d+)?)(ms|s|m|h)?$")
_UNIT_SECONDS = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0, None: 1.0}
_SINCE_REL = re.compile(r"^(\d+)(m|h|d|w)$")
_SINCE_UNITS = {"m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def parse_duration(value: str) -> float:
    """`500ms`, `5s`, `2m`, `1h`, or a bare number of seconds → seconds."""
    match = _DURATION.match(value.strip().lower())
    if not match:
        msg = f"invalid duration {value!r}; use e.g. 500ms, 5s, 2m, 1h or a bare number of seconds"
        raise UsageError(msg)
    amount, unit = match.groups()
    return float(amount) * _UNIT_SECONDS[unit]


def parse_since(value: str, *, now: datetime) -> datetime:
    """`30m`, `2h`, `3d`, `1w` ago, or an ISO date/datetime → an aware UTC datetime.

    A naive ISO value is read in `now`'s timezone, which the CLI sets to local
    time: `--since 2026-09-01` means the local midnight, as a person means it.
    """
    text = value.strip()
    rel = _SINCE_REL.match(text.lower())
    if rel:
        amount, unit = rel.groups()
        return (now - timedelta(**{_SINCE_UNITS[unit]: int(amount)})).astimezone(UTC)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        msg = f"invalid --since {value!r}; use 30m, 2h, 3d, 1w or a date like 2026-09-01"
        raise UsageError(msg) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=now.tzinfo)
    return parsed.astimezone(UTC)


def read_text(value: str, stdin: TextIO) -> str:
    """The TEXT argument, or all of stdin when it is `-` (multi-line, no escaping)."""
    text = stdin.read() if value == "-" else value
    if value == "-":
        text = text.removesuffix("\n")
    if not text.strip():
        source = "stdin" if value == "-" else "TEXT"
        msg = f"empty message text from {source}"
        raise UsageError(msg)
    return text
