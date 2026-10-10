"""`tg watch`: stream a few chats' events until stopped.

The rules, which the consumers (agents, the Dialogs Pane mod) rely on:

1. Subscribe **before** replaying `--after`/`--since`, so nothing falls in the gap.
   A message seen both in the replay and live is printed once.
2. Everything printed before the `ready` line is replay; everything after is live.
3. Messages in both directions count (`out` tells them apart): a reply typed on
   the phone must reach the watcher too.
4. Telegram does not say which chat a private-chat or basic-group deletion
   belongs to (message ids there are per account). Such deletions are reported
   only for ids this watch has printed; channel and supergroup deletions always.
5. `--idle-exit` ends the stream after that long with nothing printed (exit 0).

`Follower` and `follow` are pure over an event source and a clock, so these
rules are unit-tested without a network.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from tg_kit.errors import UsageError
from tg_kit.model import DeleteEvent, MessageEvent, MessageView, TypingEvent, WatchEvent

__all__ = [
    "EVENT_KINDS",
    "Follower",
    "TelethonWatchSource",
    "WatchSource",
    "follow",
    "kind_of",
    "parse_events",
]

EVENT_KINDS = ("message", "edit", "typing", "delete")

# Ids remembered for attributing private-chat deletions (rule 4). A few hours of
# a busy chat; beyond it an old message's deletion is simply not reported.
REMEMBERED_IDS = 50_000

_MIN_WAIT = 0.001  # see waiter: a shrinking float remainder must not keep the loop alive


def kind_of(event: WatchEvent) -> str:
    if isinstance(event, MessageEvent):
        return "edit" if event.edit else "message"
    return "typing" if isinstance(event, TypingEvent) else "delete"


def parse_events(value: str | None) -> frozenset[str]:
    """`message,edit` → that set; None → every kind."""
    if value is None:
        return frozenset(EVENT_KINDS)
    kinds = {part.strip().lower() for part in value.split(",") if part.strip()}
    unknown = sorted(kinds - set(EVENT_KINDS))
    if unknown or not kinds:
        raise UsageError(
            f"invalid --events {value!r}", hint=f"use a comma list of: {','.join(EVENT_KINDS)}"
        )
    return frozenset(kinds)


@dataclass
class Follower:
    """Decides what of the raw stream gets printed (rules 1, 3, 4)."""

    chat_ids: frozenset[int]
    kinds: frozenset[str]
    replayed: set[tuple[int, int]] = field(default_factory=set)
    _chat_of: dict[int, int] = field(default_factory=dict)

    def remember(self, chat_id: int, msg_id: int) -> None:
        self._chat_of.pop(msg_id, None)
        self._chat_of[msg_id] = chat_id
        if len(self._chat_of) > REMEMBERED_IDS:
            del self._chat_of[next(iter(self._chat_of))]

    def mark_replayed(self, events: Iterable[MessageEvent]) -> None:
        for event in events:
            self.replayed.add((event.view.chat_id, event.view.id))
            self.remember(event.view.chat_id, event.view.id)

    def accept(self, event: WatchEvent) -> list[WatchEvent]:
        if isinstance(event, DeleteEvent):
            return [e for e in self._attribute(event) if "delete" in self.kinds]
        if isinstance(event, TypingEvent):
            ok = event.chat_id in self.chat_ids and "typing" in self.kinds
            return [event] if ok else []
        view = event.view
        if view.chat_id not in self.chat_ids:
            return []
        key = (view.chat_id, view.id)
        if not event.edit and key in self.replayed:
            return []
        self.remember(view.chat_id, view.id)
        return [event] if kind_of(event) in self.kinds else []

    def _attribute(self, event: DeleteEvent) -> list[DeleteEvent]:
        if event.chat_id is not None:
            return [event] if event.chat_id in self.chat_ids else []
        by_chat: dict[int, list[int]] = {}
        for msg_id in event.ids:
            chat_id = self._chat_of.pop(msg_id, None)
            if chat_id is not None:
                by_chat.setdefault(chat_id, []).append(msg_id)
        return [
            DeleteEvent(chat_id=chat_id, ids=tuple(ids), date=event.date)
            for chat_id, ids in by_chat.items()
        ]


class WatchSource(Protocol):
    async def next(self, within: float | None) -> WatchEvent | None: ...


async def follow(
    source: WatchSource,
    emit: Callable[[WatchEvent], None],
    *,
    follower: Follower,
    idle_exit: float | None,
    clock: Callable[[], float],
) -> None:
    """Print accepted events until `idle_exit` seconds pass with nothing printed (or forever)."""
    last = clock()
    while True:
        wait = None if idle_exit is None else idle_exit - (clock() - last)
        if wait is not None and wait < _MIN_WAIT:
            return
        event = await source.next(wait)
        if event is None:
            continue
        accepted = follower.accept(event)
        for item in accepted:
            emit(item)
        if accepted:
            last = clock()


class TelethonWatchSource:
    """Feeds new/edited messages, typing and deletions for `chat_ids` into a queue.

    Subscribed in `start()`; the Telethon handlers only filter, convert and enqueue.
    """

    def __init__(
        self,
        client: Any,
        chat_ids: Collection[int],
        *,
        convert: Callable[[Any], MessageView],
        typing: Callable[[Any, datetime], TypingEvent | None],
        delete: Callable[[Any, datetime], DeleteEvent | None],
    ) -> None:
        self._client = client
        self._chat_ids = frozenset(chat_ids)
        self._convert = convert
        self._typing = typing
        self._delete = delete
        self._queue: asyncio.Queue[WatchEvent | None] = asyncio.Queue()
        self._handlers: list[tuple[Any, Any]] = []
        self._failure: BaseException | None = None

    async def start(self) -> None:
        from telethon import events

        from tg_kit.convert import DELETE_UPDATES, TYPING_UPDATES

        handlers = (
            (self._message_handler(edit=False), events.NewMessage()),
            (self._message_handler(edit=True), events.MessageEdited()),
            (self._update_handler(self._typing), events.Raw(types=list(TYPING_UPDATES))),
            (self._update_handler(self._delete), events.Raw(types=list(DELETE_UPDATES))),
        )
        for handler, builder in handlers:
            self._client.add_event_handler(handler, builder)
            self._handlers.append((handler, builder))

    def _message_handler(self, *, edit: bool) -> Callable[[Any], Any]:
        async def handler(event: Any) -> None:
            if event.chat_id not in self._chat_ids:
                return
            self._put(lambda: MessageEvent(view=self._convert(event.message), edit=edit))

        return handler

    def _update_handler(
        self, convert: Callable[[Any, datetime], WatchEvent | None]
    ) -> Callable[[Any], Any]:
        async def handler(update: Any) -> None:
            self._put(lambda: convert(update, datetime.now(UTC)))

        return handler

    def _put(self, make: Callable[[], WatchEvent | None]) -> None:
        try:
            event = make()
        except Exception as exc:  # noqa: BLE001 — surfaced from next(), not lost in Telethon's handler loop
            self._failure = exc
            self._queue.put_nowait(None)
            return
        if event is not None:
            self._queue.put_nowait(event)

    async def next(self, within: float | None) -> WatchEvent | None:
        try:
            event = await asyncio.wait_for(self._queue.get(), within)
        except TimeoutError:
            return None
        if self._failure is not None:
            # An event arrived but could not be read: failing beats silently skipping it.
            raise self._failure
        return event

    async def stop(self) -> None:
        for handler, builder in self._handlers:
            self._client.remove_event_handler(handler, builder)
        self._handlers.clear()
