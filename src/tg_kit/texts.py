"""Splitting long message text. Pure."""

from __future__ import annotations

__all__ = ["CAPTION_LIMIT", "TEXT_LIMIT", "split_text"]

# Telegram's limits for a message and a media caption (non-premium), in characters.
TEXT_LIMIT = 4096
CAPTION_LIMIT = 1024


def split_text(text: str, limit: int = TEXT_LIMIT) -> list[str]:
    """Chunks of at most `limit` chars, cut at a paragraph, else a line, else a word.

    The limit is on the source text. With Markdown/HTML parsing the sent text
    is shorter (markup is stripped), so a chunk never exceeds the real limit;
    a markup span cut across chunks is the price, and why a paragraph break is
    tried first.
    """
    chunks: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for sep in ("\n\n", "\n", " "):
            cut = window.rfind(sep)
            if cut > 0:
                chunks.append(rest[:cut].rstrip())
                rest = rest[cut + len(sep) :].lstrip("\n")
                break
        if cut <= 0:  # one unbroken run longer than the limit
            chunks.append(window)
            rest = rest[limit:]
    if rest.strip():
        chunks.append(rest)
    return chunks
