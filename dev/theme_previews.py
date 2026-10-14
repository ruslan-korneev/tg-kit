# ruff: noqa: INP001 — a dev script, not a package
"""Render `tg themes NAME` to SVG for the README: docs/media/themes/<name>.svg.

Runs the real command (`tg --color always themes NAME`) and turns its ANSI
output into an SVG: the theme's background rectangle, one <text> per coloured
span, positioned by terminal cell. Handles only what `tg themes` prints: SGR 0,
1, 38;2;r;g;b and 48;2;r;g;b. No dependency beyond the standard library.

    uv run python dev/theme_previews.py            # the base themes (no <name>256)
    uv run python dev/theme_previews.py nord       # one theme

Not part of the package. Rerun it after palettes/themes.json changes.
"""

from __future__ import annotations

import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/media/themes"

FONT_SIZE = 14
CELL_W = 8.4  # a monospace cell at 14px (0.6em), the usual advance of Menlo/DejaVu Sans Mono
LINE_H = 20
FONTS = "Menlo, Consolas, DejaVu Sans Mono, monospace"
PAD = 12
SGR = re.compile(r"\x1b\[([0-9;]*)m")
RESET, BOLD, FG, BG, RGB = 0, 1, 38, 48, 2


@dataclass
class Span:
    col: int
    text: str
    fg: str | None
    bg: str | None
    bold: bool


def cells(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def parse(line: str) -> list[Span]:
    spans: list[Span] = []
    fg = bg = None
    bold = False
    col = 0
    pos = 0
    for m in [*SGR.finditer(line), None]:
        end = m.start() if m else len(line)
        text = line[pos:end]
        if text:
            spans.append(Span(col, text, fg, bg, bold))
            col += cells(text)
        if m is None:
            break
        pos = m.end()
        codes = [int(c) for c in m.group(1).split(";") if c] or [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == RESET:
                fg = bg = None
                bold = False
            elif c == BOLD:
                bold = True
            elif c in {FG, BG} and codes[i + 1] == RGB:
                hexcode = "#{:02X}{:02X}{:02X}".format(*codes[i + 2 : i + 5])
                if c == FG:
                    fg = hexcode
                else:
                    bg = hexcode
                i += 4
            i += 1
    return spans


def svg(lines: list[list[Span]], background: str, foreground: str) -> str:
    width = max(s.col + cells(s.text) for line in lines for s in line)
    w = round(width * CELL_W + 2 * PAD)
    h = len(lines) * LINE_H + 2 * PAD
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
        f'<rect width="{w}" height="{h}" rx="6" fill="{background}"/>',
        f'<g font-family={FONTS!r} font-size="{FONT_SIZE}" xml:space="preserve">',
    ]
    for row, line in enumerate(lines):
        y = PAD + row * LINE_H + LINE_H * 0.72
        for s in line:
            text = s.text.strip()
            if not text:
                continue
            # textLength covers only the glyphs: the block's padding spaces counted in would
            # stretch a short message over the rest of the row
            lead = cells(s.text) - cells(s.text.lstrip())
            x = PAD + (s.col + lead) * CELL_W
            weight = ' font-weight="bold"' if s.bold else ""
            length = cells(text) * CELL_W
            parts.append(
                f'<text x="{x:.1f}" y="{y:.1f}" fill="{s.fg or foreground}"{weight} '
                f'textLength="{length:.1f}" lengthAdjust="spacingAndGlyphs">'
                f"{escape(text)}</text>"
            )
    parts += ["</g>", "</svg>", ""]
    return "\n".join(parts)


def render(name: str) -> Path:
    result = subprocess.run(  # noqa: S603 — fixed argv: this interpreter + a theme name
        [
            sys.executable,
            "-c",
            "from tg_kit.cli import main; main()",
            "--color",
            "always",
            "themes",
            name,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    block = [parse(line) for line in result.stdout.splitlines()[1:]]  # skip the header line
    first = next(s for s in block[0] if s.bg)
    background, foreground = first.bg, first.fg
    if background is None or foreground is None:
        msg = f"tg themes {name}: the block does not start on the theme's colours"
        raise SystemExit(msg)
    # the block's own 1-cell margin is drawn by PAD instead
    trimmed = [[Span(s.col - 1, s.text, s.fg, s.bg, s.bold) for s in line] for line in block]
    path = OUT / f"{name}.svg"
    path.write_text(svg(trimmed, background, foreground), encoding="utf-8")
    return path


def base_themes() -> list[str]:
    import json

    doc = json.loads((ROOT / "palettes/themes.json").read_text("utf-8"))
    return list(doc["themes"])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or base_themes():
        print(render(name).relative_to(ROOT))  # noqa: T201 — a dev script's report


if __name__ == "__main__":
    main()
