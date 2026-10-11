"""Pins the theme catalogue the CLI and the pane share (§10.2, "The theme
catalogue"): palettes/themes.json is the source of truth, and src/tg_kit/themes.json
(package data: an installed `tg` cannot read the repo root) is a byte-identical copy.
The pane's copy is mods/dialogs-pane/hooks/ui/themes.ts, the file's bytes as a module
(the engine loads no .json from a plugin), written by dev/pane_themes.py; and the
mod's `palette` option lists every theme. Also checks the file's schema, and that no
theme draws two different colours on one 256-colour cell in tmux once its
`variant256` is applied.

Not covered: that palette.ts reads the module right (the mod's own palette.test.ts).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "palettes/themes.json"
COPIES = [ROOT / "src/tg_kit/themes.json"]
PANE_COPY = ROOT / "mods/dialogs-pane/hooks/ui/themes.ts"
PANE_MANIFEST = ROOT / "mods/dialogs-pane/.claude-plugin/plugin.json"
DOC: dict[str, Any] = json.loads(SOURCE.read_text("utf-8"))
THEMES: dict[str, dict[str, Any]] = DOC["themes"]
HEX = re.compile(r"#[0-9A-F]{6}")


@pytest.mark.parametrize("copy", COPIES, ids=lambda p: str(p.relative_to(ROOT)))
def test_the_copy_matches_the_source(copy: Path) -> None:
    assert copy.read_bytes() == SOURCE.read_bytes(), f"copy {SOURCE} to {copy}"


def test_the_pane_module_carries_the_source_bytes() -> None:
    text = PANE_COPY.read_text("utf-8")
    opening = "\nexport const CATALOGUE = "
    assert opening in text, f"run dev/pane_themes.py to write {PANE_COPY}"
    body = text.split(opening, 1)[1]
    assert body.endswith(" as const\n")
    copied = body.removesuffix(" as const\n") + "\n"
    assert copied == SOURCE.read_text("utf-8"), f"run dev/pane_themes.py to copy {SOURCE}"


def test_the_pane_option_lists_every_theme_and_defaults_to_tokyo_night() -> None:
    """theme and ansi, then each theme, and its `<name>256` where it has a variant256."""
    palette = json.loads(PANE_MANIFEST.read_text("utf-8"))["userConfig"]["palette"]
    expected = ["theme", "ansi"]
    for name, theme in THEMES.items():
        expected += [name, f"{name}256"] if "variant256" in theme else [name]
    assert palette["options"] == expected
    assert palette["default"] == "tokyo-night"


def test_the_catalogue_names_its_roles_senders_and_topic_keys() -> None:
    assert DOC["version"] == 1
    assert len(DOC["roles"]) == 14
    assert DOC["senderOrder"] == ["red", "orange", "violet", "green", "cyan", "blue", "pink"]
    assert DOC["topicKeys"] == ["6FB9F0", "FFD67E", "CB86DB", "8EEE98", "FF93B2", "FB6F5F"]


@pytest.mark.parametrize("name", THEMES)
def test_every_theme_has_the_same_keys_and_valid_colours(name: str) -> None:
    t = THEMES[name]
    assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name)
    assert t["appearance"] in {"dark", "light"}
    assert list(t["roles"]) == DOC["roles"]
    assert len(t["senders"]) == len(DOC["senderOrder"])
    assert len(t["senderNames"]) == len(DOC["senderOrder"])
    assert all(isinstance(n, str) and n for n in t["senderNames"])
    assert list(t["topics"]) == DOC["topicKeys"]
    colours = [t["background"], t["foreground"], *t["roles"].values(), *t["senders"]]
    colours += list(t["topics"].values())
    assert all(HEX.fullmatch(c) for c in colours), colours


@pytest.mark.parametrize("name", [n for n, t in THEMES.items() if "variant256" in t])
def test_every_variant256_key_exists_in_the_base(name: str) -> None:
    t, variant = THEMES[name], THEMES[name]["variant256"]
    assert set(variant["roles"]) <= set(t["roles"])
    assert set(variant["topics"]) <= set(t["topics"])
    assert all(0 <= int(i) < len(t["senders"]) for i in variant["senders"])
    moved = [*variant["roles"].values(), *variant["senders"].values()]
    assert all(HEX.fullmatch(c) for c in [*moved, *variant["topics"].values()])


def cell256(hexcode: str) -> int:
    """tmux's downsample, as §10.2 gives it: 16 + 36·r + 6·g + b, each round(v / 51)."""
    r, g, b = (round(int(hexcode[i : i + 2], 16) / 51) for i in (1, 3, 5))
    return 16 + 36 * r + 6 * g + b


def drawn_in_tmux(t: dict[str, Any]) -> tuple[dict[str, str], list[str], dict[str, str]]:
    """The roles, senders and topics tmux draws: the base, with variant256 applied."""
    variant = t.get("variant256", {"roles": {}, "senders": {}, "topics": {}})
    senders = list(t["senders"])
    for i, colour in variant["senders"].items():
        senders[int(i)] = colour
    return (
        {**t["roles"], **variant["roles"]},
        senders,
        {**t["topics"], **variant["topics"]},
    )


def collisions(named: dict[str, str]) -> list[tuple[str, str, int]]:
    """Pairs of different hex on one cell (equal hex is a pair shared on purpose)."""
    items = list(named.items())
    return [
        (a, b, cell256(ca))
        for i, (a, ca) in enumerate(items)
        for b, cb in items[i + 1 :]
        if ca != cb and cell256(ca) == cell256(cb)
    ]


# A sender's name must never read as an unread count, a mention or `me`.
NOT_A_SENDER = ("unread", "mention", "accent")


@pytest.mark.parametrize("name", THEMES)
def test_no_sender_is_unread_mention_or_accent(name: str) -> None:
    t = THEMES[name]
    # an adjusted role's upstream hex is banned too: it still reads as that role
    adjusted = t.get("adjusted", {}).get("roles", {})
    upstream = {a["from"] for r, a in adjusted.items() if r in NOT_A_SENDER}
    for roles, senders in ((t["roles"], t["senders"]), drawn_in_tmux(t)[:2]):
        assert not ({roles[r] for r in NOT_A_SENDER} | upstream) & set(senders)


@pytest.mark.parametrize("name", [n for n, t in THEMES.items() if "adjusted" in t])
def test_every_adjusted_entry_records_its_upstream_and_used_hex(name: str) -> None:
    t = THEMES[name]
    adjusted = t["adjusted"]
    assert adjusted
    assert set(adjusted) <= {"roles", "senders", "topics"}
    used = {"roles": t["roles"], "senders": dict(enumerate(t["senders"])), "topics": t["topics"]}
    for part, changes in adjusted.items():
        assert changes, f"{part}: an empty part is left out"
        for key, change in changes.items():
            assert set(change) == {"from", "to"}
            assert HEX.fullmatch(change["from"])
            assert change["to"] == used[part][int(key) if part == "senders" else key]
            assert change["from"] != change["to"]


def luminance(hexcode: str) -> float:
    """WCAG 2 relative luminance."""

    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(int(hexcode[i : i + 2], 16)) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


@pytest.mark.parametrize("name", THEMES)
def test_every_data_colour_reaches_3_to_1_on_the_background(name: str) -> None:
    """Roles (all but `surface`, a border), senders and topics."""
    t = THEMES[name]
    data = {r: c for r, c in t["roles"].items() if r != "surface"}
    data |= {f"sender {i}": c for i, c in enumerate(t["senders"])}
    data |= {f"topic {k}": c for k, c in t["topics"].items()}
    weak = {
        key: round(contrast(colour, t["background"]), 2)
        for key, colour in data.items()
        if contrast(colour, t["background"]) < 3
    }
    assert weak == {}


@pytest.mark.parametrize("name", THEMES)
def test_no_two_colours_share_a_256_cell_after_variant256(name: str) -> None:
    roles, senders, topics = drawn_in_tmux(THEMES[name])
    unread = {"unread": roles["unread"]}
    guarded = {r: roles[r] for r in NOT_A_SENDER}
    assert collisions(roles) == []
    assert collisions({**guarded, **{f"sender{i}": c for i, c in enumerate(senders)}}) == []
    # a topic may be unread's own hex (the single-red themes), never another hex on its cell
    assert collisions({**unread, **{f"topic {k}": c for k, c in topics.items()}}) == []


def test_mocha_needs_its_variant_without_it() -> None:
    """The check bites: catppuccin-mocha's base collides in tmux (§10.2: 223, 153, 217)."""
    base = THEMES["catppuccin-mocha"]
    cells = {cell for _, _, cell in collisions(base["roles"])}
    assert {223, 153} <= cells
