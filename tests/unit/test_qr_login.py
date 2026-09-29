"""Pins the QR-login loop: each expired token is replaced by a new code (shown via
the callback with its attempt number and lifetime), a scan returns the user, 2FA
is asked when needed, and after the last code it gives up with exit 3.

The QR object is a fake with Telethon's QRLogin surface (url, expires, wait,
recreate). Not covered: Telegram accepting the scan (done live by the owner).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest
from telethon import errors

from tg_kit.client import QR_ATTEMPTS, QrPrompt, _qr_login
from tg_kit.errors import AuthRequiredError


@dataclass
class FakeQR:
    scanned_on: int | None  # attempt that succeeds; None = never
    needs_2fa: bool = False
    attempt: int = 1
    recreated: int = 0
    waits: list[float] = field(default_factory=list)

    @property
    def url(self) -> str:
        return f"tg://login?token=t{self.attempt}"

    @property
    def expires(self) -> datetime:
        return datetime.now(tz=UTC) + timedelta(seconds=30)

    async def wait(self, timeout: float) -> str:  # noqa: ASYNC109 — mirrors QRLogin.wait
        self.waits.append(timeout)
        if self.attempt == self.scanned_on:
            if self.needs_2fa:
                raise errors.SessionPasswordNeededError(request=None)
            return "user"
        raise TimeoutError

    async def recreate(self) -> None:
        self.recreated += 1
        self.attempt += 1


@dataclass
class FakeClient:
    qr: FakeQR
    passwords: list[str] = field(default_factory=list)

    async def qr_login(self) -> FakeQR:
        return self.qr

    async def sign_in(self, *, password: str) -> str:
        self.passwords.append(password)
        return "user-2fa"


def run(qr: FakeQR) -> tuple[object, list[QrPrompt], FakeClient]:
    shown: list[QrPrompt] = []
    client = FakeClient(qr)
    result = asyncio.run(_qr_login(client, shown.append, lambda: "secret"))
    return result, shown, client


def test_expired_codes_are_replaced_until_one_is_scanned() -> None:
    qr = FakeQR(scanned_on=3)
    user, shown, _ = run(qr)
    assert user == "user"
    assert [p.url for p in shown] == [f"tg://login?token=t{i}" for i in (1, 2, 3)]
    assert [(p.attempt, p.attempts) for p in shown] == [
        (1, QR_ATTEMPTS),
        (2, QR_ATTEMPTS),
        (3, QR_ATTEMPTS),
    ]
    assert qr.recreated == 2
    assert all(25 < w <= 30 for w in qr.waits)  # waits the token's real lifetime


def test_two_factor_password_is_asked_after_the_scan() -> None:
    user, _, client = run(FakeQR(scanned_on=1, needs_2fa=True))
    assert user == "user-2fa"
    assert client.passwords == ["secret"]


def test_gives_up_with_exit_3_after_the_last_code() -> None:
    qr = FakeQR(scanned_on=None)
    with pytest.raises(AuthRequiredError, match="not scanned in time") as info:
        run(qr)
    assert info.value.exit_code == 3
    assert qr.recreated == QR_ATTEMPTS
