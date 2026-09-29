"""Peer specs: parse (pure) and resolve (network, cache first).

Accepted: me/self · @username · username · t.me/username[/ID] · t.me/c/123/45 ·
numeric user id · -100… channel · -… basic group · +phone (contacts only) ·
title:Some Chat (unique dialog title match; writes need --yes).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from tg_kit.errors import NotFoundError, UsageError

__all__ = [
    "Peer",
    "PeerSpec",
    "message_id_in",
    "parse_message_ref",
    "parse_peer",
    "resolve",
]

_USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,31}$")  # 3+: old bots like @gif are short
_TME = re.compile(
    r"^(?:https?://)?(?:t|telegram)\.me/(?:s/)?(?P<rest>[^?#]+?)/?(?:[?#].*)?$", re.IGNORECASE
)
_PHONE = re.compile(r"^\+[\d\s()-]{6,20}$")
# Channel ids are marked as -(10**12 + id) by Telethon/Bot API.
_CHANNEL_MARK = 10**12

# Dialogs scanned when a numeric id or title is not in the entity cache. Bounds
# the one-off cost (one GetDialogs page is 100) so a miss never walks thousands.
DIALOG_SCAN_LIMIT = 500


@dataclass(frozen=True)
class PeerSpec:
    """What the user typed, parsed. Exactly one of the value fields is set."""

    raw: str
    kind: str  # me | username | id | phone | title
    username: str | None = None
    peer_id: int | None = None  # marked id
    phone: str | None = None
    title: str | None = None
    message_id: int | None = None  # from a t.me/.../45 link


@dataclass(frozen=True)
class Peer:
    """A resolved target. `id` is marked (-100… channels); `input` is the Telethon InputPeer."""

    id: int
    kind: str  # self | user | bot | group | channel | supergroup
    username: str | None
    title: str
    input: Any
    fuzzy: bool = False  # resolved by title match — writes must confirm

    def label(self) -> str:
        """`@name`, or the title, for one-line display."""
        if self.kind == "self":
            return "me"
        return f"@{self.username}" if self.username else self.title

    def target_line(self) -> str:
        """The first stderr line of every write: where it is going."""
        how = ", title match" if self.fuzzy else ""
        return f"→ {self.label()} ({self.kind}, id {self.id}{how})"

    def summary(self) -> dict[str, object]:
        return {"id": self.id, "kind": self.kind, "username": self.username, "title": self.title}


def parse_peer(spec: str) -> PeerSpec:
    raw = spec
    text = spec.strip()
    if not text:
        raise UsageError("empty peer spec", hint=_SPEC_HINT)
    low = text.lower()
    if low in {"me", "self"}:
        return PeerSpec(raw=raw, kind="me")
    if low.startswith("title:"):
        title = text[len("title:") :].strip()
        if not title:
            raise UsageError("title: needs a chat title after the colon")
        return PeerSpec(raw=raw, kind="title", title=title)
    if _PHONE.match(text):
        digits = re.sub(r"\D", "", text)
        return PeerSpec(raw=raw, kind="phone", phone=digits)
    if re.fullmatch(r"-?\d+", text):
        return PeerSpec(raw=raw, kind="id", peer_id=int(text))
    tme = _TME.match(text)
    if tme:
        return _parse_tme(raw, tme.group("rest"))
    name = text.removeprefix("@")
    if _USERNAME.match(name):
        return PeerSpec(raw=raw, kind="username", username=name.lower())
    msg = f"cannot read peer spec {spec!r}"
    raise UsageError(msg, hint=_SPEC_HINT)


_SPEC_HINT = (
    "use me, @username, t.me/username, a numeric id (-100… for channels), "
    "+phone (contacts) or title:Chat Name"
)


def _parse_tme(raw: str, rest: str) -> PeerSpec:
    parts = [p for p in rest.split("/") if p]
    if parts and parts[0] == "c" and len(parts) >= 2 and parts[1].isdigit():  # noqa: PLR2004 — self-explanatory literal
        msg_id = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None  # noqa: PLR2004 — self-explanatory literal
        return PeerSpec(
            raw=raw, kind="id", peer_id=-(_CHANNEL_MARK + int(parts[1])), message_id=msg_id
        )
    if parts and (parts[0].startswith("+") or parts[0] == "joinchat"):
        msg = f"invite links are not supported as peers ({raw!r})"
        raise UsageError(msg, hint="join the chat in Telegram, then use its @username or id")
    if parts and _USERNAME.match(parts[0]):
        msg_id = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        return PeerSpec(raw=raw, kind="username", username=parts[0].lower(), message_id=msg_id)
    msg = f"cannot read t.me link {raw!r}"
    raise UsageError(msg, hint=_SPEC_HINT)


def parse_message_ref(value: str) -> tuple[PeerSpec | None, int]:
    """A message id, or a t.me link carrying one (the link's peer is returned too)."""
    text = value.strip().removeprefix("#")
    if text.isdigit():
        return None, int(text)
    spec = parse_peer(value)
    if spec.message_id is None:
        msg = f"{value!r} is not a message id or a t.me/…/ID link"
        raise UsageError(msg)
    return spec, spec.message_id


def message_id_in(peer: str, ref: str) -> int:
    """A message id for PEER; a t.me link is accepted only if it points into PEER.

    Otherwise `tg delete @a t.me/c/999/45` would act on message 45 of @a.
    """
    link, msg_id = parse_message_ref(ref)
    if link is None:
        return msg_id
    target = parse_peer(peer)
    same = (link.username is not None and link.username == target.username) or (
        link.peer_id is not None and link.peer_id == target.peer_id
    )
    if not same:
        msg = f"{ref!r} points into another chat than {peer!r}"
        raise UsageError(
            msg,
            hint="use a bare message id, with the chat the link points into as PEER",
        )
    return msg_id


async def resolve(  # noqa: C901 — one branch per spec kind
    client: Any, session: Any, spec: PeerSpec, *, self_id: int | None, fresh: bool = False
) -> Peer:
    """Cache first; one bounded network lookup on a miss; never a silent guess."""
    from telethon import (
        errors,
        utils,
    )
    from telethon.tl import functions, types

    if spec.kind == "me":
        return await _self_peer(client, session, self_id)

    if spec.kind == "username":
        assert spec.username is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
        # `fresh` (every write target): a username can move to another account, and
        # a stale cache row would then send the write, allowlisted, somewhere else.
        row = None if fresh else session.find(username=spec.username)
        if row is None or row.kind is None:
            try:
                found = await client(functions.contacts.ResolveUsernameRequest(spec.username))
            except (errors.UsernameNotOccupiedError, errors.UsernameInvalidError) as exc:
                msg = f"no user, bot or chat is called @{spec.username}"
                raise NotFoundError(msg) from exc
            # By the resolved id, not the name: the cached username may differ
            # (collectible usernames) while the peer is the one Telegram named.
            row = session.find(peer_id=utils.get_peer_id(found.peer))
        if row is None:
            msg = f"@{spec.username} resolved but is not accessible (no access hash)"
            raise NotFoundError(msg)
        return _peer_from_row(row, utils, types)

    if spec.kind == "id":
        assert spec.peer_id is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
        row = session.find(peer_id=spec.peer_id)
        if row is None:
            await _scan_dialogs(client)
            row = session.find(peer_id=spec.peer_id)
        if row is None:
            msg = (
                f"id {spec.peer_id} is not in the local cache "
                f"or the latest {DIALOG_SCAN_LIMIT} dialogs"
            )
            raise NotFoundError(
                msg, hint="resolve it by @username first (tg resolve @name), then use the id"
            )
        if self_id is not None and row.id == self_id:
            return await _self_peer(client, session, self_id)
        return _peer_from_row(row, utils, types)

    if spec.kind == "phone":
        assert spec.phone is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
        row = session.find(phone=spec.phone)
        if row is None:
            await client(functions.contacts.GetContactsRequest(hash=0))
            row = session.find(phone=spec.phone)
        if row is None:
            msg = f"+{spec.phone} is not one of your contacts"
            raise NotFoundError(msg, hint="phone targets work for existing contacts only")
        return _peer_from_row(row, utils, types)

    assert spec.title is not None  # noqa: S101 — narrows a type already fixed by the parser for this kind
    return await _by_title(client, spec.title, utils)


async def _self_peer(client: Any, session: Any, self_id: int | None) -> Peer:
    from telethon.tl import types

    if self_id is None:
        me = await client.get_me(input_peer=True)
        self_id = int(me.user_id)
    row = session.find(peer_id=self_id)
    username = row.username if row else None
    return Peer(
        id=self_id,
        kind="self",
        username=username,
        title="Saved Messages",
        input=types.InputPeerSelf(),
    )


def _peer_from_row(row: Any, utils: Any, types: Any) -> Peer:
    real_id, peer_type = utils.resolve_id(row.id)
    if peer_type is types.PeerUser:
        input_peer = types.InputPeerUser(real_id, row.hash)
    elif peer_type is types.PeerChat:
        input_peer = types.InputPeerChat(real_id)
    else:
        input_peer = types.InputPeerChannel(real_id, row.hash)
    return Peer(
        id=row.id,
        kind=row.kind or "unknown",
        username=row.username,
        title=row.name or str(row.id),
        input=input_peer,
    )


async def _scan_dialogs(client: Any) -> list[Any]:
    """One bounded dialogs walk; every entity it returns lands in the cache."""
    return [d async for d in client.iter_dialogs(limit=DIALOG_SCAN_LIMIT)]


async def _by_title(client: Any, title: str, utils: Any) -> Peer:
    from tg_kit.session import entity_kind

    dialogs = await _scan_dialogs(client)
    needle = title.casefold()
    exact = [d for d in dialogs if (d.name or "").casefold() == needle]
    matches = exact or [d for d in dialogs if needle in (d.name or "").casefold()]
    if len(matches) != 1:
        found = "; ".join(f"{d.name} ({d.id})" for d in matches[:10]) or "none"
        msg = f"title {title!r} matches {len(matches)} dialogs: {found}"
        raise NotFoundError(msg, hint="use the @username or the numeric id shown")
    d = matches[0]
    entity = d.entity
    return Peer(
        id=int(d.id),
        kind=entity_kind(entity) or "unknown",
        username=getattr(entity, "username", None),
        title=d.name or str(d.id),
        input=utils.get_input_peer(entity),
        fuzzy=True,
    )
