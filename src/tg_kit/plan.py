"""A write as data: what `--dry-run` prints is exactly what `execute` sends.

A step's `method` is either one of Telethon's high-level client methods
(`send_message`, …) or an MTProto method name (`messages.SendReaction`) built
through `tg_kit.raw`. Params are in the `tg raw` JSON dialect, with resolved
`Peer` objects where a peer goes; `to_json` shows those as their summary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tg_kit.guard import Target, Verdict
from tg_kit.model import TopicView
from tg_kit.peers import Peer

__all__ = ["CLIENT_METHODS", "Step", "WritePlan", "execute_step", "target_of"]

CLIENT_METHODS = frozenset(
    {
        "send_message",
        "send_file",
        "edit_message",
        "delete_messages",
        "forward_messages",
        "send_read_acknowledge",
    }
)


@dataclass(frozen=True)
class Step:
    method: str
    params: dict[str, object]

    def to_json(self) -> dict[str, object]:
        return {"method": self.method, "params": {k: _show(v) for k, v in self.params.items()}}


@dataclass(frozen=True)
class WritePlan:
    action: str
    target: Peer | None
    steps: tuple[Step, ...]
    verdict: Verdict
    topic: TopicView | None = None  # the forum topic the write posts into

    def to_json(self) -> dict[str, object]:
        topic = self.topic
        return {
            "action": self.action,
            "target": self.target.summary() if self.target else None,
            "topic": (
                {"id": topic.id, "title": topic.title, "closed": topic.closed} if topic else None
            ),
            "steps": [s.to_json() for s in self.steps],
            "guard": {"allowed": self.verdict.allowed, "reason": self.verdict.reason},
        }


def target_of(peer: Peer | None) -> Target | None:
    if peer is None:
        return None
    return Target(id=peer.id, kind=peer.kind, username=peer.username, fuzzy=peer.fuzzy)


def _show(value: object) -> object:
    if isinstance(value, Peer):
        return value.summary()
    if isinstance(value, list):
        return [_show(v) for v in value]
    return value


async def execute_step(client: Any, step: Step) -> Any:
    from tg_kit.client import telegram_errors
    from tg_kit.raw import build_object, find_method

    with telegram_errors():
        if step.method in CLIENT_METHODS:
            kwargs = {k: (v.input if isinstance(v, Peer) else v) for k, v in step.params.items()}
            if step.method == "send_message" and "top_msg_id" in kwargs:
                return await _send_in_topic(client, kwargs)
            return await getattr(client, step.method)(**kwargs)

        async def no_resolve(spec: str) -> Peer:
            msg = f"plan step {step.method} holds an unresolved peer {spec!r}"
            raise AssertionError(msg)

        request = await build_object(find_method(step.method), step.params, no_resolve)
        return await client(request)


async def _send_in_topic(client: Any, params: dict[str, Any]) -> Any:
    """`send_message` replying to a message inside a forum topic.

    Telegram wants the topic in `top_msg_id` then (core.telegram.org/api/forum),
    and Telethon's send_message only takes a message id. Otherwise the same
    request, built the way send_message builds it.
    """
    from telethon.tl import functions, types

    peer = await client.get_input_entity(params["entity"])
    text, entities = await client._parse_message_text(params["message"], params["parse_mode"])  # noqa: SLF001 — what send_message does
    request = functions.messages.SendMessageRequest(
        peer=peer,
        message=text,
        entities=entities,
        no_webpage=not params["link_preview"],
        reply_to=types.InputReplyToMessage(params["reply_to"], top_msg_id=params["top_msg_id"]),
        silent=params["silent"],
    )
    result = await client(request)
    return client._get_response_message(request, result, peer)  # noqa: SLF001 — what send_message does
