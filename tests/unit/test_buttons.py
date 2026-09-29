"""Pins button selection: exact → case-insensitive → emoji/space-insensitive, index,
ambiguity and misses (exit 4 with the full listing), and the JSON shape of a button.

Not covered: converting Telethon markup into the grid (see test_convert.py).
"""

from __future__ import annotations

import pytest

from tg_kit.buttons import Button, ButtonGrid, format_button, format_grid, select_button
from tg_kit.cmd_bots import no_press_action
from tg_kit.errors import NotFoundError, RefusedError, UsageError

GRID: ButtonGrid = (
    (
        Button(0, 0, "cb", "My Bot", data=b"bot:1"),
        Button(0, 1, "cb", "🤖 Settings »", data=b"set"),
    ),
    (
        Button(1, 0, "url", "Docs", url="https://example.com/docs"),
        Button(1, 1, "cb", "Back", data=b"back"),
    ),
    (Button(2, 0, "cb", "back", data=b"back2"),),
)


@pytest.mark.parametrize(
    ("label", "index"),
    [
        ("My Bot", "0:0"),  # exact
        ("my bot", "0:0"),  # case-insensitive
        ("Settings", "0:1"),  # emoji and punctuation ignored
        ("settings", "0:1"),
        ("🤖 Settings »", "0:1"),
        ("Docs", "1:0"),
        ("Back", "1:1"),  # exact wins over the case-insensitive tie with "back"
        ("back", "2:0"),
    ],
)
def test_label_selects_the_right_button(label: str, index: str) -> None:
    assert select_button(GRID, text=label).index == index


def test_case_insensitive_tie_is_ambiguous_and_lists_buttons() -> None:
    with pytest.raises(NotFoundError, match="ambiguous") as info:
        select_button(GRID, text="BACK")
    assert info.value.hint is not None
    assert '[1:1 cb "Back"]' in info.value.hint
    assert '[2:0 cb "back"]' in info.value.hint


def test_unknown_label_lists_every_button() -> None:
    with pytest.raises(NotFoundError, match="no button labelled 'Nope'") as info:
        select_button(GRID, text="Nope")
    assert info.value.hint is not None
    for row in format_grid(GRID):
        assert row.strip() in info.value.hint


def test_index_selects_by_row_and_column() -> None:
    assert select_button(GRID, row=1, col=0).text == "Docs"


def test_missing_index_is_not_found() -> None:
    with pytest.raises(NotFoundError, match="no button at 5:0"):
        select_button(GRID, row=5, col=0)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"row": 1}, "--row and --col together"),
        ({"text": "Docs", "row": 1, "col": 0}, "--row and --col together"),
        ({}, "name a button"),
    ],
)
def test_incomplete_selection_is_a_usage_error(kwargs: dict[str, object], message: str) -> None:
    with pytest.raises(UsageError, match=message):
        select_button(GRID, **kwargs)  # type: ignore[arg-type]


def test_message_without_buttons_is_not_found() -> None:
    with pytest.raises(NotFoundError, match="no buttons"):
        select_button((), text="x")


@pytest.mark.parametrize(
    ("button", "line"),
    [
        (Button(0, 0, "cb", "Go", data=b"g"), '[0:0 cb "Go"]'),
        (Button(1, 0, "url", "Docs", url="https://x.io"), '[1:0 url "Docs" → https://x.io]'),
        (Button(0, 1, "webapp", "App", url="https://a.io"), '[0:1 webapp "App" → https://a.io]'),
        (
            Button(0, 0, "switch", "Share", query="q", same_peer=True),
            "[0:0 switch \"Share\" → here: 'q']",
        ),
        (Button(0, 0, "switch", "Share", query=""), "[0:0 switch \"Share\" → pick chat: '']"),
        (Button(0, 0, "copy", "Copy", copy_text="abc"), "[0:0 copy \"Copy\" → 'abc']"),
        (Button(0, 0, "profile", "Author", user_id=7), '[0:0 profile "Author" → user 7]'),
        (
            Button(0, 0, "cb", "Transfer", data=b"t", requires_password=True),
            '[0:0 cb "Transfer" 🔒]',
        ),
        (Button(0, 0, "game", "Play"), '[0:0 game "Play"]'),
        (Button(0, 0, "buy", "Pay"), '[0:0 buy "Pay"]'),
        (Button(0, 0, "reply", "Menu", inline=False), '[0:0 reply "Menu"]'),
        (Button(0, 0, "phone", "Share phone", inline=False), '[0:0 phone "Share phone"]'),
        (Button(0, 0, "geo", "Location", inline=False), '[0:0 geo "Location"]'),
        (Button(0, 0, "poll", "Poll", inline=False), '[0:0 poll "Poll"]'),
    ],
)
def test_every_button_type_formats(button: Button, line: str) -> None:
    assert format_button(button) == line


def test_button_json_carries_base64_data_and_optional_fields() -> None:
    assert Button(0, 1, "cb", "Go", data=b"go").to_json() == {
        "row": 0,
        "col": 1,
        "type": "cb",
        "text": "Go",
        "data_b64": "Z28=",
    }
    assert Button(1, 0, "url", "D", url="https://x.io").to_json() == {
        "row": 1,
        "col": 0,
        "type": "url",
        "text": "D",
        "url": "https://x.io",
    }


@pytest.mark.parametrize(
    ("button", "shown"),
    [
        (Button(0, 0, "url", "Docs", url="https://x.io"), "url: https://x.io"),
        (Button(0, 0, "login", "Login", url="https://x.io/l"), "url: https://x.io/l"),
        (Button(0, 0, "webapp", "App", url="https://x.io/a"), "url: https://x.io/a"),
        (
            Button(0, 0, "switch", "S", query="q", same_peer=True),
            "switch inline: @example_bot 'q' (this chat)",
        ),
        (Button(0, 0, "copy", "C", copy_text="abc"), "copy: abc"),
        (Button(0, 0, "profile", "P", user_id=7), "profile: user 7"),
        (Button(0, 0, "cb", "Go", data=b"g"), None),
        (Button(0, 0, "game", "Play"), None),
        (Button(0, 0, "reply", "Menu", inline=False), None),
    ],
)
def test_links_and_helpers_are_shown_not_pressed(button: Button, shown: str | None) -> None:
    assert no_press_action(button, bot_label="@example_bot") == shown


@pytest.mark.parametrize(
    ("button", "why"),
    [
        (Button(0, 0, "phone", "Share phone", inline=False), "phone number"),
        (Button(0, 0, "geo", "Where", inline=False), "location"),
        (Button(0, 0, "peer", "Pick", inline=False), "share a chat"),
        (Button(0, 0, "buy", "Pay"), "payment"),
        (Button(0, 0, "disabled", "Off"), "disabled"),
        (Button(0, 0, "cb", "Transfer", data=b"t", requires_password=True), "2FA password"),
    ],
)
def test_personal_data_payment_and_2fa_buttons_are_refused(button: Button, why: str) -> None:
    with pytest.raises(RefusedError, match=why) as info:
        no_press_action(button, bot_label="@example_bot")
    assert info.value.exit_code == 7


def test_labels_never_match_by_prefix_or_substring() -> None:
    grid: ButtonGrid = (
        (
            Button(0, 0, "cb", "« Back to Bot List", data=b"b"),
            Button(0, 1, "cb", "⚙️ Settings", data=b"s"),
        ),
    )
    with pytest.raises(NotFoundError, match="no button labelled '«'"):
        select_button(grid, text="«")
    with pytest.raises(NotFoundError, match="no button labelled 'Back'"):
        select_button(grid, text="Back")
    assert select_button(grid, text="settings").index == "0:1"
