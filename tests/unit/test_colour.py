"""Pins colour as presentation only: with colour off every line is byte-for-byte
the pre-colour output, and with colour on, stripping the ANSI codes gives that
same line (no reordering, no extra or missing characters, same truncation).

`golden/plain_lines.txt` was printed by render.py before colour existed
(21dff6a), from the cases below: every line kind (message with each media
kind, marker, truncation, links and buttons; dialog; topic; folder; watch
message, typing and delete). Also covers when colour is on (`choose_style`,
`--color`, TG_COLOR, NO_COLOR, FORCE_COLOR, TERM=dumb, COLORTERM) and the
stderr prefixes through the real entry point. Not covered: how a terminal draws
the colours (checked by hand on a TTY).
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tg_kit.app import _paint_prefix
from tg_kit.buttons import Button
from tg_kit.errors import UsageError
from tg_kit.folders import Folder
from tg_kit.model import (
    DeleteEvent,
    DialogView,
    Forward,
    Media,
    MessageEvent,
    MessageView,
    Reaction,
    Sender,
    TopicView,
    TypingEvent,
    WatchEvent,
)
from tg_kit.render import compact, dialog_line, event_lines, folder_line, topic_line
from tg_kit.style import PLAIN, Depth, Style, choose_style, color_mode, strip_ansi

NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
D = datetime(2026, 9, 29, 11, 2, tzinfo=UTC)
OLD = datetime(2025, 3, 1, 8, 5, tzinfo=UTC)
ME = Sender(1, "self", None, "Me")
BOT = Sender(123456, "bot", "example_bot", "Example")
IVAN = Sender(555, "user", None, "Ivan Petrov")
NEWS = Sender(-1000000000777, "channel", "example_news", "Example News")
NOID = Sender(None, "unknown", None, "Hidden")
GRID = (
    (
        Button(0, 0, "cb", "My bot", data=b"x"),
        Button(0, 1, "url", "Docs", url="https://example.com/docs"),
    ),
    (Button(1, 0, "switch", "Share", query="q"),),
)


def _msg(mid: int, sender: Sender, text: str = "", **kw: object) -> MessageView:
    return MessageView(mid, 1, kw.pop("date", D), sender, sender is ME, text, **kw)  # type: ignore[arg-type]


MESSAGES = [
    _msg(677791, BOT, "Choose a bot\nsecond line", buttons=GRID, keyboard="inline"),
    _msg(677792, ME, "/start", reply_to=677791),
    _msg(
        677793, IVAN, "caption text", date=OLD, media=Media("photo", 219136, width=1280, height=720)
    ),
    _msg(677794, BOT, "updated text", edits=2, reactions=(Reaction("👍", 3), Reaction("❤️", 1))),
    _msg(812, BOT, "a reply inside forum topic 12", reply_to=809, topic_id=12),
    _msg(
        2985,
        ME,
        "36. Mastering … ⏎ Austen\nMcDonald",
        topic_id=2,
        media=Media("document", 2621440, name="mastering-behavioral-interview.epub"),
    ),
    _msg(
        10,
        NEWS,
        "fwd",
        forward=Forward(-1000000000777, "@example_news", None),
        via_bot="example_bot",
        edited=D,
        pinned=True,
        chat_title="Example News",
    ),
    _msg(11, NOID, service="pin_message"),
    _msg(12, IVAN, "see docs", links=(("Privacy policy", "https://example.com/privacy"),)),
    _msg(13, IVAN, "x" * 50, media=Media("voice", duration=12)),
    _msg(14, IVAN, media=Media("sticker", emoji="😀")),
    _msg(15, IVAN, media=Media("audio", name="song.mp3", duration=185)),
    _msg(16, IVAN, media=Media("video", 500, width=640, height=360, duration=9)),
    _msg(17, IVAN, media=Media("poll", title="Lunch?")),
    _msg(18, IVAN, media=Media("dice", emoji="🎲=4")),
    _msg(19, IVAN, media=Media("contact", title="Ivan Petrov")),
    _msg(20, IVAN, media=Media("geo")),
    _msg(21, IVAN, media=Media("document", 2048, mime="application/pdf")),
    _msg(22, IVAN, "hi", media=Media("webpage", url="https://example.com")),
    _msg(23, IVAN, "hi", reply_to=12, topic_id=12),
    _msg(24, BOT, "edited once", edits=1),
    _msg(25, BOT, buttons=((Button(0, 0, "reply", "Yes", inline=False),),), keyboard="reply"),
    _msg(26, IVAN, "trailing space   "),
    _msg(27, IVAN, "  ", reactions=(Reaction("👍", 1),)),
    _msg(28, IVAN, media=Media("sticker")),
]
DIALOGS = [
    DialogView(123456, "bot", "Example", "example_bot", unread=2, pinned=True, last_text="Choose"),
    DialogView(-1000000000777, "channel", "Example News", None, unread=5, mentions=1, muted=True),
    DialogView(-1002, "supergroup", "Dev Chat", None, mentions=3, forum=True, last_text="y" * 120),
    DialogView(1, "self", "Saved Messages", None),
    DialogView(555, "user", "Ivan Petrov", None, unread=1, mentions=2, last_text="a\nb"),
    DialogView(-3, "group", "Family", None, last_text="ok"),
    DialogView(-4, "unknown", "Odd", None),
]
TOPICS = [
    TopicView(12, "Releases", 0x6FB9F0, unread=5, mentions=1, pinned=True, last_text="v2.3"),
    TopicView(1, "General", None, closed=True, hidden=True, last_text="welcome"),
    TopicView(3, "Ideas", 0xFB6F5F, mentions=2, last_text="z" * 100),
    TopicView(4, "Odd", 0x123456),
]
FOLDERS: list[tuple[Folder, int | None, int | None]] = [
    (Folder(0, "All chats", "all"), None, None),
    (Folder(2, "Work", "folder"), 3, None),
    (Folder(5, "Team Projects", "shared"), None, None),
    (Folder(2, "Work", "folder"), 3, 14),
    (Folder(6, "Solo", "folder"), 0, 1),
]
EVENTS: list[WatchEvent] = [
    MessageEvent(MESSAGES[0]),
    MessageEvent(MESSAGES[3], edit=True),
    TypingEvent(123456, BOT, "typing", D),
    TypingEvent(555, IVAN, "record_audio", OLD),
    DeleteEvent(None, (677792, 677793), D),
    DeleteEvent(123456, (5,), D),
]


def every_line(style: Style) -> list[str]:
    out: list[str] = []
    for m in MESSAGES:
        out += compact(m, now=NOW, tz=UTC, style=style)
        out += compact(m, now=NOW, tz=UTC, truncate=20, style=style)
        out += compact(m, now=NOW, tz=UTC, truncate=20, peer_hint="@example_bot", style=style)
    out += [dialog_line(d, style) for d in DIALOGS]
    out += [topic_line(t, style) for t in TOPICS]
    out += [folder_line(f, unread, chats, style) for f, unread, chats in FOLDERS]
    for e in EVENTS:
        out += event_lines(e, now=NOW, tz=UTC, style=style)
        out += event_lines(e, now=NOW, tz=UTC, chat="@example_bot", style=style)
    return out


GOLDEN = Path(__file__).parent / "golden" / "plain_lines.txt"


def test_colour_off_prints_the_pre_colour_bytes() -> None:
    assert every_line(PLAIN) == GOLDEN.read_text(encoding="utf-8").splitlines()


def test_default_style_is_plain() -> None:
    assert compact(MESSAGES[0], now=NOW, tz=UTC) == compact(
        MESSAGES[0], now=NOW, tz=UTC, style=PLAIN
    )


@pytest.mark.parametrize("depth", ["16", "truecolor"])
def test_stripping_colour_gives_the_plain_line(depth: Depth) -> None:
    coloured = every_line(Style(depth))
    assert [strip_ansi(line) for line in coloured] == every_line(PLAIN)
    assert sum("\x1b[" in line for line in coloured) == len(coloured)  # every line has colour


def test_owner_example_line_colours_each_token() -> None:
    line = compact(MESSAGES[5], now=NOW, tz=UTC, style=Style("16"))[0]
    assert line == (
        "\x1b[90m#2985\x1b[0m \x1b[90m09-29 11:02\x1b[0m \x1b[35m[topic:2]\x1b[0m "
        "\x1b[35mme\x1b[0m: \x1b[36m[document mastering-behavioral-interview.epub\x1b[0m"
        "\x1b[90m 2.5MB\x1b[0m\x1b[36m]\x1b[0m 36. Mastering …\x1b[90m ⏎ \x1b[0mAusten"
        "\x1b[90m ⏎ \x1b[0mMcDonald"
    )


def test_truecolor_uses_the_mocha_hex() -> None:
    assert (
        Style("truecolor", "catppuccin-mocha")("accent", "me") == "\x1b[38;2;203;166;247mme\x1b[0m"
    )


@pytest.mark.parametrize(
    ("sender", "code"),
    [(ME, "35"), (BOT, "95"), (IVAN, "94"), (Sender(556, "user", None, "B"), "32")],
)
def test_sender_colour_is_me_bot_or_by_id(sender: Sender, code: str) -> None:
    assert Style("16").sender(sender.id, sender.kind, "x") == f"\x1b[{code}mx\x1b[0m"


def test_sender_without_id_stays_plain() -> None:
    assert Style("16").sender(None, "unknown", "x") == "x"


@pytest.mark.parametrize(
    ("mode", "isatty", "env", "depth"),
    [
        ("auto", True, {}, "16"),
        ("auto", False, {}, "none"),
        ("auto", True, {"COLORTERM": "truecolor"}, "truecolor"),
        ("auto", True, {"COLORTERM": "24bit"}, "truecolor"),
        ("auto", True, {"NO_COLOR": "1"}, "none"),
        ("auto", True, {"NO_COLOR": ""}, "16"),
        ("auto", True, {"TERM": "dumb"}, "none"),
        ("auto", False, {"FORCE_COLOR": "1"}, "16"),
        ("auto", True, {"FORCE_COLOR": "1", "NO_COLOR": "1"}, "16"),
        ("auto", True, {"FORCE_COLOR": "0"}, "none"),
        ("always", False, {"NO_COLOR": "1", "TERM": "dumb"}, "16"),
        ("never", True, {"FORCE_COLOR": "1"}, "none"),
    ],
)
def test_choose_style(mode: str, isatty: bool, env: dict[str, str], depth: Depth) -> None:
    assert choose_style(mode, isatty=isatty, env=env).depth == depth  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("flag", "env", "mode"),
    [
        (None, {}, "auto"),
        (None, {"TG_COLOR": "Never"}, "never"),
        ("always", {"TG_COLOR": "never"}, "always"),
    ],
)
def test_color_mode_flag_over_env(flag: str | None, env: dict[str, str], mode: str) -> None:
    assert color_mode(flag, env) == mode


def test_unknown_color_mode_is_a_usage_error() -> None:
    with pytest.raises(UsageError, match="TG_COLOR 'rainbow' is not a colour mode"):
        color_mode(None, {"TG_COLOR": "rainbow"})


@pytest.mark.parametrize(
    ("line", "painted"),
    [
        ("error: boom", "\x1b[1;31merror:\x1b[0m boom"),
        ("  fix: run x", "\x1b[32m  fix:\x1b[0m run x"),
        ("note: slow", "\x1b[93mnote:\x1b[0m slow"),
        ("warning: odd", "\x1b[93mwarning:\x1b[0m odd"),
        ("interrupted", "interrupted"),
    ],
)
def test_stderr_prefixes(line: str, painted: str) -> None:
    assert _paint_prefix(line, Style("16")) == painted


# --- through the real entry point (stderr is a pipe here) ----------------------


def tg(tmp_path: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    base = {
        k: v
        for k, v in os.environ.items()
        if k not in {"NO_COLOR", "FORCE_COLOR", "TG_COLOR", "TG_THEME", "COLORTERM"}
    }
    return subprocess.run(  # noqa: S603 — fixed argv: this interpreter + the test's own args
        [sys.executable, "-c", "from tg_kit.cli import main; main()", *args],
        capture_output=True,
        text=True,
        env={
            **base,
            "TG_KIT_CONFIG_DIR": str(tmp_path),
            "TG_KIT_API_ID": "1",
            "TG_KIT_API_HASH": "fake",
            **env,
        },
        timeout=60,
        check=False,
    )


def test_piped_stderr_is_plain(tmp_path: Path) -> None:
    result = tg(tmp_path, "read", "me")
    assert result.returncode == 3
    assert result.stderr.startswith("error: not logged in")
    assert "\x1b[" not in result.stderr


def test_force_color_colours_piped_stderr(tmp_path: Path) -> None:
    result = tg(tmp_path, "read", "me", FORCE_COLOR="1")
    assert result.stderr.startswith("\x1b[1;31merror:\x1b[0m not logged in")
    assert "\x1b[32m  fix:\x1b[0m" in result.stderr


def test_color_never_beats_force_color(tmp_path: Path) -> None:
    result = tg(tmp_path, "--color", "never", "read", "me", FORCE_COLOR="1")
    assert "\x1b[" not in result.stderr


def test_json_stdout_never_has_colour(tmp_path: Path) -> None:
    result = tg(tmp_path, "--color", "always", "accounts", "--json")
    assert result.stdout.strip() == "[]"


def test_bad_tg_color_is_a_usage_error(tmp_path: Path) -> None:
    result = tg(tmp_path, "accounts", TG_COLOR="rainbow")
    assert result.returncode == 2
    assert result.stderr.splitlines() == [
        "error: TG_COLOR 'rainbow' is not a colour mode",
        "  fix: use one of: auto, always, never",
    ]
