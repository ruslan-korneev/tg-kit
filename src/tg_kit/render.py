"""MessageView → compact lines or JSON. Pure; the output contract lives here.

Compact, one line per message, buttons on indented lines under it:

    #677791 09-29 14:02 @example_bot: Choose a bot ⏎ second line
      [0:0 cb "My bot"] [0:1 cb "Back"]
    #677792 09-29 14:02 me ↩677791: /start
    #677794 09-29 14:05 @example_bot ✎×2: updated text {👍3}
"""

from __future__ import annotations

from datetime import UTC, datetime, tzinfo

from tg_kit.buttons import format_grid
from tg_kit.model import Media, MessageView

__all__ = ["LIST_TRUNCATE", "compact", "message_json", "sender_label"]

# List commands cut text here; `tg msg` and `--full` never do. 300 keeps a
# 20-message listing around 6–8 k characters, far under a tool-output limit.
LIST_TRUNCATE = 300


def sender_label(view: MessageView) -> str:
    s = view.sender
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
        "sender": {
            "id": view.sender.id,
            "kind": view.sender.kind,
            "username": view.sender.username,
            "name": view.sender.name,
        },
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
