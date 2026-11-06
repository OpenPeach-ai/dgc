"""Invisible characters in text someone pasted, and taking them out.

A paste can carry characters with no visible glyph. Most are harmless residue from a web page,
but three kinds are not: bidirectional overrides reorder how text DISPLAYS without changing its
bytes, so what a reader sees and what the model reads can differ; tag characters encode a whole
ASCII string inside something that renders as nothing; and zero-width characters pad text
invisibly. DGC feeds a paste to a model and then acts on it, so text that hides instructions from
the person who pasted it is a real problem, not untidiness.

This module is the ONE definition of that for Python, and editors/vscode/media/pasteclean.js is its
mirror for the editor's prompt boxes, so the surfaces cannot drift into slightly different answers.
tests/test_invisible_characters.py holds the two together. The rule is: a paste is cleaned as it
lands, and a short line says how many characters went. Text someone typed stays as they typed it.

The hard part is not finding invisible characters, it is NOT breaking ordinary text. Arabic, Persian
and Hebrew legitimately carry directional marks; every multi-person emoji is held together by zero
width joiners; the subdivision flags are built from tag characters; our own dgc/logo.py is 86
braille blanks. None of those are touched, and none raise the line.
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
# Legal inside emoji and in Indic/Persian/Arabic shaping, where they follow a character of those
# scripts, all of which stand at U+0590 or later. After anything earlier (ASCII, Latin, Greek,
# Cyrillic, a space, or nothing at all) they have no typographic job and only hide something.
_JOINERS = frozenset((0x200C, 0x200D))
_JOINER_USERS_FROM = 0x0590
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
_LINE_BREAK = re.compile("\r\n?|[\u2028\u2029]")
_LEADING_BLANK_LINES = re.compile(r"^(?:[^\S\n]*\n)+")

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
    lets a dropped neighbour change the verdict on the next pass, and then one pass is not enough.
    """
    source = str(text or "")
    points = list(source)
    rtl = bool(_STRONG_RTL.search(source))
    counts: dict[str, int] = {}
    keep: list[str] = []

    def bump(category: str, n: int = 1) -> None:
        counts[category] = counts.get(category, 0) + n

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
            if keep and ord(keep[-1]) >= _JOINER_USERS_FROM:
                keep.append(points[i])        # emoji, Indic and Persian shaping keep theirs
            else:
                bump("zero-width")
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
    """One line for a reader: what is already gone, as information. Empty when nothing was taken."""
    n = total(counts)
    if not n:
        return ""
    return f"Removed {n} invisible character{'' if n == 1 else 's'} from the pasted text"


def line_breaks(text) -> str:
    """Every way a line can end, as a newline. Blank lines stay what they are."""
    return _LINE_BREAK.sub("\n", str(text or ""))


def clean_paste(text) -> tuple[str, str]:
    """A paste as it should land: `(the text, the line saying what was taken, or "")`."""
    counts, clean = classify(line_breaks(text))
    return clean, notice(counts)


def trim_draft(text) -> str:
    """A draft as a message: no blank lines around it and no trailing space, and the first line's
    indentation kept, because a pasted block's first line is as indented as the rest. A command
    is read from its words, so a draft that opens with one (`/`, `!`, `#`) loses it as before."""
    body = _LEADING_BLANK_LINES.sub("", str(text or "")).rstrip()
    return body.lstrip() if body.lstrip().startswith(("/", "!", "#")) else body
