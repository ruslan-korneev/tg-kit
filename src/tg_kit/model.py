"""Message DTOs: what `convert` produces from Telethon and `render` prints. Pure."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime

from tg_kit.buttons import ButtonGrid

__all__ = ["Forward", "Media", "MessageView", "Reaction", "Sender", "with_edits"]


@dataclass(frozen=True)
class Sender:
    id: int | None
    kind: str  # self | user | bot | group | channel | supergroup | unknown
    username: str | None
    name: str


@dataclass(frozen=True)
class Media:
    # plain str: photo video gif videonote voice audio sticker document poll geo
    # contact dice game invoice story webpage, or a lowercased TL name for new kinds
    type: str
    size: int | None = None
    name: str | None = None
    mime: str | None = None
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    emoji: str | None = None  # sticker alt / dice
    title: str | None = None  # poll question, webpage/game/invoice title
    url: str | None = None  # webpage


@dataclass(frozen=True)
class Forward:
    from_id: int | None
    from_name: str | None
    date: datetime | None


@dataclass(frozen=True)
class Reaction:
    emoji: str
    count: int


@dataclass(frozen=True)
class MessageView:
    id: int
    chat_id: int
    date: datetime  # aware UTC
    sender: Sender
    out: bool
    text: str
    reply_to: int | None = None
    forward: Forward | None = None
    edited: datetime | None = None
    pinned: bool = False
    media: Media | None = None
    buttons: ButtonGrid = ()
    keyboard: str | None = None  # inline | reply | None
    reactions: tuple[Reaction, ...] = field(default_factory=tuple)
    links: tuple[tuple[str, str], ...] = ()  # (text, url) of links hidden behind text
    service: str | None = None  # service-message action, e.g. "pin_message"
    via_bot: str | None = None
    chat_title: str | None = None  # set when listing across chats (global search)
    edits: int = 0  # edits seen while waiting (✎×N); 0 when not waiting


def with_edits(view: MessageView, edits: int) -> MessageView:
    return replace(view, edits=edits)
