"""Negative chat ids (-100… channels, -… groups) parse as PEER, not as `-1…` flags.

Parses through the real command tree without invoking any command body, so
nothing connects; the CliRunner cases check the exit code end to end.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import typer
from typer.core import TyperGroup
from typer.testing import CliRunner

from tg_kit.cli import app

CHANNEL = "-1001234567890"
GROUP = "-123456"


def parse(argv: list[str]) -> dict[str, Any]:
    """The params the command named by argv's leading words would be invoked with."""
    command = typer.main.get_command(app)
    while isinstance(command, TyperGroup):
        name, *argv = argv
        command = command.commands[name]
    return command.make_context(command.name, argv).params


@pytest.mark.parametrize(
    ("argv", "param", "expected"),
    [
        (["read", "{id}"], "peer", "{id}"),
        (["read", "{id}", "--json", "-v"], "peer", "{id}"),
        (["msg", "{id}", "5", "6"], "peer", "{id}"),
        (["search", "{id}", "hello"], "args", ["{id}", "hello"]),
        (["resolve", "{id}"], "spec", "{id}"),
        (["info", "{id}"], "peer", "{id}"),
        (["download", "{id}", "5"], "peer", "{id}"),
        (["transcribe", "{id}", "5"], "peer", "{id}"),
        (["send", "{id}", "hi", "--reply-to", "5"], "peer", "{id}"),
        (["send-file", "{id}", "photo.jpg"], "peer", "{id}"),
        (["edit", "{id}", "5", "new text"], "peer", "{id}"),
        (["delete", "{id}", "5", "6", "--yes"], "peer", "{id}"),
        (["forward", "{id}", "5", "--to", "me"], "from_peer", "{id}"),
        (["forward", "me", "5", "--to", "{id}"], "to", "{id}"),
        (["react", "{id}", "5", "👍"], "peer", "{id}"),
        (["draft", "{id}", "text"], "peer", "{id}"),
        (["mark-read", "{id}"], "peer", "{id}"),
        (["press", "{id}", "5", "OK"], "peer", "{id}"),
        (["inline", "@example_bot", "q", "--pick", "1", "--to", "{id}"], "to", "{id}"),
        (["allow", "add", "{id}", "--yes"], "peers", ["{id}"]),
        (["allow", "remove", "{id}"], "peers", ["{id}"]),
    ],
)
@pytest.mark.parametrize("peer_id", [CHANNEL, GROUP])
def test_negative_id_is_a_peer(
    argv: list[str], param: str, expected: str | list[str], peer_id: str
) -> None:
    def fill(value: str) -> str:
        return value.replace("{id}", peer_id)

    want = [fill(v) for v in expected] if isinstance(expected, list) else fill(expected)
    got = parse([fill(a) for a in argv])[param]
    assert (list(got) if isinstance(want, list) else got) == want


def test_several_negative_ids_in_one_list() -> None:
    assert list(parse(["allow", "add", CHANNEL, GROUP, "me"])["peers"]) == [CHANNEL, GROUP, "me"]


def test_options_after_a_negative_id_still_parse() -> None:
    params = parse(["send", CHANNEL, "hi", "--reply-to", "5", "--dry-run", "-y"])
    assert (params["peer"], params["text"], params["reply_to"]) == (CHANNEL, "hi", 5)
    assert params["dry_run"] is True
    assert params["yes"] is True


def test_double_dash_still_passes_dash_text() -> None:
    assert parse(["send", "me", "--", "--not-a-flag"])["text"] == "--not-a-flag"


@pytest.mark.parametrize(
    "argv",
    [
        ["read", CHANNEL, "--jsno"],
        ["send", "me", "--typo"],
        ["allow", "add", GROUP, "--typo"],
        ["read", "-x"],
    ],
)
def test_a_mistyped_option_still_exits_2(argv: list[str]) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 2
    assert "No such option" in result.output


def test_negative_id_reaches_the_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TG_KIT_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("TG_KIT_API_ID", "1")
    monkeypatch.setenv("TG_KIT_API_HASH", "fake")
    result = CliRunner().invoke(app, ["read", CHANNEL])
    assert result.exit_code == 3  # past parsing, stopped at login
    assert "not logged in" in result.output
