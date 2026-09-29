"""Pins `--wait` collection over a scripted event source and a fake clock:
budget before the first event, quiet window after it, edits collapsing to the
final state with a count, empty result on silence, and subscribe-before-act.

Not covered: Telethon actually delivering updates (live smoke test: BotFather
/mybots + press printed the edited message).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from tg_kit.model import MessageView, Sender
from tg_kit.waiter import Event, collect, run_and_collect

BOT = Sender(id=5, kind="bot", username="example_bot", name="Example")


def msg(msg_id: int, text: str) -> MessageView:
    return MessageView(
        id=msg_id,
        chat_id=5,
        date=datetime(2026, 9, 29, tzinfo=UTC),
        sender=BOT,
        out=False,
        text=text,
    )


@dataclass
class Clock:
    t: float = 0.0

    def __call__(self) -> float:
        return self.t


@dataclass
class ScriptedSource:
    """Events arrive at scripted times; `next` advances the fake clock."""

    clock: Clock
    script: list[tuple[float, Event]]
    log: list[str] = field(default_factory=list)

    async def start(self) -> None:
        self.log.append("start")

    async def stop(self) -> None:
        self.log.append("stop")

    async def next(self, within: float) -> Event | None:
        if self.script and self.script[0][0] <= self.clock.t + within:
            at, event = self.script.pop(0)
            self.clock.t = max(self.clock.t, at)
            return event
        self.clock.t += within
        return None


def run(source: ScriptedSource, *, budget: float = 10, quiet: float = 1.5) -> list[MessageView]:
    return asyncio.run(collect(source, budget=budget, quiet=quiet, clock=source.clock))


def test_silence_returns_nothing_after_the_whole_budget() -> None:
    clock = Clock()
    assert run(ScriptedSource(clock, [])) == []
    assert clock.t == 10


def test_slow_first_reply_is_still_caught_within_budget() -> None:
    clock = Clock()
    views = run(ScriptedSource(clock, [(8.0, Event(msg(1, "late"), edit=False))]))
    assert [v.text for v in views] == ["late"]
    assert clock.t == 9.5  # stopped one quiet window after it


def test_quiet_window_ends_collection_early() -> None:
    clock = Clock()
    source = ScriptedSource(
        clock,
        [
            (0.5, Event(msg(1, "a"), edit=False)),
            (1.2, Event(msg(2, "b"), edit=False)),
            (5.0, Event(msg(3, "too late"), edit=False)),  # after a 1.5 s gap
        ],
    )
    assert [v.id for v in run(source)] == [1, 2]
    assert clock.t == 2.7


def test_budget_caps_a_chatty_chat() -> None:
    clock = Clock()
    script = [(0.5 * i, Event(msg(i, str(i)), edit=False)) for i in range(1, 100)]
    views = run(ScriptedSource(clock, script), budget=3)
    assert len(views) == 6
    assert clock.t == 3


def test_edits_collapse_to_final_state_with_count() -> None:
    clock = Clock()
    source = ScriptedSource(
        clock,
        [
            (0.2, Event(msg(1, "v1"), edit=True)),  # edit of a message that existed before
            (0.4, Event(msg(2, "new"), edit=False)),
            (0.6, Event(msg(1, "v2"), edit=True)),
            (0.8, Event(msg(1, "v3"), edit=True)),
        ],
    )
    views = run(source)
    assert [(v.id, v.text, v.edits) for v in views] == [(1, "v3", 3), (2, "new", 0)]


def test_subscription_happens_before_the_action_and_is_released() -> None:
    clock = Clock()
    source = ScriptedSource(clock, [(0.1, Event(msg(1, "reply"), edit=False))])

    async def action() -> str:
        source.log.append("action")
        return "sent"

    result, views = asyncio.run(run_and_collect(source, action, budget=5, quiet=1, clock=clock))
    assert source.log == ["start", "action", "stop"]
    assert result == "sent"
    assert [v.text for v in views] == ["reply"]


def test_subscription_is_released_when_the_action_fails() -> None:
    clock = Clock()
    source = ScriptedSource(clock, [])

    async def action() -> None:
        raise RuntimeError("send failed")

    with pytest.raises(RuntimeError, match="send failed"):
        asyncio.run(run_and_collect(source, action, budget=5, quiet=1, clock=clock))
    assert source.log == ["start", "stop"]
