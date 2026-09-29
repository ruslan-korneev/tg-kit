"""Read commands: dialogs, read, msg, search, resolve, info, download, drafts, transcribe."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated, Any

import typer
from telethon import utils
from telethon.tl import functions, types

from tg_kit.app import (
    AccountOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    VerboseOpt,
    emit_json,
    globals_from,
    note,
    out,
    run,
)
from tg_kit.client import rpc_error_name, telegram_errors
from tg_kit.common import HARD_MAX, print_views, resolve_spec, self_id, view_of
from tg_kit.errors import NotFoundError, RefusedError, TgError, UsageError
from tg_kit.parsing import parse_since
from tg_kit.peers import message_id_in, parse_peer
from tg_kit.render import LIST_TRUNCATE
from tg_kit.session import entity_kind

__all__ = ["register"]

LimitOpt = Annotated[int, typer.Option("--limit", "-n", help=f"How many (max {HARD_MAX}).")]
FullOpt = Annotated[bool, typer.Option("--full", help="Do not truncate long text.")]

# Search filters by name → Telethon filter class.
FILTERS: dict[str, Any] = {
    "photo": types.InputMessagesFilterPhotos,
    "video": types.InputMessagesFilterVideo,
    "photo_video": types.InputMessagesFilterPhotoVideo,
    "doc": types.InputMessagesFilterDocument,
    "link": types.InputMessagesFilterUrl,
    "voice": types.InputMessagesFilterVoice,
    "music": types.InputMessagesFilterMusic,
    "gif": types.InputMessagesFilterGif,
    "round": types.InputMessagesFilterRoundVideo,
    "geo": types.InputMessagesFilterGeo,
    "contact": types.InputMessagesFilterContacts,
    "pinned": types.InputMessagesFilterPinned,
    "mention": types.InputMessagesFilterMyMentions,
}

# Default download dir and size guard (MB): big enough for voice/photos/short
# videos, small enough that a stray 2 GB file is never pulled by accident.
DOWNLOAD_DIR = Path.home() / "Downloads" / "tg-kit"
DEFAULT_MAX_MB = 200
# Transcription is asynchronous server-side; poll this often, this long.
TRANSCRIBE_POLL = 1.5
TRANSCRIBE_MAX = 30.0


def _limit(n: int) -> int:
    if n < 1:
        raise UsageError("--limit must be at least 1")
    if n > HARD_MAX:
        note(f"note: --limit capped at {HARD_MAX}")
    return min(n, HARD_MAX)


def register(app: typer.Typer) -> None:  # noqa: C901, PLR0915 — one branch per case keeps the contract readable in one place
    @app.command()
    def dialogs(
        ctx: typer.Context,
        limit: LimitOpt = 30,
        unread: Annotated[
            bool, typer.Option("--unread", help="Only chats with unread messages.")
        ] = False,
        query: Annotated[
            str | None, typer.Option("--query", "-q", help="Title/@username contains.")
        ] = None,
        archived: Annotated[bool, typer.Option("--archived", help="The archive folder.")] = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """List chats: id, kind, name, unread count, last message."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        n = _limit(limit)

        async def body(rt: Runtime) -> int:
            filtered = unread or query is not None
            rows = []
            async with rt.connect() as conn:
                with telegram_errors():
                    # Filters apply client-side, so scan further than -n when filtering.
                    async for d in conn.client.iter_dialogs(
                        limit=500 if filtered else n, folder=1 if archived else 0
                    ):
                        entity = d.entity
                        username = getattr(entity, "username", None)
                        if unread and not d.unread_count:
                            continue
                        if (
                            query
                            and query.casefold() not in f"{d.name} {username or ''}".casefold()
                        ):
                            continue
                        last = d.message.message if d.message is not None else ""
                        rows.append(
                            {
                                "id": d.id,
                                "kind": ("self" if d.id == self_id(conn) else entity_kind(entity))
                                or "unknown",
                                "title": d.name,
                                "username": username,
                                "unread": d.unread_count,
                                "last_id": d.message.id if d.message is not None else None,
                                "last_date": d.date.isoformat() if d.date else None,
                                "last_text": last or "",
                            }
                        )
                        if len(rows) >= n:
                            break
            if rt.json:
                emit_json(rows)
                return 0
            for r in rows:
                name = f"@{r['username']}" if r["username"] else r["title"]
                unread_mark = f" [{r['unread']} unread]" if r["unread"] else ""
                preview = str(r["last_text"]).replace("\n", " ⏎ ")
                preview = preview[:80] + "…" if len(preview) > 80 else preview  # noqa: PLR2004 — self-explanatory literal
                out(f"{r['id']} {r['kind']} {name}{unread_mark} — {preview}")
            return 0

        run(g, body)

    @app.command()
    def read(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="me, @username, id, t.me link, title:…")],
        limit: LimitOpt = 20,
        before: Annotated[
            int | None, typer.Option("--before", help="Messages older than this id.")
        ] = None,
        after: Annotated[
            int | None,
            typer.Option(
                "--after", help="Messages newer than this id, oldest first (instead of polling)."
            ),
        ] = None,
        since: Annotated[str | None, typer.Option("--since", help="2h, 3d, or 2026-09-01.")] = None,
        from_peer: Annotated[
            str | None, typer.Option("--from", help="Only from this sender.")
        ] = None,
        reverse: Annotated[bool, typer.Option("--reverse", help="Flip the output order.")] = False,
        full: FullOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Messages in a chat, newest first (with --after: oldest first). Buttons always shown."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        n = _limit(limit)

        async def body(rt: Runtime) -> int:
            since_at = parse_since(since, now=rt.now) if since else None
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer)
                sender = await resolve_spec(conn, from_peer) if from_peer else None
                views = []
                with telegram_errors():
                    async for msg in conn.client.iter_messages(
                        target.input,
                        limit=n if since_at is None or after is not None else HARD_MAX,
                        offset_id=before or 0,
                        min_id=after or 0,
                        reverse=after is not None,
                        from_user=sender.input if sender else None,
                    ):
                        if since_at is not None and msg.date < since_at:
                            if after is None:
                                break  # newest first: everything further is older
                            continue
                        views.append(view_of(conn, msg))
                        if len(views) >= n:
                            break
            if reverse:
                views.reverse()
            print_views(rt, views, truncate=None if full else LIST_TRUNCATE, peer_hint=peer)
            return 0

        run(g, body)

    @app.command()
    def msg(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        ids: Annotated[list[str], typer.Argument(help="Message ids (or t.me/…/ID links).")],
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Full messages by id: never truncated, with buttons, media and reactions."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = [message_id_in(peer, i) for i in ids]

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer)
                with telegram_errors():
                    found = await conn.client.get_messages(target.input, ids=wanted)
                views = [view_of(conn, m) for m in found if m is not None]
            missing = [i for i, m in zip(wanted, found, strict=True) if m is None]
            print_views(rt, views, truncate=None, peer_hint=peer)
            if missing:
                raise NotFoundError(f"no message {', '.join(map(str, missing))} in {peer}")
            return 0

        run(g, body)

    @app.command()
    def search(
        ctx: typer.Context,
        args: Annotated[list[str], typer.Argument(help="PEER QUERY, or just QUERY with --global.")],
        global_: Annotated[bool, typer.Option("--global", help="Search all chats.")] = False,
        limit: LimitOpt = 20,
        from_peer: Annotated[
            str | None, typer.Option("--from", help="Only from this sender.")
        ] = None,
        since: Annotated[str | None, typer.Option("--since", help="2h, 3d, or 2026-09-01.")] = None,
        filter_: Annotated[
            str | None, typer.Option("--filter", help=f"One of: {', '.join(FILTERS)}.")
        ] = None,
        full: FullOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Search one chat, or all chats with --global. Newest first."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        n = _limit(limit)
        if global_ and len(args) != 1:
            raise typer.BadParameter("with --global give only QUERY")
        if not global_ and len(args) != 2:  # noqa: PLR2004 — self-explanatory literal
            raise typer.BadParameter("give PEER QUERY (or --global QUERY)")
        if filter_ is not None and filter_ not in FILTERS:
            raise typer.BadParameter(f"--filter must be one of: {', '.join(FILTERS)}")
        peer_spec, query = (None, args[0]) if global_ else (args[0], args[1])

        async def body(rt: Runtime) -> int:
            since_at = parse_since(since, now=rt.now) if since else None
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer_spec) if peer_spec else None
                sender = await resolve_spec(conn, from_peer) if from_peer else None
                views = []
                with telegram_errors():
                    async for m in conn.client.iter_messages(
                        target.input if target else None,
                        limit=n,
                        search=query,
                        from_user=sender.input if sender else None,
                        filter=FILTERS[filter_] if filter_ else None,
                    ):
                        if since_at is not None and m.date < since_at:
                            break
                        title = utils.get_display_name(m.chat) if global_ and m.chat else None
                        views.append(view_of(conn, m, chat_title=title))
            print_views(rt, views, truncate=None if full else LIST_TRUNCATE, peer_hint=peer_spec)
            return 0

        run(g, body)

    @app.command("resolve")
    def resolve_cmd(
        ctx: typer.Context,
        spec: Annotated[str, typer.Argument(help="me, @username, id, t.me link, +phone, title:…")],
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """What a peer spec resolves to. Use it to verify a target before writing."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            parsed = parse_peer(spec)
            async with rt.connect() as conn:
                p = await resolve_spec(conn, spec)
            doc = {
                **p.summary(),
                "bot": p.kind == "bot",
                "title_match": p.fuzzy,
                "message_id": parsed.message_id,
            }
            if rt.json:
                emit_json(doc)
            else:
                extra = f"  message {parsed.message_id}" if parsed.message_id else ""
                fuzzy = "  (title match)" if p.fuzzy else ""
                handle = f"@{p.username}" if p.username else "-"
                out(f"{p.kind}  id {p.id}  {handle}  {p.title}{extra}{fuzzy}")
            return 0

        run(g, body)

    @app.command()
    def info(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="User, bot, group or channel.")],
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Details: bio/description, members, linked chat, flags."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                p = await resolve_spec(conn, peer)
                with telegram_errors():
                    doc = await _info(conn.client, p)
            if rt.json:
                emit_json(doc)
            else:
                for key, value in doc.items():
                    if value in (None, "", False, []):
                        continue
                    if isinstance(value, list):
                        out(f"{key}:")
                        for item in value:
                            out(f"  {item}")
                    else:
                        out(f"{key}: {str(value).replace(chr(10), ' ⏎ ')}")
            return 0

        run(g, body)

    @app.command()
    def download(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        msg_id: Annotated[str, typer.Argument(metavar="ID", help="Message id or t.me/…/ID link.")],
        out_dir: Annotated[
            Path | None,
            typer.Option("--out", help=f"Directory [default: {DOWNLOAD_DIR}].", show_default=False),
        ] = None,
        max_size: Annotated[
            int, typer.Option("--max-size", help="Refuse files over this many MB.")
        ] = DEFAULT_MAX_MB,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Save a message's media; prints the final path. Never overwrites."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = message_id_in(peer, msg_id)
        directory = (out_dir or DOWNLOAD_DIR).expanduser()

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                p = await resolve_spec(conn, peer)
                with telegram_errors():
                    m = await conn.client.get_messages(p.input, ids=wanted)
                if m is None:
                    raise NotFoundError(f"no message {wanted} in {peer}")
                if m.media is None or m.file is None:
                    raise NotFoundError(f"message {wanted} has no downloadable media")
                size = m.file.size or 0
                if size > max_size * 1024 * 1024:
                    raise RefusedError(
                        f"file is {size / 1024 / 1024:.1f} MB, over --max-size {max_size}",
                        hint=f"rerun with --max-size {size // 1024 // 1024 + 1}",
                    )
                directory.mkdir(parents=True, exist_ok=True)
                name = m.file.name or f"{p.id}_{wanted}{m.file.ext or ''}"
                path = _unique(directory / Path(name).name)
                with telegram_errors():
                    saved = await conn.client.download_media(m, file=str(path))
            if rt.json:
                emit_json({"path": saved, "size": size, "mime": m.file.mime_type})
            else:
                out(str(saved))
            return 0

        run(g, body)

    @app.command()
    def drafts(
        ctx: typer.Context,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Unsent drafts across chats."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            rows = []
            async with rt.connect() as conn:
                with telegram_errors():
                    for d in await conn.client.get_drafts():
                        entity = d.entity
                        rows.append(
                            {
                                "peer_id": utils.get_peer_id(entity) if entity else None,
                                "peer": (
                                    f"@{entity.username}"
                                    if getattr(entity, "username", None)
                                    else utils.get_display_name(entity)
                                )
                                if entity
                                else None,
                                "text": d.text or "",
                                "date": d.date.isoformat() if d.date else None,
                            }
                        )
            if rt.json:
                emit_json(rows)
            else:
                for r in rows:
                    out(f"{r['peer_id']} {r['peer']}: {str(r['text']).replace(chr(10), ' ⏎ ')}")
            return 0

        run(g, body)

    @app.command()
    def transcribe(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="The chat.")],
        msg_id: Annotated[str, typer.Argument(metavar="ID", help="Voice/video-note message id.")],
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Voice → text via Telegram (Premium, or its limited free trial)."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        wanted = message_id_in(peer, msg_id)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                p = await resolve_spec(conn, peer)
                result = await _transcribe(conn.client, p.input, wanted)
            if rt.json:
                emit_json({"text": result.text, "pending": bool(result.pending)})
            else:
                out(result.text)
                if result.pending:
                    note("note: transcription still pending; the text may be partial")
            return 0

        run(g, body)


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(1, 10_000):
        candidate = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise TgError(f"too many files named like {path}")


async def _transcribe(client: Any, input_peer: Any, msg_id: int) -> Any:
    from telethon import errors

    loop = asyncio.get_running_loop()
    deadline = loop.time() + TRANSCRIBE_MAX
    while True:
        try:
            with telegram_errors():
                result = await client(functions.messages.TranscribeAudioRequest(input_peer, msg_id))
        except TgError as exc:
            cause = exc.__cause__
            if isinstance(cause, errors.RPCError) and "PREMIUM" in rpc_error_name(cause):
                raise RefusedError(
                    "transcription needs Telegram Premium (free trial used up)"
                ) from exc
            raise
        if not result.pending or loop.time() > deadline:
            return result
        await asyncio.sleep(TRANSCRIBE_POLL)


async def _info(client: Any, p: Any) -> dict[str, object]:
    base: dict[str, object] = {"id": p.id, "kind": p.kind, "username": p.username, "title": p.title}
    if p.kind in {"self", "user", "bot"}:
        full = await client(functions.users.GetFullUserRequest(utils.get_input_user(p.input)))
        user = full.users[0]
        fu = full.full_user
        bot_info = fu.bot_info
        return {
            **base,
            "name": utils.get_display_name(user),
            "bio": fu.about,
            "bot": bool(user.bot),
            "bot_description": getattr(bot_info, "description", None),
            "bot_commands": [
                f"/{c.command} — {c.description}"
                for c in (getattr(bot_info, "commands", None) or [])
            ],
            "verified": bool(user.verified),
            "premium": bool(user.premium),
            "scam": bool(user.scam),
            "fake": bool(user.fake),
            "contact": bool(user.contact),
            "mutual_contact": bool(user.mutual_contact),
            "blocked": bool(fu.blocked),
            "common_chats": fu.common_chats_count,
        }
    if p.kind in {"channel", "supergroup"}:
        full = await client(
            functions.channels.GetFullChannelRequest(utils.get_input_channel(p.input))
        )
        fc = full.full_chat
        chat = full.chats[0]
        return {
            **base,
            "about": fc.about,
            "members": fc.participants_count,
            "admins": fc.admins_count,
            "online": fc.online_count,
            "linked_chat_id": fc.linked_chat_id,
            "slowmode_seconds": fc.slowmode_seconds,
            "verified": bool(chat.verified),
            "scam": bool(chat.scam),
            "forum": bool(getattr(chat, "forum", False)),
        }
    full = await client(functions.messages.GetFullChatRequest(abs(p.id)))
    fc = full.full_chat
    members = getattr(fc.participants, "participants", None)
    return {**base, "about": fc.about, "members": len(members) if members is not None else None}
