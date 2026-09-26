"""Invisible characters in text someone pasted, and what to do about them.

A paste can carry characters with no visible glyph. Most are harmless residue from a web page,
but three kinds are not: bidirectional overrides reorder how text DISPLAYS without changing its
bytes, so what a reader sees and what the model reads can differ; tag characters encode a whole
ASCII string inside something that renders as nothing; and zero-width characters pad text
invisibly. DGC feeds a paste to a model and then acts on it, so text that hides instructions from
the person who pasted it is a real problem, not untidiness.

This module is the ONE definition of that, so the panel, the TUI and the backend cannot drift into
three slightly different answers. The rule is: count and report, never strip on your own. Silently
altering what someone pasted is its own bug.

The hard part is not finding invisible characters, it is NOT crying wolf. Arabic, Persian and
Hebrew legitimately carry directional marks; every multi-person emoji is held together by zero
width joiners; the subdivision flags are built from tag characters; our own dgc/logo.py is 86
braille blanks. A notice that fires on any of those teaches the reader to dismiss it, which is
worse than having no notice at all.
"""
from __future__ import annotations

import re

# Reorder how text displays without changing its bytes -- the "Trojan Source" class. Never legal
# in a prompt: there is no reason to embed one in text you are handing to a model.
_OVERRIDES = frozenset(range(0x202A, 0x202F)) | frozenset(range(0x2066, 0x206A))
# Directional MARKS are different: ordinary RTL prose uses them. Judged against the text.
_MARKS = frozenset((0x200E, 0x200F, 0x061C))
_ZERO_WIDTH = frozenset((0x200B, 0x2060, 0xFEFF, 0x00AD, 0x180E, 0x034F,
                         0x115F, 0x1160, 0x3164, 0xFFA0))
# Legal inside emoji and in Indic/Persian shaping; suspicious only between ASCII word characters,
# where they have no typographic job and exist to break up a word the reader thinks they can see.
_JOINERS = frozenset((0x200C, 0x200D))
_TAGS = frozenset(range(0xE0000, 0xE0080))
_HIDDEN_MARKS = frozenset(range(0xE0100, 0xE01F0))     # variation selectors 17-256
_CONTROL = ((frozenset(range(0x20)) | {0x7F} | frozenset(range(0x80, 0xA0)))
            - {0x09, 0x0A, 0x0D})                      # tab, newline and CR are ordinary text

# U+061C (ALM) and U+FEFF (BOM) sit inside the naive RTL ranges, so a class written the obvious way
# lets each of them vouch for itself and suppress its own flag. Both are excluded here.
_STRONG_RTL = re.compile(
    "[֐-׿؀-؛؝-ۿ܀-ݏހ-޿"
    "ࡠ-ࣿיִ-﷿ﹰ-﻾"
    "\U00010800-\U00010FFF\U0001E800-\U0001EFFF]")
_ASCII_WORD = re.compile("[0-9A-Za-z]")

# The ONLY tag sequences Unicode actually defines: the three subdivision flags. Anything else
# shaped like a flag is a payload wearing a costume -- checking the SHAPE (leading U+1F3F4, tag
# letters, trailing U+E007F) accepts any hidden string prefixed with a flag, which is a
# one-character bypass of the exact thing this is here to catch.
_RGI_TAG_SEQUENCES = frozenset(("gbeng", "gbsct", "gbwls"))

CATEGORIES = ("bidi", "hidden", "zero-width", "control")


def _tag_letters(run: list[str]) -> str:
    """The ASCII a tag run spells, or '' if any codepoint is outside the tag-letter block."""
    out = []
    for char in run:
        point = ord(char)
        if not 0xE0020 <= point <= 0xE007E:
            return ""
        out.append(chr(point - 0xE0000))
    return "".join(out)


def classify(text) -> tuple[dict[str, int], str]:
    """Return `(category -> codepoints found, the text with those removed)`.

    ONE walk, so the count and the removal can never disagree. Two walks drift, and then the
    notice says 16 while the strip takes 14 and the reader stops believing it. The count is in
    CODEPOINTS, not UTF-16 units: a tag character is one thing the reader cannot see, not two.

    The removal is a fixed point -- classify(classify(t)[1])[0] is empty for every t -- because
    the joiner rule reads the text that SURVIVES rather than the original. Reading the original
    lets a dropped neighbour change the verdict on the next pass, and then one click is not enough
    to clean the box.
    """
    source = str(text or "")
    points = list(source)
    rtl = bool(_STRONG_RTL.search(source))
    counts: dict[str, int] = {}
    keep: list[str] = []

    def bump(category: str, n: int = 1) -> None:
        counts[category] = counts.get(category, 0) + n

    def next_kept(start: int) -> str:
        """The next codepoint that will survive, so the joiner rule is stable under re-running."""
        for j in range(start, len(points)):
            point = ord(points[j])
            if point in _JOINERS:
                continue                      # undecided; keep looking past it
            if (point in _OVERRIDES or point in _ZERO_WIDTH or point in _CONTROL
                    or point in _HIDDEN_MARKS or (point in _MARKS and not rtl)):
                continue
            return points[j]
        return ""

    i = 0
    while i < len(points):
        point = ord(points[i])
        if point in _TAGS:
            j = i
            while j < len(points) and ord(points[j]) in _TAGS:
                j += 1
            run = points[i:j]
            spelled = _tag_letters(run[:-1]) if run and ord(run[-1]) == 0xE007F else ""
            flag = i > 0 and ord(points[i - 1]) == 0x1F3F4
            if flag and spelled in _RGI_TAG_SEQUENCES:
                keep.extend(run)              # a real subdivision flag, rendered as one glyph
            else:
                bump("hidden", len(run))
            i = j
            continue
        if point in _OVERRIDES:
            bump("bidi"); i += 1; continue
        if point in _MARKS:
            # A directional mark in text that has no RTL in it is doing nothing a reader can see.
            if rtl: keep.append(points[i])
            else: bump("bidi")
            i += 1; continue
        if point in _JOINERS:
            before = keep[-1] if keep else ""
            after = next_kept(i + 1)
            if _ASCII_WORD.search(before or "") and _ASCII_WORD.search(after or ""):
                bump("zero-width")
            else:
                keep.append(points[i])        # emoji, Indic and Persian shaping keep theirs
            i += 1; continue
        if point in _ZERO_WIDTH:
            bump("zero-width"); i += 1; continue
        if point in _HIDDEN_MARKS:
            bump("hidden"); i += 1; continue
        if point in _CONTROL:
            bump("control"); i += 1; continue
        keep.append(points[i]); i += 1
    return counts, "".join(keep)


def total(counts: dict[str, int]) -> int:
    return sum(counts.values())


def notice(counts: dict[str, int]) -> str:
    """One line for a reader, naming the count and -- only when earned -- why it matters."""
    n = total(counts)
    if not n:
        return ""
    line = f"Remove {n} invisible character{'' if n == 1 else 's'}"
    # Say "hidden instruction" only for the classes that can actually carry one. Saying it for a
    # stray BOM from a web page would be the crying-wolf failure in a different costume.
    risky = counts.get("bidi", 0) + counts.get("hidden", 0)
    if risky:
        line += f" — {risky} can carry a hidden instruction"
    return line
