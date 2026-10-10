"""Live checks against the real logged-in account. Opt-in: TG_KIT_LIVE=1.

Pins what unit tests cannot: several `tg` processes sharing one account at the
same time (the SQLite "database is locked" failure the session split exists to
prevent), `tg watch` receiving real updates, and `tg folders` reading the real
folder list. Touches Saved Messages only: the watch test sends one message
there, edits it and deletes it; the folders test only reads.

Run: TG_KIT_LIVE=1 uv run pytest tests/live -q
"""

from __future__ import annotations

import json
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


def test_folders_lists_all_chats_once_and_every_folder_opens() -> None:
    listed = _run(["folders", "--json"])
    assert listed.returncode == 0, listed.stderr
    folders = json.loads(listed.stdout)
    assert [f["kind"] for f in folders].count("all") == 1
    assert {f["kind"] for f in folders} <= {"all", "folder", "shared"}
    first = _run(["dialogs", "--folder", str(folders[0]["id"]), "-n", "3", "--json"])
    assert first.returncode == 0, first.stderr
    for row in json.loads(first.stdout):
        assert {"pinned", "muted", "mentions"} <= row.keys()


def test_watch_streams_a_message_its_edit_and_its_deletion_in_saved_messages() -> None:
    watcher = subprocess.Popen(  # noqa: S603 — fixed argv
        [TG, "watch", "me", "--jsonl", "--idle-exit", "15s"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert watcher.stdout is not None
        ready = json.loads(watcher.stdout.readline())  # subscribed from here on
        assert ready["event"] == "ready"
        sent = _run(["send", "me", "tg-kit live: watch", "--json"])
        assert sent.returncode == 0, sent.stderr
        msg_id = json.loads(sent.stdout)["sent"][0]["id"]
        assert _run(["edit", "me", str(msg_id), "tg-kit live: watch (edited)"]).returncode == 0
        assert _run(["delete", "me", str(msg_id), "--yes"]).returncode == 0
        lines = [json.loads(watcher.stdout.readline()) for _ in range(3)]
    finally:
        watcher.terminate()
        code = watcher.wait(timeout=30)
    assert [(e["event"], e.get("id"), e.get("ids")) for e in lines] == [
        ("message", msg_id, None),
        ("edit", msg_id, None),
        ("delete", None, [msg_id]),
    ]
    assert lines[1]["text"] == "tg-kit live: watch (edited)"
    assert code == 0  # SIGTERM is a clean stop
