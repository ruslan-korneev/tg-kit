"""MessageView → compact lines or JSON. Pure; the output contract lives here.

Compact, one line per message, buttons on indented lines under it:

    #677791 09-29 14:02 @example_bot: Choose a bot ⏎ second line
      [0:0 cb "My bot"] [0:1 cb "Back"]
    #677792 09-29 14:02 me ↩677791: /start
    #677794 09-29 14:05 @example_bot ✎×2: updated text {👍3}

`tg watch` adds typing and delete lines, and one JSON object per line with `--jsonl`:

    ~ 09-29 14:06 @example_bot: typing
    ✗ 09-29 14:07 deleted #677792 #677793

`tg dialogs` prints one line per chat, `tg folders` one line per folder:

    123456 bot @example_bot 📌 [2 unread] — Choose an option
    -1000000000777 channel Example News 🔕 [5 unread, 1 mention] — post text
    2 Work [3 unread]
    5 Team Projects (shared)

`tg folders --chats` ends each folder line with its size: `2 Work [3 unread] · 14 chats`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime, tzinfo

from tg_kit.buttons import format_grid
from tg_kit.folders import Folder, FolderChats
from tg_kit.model import (
    DialogView,
    Media,
    MessageEvent,
    MessageView,
    Sender,
    TypingEvent,
    WatchEvent,
)

__all__ = [
    "LIST_TRUNCATE",
    "compact",
    "dialog_json",
    "dialog_line",
    "event_json",
    "event_lines",
    "folder_json",
    "folder_line",
    "folders_pass_json",
    "message_json",
    "ready_json",
    "sender_label",
]

# List commands cut text here; `tg msg` and `--full` never do. 300 keeps a
# 20-message listing around 6–8 k characters, far under a tool-output limit.
LIST_TRUNCATE = 300


def sender_label(view: MessageView) -> str:
    return _who(view.sender)


def _who(s: Sender) -> str:
    if s.kind == "self":
        return "me"
    if s.username:
        return f"@{s.username}"
    return s.name


def compact(  # noqa: C901, PLR0912 — one branch per case keeps the contract readable in one place
    view: MessageView,
    *,
    now: datetime,
    tz: tzinfo | None = None,
    truncate: int | None = None,
    peer_hint: str | None = None,
) -> list[str]:
    """The message's lines. `peer_hint` names the chat in the "+N chars" pointer."""
    tz = tz or now.tzinfo or UTC
    local = view.date.astimezone(tz)
    stamp = local.strftime("%m-%d %H:%M" if local.year == now.year else "%Y-%m-%d %H:%M")
    head = f"#{view.id} {stamp} "
    if view.chat_title:
        head += f"[{view.chat_title}] "
    head += sender_label(view)
    if view.via_bot:
        head += f" via @{view.via_bot}"
    if view.reply_to:
        head += f" ↩{view.reply_to}"
    if view.forward:
        head += f" ⤳{view.forward.from_name or view.forward.from_id or 'hidden'}"
    if view.edits > 1:
        head += f" ✎×{view.edits}"
    elif view.edits == 1 or view.edited:
        head += " ✎"
    if view.pinned:
        head += " 📌"

    body_parts = []
    if view.service:
        body_parts.append(f"[service {view.service}]")
    tag = _media_tag(view.media)
    if tag:
        body_parts.append(tag)
    text = view.text.replace("\r\n", "\n").replace("\n", " ⏎ ")
    if truncate is not None and len(text) > truncate:
        rest = len(text) - truncate
        where = f"tg msg {peer_hint} {view.id}" if peer_hint else "tg msg"
        text = f"{text[:truncate]}… (+{rest} chars, {where})"
    if text:
        body_parts.append(text)
    if view.reactions:
        body_parts.append("{" + " ".join(f"{r.emoji}{r.count}" for r in view.reactions) + "}")

    lines = [f"{head}: {' '.join(body_parts)}".rstrip()]
    if view.links:
        lines.append("  " + " ".join(f'[link "{text}" → {url}]' for text, url in view.links))
    lines.extend(format_grid(view.buttons))
    return lines


def _media_tag(media: Media | None) -> str | None:  # noqa: PLR0911 — one return per kind reads best
    if media is None or media.type == "webpage":
        return None  # link previews repeat the URL already in the text
    t = media.type
    if t == "photo":
        dims = f" {media.width}×{media.height}" if media.width else ""
        return f"[photo{dims}{_size(media.size)}]"
    if t in {"voice", "audio", "videonote"}:
        name = f" {media.name}" if t == "audio" and media.name else ""
        return f"[{t}{name} {_clock(media.duration)}]"
    if t in {"video", "gif"}:
        dims = f" {media.width}×{media.height}" if media.width else ""
        dur = f" {_clock(media.duration)}" if media.duration else ""
        return f"[{t}{dims}{dur}{_size(media.size)}]"
    if t == "sticker":
        return f"[sticker {media.emoji or ''}]".replace(" ]", "]")
    if t == "document":
        return f"[document {media.name or media.mime or '?'}{_size(media.size)}]"
    if t == "poll":
        return f'[poll "{media.title}"]'
    if t == "dice":
        return f"[dice {media.emoji}]"
    if media.title or media.name:
        return f'[{t} "{media.title or media.name}"]'
    return f"[{t}]"


def _size(n: int | None) -> str:
    if not n:
        return ""
    if n < 1024:  # noqa: PLR2004 — self-explanatory literal
        return f" {n}B"
    if n < 1024 * 1024:
        return f" {n / 1024:.0f}KB"
    return f" {n / 1024 / 1024:.1f}MB"


def _clock(seconds: float | None) -> str:
    total = round(seconds or 0)
    return f"{total // 60}:{total % 60:02d}"


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def message_json(view: MessageView) -> dict[str, object]:
    """The stable per-message JSON schema (documented in README → JSON output)."""
    media = None
    if view.media is not None:
        m = view.media
        media = {
            k: v
            for k, v in {
                "type": m.type,
                "size": m.size,
                "name": m.name,
                "mime": m.mime,
                "duration": m.duration,
                "width": m.width,
                "height": m.height,
                "emoji": m.emoji,
                "title": m.title,
                "url": m.url,
            }.items()
            if v is not None
        }
    return {
        "id": view.id,
        "chat_id": view.chat_id,
        "date": _iso(view.date),
        "sender": _sender_json(view.sender),
        "out": view.out,
        "text": view.text,
        "reply_to": view.reply_to,
        "forward": (
            {
                "from_id": view.forward.from_id,
                "from_name": view.forward.from_name,
                "date": _iso(view.forward.date),
            }
            if view.forward
            else None
        ),
        "edited": _iso(view.edited),
        "edits": view.edits,
        "pinned": view.pinned,
        "service": view.service,
        "via_bot": view.via_bot,
        "media": media,
        "keyboard": view.keyboard,
        "buttons": [[b.to_json() for b in row] for row in view.buttons],
        "reactions": [{"emoji": r.emoji, "count": r.count} for r in view.reactions],
        "links": [{"text": text, "url": url} for text, url in view.links],
        **({"chat_title": view.chat_title} if view.chat_title else {}),
    }


def _sender_json(s: Sender) -> dict[str, object]:
    return {"id": s.id, "kind": s.kind, "username": s.username, "name": s.name}


# --- `tg dialogs`, `tg folders` ------------------------------------------------

DIALOG_PREVIEW = 80


def dialog_json(view: DialogView) -> dict[str, object]:
    """One `tg dialogs --json` row (documented in README → JSON output)."""
    return {
        "id": view.id,
        "kind": view.kind,
        "title": view.title,
        "username": view.username,
        "unread": view.unread,
        "mentions": view.mentions,
        "pinned": view.pinned,
        "muted": view.muted,
        "last_id": view.last_id,
        "last_date": view.last_date.isoformat() if view.last_date else None,
        "last_text": view.last_text,
    }


def dialog_line(view: DialogView) -> str:
    name = f"@{view.username}" if view.username else view.title
    marks = (" 📌" if view.pinned else "") + (" 🔕" if view.muted else "")
    counts = []
    if view.unread:
        counts.append(f"{view.unread} unread")
    if view.mentions:
        counts.append(f"{view.mentions} mention{'s' if view.mentions > 1 else ''}")
    unread = f" [{', '.join(counts)}]" if counts else ""
    preview = view.last_text.replace("\n", " ⏎ ")
    if len(preview) > DIALOG_PREVIEW:
        preview = preview[:DIALOG_PREVIEW] + "…"
    return f"{view.id} {view.kind} {name}{marks}{unread} — {preview}"


def folder_json(folder: Folder, unread: int | None = None) -> dict[str, object]:
    """One `tg folders --json` entry; `unread` only with `--counts`."""
    doc: dict[str, object] = {"id": folder.id, "title": folder.title, "kind": folder.kind}
    if unread is not None:
        doc["unread"] = unread
    return doc


def folder_line(folder: Folder, unread: int | None = None, chats: int | None = None) -> str:
    shared = " (shared)" if folder.kind == "shared" else ""
    count = f" [{unread} unread]" if unread else ""
    members = f" · {chats} chat{'' if chats == 1 else 's'}" if chats is not None else ""
    return f"{folder.id} {folder.title}{shared}{count}{members}"


def folders_pass_json(
    at: datetime, scan: int, entries: Sequence[FolderChats], rows: Sequence[DialogView]
) -> dict[str, object]:
    """The `tg folders --chats --json` document (documented in README → Dialogs and folders)."""
    return {
        "at": at.astimezone(UTC).isoformat(),
        "scan": scan,
        "folders": [
            {
                **folder_json(e.folder, e.unread),
                "pinned": list(e.pinned),
                "chats": list(e.chats),
            }
            for e in entries
        ],
        "dialogs": [dialog_json(r) for r in rows],
    }


# --- `tg watch` ---------------------------------------------------------------


def event_json(event: WatchEvent) -> dict[str, object]:
    """One `tg watch --jsonl` line (documented in README → `tg watch`)."""
    if isinstance(event, MessageEvent):
        return {"event": "edit" if event.edit else "message", **message_json(event.view)}
    if isinstance(event, TypingEvent):
        return {
            "event": "typing",
            "chat_id": event.chat_id,
            "date": _iso(event.date),
            "sender": _sender_json(event.sender),
            "action": event.action,
        }
    return {
        "event": "delete",
        "chat_id": event.chat_id,
        "date": _iso(event.date),
        "ids": list(event.ids),
    }


def ready_json(peers: list[dict[str, object]], date: datetime) -> dict[str, object]:
    """The line `tg watch` prints once it is subscribed and any replay is done."""
    return {"event": "ready", "date": _iso(date), "peers": peers}


def event_lines(
    event: WatchEvent, *, now: datetime, tz: tzinfo | None = None, chat: str | None = None
) -> list[str]:
    """Compact `tg watch` lines. `chat` names the chat when several are watched."""
    if isinstance(event, MessageEvent):
        view = replace(event.view, chat_title=chat) if chat else event.view
        return compact(view, now=now, tz=tz, peer_hint=str(view.chat_id), truncate=LIST_TRUNCATE)
    tz = tz or now.tzinfo or UTC
    local = event.date.astimezone(tz)
    head = local.strftime("%m-%d %H:%M" if local.year == now.year else "%Y-%m-%d %H:%M")
    where = f"[{chat}] " if chat else ""
    if isinstance(event, TypingEvent):
        return [f"~ {head} {where}{_who(event.sender)}: {event.action}"]
    return [f"✗ {head} {where}deleted " + " ".join(f"#{i}" for i in event.ids)]
