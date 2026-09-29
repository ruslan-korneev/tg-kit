"""Building and connecting the Telethon client; translating its errors.

This module and the other Telethon adapters (`peers`, `convert`, `actions`,
`raw`, `waiter`'s event source) are the only places Telethon types appear.
Everything they raise upward is a `TgError`.
"""

from __future__ import annotations

import asyncio
import contextlib
import platform
import sys
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from telethon import TelegramClient, errors

from tg_kit import __version__
from tg_kit.config import Config
from tg_kit.credentials import AppCredentials
from tg_kit.errors import AuthRequiredError, FloodWaitTooLongError, TgError, UsageError
from tg_kit.session import AccountMeta, SessionStore, TgSession

__all__ = [
    "CONNECT_TIMEOUT",
    "Connected",
    "QrPrompt",
    "build_client",
    "connect",
    "login",
    "meta_from_user",
    "rpc_error_name",
    "telegram_errors",
]

# Telethon's per-connection-attempt timeout; the brief's ~10 s connect budget.
CONNECT_TIMEOUT = 10
# Connection attempts before giving up (Telethon backs off `retry_delay` between them).
CONNECT_RETRIES = 3
# Telethon re-sends a request on transient server errors (-500/-503). Safe for
# sends: the retry reuses the same request object and so the same random_id,
# which Telegram de-duplicates. Kept low so a sick DC fails fast.
REQUEST_RETRIES = 2
# QR login: codes offered before giving up (each lives ~30 s, so ~2.5 min in all),
# and the shortest wait per code even if our clock says it already expired.
QR_ATTEMPTS = 5
QR_MIN_WAIT = 5.0

_AUTH_ERRORS = (
    errors.AuthKeyUnregisteredError,
    errors.SessionRevokedError,
    errors.SessionExpiredError,
    errors.UserDeactivatedError,
    errors.UserDeactivatedBanError,
    errors.AuthKeyDuplicatedError,
)


@dataclass(frozen=True)
class QrPrompt:
    """One QR code to show: the tg://login URL, which try it is, and how long it lives."""

    url: str
    attempt: int
    attempts: int
    expires_in: float


@dataclass
class Connected:
    client: Any  # telethon.TelegramClient — untyped
    session: TgSession
    account: str
    me: AccountMeta | None


def build_client(
    session: TgSession, creds: AppCredentials, config: Config, *, updates: bool
) -> Any:
    return TelegramClient(
        session,
        creds.api_id,
        creds.api_hash,
        # Recognisable in Telegram → Settings → Devices.
        device_model="tg-kit",
        system_version=f"{platform.system()} {platform.release()}",
        app_version=__version__,
        timeout=CONNECT_TIMEOUT,
        connection_retries=CONNECT_RETRIES,
        request_retries=REQUEST_RETRIES,
        flood_sleep_threshold=config.flood_sleep_threshold,
        receive_updates=updates,
        catch_up=False,
    )


@contextlib.asynccontextmanager
async def connect(
    store: SessionStore,
    account: str,
    creds: AppCredentials,
    config: Config,
    *,
    updates: bool = False,
) -> AsyncIterator[Connected]:
    """A connected, authorized client; always disconnected on the way out."""
    session = store.open(account)
    client = build_client(session, creds, config, updates=updates)
    try:
        with telegram_errors():
            await client.connect()
            # connect() already ran get_me() for a logged-in session and set
            # _authorized; this is a cached check, not another round trip.
            if not await client.is_user_authorized():
                msg = f"account {account!r} is not logged in (session revoked or never completed)"
                raise AuthRequiredError(
                    msg, hint=f"ask the account owner to run: tg login --account {account}"
                )
        yield Connected(client=client, session=session, account=account, me=store.meta(account))
    finally:
        with contextlib.suppress(
            Exception
        ):  # degradation boundary: a failed disconnect must not mask the real outcome
            await asyncio.wait_for(client.disconnect(), 5)
        session.close()


@contextlib.contextmanager
def telegram_errors() -> Iterator[None]:
    """Translate Telethon/transport exceptions into TgError at the adapter edge."""
    try:
        yield
    except TgError:
        raise
    except errors.FloodError as exc:
        # FloodWait, SlowModeWait, FloodPremiumWait…: all carry the seconds to wait.
        seconds = getattr(exc, "seconds", None)
        if seconds is None:
            raise TgError(f"Telegram rate-limited the request: {rpc_error_name(exc)}") from exc
        raise FloodWaitTooLongError(int(seconds), hint=f"retry in {int(seconds)}s") from exc
    except _AUTH_ERRORS as exc:
        msg = f"Telegram rejected the session ({type(exc).__name__})"
        raise AuthRequiredError(msg, hint="ask the account owner to run: tg login") from exc
    except errors.RPCError as exc:
        from tg_kit.raw import method_name

        inner = exc.request
        # Telethon wraps requests (InvokeWithoutUpdates, InvokeWithLayer…); name the real one.
        while inner is not None and type(inner).__name__.startswith("Invoke"):
            inner = getattr(inner, "query", None)
        request = method_name(type(inner)) if inner is not None else "the request"
        msg = f"Telegram refused {request}: {rpc_error_name(exc)}"
        raise TgError(msg) from exc
    except (ConnectionError, OSError) as exc:
        msg = f"cannot reach Telegram: {exc}"
        raise TgError(msg, hint="check the network and retry") from exc


def rpc_error_name(exc: Any) -> str:
    """PEER_ID_INVALID, not Telethon's generic `.message` (BAD_REQUEST) for known errors."""
    from telethon.errors.rpcerrorlist import rpc_errors_dict

    for name, cls in rpc_errors_dict.items():
        if type(exc) is cls:
            return str(name)
    return str(exc.message)


def meta_from_user(user: Any) -> AccountMeta:
    name = " ".join(p for p in (user.first_name, user.last_name) if p) or str(user.id)
    username = user.username or next(
        (u.username for u in getattr(user, "usernames", None) or [] if u.active), None
    )  # collectible usernames leave `username` empty
    return AccountMeta(user_id=int(user.id), username=username, name=name, phone=user.phone)


async def login(
    store: SessionStore,
    account: str,
    creds: AppCredentials,
    config: Config,
    *,
    phone: Callable[[], str],
    code: Callable[[], str],
    password: Callable[[], str],
    qr: Callable[[QrPrompt], None] | None,
) -> AccountMeta:
    """Interactive login. A fresh auth key every time — never an imported one.

    `qr` given → QR login (shows the tg://login URL via the callback and waits
    for a scan); otherwise phone + code. Either way a 2FA password is asked
    for when the account has one.
    """
    session = store.open(account)
    # QR login needs updates (the "token accepted" signal arrives as one).
    client = build_client(session, creds, config, updates=qr is not None)
    try:
        with telegram_errors():
            await client.connect()
            if await client.is_user_authorized():
                me = await client.get_me()
            elif qr is not None:
                me = await _qr_login(client, qr, password)
            else:
                me = await _phone_login(client, phone, code, password)
        meta = meta_from_user(me)
        store.save_meta(account, meta)
        return meta
    finally:
        with contextlib.suppress(Exception):  # degradation boundary: see connect()
            await asyncio.wait_for(client.disconnect(), 5)
        session.close()


async def _phone_login(
    client: Any, phone: Callable[[], str], code: Callable[[], str], password: Callable[[], str]
) -> Any:
    number = phone()
    try:
        await client.send_code_request(number)
    except errors.PhoneNumberInvalidError as exc:
        raise UsageError(f"Telegram says {number!r} is not a valid phone number") from exc
    for _ in range(3):
        try:
            return await client.sign_in(number, code())
        except errors.PhoneCodeInvalidError:
            print("wrong code, try again", file=sys.stderr)  # noqa: T201 — interactive login feedback on stderr
        except errors.SessionPasswordNeededError:
            return await _password(client, password)
    raise AuthRequiredError("three wrong codes; login aborted", hint="run: tg login")


async def _qr_login(
    client: Any, show: Callable[[QrPrompt], None], password: Callable[[], str]
) -> Any:
    qr = await client.qr_login()
    for attempt in range(1, QR_ATTEMPTS + 1):
        # Wait exactly as long as this token lives (Telegram's `expires`), then
        # draw a fresh one; the floor absorbs clock skew between us and Telegram.
        ttl = max((qr.expires - datetime.now(tz=UTC)).total_seconds(), QR_MIN_WAIT)
        show(QrPrompt(url=qr.url, attempt=attempt, attempts=QR_ATTEMPTS, expires_in=ttl))
        try:
            return await qr.wait(timeout=ttl)
        except TimeoutError:
            await qr.recreate()
        except errors.SessionPasswordNeededError:
            return await _password(client, password)
    raise AuthRequiredError("QR code was not scanned in time", hint="run: tg login --qr")


async def _password(client: Any, password: Callable[[], str]) -> Any:
    for _ in range(3):
        try:
            return await client.sign_in(password=password())
        except errors.PasswordHashInvalidError:
            print("wrong password, try again", file=sys.stderr)  # noqa: T201 — interactive login feedback on stderr
    raise AuthRequiredError("three wrong 2FA passwords; login aborted", hint="run: tg login")
