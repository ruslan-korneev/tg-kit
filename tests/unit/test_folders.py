"""Pins Telegram folders: membership (tdlib's `need_dialog`), order, lookup by id or
title, the layer-229 conversion of `DialogFilter*` and dialogs, the `dialogs` and
`folders` output, the folder list's order (All chats first when the server omits
it), default mutes that fail to load, and how getPeerDialogs survives a chat
Telegram refuses and skips it on later runs.

TL objects are real Telethon classes built offline. Not covered: folders fetched
live (the live test reads `tg folders`), and type-built folders past the latest
500 chats (by design, they are not looked at).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from telethon import errors
from telethon.tl import custom, functions, types

from tg_kit.client import Connected
from tg_kit.cmd_read import (
    REFUSED_FOR,
    _fetch_peer_dialogs,
    _folders_of,
    _mute_defaults,
    _peer_dialogs,
)
from tg_kit.convert import convert_dialog, convert_folder, folder_input_peers
from tg_kit.errors import EXIT_NOT_FOUND, NotFoundError
from tg_kit.folders import ALL_CHATS, Folder, find_folder, folder_order, in_folder, unread_chats
from tg_kit.model import DialogView
from tg_kit.render import dialog_json, dialog_line, folder_json, folder_line
from tg_kit.session import TgSession

from .conftest import BOT, CHANNEL, PERSON, SELF_ID

NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)


def chat(chat_id: int, kind: str, **kw: Any) -> DialogView:
    return DialogView(id=chat_id, kind=kind, title=f"chat {chat_id}", username=None, **kw)


SELF = chat(SELF_ID, "self")
CONTACT = chat(201, "user", contact=True)
STRANGER = chat(202, "user")
BOT_CHAT = chat(203, "bot")
GROUP = chat(-204, "group")
SUPERGROUP = chat(-1000000000205, "supergroup")
NEWS = chat(-1000000000206, "channel")
EVERY_KIND = (SELF, CONTACT, STRANGER, BOT_CHAT, GROUP, SUPERGROUP, NEWS)


def folder(**kw: Any) -> Folder:
    return Folder(id=2, title="Work", kind="folder", **kw)


# --- membership ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("flag", "members"),
    [
        ("contacts", {SELF.id, CONTACT.id}),
        ("non_contacts", {STRANGER.id}),
        ("bots", {BOT_CHAT.id}),
        ("groups", {GROUP.id, SUPERGROUP.id}),
        ("channels", {NEWS.id}),
    ],
)
def test_each_type_flag_takes_its_kind_of_chat(flag: str, members: set[int]) -> None:
    f = folder(**{flag: True})
    assert {c.id for c in EVERY_KIND if in_folder(f, c)} == members


def test_no_flags_and_no_list_is_an_empty_folder() -> None:
    assert not any(in_folder(folder(), c) for c in EVERY_KIND)


def test_pinned_and_included_win_over_excluded_and_over_every_exclusion() -> None:
    old = replace(STRANGER, muted=True, archived=True)  # read, muted, archived
    f = folder(
        pinned=(old.id,),
        include=(GROUP.id,),
        exclude=(old.id, GROUP.id),
        exclude_muted=True,
        exclude_read=True,
        exclude_archived=True,
    )
    assert in_folder(f, old)
    assert in_folder(f, GROUP)


def test_excluded_beats_the_chat_type() -> None:
    f = folder(groups=True, exclude=(GROUP.id,))
    assert not in_folder(f, GROUP)
    assert in_folder(f, SUPERGROUP)


@pytest.mark.parametrize(
    ("rule", "facts", "mentions", "member"),
    [
        ("exclude_muted", {"muted": True, "unread": 3}, 0, False),
        ("exclude_muted", {"muted": True, "unread": 3}, 1, True),
        ("exclude_read", {}, 0, False),
        ("exclude_read", {}, 1, True),
        ("exclude_read", {"unread": 2}, 0, True),
        ("exclude_read", {"marked_unread": True}, 0, True),
        ("exclude_archived", {"archived": True}, 0, False),
        # tdlib: an unread mention keeps a muted or read chat in, not an archived one
        ("exclude_archived", {"archived": True, "unread": 1}, 1, False),
        ("exclude_archived", {}, 0, True),
    ],
)
def test_exclusions_with_and_without_an_unread_mention(
    rule: str, facts: dict[str, Any], mentions: int, member: bool
) -> None:
    f = folder(groups=True, **{rule: True})
    assert in_folder(f, replace(GROUP, mentions=mentions, **facts)) is member


def test_a_shared_folder_is_its_listed_chats_only() -> None:
    f = Folder(id=5, title="Team", kind="shared", pinned=(NEWS.id,), include=(GROUP.id,))
    assert [c.id for c in EVERY_KIND if in_folder(f, c)] == [GROUP.id, NEWS.id]


def test_all_chats_is_every_chat_outside_the_archive() -> None:
    archived = replace(STRANGER, archived=True)
    assert in_folder(ALL_CHATS, GROUP)
    assert not in_folder(ALL_CHATS, archived)


# --- order and counts ----------------------------------------------------------


def test_pinned_come_first_in_the_folders_order_then_newest_first() -> None:
    def at(c: DialogView, minutes: int) -> DialogView:
        return replace(c, last_date=NOW - timedelta(minutes=minutes), pinned=True)

    chats = [at(CONTACT, 1), at(GROUP, 50), at(NEWS, 5), at(BOT_CHAT, 3), replace(STRANGER)]
    f = folder(
        pinned=(NEWS.id, GROUP.id), include=(CONTACT.id, BOT_CHAT.id, STRANGER.id, SUPERGROUP.id)
    )
    ordered = folder_order(f, chats)
    assert [(c.id, c.pinned) for c in ordered] == [
        (NEWS.id, True),
        (GROUP.id, True),
        (CONTACT.id, False),  # pinned in the main list, not in this folder
        (BOT_CHAT.id, False),
        (STRANGER.id, False),  # no last message: last
    ]


def test_all_chats_keeps_telegrams_own_order() -> None:
    chats = [replace(NEWS, pinned=True), GROUP, replace(STRANGER, archived=True), CONTACT]
    assert [c.id for c in folder_order(ALL_CHATS, chats)] == [NEWS.id, GROUP.id, CONTACT.id]


def test_the_count_is_unread_chats_that_are_not_muted() -> None:
    chats = [
        replace(GROUP, unread=4),
        replace(SUPERGROUP, unread=9, muted=True),
        replace(NEWS, marked_unread=True),
        STRANGER,
    ]
    assert unread_chats(folder(groups=True, channels=True, non_contacts=True), chats) == 2


# --- lookup ----------------------------------------------------------------------

FOLDERS = [
    folder(),
    Folder(id=7, title="🤖 Bots", kind="folder", bots=True),
    ALL_CHATS,
    Folder(id=11, title="Team", kind="shared"),
]


@pytest.mark.parametrize(
    ("spec", "found"),
    [("2", 2), ("0", 0), ("Work", 2), ("work", 2), ("🤖 Bots", 7), (" all chats ", 0), ("11", 11)],
)
def test_a_folder_is_found_by_id_or_by_title(spec: str, found: int) -> None:
    assert find_folder(FOLDERS, spec).id == found


def test_an_unknown_folder_exits_4_with_the_list_and_the_fix() -> None:
    with pytest.raises(NotFoundError, match=r'no folder "Home"; folders: 2 Work, 7 🤖 Bots') as e:
        find_folder(FOLDERS, "Home")
    assert e.value.exit_code == EXIT_NOT_FOUND
    assert e.value.hint == "tg folders"


def test_a_title_two_folders_share_is_ambiguous() -> None:
    twins = [folder(), Folder(id=3, title="work", kind="folder")]
    assert find_folder(twins, "Work").id == 2  # exact wins
    with pytest.raises(NotFoundError, match="ambiguous: ids 2, 3"):
        find_folder(twins, "WORK")


# --- the Telethon boundary ---------------------------------------------------------

BOT_PEER = types.InputPeerUser(BOT.id, BOT.access_hash)
PERSON_PEER = types.InputPeerUser(PERSON.id, PERSON.access_hash)
CHANNEL_PEER = types.InputPeerChannel(CHANNEL.id, CHANNEL.access_hash)
CHANNEL_ID = -(10**12 + CHANNEL.id)


def title(text: str) -> types.TextWithEntities:
    return types.TextWithEntities(text=text, entities=[])


def test_a_dialog_filter_converts_every_flag_and_list() -> None:
    tl = types.DialogFilter(
        id=4,
        title=title("🚀 Launch"),
        pinned_peers=[CHANNEL_PEER, types.InputPeerSelf()],
        include_peers=[BOT_PEER],
        exclude_peers=[PERSON_PEER],
        contacts=True,
        non_contacts=True,
        groups=True,
        broadcasts=True,
        bots=True,
        exclude_muted=True,
        exclude_read=True,
        exclude_archived=True,
        emoticon="🚀",
    )
    assert convert_folder(tl, self_id=SELF_ID) == Folder(
        id=4,
        title="🚀 Launch",
        kind="folder",
        pinned=(CHANNEL_ID, SELF_ID),
        include=(BOT.id,),
        exclude=(PERSON.id,),
        contacts=True,
        non_contacts=True,
        groups=True,
        channels=True,
        bots=True,
        exclude_muted=True,
        exclude_read=True,
        exclude_archived=True,
    )
    assert folder_input_peers(tl, self_id=SELF_ID) == {
        CHANNEL_ID: CHANNEL_PEER,
        SELF_ID: types.InputPeerSelf(),
        BOT.id: BOT_PEER,
    }


def test_a_chatlist_is_a_shared_folder_and_the_default_is_all_chats() -> None:
    shared = types.DialogFilterChatlist(
        id=9, title=title("Team"), pinned_peers=[], include_peers=[CHANNEL_PEER]
    )
    assert convert_folder(shared, self_id=SELF_ID) == Folder(
        id=9, title="Team", kind="shared", include=(CHANNEL_ID,)
    )
    assert convert_folder(types.DialogFilterDefault(), self_id=SELF_ID) is ALL_CHATS
    assert folder_input_peers(types.DialogFilterDefault(), self_id=SELF_ID) == {}


class _Client:
    _self_id = SELF_ID


def tl_dialog(
    entity: Any,
    peer: Any,
    *,
    notify: types.PeerNotifySettings | None = None,
    **kw: Any,
) -> Any:
    raw = types.Dialog(
        peer=peer,
        top_message=0,
        read_inbox_max_id=0,
        read_outbox_max_id=0,
        unread_count=kw.pop("unread_count", 0),
        unread_mentions_count=kw.pop("unread_mentions_count", 0),
        unread_reactions_count=0,
        unread_poll_votes_count=0,
        notify_settings=notify or types.PeerNotifySettings(),
        **kw,
    )
    key = CHANNEL_ID if isinstance(entity, types.Channel) else entity.id
    return custom.Dialog(_Client(), raw, {key: entity}, None)


def convert(d: Any, **defaults: datetime | None) -> DialogView:
    return convert_dialog(d, self_id=SELF_ID, mute_defaults=defaults, now=NOW)


def test_a_dialog_converts_its_counts_pin_archive_and_unread_mark() -> None:
    d = tl_dialog(
        CHANNEL,
        types.PeerChannel(CHANNEL.id),
        unread_count=5,
        unread_mentions_count=2,
        pinned=True,
        unread_mark=True,
        folder_id=1,
    )
    view = convert(d)
    assert (view.id, view.kind, view.username) == (CHANNEL_ID, "channel", "example_news")
    assert (view.unread, view.mentions, view.pinned) == (5, 2, True)
    assert (view.marked_unread, view.archived, view.muted) == (True, True, False)


@pytest.mark.parametrize(
    ("own", "defaults", "muted"),
    [
        (NOW + timedelta(days=1), {}, True),
        (NOW - timedelta(days=1), {"broadcasts": NOW + timedelta(days=1)}, False),
        (None, {"broadcasts": NOW + timedelta(days=365)}, True),
        (None, {"users": NOW + timedelta(days=365)}, False),  # another scope's default
        (None, {}, False),
    ],
)
def test_a_chat_without_its_own_mute_follows_its_scopes_default(
    own: datetime | None, defaults: dict[str, datetime | None], muted: bool
) -> None:
    d = tl_dialog(
        CHANNEL, types.PeerChannel(CHANNEL.id), notify=types.PeerNotifySettings(mute_until=own)
    )
    assert convert(d, **defaults).muted is muted


def test_saved_messages_is_self_and_a_contact_is_flagged() -> None:
    me = types.User(id=SELF_ID, is_self=True, first_name="Me", access_hash=33)
    friend = types.User(id=301, first_name="Sam", contact=True, access_hash=55)
    assert convert(tl_dialog(me, types.PeerUser(SELF_ID))).kind == "self"
    view = convert(tl_dialog(friend, types.PeerUser(301)))
    assert (view.kind, view.contact) == ("user", True)


# --- getPeerDialogs ------------------------------------------------------------------


class _PeerDialogsClient:
    """Answers getPeerDialogs for users, refusing any batch that holds a channel."""

    _self_id = SELF_ID

    def __init__(self) -> None:
        self.calls: list[int] = []

    async def __call__(self, request: Any) -> Any:
        assert isinstance(request, functions.messages.GetPeerDialogsRequest)
        peers = [p.peer for p in request.peers]
        self.calls.append(len(peers))
        if any(isinstance(p, types.InputPeerChannel) for p in peers):
            raise errors.ChannelPrivateError(request=request)
        users = [types.User(id=p.user_id, access_hash=p.access_hash, first_name="U") for p in peers]
        dialogs = [
            types.Dialog(
                peer=types.PeerUser(u.id),
                top_message=0,
                read_inbox_max_id=0,
                read_outbox_max_id=0,
                unread_count=0,
                unread_mentions_count=0,
                unread_reactions_count=0,
                unread_poll_votes_count=0,
                notify_settings=types.PeerNotifySettings(),
            )
            for u in users
        ]
        return types.messages.PeerDialogs(
            dialogs=dialogs,
            messages=[],
            chats=[],
            users=users,
            state=types.updates.State(pts=0, qts=0, date=NOW, seq=0, unread_count=0),
        )


def test_a_refused_chat_is_dropped_and_the_rest_still_come() -> None:
    client = _PeerDialogsClient()
    refused: list[int] = []
    peers = [(BOT.id, BOT_PEER), (CHANNEL_ID, CHANNEL_PEER), (PERSON.id, PERSON_PEER)]
    found = asyncio.run(_fetch_peer_dialogs(client, peers, refused))
    assert sorted(d.id for d in found) == [PERSON.id, BOT.id]
    assert refused == [CHANNEL_ID]
    assert client.calls == [3, 1, 2, 1, 1]


@pytest.fixture
def session(tmp_path: Path) -> Iterator[TgSession]:
    s = TgSession(tmp_path / "a.session", tmp_path / "a.cache.db")
    yield s
    s.close()


def test_a_refused_chat_is_skipped_on_the_next_run_until_its_time_is_up(
    session: TgSession,
) -> None:
    client = _PeerDialogsClient()
    conn = Connected(client=client, session=session, account="a", me=None)
    users = {5000 + i: types.InputPeerUser(5000 + i, 1) for i in range(99)}
    peers = {**dict(list(users.items())[:40]), CHANNEL_ID: CHANNEL_PEER, **users}

    def run(now: datetime) -> list[DialogView]:
        client.calls.clear()
        return asyncio.run(_peer_dialogs(conn, peers, {}, now))

    first = run(NOW)
    assert len(first) == 99
    assert sum(client.calls) > 100  # halving to find the refused chat

    second = run(NOW + timedelta(hours=1))
    assert len(second) == 99
    assert client.calls == [99]

    run(NOW + REFUSED_FOR + timedelta(minutes=1))
    assert sum(client.calls) > 100  # asked again once its time is up


# --- folder list ---------------------------------------------------------------------

WORK_TL = types.DialogFilter(
    id=2, title=title("Work"), pinned_peers=[], include_peers=[BOT_PEER], exclude_peers=[]
)
TEAM_TL = types.DialogFilterChatlist(
    id=11, title=title("Team"), pinned_peers=[], include_peers=[CHANNEL_PEER]
)


def test_the_servers_order_is_kept_with_all_chats_in_the_middle() -> None:
    found = _folders_of([WORK_TL, types.DialogFilterDefault(), TEAM_TL], self_id=SELF_ID)
    assert [(f.id, f.kind) for f, _ in found] == [(2, "folder"), (0, "all"), (11, "shared")]
    assert [peers for _, peers in found] == [{BOT.id: BOT_PEER}, {}, {CHANNEL_ID: CHANNEL_PEER}]


def test_without_a_default_filter_all_chats_comes_first() -> None:
    found = _folders_of([WORK_TL, TEAM_TL], self_id=SELF_ID)
    assert [(f.id, f.kind) for f, _ in found] == [(0, "all"), (2, "folder"), (11, "shared")]
    assert _folders_of([], self_id=SELF_ID) == [(ALL_CHATS, {})]


# --- default mutes -------------------------------------------------------------------


class _NotifyClient:
    """Answers account.getNotifySettings; `fail` scopes raise an RPC error."""

    def __init__(self, fail: set[type]) -> None:
        self._fail = fail

    async def __call__(self, request: Any) -> Any:
        assert isinstance(request, functions.account.GetNotifySettingsRequest)
        if type(request.peer) in self._fail:
            raise errors.RPCError(request=request, message="INTERNAL_ERROR", code=500)
        return types.PeerNotifySettings(mute_until=NOW + timedelta(days=1))


def test_a_failed_default_mute_counts_as_not_muted_with_a_note(
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _NotifyClient(fail={types.InputNotifyBroadcasts})
    defaults = asyncio.run(_mute_defaults(client))
    assert defaults == {
        "users": NOW + timedelta(days=1),
        "chats": NOW + timedelta(days=1),
        "broadcasts": None,
    }
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "no default mute for broadcasts" in captured.err
    assert "counted as not muted" in captured.err


# --- output --------------------------------------------------------------------------


def test_dialog_json_has_the_contract_keys() -> None:
    view = replace(
        BOT_CHAT,
        username="example_bot",
        unread=2,
        mentions=1,
        pinned=True,
        muted=True,
        last_id=677791,
        last_date=NOW,
        last_text="Choose an option",
        contact=True,  # facts for membership stay out of the row
        archived=True,
    )
    assert dialog_json(view) == {
        "id": 203,
        "kind": "bot",
        "title": "chat 203",
        "username": "example_bot",
        "unread": 2,
        "mentions": 1,
        "pinned": True,
        "muted": True,
        "last_id": 677791,
        "last_date": "2026-09-29T15:00:00+00:00",
        "last_text": "Choose an option",
    }


@pytest.mark.parametrize(
    ("facts", "line"),
    [
        ({}, "202 user chat 202 — "),
        ({"username": "example_bot", "pinned": True}, "202 user @example_bot 📌 — "),
        (
            {"muted": True, "unread": 5, "mentions": 1},
            "202 user chat 202 🔕 [5 unread, 1 mention] — ",
        ),
        ({"mentions": 2, "last_text": "a\nb"}, "202 user chat 202 [2 mentions] — a ⏎ b"),
        ({"last_text": "x" * 81}, "202 user chat 202 — " + "x" * 80 + "…"),
    ],
)
def test_dialog_line_marks_pin_mute_unread_and_mentions(facts: dict[str, Any], line: str) -> None:
    assert dialog_line(replace(STRANGER, **facts)) == line


def test_folders_print_id_title_kind_and_count() -> None:
    shared = Folder(id=11, title="Team", kind="shared")
    assert folder_json(ALL_CHATS) == {"id": 0, "title": "All chats", "kind": "all"}
    assert folder_json(shared, 0) == {"id": 11, "title": "Team", "kind": "shared", "unread": 0}
    assert folder_line(shared, 3) == "11 Team (shared) [3 unread]"
    assert folder_line(folder(), 0) == "2 Work"
