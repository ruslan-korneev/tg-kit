"""Reply-markup buttons as a grid, and picking one to press. Pure — no Telethon.

Every markup is rows × columns with 0-based `r:c` indices. Selection never
guesses: an ambiguous or unmatched label is an error listing every button.
"""

from __future__ import annotations

import base64
import re
import unicodedata
from dataclasses import dataclass

from tg_kit.errors import NotFoundError, UsageError

__all__ = [
    "Button",
    "ButtonGrid",
    "format_button",
    "format_grid",
    "select_button",
]

# Button `type` is a plain str, not an Enum: Telegram keeps adding button kinds
# and an unknown one must still render (as its TL name) rather than crash.
# Known values:
#   inline: cb url login webapp switch game buy copy profile disabled
#   reply keyboard: reply phone geo poll peer webapp


@dataclass(frozen=True)
class Button:
    row: int
    col: int
    type: str
    text: str
    data: bytes | None = None  # callback payload
    url: str | None = None
    query: str | None = None  # switch-inline query
    same_peer: bool = False  # switch-inline in the current chat
    user_id: int | None = None  # profile button
    copy_text: str | None = None
    requires_password: bool = False
    inline: bool = True  # False for reply-keyboard buttons

    @property
    def index(self) -> str:
        return f"{self.row}:{self.col}"

    def to_json(self) -> dict[str, object]:
        doc: dict[str, object] = {
            "row": self.row,
            "col": self.col,
            "type": self.type,
            "text": self.text,
        }
        if self.data is not None:
            doc["data_b64"] = base64.b64encode(self.data).decode()
        for key in ("url", "query", "user_id", "copy_text"):
            value = getattr(self, key)
            if value is not None:
                doc[key] = value
        if self.type == "switch":
            doc["same_peer"] = self.same_peer
        if self.requires_password:
            doc["requires_password"] = True
        return doc


ButtonGrid = tuple[tuple[Button, ...], ...]


def format_button(b: Button) -> str:
    label = f'[{b.index} {b.type} "{b.text}"'
    if b.url:
        label += f" → {b.url}"
    elif b.type == "switch":
        label += f" → {'here' if b.same_peer else 'pick chat'}: {b.query or ''!r}"
    elif b.copy_text is not None:
        label += f" → {b.copy_text!r}"
    elif b.user_id is not None:
        label += f" → user {b.user_id}"
    if b.requires_password:
        label += " 🔒"
    return label + "]"


def format_grid(grid: ButtonGrid, indent: str = "  ") -> list[str]:
    return [indent + " ".join(format_button(b) for b in row) for row in grid if row]


def select_button(  # noqa: C901 — one branch per case keeps the contract readable in one place
    grid: ButtonGrid, *, text: str | None = None, row: int | None = None, col: int | None = None
) -> Button:
    """By label (exact → case-insensitive → ignoring emoji/space/punctuation) or by index."""
    flat = [b for r in grid for b in r]
    if not flat:
        raise NotFoundError("the message has no buttons")
    if row is not None or col is not None:
        if row is None or col is None or text is not None:
            raise UsageError("pick a button by label, or by --row and --col together")
        for b in flat:
            if (b.row, b.col) == (row, col):
                return b
        raise NotFoundError(f"no button at {row}:{col}", hint=_listing(grid))
    if text is None:
        raise UsageError("name a button: its label, --row/--col, --data or --data-hex")

    for key in (lambda s: s, str.casefold, _loose):
        wanted = key(text)
        if not wanted:
            continue
        hits = [b for b in flat if key(b.text) == wanted]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            where = ", ".join(b.index for b in hits)
            msg = f"button label {text!r} is ambiguous ({where})"
            raise NotFoundError(msg, hint="pick one with --row R --col C:\n" + _listing(grid))
    msg = f"no button labelled {text!r}"
    raise NotFoundError(msg, hint="buttons on that message:\n" + _listing(grid))


def _listing(grid: ButtonGrid) -> str:
    return "\n".join(format_grid(grid, indent="    "))


_NOT_WORD = re.compile(r"[\W_]+", re.UNICODE)


def _loose(s: str) -> str:
    """Casefold and keep only letters/digits: '🤖 My Bot »' ≈ 'my bot'."""
    kept = "".join(ch for ch in s if not unicodedata.category(ch).startswith(("S", "C", "M")))
    return _NOT_WORD.sub("", kept.casefold())
