"""Colour for the human (text) output: a role table, and when colour is on. Pure.

Colour is presentation only. Code names a role, never a colour; a `Style`
turns a role into ANSI SGR, or into nothing at all. `PLAIN` is the identity,
so with colour off every line is byte-for-byte what it was without colour.

The roles and colours are the dialogs pane's (docs/design/dialogs-pane-ux.md
§10.2, `mocha` and 16-colour columns). `text` sets no colour: names stay in
the terminal's own foreground, only bold.

Whether colour is on is decided once per stream at the CLI edge
(`choose_style`), never inside `render`:

    --color never|always > TG_COLOR > FORCE_COLOR > NO_COLOR > TERM=dumb > isatty
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, get_args

from tg_kit.errors import UsageError

__all__ = [
    "PLAIN",
    "ColorMode",
    "Depth",
    "Role",
    "Style",
    "choose_style",
    "color_mode",
    "strip_ansi",
]

Role = Literal[
    "accent",
    "unread",
    "mention",
    "held",
    "ok",
    "person",
    "group",
    "channel",
    "bot",
    "saved",
    "dim",
    "subtext",
    "text",
]
Depth = Literal["none", "16", "truecolor"]
ColorMode = Literal["auto", "always", "never"]

# (truecolor hex, 16-colour SGR foreground). None: the terminal's default.
_Colour = tuple[str, int] | None

_ROLES: dict[Role, _Colour] = {
    "accent": ("#CBA6F7", 35),  # mauve / magenta
    "unread": ("#F38BA8", 31),  # red
    "mention": ("#FAB387", 33),  # peach / yellow
    "held": ("#F9E2AF", 93),  # yellow / bright yellow
    "ok": ("#A6E3A1", 32),  # green
    "person": ("#89B4FA", 34),  # blue
    "group": ("#94E2D5", 36),  # teal / cyan
    "channel": ("#89DCEB", 96),  # sky / bright cyan
    "bot": ("#F5C2E7", 95),  # pink / bright magenta
    "saved": ("#F9E2AF", 93),  # yellow / bright yellow
    "dim": ("#6C7086", 90),  # overlay / gray
    "subtext": ("#A6ADC8", 37),  # subtext / white
    "text": None,
}

# A sender's name colour, by `abs(id) % 7`, in the order of Telegram's own seven
# name colours (red, orange, violet, green, cyan, blue, pink). Red is maroon and
# violet lavender, so a name never reads as an unread count or as `me` (accent).
_NAMES: tuple[tuple[str, int], ...] = (
    ("#EBA0AC", 91),  # maroon / bright red
    ("#FAB387", 33),  # peach / yellow
    ("#B4BEFE", 94),  # lavender / bright blue
    ("#A6E3A1", 32),  # green
    ("#74C7EC", 36),  # sapphire / cyan
    ("#89B4FA", 34),  # blue
    ("#F2CDCD", 95),  # flamingo / bright magenta
)

# A forum topic's `icon_color` (Telegram's six) → the pane's colour (§10.2).
_TOPICS: dict[int, tuple[str, int]] = {
    0x6FB9F0: ("#89B4FA", 34),  # blue
    0xFFD67E: ("#F9E2AF", 93),  # yellow
    0xCB86DB: ("#CBA6F7", 35),  # mauve
    0x8EEE98: ("#A6E3A1", 32),  # green
    0xFF93B2: ("#F5C2E7", 95),  # pink
    0xFB6F5F: ("#EBA0AC", 91),  # maroon, not red: a topic never reads as unread
}

_KINDS: dict[str, Role] = {
    "self": "saved",
    "user": "person",
    "bot": "bot",
    "group": "group",
    "supergroup": "group",
    "channel": "channel",
}

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


@dataclass(frozen=True)
class Style:
    """Paints text by role. `depth="none"` returns every string unchanged."""

    depth: Depth = "none"

    @property
    def on(self) -> bool:
        return self.depth != "none"

    def __call__(self, role: Role, text: str, *, bold: bool = False) -> str:
        return self._paint(_ROLES[role], text, bold=bold)

    def kind(self, kind: str, text: str, *, bold: bool = False) -> str:
        """A chat kind's colour (person, bot, group, channel, saved); unknown → plain."""
        role = _KINDS.get(kind, "text")
        return self(role, text, bold=bold)

    def sender(self, sender_id: int | None, kind: str, text: str) -> str:
        """`me` in accent, a bot in its kind's colour, anyone else by id, like Telegram."""
        if kind == "self":
            return self("accent", text)
        if kind == "bot":
            return self("bot", text)
        if sender_id is None:
            return text
        return self._paint(_NAMES[abs(sender_id) % len(_NAMES)], text)

    def topic(self, icon_color: int | None, text: str, *, bold: bool = False) -> str:
        """A forum topic's title in its icon's colour; another colour → plain."""
        colour = _TOPICS.get(icon_color) if icon_color is not None else None
        return self._paint(colour, text, bold=bold)

    def _paint(self, colour: _Colour, text: str, *, bold: bool = False) -> str:
        if self.depth == "none" or not text or (colour is None and not bold):
            return text
        codes = ["1"] if bold else []
        if colour is not None:
            hexcode, sgr = colour
            if self.depth == "truecolor":
                r, g, b = (int(hexcode[i : i + 2], 16) for i in (1, 3, 5))
                codes.append(f"38;2;{r};{g};{b}")
            else:
                codes.append(str(sgr))
        return f"\x1b[{';'.join(codes)}m{text}\x1b[0m"


PLAIN = Style()


def color_mode(flag: str | None, env: Mapping[str, str]) -> ColorMode:
    """`--color`, else `TG_COLOR`, else auto. Anything else is a usage error."""
    raw = flag if flag is not None else env.get("TG_COLOR", "") or "auto"
    value = raw.strip().lower()
    for mode in get_args(ColorMode):
        if value == mode:
            return mode  # type: ignore[no-any-return]
    source = "--color" if flag is not None else "TG_COLOR"
    raise UsageError(
        f"{source} {raw!r} is not a colour mode", hint="use one of: auto, always, never"
    )


def choose_style(mode: ColorMode, *, isatty: bool, env: Mapping[str, str]) -> Style:
    """The style for one stream (stdout or stderr), given its own isatty.

    `auto`: FORCE_COLOR (not "0"/"false") turns colour on, NO_COLOR
    (no-color.org) or TERM=dumb turn it off, otherwise colour iff a terminal.
    """
    if mode == "never":
        return PLAIN
    if mode == "auto" and not _auto_on(isatty=isatty, env=env):
        return PLAIN
    truecolor = env.get("COLORTERM", "").lower() in {"truecolor", "24bit"}
    return Style("truecolor" if truecolor else "16")


def _auto_on(*, isatty: bool, env: Mapping[str, str]) -> bool:
    force = env.get("FORCE_COLOR", "")
    if force:
        return force.lower() not in {"0", "false"}
    if env.get("NO_COLOR", ""):
        return False
    if env.get("TERM", "") == "dumb":
        return False
    return isatty
