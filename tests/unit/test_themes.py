"""Pins the named colour themes: the packaged themes.json is the design file
byte for byte, every theme colours every role, sender and topic, `--theme` /
`TG_THEME` pick one (an unknown name is exit 2 with the list), a theme changes
only truecolor (the 16-colour fallback is one table), and `tg themes` previews
every theme on a terminal and prints names only in a pipe.

Not covered: whether a theme's colours read well (judged by eye with
`tg themes` on a terminal), and how a terminal draws them.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tg_kit.cmd_themes import sample_block
from tg_kit.config import load_config
from tg_kit.errors import UsageError
from tg_kit.style import (
    DEFAULT_THEME,
    PLAIN,
    ROLES,
    Style,
    _theme,
    choose_style,
    rgb,
    strip_ansi,
    theme_name,
    themes,
)

DESIGN = Path(__file__).parents[2] / "palettes" / "themes.json"
NAMES = list(themes())


def test_default_theme_exists() -> None:
    assert DEFAULT_THEME in NAMES


@pytest.mark.parametrize("name", NAMES)
def test_every_theme_colours_every_role_sender_and_topic(name: str) -> None:
    t = themes()[name]
    assert set(t.roles) == set(ROLES)  # `surface` is the pane's, dropped on load
    assert len(t.senders) == 7
    assert set(t.topics) == {0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F}
    assert t.appearance in {"dark", "light"}


def _mocha() -> dict[str, object]:
    raw: dict[str, object] = json.loads(DESIGN.read_text("utf-8"))["themes"][DEFAULT_THEME]
    return raw


@pytest.mark.parametrize(
    ("change", "error"),
    [
        (lambda b: b["roles"].pop("accent"), "roles"),
        (lambda b: b["senders"].pop(), "senders"),
        (lambda b: b["topics"].pop("6FB9F0"), "topic keys"),
        (lambda b: b.update(appearance="dusk"), "appearance"),
        (lambda b: b["roles"].update(accent="mauve"), "#RRGGBB"),
    ],
)
def test_a_broken_theme_is_refused_when_loaded(change: object, error: str) -> None:
    body = _mocha()
    change(body)  # type: ignore[operator]
    with pytest.raises(ValueError, match=error):
        _theme("broken", body)


# --- choosing a theme ----------------------------------------------------------


@pytest.mark.parametrize(
    ("flag", "env", "expected"),
    [
        (None, {}, DEFAULT_THEME),
        (None, {"TG_THEME": ""}, DEFAULT_THEME),
        (None, {"TG_THEME": NAMES[-1]}, NAMES[-1]),
        (NAMES[-1], {"TG_THEME": NAMES[0]}, NAMES[-1]),
        (NAMES[-1], {"TG_THEME": "nope"}, NAMES[-1]),  # the flag wins; TG_THEME is not read
        (f" {NAMES[-1].upper()} ", {}, NAMES[-1]),
    ],
)
def test_flag_beats_env_beats_default(flag: str | None, env: dict[str, str], expected: str) -> None:
    assert theme_name(flag, env) == expected


@pytest.mark.parametrize(
    ("flag", "env", "expected"),
    [
        (None, {}, "nord"),
        (None, {"TG_THEME": "dracula"}, "dracula"),
        ("kanagawa256", {"TG_THEME": "dracula"}, "kanagawa256"),
    ],
)
def test_config_theme_sits_between_tg_theme_and_the_default(
    flag: str | None, env: dict[str, str], expected: str
) -> None:
    assert theme_name(flag, env, configured="nord") == expected


@pytest.mark.parametrize(("value", "expected"), [('"nord"', "nord"), ('" Nord256 "', "nord256")])
def test_config_toml_theme_is_read(tmp_path: Path, value: str, expected: str) -> None:
    path = tmp_path / "config.toml"
    path.write_text(f"theme = {value}\n")
    assert load_config(path).theme == expected


@pytest.mark.parametrize("value", ['"nope"', "3"])
def test_config_toml_unknown_theme_names_the_file_and_the_list(tmp_path: Path, value: str) -> None:
    path = tmp_path / "config.toml"
    path.write_text(f"theme = {value}\n")
    with pytest.raises(UsageError, match="is not a theme") as info:
        load_config(path)
    assert str(info.value).startswith(f"{path}: theme ")
    assert info.value.hint == f"use one of: {', '.join(NAMES)}"


@pytest.mark.parametrize(
    ("flag", "env", "source"), [("nope", {}, "--theme"), (None, {"TG_THEME": "nope"}, "TG_THEME")]
)
def test_unknown_theme_is_a_usage_error_listing_the_themes(
    flag: str | None, env: dict[str, str], source: str
) -> None:
    with pytest.raises(UsageError, match=f"{source} 'nope' is not a theme") as info:
        theme_name(flag, env)
    assert info.value.hint == f"use one of: {', '.join(NAMES)}"


@pytest.mark.parametrize("name", NAMES)
def test_truecolor_paints_the_themes_own_hex(name: str) -> None:
    r, g, b = rgb(themes()[name].roles["accent"])
    assert Style("truecolor", name)("accent", "me") == f"\x1b[38;2;{r};{g};{b}mme\x1b[0m"


def test_sixteen_colours_are_the_same_in_every_theme() -> None:
    lines = {tuple(sample_block(Style("16", name))) for name in NAMES}
    assert len(lines) == 1


def test_choose_style_carries_the_theme() -> None:
    env = {"COLORTERM": "truecolor"}
    assert choose_style("always", isatty=False, env=env, theme=NAMES[-1]).theme == NAMES[-1]


# --- the preview ----------------------------------------------------------------


@pytest.mark.parametrize("name", NAMES)
def test_preview_block_strips_to_the_plain_sample(name: str) -> None:
    painted = sample_block(Style("truecolor", name))
    assert [strip_ansi(line) for line in painted] == sample_block(PLAIN)
    assert all("\x1b[" in line for line in painted)


def test_preview_sample_uses_placeholder_names_only() -> None:
    text = "\n".join(sample_block(PLAIN))
    for placeholder in ("Ivan Petrov", "@example_bot", "Project team", "[topic:12]", "[photo"):
        assert placeholder in text


def tg(tmp_path: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    drop = {"NO_COLOR", "FORCE_COLOR", "TG_COLOR", "TG_THEME", "COLORTERM"}
    base = {k: v for k, v in os.environ.items() if k not in drop}
    return subprocess.run(  # noqa: S603 — fixed argv: this interpreter + the test's own args
        [sys.executable, "-c", "from tg_kit.cli import main; main()", *args],
        capture_output=True,
        text=True,
        env={**base, "TG_KIT_CONFIG_DIR": str(tmp_path), **env},
        timeout=60,
        check=False,
    )


def test_piped_preview_is_the_plain_names(tmp_path: Path) -> None:
    result = tg(tmp_path, "themes")
    assert result.returncode == 0
    assert result.stdout.splitlines() == NAMES


def test_forced_preview_paints_each_theme_on_its_background(tmp_path: Path) -> None:
    result = tg(tmp_path, "--color", "always", "themes")
    assert result.returncode == 0
    for name in NAMES:
        r, g, b = rgb(themes()[name].background)
        assert f"\x1b[48;2;{r};{g};{b}m" in result.stdout
        assert f"\x1b[1m{name}\x1b[0m" in result.stdout
    assert "\x1b[38;2;" in result.stdout  # truecolor although COLORTERM is unset


def test_preview_of_one_theme(tmp_path: Path) -> None:
    result = tg(tmp_path, "themes", NAMES[-1])
    assert result.stdout.splitlines() == [NAMES[-1]]


def test_preview_json_lists_the_themes(tmp_path: Path) -> None:
    result = tg(tmp_path, "--json", "themes")
    rows = json.loads(result.stdout)
    assert [r["name"] for r in rows] == NAMES
    assert [r["name"] for r in rows if r["default"]] == [DEFAULT_THEME]
    assert [r["name"] for r in rows if r["current"]] == [DEFAULT_THEME]


@pytest.mark.parametrize(
    ("args", "env", "current"),
    [
        ((), {}, "nord"),
        ((), {"TG_THEME": "dracula"}, "dracula"),
        (("--theme", "kanagawa"), {"TG_THEME": "dracula"}, "kanagawa"),
    ],
)
def test_current_theme_follows_flag_env_config(
    tmp_path: Path, args: tuple[str, ...], env: dict[str, str], current: str
) -> None:
    (tmp_path / "config.toml").write_text('theme = "nord"\n')
    rows = json.loads(tg(tmp_path, *args, "--json", "themes", **env).stdout)
    assert [r["name"] for r in rows if r["current"]] == [current]


def test_unknown_config_theme_exits_2_naming_the_file(tmp_path: Path) -> None:
    (tmp_path / "config.toml").write_text('theme = "nope"\n')
    result = tg(tmp_path, "accounts")
    assert result.returncode == 2
    assert result.stderr.splitlines() == [
        f"error: {tmp_path / 'config.toml'}: theme 'nope' is not a theme",
        f"  fix: use one of: {', '.join(NAMES)}",
    ]


@pytest.mark.parametrize(
    ("args", "env", "first"),
    [
        (("themes", "nope"), {}, "error: 'nope' is not a theme"),
        (("--theme", "nope", "accounts"), {}, "error: --theme 'nope' is not a theme"),
        (("accounts",), {"TG_THEME": "nope"}, "error: TG_THEME 'nope' is not a theme"),
    ],
)
def test_unknown_theme_exits_2_with_the_list(
    tmp_path: Path, args: tuple[str, ...], env: dict[str, str], first: str
) -> None:
    result = tg(tmp_path, *args, **env)
    assert result.returncode == 2
    assert result.stderr.splitlines() == [first, f"  fix: use one of: {', '.join(NAMES)}"]
