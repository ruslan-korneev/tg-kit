"""Pins the delegate rules the two mods share: mods/dialogs-pane-guard carries
byte-identical copies of mods/dialogs-pane/hooks/delegate (the engine loads no
file from outside a plugin's folder, symlinks included). Each mod's
contract.ts, the one file that differs, is not compared.

A drifted copy means the guard judges a Worker's call by other rules than the
card shows. Not covered: that the guard's contract.ts exports the same names.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PANE = ROOT / "mods/dialogs-pane/hooks/delegate"
GUARD = ROOT / "mods/dialogs-pane-guard/hooks/delegate"
SHARED = ["shell.ts", "paths.ts", "stops.ts", "grant.ts", "skip.ts", "task.ts"]


@pytest.mark.parametrize("name", SHARED)
def test_the_guard_copy_matches_the_pane(name: str) -> None:
    copy, source = GUARD / name, PANE / name
    assert copy.read_bytes() == source.read_bytes(), f"copy {source} to {copy}"


def test_the_guard_carries_no_other_rule_file() -> None:
    assert sorted(path.name for path in GUARD.iterdir()) == sorted([*SHARED, "contract.ts"])
