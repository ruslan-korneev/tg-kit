"""`tg watch`: stay connected and stream chats' events (see `watch` for the rules)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import stat
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

import typer

from tg_kit.app import (
    AccountOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    TopicOpt,
    VerboseOpt,
    globals_from,
    note,
    run,
)
from tg_kit.client import Connected, telegram_errors
from tg_kit.common import HARD_MAX, resolve_spec, resolve_topic_id, self_id, view_of
from tg_kit.convert import convert_delete, convert_typing
from tg_kit.errors import TgError, UsageError
from tg_kit.model import GENERAL_TOPIC, MessageEvent, WatchEvent
from tg_kit.parsing import parse_duration, parse_since
from tg_kit.peers import Peer
from tg_kit.render import event_json, event_lines, ready_json
from tg_kit.watch import EVENT_KINDS, Follower, TelethonWatchSource, follow, parse_events

__all__ = ["register"]


class _ConsumerGone(Exception):  # noqa: N818 — a signal, not an error: the reader closed the pipe
    pass


def register(app: typer.Typer) -> None:
    @app.command()
    def watch(
        ctx: typer.Context,
        peers: Annotated[
            list[str],
            typer.Argument(metavar="PEER...", help="me, @username, id, t.me link, title:…"),
        ],
        jsonl: Annotated[
            bool, typer.Option("--jsonl", help="One JSON object per line (see README).")
        ] = False,
        events: Annotated[
            str | None,
            typer.Option("--events", help=f"Comma list of {','.join(EVENT_KINDS)} (default: all)."),
        ] = None,
        after: Annotated[
            int | None,
            typer.Option("--after", help="First replay messages newer than this id (one PEER)."),
        ] = None,
        since: Annotated[
            str | None,
            typer.Option("--since", help="First replay messages since 2h, 3d or 2026-09-01."),
        ] = None,
        idle_exit: Annotated[
            str | None,
            typer.Option("--idle-exit", help="Exit 0 after this long with nothing printed."),
        ] = None,
        topic: TopicOpt = None,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Stream new and edited messages, typing and deletions in chats until stopped.

        Lines before `ready` are the replay; Ctrl-C or SIGTERM exits 0.
        """
        g = globals_from(ctx, account, json_out, timeout, verbose)
        kinds, idle = _check_options(g.json, peers, events, after, since, idle_exit, topic)

        async def body(rt: Runtime) -> int:
            since_at = parse_since(since, now=rt.now) if since else None
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, stop.set)
            _on_reader_gone(loop, stop.set)
            work = asyncio.ensure_future(
                _watch(
                    rt,
                    peers,
                    kinds=kinds,
                    after=after,
                    since_at=since_at,
                    idle=idle,
                    jsonl=jsonl,
                    topic=topic,
                )
            )
            stopper = asyncio.ensure_future(stop.wait())
            try:
                await asyncio.wait({work, stopper}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                stopper.cancel()
                if not work.done():
                    work.cancel()  # a stop: disconnect cleanly, then exit 0
                    with contextlib.suppress(asyncio.CancelledError):
                        await work
            if work.cancelled():
                return 0
            try:
                return work.result()
            except _ConsumerGone:
                return 0

        run(g, body, unbounded=True)


def _check_options(
    json_out: bool,
    peers: list[str],
    events: str | None,
    after: int | None,
    since: str | None,
    idle_exit: str | None,
    topic: int | None,
) -> tuple[frozenset[str], float | None]:
    if json_out:
        raise UsageError("tg watch streams; --json prints one document", hint="use --jsonl")
    if after is not None and since is not None:
        raise UsageError("--after and --since replay differently; pass one")
    if after is not None and len(peers) > 1:
        # Channel message ids are per channel, so one id means nothing across chats.
        raise UsageError("--after takes one PEER", hint="use --since for several chats")
    if topic is not None and len(peers) > 1:
        raise UsageError("--topic takes one PEER: a topic belongs to one forum")
    kinds = parse_events(events)
    idle = parse_duration(idle_exit) if idle_exit is not None else None
    if idle is not None and idle <= 0:
        raise UsageError("--idle-exit must be positive")
    return kinds, idle


async def _watch(
    rt: Runtime,
    specs: list[str],
    *,
    kinds: frozenset[str],
    after: int | None,
    since_at: datetime | None,
    idle: float | None,
    jsonl: bool,
    topic: int | None,
) -> int:
    # Connect, resolve, subscribe and replay within --timeout; following has no deadline.
    setup = rt.globals.timeout + rt.config.flood_sleep_threshold
    async with asyncio.timeout(setup) as deadline, rt.connect(updates=True) as conn:
        targets = [await resolve_spec(conn, spec) for spec in specs]
        for target in targets:
            await resolve_topic_id(conn, target, topic)
        chat_ids = {_chat_id(conn, t): t for t in targets}
        me = self_id(conn)
        forum = True if topic is not None else None  # resolve_topic_id proved it is a forum
        source = TelethonWatchSource(
            conn.client,
            chat_ids,
            convert=lambda msg: view_of(conn, msg, forum=forum),
            typing=lambda update, now: convert_typing(
                update, self_id=me, find=lambda pid: conn.session.find(peer_id=pid), now=now
            ),
            delete=lambda update, now: convert_delete(update, now=now),
        )
        emit = _Printer(rt, jsonl=jsonl, chat_ids=chat_ids)
        await source.start()  # rule 1: subscribe before the replay
        try:
            follower = Follower(chat_ids=frozenset(chat_ids), kinds=kinds, topic=topic)
            if after is not None or since_at is not None:
                replayed = await _replay(conn, targets, after=after, since_at=since_at, topic=topic)
                follower.mark_replayed(replayed)
                for event in replayed:
                    if "message" in kinds:
                        emit(event)
            emit.ready()
            deadline.reschedule(None)
            await _follow_until_disconnected(conn, source, emit, follower=follower, idle=idle)
        finally:
            await source.stop()
    return 0


async def _follow_until_disconnected(
    conn: Connected,
    source: TelethonWatchSource,
    emit: Callable[[WatchEvent], None],
    *,
    follower: Follower,
    idle: float | None,
) -> None:
    following = asyncio.ensure_future(
        follow(source, emit, follower=follower, idle_exit=idle, clock=time.monotonic)
    )
    lost = asyncio.ensure_future(conn.client.disconnected)
    try:
        await asyncio.wait({following, lost}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (following, lost):
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
    if following.done() and not following.cancelled():
        following.result()  # idle exit, or the error that ended it
        return
    reason = lost.exception() if lost.done() and not lost.cancelled() else None
    raise TgError(
        f"lost the connection to Telegram{f': {reason}' if reason else ''}",
        hint="rerun tg watch; replay what was missed with --after LAST_ID or --since",
    )


async def _replay(
    conn: Connected,
    targets: list[Peer],
    *,
    after: int | None,
    since_at: datetime | None,
    topic: int | None,
) -> list[MessageEvent]:
    """Each chat's messages after the id/date, oldest first, merged by date.

    In a topic: its messages only. General's are picked out of the forum's history,
    so its replay looks at HARD_MAX messages and keeps General's."""
    events: list[MessageEvent] = []
    general = topic == GENERAL_TOPIC
    for target in targets:
        with telegram_errors():
            views = [
                view_of(conn, msg, forum=True if topic is not None else None)
                async for msg in conn.client.iter_messages(
                    target.input,
                    limit=HARD_MAX,
                    min_id=after or 0,
                    offset_date=since_at,
                    reverse=True,
                    reply_to=None if topic is None or general else topic,
                )
            ]
        if len(views) >= HARD_MAX:
            note(
                f"note: replay of {target.label()} capped at {HARD_MAX} messages; "
                f"the rest: tg read {target.id} --after {views[-1].id}"
            )
        events.extend(MessageEvent(view=v) for v in views if topic is None or v.topic_id == topic)
    events.sort(key=lambda e: e.view.date)
    return events


def _chat_id(conn: Connected, target: Peer) -> int:
    # Saved Messages arrive with the account's own user id as the chat.
    return (self_id(conn) or target.id) if target.kind == "self" else target.id


class _Printer:
    """Writes each line and flushes it at once: the reader acts on every event as it comes."""

    def __init__(self, rt: Runtime, *, jsonl: bool, chat_ids: dict[int, Peer]) -> None:
        self._now = rt.now
        self._jsonl = jsonl
        self._chat_ids = chat_ids
        # Compact lines name the chat only when several chats share the stream.
        multi = len(chat_ids) > 1
        self._labels = {cid: t.label() for cid, t in chat_ids.items()} if multi else {}

    def ready(self) -> None:
        if not self._jsonl:
            _write("ready: watching " + ", ".join(t.label() for t in self._chat_ids.values()))
            return
        peers: list[dict[str, object]] = [
            {"chat_id": cid, "kind": t.kind, "username": t.username, "title": t.title}
            for cid, t in self._chat_ids.items()
        ]
        _write(json.dumps(ready_json(peers, datetime.now(UTC)), ensure_ascii=False))

    def __call__(self, event: WatchEvent) -> None:
        if self._jsonl:
            _write(json.dumps(event_json(event), ensure_ascii=False, default=str))
            return
        chat_id = event.view.chat_id if isinstance(event, MessageEvent) else event.chat_id
        chat = self._labels.get(chat_id) if chat_id is not None else None
        for line in event_lines(event, now=self._now, chat=chat):
            _write(line)


def _on_reader_gone(loop: asyncio.AbstractEventLoop, callback: Callable[[], None]) -> None:
    """Stop when the process reading our stdout pipe exits, not at the next write.

    A quiet chat may print nothing for hours; without this, a watch whose reader
    died would linger until then. The write end of a pipe polls readable once
    the read end is closed (kqueue EV_EOF, epoll EPOLLERR). Only pipes: a
    terminal is readable whenever someone types.
    """
    fd = sys.stdout.fileno()
    if not stat.S_ISFIFO(os.fstat(fd).st_mode):
        return

    def gone() -> None:
        loop.remove_reader(fd)
        callback()

    loop.add_reader(fd, gone)


def _write(line: str) -> None:
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        # The reader went away: stop quietly, and keep Python's exit-time flush from failing too.
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
        raise _ConsumerGone from None
