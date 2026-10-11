"""Colour for the human (text) output: a role table, and when colour is on. Pure.

Colour is presentation only. Code names a role, never a colour; a `Style`
turns a role into ANSI SGR, or into nothing at all. `PLAIN` is the identity,
so with colour off every line is byte-for-byte what it was without colour.

The roles are the dialogs pane's (docs/design/dialogs-pane-ux.md §10.2). The
truecolor values come from a named theme in the packaged `themes.json` (a copy
of palettes/themes.json); the 16-colour fallback is one table here, the same
for every theme. `text` sets no colour: names stay in the terminal's own
foreground, only bold.

Whether colour is on is decided once per stream at the CLI edge
(`choose_style`), never inside `render`:

    --color never|always > TG_COLOR > FORCE_COLOR > NO_COLOR > TERM=dumb > isatty

and the theme by `--theme` > `TG_THEME` > config.toml `theme` > DEFAULT_THEME
(`theme_name`).
"""

from __future__ import annotations

import functools
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any, Literal, get_args

from tg_kit.errors import UsageError

__all__ = [
    "DEFAULT_THEME",
    "FILE_ROLES",
    "PLAIN",
    "ROLES",
    "Appearance",
    "ColorMode",
    "Depth",
    "Role",
    "Style",
    "Theme",
    "choose_style",
    "color_mode",
    "rgb",
    "strip_ansi",
    "theme_name",
    "themes",
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
Appearance = Literal["dark", "light"]

ROLES: tuple[Role, ...] = get_args(Role)

# The theme when neither --theme, TG_THEME nor config.toml names one: the owner's pick
# (2026-10-11, from `tg themes`).
DEFAULT_THEME = "tokyo-night"

# The 16-colour fallback (no COLORTERM=truecolor) is one table for every theme:
# SGR foregrounds, by role. None: the terminal's default.
_SGR16: dict[Role, int | None] = {
    "accent": 35,  # magenta
    "unread": 31,  # red
    "mention": 33,  # yellow
    "held": 93,  # bright yellow
    "ok": 32,  # green
    "person": 34,  # blue
    "group": 36,  # cyan
    "channel": 96,  # bright cyan
    "bot": 95,  # bright magenta
    "saved": 93,  # bright yellow
    "dim": 90,  # gray
    "subtext": 37,  # white
    "text": None,
}

# A sender's name colour, by `abs(id) % 7`, in the order of Telegram's own seven
# name colours (red, orange, violet, green, cyan, blue, pink). Here red is bright
# red and violet bright blue, so a name never reads as an unread count (31) or as
# `me` (accent, 35). In truecolor the theme's `senders` decide.
_NAMES16: tuple[int, ...] = (91, 33, 94, 32, 36, 34, 95)

# A forum topic's `icon_color` (Telegram's six) → its 16-colour SGR. A theme maps
# the same six keys to its own colours (§10.2).
_TOPICS16: dict[int, int] = {
    0x6FB9F0: 34,  # blue
    0xFFD67E: 93,  # yellow
    0xCB86DB: 35,  # mauve
    0x8EEE98: 32,  # green
    0xFF93B2: 95,  # pink
    0xFB6F5F: 91,  # maroon, not red: a topic never reads as unread
}

# Every role a theme in themes.json colours: the CLI's roles, plus the pane's
# `surface` (its borders), which the CLI ignores. `text` is the CLI terminal's own
# foreground whatever the theme says; the theme's `text` is for the pane.
FILE_ROLES: tuple[str, ...] = (*ROLES, "surface")


@dataclass(frozen=True)
class Theme:
    """One named palette from themes.json: truecolor hex per role, sender and topic."""

    name: str  # the CLI name: a catalogue key, or `<key>256` for its tmux variant
    display: str
    appearance: Appearance
    background: str  # "#RRGGBB"; only `tg themes` paints it
    foreground: str
    roles: Mapping[Role, str]
    senders: tuple[str, ...]  # len 7, Telegram's order (see _NAMES16)
    topics: Mapping[int, str]  # icon_color → hex, the six keys of _TOPICS16


@functools.cache
def themes() -> Mapping[str, Theme]:
    """Every theme in the packaged themes.json, in file order, each `<name>256` after
    its base. Read and checked once, on first use."""
    raw = json.loads(resources.files("tg_kit").joinpath("themes.json").read_text("utf-8"))
    found: dict[str, Theme] = {}
    for name, body in raw["themes"].items():
        found[name] = _theme(name, body)
        if "variant256" in body:
            found[f"{name}256"] = _theme(f"{name}256", _overlay(name, body))
    return found


def _theme(name: str, body: dict[str, object]) -> Theme:
    roles = _hex_map(body["roles"])
    topics = {int(k, 16): v for k, v in _hex_map(body["topics"]).items()}
    senders = body["senders"]
    appearance = body["appearance"]
    if set(roles) != set(FILE_ROLES):
        msg = f"theme {name}: roles {sorted(roles)} != {sorted(FILE_ROLES)}"
        raise ValueError(msg)
    if set(topics) != set(_TOPICS16):
        msg = f"theme {name}: topic keys must be Telegram's six icon colours"
        raise ValueError(msg)
    if not isinstance(senders, list) or len(senders) != len(_NAMES16):
        msg = f"theme {name}: senders must be {len(_NAMES16)} colours"
        raise ValueError(msg)
    if appearance not in get_args(Appearance):
        msg = f"theme {name}: appearance must be dark or light"
        raise ValueError(msg)
    return Theme(
        name=name,
        display=str(body["display"]),
        appearance="light" if appearance == "light" else "dark",
        background=_hex(body["background"]),
        foreground=_hex(body["foreground"]),
        roles={r: roles[r] for r in ROLES},
        senders=tuple(_hex(c) for c in senders),
        topics=topics,
    )


def _overlay(name: str, body: dict[str, Any]) -> dict[str, Any]:
    """The base theme with its `variant256` entries moved; a key not in the base is refused."""
    variant = body["variant256"]
    roles, senders, topics = dict(body["roles"]), list(body["senders"]), dict(body["topics"])
    for part, base in (("roles", roles), ("topics", topics)):
        for key, value in variant.get(part, {}).items():
            if key not in base:
                msg = f"theme {name}: variant256 {part} {key!r} is not in the base"
                raise ValueError(msg)
            base[key] = value
    for key, value in variant.get("senders", {}).items():
        if not key.isdigit() or int(key) >= len(senders):
            msg = f"theme {name}: variant256 senders {key!r} is not in the base"
            raise ValueError(msg)
        senders[int(key)] = value
    return {
        **body,
        "display": f"{body['display']} (256)",
        "roles": roles,
        "senders": senders,
        "topics": topics,
    }


_HEX = re.compile(r"#[0-9A-Fa-f]{6}")


def _hex(value: object) -> str:
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        msg = f"not a #RRGGBB colour: {value!r}"
        raise ValueError(msg)
    return value


def _hex_map(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        msg = f"not an object: {value!r}"
        raise TypeError(msg)
    return {str(k): _hex(v) for k, v in value.items()}


def rgb(hexcode: str) -> tuple[int, int, int]:
    r, g, b = (int(hexcode[i : i + 2], 16) for i in (1, 3, 5))
    return r, g, b


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
    """Paints text by role. `depth="none"` returns every string unchanged.

    `theme` is a name in themes.json; it only matters in truecolor (the
    16-colour fallback is the same for every theme), and is read only then.
    """

    depth: Depth = "none"
    theme: str = DEFAULT_THEME

    @property
    def on(self) -> bool:
        return self.depth != "none"

    def __call__(self, role: Role, text: str, *, bold: bool = False) -> str:
        if role == "text":
            return self._paint(None, None, text, bold=bold)
        return self._paint(_SGR16[role], lambda t: t.roles[role], text, bold=bold)

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
        i = abs(sender_id) % len(_NAMES16)
        return self._paint(_NAMES16[i], lambda t: t.senders[i], text)

    def topic(self, icon_color: int | None, text: str, *, bold: bool = False) -> str:
        """A forum topic's title in its icon's colour; another colour → plain."""
        if icon_color not in _TOPICS16:
            return self._paint(None, None, text, bold=bold)
        sgr = _TOPICS16[icon_color]
        return self._paint(sgr, lambda t: t.topics[icon_color], text, bold=bold)

    def _paint(
        self,
        sgr: int | None,
        hexcode: Callable[[Theme], str] | None,
        text: str,
        *,
        bold: bool = False,
    ) -> str:
        if self.depth == "none" or not text or (sgr is None and not bold):
            return text
        codes = ["1"] if bold else []
        if sgr is not None and hexcode is not None:
            if self.depth == "truecolor":
                r, g, b = rgb(hexcode(themes()[self.theme]))
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


def theme_name(flag: str | None, env: Mapping[str, str], configured: str | None = None) -> str:
    """`--theme`, else `TG_THEME`, else config.toml's `theme` (`configured`, checked
    when the config loads), else DEFAULT_THEME. An unknown name is a usage error."""
    raw = flag if flag is not None else env.get("TG_THEME", "")
    if not raw.strip():
        return configured or DEFAULT_THEME
    value = raw.strip().lower()
    if value in themes():
        return value
    source = "--theme" if flag is not None else "TG_THEME"
    raise UsageError(f"{source} {raw!r} is not a theme", hint=f"use one of: {', '.join(themes())}")


def choose_style(
    mode: ColorMode, *, isatty: bool, env: Mapping[str, str], theme: str = DEFAULT_THEME
) -> Style:
    """The style for one stream (stdout or stderr), given its own isatty.

    `auto`: FORCE_COLOR (not "0"/"false") turns colour on, NO_COLOR
    (no-color.org) or TERM=dumb turn it off, otherwise colour iff a terminal.
    """
    if mode == "never":
        return PLAIN
    if mode == "auto" and not _auto_on(isatty=isatty, env=env):
        return PLAIN
    truecolor = env.get("COLORTERM", "").lower() in {"truecolor", "24bit"}
    return Style("truecolor" if truecolor else "16", theme)


def _auto_on(*, isatty: bool, env: Mapping[str, str]) -> bool:
    force = env.get("FORCE_COLOR", "")
    if force:
        return force.lower() not in {"0", "false"}
    if env.get("NO_COLOR", ""):
        return False
    if env.get("TERM", "") == "dumb":
        return False
    return isatty
