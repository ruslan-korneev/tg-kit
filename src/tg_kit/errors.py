"""The error hierarchy, and the exit code each error maps to.

Exit codes are a contract agents branch on, so each class pins one code and
the CLI never picks a code any other way:

    0 ok · 1 unexpected · 2 usage · 3 auth required · 4 peer/button not found
    5 flood wait too long · 6 --wait got no reply · 7 refused by guard/policy
"""

from __future__ import annotations

__all__ = [
    "EXIT_AUTH",
    "EXIT_FLOOD",
    "EXIT_NOT_FOUND",
    "EXIT_NO_REPLY",
    "EXIT_OK",
    "EXIT_REFUSED",
    "EXIT_UNEXPECTED",
    "EXIT_USAGE",
    "AuthRequiredError",
    "FloodWaitTooLongError",
    "NoReplyError",
    "NotFoundError",
    "RefusedError",
    "TgError",
    "UsageError",
]

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_USAGE = 2
EXIT_AUTH = 3
EXIT_NOT_FOUND = 4
EXIT_FLOOD = 5
EXIT_NO_REPLY = 6
EXIT_REFUSED = 7


class TgError(Exception):
    """Base for every failure tg-kit reports on purpose.

    `hint` is the fix — a command to run or a flag to add — printed on its own
    line so the reader does not have to dig it out of the message.
    """

    exit_code: int = EXIT_UNEXPECTED

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.hint: str | None = hint


class UsageError(TgError):
    exit_code: int = EXIT_USAGE


class AuthRequiredError(TgError):
    exit_code: int = EXIT_AUTH


class NotFoundError(TgError):
    """A peer, message, button or account that does not exist or is ambiguous."""

    exit_code: int = EXIT_NOT_FOUND


class FloodWaitTooLongError(TgError):
    exit_code: int = EXIT_FLOOD

    def __init__(self, seconds: int, *, hint: str | None = None) -> None:
        super().__init__(f"FLOOD_WAIT {seconds}s: Telegram asks to wait before retrying", hint=hint)
        self.seconds: int = seconds


class NoReplyError(TgError):
    exit_code: int = EXIT_NO_REPLY


class RefusedError(TgError):
    """The guard or a policy refused the action; nothing was sent."""

    exit_code: int = EXIT_REFUSED
