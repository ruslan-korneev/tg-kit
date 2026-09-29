"""Pins how Telethon/transport exceptions become tg-kit errors (and so exit codes)
at the adapter edge: FLOOD_WAIT → 5, revoked session → 3, other RPC errors → 1
with the method named, network failures → 1 with a hint.

Not covered: Telethon raising these for real.
"""

from __future__ import annotations

import pytest
from telethon import errors
from telethon.tl import functions, types

from tg_kit.client import telegram_errors
from tg_kit.errors import AuthRequiredError, FloodWaitTooLongError, TgError


def test_flood_wait_exits_5_with_seconds() -> None:
    with pytest.raises(FloodWaitTooLongError, match="FLOOD_WAIT 120s") as info, telegram_errors():
        raise errors.FloodWaitError(request=None, capture=120)
    assert info.value.exit_code == 5
    assert info.value.hint == "retry in 120s"


@pytest.mark.parametrize(
    "exc",
    [
        errors.AuthKeyUnregisteredError(request=None),
        errors.SessionRevokedError(request=None),
        errors.AuthKeyDuplicatedError(request=None),
    ],
)
def test_dead_session_means_login_again(exc: Exception) -> None:
    with pytest.raises(AuthRequiredError, match="rejected the session") as info, telegram_errors():
        raise exc
    assert info.value.exit_code == 3


def test_other_rpc_errors_name_the_method() -> None:
    request = functions.messages.GetHistoryRequest(
        peer=None, offset_id=0, offset_date=None, add_offset=0, limit=1, max_id=0, min_id=0, hash=0
    )
    error = errors.rpc_message_to_error(types.RpcError(400, "PEER_ID_INVALID"), request)
    with (
        pytest.raises(TgError, match=r"^Telegram refused messages\.GetHistory: PEER_ID_INVALID$"),
        telegram_errors(),
    ):
        raise error


def test_network_failure_suggests_retry() -> None:
    with pytest.raises(TgError, match="cannot reach Telegram") as info, telegram_errors():
        raise ConnectionError("reset by peer")
    assert info.value.hint == "check the network and retry"


def test_bot_response_timeout_keeps_its_cause_for_press() -> None:
    error = errors.rpc_message_to_error(types.RpcError(400, "BOT_RESPONSE_TIMEOUT"), None)
    with pytest.raises(TgError, match="BOT_RESPONSE_TIMEOUT") as info, telegram_errors():
        raise error
    assert isinstance(info.value.__cause__, errors.BotResponseTimeoutError)


def test_wrapped_request_is_named_by_the_inner_method() -> None:
    inner = functions.contacts.ResolveUsernameRequest(username="a")
    wrapped = functions.InvokeWithoutUpdatesRequest(inner)
    error = errors.rpc_message_to_error(types.RpcError(400, "USERNAME_INVALID"), wrapped)
    with (
        pytest.raises(TgError, match=r"refused contacts\.ResolveUsername: USERNAME_INVALID"),
        telegram_errors(),
    ):
        raise error


def test_slow_mode_wait_is_a_flood_wait_too() -> None:
    error = errors.rpc_message_to_error(types.RpcError(420, "SLOWMODE_WAIT_45"), None)
    with pytest.raises(FloodWaitTooLongError, match="FLOOD_WAIT 45s"), telegram_errors():
        raise error
