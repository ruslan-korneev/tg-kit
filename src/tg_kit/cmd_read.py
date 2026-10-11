"""Read commands: dialogs, folders, topics, read, msg, search, resolve, info, download,
drafts, transcribe."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

import typer
from telethon import errors, utils
from telethon.client.dialogs import _dialog_message_key
from telethon.tl import custom, functions, types

from tg_kit.app import (
    AccountOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    TopicOpt,
    VerboseOpt,
    emit_json,
    globals_from,
    note,
    out,
    run,
)
from tg_kit.client import Connected, rpc_error_name, telegram_errors
from tg_kit.common import HARD_MAX, print_views, resolve_spec, resolve_topic_id, self_id, view_of
from tg_kit.convert import MUTE_SCOPES, convert_dialog, convert_folder, folder_input_peers
from tg_kit.errors import NotFoundError, RefusedError, TgError, UsageError
from tg_kit.folders import (
    ALL_CHATS,
    Folder,
    FolderChats,
    find_folder,
    folder_order,
    folder_pass,
)
from tg_kit.model import GENERAL_TOPIC, DialogView
from tg_kit.parsing import parse_since
from tg_kit.peers import list_topics, message_id_in, parse_peer
from tg_kit.render import (
    LIST_TRUNCATE,
    dialog_json,
    dialog_line,
    folder_json,
    folder_line,
    folders_pass_json,
    topic_json,
    topic_line,
)

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

# How many of the latest chats a filtered listing, a type-built folder or
# `folders --counts` looks at: the same 500 as the peer-cache fallback.
SCAN = 500
# Peers per messages.getPeerDialogs call; a folder lists at most 100 + pinned.
PEER_DIALOGS_CHUNK = 100
# How long a chat getPeerDialogs refused is skipped. Finding one again costs about
# log2(100) * 2 calls and ~300 peers of a ~180-per-30-s budget. A chat left or
# banned from rarely comes back; one that does is in the latest-chats scan anyway,
# and a hand-picked folder shows it again within this time.
REFUSED_FOR = timedelta(hours=6)

# How far back `tg read --topic 1` looks for General's messages. Telegram keeps
# no separate list of them (they carry no topic), so they are picked out of the
# forum's whole history: 1000 messages is 10 history pages, a bounded cost.
GENERAL_SCAN = 1000

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
        folder: Annotated[
            str | None,
            typer.Option("--folder", "-f", help="A Telegram folder by id or title (tg folders)."),
        ] = None,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """List chats: id, kind, name, unread count, mentions, pinned, muted, last message."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        n = _limit(limit)
        if folder is not None and archived:
            raise UsageError("--folder and --archived: pass one (the archive is not a folder)")

        def wanted(r: DialogView) -> bool:
            if unread and not r.unread:
                return False
            return not (
                query and query.casefold() not in f"{r.title} {r.username or ''}".casefold()
            )

        async def body(rt: Runtime) -> int:
            filtered = unread or query is not None
            async with rt.connect() as conn:
                with telegram_errors():
                    defaults = await _mute_defaults(conn.client)
                    chosen, inputs = (
                        _pick(await _folders(conn), folder) if folder is not None else (None, {})
                    )
                    if chosen is None or chosen.kind == "all":
                        # Filters apply client-side, so scan further than -n when filtering.
                        rows = await _latest(
                            conn,
                            defaults,
                            rt.now,
                            n=n,
                            scan=SCAN if filtered else n,
                            folder=1 if archived else 0,
                            keep=wanted,
                        )
                    else:
                        chats = await _folder_chats(conn, chosen, inputs, defaults, rt.now)
                        rows = [r for r in chats if wanted(r)][:n]
            if rt.json:
                emit_json([dialog_json(r) for r in rows])
            else:
                for r in rows:
                    out(dialog_line(r, rt.style), color=rt.style.on)
            return 0

        run(g, body)

    @app.command()
    def folders(
        ctx: typer.Context,
        counts: Annotated[
            bool,
            typer.Option("--counts", help="Add each folder's unread chats that are not muted."),
        ] = False,
        chats: Annotated[
            bool,
            typer.Option(
                "--chats",
                help="Every folder's chats and their rows in one pass (implies --counts).",
            ),
        ] = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Telegram folders in Telegram's order: id, title, kind (all | folder | shared)."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                with telegram_errors():
                    found, entries, rows = await _folders_pass(
                        conn, rt.now, counted=counts or chats
                    )
            if chats:
                if rt.json:
                    emit_json(folders_pass_json(rt.now, SCAN, entries, rows))
                else:
                    for e in entries:
                        out(
                            folder_line(e.folder, e.unread, len(e.chats), rt.style),
                            color=rt.style.on,
                        )
                return 0
            unread = {e.folder.id: e.unread for e in entries}
            if rt.json:
                emit_json([folder_json(f, unread.get(f.id)) for f in found])
            else:
                for f in found:
                    out(folder_line(f, unread.get(f.id), style=rt.style), color=rt.style.on)
            return 0

        run(g, body)

    @app.command()
    def topics(
        ctx: typer.Context,
        peer: Annotated[str, typer.Argument(help="A forum: @username, id, t.me link, title:…")],
        limit: LimitOpt = 30,
        query: Annotated[
            str | None, typer.Option("--query", "-q", help="Title contains (Telegram's search).")
        ] = None,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """A forum's topics: id, title, unread, mentions, pinned, closed, last message."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        n = _limit(limit)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                target = await resolve_spec(conn, peer)
                with telegram_errors():
                    rows = await list_topics(conn.client, target, limit=n, query=query)
            if rt.json:
                emit_json([topic_json(r) for r in rows])
            else:
                for r in rows:
                    out(topic_line(r, rt.style), color=rt.style.on)
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
        topic: TopicOpt = None,
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
                await resolve_topic_id(conn, target, topic)
                # A topic's messages are the replies to its first message; General's
                # carry no topic, so they are picked out of the whole history.
                general = topic == GENERAL_TOPIC
                fetch = n if since_at is None or after is not None else HARD_MAX
                views = []
                scanned, last_seen = 0, 0
                with telegram_errors():
                    async for msg in conn.client.iter_messages(
                        target.input,
                        limit=GENERAL_SCAN if general else fetch,
                        offset_id=before or 0,
                        min_id=after or 0,
                        reverse=after is not None,
                        from_user=sender.input if sender else None,
                        reply_to=None if topic is None or general else topic,
                    ):
                        scanned, last_seen = scanned + 1, msg.id
                        if since_at is not None and msg.date < since_at:
                            if after is None:
                                break  # newest first: everything further is older
                            continue
                        view = view_of(conn, msg, forum=True if topic is not None else None)
                        if general and view.topic_id != GENERAL_TOPIC:
                            continue
                        views.append(view)
                        if len(views) >= n:
                            break
                if general and scanned >= GENERAL_SCAN and len(views) < n:
                    more = f"--after {last_seen}" if after is not None else f"--before {last_seen}"
                    note(
                        f"note: General's messages are picked out of the forum's history; "
                        f"looked at {GENERAL_SCAN} messages, for the next ones: {more}"
                    )
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
                st = rt.style
                for key, value in doc.items():
                    if value in (None, "", False, []):
                        continue
                    if isinstance(value, list):
                        out(st("dim", f"{key}:"), color=st.on)
                        for item in value:
                            out(f"  {item}", color=st.on)
                    else:
                        text = str(value).replace(chr(10), " ⏎ ")
                        out(f"{st('dim', f'{key}:')} {text}", color=st.on)
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


# --- dialogs and folders -------------------------------------------------------

FolderWithPeers = tuple[Folder, dict[int, Any]]

_SCOPE_INPUTS: dict[str, Any] = {
    "users": types.InputNotifyUsers,
    "chats": types.InputNotifyChats,
    "broadcasts": types.InputNotifyBroadcasts,
}


async def _folders(conn: Connected) -> list[FolderWithPeers]:
    result = await conn.client(functions.messages.GetDialogFiltersRequest())
    return _folders_of(result.filters, self_id=self_id(conn))


def _folders_of(filters: list[Any], *, self_id: int | None) -> list[FolderWithPeers]:
    """The server's order. No dialogFilterDefault in the list means All chats is first
    (tdlib reads a missing one as position 0)."""
    found = [
        (convert_folder(f, self_id=self_id), folder_input_peers(f, self_id=self_id))
        for f in filters
    ]
    if not any(f.kind == "all" for f, _ in found):
        found.insert(0, (ALL_CHATS, {}))
    return found


def _pick(found: list[FolderWithPeers], spec: str) -> FolderWithPeers:
    folder = find_folder([f for f, _ in found], spec)
    return next(pair for pair in found if pair[0] is folder)


async def _latest(
    conn: Connected,
    defaults: dict[str, datetime | None],
    now: datetime,
    *,
    n: int,
    scan: int,
    folder: int,
    keep: Callable[[DialogView], bool],
) -> list[DialogView]:
    """The first `n` of the latest `scan` chats that `keep` accepts, in Telegram's order."""
    rows: list[DialogView] = []
    async for r in _scan(conn, defaults, now, limit=scan, folder=folder):
        if keep(r):
            rows.append(r)
        if len(rows) >= n:
            break
    return rows


async def _folder_chats(
    conn: Connected,
    folder: Folder,
    inputs: dict[int, Any],
    defaults: dict[str, datetime | None],
    now: datetime,
) -> list[DialogView]:
    """A folder's chats in its order: the listed ones by id, plus the latest chats by type."""
    if folder.by_type:
        scan_folder = 0 if folder.exclude_archived else None
        scanned, listed = await _scan_then_listed(conn, inputs, defaults, now, folder=scan_folder)
        chats = [*scanned, *listed]
    else:
        chats = await _peer_dialogs(conn, inputs, defaults, now)
    return folder_order(folder, chats)


async def _scan_then_listed(
    conn: Connected,
    inputs: dict[int, Any],
    defaults: dict[str, datetime | None],
    now: datetime,
    *,
    folder: int | None,
) -> tuple[list[DialogView], list[DialogView]]:
    """The latest chats, and the listed ones the scan did not reach.

    getPeerDialogs is rate-limited by peers: on a real account ~180 peers in 30 s
    went through, the next call got FLOOD_WAIT 29. So listed chats the scan already
    has are not fetched again.
    """
    scanned = [r async for r in _scan(conn, defaults, now, limit=SCAN, folder=folder)]
    seen = {r.id for r in scanned}
    missing = {i: p for i, p in inputs.items() if i not in seen}
    return scanned, await _peer_dialogs(conn, missing, defaults, now)


async def _folders_pass(
    conn: Connected, now: datetime, *, counted: bool
) -> tuple[list[Folder], list[FolderChats], list[DialogView]]:
    """`tg folders`: the list, and with `counted` one pass over the latest chats (main
    list and archive) plus the chats folders list, from which every folder is built."""
    found = await _folders(conn)
    folders = [f for f, _ in found]
    if not counted:
        return folders, [], []
    defaults = await _mute_defaults(conn.client)
    inputs = {i: p for _, ps in found for i, p in ps.items()}
    scanned, listed = await _scan_then_listed(conn, inputs, defaults, now, folder=None)
    entries, rows = folder_pass(folders, scanned, listed)
    return folders, entries, rows


async def _mute_defaults(client: Any) -> dict[str, datetime | None]:
    """The account's mute per kind of chat, for chats that follow the default.

    A scope Telegram does not answer counts as not muted, with a note: `muted` is
    enrichment, and a listing must not fail for it.
    """
    settings = await asyncio.gather(
        *(
            client(functions.account.GetNotifySettingsRequest(_SCOPE_INPUTS[scope]()))
            for scope in MUTE_SCOPES
        ),
        return_exceptions=True,
    )
    defaults: dict[str, datetime | None] = {}
    for scope, s in zip(MUTE_SCOPES, settings, strict=True):
        if isinstance(s, errors.RPCError):
            note(f"note: no default mute for {scope} ({rpc_error_name(s)}); counted as not muted")
            defaults[scope] = None
        elif isinstance(s, BaseException):
            raise s
        else:
            defaults[scope] = getattr(s, "mute_until", None)
    return defaults


async def _scan(
    conn: Connected,
    defaults: dict[str, datetime | None],
    now: datetime,
    *,
    limit: int,
    folder: int | None,
) -> AsyncIterator[DialogView]:
    """The latest `limit` chats of the main list (`folder` 0), the archive (1), or each (None).

    None is two scans, because getDialogs without a folder id returns the main list
    only (measured: 500 chats, none archived). The archive scan keeps only dialogs
    marked folder_id 1: with an empty archive, getDialogs(folder_id=1) returns the
    main list's pinned chats (measured: 3 dialogs, folder_id unset, all pinned). So
    it reads on, lazily, until it has `limit` archived chats or the archive ends.
    """
    me = self_id(conn)
    for one in (0, 1) if folder is None else (folder,):
        kept = 0
        async for d in conn.client.iter_dialogs(limit=None if one == 1 else limit, folder=one):
            if one == 1 and d.folder_id != 1:
                continue
            yield convert_dialog(d, self_id=me, mute_defaults=defaults, now=now)
            kept += 1
            if kept >= limit:
                break


async def _peer_dialogs(
    conn: Connected,
    peers: dict[int, Any],
    defaults: dict[str, datetime | None],
    now: datetime,
) -> list[DialogView]:
    """Chats by InputPeer, however old (messages.getPeerDialogs). Ones Telegram refuses
    (left, banned, deleted) are skipped, as the apps skip them in a folder, and are
    remembered for `REFUSED_FOR` so the next run does not pay to find them again."""
    me = self_id(conn)
    stamp = now.timestamp()
    skip = conn.session.refused_peers(stamp)
    wanted = [(i, p) for i, p in peers.items() if i not in skip]
    rows: list[DialogView] = []
    refused: list[int] = []
    for start in range(0, len(wanted), PEER_DIALOGS_CHUNK):
        chunk = wanted[start : start + PEER_DIALOGS_CHUNK]
        found = await _fetch_peer_dialogs(conn.client, chunk, refused)
        rows.extend(convert_dialog(d, self_id=me, mute_defaults=defaults, now=now) for d in found)
    if refused:
        conn.session.remember_refused(refused, now=stamp, until=stamp + REFUSED_FOR.total_seconds())
    return rows


async def _fetch_peer_dialogs(
    client: Any, peers: list[tuple[int, Any]], refused: list[int]
) -> list[Any]:
    """`peers` as (id, InputPeer); the ids of chats Telegram refuses go to `refused`."""
    if not peers:
        return []
    try:
        r = await client(
            functions.messages.GetPeerDialogsRequest([types.InputDialogPeer(p) for _, p in peers])
        )
    except (errors.BadRequestError, errors.ForbiddenError):
        # One inaccessible chat fails the whole call: halve until it is alone, then drop it.
        if len(peers) == 1:
            refused.append(peers[0][0])
            return []
        mid = len(peers) // 2
        return [
            *await _fetch_peer_dialogs(client, peers[:mid], refused),
            *await _fetch_peer_dialogs(client, peers[mid:], refused),
        ]
    # As Telethon's iter_dialogs builds its custom.Dialog objects.
    entities = {
        utils.get_peer_id(x): x
        for x in [*r.users, *r.chats]
        if not isinstance(x, types.UserEmpty | types.ChatEmpty)
    }
    messages = {}
    for m in r.messages:
        m._finish_init(client, entities, None)  # noqa: SLF001 — what iter_dialogs does
        messages[_dialog_message_key(m.peer_id, m.id)] = m
    return [
        custom.Dialog(client, d, entities, messages.get(_dialog_message_key(d.peer, d.top_message)))
        for d in r.dialogs
        if utils.get_peer_id(d.peer) in entities
    ]


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(1, 10_000):
        candidate = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise TgError(f"too many files named like {path}")


async def _transcribe(client: Any, input_peer: Any, msg_id: int) -> Any:
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
