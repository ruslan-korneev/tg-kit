"""`--wait`: collect a chat's replies and edits after an action.

The rules, which agents rely on:

1. Subscribe (NewMessage + MessageEdited for the chat) **before** the action,
   or a fast bot's reply races the subscription and is lost.
2. Until the first event, wait up to the whole budget. After any event, stop
   once `quiet` seconds pass with nothing new — or when the budget ends.
3. Only incoming messages count; own outgoing echoes are ignored.
4. A message edited several times is reported once, in its final state, with
   the number of edits seen (✎×N).
5. Nothing collected → the caller exits 6.

`collect` is pure over an `EventSource` and a clock, so the timing rules are
unit-tested with a scripted source and a fake clock.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from tg_kit.model import MessageView, with_edits

__all__ = [
    "DEFAULT_QUIET",
    "Event",
    "EventSource",
    "TelethonSource",
    "collect",
    "run_and_collect",
]

# Quiet window after the last event. Bots that send a reply and then edit it
# (or send 2–3 messages in a row) do so within ~1 s; 1.5 s catches that
# without making every command wait long. Overridable with --quiet.
DEFAULT_QUIET = 1.5

# Waits shorter than this count as done: they cannot deliver anything, and with
# float arithmetic an ever-shrinking remainder must not keep the loop alive.
_MIN_WAIT = 0.001


@dataclass(frozen=True)
class Event:
    view: MessageView
    edit: bool


class EventSource(Protocol):
    async def start(self) -> None: ...
    async def next(self, within: float) -> Event | None: ...
    async def stop(self) -> None: ...


async def collect(
    source: EventSource, *, budget: float, quiet: float, clock: Callable[[], float]
) -> list[MessageView]:
    start = clock()
    deadline = start + budget
    last: float | None = None
    order: list[int] = []
    latest: dict[int, MessageView] = {}
    edits: dict[int, int] = {}
    while True:
        now = clock()
        remaining = deadline - now
        wait = remaining if last is None else min(remaining, quiet - (now - last))
        if wait < _MIN_WAIT:
            break
        event = await source.next(wait)
        if event is None:
            continue
        last = clock()
        key = event.view.id
        if key not in latest:
            order.append(key)
            edits[key] = 0
        if event.edit:
            edits[key] += 1
        latest[key] = event.view
    return [with_edits(latest[k], edits[k]) for k in order]


async def run_and_collect[T](
    source: EventSource,
    action: Callable[[], Awaitable[T]],
    *,
    budget: float,
    quiet: float,
    clock: Callable[[], float],
) -> tuple[T, list[MessageView]]:
    """Subscribe, then act, then collect — the ordering is the point."""
    await source.start()
    try:
        result = await action()
        views = await collect(source, budget=budget, quiet=quiet, clock=clock)
    finally:
        await source.stop()
    return result, views


class TelethonSource:
    """Feeds a chat's incoming new/edited messages into a queue."""

    def __init__(self, client: Any, chat_id: int, *, convert: Callable[[Any], MessageView]) -> None:
        self._client = client
        self._chat_id = chat_id
        self._convert = convert
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._handlers: list[tuple[Any, Any]] = []
        self._failure: BaseException | None = None

    async def start(self) -> None:
        from telethon import events

        for builder, edit in (
            (events.NewMessage(incoming=True), False),
            (events.MessageEdited(incoming=True), True),
        ):
            handler = self._make_handler(edit=edit)
            self._client.add_event_handler(handler, builder)
            self._handlers.append((handler, builder))

    def _make_handler(self, *, edit: bool) -> Callable[[Any], Awaitable[None]]:
        async def handler(event: Any) -> None:
            if event.chat_id != self._chat_id:
                return
            try:
                view = self._convert(event.message)
            except Exception as exc:  # noqa: BLE001 — surfaced from next(), not lost in Telethon's handler loop
                self._failure = exc
                self._queue.put_nowait(None)
                return
            self._queue.put_nowait(Event(view=view, edit=edit))

        return handler

    async def next(self, within: float) -> Event | None:
        try:
            event = await asyncio.wait_for(self._queue.get(), within)
        except TimeoutError:
            return None
        if self._failure is not None:
            # A reply arrived but could not be read: failing beats a false "no reply" (exit 6).
            raise self._failure
        return event

    async def stop(self) -> None:
        for handler, builder in self._handlers:
            self._client.remove_event_handler(handler, builder)
        self._handlers.clear()
