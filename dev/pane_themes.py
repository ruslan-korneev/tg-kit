# ruff: noqa: INP001 — a dev script, not a package
"""Write the pane's copy of the theme catalogue: mods/dialogs-pane/hooks/ui/themes.ts.

The engine loads only script files from a plugin (.ts, .js, …), never a .json, so
the pane carries palettes/themes.json as a module: the file's bytes, unchanged,
after `export const CATALOGUE = `. tests/unit/test_themes_shared.py pins that
object to the source byte for byte.

    uv run python dev/pane_themes.py

Not part of the package. Rerun it after palettes/themes.json changes.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "palettes/themes.json"
TARGET = ROOT / "mods/dialogs-pane/hooks/ui/themes.ts"

HEADER = """\
// Written by dev/pane_themes.py from palettes/themes.json: do not edit, rerun it.
// The theme catalogue (docs/design/dialogs-pane-ux.md §10.2). The engine loads no
// .json file from a plugin, so the file's bytes sit here as a module, and
// tests/unit/test_themes_shared.py pins them to the source. palette.ts reads it.
"""
OPEN = "export const CATALOGUE = "
CLOSE = " as const\n"


def render(source: str) -> str:
    return HEADER + OPEN + source.removesuffix("\n") + CLOSE


def main() -> None:
    TARGET.write_text(render(SOURCE.read_text("utf-8")), "utf-8")


if __name__ == "__main__":
    main()
