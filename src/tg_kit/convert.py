"""Telethon messages → `MessageView`. The only place Telethon message shapes are read.

Written against Telethon 1.45 / layer 229, where every button is
`Keyboard[Inline]Button(text, type=<ButtonType>)` rather than the older
one-class-per-kind `KeyboardButtonCallback`, `KeyboardButtonUrl`, ….
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from telethon import utils
from telethon.tl import types

from tg_kit.buttons import Button, ButtonGrid
from tg_kit.model import Forward, Media, MessageView, Reaction, Sender
from tg_kit.session import entity_kind

__all__ = ["convert_buttons", "convert_message"]

_INLINE_TYPES: dict[type, str] = {
    types.InlineButtonTypeCallback: "cb",
    types.InlineButtonTypeUrl: "url",
    types.InlineButtonTypeUrlAuth: "login",
    types.InlineButtonTypeWebView: "webapp",
    types.InlineButtonTypeSwitchInline: "switch",
    types.InlineButtonTypeGame: "game",
    types.InlineButtonTypeBuy: "buy",
    types.InlineButtonTypeCopy: "copy",
    types.InlineButtonTypeUserProfile: "profile",
    types.InlineButtonTypeDisabled: "disabled",
}
_REPLY_TYPES: dict[type, str] = {
    types.ButtonTypeDefault: "reply",
    types.ButtonTypeRequestPhone: "phone",
    types.ButtonTypeRequestGeoLocation: "geo",
    types.ButtonTypeRequestPoll: "poll",
    types.ButtonTypeRequestPeer: "peer",
    types.ButtonTypeSimpleWebView: "webapp",
}


def convert_message(msg: Any, *, self_id: int | None, chat_title: str | None = None) -> MessageView:
    service = None
    text = msg.message or ""
    if isinstance(msg, types.MessageService):
        service = _snake(type(msg.action).__name__.removeprefix("MessageAction"))
        text = ""
    # Every edit counts, including `edit_hide` ones (the apps hide the "edited"
    # label when a bot edits its own message): for bot testing that is the point.
    edited = getattr(msg, "edit_date", None)
    reply = getattr(msg, "reply_to", None)
    markup = getattr(msg, "reply_markup", None)
    via = getattr(msg, "via_bot", None)
    return MessageView(
        id=int(msg.id),
        chat_id=int(msg.chat_id),
        date=_utc(msg.date),
        sender=_sender(msg, self_id),
        out=bool(msg.out),
        text=text,
        reply_to=reply.reply_to_msg_id if isinstance(reply, types.MessageReplyHeader) else None,
        forward=_forward(msg),
        edited=_utc(edited) if edited else None,
        pinned=bool(getattr(msg, "pinned", False)),
        media=_media(getattr(msg, "media", None)),
        buttons=convert_buttons(markup),
        keyboard=(
            "inline"
            if isinstance(markup, types.ReplyInlineMarkup)
            else "reply"
            if isinstance(markup, types.ReplyKeyboardMarkup)
            else None
        ),
        reactions=_reactions(getattr(msg, "reactions", None)),
        links=_text_links(msg),
        service=service,
        via_bot=getattr(via, "username", None),
        chat_title=chat_title,
    )


def _utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def _sender(msg: Any, self_id: int | None) -> Sender:
    entity = msg.sender
    sender_id = msg.sender_id
    if msg.out or (self_id is not None and sender_id == self_id):
        username = getattr(entity, "username", None)
        return Sender(id=sender_id, kind="self", username=username, name="me")
    if entity is None:
        return Sender(id=sender_id, kind="unknown", username=None, name=str(sender_id or "?"))
    return Sender(
        id=int(utils.get_peer_id(entity)),
        kind=entity_kind(entity) or "unknown",
        username=getattr(entity, "username", None),
        name=utils.get_display_name(entity) or str(sender_id),
    )


def _forward(msg: Any) -> Forward | None:
    header = getattr(msg, "fwd_from", None)
    if header is None:
        return None
    from_id = utils.get_peer_id(header.from_id) if header.from_id else None
    name = header.from_name
    fwd = getattr(msg, "forward", None)
    if name is None and fwd is not None:
        entity = fwd.sender or fwd.chat
        if entity is not None:
            username = getattr(entity, "username", None)
            name = f"@{username}" if username else utils.get_display_name(entity)
    return Forward(from_id=from_id, from_name=name, date=_utc(header.date) if header.date else None)


def convert_buttons(markup: Any) -> ButtonGrid:
    if isinstance(markup, types.ReplyInlineMarkup):
        return tuple(
            tuple(_inline_button(r, c, b) for c, b in enumerate(row.buttons))
            for r, row in enumerate(markup.rows)
        )
    if isinstance(markup, types.ReplyKeyboardMarkup):
        return tuple(
            tuple(_reply_button(r, c, b) for c, b in enumerate(row.buttons))
            for r, row in enumerate(markup.rows)
        )
    return ()


def _inline_button(r: int, c: int, b: Any) -> Button:
    kind = b.type
    name = _INLINE_TYPES.get(
        type(kind), _snake(type(kind).__name__.removeprefix("InlineButtonType"))
    )
    return Button(
        row=r,
        col=c,
        type=name,
        text=b.text,
        data=getattr(kind, "data", None),
        url=getattr(kind, "url", None),
        query=getattr(kind, "query", None),
        same_peer=bool(getattr(kind, "same_peer", False)),
        user_id=getattr(kind, "user_id", None),
        copy_text=getattr(kind, "copy_text", None),
        requires_password=bool(getattr(kind, "requires_password", False)),
    )


def _reply_button(r: int, c: int, b: Any) -> Button:
    kind = b.type
    name = _REPLY_TYPES.get(type(kind), _snake(type(kind).__name__.removeprefix("ButtonType")))
    return Button(
        row=r, col=c, type=name, text=b.text, url=getattr(kind, "url", None), inline=False
    )


def _media(media: Any) -> Media | None:  # noqa: PLR0911 — one return per kind reads best
    if media is None or isinstance(media, types.MessageMediaEmpty):
        return None
    if isinstance(media, types.MessageMediaPhoto):
        return _photo(media.photo)
    if isinstance(media, types.MessageMediaDocument):
        return _document(media)
    if isinstance(media, types.MessageMediaPoll):
        return Media(type="poll", title=media.poll.question.text)
    if isinstance(media, types.MessageMediaWebPage):
        page = media.webpage
        return Media(
            type="webpage", url=getattr(page, "url", None), title=getattr(page, "title", None)
        )
    if isinstance(
        media, types.MessageMediaGeo | types.MessageMediaGeoLive | types.MessageMediaVenue
    ):
        return Media(type="geo", title=getattr(media, "title", None))
    if isinstance(media, types.MessageMediaContact):
        name = " ".join(p for p in (media.first_name, media.last_name) if p)
        return Media(type="contact", name=name or None)
    if isinstance(media, types.MessageMediaDice):
        return Media(type="dice", emoji=f"{media.emoticon}={media.value}")
    if isinstance(media, types.MessageMediaGame | types.MessageMediaInvoice):
        kind = "game" if isinstance(media, types.MessageMediaGame) else "invoice"
        title = media.game.title if kind == "game" else media.title
        return Media(type=kind, title=title)
    return Media(type=_snake(type(media).__name__.removeprefix("MessageMedia")))


def _photo(photo: Any) -> Media:
    best = None
    for size in getattr(photo, "sizes", None) or []:
        if isinstance(size, types.PhotoSize):
            candidate = (size.w, size.h, size.size)
        elif isinstance(size, types.PhotoSizeProgressive) and size.sizes:
            candidate = (size.w, size.h, max(size.sizes))
        else:
            continue
        if best is None or candidate[0] * candidate[1] > best[0] * best[1]:
            best = candidate
    if best is None:
        return Media(type="photo")
    return Media(type="photo", width=best[0], height=best[1], size=best[2], mime="image/jpeg")


def _document(media: Any) -> Media:  # noqa: PLR0911 — one return per kind reads best
    doc = media.document
    if doc is None:  # expired self-destructing media
        return Media(type="document")
    attrs = {type(a): a for a in doc.attributes}
    name = getattr(attrs.get(types.DocumentAttributeFilename), "file_name", None)
    base = {"size": int(doc.size), "mime": doc.mime_type, "name": name}
    if sticker := attrs.get(types.DocumentAttributeSticker):
        return Media(type="sticker", emoji=sticker.alt or None, **base)
    if audio := attrs.get(types.DocumentAttributeAudio):
        if audio.voice:
            return Media(type="voice", duration=float(audio.duration), **base)
        title = " - ".join(p for p in (audio.performer, audio.title) if p) or None
        return Media(
            type="audio", duration=float(audio.duration), **{**base, "name": name or title}
        )
    if video := attrs.get(types.DocumentAttributeVideo):
        kind = (
            "videonote"
            if video.round_message
            else "gif"
            if types.DocumentAttributeAnimated in attrs
            else "video"
        )
        return Media(
            type=kind, duration=float(video.duration), width=video.w, height=video.h, **base
        )
    if types.DocumentAttributeAnimated in attrs:
        return Media(type="gif", **base)
    return Media(type="document", **base)


def _text_links(msg: Any) -> tuple[tuple[str, str], ...]:
    """Links hidden behind text (MessageEntityTextUrl); plain URLs are already in the text."""
    if not getattr(msg, "entities", None):
        return ()
    # Telethon slices by UTF-16 offsets, as Telegram counts them.
    found = msg.get_entities_text(types.MessageEntityTextUrl)
    return tuple((text, entity.url) for entity, text in found)


def _reactions(reactions: Any) -> tuple[Reaction, ...]:
    if reactions is None:
        return ()
    out = []
    for rc in reactions.results:
        r = rc.reaction
        if isinstance(r, types.ReactionEmoji):
            emoji = r.emoticon
        elif isinstance(r, types.ReactionCustomEmoji):
            emoji = "custom"
        else:
            emoji = "⭐" if type(r).__name__ == "ReactionPaid" else "?"
        out.append(Reaction(emoji=emoji, count=int(rc.count)))
    return tuple(out)


def _snake(name: str) -> str:
    return "".join(f"_{ch.lower()}" if ch.isupper() else ch for ch in name).lstrip("_") or "unknown"
