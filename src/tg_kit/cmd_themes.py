"""`tg themes [NAME]` — preview the colour themes. Local only: no account, no network.

On a terminal each theme prints a header and a fixed sample block (messages,
dialogs, a topic, an error and its fix) in truecolor, whatever COLORTERM says,
painted on the theme's own background so a light theme is judged on light.
Piped (or NO_COLOR, --color never): the theme names only, one per line.
"""

from __future__ import annotations

import os
import sys
import unicodedata
from datetime import UTC, datetime
from typing import Annotated

import typer

from tg_kit.app import Globals, JsonOpt, _paint_prefix, emit_json, out
from tg_kit.config import load_config
from tg_kit.errors import UsageError
from tg_kit.model import DialogView, Media, MessageView, Sender, TopicView
from tg_kit.render import compact, dialog_line, topic_line
from tg_kit.style import (
    DEFAULT_THEME,
    Style,
    Theme,
    choose_style,
    rgb,
    strip_ansi,
    theme_name,
    themes,
)

__all__ = ["register", "sample_block"]

# Placeholder data only: never a real contact.
_NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
_AT = datetime(2026, 9, 29, 11, 2, tzinfo=UTC)
_ME = Sender(1, "self", None, "Me")
_IVAN = Sender(555, "user", None, "Ivan Petrov")
_BOT = Sender(123456, "bot", "example_bot", "Example")
_TEAM = -1000000000123
_MESSAGES = (
    MessageView(
        2985,
        _TEAM,
        _AT,
        _IVAN,
        False,  # noqa: FBT003 — MessageView.out, positional like the rest
        "release notes attached",
        topic_id=12,
        media=Media("photo", 219136, width=1280, height=720),
    ),
    MessageView(2986, _TEAM, _AT, _ME, True, "/start", reply_to=2985),  # noqa: FBT003
    MessageView(2987, _TEAM, _AT, _BOT, False, "Choose a bot", edits=1),  # noqa: FBT003
)
_DIALOGS = (
    DialogView(123456, "bot", "Example", "example_bot", unread=2, last_text="Choose a bot"),
    DialogView(555, "user", "Ivan Petrov", None, unread=3, mentions=1, last_text="see you at 5"),
    DialogView(
        _TEAM,
        "supergroup",
        "Project team",
        None,
        unread=14,
        muted=True,
        forum=True,
        last_text="v2.3 is out",
    ),
)
_TOPIC = TopicView(12, "Releases", 0x6FB9F0, unread=5, mentions=1, pinned=True, last_text="v2.3")
_ERROR = (  # a real pair, from peers.resolve
    "error: id 42 is not in the local cache or the latest 500 dialogs",
    "  fix: resolve it by @username first (tg resolve @name), then use the id",
)


def sample_block(style: Style) -> list[str]:
    """The fixed sample every theme is judged on, rendered by the real renderers."""
    lines: list[str] = []
    for m in _MESSAGES:
        lines += compact(m, now=_NOW, tz=UTC, style=style)
    lines += [dialog_line(d, style) for d in _DIALOGS]
    lines.append(topic_line(_TOPIC, style))
    lines += [_paint_prefix(line, style) for line in _ERROR]
    return lines


def _on_background(lines: list[str], theme: Theme) -> list[str]:
    """Each line on the theme's background and foreground, padded to one rectangle."""
    bg, fg = rgb(theme.background), rgb(theme.foreground)
    base = f"\x1b[48;2;{bg[0]};{bg[1]};{bg[2]}m\x1b[38;2;{fg[0]};{fg[1]};{fg[2]}m"
    reset = "\x1b[0m"
    width = max(_cells(strip_ansi(line)) for line in lines) + 2
    painted = []
    for line in lines:
        pad = " " * (width - 1 - _cells(strip_ansi(line)))
        body = line.replace(reset, reset + base)  # a coloured span ends; the theme resumes
        painted.append(f"{base} {body}{pad}{reset}")
    return painted


def _cells(text: str) -> int:
    """Terminal columns: wide (emoji, CJK) characters take two."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def register(app: typer.Typer) -> None:
    @app.command("themes")
    def themes_cmd(
        ctx: typer.Context,
        name: Annotated[
            str | None, typer.Argument(metavar="[NAME]", help="One theme; default: all.")
        ] = None,
        json_out: JsonOpt = False,
    ) -> None:
        """Preview the colour themes (--theme, TG_THEME, config.toml theme); piped: names."""
        g = ctx.obj if isinstance(ctx.obj, Globals) else Globals()
        known = themes()
        if name is not None and name.strip().lower() not in known:
            raise UsageError(f"{name!r} is not a theme", hint=f"use one of: {', '.join(known)}")
        chosen = [known[name.strip().lower()]] if name is not None else list(known.values())
        current = theme_name(g.theme, os.environ, load_config().theme)
        if json_out or g.json:
            emit_json(
                [
                    {
                        "name": t.name,
                        "appearance": t.appearance,
                        "default": t.name == DEFAULT_THEME,
                        "current": t.name == current,
                    }
                    for t in chosen
                ]
            )
            return
        if not choose_style(g.color, isatty=sys.stdout.isatty(), env=os.environ).on:
            for t in chosen:
                out(t.name)
            return
        for i, t in enumerate(chosen):
            if i:
                out()
            mark = "  (default)" if t.name == DEFAULT_THEME else ""
            mark += "  (current)" if t.name == current else ""
            out(f"\x1b[1m{t.name}\x1b[0m  {t.display}, {t.appearance}{mark}", color=True)
            for line in _on_background(sample_block(Style("truecolor", t.name)), t):
                out(line, color=True)
