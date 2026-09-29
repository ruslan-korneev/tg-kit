"""Bot commands: press a button, inline mode, /start with a payload.

`press` is the heart of bot testing: it presses, then collects the edit of the
pressed message and any new messages (bots like @BotFather edit in place).
"""

from __future__ import annotations

import asyncio
import base64
from typing import Annotated, Any

import typer
from telethon import errors

from tg_kit.app import (
    AccountOpt,
    DryRunOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    VerboseOpt,
    YesOpt,
    emit_json,
    globals_from,
    note,
    out,
    run,
)
from tg_kit.buttons import Button, format_button, select_button
from tg_kit.client import telegram_errors
from tg_kit.cmd_write import QuietOpt, WaitOpt, send_plan_and_maybe_wait
from tg_kit.common import (
    authorize,
    execute_plan,
    make_plan,
    no_reply,
    parse_wait,
    print_views,
    resolve_spec,
    with_wait,
)
from tg_kit.errors import NotFoundError, RefusedError, TgError, UsageError
from tg_kit.peers import message_id_in
from tg_kit.plan import Step
from tg_kit.render import message_json

__all__ = ["no_press_action", "register"]

# press waits this long for replies/edits unless --wait says otherwise.
DEFAULT_PRESS_WAIT = "5s"
# Cap on waiting for the bot's callback answer itself; Telegram gives up on a
# silent bot with BOT_RESPONSE_TIMEOUT after a similar interval anyway.
ANSWER_TIMEOUT = 10.0
# Inline results listed at most (a bot may return 50).
INLINE_MAX = 20

_REFUSE = {
    "phone": "it would share the account's phone number",
    "geo": "it would share the account's location",
    "peer": "it would share a chat or user with the bot",
    "poll": "it opens poll creation in the Telegram app",
    "buy": "it starts a payment",
    "disabled": "the button is disabled",
}
_SHOW_ONLY = {"url", "login", "webapp"}


def register(app: typer.Typer) -> None:  # noqa: C901, PLR0915 — one branch per case keeps the contract readable in one place
    @app.command()
    def press(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The bot's chat.")],
        msg_id: Annotated[str, typer.Argument(metavar="ID", help="Message carrying the buttons.")],
        button: Annotated[
            str | None, typer.Argument(metavar="[BUTTON]", help="Button label.")
        ] = None,
        row: Annotated[int | None, typer.Option("--row", help="Button row, 0-based.")] = None,
        col: Annotated[int | None, typer.Option("--col", help="Button column, 0-based.")] = None,
        data: Annotated[
            str | None, typer.Option("--data", help="Raw callback data (UTF-8).")
        ] = None,
        data_hex: Annotated[
            str | None, typer.Option("--data-hex", help="Raw callback data (hex).")
        ] = None,
        wait: WaitOpt = DEFAULT_PRESS_WAIT,
        quiet: QuietOpt = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Press an inline or keyboard button, then show the bot's answer, edits and replies."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = message_id_in(peer, msg_id)
        budget, q = parse_wait(wait, quiet)
        assert budget is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
        raw_data = _raw_data(data, data_hex)
        if raw_data is not None and (button is not None or row is not None or col is not None):
            raise UsageError("--data/--data-hex replace the button; do not name one too")

        async def body(rt: Runtime) -> int:
            async with rt.connect(updates=True) as conn:
                target = await resolve_spec(conn, peer, for_write=True)
                if raw_data is not None:
                    chosen = Button(row=-1, col=-1, type="cb", text="(raw data)", data=raw_data)
                else:
                    chosen = await _find_button(conn, target, wanted, button, row, col)
                return await _press(
                    rt,
                    conn,
                    target,
                    wanted,
                    chosen,
                    budget=budget,
                    quiet=q,
                    yes=yes,
                    dry_run=dry_run,
                    peer_hint=peer,
                )

        run(
            g,
            body,
            extra_budget=budget + ANSWER_TIMEOUT,
            timeout_hint=f"unknown if the press reached the bot; check: tg msg {peer} {wanted}",
        )

    @app.command()
    def inline(
        ctx: typer.Context,
        bot: Annotated[str, typer.Argument(help="@bot that supports inline mode.")],
        query: Annotated[str, typer.Argument(help="Inline query text.")] = "",
        peer: Annotated[
            str | None, typer.Option("--peer", help="Chat the query is made in.")
        ] = None,
        pick: Annotated[int | None, typer.Option("--pick", help="Send result N (0-based).")] = None,
        to: Annotated[
            str | None, typer.Option("--to", help="Chat to send the picked result to.")
        ] = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """List a bot's inline results; with --pick N --to PEER, send one."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        if (pick is None) != (to is None):
            raise typer.BadParameter("--pick and --to go together")

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                bot_peer = await resolve_spec(conn, bot)
                if bot_peer.kind != "bot":
                    raise UsageError(f"{bot} is a {bot_peer.kind}, not a bot")
                dest = await resolve_spec(conn, to, for_write=True) if to else None
                where = dest or (await resolve_spec(conn, peer) if peer else None)
                with telegram_errors():
                    results = await conn.client.inline_query(
                        bot_peer.input, query, entity=where.input if where else None
                    )
                if pick is None:
                    _print_inline(rt, results)
                    return 0
                assert dest is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
                if not 0 <= pick < len(results):
                    raise NotFoundError(f"no result {pick}; the bot returned {len(results)}")
                chosen = results[pick]
                step = Step(
                    "messages.SendInlineBotResult",
                    {"peer": dest, "query_id": results.query_id, "id": chosen.result.id},
                )
                plan = make_plan(rt, "inline-send", dest, [step], yes=yes)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                return await send_plan_and_maybe_wait(
                    rt, conn, dest, plan, wait=None, quiet=0, peer_hint=to or ""
                )

        run(g, body)

    @app.command()
    def start(
        ctx: typer.Context,
        bot: Annotated[str, typer.Argument(help="@bot to start.")],
        payload: Annotated[
            str | None, typer.Argument(help="Deep-link payload (t.me/bot?start=…).")
        ] = None,
        wait: WaitOpt = None,
        quiet: QuietOpt = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Send /start, or messages.StartBot with a deep-link payload."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        budget, q = parse_wait(wait, quiet)

        async def body(rt: Runtime) -> int:
            async with rt.connect(updates=budget is not None) as conn:
                target = await resolve_spec(conn, bot, for_write=True)
                if target.kind != "bot":
                    raise UsageError(f"{bot} is a {target.kind}, not a bot")
                if payload:
                    step = Step(
                        "messages.StartBot", {"bot": target, "peer": target, "start_param": payload}
                    )
                else:
                    step = Step("send_message", {"entity": target, "message": "/start"})
                plan = make_plan(rt, "start", target, [step], yes=yes)
                if not authorize(plan, dry_run=dry_run):
                    return 0
                return await send_plan_and_maybe_wait(
                    rt, conn, target, plan, wait=budget, quiet=q, peer_hint=bot
                )

        run(g, body, extra_budget=budget or 0.0)


def _raw_data(data: str | None, data_hex: str | None) -> bytes | None:
    if data is not None and data_hex is not None:
        raise UsageError("give --data or --data-hex, not both")
    if data is not None:
        return data.encode()
    if data_hex is not None:
        try:
            return bytes.fromhex(data_hex)
        except ValueError:
            raise UsageError(f"--data-hex {data_hex!r} is not valid hex") from None
    return None


async def _find_button(
    conn: Any, target: Any, msg_id: int, text: str | None, row: int | None, col: int | None
) -> Button:
    from tg_kit.convert import convert_buttons

    with telegram_errors():
        msg = await conn.client.get_messages(target.input, ids=msg_id)
    if msg is None:
        raise NotFoundError(f"no message {msg_id} in {target.label()}")
    return select_button(convert_buttons(msg.reply_markup), text=text, row=row, col=col)


def no_press_action(b: Button, *, bot_label: str) -> str | None:
    """What to print instead of pressing, or None when the button is really pressed.

    Refused buttons raise (exit 7): they share personal data, pay, or need 2FA.
    """
    if b.type in _REFUSE:
        raise RefusedError(f"not pressing {format_button(b)}: {_REFUSE[b.type]}")
    if b.requires_password:
        raise RefusedError(
            f"not pressing {format_button(b)}: it asks for the account's 2FA password"
        )
    if b.type in _SHOW_ONLY:
        return f"url: {b.url}"
    if b.type == "switch":
        where = "this chat" if b.same_peer else "pick a chat"
        return f"switch inline: {bot_label} {b.query or ''!r} ({where})"
    if b.type == "copy":
        return f"copy: {b.copy_text}"
    if b.type == "profile":
        return f"profile: user {b.user_id}"
    return None


async def _press(  # noqa: C901 — one branch per case keeps the contract readable in one place
    rt: Runtime,
    conn: Any,
    target: Any,
    msg_id: int,
    b: Button,
    *,
    budget: float,
    quiet: float,
    yes: bool,
    dry_run: bool,
    peer_hint: str,
) -> int:
    shown = no_press_action(b, bot_label=target.label())
    if shown is not None:
        return _show(rt, b, shown)

    if not b.inline:  # reply-keyboard button: the app sends its text as a message
        step = Step("send_message", {"entity": target, "message": b.text})
        plan = make_plan(rt, "press", target, [step], yes=yes)
        if not authorize(plan, dry_run=dry_run):
            return 0
        note(f"pressed {format_button(b)} (sends its text)")
        return await send_plan_and_maybe_wait(
            rt, conn, target, plan, wait=budget, quiet=quiet, peer_hint=peer_hint
        )

    if b.type not in {"cb", "game"}:
        raise UsageError(f"cannot press a {b.type!r} button")
    params: dict[str, object] = {"peer": target, "msg_id": msg_id}
    if b.type == "game":
        params["game"] = True
    else:
        params["data"] = {"$b64": base64.b64encode(b.data or b"").decode()}
    plan = make_plan(rt, "press", target, [Step("messages.GetBotCallbackAnswer", params)], yes=yes)
    if not authorize(plan, dry_run=dry_run):
        return 0
    note(f"pressed {format_button(b)}")

    async def ask() -> Any:
        try:
            return (await asyncio.wait_for(execute_plan(conn, plan), ANSWER_TIMEOUT))[0]
        except TimeoutError:
            note(
                f"warning: no callback answer within {ANSWER_TIMEOUT:g}s; still collecting effects"
            )
        except TgError as exc:
            if not isinstance(exc.__cause__, errors.BotResponseTimeoutError):
                raise
            note(
                "warning: the bot did not answer the callback (BOT_RESPONSE_TIMEOUT); "
                "still collecting effects"
            )
        return None

    answer, replies = await with_wait(conn, target, ask, budget=budget, quiet=quiet)
    answer_doc = _answer(answer)
    if rt.json:
        emit_json(
            {
                "button": b.to_json(),
                "answer": answer_doc,
                "replies": [message_json(v) for v in replies],
            }
        )
    else:
        for key in ("alert", "toast", "url"):
            if answer_doc and answer_doc.get(key):
                out(f"{key}: {answer_doc[key]}")
        print_views(rt, replies, truncate=None, peer_hint=peer_hint)
    if not replies and not (
        answer_doc and (answer_doc.get("toast") or answer_doc.get("alert") or answer_doc.get("url"))
    ):
        raise no_reply(budget)
    return 0


def _answer(answer: Any) -> dict[str, object] | None:
    if answer is None:
        return None
    message = answer.message or None
    return {
        "alert": message if answer.alert else None,
        "toast": None if answer.alert else message,
        "url": answer.url or None,
    }


def _show(rt: Runtime, b: Button, line: str) -> int:
    if rt.json:
        emit_json({"button": b.to_json(), "action": line})
    else:
        out(line)
    return 0


def _print_inline(rt: Runtime, results: Any) -> None:
    rows = []
    for i, r in enumerate(list(results)[:INLINE_MAX]):
        rows.append(
            {
                "index": i,
                "id": r.result.id,
                "type": r.type,
                "title": r.title,
                "description": r.description,
                "url": r.url,
            }
        )
    if rt.json:
        emit_json({"query_id": results.query_id, "results": rows})
        return
    for row in rows:
        desc = f" — {row['description']}" if row["description"] else ""
        title = row["title"] or row["url"] or row["id"]
        out(f'{row["index"]} {row["type"]} "{title}"{desc}')
    if len(results) > INLINE_MAX:
        note(f"note: showing {INLINE_MAX} of {len(results)} results")
