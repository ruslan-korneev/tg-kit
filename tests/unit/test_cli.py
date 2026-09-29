"""Pins the process contract for paths that need no network: exit codes for usage
errors and missing login, stdout/stderr split, no tracebacks.

Runs the real `tg` entry point in a subprocess with an empty TG_KIT_CONFIG_DIR
and fake app credentials, so nothing touches the real account. Not covered:
commands that reach Telegram (live smoke test).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


def tg(tmp_path: Path, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "TG_KIT_CONFIG_DIR": str(tmp_path),
        "TG_KIT_API_ID": "1",
        "TG_KIT_API_HASH": "fake",
    }
    return subprocess.run(  # noqa: S603 — fixed argv: this interpreter + the test's own args
        [sys.executable, "-c", "from tg_kit.cli import main; main()", *args],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
        check=False,
    )


def test_accounts_is_empty_and_succeeds_without_login(tmp_path: Path) -> None:
    result = tg(tmp_path, "accounts", "--json")
    assert result.returncode == 0
    assert result.stdout.strip() == "[]"


@pytest.mark.parametrize(
    ("args", "code", "message"),
    [
        (("read", "me"), 3, "not logged in"),
        (("send", "me", "hi", "--wait", "soon"), 2, "invalid duration"),
        (("send", "me", "-"), 2, "empty message text"),
        (("read", "hello world"), 3, "not logged in"),
        (("raw", "messages.GetHistroy"), 2, "did you mean: messages.GetHistory"),
        (("raw", "messages.GetHistory", "[1]"), 2, "must be a JSON object"),
        (("press", "@example_bot", "1", "--data", "x", "--data-hex", "00"), 2, "not both"),
        (("login",), 3, "needs a terminal"),
        (("logout",), 3, "not logged in"),
    ],
)
def test_failures_exit_with_the_contracted_code_and_one_line(
    tmp_path: Path, args: tuple[str, ...], code: int, message: str
) -> None:
    result = tg(tmp_path, *args)
    assert result.returncode == code, result.stderr
    assert message in result.stderr
    assert "Traceback" not in result.stderr
    assert result.stdout == ""


def test_bad_config_is_a_usage_error(tmp_path: Path) -> None:
    (tmp_path / "config.toml").write_text("readonly = 1\n")
    result = tg(tmp_path, "accounts")
    assert result.returncode == 2
    assert "readonly must be true or false" in result.stderr


def test_empty_allowlist_lists_with_a_hint(tmp_path: Path) -> None:
    result = tg(tmp_path, "allow", "list")
    assert result.returncode == 0
    assert "allowlist is empty" in result.stderr
