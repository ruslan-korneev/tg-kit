"""Telegram folders (dialog filters): the spec, membership and order. Pure.

The Telethon boundary (`convert.convert_folder`, `convert.convert_dialog`) builds
a `Folder` from a `DialogFilter*` and a `DialogView` from a dialog; everything
here works on those two.

Membership follows tdlib's `DialogFilter::need_dialog`:

1. pinned or included → in; excluded → out (a shared folder stops here: it is
   its pinned and included chats only);
2. unless the chat has an unread mention: muted → out with `exclude_muted`,
   read → out with `exclude_read`;
3. archived → out with `exclude_archived` (an unread mention does not help);
4. otherwise the chat types: bots, contacts (and Saved Messages), non-contacts,
   groups (basic and supergroups), channels.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from tg_kit.errors import NotFoundError
from tg_kit.model import DialogView

__all__ = [
    "ALL_CHATS",
    "ALL_CHATS_ID",
    "Folder",
    "find_folder",
    "folder_order",
    "in_folder",
    "is_unread",
    "unread_chats",
]

# `DialogFilterDefault` carries no id; 0 is never a real folder's id (they start at 2).
ALL_CHATS_ID = 0


@dataclass(frozen=True)
class Folder:
    id: int
    title: str
    kind: str  # all | folder | shared
    pinned: tuple[int, ...] = ()  # in the folder's order
    include: tuple[int, ...] = ()
    exclude: tuple[int, ...] = ()
    contacts: bool = False
    non_contacts: bool = False
    groups: bool = False
    channels: bool = False
    bots: bool = False
    exclude_muted: bool = False
    exclude_read: bool = False
    exclude_archived: bool = False

    @property
    def by_type(self) -> bool:
        """Whether chats join by type, so the latest chats must be scanned."""
        return self.kind == "folder" and (
            self.contacts or self.non_contacts or self.groups or self.channels or self.bots
        )

    @property
    def listed(self) -> tuple[int, ...]:
        """Chats named in the folder (pinned, then included), fetched by id."""
        return self.pinned + tuple(i for i in self.include if i not in self.pinned)


ALL_CHATS = Folder(id=ALL_CHATS_ID, title="All chats", kind="all")


def is_unread(chat: DialogView) -> bool:
    return chat.unread > 0 or chat.marked_unread


def in_folder(folder: Folder, chat: DialogView) -> bool:  # noqa: PLR0911 — one return per rule, in tdlib's order
    if folder.kind == "all":
        return not chat.archived
    if chat.id in folder.pinned or chat.id in folder.include:
        return True
    if folder.kind == "shared" or chat.id in folder.exclude:
        return False
    if not chat.mentions:
        if folder.exclude_muted and chat.muted:
            return False
        if folder.exclude_read and not is_unread(chat):
            return False
    if folder.exclude_archived and chat.archived:
        return False
    return _type_matches(folder, chat)


def _type_matches(folder: Folder, chat: DialogView) -> bool:
    if chat.kind == "bot":
        return folder.bots
    if chat.kind == "self" or (chat.kind == "user" and chat.contact):
        return folder.contacts
    if chat.kind == "user":
        return folder.non_contacts
    if chat.kind in {"group", "supergroup"}:
        return folder.groups
    if chat.kind == "channel":
        return folder.channels
    return False


_OLDEST = datetime.min.replace(tzinfo=UTC)


def folder_order(folder: Folder, chats: Iterable[DialogView]) -> list[DialogView]:
    """The folder's chats as Telegram lists them: its pinned ones in order, then newest first.

    Rows come back with `pinned` meaning pinned in this folder.
    """
    members = [c for c in chats if in_folder(folder, c)]
    if folder.kind == "all":
        return members  # Telegram's own order: pinned first, then by last message
    rank = {chat_id: i for i, chat_id in enumerate(folder.pinned)}
    pinned = sorted((c for c in members if c.id in rank), key=lambda c: rank[c.id])
    rest = sorted(
        (c for c in members if c.id not in rank),
        key=lambda c: c.last_date or _OLDEST,
        reverse=True,
    )
    return [c.with_pinned(pinned=True) for c in pinned] + [
        c.with_pinned(pinned=False) for c in rest
    ]


def unread_chats(folder: Folder, chats: Iterable[DialogView]) -> int:
    """The folder's badge: unread chats that are not muted (muted ones would bury it)."""
    return sum(1 for c in chats if in_folder(folder, c) and is_unread(c) and not c.muted)


def find_folder(folders: Sequence[Folder], spec: str) -> Folder:
    """A folder by id, then by title: exact, then case-insensitive."""
    wanted = spec.strip()
    if wanted.lstrip("-").isdigit():
        for f in folders:
            if f.id == int(wanted):
                return f
    for fold in (False, True):
        key = wanted.casefold() if fold else wanted
        found = [f for f in folders if (f.title.casefold() if fold else f.title) == key]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            ids = ", ".join(str(f.id) for f in found)
            raise NotFoundError(
                f'folder "{spec}" is ambiguous: ids {ids}', hint="tg dialogs --folder ID"
            )
    have = ", ".join(f"{f.id} {f.title}" for f in folders)
    raise NotFoundError(f'no folder "{spec}"; folders: {have}', hint="tg folders")
