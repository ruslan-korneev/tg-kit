"""Pins forum topics without a network: which topic a Telethon message lands in
(a topic, a reply inside one, General, the creation message, outside forums),
`tg topics` rows and lines, the send params that place a write in a topic, the
closed-topic refusal, the topic in the write plan, `tg watch --topic` and the
`--wait` topic filter, the topic a reply derives from its message, drafts in a
topic, and topic lookups over a scripted client (non-forum,
deleted topic, paging).

Not covered: a live forum. Live tests message only `me`, which has no topics;
that Telegram files a `top_msg_id` reply in the topic is taken from
core.telegram.org/api/forum, not observed.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from telethon import errors
from telethon.tl import functions, types

from tg_kit.cmd_write import raw_topic_reply, topic_reply
from tg_kit.common import topic_of_reply
from tg_kit.config import Config
from tg_kit.convert import convert_message, convert_topic, convert_typing
from tg_kit.errors import EXIT_NOT_FOUND, EXIT_USAGE, NotFoundError, UsageError
from tg_kit.guard import Target, check
from tg_kit.model import (
    GENERAL_TOPIC,
    DeleteEvent,
    MessageEvent,
    MessageView,
    Sender,
    TopicView,
    TypingEvent,
)
from tg_kit.peers import TOPICS_PAGE, Peer, list_topics, resolve_topic
from tg_kit.plan import Step, WritePlan, execute_step
from tg_kit.raw import build_object, find_method
from tg_kit.render import compact, message_json, topic_json, topic_line
from tg_kit.waiter import TelethonSource
from tg_kit.watch import Follower, parse_events

from .conftest import BOT, CHANNEL, DATE, PERSON, SELF_ID, MessageFactory

NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
FORUM = types.Channel(
    id=206,
    title="Example Forum",
    photo=types.ChatPhotoEmpty(),
    date=None,
    megagroup=True,
    forum=True,
    access_hash=66,
)
FORUM_ID = -(10**12 + FORUM.id)
FORUM_PEER = Peer(
    id=FORUM_ID,
    kind="supergroup",
    username=None,
    title="Example Forum",
    input=types.InputPeerChannel(FORUM.id, 66),
)
GROUP = types.Channel(
    id=207,
    title="Plain Group",
    photo=types.ChatPhotoEmpty(),
    date=None,
    megagroup=True,
    access_hash=77,
)


def in_forum(tl_message: MessageFactory, *, chat: Any = FORUM, **fields: Any) -> MessageView:
    msg = tl_message(peer_id=types.PeerChannel(chat.id), peers=(BOT, PERSON, chat), **fields)
    return convert_message(msg, self_id=SELF_ID)


def lines(view: MessageView) -> list[str]:
    return compact(view, now=NOW, tz=UTC)


# --- which topic a message is in ------------------------------------------------


def test_a_message_posted_into_a_topic_is_in_it_and_is_not_shown_as_a_reply(
    tl_message: MessageFactory,
) -> None:
    v = in_forum(
        tl_message,
        id=810,
        message="v2.3 is out",
        reply_to=types.MessageReplyHeader(forum_topic=True, reply_to_msg_id=12),
    )
    assert (v.topic_id, v.reply_to) == (12, 12)  # JSON keeps Telegram's reply_to
    assert lines(v) == ["#810 09-29 11:02 [topic:12] @example_bot: v2.3 is out"]
    assert message_json(v)["topic_id"] == 12


def test_a_reply_inside_a_topic_names_the_topic_and_the_replied_message(
    tl_message: MessageFactory,
) -> None:
    header = types.MessageReplyHeader(forum_topic=True, reply_to_msg_id=809, reply_to_top_id=12)
    v = in_forum(tl_message, id=812, message="thanks", reply_to=header)
    assert (v.topic_id, v.reply_to) == (12, 809)
    assert lines(v) == ["#812 09-29 11:02 [topic:12] @example_bot ↩809: thanks"]


@pytest.mark.parametrize(
    "header",
    [None, types.MessageReplyHeader(reply_to_msg_id=40)],
    ids=["plain", "reply-in-general"],
)
def test_a_forum_message_without_a_topic_header_is_in_general(
    tl_message: MessageFactory, header: Any
) -> None:
    v = in_forum(tl_message, message="hello", reply_to=header)
    assert v.topic_id == GENERAL_TOPIC


def test_a_topic_creation_message_opens_its_own_topic(tl_message: MessageFactory) -> None:
    msg = tl_message(
        cls=types.MessageService,
        id=12,
        peer_id=types.PeerChannel(FORUM.id),
        peers=(BOT, FORUM),
        action=types.MessageActionTopicCreate(title="Releases", icon_color=0x6FB9F0),
    )
    assert convert_message(msg, self_id=SELF_ID).topic_id == 12


@pytest.mark.parametrize(
    ("chat", "header"),
    [
        (GROUP, None),
        (GROUP, types.MessageReplyHeader(reply_to_msg_id=5)),
        (CHANNEL, None),
    ],
    ids=["group", "group-reply", "channel"],
)
def test_outside_forums_a_message_has_no_topic(
    tl_message: MessageFactory, chat: Any, header: Any
) -> None:
    v = in_forum(tl_message, chat=chat, message="x", reply_to=header)
    assert v.topic_id is None
    assert "[topic:" not in lines(v)[0]
    assert message_json(v)["topic_id"] is None


def test_a_caller_that_knows_the_forum_places_a_message_without_its_chat_in_general(
    tl_message: MessageFactory,
) -> None:
    # A live update may come without the chat entity; --topic has checked the forum.
    msg = tl_message(peer_id=types.PeerChannel(FORUM.id), peers=(BOT,), message="x")
    assert convert_message(msg, self_id=SELF_ID).topic_id is None
    assert convert_message(msg, self_id=SELF_ID, forum=True).topic_id == GENERAL_TOPIC


def test_typing_in_a_topic_carries_telegrams_topic_id() -> None:
    update = types.UpdateChannelUserTyping(
        channel_id=FORUM.id,
        from_id=types.PeerUser(BOT.id),
        action=types.SendMessageTypingAction(),
        top_msg_id=12,
    )
    event = convert_typing(update, self_id=SELF_ID, find=lambda _: None, now=NOW)
    assert event is not None
    assert (event.chat_id, event.top_msg_id) == (FORUM_ID, 12)


# --- tg topics rows -------------------------------------------------------------


def forum_topic(topic_id: int, top_message: int, **kw: Any) -> types.ForumTopic:
    return types.ForumTopic(
        id=topic_id,
        date=DATE,
        peer=types.PeerChannel(FORUM.id),
        title=kw.pop("title", f"Topic {topic_id}"),
        icon_color=kw.pop("icon_color", 0x6FB9F0),
        top_message=top_message,
        read_inbox_max_id=0,
        read_outbox_max_id=0,
        unread_count=kw.pop("unread_count", 0),
        unread_mentions_count=kw.pop("unread_mentions_count", 0),
        unread_reactions_count=0,
        unread_poll_votes_count=0,
        from_id=types.PeerUser(BOT.id),
        notify_settings=types.PeerNotifySettings(),
        **kw,
    )


def raw_message(msg_id: int, text: str, date: datetime = DATE) -> types.Message:
    return types.Message(id=msg_id, peer_id=types.PeerChannel(FORUM.id), date=date, message=text)


def test_a_topic_row_has_its_counts_marks_and_last_message() -> None:
    t = forum_topic(12, 810, title="Releases", unread_count=5, unread_mentions_count=1, pinned=True)
    view = convert_topic(t, {810: raw_message(810, "v2.3 is out")})
    assert view is not None
    assert topic_line(view) == "12 Releases 📌 [5 unread, 1 mention] — v2.3 is out"
    assert topic_json(view) == {
        "id": 12,
        "title": "Releases",
        "icon_color": 0x6FB9F0,
        "unread": 5,
        "mentions": 1,
        "pinned": True,
        "closed": False,
        "hidden": False,
        "last_id": 810,
        "last_date": "2026-09-29T11:02:00+00:00",
        "last_text": "v2.3 is out",
    }


def test_closed_and_hidden_topics_are_marked() -> None:
    view = convert_topic(forum_topic(1, 3, title="General", closed=True, hidden=True), {})
    assert view is not None
    assert topic_line(view) == "1 General 🔒 (hidden) — "


def test_a_deleted_topic_is_no_row() -> None:
    assert convert_topic(types.ForumTopicDeleted(id=13), {}) is None


# --- writes into a topic ----------------------------------------------------------


@pytest.mark.parametrize(
    ("topic", "reply_to", "params"),
    [
        (None, None, {"reply_to": None}),
        (None, 5, {"reply_to": 5}),
        (GENERAL_TOPIC, None, {"reply_to": None}),  # General: a plain message
        (GENERAL_TOPIC, 40, {"reply_to": 40}),
        (12, None, {"reply_to": 12}),  # into the topic: reply to its first message
        (12, 12, {"reply_to": 12}),
        (12, 809, {"reply_to": 809, "top_msg_id": 12}),  # a reply inside the topic
    ],
)
def test_topic_reply_places_the_message(
    topic: int | None, reply_to: int | None, params: dict[str, object]
) -> None:
    assert topic_reply(topic, reply_to) == params


@pytest.mark.parametrize(
    ("topic", "params"),
    [
        (None, {}),
        (GENERAL_TOPIC, {}),
        (12, {"reply_to": {"_": "InputReplyToMessage", "reply_to_msg_id": 12}}),
    ],
)
def test_raw_topic_reply_places_an_mtproto_step(
    topic: int | None, params: dict[str, object]
) -> None:
    assert raw_topic_reply(topic) == params


def test_a_draft_in_a_topic_builds_savedraft_with_the_topic_as_reply_to() -> None:
    async def no_resolve(spec: str) -> Any:
        raise AssertionError(spec)

    params = {"peer": FORUM_PEER, "message": "later", **raw_topic_reply(12)}
    request = asyncio.run(build_object(find_method("messages.SaveDraft"), params, no_resolve))
    assert isinstance(request, functions.messages.SaveDraftRequest)
    reply = request.reply_to
    assert isinstance(reply, types.InputReplyToMessage)
    assert (reply.reply_to_msg_id, reply.top_msg_id) == (12, None)


@dataclass
class _MessagesClient:
    found: Any
    calls: list[Any] = field(default_factory=list)

    async def get_messages(self, entity: Any, *, ids: int) -> Any:
        self.calls.append((entity, ids))
        return self.found


@dataclass
class _Conn:
    client: _MessagesClient
    me: Any = None


def derive(
    found: Any, peer: Peer, topic: int | None, reply_to: int | None
) -> tuple[Any, list[Any]]:
    conn = _Conn(_MessagesClient(found))
    got = asyncio.run(topic_of_reply(conn, peer, topic, reply_to))  # type: ignore[arg-type]
    return got, conn.client.calls


IN_TOPIC = types.MessageReplyHeader(forum_topic=True, reply_to_msg_id=12)


def forum_msg(tl_message: MessageFactory, chat: Any = FORUM, **fields: Any) -> Any:
    return tl_message(id=809, peer_id=types.PeerChannel(chat.id), peers=(BOT, chat), **fields)


@pytest.mark.parametrize(
    ("header", "topic"), [(IN_TOPIC, 12), (None, GENERAL_TOPIC)], ids=["topic", "general"]
)
def test_a_reply_in_a_forum_goes_into_the_replied_messages_topic(
    tl_message: MessageFactory, header: Any, topic: int
) -> None:
    got, calls = derive(forum_msg(tl_message, reply_to=header), FORUM_PEER, None, 809)
    assert got == topic
    assert calls == [(FORUM_PEER.input, 809)]


def test_an_explicit_topic_that_agrees_with_the_message_is_kept(
    tl_message: MessageFactory,
) -> None:
    assert derive(forum_msg(tl_message, reply_to=IN_TOPIC), FORUM_PEER, 12, 809)[0] == 12


def test_an_explicit_topic_that_contradicts_the_message_is_a_usage_error(
    tl_message: MessageFactory,
) -> None:
    with pytest.raises(UsageError, match="message 809 is in topic 12, not in topic 13"):
        derive(forum_msg(tl_message, reply_to=IN_TOPIC), FORUM_PEER, 13, 809)


def test_a_reply_in_a_supergroup_without_topics_has_no_topic(tl_message: MessageFactory) -> None:
    group = replace(FORUM_PEER, id=-(10**12 + GROUP.id), title="Plain Group")
    assert derive(forum_msg(tl_message, chat=GROUP), group, None, 809)[0] is None


@pytest.mark.parametrize(("topic", "reply_to"), [(None, 5), (7, None)])
def test_no_lookup_without_a_reply_or_outside_supergroups(
    topic: int | None, reply_to: int | None
) -> None:
    bot = Peer(id=BOT.id, kind="bot", username="example_bot", title="Example", input=None)
    peer = bot if reply_to is not None else FORUM_PEER
    assert derive(None, peer, topic, reply_to) == (topic, [])


def test_a_reply_to_a_missing_message_is_not_found() -> None:
    with pytest.raises(NotFoundError, match="no message 809"):
        derive(None, FORUM_PEER, None, 809)


ALLOWED = Target(id=FORUM_ID, kind="supergroup", username=None)


@pytest.mark.parametrize("yes", [False, True])
def test_a_closed_topic_refuses_the_post_even_when_allowlisted_and_confirmed(yes: bool) -> None:
    verdict = check(
        Config(),
        allowed_ids=frozenset({FORUM_ID}),
        action="send",
        target=ALLOWED,
        yes=yes,
        closed_topic=12,
    )
    assert not verdict.allowed
    assert "topic 12 is closed" in verdict.reason


def test_a_topic_never_widens_the_allowlist() -> None:
    verdict = check(Config(), allowed_ids=frozenset(), action="send", target=ALLOWED, yes=False)
    assert not verdict.allowed
    assert "not in the allowlist" in verdict.reason


def test_the_dry_run_plan_shows_the_topic() -> None:
    verdict = check(
        Config(), allowed_ids=frozenset({FORUM_ID}), action="send", target=ALLOWED, yes=False
    )
    plan = WritePlan(
        action="send",
        target=FORUM_PEER,
        steps=(Step("send_message", {"entity": FORUM_PEER, "message": "hi", "reply_to": 12}),),
        verdict=verdict,
        topic=TopicView(id=12, title="Releases"),
    )
    doc = plan.to_json()
    assert doc["topic"] == {"id": 12, "title": "Releases", "closed": False}
    assert list(doc) == ["action", "target", "topic", "steps", "guard"]


@dataclass
class _SendClient:
    """What `send_message` needs from TelegramClient, recording the request."""

    requests: list[Any] = field(default_factory=list)

    async def get_input_entity(self, entity: Any) -> Any:
        return entity

    async def _parse_message_text(self, message: str, _parse_mode: Any) -> tuple[str, list[Any]]:
        return message, []

    async def __call__(self, request: Any) -> Any:
        self.requests.append(request)
        return "updates"

    def _get_response_message(self, _request: Any, result: Any, _entity: Any) -> Any:
        return ("sent", result)


def test_a_reply_inside_a_topic_sends_the_topic_as_top_msg_id() -> None:
    client = _SendClient()
    step = Step(
        "send_message",
        {
            "entity": FORUM_PEER,
            "message": "thanks",
            "reply_to": 809,
            "top_msg_id": 12,
            "link_preview": False,
            "parse_mode": None,
            "silent": None,
        },
    )
    assert asyncio.run(execute_step(client, step)) == ("sent", "updates")
    (request,) = client.requests
    assert isinstance(request, functions.messages.SendMessageRequest)
    assert request.peer == FORUM_PEER.input
    reply = request.reply_to
    assert isinstance(reply, types.InputReplyToMessage)
    assert (reply.reply_to_msg_id, reply.top_msg_id) == (809, 12)
    assert (request.message, request.no_webpage) == ("thanks", True)


# --- tg watch --topic, send --wait in a topic --------------------------------------


BOT_SENDER = Sender(id=BOT.id, kind="bot", username="example_bot", name="Example")


def topic_view(msg_id: int, topic: int | None) -> MessageView:
    return MessageView(
        id=msg_id,
        chat_id=FORUM_ID,
        date=DATE,
        sender=BOT_SENDER,
        out=False,
        text="x",
        topic_id=topic,
    )


def topic_follower(topic: int) -> Follower:
    return Follower(chat_ids=frozenset({FORUM_ID}), kinds=parse_events(None), topic=topic)


def test_watch_topic_keeps_only_that_topics_messages_and_edits() -> None:
    f = topic_follower(12)
    keep, edit = MessageEvent(topic_view(810, 12)), MessageEvent(topic_view(810, 12), edit=True)
    assert f.accept(keep) == [keep]
    assert f.accept(edit) == [edit]
    assert f.accept(MessageEvent(topic_view(811, 13))) == []
    assert f.accept(MessageEvent(topic_view(812, GENERAL_TOPIC))) == []


@pytest.mark.parametrize(
    ("watched", "top", "kept"), [(12, 12, True), (12, None, False), (1, None, True)]
)
def test_watch_topic_keeps_typing_in_that_topic(watched: int, top: int | None, kept: bool) -> None:
    typing = TypingEvent(
        chat_id=FORUM_ID, sender=BOT_SENDER, action="typing", date=NOW, top_msg_id=top
    )
    assert topic_follower(watched).accept(typing) == ([typing] if kept else [])


def test_watch_topic_reports_deletions_only_of_messages_it_printed() -> None:
    f = topic_follower(12)
    f.accept(MessageEvent(topic_view(810, 12)))
    f.accept(MessageEvent(topic_view(811, 13)))  # another topic: not printed
    deleted = f.accept(DeleteEvent(chat_id=FORUM_ID, ids=(810, 811), date=NOW))
    assert deleted == [DeleteEvent(chat_id=FORUM_ID, ids=(810,), date=NOW)]


@dataclass
class _HandlerClient:
    handlers: list[Any] = field(default_factory=list)

    def add_event_handler(self, handler: Any, _builder: Any) -> None:
        self.handlers.append(handler)

    def remove_event_handler(self, handler: Any, _builder: Any) -> None:
        self.handlers.remove(handler)


@dataclass
class _Event:
    chat_id: int
    message: MessageView  # the stand-in convert passes it through


def test_wait_in_a_topic_collects_only_that_topics_replies() -> None:
    async def scenario() -> list[int]:
        client = _HandlerClient()
        source = TelethonSource(client, FORUM_ID, convert=lambda m: m, topic=12)
        await source.start()
        new_message = client.handlers[0]
        for v in (topic_view(811, 13), topic_view(812, 12), topic_view(813, None)):
            await new_message(_Event(chat_id=FORUM_ID, message=v))
        got = []
        while (event := await source.next(0.01)) is not None:
            got.append(event.view.id)
        await source.stop()
        return got

    assert asyncio.run(scenario()) == [812]


# --- topic lookups over a scripted client -------------------------------------------


@dataclass
class _TopicsClient:
    replies: list[Any]
    requests: list[Any] = field(default_factory=list)

    async def __call__(self, request: Any) -> Any:
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def forum_topics(topics: list[Any], messages: list[Any]) -> types.messages.ForumTopics:
    return types.messages.ForumTopics(
        count=len(topics), topics=topics, messages=messages, chats=[], users=[], pts=1
    )


def test_resolve_topic_returns_the_topic_with_its_closed_flag() -> None:
    client = _TopicsClient([forum_topics([forum_topic(12, 810, closed=True)], [])])
    view = asyncio.run(resolve_topic(client, FORUM_PEER, 12))
    assert (view.id, view.closed) == (12, True)
    (request,) = client.requests
    assert isinstance(request, functions.messages.GetForumTopicsByIDRequest)
    assert request.topics == [12]


@pytest.mark.parametrize("kind", ["user", "bot", "self", "group", "channel"])
def test_a_chat_that_cannot_be_a_forum_is_refused_without_a_request(kind: str) -> None:
    client = _TopicsClient([])
    peer = Peer(id=1, kind=kind, username=None, title="chat", input=None)
    with pytest.raises(UsageError, match="not a forum"):
        asyncio.run(resolve_topic(client, peer, 12))
    with pytest.raises(UsageError, match="not a forum"):
        asyncio.run(list_topics(client, peer, limit=5))
    assert client.requests == []


def test_a_supergroup_without_topics_is_a_usage_error_exit_2() -> None:
    client = _TopicsClient([errors.ChannelForumMissingError(request=None)])
    with pytest.raises(UsageError, match="without topics") as caught:
        asyncio.run(resolve_topic(client, FORUM_PEER, 12))
    assert caught.value.exit_code == EXIT_USAGE


@pytest.mark.parametrize(
    "reply",
    [
        forum_topics([types.ForumTopicDeleted(id=13)], []),
        forum_topics([], []),
        errors.TopicDeletedError(request=None),
    ],
    ids=["deleted", "absent", "rpc-deleted"],
)
def test_a_missing_topic_is_not_found_exit_4(reply: Any) -> None:
    with pytest.raises(NotFoundError, match="has no topic 13") as caught:
        asyncio.run(resolve_topic(_TopicsClient([reply]), FORUM_PEER, 13))
    assert caught.value.exit_code == EXIT_NOT_FOUND


def test_topic_zero_is_refused_before_a_request() -> None:
    with pytest.raises(UsageError, match="1 is General"):
        asyncio.run(resolve_topic(_TopicsClient([]), FORUM_PEER, 0))


def test_list_topics_pages_from_the_last_topic_and_its_last_message() -> None:
    first = [forum_topic(1000 - i, 5000 - i) for i in range(TOPICS_PAGE)]
    tail_date = DATE - timedelta(hours=1)
    messages = [raw_message(5000 - i, f"m{i}", tail_date) for i in range(TOPICS_PAGE)]
    client = _TopicsClient(
        [forum_topics(first, messages), forum_topics([forum_topic(7, 70)], [raw_message(70, "x")])]
    )
    rows = asyncio.run(list_topics(client, FORUM_PEER, limit=150, query="rel"))
    assert len(rows) == TOPICS_PAGE + 1
    assert rows[0].last_text == "m0"
    one, two = client.requests
    assert (one.offset_id, one.offset_topic, one.limit, one.q) == (0, 0, TOPICS_PAGE, "rel")
    last = first[-1]
    assert (two.offset_id, two.offset_topic, two.limit) == (last.top_message, last.id, 50)
    assert two.offset_date == tail_date


def test_list_topics_stops_at_the_limit() -> None:
    page = [forum_topic(i, 100 + i) for i in range(1, 4)]
    client = _TopicsClient([forum_topics(page, [])])
    rows = asyncio.run(list_topics(client, FORUM_PEER, limit=3))
    assert [r.id for r in rows] == [1, 2, 3]
    assert len(client.requests) == 1
