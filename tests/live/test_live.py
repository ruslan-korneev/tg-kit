"""Live checks against the real logged-in account. Opt-in: TG_KIT_LIVE=1.

Pins what unit tests cannot: several `tg` processes sharing one account at the
same time (the SQLite "database is locked" failure the session split exists to
prevent). Reads Saved Messages only; sends nothing.

Run: TG_KIT_LIVE=1 uv run pytest tests/live -q
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TG_KIT_LIVE") != "1" or shutil.which("tg") is None,
    reason="live test: set TG_KIT_LIVE=1 with tg installed and logged in",
)

PARALLEL = 6
TG = shutil.which("tg") or "tg"  # the installed binary, as agents call it


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 — fixed argv
        [TG, *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_parallel_commands_all_succeed() -> None:
    commands = [["read", "me", "-n", "1"], ["resolve", "me"], ["whoami"]] * (PARALLEL // 3)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(commands)) as pool:
        results = list(pool.map(_run, commands))
    elapsed = time.monotonic() - started
    failures = [
        (c, r.returncode, r.stderr)
        for c, r in zip(commands, results, strict=True)
        if r.returncode != 0
    ]
    assert failures == []
    assert not any("locked" in r.stderr for r in results)
    # Parallel, not serialised: well under the sum of sequential runs (~1 s each).
    assert elapsed < len(commands) * 0.8
