"""Write safety: may this write go to this target without asking? Pure.

Order of rules (first match decides):
1. `readonly = true` in config → refused, whatever the flags.
2. A post into a closed forum topic → refused, whatever the flags.
3. An always-confirm action (delete, logout, raw write) without `--yes` → refused.
4. A target found by fuzzy title match without `--yes` → refused.
5. Target id in the allowlist (`allow.toml`, see `tg_kit.allowlist`) → allowed.
6. `--yes` → allowed.
7. Otherwise → refused: the target is not allowlisted.

A forum topic never changes the target: the allowlist holds chats, and an
allowlisted forum is allowed in every one of its topics.
"""

from __future__ import annotations

from dataclasses import dataclass

from tg_kit.config import Config

__all__ = ["Target", "Verdict", "check", "is_allowlisted"]


@dataclass(frozen=True)
class Target:
    id: int | None
    kind: str | None
    username: str | None
    fuzzy: bool = False


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    reason: str


def is_allowlisted(allowed_ids: frozenset[int], target: Target) -> bool:
    """By id only: a username can move to another account, an id cannot."""
    return target.id is not None and target.id in allowed_ids


def check(  # noqa: PLR0911 — one return per rule, in the docstring's order
    config: Config,
    *,
    allowed_ids: frozenset[int],
    action: str,
    target: Target | None,
    yes: bool,
    always_confirm: bool = False,
    closed_topic: int | None = None,
) -> Verdict:
    """`closed_topic`: the id of the closed forum topic the write would post into."""
    if config.readonly:
        return Verdict(
            allowed=False, reason="readonly = true in config.toml: every write is refused"
        )
    if closed_topic is not None:
        return Verdict(
            allowed=False, reason=f"forum topic {closed_topic} is closed: nobody can post in it"
        )
    if always_confirm and not yes:
        return Verdict(allowed=False, reason=f"{action} always needs --yes")
    if target is not None and target.fuzzy and not yes:
        return Verdict(
            allowed=False,
            reason="the target came from a title match; confirm with --yes or use @username/id",
        )
    if target is not None and is_allowlisted(allowed_ids, target):
        return Verdict(allowed=True, reason="target is in the allowlist (allow.toml)")
    if yes:
        return Verdict(allowed=True, reason="confirmed with --yes")
    return Verdict(
        allowed=False,
        reason="target is not in the allowlist; rerun with --yes only if the owner agreed",
    )
