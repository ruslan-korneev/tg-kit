"""Pins `tg raw` conversion: method lookup and hints, camel→snake keys, peer params
resolved by the request's own type annotations, bytes markers, explicit TL
objects, dates, defaults for omitted required params, and result serialisation.

Peers are resolved through a recording fake; no network. Not covered: sending
the built request (live smoke test).
"""

from __future__ import annotations

import asyncio
import base64
import inspect
from datetime import UTC, datetime
from typing import Any, Optional

import pytest
from telethon.tl import functions, types

from tg_kit.errors import UsageError
from tg_kit.peers import Peer
from tg_kit.raw import (
    _nullable,
    build_object,
    find_method,
    is_read_method,
    method_name,
    to_jsonable,
)

BOT_PEER = Peer(
    id=123456,
    kind="bot",
    username="example_bot",
    title="Example",
    input=types.InputPeerUser(123456, 11),
)
ME_PEER = Peer(
    id=1000, kind="self", username=None, title="Saved Messages", input=types.InputPeerSelf()
)
CHANNEL_PEER = Peer(
    id=-1000000000777,
    kind="channel",
    username="example_news",
    title="News",
    input=types.InputPeerChannel(777, 44),
)


class FakeResolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, spec: str) -> Peer:
        self.calls.append(spec)
        return {"me": ME_PEER, "@example_bot": BOT_PEER, "@example_news": CHANNEL_PEER}[spec]


def build(method: str, params: dict[str, object]) -> tuple[Any, FakeResolver]:
    resolver = FakeResolver()
    return asyncio.run(build_object(find_method(method), params, resolver)), resolver


@pytest.mark.parametrize(
    "name",
    [
        "messages.GetHistory",
        "messages.GetHistoryRequest",
        "messages.getHistory",
        "MESSAGES.GETHISTORY",
    ],
)
def test_method_names_resolve_in_every_spelling(name: str) -> None:
    assert find_method(name) is functions.messages.GetHistoryRequest


def test_unknown_method_suggests_close_names() -> None:
    with pytest.raises(UsageError, match="unknown MTProto method") as info:
        find_method("messages.GetHistroy")
    assert info.value.hint is not None
    assert "messages.GetHistory" in info.value.hint


@pytest.mark.parametrize(
    ("name", "read"),
    [
        ("messages.GetHistory", True),
        ("messages.SearchGlobal", True),
        ("contacts.ResolveUsername", True),
        ("account.CheckUsername", True),
        ("channels.ExportMessageLink", True),
        ("messages.ExportChatInvite", False),
        ("bots.ExportBotToken", False),
        ("auth.ExportAuthorization", False),
        ("auth.CheckPassword", False),
        ("messages.GetBotCallbackAnswer", False),
        ("messages.GetMessagesViews", False),
        ("contacts.GetLocated", False),
        ("account.GetTmpPassword", False),
        ("messages.SendMessage", False),
        ("channels.LeaveChannel", False),
        ("messages.DeleteHistory", False),
    ],
)
def test_read_methods_are_get_search_check_resolve_minus_known_writes(
    name: str, read: bool
) -> None:
    assert is_read_method(find_method(name)) is read


def test_method_name_round_trips() -> None:
    assert method_name(functions.users.GetFullUserRequest) == "users.GetFullUser"


def test_peer_params_resolve_to_the_annotated_input_type() -> None:
    req, resolver = build("messages.GetHistory", {"peer": "@example_bot", "limit": 2})
    assert isinstance(req, functions.messages.GetHistoryRequest)
    assert req.peer == types.InputPeerUser(123456, 11)
    assert (req.limit, req.offset_id, req.hash, req.offset_date) == (2, 0, 0, None)
    assert resolver.calls == ["@example_bot"]

    full, _ = build("users.GetFullUser", {"id": "me"})
    assert full.id == types.InputUserSelf()

    chan, _ = build("channels.GetFullChannel", {"channel": "@example_news"})
    assert chan.channel == types.InputChannel(777, 44)


def test_camel_case_keys_become_snake_case() -> None:
    req, _ = build(
        "messages.GetHistory", {"peer": "me", "offsetId": 10, "addOffset": -5, "maxId": 3}
    )
    assert (req.offset_id, req.add_offset, req.max_id) == (10, -5, 3)


def test_list_of_input_messages_accepts_bare_ids() -> None:
    req, _ = build("messages.GetMessages", {"id": [5, {"_": "InputMessageReplyTo", "id": 6}]})
    assert req.id == [types.InputMessageID(5), types.InputMessageReplyTo(6)]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("go", b"go"),
        ({"$bytes": "go"}, b"go"),
        ({"$hex": "676f"}, b"go"),
        ({"$b64": base64.b64encode(b"go").decode()}, b"go"),
    ],
)
def test_bytes_markers(value: object, expected: bytes) -> None:
    req, _ = build(
        "messages.GetBotCallbackAnswer", {"peer": "@example_bot", "msgId": 7, "data": value}
    )
    assert req.data == expected
    assert req.msg_id == 7


@pytest.mark.parametrize(
    ("value", "message"),
    [({"$hex": "zz"}, "invalid \\$hex"), ({"$b64": "!!"}, "invalid \\$b64"), (5, "bytes go as")],
)
def test_bad_bytes_are_usage_errors(value: object, message: str) -> None:
    with pytest.raises(UsageError, match=message):
        build("messages.GetBotCallbackAnswer", {"peer": "@example_bot", "msg_id": 1, "data": value})


def test_explicit_tl_objects_are_built_recursively() -> None:
    req, _ = build(
        "messages.SendReaction",
        {
            "peer": "@example_bot",
            "msg_id": 3,
            "reaction": [{"_": "ReactionEmoji", "emoticon": "👍"}],
        },
    )
    assert req.reaction == [types.ReactionEmoji("👍")]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1_790_000_000, datetime.fromtimestamp(1_790_000_000, tz=UTC)),
        ("2026-09-01T00:00:00", datetime(2026, 9, 1, tzinfo=UTC)),
    ],
)
def test_dates_accept_unix_and_iso(value: object, expected: datetime) -> None:
    req, _ = build("messages.GetHistory", {"peer": "me", "offsetDate": value})
    assert req.offset_date == expected


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"peer": "me", "bogus": 1}, "unknown params \\['bogus'\\]"),
        ({"peer": "me", "limit": "two"}, "expected an integer"),
        ({"peer": "me", "limit": True}, "expected an integer"),
        ({"peer": ["me"]}, "expected a peer spec"),
        ({"peer": "me", "offsetDate": "soon"}, "invalid ISO date"),
    ],
)
def test_bad_params_are_usage_errors_naming_the_field(
    params: dict[str, object], message: str
) -> None:
    with pytest.raises(UsageError, match=message):
        build("messages.GetHistory", params)


def test_missing_required_non_defaultable_param_lists_required() -> None:
    with pytest.raises(UsageError, match="missing param 'peer'; required"):
        build("messages.GetHistory", {"limit": 1})


def test_fieldless_methods_and_constructors_take_no_params() -> None:
    req, _ = build("account.GetAuthorizations", {})
    assert isinstance(req, functions.account.GetAuthorizationsRequest)
    priv, _ = build("account.GetPrivacy", {"key": {"_": "InputPrivacyKeyPhoneNumber"}})
    assert priv.key == types.InputPrivacyKeyPhoneNumber()


def test_unknown_tl_constructor_suggests_close_names() -> None:
    with pytest.raises(UsageError, match="unknown TL constructor 'ReactionEmojj'"):
        build(
            "messages.SendReaction",
            {"peer": "me", "msg_id": 1, "reaction": [{"_": "ReactionEmojj"}]},
        )


def test_result_serialises_bytes_as_base64_and_dates_as_iso() -> None:
    answer = types.messages.BotCallbackAnswer(cache_time=0, message="hi")
    photo = types.PhotoSize("m", 1, 1, 5)
    doc = to_jsonable(
        {"a": answer, "b": b"\x00\x01", "d": datetime(2026, 9, 1, tzinfo=UTC), "l": (photo,)}
    )
    assert doc == {
        "a": {
            "_": "BotCallbackAnswer",
            "cache_time": 0,
            "alert": None,
            "has_url": None,
            "native_ui": None,
            "message": "hi",
            "url": None,
        },
        "b": "AAE=",
        "d": "2026-09-01T00:00:00+00:00",
        "l": [{"_": "PhotoSize", "type": "m", "w": 1, "h": 1, "size": 5}],
    }


def _hint(request: type, param: str) -> object:
    return inspect.signature(request.__init__).parameters[param].annotation  # type: ignore[misc]


@pytest.mark.parametrize(
    ("annotation", "nullable"),
    [
        (datetime | None, True),
        (Optional[datetime], True),  # noqa: UP045 — the 3.12/3.13 spelling Telethon hints resolve to
        # Telethon's own hints, as the running Python renders them:
        (_hint(functions.messages.GetHistoryRequest, "offset_date"), True),
        (_hint(functions.messages.ForwardMessagesRequest, "send_as"), True),
        (_hint(functions.messages.GetHistoryRequest, "peer"), False),
        ("TypeInputPeer", False),
        (int, False),
        (list[int], False),
    ],
)
def test_nullable_is_detected_on_every_python_spelling(annotation: object, nullable: bool) -> None:
    assert _nullable(annotation) is nullable
