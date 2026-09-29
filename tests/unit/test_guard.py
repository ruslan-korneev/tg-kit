"""Pins the write guard's decision table: readonly, always-confirm actions, title
matches, the id-based allowlist, and --yes.

Not covered: where the CLI calls the guard — that each write command goes
through it is pinned by the live smoke test (send @durov → exit 7).
"""

from __future__ import annotations

import pytest

from tg_kit.config import Config
from tg_kit.guard import Target, check, is_allowlisted

ME = Target(id=1, kind="self", username="someone")
BOT = Target(id=123456, kind="bot", username="Example_Bot")
STRANGER = Target(id=999, kind="user", username="stranger")
FUZZY = Target(id=-100777, kind="supergroup", username=None, fuzzy=True)
IDS = frozenset({1, 123456, -100777})
# The username a stranger now holds used to belong to the allowlisted bot.
IMPOSTOR = Target(id=555, kind="user", username="Example_Bot")


@pytest.mark.parametrize(
    ("target", "allowed"),
    [(ME, True), (BOT, True), (STRANGER, False), (FUZZY, True), (IMPOSTOR, False)],
)
def test_allowlist_matches_by_id_only(target: Target, allowed: bool) -> None:
    assert is_allowlisted(IDS, target) is allowed


@pytest.mark.parametrize(
    ("config", "target", "yes", "always", "allowed", "reason"),
    [
        (Config(), BOT, False, False, True, "in the allowlist"),
        (Config(), STRANGER, False, False, False, "not in the allowlist"),
        (Config(), STRANGER, True, False, True, "--yes"),
        (Config(readonly=True), ME, True, False, False, "readonly"),
        (Config(), ME, False, True, False, "always needs --yes"),
        (Config(), ME, True, True, True, "in the allowlist"),
        (Config(), FUZZY, False, False, False, "title match"),
        (Config(), FUZZY, True, False, True, "in the allowlist"),
        (Config(), None, False, True, False, "always needs --yes"),
        (Config(), None, True, True, True, "--yes"),
    ],
)
def test_guard_decision_table(
    config: Config, target: Target | None, yes: bool, always: bool, allowed: bool, reason: str
) -> None:
    verdict = check(
        config,
        allowed_ids=IDS,
        action="delete" if always else "send",
        target=target,
        yes=yes,
        always_confirm=always,
    )
    assert verdict.allowed is allowed
    assert reason in verdict.reason


def test_readonly_beats_yes_and_allowlist() -> None:
    verdict = check(Config(readonly=True), allowed_ids=IDS, action="send", target=BOT, yes=True)
    assert not verdict.allowed
