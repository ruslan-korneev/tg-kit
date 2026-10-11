"""Pins `tg watch` without a network: TL updates → events, events → JSON lines and
compact lines, and the stream rules over a scripted source and a fake clock
(chat filter, replay de-duplication, deletion attribution, --events, --idle-exit).

Not covered: Telethon delivering updates, signals and a closed stdout pipe
(live: tests/live, and by hand against Saved Messages).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from telethon.tl import types

from tg_kit.convert import convert_delete, convert_message, convert_typing, typing_action
from tg_kit.errors import UsageError
from tg_kit.model import DeleteEvent, MessageEvent, MessageView, Sender, TypingEvent, WatchEvent
from tg_kit.render import event_json, event_lines, message_json, ready_json
from tg_kit.session import EntityRow
from tg_kit.watch import Follower, follow, parse_events

from .conftest import BOT, DATE, SELF_ID, MessageFactory

NOW = datetime(2026, 9, 29, 11, 5, tzinfo=UTC)
BOT_SENDER = Sender(id=BOT.id, kind="bot", username="example_bot", name="Example")
CHAT = BOT.id
OTHER_CHAT = 999
CHANNEL_CHAT = -1000000000777
BOT_ROW = EntityRow(
    id=BOT.id, hash=11, username="example_bot", phone=None, name="Example", kind="bot"
)


def view(msg_id: int, chat_id: int = CHAT, text: str = "hi") -> MessageView:
    return MessageView(
        id=msg_id, chat_id=chat_id, date=DATE, sender=BOT_SENDER, out=False, text=text
    )


def find(peer_id: int) -> EntityRow | None:
    return BOT_ROW if peer_id == BOT.id else None


# --- TL updates → events ------------------------------------------------------


@pytest.mark.parametrize(
    ("update", "chat_id", "sender_id"),
    [
        (
            types.UpdateUserTyping(user_id=BOT.id, action=types.SendMessageTypingAction()),
            BOT.id,
            BOT.id,
        ),
        (
            types.UpdateChatUserTyping(
                chat_id=42, from_id=types.PeerUser(BOT.id), action=types.SendMessageTypingAction()
            ),
            -42,
            BOT.id,
        ),
        (
            types.UpdateChannelUserTyping(
                channel_id=777,
                from_id=types.PeerUser(BOT.id),
                action=types.SendMessageTypingAction(),
            ),
            CHANNEL_CHAT,
            BOT.id,
        ),
    ],
)
def test_typing_updates_name_the_chat_by_its_marked_id(
    update: object, chat_id: int, sender_id: int
) -> None:
    event = convert_typing(update, self_id=SELF_ID, find=find, now=NOW)
    assert event == TypingEvent(
        chat_id=chat_id,
        sender=Sender(id=sender_id, kind="bot", username="example_bot", name="Example"),
        action="typing",
        date=NOW,
    )


@pytest.mark.parametrize(
    ("action", "name"),
    [
        (types.SendMessageTypingAction(), "typing"),
        (types.SendMessageCancelAction(), "cancel"),
        (types.SendMessageRecordAudioAction(), "record_audio"),
        (types.SendMessageUploadPhotoAction(progress=10), "upload_photo"),
        (types.SendMessageChooseStickerAction(), "choose_sticker"),
        (types.SpeakingInGroupCallAction(), "speaking_in_group_call"),
        (types.SendMessageEmojiInteractionSeen(emoticon="🎉"), "emoji_interaction_seen"),
    ],
)
def test_typing_actions_are_snake_case_names(action: object, name: str) -> None:
    assert typing_action(action) == name


def test_typing_sender_missing_from_the_cache_is_unknown_with_its_id() -> None:
    update = types.UpdateUserTyping(user_id=555, action=types.SendMessageTypingAction())
    event = convert_typing(update, self_id=SELF_ID, find=find, now=NOW)
    assert event is not None
    assert event.sender == Sender(id=555, kind="unknown", username=None, name="555")


def test_own_typing_from_another_device_is_me() -> None:
    update = types.UpdateChatUserTyping(
        chat_id=42, from_id=types.PeerUser(SELF_ID), action=types.SendMessageTypingAction()
    )
    event = convert_typing(update, self_id=SELF_ID, find=find, now=NOW)
    assert event is not None
    assert (event.sender.kind, event.sender.name) == ("self", "me")


def test_deletions_carry_a_chat_only_for_channels() -> None:
    private = types.UpdateDeleteMessages(messages=[5, 6], pts=1, pts_count=2)
    channel = types.UpdateDeleteChannelMessages(channel_id=777, messages=[9], pts=1, pts_count=1)
    assert convert_delete(private, now=NOW) == DeleteEvent(chat_id=None, ids=(5, 6), date=NOW)
    assert convert_delete(channel, now=NOW) == DeleteEvent(chat_id=CHANNEL_CHAT, ids=(9,), date=NOW)


def test_other_updates_are_not_events() -> None:
    other = types.UpdateUserStatus(user_id=BOT.id, status=types.UserStatusOnline(expires=NOW))
    assert convert_typing(other, self_id=SELF_ID, find=find, now=NOW) is None
    assert convert_delete(other, now=NOW) is None


# --- events → JSON lines / compact lines --------------------------------------


def test_message_and_edit_lines_are_the_message_json_plus_event(
    tl_message: MessageFactory,
) -> None:
    v = convert_message(tl_message(message="Choose an option"), self_id=SELF_ID)
    assert event_json(MessageEvent(v)) == {"event": "message", **message_json(v)}
    assert event_json(MessageEvent(v, edit=True)) == {"event": "edit", **message_json(v)}


def test_typing_and_delete_json_shapes() -> None:
    typing = TypingEvent(chat_id=CHAT, sender=BOT_SENDER, action="typing", date=NOW)
    assert event_json(typing) == {
        "event": "typing",
        "chat_id": CHAT,
        "date": "2026-09-29T11:05:00Z",
        "sender": {"id": BOT.id, "kind": "bot", "username": "example_bot", "name": "Example"},
        "action": "typing",
    }
    delete = DeleteEvent(chat_id=CHAT, ids=(5, 6), date=NOW)
    assert event_json(delete) == {
        "event": "delete",
        "chat_id": CHAT,
        "date": "2026-09-29T11:05:00Z",
        "ids": [5, 6],
    }


def test_every_line_is_one_json_object_without_newlines(tl_message: MessageFactory) -> None:
    v = convert_message(tl_message(message="line one\nline two"), self_id=SELF_ID)
    line = json.dumps(event_json(MessageEvent(v)), ensure_ascii=False)
    assert "\n" not in line
    assert json.loads(line)["text"] == "line one\nline two"


def test_ready_line_lists_the_watched_chats() -> None:
    peers: list[dict[str, object]] = [
        {"chat_id": CHAT, "kind": "bot", "username": "example_bot", "title": "Example"}
    ]
    assert ready_json(peers, NOW) == {
        "event": "ready",
        "date": "2026-09-29T11:05:00Z",
        "peers": peers,
    }


def test_compact_lines_for_typing_delete_and_a_labelled_message() -> None:
    typing = TypingEvent(chat_id=CHAT, sender=BOT_SENDER, action="record_audio", date=NOW)
    delete = DeleteEvent(chat_id=CHAT, ids=(5, 6), date=NOW)
    assert event_lines(typing, now=NOW, tz=UTC) == ["~ 09-29 11:05 @example_bot: record_audio"]
    assert event_lines(delete, now=NOW, tz=UTC, chat="@example_bot") == [
        "✗ 09-29 11:05 [@example_bot] deleted #5 #6"
    ]
    assert event_lines(MessageEvent(view(7)), now=NOW, tz=UTC, chat="@example_bot") == [
        "#7 09-29 11:02 [@example_bot] @example_bot: hi"
    ]


# --- the stream rules ----------------------------------------------------------


def follower(kinds: str | None = None) -> Follower:
    return Follower(chat_ids=frozenset({CHAT, CHANNEL_CHAT}), kinds=parse_events(kinds))


def test_events_in_other_chats_are_dropped() -> None:
    f = follower()
    typing = TypingEvent(chat_id=OTHER_CHAT, sender=BOT_SENDER, action="typing", date=NOW)
    assert f.accept(MessageEvent(view(1, chat_id=OTHER_CHAT))) == []
    assert f.accept(typing) == []
    assert f.accept(DeleteEvent(chat_id=-1000000000888, ids=(1,), date=NOW)) == []


def test_a_replayed_message_is_not_printed_again_but_its_edits_are() -> None:
    f = follower()
    f.mark_replayed([MessageEvent(view(1))])
    assert f.accept(MessageEvent(view(1))) == []
    edited = MessageEvent(view(1, text="new"), edit=True)
    assert f.accept(edited) == [edited]
    assert f.accept(MessageEvent(view(2))) == [MessageEvent(view(2))]


def test_private_deletions_are_attributed_to_printed_messages_only() -> None:
    f = follower()
    f.accept(MessageEvent(view(5)))
    deleted = f.accept(DeleteEvent(chat_id=None, ids=(5, 6), date=NOW))
    assert deleted == [DeleteEvent(chat_id=CHAT, ids=(5,), date=NOW)]
    assert f.accept(DeleteEvent(chat_id=None, ids=(6,), date=NOW)) == []


def test_channel_deletions_pass_without_having_seen_the_message() -> None:
    f = follower()
    event = DeleteEvent(chat_id=CHANNEL_CHAT, ids=(9,), date=NOW)
    assert f.accept(event) == [event]


def test_events_filter_hides_kinds_but_still_tracks_ids_for_deletions() -> None:
    f = follower("delete")
    assert f.accept(MessageEvent(view(5))) == []
    assert f.accept(TypingEvent(chat_id=CHAT, sender=BOT_SENDER, action="typing", date=NOW)) == []
    assert f.accept(DeleteEvent(chat_id=None, ids=(5,), date=NOW)) == [
        DeleteEvent(chat_id=CHAT, ids=(5,), date=NOW)
    ]


@pytest.mark.parametrize(
    ("value", "kinds"),
    [
        (None, {"message", "edit", "typing", "delete"}),
        ("message", {"message"}),
        (" Message , typing ", {"message", "typing"}),
    ],
)
def test_parse_events(value: str | None, kinds: set[str]) -> None:
    assert parse_events(value) == kinds


@pytest.mark.parametrize("value", ["", ",", "message,typo"])
def test_parse_events_rejects_unknown_kinds_listing_the_valid_ones(value: str) -> None:
    with pytest.raises(UsageError, match="invalid --events") as info:
        parse_events(value)
    assert info.value.hint == "use a comma list of: message,edit,typing,delete"


@dataclass
class Clock:
    t: float = 0.0

    def __call__(self) -> float:
        return self.t


@dataclass
class ScriptedSource:
    """Events arrive at scripted times; `next` advances the fake clock."""

    clock: Clock
    script: list[tuple[float, WatchEvent | Exception]]
    waits: list[float | None] = field(default_factory=list)

    async def next(self, within: float | None) -> WatchEvent | None:
        self.waits.append(within)
        if self.script and (within is None or self.script[0][0] <= self.clock.t + within):
            at, item = self.script.pop(0)
            self.clock.t = max(self.clock.t, at)
            if isinstance(item, Exception):
                raise item
            return item
        if within is None:
            msg = "would wait forever"
            raise AssertionError(msg)
        self.clock.t += within
        return None


def run_follow(source: ScriptedSource, f: Follower, idle: float | None) -> list[WatchEvent]:
    printed: list[WatchEvent] = []
    asyncio.run(follow(source, printed.append, follower=f, idle_exit=idle, clock=source.clock))
    return printed


def test_idle_exit_counts_from_the_last_printed_event() -> None:
    clock = Clock()
    source = ScriptedSource(clock, [(3.0, MessageEvent(view(1))), (6.0, MessageEvent(view(2)))])
    printed = run_follow(source, follower(), idle=5.0)
    assert [e.view.id for e in printed if isinstance(e, MessageEvent)] == [1, 2]
    assert clock.t == 11.0


def test_filtered_out_events_do_not_keep_the_stream_alive() -> None:
    clock = Clock()
    source = ScriptedSource(clock, [(3.0, MessageEvent(view(1, chat_id=OTHER_CHAT)))])
    assert run_follow(source, follower(), idle=5.0) == []
    assert clock.t == 5.0


def test_without_idle_exit_the_stream_waits_without_a_deadline() -> None:
    clock = Clock()
    boom = RuntimeError("cannot read the update")
    source = ScriptedSource(clock, [(1.0, MessageEvent(view(1))), (2.0, boom)])
    with pytest.raises(RuntimeError, match="cannot read the update"):
        run_follow(source, follower(), idle=None)
    assert source.waits == [None, None]
