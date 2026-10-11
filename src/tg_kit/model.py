"""Message DTOs: what `convert` produces from Telethon and `render` prints. Pure."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime

from tg_kit.buttons import ButtonGrid

# Every forum has a "General" topic with this id. Its messages carry no topic
# in their reply header: they are General because the chat is a forum.
GENERAL_TOPIC = 1

__all__ = [
    "GENERAL_TOPIC",
    "DeleteEvent",
    "DialogView",
    "Forward",
    "Media",
    "MessageEvent",
    "MessageView",
    "Reaction",
    "Sender",
    "TopicView",
    "TypingEvent",
    "WatchEvent",
    "with_edits",
]


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
    topic_id: int | None = None  # forum topic; GENERAL_TOPIC for General, None outside forums
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


@dataclass(frozen=True)
class DialogView:
    """One chat in `tg dialogs`, and the facts folder membership needs."""

    id: int
    kind: str  # self | user | bot | group | supergroup | channel | unknown
    title: str
    username: str | None
    unread: int = 0
    mentions: int = 0  # unread mentions of me
    pinned: bool = False  # in the list shown: the main list, the archive, or the folder
    muted: bool = False
    last_id: int | None = None
    last_date: datetime | None = None
    last_text: str = ""
    contact: bool = False  # a user in my contacts
    marked_unread: bool = False  # "mark as unread": unread with no unread count
    archived: bool = False
    forum: bool = False  # a supergroup with topics (tg topics)

    def with_pinned(self, *, pinned: bool) -> DialogView:
        return replace(self, pinned=pinned)


@dataclass(frozen=True)
class TopicView:
    """One forum topic in `tg topics`, and what a write into it checks."""

    id: int
    title: str
    icon_color: int | None = None  # RGB as an int, Telegram's palette
    unread: int = 0
    mentions: int = 0  # unread mentions of me
    pinned: bool = False
    closed: bool = False  # nobody but admins may post
    hidden: bool = False  # only General can be hidden
    last_id: int | None = None
    last_date: datetime | None = None
    last_text: str = ""


# --- `tg watch` events ------------------------------------------------------


@dataclass(frozen=True)
class MessageEvent:
    """A new message (`edit=False`) or a new state of an edited one (`edit=True`)."""

    view: MessageView
    edit: bool = False


@dataclass(frozen=True)
class TypingEvent:
    """Someone in a chat is typing, recording, uploading…, or stopped (`cancel`)."""

    chat_id: int
    sender: Sender
    action: str  # typing | cancel | record_audio | upload_photo | … (snake_case TL name)
    date: datetime  # when tg received it (typing updates carry no date)
    top_msg_id: int | None = None  # Telegram's forum topic; None in General and outside forums


@dataclass(frozen=True)
class DeleteEvent:
    """Messages deleted. `chat_id` None: Telegram did not say where (private chats, groups)."""

    chat_id: int | None
    ids: tuple[int, ...]
    date: datetime  # when tg received it


WatchEvent = MessageEvent | TypingEvent | DeleteEvent
