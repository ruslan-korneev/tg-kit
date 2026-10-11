"""Numeric ids: a bare id is a user, else the channel/group id Telegram apps show.

Offline: a fake session holds cache rows and a fake client's dialog scan adds
rows to it, the way Telethon's iter_dialogs fills the real entity cache.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable

import pytest

from tg_kit.config import Config
from tg_kit.errors import NotFoundError, UsageError
from tg_kit.guard import check
from tg_kit.peers import Peer, parse_peer, resolve
from tg_kit.plan import target_of
from tg_kit.session import EntityRow

BARE = 1555000111  # made up; one raw id, three namespaces
USER = EntityRow(BARE, 1, "example_bot", None, "Example", "bot")
CHANNEL = EntityRow(-(10**12 + BARE), 2, None, None, "Example Channel", "supergroup")
GROUP = EntityRow(-BARE, 0, None, None, "Example Group", "group")


class FakeSession:
    def __init__(self, rows: Iterable[EntityRow]) -> None:
        self.rows = {r.id: r for r in rows}

    def find(self, *, peer_id: int) -> EntityRow | None:
        return self.rows.get(peer_id)


class FakeClient:
    """`iter_dialogs` caches `dialog_rows` and counts how often it ran."""

    def __init__(self, session: FakeSession, dialog_rows: Iterable[EntityRow] = ()) -> None:
        self.session = session
        self.dialog_rows = list(dialog_rows)
        self.scans = 0

    async def iter_dialogs(self, *, limit: int) -> AsyncIterator[EntityRow]:
        self.scans += 1
        for row in self.dialog_rows[:limit]:
            self.session.rows[row.id] = row
            yield row


def run(
    spec: str, cached: Iterable[EntityRow] = (), dialogs: Iterable[EntityRow] = ()
) -> tuple[Peer, FakeClient]:
    session = FakeSession(cached)
    client = FakeClient(session, dialogs)
    peer = asyncio.run(resolve(client, session, parse_peer(spec), self_id=None))
    return peer, client


@pytest.mark.parametrize(
    ("cached", "dialogs", "expected"),
    [
        ([CHANNEL], [], CHANNEL),
        ([], [CHANNEL], CHANNEL),
        ([GROUP], [], GROUP),
        ([], [GROUP], GROUP),
    ],
    ids=["channel-cached", "channel-in-dialogs", "group-cached", "group-in-dialogs"],
)
def test_bare_id_falls_back_to_channel_then_group(
    cached: list[EntityRow], dialogs: list[EntityRow], expected: EntityRow
) -> None:
    peer, client = run(str(BARE), cached, dialogs)
    assert (peer.id, peer.kind, peer.title) == (expected.id, expected.kind, expected.name)
    assert client.scans == 1  # the user miss costs the one scan it always did, never more


@pytest.mark.parametrize(
    ("cached", "dialogs", "scans"),
    [
        ([USER, CHANNEL, GROUP], [], 0),
        ([CHANNEL, GROUP], [USER], 1),
        ([CHANNEL], [USER], 1),
    ],
    ids=["all-cached", "user-in-dialogs", "channel-cached-user-in-dialogs"],
)
def test_user_wins_over_chats_with_the_same_bare_id(
    cached: list[EntityRow], dialogs: list[EntityRow], scans: int
) -> None:
    peer, client = run(str(BARE), cached, dialogs)
    assert (peer.id, peer.kind) == (BARE, "bot")
    assert client.scans == scans


def test_channel_and_group_with_the_same_bare_id_are_refused() -> None:
    with pytest.raises(UsageError) as caught:
        run(str(BARE), [CHANNEL, GROUP])
    err = caught.value
    assert "matches more than one chat" in str(err)
    assert f"supergroup {CHANNEL.id} (Example Channel)" in str(err)
    assert f"group {GROUP.id} (Example Group)" in str(err)
    assert err.hint == f"pass the marked id: {CHANNEL.id} or {GROUP.id}"


def test_bare_id_found_nowhere_names_the_forms_tried_and_what_helps() -> None:
    with pytest.raises(NotFoundError) as caught:
        run(str(BARE))
    err = caught.value
    assert str(err) == (
        f"id {BARE} is not in the local cache or the latest 500 dialogs "
        f"(tried as user {BARE}, channel -100{BARE}, group -{BARE})"
    )
    assert err.hint == (
        "pass its @username or t.me/name link, or pin the chat in a Telegram app "
        "so the 500-dialog scan reaches it"
    )


@pytest.mark.parametrize("row", [CHANNEL, GROUP], ids=["channel", "group"])
def test_marked_id_resolves_only_as_given(row: EntityRow) -> None:
    peer, _ = run(str(row.id), [USER, CHANNEL, GROUP])
    assert peer.id == row.id


@pytest.mark.parametrize("row", [CHANNEL, GROUP], ids=["channel", "group"])
def test_marked_id_miss_keeps_the_old_error(row: EntityRow) -> None:
    # The bare user id is cached, but a marked id never falls back to another form.
    with pytest.raises(NotFoundError) as caught:
        run(str(row.id), [USER])
    msg = f"id {row.id} is not in the local cache or the latest 500 dialogs"
    assert str(caught.value) == msg
    assert caught.value.hint == "resolve it by @username first (tg resolve @name), then use the id"


def allowed(spec: str, allow: Iterable[EntityRow], cached: Iterable[EntityRow]) -> bool:
    peer, _ = run(spec, cached)
    verdict = check(
        Config(),
        allowed_ids=frozenset(r.id for r in allow),
        action="send",
        target=target_of(peer),
        yes=False,
    )
    return verdict.allowed


def test_bare_id_of_an_allowlisted_channel_is_allowed() -> None:
    assert allowed(str(BARE), [CHANNEL], [CHANNEL])


@pytest.mark.parametrize(
    ("allow", "cached"),
    [
        ([USER], [CHANNEL]),  # the allowlisted user is not reachable; the channel is not allowed
        ([CHANNEL], [USER, CHANNEL]),  # bare id means the user, who is not allowed
        ([GROUP], [CHANNEL]),  # same raw id, other namespace
    ],
    ids=["user-allowed-channel-resolved", "channel-allowed-user-resolved", "group-vs-channel"],
)
def test_allowlist_matches_the_resolved_peer_not_the_typed_id(
    allow: list[EntityRow], cached: list[EntityRow]
) -> None:
    assert not allowed(str(BARE), allow, cached)
