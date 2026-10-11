"""Write commands. Each builds a WritePlan, passes the guard, then executes it.

Every one supports --dry-run (prints the plan, sends nothing) and prints the
resolved target as its first stderr line before sending.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated, Any

import typer

from tg_kit.app import (
    AccountOpt,
    DryRunOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    TopicOpt,
    VerboseOpt,
    YesOpt,
    emit_json,
    globals_from,
    note,
    run,
)
from tg_kit.common import (
    authorize,
    execute_plan,
    make_plan,
    no_reply,
    parse_wait,
    print_views,
    resolve_spec,
    resolve_topic_id,
    sent_views,
    topic_of_reply,
    with_wait,
)
from tg_kit.errors import UsageError
from tg_kit.model import GENERAL_TOPIC, MessageView
from tg_kit.parsing import read_text
from tg_kit.peers import Peer, message_id_in
from tg_kit.plan import Step
from tg_kit.render import message_json
from tg_kit.texts import CAPTION_LIMIT, split_text

__all__ = ["raw_topic_reply", "register", "sent_output", "topic_reply"]

TextArg = Annotated[str, typer.Argument(metavar="TEXT|-", help="Message text, or - to read stdin.")]
WaitOpt = Annotated[
    str | None,
    typer.Option(
        "--wait", help="Collect replies/edits for up to this long (5s, 2m). Exit 6 if none."
    ),
]
QuietOpt = Annotated[
    str | None,
    typer.Option("--quiet", help="Stop after this long with no new event (default 1.5s)."),
]


def _parse_mode(md: bool, html: bool, plain: bool) -> str | None:
    if md + html + plain > 1:
        raise UsageError("pick one of --md, --html, --plain")
    if html:
        return "html"
    if plain:
        return None
    return "md"


def topic_reply(topic: int | None, reply_to: int | None) -> dict[str, object]:
    """The send params that put a message into forum topic `topic`, replying to `reply_to`.

    A topic's id is its first message's id, so posting into it is replying to
    that. A reply to another message inside the topic names the topic in
    `top_msg_id`. General takes neither: a forum's plain messages are General.
    """
    if topic is None or topic == GENERAL_TOPIC:
        return {"reply_to": reply_to}
    if reply_to is None or reply_to == topic:
        return {"reply_to": topic}
    return {"reply_to": reply_to, "top_msg_id": topic}


def raw_topic_reply(topic: int | None) -> dict[str, object]:
    """`topic_reply` for an MTProto step: its `reply_to` as an InputReplyToMessage."""
    into = topic_reply(topic, None)["reply_to"]
    if into is None:
        return {}
    return {"reply_to": {"_": "InputReplyToMessage", "reply_to_msg_id": into}}


def sent_output(
    rt: Runtime, sent: list[MessageView], replies: list[MessageView] | None, peer_hint: str
) -> None:
    """Sent messages first, then what came back (when waiting)."""
    if rt.json:
        doc: dict[str, object] = {"sent": [message_json(v) for v in sent]}
        if replies is not None:
            doc["replies"] = [message_json(v) for v in replies]
        emit_json(doc)
        return
    print_views(rt, sent, truncate=None, peer_hint=peer_hint)
    if replies:
        print_views(rt, replies, truncate=None, peer_hint=peer_hint)


async def send_plan_and_maybe_wait(
    rt: Runtime,
    conn: Any,
    target: Peer,
    plan: Any,
    *,
    wait: float | None,
    quiet: float,
    peer_hint: str,
) -> int:
    """Run an authorized plan; with `wait`, subscribe first and collect replies.

    In a forum topic only that topic's replies count (`plan.topic`)."""
    if wait is None:
        results = await execute_plan(conn, plan)
        sent_output(rt, sent_views(conn, results, target), None, peer_hint)
        return 0
    results, replies = await with_wait(
        conn,
        target,
        lambda: execute_plan(conn, plan),
        budget=wait,
        quiet=quiet,
        topic=plan.topic.id if plan.topic else None,
    )
    sent_output(rt, sent_views(conn, results, target), replies, peer_hint)
    if not replies:
        raise no_reply(wait)
    return 0


def register(app: typer.Typer) -> None:  # noqa: C901, PLR0915 — one branch per case keeps the contract readable in one place
    @app.command()
    def send(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="me, @username, id, …")],
        text: TextArg,
        reply_to: Annotated[
            int | None, typer.Option("--reply-to", help="Reply to this message id.")
        ] = None,
        no_preview: Annotated[bool, typer.Option("--no-preview", help="No link preview.")] = False,
        md: Annotated[bool, typer.Option("--md", help="Markdown (default).")] = False,
        html: Annotated[bool, typer.Option("--html", help="HTML formatting.")] = False,
        plain: Annotated[bool, typer.Option("--plain", help="No formatting.")] = False,
        silent: Annotated[bool, typer.Option("--silent", help="No notification sound.")] = False,
        topic: TopicOpt = None,
        wait: WaitOpt = None,
        quiet: QuietOpt = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Send a message. Texts over 4096 chars go as several messages, in order."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        body_text = read_text(text, sys.stdin)
        mode = _parse_mode(md, html, plain)
        budget, q = parse_wait(wait, quiet)

        async def body(rt: Runtime) -> int:
            async with rt.connect(updates=budget is not None) as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                into = await topic_of_reply(conn, target, topic, reply_to)
                where = await resolve_topic_id(conn, target, into)
                chunks = split_text(body_text)
                steps = [
                    Step(
                        "send_message",
                        {
                            "entity": target,
                            "message": chunk,
                            **topic_reply(into, reply_to if i == 0 else None),
                            "link_preview": not no_preview,
                            "parse_mode": mode,
                            "silent": silent or None,
                        },
                    )
                    for i, chunk in enumerate(chunks)
                ]
                plan = make_plan(rt, "send", target, steps, yes=yes, topic=where)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                return await send_plan_and_maybe_wait(
                    rt, conn, target, plan, wait=budget, quiet=q, peer_hint=peer
                )

        run(
            g,
            body,
            extra_budget=budget or 0.0,
            timeout_hint=f"unknown if delivered — check with: tg read {peer} -n 3",
        )

    @app.command("send-file")
    def send_file(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="me, @username, id, …")],
        path: Annotated[str, typer.Argument(metavar="PATH|URL", help="Local file or http(s) URL.")],
        caption: Annotated[
            str | None, typer.Option("--caption", help=f"Up to {CAPTION_LIMIT} chars.")
        ] = None,
        as_doc: Annotated[
            bool, typer.Option("--as-doc", help="Send as a file, not as photo/video.")
        ] = False,
        topic: TopicOpt = None,
        wait: WaitOpt = None,
        quiet: QuietOpt = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Send a file (photo/video/document) with an optional caption."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        budget, q = parse_wait(wait, quiet)
        is_url = path.startswith(("http://", "https://"))
        if not is_url and not Path(path).expanduser().is_file():
            raise typer.BadParameter(f"no such file: {path}")
        if caption is not None and len(caption) > CAPTION_LIMIT:
            # Decided: refuse rather than silently splitting into file + text.
            raise typer.BadParameter(
                f"caption is {len(caption)} chars, over Telegram's {CAPTION_LIMIT}; "
                "send the file with a short caption, then the text with tg send --reply-to ID"
            )
        file_ref = path if is_url else str(Path(path).expanduser().resolve())

        async def body(rt: Runtime) -> int:
            async with rt.connect(updates=budget is not None) as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                where = await resolve_topic_id(conn, target, topic)
                into = topic_reply(topic, None)["reply_to"]
                step = Step(
                    "send_file",
                    {
                        "entity": target,
                        "file": file_ref,
                        "caption": caption,
                        "force_document": as_doc,
                        **({"reply_to": into} if into is not None else {}),
                    },
                )
                plan = make_plan(rt, "send-file", target, [step], yes=yes, topic=where)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                return await send_plan_and_maybe_wait(
                    rt, conn, target, plan, wait=budget, quiet=q, peer_hint=peer
                )

        run(
            g,
            body,
            extra_budget=budget or 0.0,
            timeout_hint=f"unknown if delivered — check with: tg read {peer} -n 3",
        )

    @app.command()
    def edit(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        msg_id: Annotated[str, typer.Argument(metavar="ID", help="Your message's id.")],
        text: TextArg,
        md: Annotated[bool, typer.Option("--md", help="Markdown (default).")] = False,
        html: Annotated[bool, typer.Option("--html", help="HTML formatting.")] = False,
        plain: Annotated[bool, typer.Option("--plain", help="No formatting.")] = False,
        no_preview: Annotated[bool, typer.Option("--no-preview", help="No link preview.")] = False,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Edit one of your messages."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = message_id_in(peer, msg_id)
        new_text = read_text(text, sys.stdin)
        mode = _parse_mode(md, html, plain)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                step = Step(
                    "edit_message",
                    {
                        "entity": target,
                        "message": wanted,
                        "text": new_text,
                        "parse_mode": mode,
                        "link_preview": not no_preview,
                    },
                )
                plan = make_plan(rt, "edit", target, [step], yes=yes)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                results = await execute_plan(conn, plan)
                sent_output(rt, sent_views(conn, results, target), None, peer)
            return 0

        run(g, body)

    @app.command()
    def delete(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        ids: Annotated[list[str], typer.Argument(metavar="ID...", help="Message ids.")],
        revoke: Annotated[
            bool,
            typer.Option(
                "--revoke/--only-me", help="Delete for everyone (default) or only for you."
            ),
        ] = True,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Delete messages. Always needs --yes."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = [message_id_in(peer, i) for i in ids]

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                step = Step(
                    "delete_messages", {"entity": target, "message_ids": wanted, "revoke": revoke}
                )
                plan = make_plan(rt, "delete", target, [step], yes=yes, always_confirm=True)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                results = await execute_plan(conn, plan)
            count = sum(getattr(r, "pts_count", 0) for res in results for r in (res or []))
            if rt.json:
                emit_json({"deleted": wanted, "affected": count})
            else:
                note(f"deleted {len(wanted)} message(s): {' '.join(map(str, wanted))}")
            return 0

        run(g, body)

    @app.command()
    def forward(
        ctx: typer.Context,
        from_peer: Annotated[str, typer.Argument(metavar="FROM", help="Source chat.")],
        ids: Annotated[list[str], typer.Argument(metavar="ID...", help="Message ids.")],
        to: Annotated[str, typer.Option("--to", help="Destination chat.")],
        topic: Annotated[
            int | None,
            typer.Option(
                "--topic",
                help="A topic of the destination forum (1 is General).",
                show_default=False,
            ),
        ] = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Forward messages to another chat (the guard checks the destination)."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = [message_id_in(from_peer, i) for i in ids]

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                source = await resolve_spec(conn, from_peer)
                target = await resolve_spec(conn, to, for_write=True)
                where = await resolve_topic_id(conn, target, topic)
                if topic is None or topic == GENERAL_TOPIC:
                    step = Step(
                        "forward_messages",
                        {"entity": target, "messages": wanted, "from_peer": source},
                    )
                else:  # Telethon's forward_messages cannot name a topic
                    step = Step(
                        "messages.ForwardMessages",
                        {"from_peer": source, "id": wanted, "to_peer": target, "top_msg_id": topic},
                    )
                plan = make_plan(rt, "forward", target, [step], yes=yes, topic=where)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                results = await execute_plan(conn, plan)
                sent_output(rt, sent_views(conn, results, target), None, to)
            return 0

        run(g, body)

    @app.command()
    def react(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        msg_id: Annotated[str, typer.Argument(metavar="ID", help="Message id.")],
        emoji: Annotated[str, typer.Argument(help="One emoji, e.g. 👍. Empty string removes.")],
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Set (or with "" remove) your reaction on a message."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = message_id_in(peer, msg_id)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                reaction = [{"_": "ReactionEmoji", "emoticon": emoji}] if emoji else []
                step = Step(
                    "messages.SendReaction",
                    {"peer": target, "msg_id": wanted, "reaction": reaction},
                )
                plan = make_plan(rt, "react", target, [step], yes=yes)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                await execute_plan(conn, plan)
            if rt.json:
                emit_json({"id": wanted, "reaction": emoji or None})
            else:
                note(f"reacted {emoji or '(removed)'} on #{wanted}")
            return 0

        run(g, body)

    @app.command()
    def draft(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        text: TextArg,
        topic: TopicOpt = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Save a draft (plain text) in a chat, or in one forum topic, without sending it."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        draft_text = read_text(text, sys.stdin)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                where = await resolve_topic_id(conn, target, topic)
                step = Step(
                    "messages.SaveDraft",
                    {"peer": target, "message": draft_text, **raw_topic_reply(topic)},
                )
                plan = make_plan(rt, "draft", target, [step], yes=yes, topic=where)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                await execute_plan(conn, plan)
            note("draft saved")
            return 0

        run(g, body)

    @app.command("mark-read")
    def mark_read(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Mark every message in a chat as read."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                step = Step("send_read_acknowledge", {"entity": target})
                plan = make_plan(rt, "mark-read", target, [step], yes=yes)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                await execute_plan(conn, plan)
            note("marked read")
            return 0

        run(g, body)
