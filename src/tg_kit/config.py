"""`~/.config/tg-kit/config.toml` — the user's settings. tg-kit only reads it.

The write allowlist is not here: it is `allow.toml`, owned by `tg_kit.allowlist`.

The config dir also holds `sessions/`, owned by `tg_kit.session`. Override the
whole dir with `TG_KIT_CONFIG_DIR` (tests do, so they never see real state).
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from tg_kit.errors import UsageError

__all__ = ["Config", "config_dir", "load_config"]

# Telethon sleeps through a FLOOD_WAIT up to this many seconds; longer waits exit 5.
# 30 s is the brief's default: long enough to ride out the common short waits,
# short enough that an agent is not left hanging on a half-minute+ pause.
DEFAULT_FLOOD_SLEEP_THRESHOLD = 30


@dataclass(frozen=True)
class Config:
    default_account: str | None = None
    readonly: bool = False
    flood_sleep_threshold: int = DEFAULT_FLOOD_SLEEP_THRESHOLD


def config_dir() -> Path:
    override = os.environ.get("TG_KIT_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "tg-kit"


_TOP_KEYS = {"default_account", "readonly", "write", "flood_sleep_threshold"}


def load_config(path: Path | None = None) -> Config:
    """Read and validate config.toml; a missing file is the empty policy."""
    path = path or config_dir() / "config.toml"
    if not path.exists():
        return Config()
    try:
        raw = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        msg = f"{path}: invalid TOML ({exc})"
        raise UsageError(msg) from exc
    return _parse(raw, path)


def _parse(raw: dict[str, object], path: Path) -> Config:
    unknown = set(raw) - _TOP_KEYS
    if unknown:
        msg = f"{path}: unknown keys {sorted(unknown)}; valid: {sorted(_TOP_KEYS)}"
        raise UsageError(msg)
    if "write" in raw:
        # The allowlist moved to allow.toml (by peer id, owned by `tg allow`).
        msg = f"{path}: [write] is no longer read; the allowlist lives in allow.toml"
        raise UsageError(msg, hint="delete [write] from config.toml, then: tg allow add PEER --yes")
    default_account = raw.get("default_account")
    readonly = raw.get("readonly", False)
    threshold = raw.get("flood_sleep_threshold", DEFAULT_FLOOD_SLEEP_THRESHOLD)
    if default_account is not None and not isinstance(default_account, str):
        msg = f"{path}: default_account must be a string"
        raise UsageError(msg)
    if not isinstance(readonly, bool):
        msg = f"{path}: readonly must be true or false"
        raise UsageError(msg)
    if not isinstance(threshold, int) or isinstance(threshold, bool) or threshold < 0:
        msg = f"{path}: flood_sleep_threshold must be a non-negative integer (seconds)"
        raise UsageError(msg)
    return Config(
        default_account=default_account,
        readonly=readonly,
        flood_sleep_threshold=threshold,
    )
