"""App credentials (api_id / api_hash) — keychain first, env override.

Named `credentials` rather than the brief's `secrets` so it does not shadow the
stdlib module. The hash is never printed, logged, or written to a file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from tg_kit.errors import AuthRequiredError, UsageError

__all__ = ["AppCredentials", "load_app", "store_app"]

SERVICE = "tg-kit"


@dataclass(frozen=True)
class AppCredentials:
    api_id: int
    api_hash: str

    def __repr__(self) -> str:
        return f"AppCredentials(api_id={self.api_id}, api_hash=<hidden>)"


def load_app() -> AppCredentials:
    env_id = os.environ.get("TG_KIT_API_ID")
    env_hash = os.environ.get("TG_KIT_API_HASH")
    if env_id and env_hash:
        return AppCredentials(_parse_id(env_id), env_hash)

    import keyring

    stored_id = keyring.get_password(SERVICE, "api_id")
    stored_hash = keyring.get_password(SERVICE, "api_hash")
    if not stored_id or not stored_hash:
        msg = "no Telegram app credentials (api_id/api_hash) in the keychain or env"
        raise AuthRequiredError(msg, hint="run: tg auth set-app --api-id N")
    return AppCredentials(_parse_id(stored_id), stored_hash)


def store_app(creds: AppCredentials) -> None:
    import keyring

    keyring.set_password(SERVICE, "api_id", str(creds.api_id))
    keyring.set_password(SERVICE, "api_hash", creds.api_hash)


def _parse_id(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        msg = "api_id must be an integer"
        raise UsageError(msg) from None
