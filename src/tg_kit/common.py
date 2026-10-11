"""Helpers shared by the command modules: resolve, print, guard → execute, wait."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from tg_kit.app import Runtime, emit_json, note, out
from tg_kit.client import Connected, telegram_errors
from tg_kit.errors import NoReplyError, NotFoundError, RefusedError, UsageError
from tg_kit.guard import check
from tg_kit.model import MessageView, TopicView
from tg_kit.parsing import parse_duration
from tg_kit.peers import Peer, parse_peer, resolve, resolve_topic
from tg_kit.plan import Step, WritePlan, execute_step, target_of
from tg_kit.render import compact, message_json
from tg_kit.waiter import DEFAULT_QUIET, TelethonSource, run_and_collect

__all__ = [
    "HARD_MAX",
    "MessagePrinter",
    "authorize",
    "execute_plan",
    "make_plan",
    "parse_wait",
    "print_views",
    "resolve_spec",
    "resolve_topic_id",
    "self_id",
    "sent_views",
    "topic_of_reply",
    "view_of",
    "with_wait",
]

# Hard cap on messages any single call prints — output stays bounded no matter what -n says.
HARD_MAX = 200


def self_id(conn: Connected) -> int | None:
    return conn.me.user_id if conn.me else None


async def resolve_spec(conn: Connected, spec: str, *, for_write: bool = False) -> Peer:
    """`for_write` re-resolves usernames over the network instead of trusting the cache."""
    with telegram_errors():
        return await resolve(
            conn.client, conn.session, parse_peer(spec), self_id=self_id(conn), fresh=for_write
        )


async def resolve_topic_id(conn: Connected, target: Peer, topic: int | None) -> TopicView | None:
    """`--topic ID` → the topic (None without the flag); a non-forum or missing topic fails."""
    if topic is None:
        return None
    with telegram_errors():
        return await resolve_topic(conn.client, target, topic)


async def topic_of_reply(
    conn: Connected, target: Peer, topic: int | None, reply_to: int | None
) -> int | None:
    """The topic a reply goes into: in a forum, the topic of the message it replies to.

    One get_messages call, and only for a reply in a supergroup (the only kind
    that can be a forum). An explicit `topic` must agree with the message's.
    """
    if reply_to is None or target.kind != "supergroup":
        return topic
    with telegram_errors():
        found = await conn.client.get_messages(target.input, ids=reply_to)
    if found is None:
        raise NotFoundError(f"no message {reply_to} in {target.label()} to reply to")
    view = view_of(conn, found)
    if view.topic_id is None:  # not a forum; a --topic is refused by resolve_topic_id
        return topic
    if topic is not None and topic != view.topic_id:
        msg = f"message {reply_to} is in topic {view.topic_id}, not in topic {topic}"
        raise UsageError(msg, hint=f"drop --topic, or pass --topic {view.topic_id}")
    return view.topic_id


def view_of(
    conn: Connected, msg: Any, *, chat_title: str | None = None, forum: bool | None = None
) -> MessageView:
    from tg_kit.convert import convert_message

    return convert_message(msg, self_id=self_id(conn), chat_title=chat_title, forum=forum)


class MessagePrinter:
    def __init__(self, rt: Runtime, *, truncate: int | None, peer_hint: str | None) -> None:
        self._rt = rt
        self._truncate = truncate
        self._peer_hint = peer_hint
        self._style = rt.style

    def lines(self, view: MessageView) -> list[str]:
        return compact(
            view,
            now=self._rt.now,
            truncate=self._truncate,
            peer_hint=self._peer_hint or str(view.chat_id),
            style=self._style,
        )


def print_views(
    rt: Runtime, views: Sequence[MessageView], *, truncate: int | None, peer_hint: str | None
) -> None:
    if rt.json:
        emit_json([message_json(v) for v in views])
        return
    printer = MessagePrinter(rt, truncate=truncate, peer_hint=peer_hint)
    color = rt.style.on
    for view in views:
        for line in printer.lines(view):
            out(line, color=color)


def make_plan(
    rt: Runtime,
    action: str,
    target: Peer | None,
    steps: Sequence[Step],
    *,
    yes: bool,
    always_confirm: bool = False,
    topic: TopicView | None = None,
) -> WritePlan:
    """`topic`: the forum topic the steps post into; a closed one refuses the plan."""
    verdict = check(
        rt.config,
        allowed_ids=rt.allowlist().ids,
        action=action,
        target=target_of(target),
        yes=yes,
        always_confirm=always_confirm,
        closed_topic=topic.id if topic is not None and topic.closed else None,
    )
    return WritePlan(action=action, target=target, steps=tuple(steps), verdict=verdict, topic=topic)


def authorize(plan: WritePlan, *, dry_run: bool) -> bool:
    """Print the plan (dry run) or enforce the guard. True → go ahead and send."""
    import json

    if plan.target is not None:
        topic = f", topic {plan.topic.id} {plan.topic.title!r}" if plan.topic else ""
        note(plan.target.target_line() + topic, role="accent")
    if dry_run:
        emit_json(plan.to_json())
        verdict = "would send" if plan.verdict.allowed else "would be REFUSED (exit 7)"
        note(f"dry run: {verdict}: {plan.verdict.reason}; nothing was sent")
        return False
    if not plan.verdict.allowed:
        note("refused; nothing was sent. The plan was:")
        note(json.dumps(plan.to_json(), ensure_ascii=False, default=str))
        raise RefusedError(
            plan.verdict.reason, hint="ask the account owner; add --yes only with their explicit OK"
        )
    return True


async def execute_plan(conn: Connected, plan: WritePlan) -> list[Any]:
    return [await execute_step(conn.client, step) for step in plan.steps]


def parse_wait(wait: str | None, quiet: str | None) -> tuple[float | None, float]:
    budget = parse_duration(wait) if wait is not None else None
    q = parse_duration(quiet) if quiet is not None else DEFAULT_QUIET
    if budget is not None and budget <= 0:
        raise UsageError("--wait must be positive")
    if q <= 0:
        raise UsageError("--quiet must be positive")
    return budget, q


async def with_wait[T](
    conn: Connected,
    chat: Peer,
    action: Callable[[], Awaitable[T]],
    *,
    budget: float,
    quiet: float,
    topic: int | None = None,
) -> tuple[T, list[MessageView]]:
    """Subscribe to `chat` (only `topic` in a forum), run `action`, collect replies/edits."""
    chat_id = self_id(conn) if chat.kind == "self" else chat.id
    forum = True if topic is not None else None  # resolve_topic_id proved it is a forum
    source = TelethonSource(
        conn.client,
        chat_id or chat.id,
        convert=lambda msg: view_of(conn, msg, forum=forum),
        topic=topic,
    )
    return await run_and_collect(source, action, budget=budget, quiet=quiet, clock=time.monotonic)


def no_reply(budget: float) -> NoReplyError:
    return NoReplyError(
        f"no reply within {budget:g}s",
        hint="the bot may be down or slow; retry with a longer --wait, "
        "or check later with tg read PEER --after ID",
    )


def sent_views(conn: Connected, results: Sequence[Any], target: Peer) -> list[MessageView]:
    """The messages a plan's steps produced, as views.

    High-level client methods return Message objects (send_file may return a
    list); raw MTProto steps return an Updates container, whose new-message
    updates hold what was sent.
    """
    from telethon import utils
    from telethon.tl import types

    messages: list[Any] = []
    for result in results:
        if isinstance(result, list):
            messages.extend(result)
        elif isinstance(result, types.Message | types.MessageService):
            messages.append(result)
        elif isinstance(result, types.Updates | types.UpdatesCombined):
            entities = {utils.get_peer_id(e): e for e in [*result.users, *result.chats]}
            for update in result.updates:
                if isinstance(update, types.UpdateNewMessage | types.UpdateNewChannelMessage):
                    msg = update.message
                    # What Telethon does for every message it returns: attach sender/chat.
                    msg._finish_init(conn.client, entities, target.input)  # noqa: SLF001
                    messages.append(msg)
    return [view_of(conn, m) for m in messages if m is not None]
