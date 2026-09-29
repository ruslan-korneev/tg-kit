"""Shared fixtures: Telethon messages built offline, the way the library builds them.

`tl_message` runs Telethon's own `Message._finish_init` with a stand-in client
that has only the two attributes it reads, so `msg.sender` / `msg.forward`
are populated exactly as they are for a real response.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
from telethon._updates import EntityCache
from telethon.tl import types

SELF_ID = 1000
BOT = types.User(id=123456, bot=True, username="example_bot", first_name="Example", access_hash=11)
PERSON = types.User(id=222, first_name="Alex", last_name="K.", access_hash=22)
ME = types.User(id=SELF_ID, is_self=True, first_name="Me", access_hash=33)
CHANNEL = types.Channel(
    id=777,
    title="Example News",
    photo=types.ChatPhotoEmpty(),
    date=None,
    broadcast=True,
    username="example_news",
    access_hash=44,
)
DATE = datetime(2026, 9, 29, 11, 2, tzinfo=UTC)


class _Client:
    _self_id = SELF_ID

    def __init__(self) -> None:
        self._mb_entity_cache = EntityCache()


MessageFactory = Callable[..., Any]


@pytest.fixture
def tl_message() -> MessageFactory:
    def make(
        *,
        cls: Any = types.Message,
        peers: tuple[Any, ...] = (BOT, PERSON, ME, CHANNEL),
        **fields: Any,
    ) -> Any:
        fields.setdefault("id", 677791)
        fields.setdefault("peer_id", types.PeerUser(BOT.id))
        fields.setdefault("from_id", types.PeerUser(BOT.id))
        fields.setdefault("date", DATE)
        if cls is types.Message:
            fields.setdefault("message", "")
        msg = cls(**fields)
        by_id = {}
        for e in peers:
            key = -(10**12 + e.id) if isinstance(e, types.Channel) else e.id
            by_id[key] = e
        msg._finish_init(_Client(), by_id, None)
        return msg

    return make
