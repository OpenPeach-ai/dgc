"""Slides: a deck DGC lays out from data the model writes (an artifact's ``deck.json``).

The model never writes a slide's markup. It hands over what each slide says and which layout it takes (title,
section, bullets, two_columns, image, chart, quote, table or closing) and a theme, and this module lays it out the
same way every time:

- ``render_html``: one standalone page, to view (every slide stacked, each in its exact shape) or to present (one
  slide at a time, full screen). Inline CSS, the system's own fonts, images as data: URIs and charts drawn here as
  SVG, so nothing loads from anywhere; presenting needs only a small inline script, which carries a nonce.
- ``export_pptx``: a real PowerPoint file: the theme's colours and fonts, native tables, native charts that keep
  their numbers (an embedded workbook, so Edit Data works), pictures, and speaker notes on the notes pages.
- ``export_pdf``: one slide a page, printed by the user's Chrome or Edge the way ChatDGC prints its PDFs; without
  one, a plain built-in writer that says so.

Text is fitted before it is drawn. Every title, list, quote and table gets the largest of a few sizes at which it
fits its box, measured with Helvetica's metrics (which Arial and Liberation Sans share) and a margin for the wider
system fonts, so a long slide shrinks or wraps rather than running off the edge, and PowerPoint gets the same sizes
the page uses.

``normalize`` checks a deck and fills its defaults; its errors name the slide and the field and say what to change,
in words a small local model can act on. ``apply_edits`` is the ``edit_artifact`` tool's: replace, insert, delete,
move, set a field, change the theme.

Standard library and DGC's own pieces only: ``dgc.chatdgc.made``'s OOXML helpers, limits and workbook writer, and
``dgc.browser`` to print.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import html
import json
import math
import os
import re
import secrets
import string
import struct
import tempfile
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .chatdgc import made

LAYOUTS = ("title", "section", "bullets", "two_columns", "image", "chart", "quote", "table", "closing")
THEMES = ("paper", "dusk", "bold", "plain")
SIZES = {"16:9": (1280, 720), "4:3": (960, 720)}       # the design grid: 1 unit is one CSS px at 96 dpi
SLIDE_FIELDS = ("layout", "title", "subtitle", "bullets", "left", "right", "image", "chart", "quote", "table", "notes")
CHART_TYPES = ("bar", "line", "area", "pie", "scatter")
EDIT_OPS = ("replace", "insert", "delete", "move", "set", "theme")
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".svg": "image/svg+xml"}

MAX_SLIDES = made.MAX_SLIDES
MAX_BULLETS = made.MAX_BULLETS
MAX_SUB = 6                   # sub-points under one bullet
MAX_SIDE_BULLETS = 6          # beside an image or a chart
MAX_COLUMN_BULLETS = 8        # in each of two columns
MAX_SLIDE_TEXT = 1000         # characters of bullets on one slide, both columns together
MAX_TABLE_COLUMNS = 8
MAX_TABLE_ROWS = 15
MAX_SERIES = 8                # the chart limits are ChatDGC's (editors/vscode/media/chart.js)
MAX_POINTS = 60
MAX_SCATTER = 500
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_DECK_IMAGE_BYTES = 30 * 1024 * 1024      # base64 makes it ~40 MB, inside the store's 50 MB a version
MAX_EDITS = 50
LIMITS = {"title": 160, "subtitle": 240, "bullet": 300, "sub": 240, "heading": 80, "quote": 500, "by": 120,
          "caption": 200, "alt": 300, "notes": 6000, "cell": 120, "column": 60, "name": 60}

# The content each layout shows; a field on a slide whose layout doesn't show it is refused, not dropped.
_CONTENT = {"title": (), "section": (), "closing": (), "bullets": ("bullets",), "two_columns": ("left", "right"),
            "image": ("image", "bullets"), "chart": ("chart", "bullets"), "quote": ("quote",), "table": ("table",)}
_BELONGS = {"bullets": "a bullets slide (or beside an image or a chart)", "left": "a two_columns slide",
            "right": "a two_columns slide", "image": "an image slide", "chart": "a chart slide",
            "quote": "a quote slide", "table": "a table slide"}
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")
_HEX = re.compile(r"#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})\Z")
_FONT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 \-]{0,40}\Z")


class SlidesError(ValueError):
    """A deck or an edit that can't be used as given; the text names the slide and the field, and what to change."""


@dataclass
class PdfExport:
    path: str
    pages: int
    note: str = ""          # something the user should know (made without a browser)


# =========================================================================== normalize

def normalize(deck, *, base=None, resolve=None) -> dict:
    """The deck, checked and complete: {"size", "theme", "slides"}, each slide with its layout and only the fields
    it shows. Images are embedded as data: URIs (a relative path is read from ``base``, or the working folder).
    ``resolve``, when given, turns a picture's path into the file to read and raises if it may not be read (the
    tool passes its workspace rule: a path outside the project needs the user's approval); its error's text is
    what the model is told. Content that can't fit its slide even in the smallest type is refused, naming the
    slide. Normalizing a normalized deck gives it back unchanged."""
    if isinstance(deck, (str, bytes)):
        try:
            deck = json.loads(deck)
        except ValueError as error:
            raise SlidesError(f"The deck isn't valid JSON ({error}).") from None
    if isinstance(deck, list):
        deck = {"slides": deck}
    if not isinstance(deck, dict):
        raise SlidesError('A deck is an object: {"size": "16:9", "theme": "paper", "slides": [{"layout": "title", '
                          '"title": "…"}, …]}.')
    for key in deck:
        if key not in ("size", "theme", "slides"):
            raise SlidesError(f'A deck has "size", "theme" and "slides"; "{str(key)[:40]}" isn\'t one of them. '
                              "Put text on a slide.")
    size = _size(deck.get("size"))
    theme = _theme_value(deck.get("theme"))
    slides = deck.get("slides")
    if not isinstance(slides, list) or not slides:
        raise SlidesError('Give the deck its slides: "slides": [{"layout": "title", "title": "…"}, {"layout": '
                          '"bullets", "title": "…", "bullets": ["…"]}].')
    if len(slides) > MAX_SLIDES:
        raise SlidesError(f"The deck has {len(slides)} slides; a deck holds at most {MAX_SLIDES}. Split it in two.")
    reading = {"base": base, "resolve": resolve, "bytes": 0}      # where pictures come from, and how much
    out = [_slide(raw, n, reading) for n, raw in enumerate(slides, 1)]
    deck = {"size": size, "theme": theme, "slides": out}
    for n, plan in enumerate(_plans(deck, _look(theme)), 1):
        if plan.get("overflow"):
            raise SlidesError(f"Slide {n}'s {plan['overflow'][0]} on a {size} slide even in small type. "
                              f"{plan['overflow'][1]}")
    return deck


def _size(value) -> str:
    if value in (None, ""):
        return "16:9"
    text = str(value).strip().lower().replace("x", ":").replace("/", ":")
    text = {"widescreen": "16:9", "wide": "16:9", "standard": "4:3"}.get(text, text)
    if text not in SIZES:
        raise SlidesError(f'size is "16:9" or "4:3", not "{str(value)[:20]}".')
    return text


def _color(value, where: str) -> str:
    match = _HEX.match(str(value or "").strip())
    if not match:
        raise SlidesError(f'{where} is a colour like "#1F2937"; "{str(value)[:20]}" isn\'t one.')
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    return "#" + digits.lower()


def _theme_value(value):
    if value in (None, ""):
        return "paper"
    if isinstance(value, str):
        name = value.strip().lower()
        if name not in THEMES:
            raise SlidesError(f'theme is one of {", ".join(THEMES)}, or your own colours: {{"bg": "#…", "fg": "#…", '
                              f'"accent": "#…", "muted": "#…", "font": "…"}}; "{value[:30]}" isn\'t one.')
        return name
    if not isinstance(value, dict):
        raise SlidesError('theme is a name ("paper", "dusk", "bold", "plain") or {"bg", "fg", "accent", "muted", '
                          '"font"}.')
    for key in value:
        if key not in ("bg", "fg", "accent", "muted", "font"):
            raise SlidesError(f'A theme has bg, fg, accent, muted and font; "{str(key)[:30]}" isn\'t one of them.')
    for key in ("bg", "fg", "accent"):
        if not value.get(key):
            raise SlidesError(f'A theme of your own needs "{key}" (a colour like "#1F2937").')
    out = {key: _color(value[key], f"The theme's {key}") for key in ("bg", "fg", "accent")}
    ratio = _contrast(out["fg"][1:], out["bg"][1:])
    if ratio < 4.5:
        raise SlidesError(f"The theme's fg on its bg has a contrast of {ratio:.1f}:1; text needs at least 4.5:1. "
                          "Make one of them much darker or lighter.")
    if value.get("muted"):
        out["muted"] = _color(value["muted"], "The theme's muted")
    font = value.get("font")
    if font not in (None, ""):
        font = " ".join(str(font).replace('"', "").replace("'", "").split())
        if not _FONT_NAME.match(font):
            raise SlidesError(f'The theme\'s font is one font family\'s name, like "Inter" or "Georgia", or "serif" '
                              f'or "sans-serif"; "{str(value.get("font"))[:40]}" isn\'t.')
        out["font"] = font
    return out


def _empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _line(value, where: str, kind: str, *, required: bool = False) -> str:
    if value is None:
        value = ""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SlidesError(f"{where} should be text.")
    text = " ".join(_CTRL.sub(" ", str(value)).split())
    limit = LIMITS[kind]
    if len(text) > limit:
        raise SlidesError(f"{where} is {len(text)} characters; keep it to {limit} or fewer (shorten it, or move the "
                          "detail into the speaker notes).")
    if required and not text:
        raise SlidesError(f"{where} is empty.")
    return text


def _notes(value, where: str) -> str:
    if _empty(value):
        return ""
    if not isinstance(value, str):
        raise SlidesError(f"{where} are text.")
    text = _CTRL.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in text.split("\n"))).strip()
    if len(text) > LIMITS["notes"]:
        raise SlidesError(f"{where} are {len(text)} characters; keep a slide's notes to {LIMITS['notes']}.")
    return text


def _infer(raw: dict, n: int) -> str:
    for key, layout in (("chart", "chart"), ("table", "table"), ("image", "image"), ("quote", "quote"),
                        ("left", "two_columns"), ("right", "two_columns"), ("bullets", "bullets")):
        if not _empty(raw.get(key)):
            return layout
    return "title" if n == 1 else "section"


def _slide(raw, n: int, reading: dict) -> dict:
    where = f"Slide {n}"
    if isinstance(raw, str):
        raw = {"title": raw}
    if not isinstance(raw, dict):
        raise SlidesError(f'{where} should be an object like {{"layout": "bullets", "title": "…", "bullets": ["…"]}}.')
    for key in raw:
        if key not in SLIDE_FIELDS:
            raise SlidesError(f'{where} has "{str(key)[:30]}", which a slide doesn\'t have. A slide\'s fields are: '
                              f'{", ".join(SLIDE_FIELDS)}.')
    layout = raw.get("layout")
    if _empty(layout):
        layout = _infer(raw, n)
    layout = str(layout).strip().lower().replace("-", "_").replace(" ", "_")
    layout = {"two_column": "two_columns", "columns": "two_columns", "end": "closing", "cover": "title"}.get(layout, layout)
    if layout not in LAYOUTS:
        raise SlidesError(f'{where}\'s layout is one of {", ".join(LAYOUTS)}; "{str(raw.get("layout"))[:30]}" isn\'t.')
    for key in ("bullets", "left", "right", "image", "chart", "quote", "table"):
        if not _empty(raw.get(key)) and key not in _CONTENT[layout]:
            raise SlidesError(f'{where} is a {layout} slide, which doesn\'t show "{key}": {key} belongs on '
                              f"{_BELONGS[key]}. Change its layout, or remove {key}.")
    slide: dict = {"layout": layout}
    title = _line(raw.get("title"), f"{where}'s title", "title")
    subtitle = _line(raw.get("subtitle"), f"{where}'s subtitle", "subtitle")
    if title:
        slide["title"] = title
    if subtitle:
        slide["subtitle"] = subtitle
    if layout in ("title", "section") and not title:
        raise SlidesError(f"{where} is a {layout} slide with no title: give it a title.")
    if layout == "closing" and not (title or subtitle):
        raise SlidesError(f'{where} is a closing slide with nothing on it: give it a title (like "Questions?") '
                          "and, if you like, a subtitle.")
    if layout == "bullets":
        slide["bullets"] = _bullets(raw.get("bullets"), where, MAX_BULLETS, required=True)
    elif layout in ("image", "chart") and not _empty(raw.get("bullets")):
        slide["bullets"] = _bullets(raw.get("bullets"), where, MAX_SIDE_BULLETS, required=False,
                                    beside=f"beside the {layout}")
        if not slide["bullets"]:
            del slide["bullets"]
    if layout == "two_columns":
        for side in ("left", "right"):
            column = _column(raw.get(side), f"{where}'s {side} column")
            if column is None:
                raise SlidesError(f'{where} is a two_columns slide: give it both "left" and "right" ({{"heading": '
                                  '"…", "bullets": ["…"]}}), or make it a bullets slide.')
            slide[side] = column
    if layout == "image":
        if _empty(raw.get("image")):
            raise SlidesError(f'{where} is an image slide with no image: give it "image": {{"src": "path/to/'
                              'picture.png", "alt": "what it shows"}}.')
        slide["image"] = _image(raw["image"], f"{where}'s image", reading)
    if layout == "chart":
        if _empty(raw.get("chart")):
            raise SlidesError(f'{where} is a chart slide with no chart: give it "chart": {{"type": "bar", "x": '
                              '["Q1", "Q2"], "series": [{"name": "Revenue", "values": [120, 140]}]}}.')
        slide["chart"] = _chart(raw["chart"], f"{where}'s chart")
    if layout == "quote":
        slide["quote"] = _quote(raw.get("quote"), f"{where}'s quote")
    if layout == "table":
        slide["table"] = _table(raw.get("table"), f"{where}'s table")
    words = sum(_bullet_chars(b) for key in ("bullets",) for b in slide.get(key, []))
    words += sum(_bullet_chars(b) for side in ("left", "right") for b in slide.get(side, {}).get("bullets", []))
    if words > MAX_SLIDE_TEXT:
        raise SlidesError(f"{where} has {words:,} characters of bullets; a slide holds about {MAX_SLIDE_TEXT:,} and "
                          "stays readable. Split it across two slides, or move the detail into the speaker notes.")
    notes = _notes(raw.get("notes"), f"{where}'s notes")
    if notes:
        slide["notes"] = notes
    return slide


def _bullet_chars(bullet) -> int:
    text, subs = _bt(bullet)
    return len(text) + sum(len(s) for s in subs)


def _bt(bullet) -> tuple[str, list]:
    if isinstance(bullet, dict):
        return bullet.get("text", ""), list(bullet.get("sub") or [])
    return bullet, []


def _bullets(raw, where: str, limit: int, *, required: bool, beside: str = "") -> list:
    if _empty(raw):
        if required:
            raise SlidesError(f'{where} is a bullets slide with no bullets: add "bullets": ["…", "…"], or make it a '
                              "section slide.")
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise SlidesError(f'{where}\'s bullets are a list: ["…", {{"text": "…", "sub": ["…"]}}].')
    out = []
    for i, item in enumerate(raw, 1):
        at = f"{where}'s bullet {i}"
        if isinstance(item, dict):
            for key in item:
                if key not in ("text", "sub"):
                    raise SlidesError(f'{at} has "{str(key)[:30]}"; a bullet is text, or {{"text": "…", "sub": '
                                      '["…"]}.')
            text = _line(item.get("text"), at, "bullet")
            subs_raw = item.get("sub")
            subs_raw = [] if _empty(subs_raw) else [subs_raw] if isinstance(subs_raw, str) else subs_raw
            if not isinstance(subs_raw, list):
                raise SlidesError(f'{at}\'s sub-points are a list of text: "sub": ["…", "…"].')
            subs = [s for s in (_line(x, f"{at}, sub-point {j}", "sub") for j, x in enumerate(subs_raw, 1)) if s]
            if len(subs) > MAX_SUB:
                raise SlidesError(f"{at} has {len(subs)} sub-points; keep a bullet to {MAX_SUB}.")
            if not text and not subs:
                continue
            if not text:
                raise SlidesError(f"{at} has sub-points but no text of its own.")
            out.append({"text": text, "sub": subs} if subs else text)
        else:
            text = _line(item, at, "bullet")
            if text:
                out.append(text)
    if len(out) > limit:
        place = f" {beside}" if beside else ""
        raise SlidesError(f"{where} has {len(out)} bullets{place}; keep it to {limit} or split it across two slides.")
    if required and not out:
        raise SlidesError(f"{where} is a bullets slide whose bullets are all empty: give them text.")
    return out


def _column(raw, where: str):
    if _empty(raw):
        return None
    if isinstance(raw, (list, str)):
        raw = {"bullets": raw}
    if not isinstance(raw, dict):
        raise SlidesError(f'{where} should be {{"heading": "…", "bullets": ["…"]}}.')
    for key in raw:
        if key not in ("heading", "bullets"):
            raise SlidesError(f'{where} has "{str(key)[:30]}"; a column has "heading" and "bullets".')
    heading = _line(raw.get("heading"), f"{where}'s heading", "heading")
    bullets = _bullets(raw.get("bullets"), where, MAX_COLUMN_BULLETS, required=False, beside="")
    if not heading and not bullets:
        return None
    column = {}
    if heading:
        column["heading"] = heading
    if bullets:
        column["bullets"] = bullets
    return column


def _quote(raw, where: str) -> dict:
    if isinstance(raw, str):
        raw = {"text": raw}
    if not isinstance(raw, dict) or _empty(raw.get("text")):
        raise SlidesError(f'{where} needs its words: "quote": {{"text": "…", "by": "who said it"}}.')
    for key in raw:
        if key not in ("text", "by"):
            raise SlidesError(f'{where} has "{str(key)[:30]}"; a quote has "text" and "by".')
    text = _line(raw.get("text"), where, "quote", required=True).strip("\"“”'")
    quote = {"text": text}
    by = _line(raw.get("by"), f"{where}'s by", "by").lstrip("—–- ")
    if by:
        quote["by"] = by
    return quote


def _cell(value, where: str):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else ""
    return _line(value, where, "cell")


def _table(raw, where: str) -> dict:
    if isinstance(raw, list) and raw and all(isinstance(r, list) for r in raw):
        raw = {"columns": raw[0], "rows": raw[1:]}            # ChatDGC's own deck writes a table as rows
    if not isinstance(raw, dict):
        raise SlidesError(f'{where} is {{"columns": ["…", "…"], "rows": [["…", 12], ["…", 14]]}}.')
    for key in raw:
        if key not in ("columns", "rows"):
            raise SlidesError(f'{where} has "{str(key)[:30]}"; a table has "columns" and "rows".')
    columns = raw.get("columns")
    if not isinstance(columns, list) or not columns:
        raise SlidesError(f'{where} needs its column headings: "columns": ["…", "…"].')
    if len(columns) > MAX_TABLE_COLUMNS:
        raise SlidesError(f"{where} has {len(columns)} columns; a slide's table holds at most {MAX_TABLE_COLUMNS}. "
                          "Drop some, or split the table.")
    heads = [_line(c, f"{where}'s column {i}", "column") for i, c in enumerate(columns, 1)]
    rows = raw.get("rows")
    if not isinstance(rows, list) or not rows:
        raise SlidesError(f'{where} needs rows: "rows": [["…", 12], ["…", 14]], one list per row.')
    if len(rows) > MAX_TABLE_ROWS:
        raise SlidesError(f"{where} has {len(rows)} rows; a slide's table holds at most {MAX_TABLE_ROWS}. Split it "
                          "across two slides, or keep the rows that matter.")
    out = []
    for r, row in enumerate(rows, 1):
        if not isinstance(row, list):
            raise SlidesError(f"{where}'s row {r} should be a list of cells, one per column.")
        if len(row) > len(heads):
            raise SlidesError(f"{where}'s row {r} has {len(row)} cells but the table has {len(heads)} columns.")
        cells = [_cell(c, f"{where}'s row {r}, cell {i}") for i, c in enumerate(row, 1)]
        out.append(cells + [""] * (len(heads) - len(cells)))
    return {"columns": heads, "rows": out}


def _num(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value.replace(",", "").strip())
        except ValueError:
            return None
        if not math.isfinite(parsed):
            return None
        return int(parsed) if parsed.is_integer() and abs(parsed) < 1e15 else parsed
    return None


def _chart_num(value, where: str):
    number = _num(value)
    if number is not None and abs(number) > 1e15:
        raise SlidesError(f"{where} is too large for a readable chart; keep its magnitude at or below 1 quadrillion.")
    return number


def _chart(raw, where: str) -> dict:
    """ChatDGC's chart spec, as chart.js reads it: {type, title, x, series: [{name, values}], unit, stacked,
    horizontal, x_label, y_label}; a scatter's series have "points": [[x, y], …]."""
    if not isinstance(raw, dict):
        raise SlidesError(f'{where} is {{"type": "bar", "x": ["Q1", "Q2"], "series": [{{"name": "Revenue", '
                          '"values": [120, 140]}]}.')
    kind = str(raw.get("type") or "bar").strip().lower()
    if kind not in CHART_TYPES:
        raise SlidesError(f'{where}\'s type is one of {", ".join(CHART_TYPES)}; "{kind[:20]}" isn\'t.')
    series_raw = raw.get("series")
    if not isinstance(series_raw, list) or not series_raw:
        raise SlidesError(f'{where} needs its numbers: "series": [{{"name": "…", "values": [12, 15]}}].')
    if len(series_raw) > MAX_SERIES:
        raise SlidesError(f"{where} has {len(series_raw)} series; a chart shows at most {MAX_SERIES}.")
    series = []
    for i, s in enumerate(series_raw, 1):
        if not isinstance(s, dict):
            raise SlidesError(f'{where}\'s series {i} should be {{"name": "…", "values": [numbers]}}.')
        name = " ".join(_CTRL.sub(" ", str(s.get("name") or f"Series {i}")).split())[:60] or f"Series {i}"
        if kind == "scatter":
            points = s.get("points")
            if not isinstance(points, list):
                raise SlidesError(f'{where}\'s series {i} is a scatter series: "points": [[x, y], …].')
            if len(points) > MAX_SCATTER:
                raise SlidesError(f"{where}'s series {i} has {len(points)} points; a scatter shows at most "
                                  f"{MAX_SCATTER} a series.")
            kept = []
            for p in points:
                if isinstance(p, (list, tuple)) and len(p) >= 2:
                    px, py = _chart_num(p[0], f"{where}'s series {i} x"), _chart_num(p[1], f"{where}'s series {i} y")
                    if px is not None and py is not None:
                        kept.append([px, py])
            series.append({"name": name, "points": kept})
        else:
            values = s.get("values")
            if not isinstance(values, list):
                raise SlidesError(f'{where}\'s series {i} needs "values": [numbers], one for each x.')
            if len(values) > MAX_POINTS:
                raise SlidesError(f"{where}'s series {i} has {len(values)} values; a chart shows at most "
                                  f"{MAX_POINTS}.")
            series.append({"name": name, "values": [_chart_num(v, f"{where}'s series {i} value") for v in values]})
    spec: dict = {"type": kind}
    title = " ".join(_CTRL.sub(" ", str(raw.get("title") or "")).split())[:120]
    if title:
        spec["title"] = title
    if kind == "scatter":
        if not any(s["points"] for s in series):
            raise SlidesError(f"{where} has no points that are two numbers each, [x, y].")
    else:
        x_raw = raw.get("x") if raw.get("x") is not None else raw.get("labels")
        x_raw = x_raw if isinstance(x_raw, list) else []
        if len(x_raw) > MAX_POINTS:
            raise SlidesError(f"{where} has {len(x_raw)} x values; a chart shows at most {MAX_POINTS}.")
        x = [" ".join(_CTRL.sub(" ", "" if v is None else str(v)).split())[:40] for v in x_raw]
        count = max([len(x)] + [len(s["values"]) for s in series])
        if not count or all(v is None for s in series for v in s["values"]):
            raise SlidesError(f'{where} has no numbers: each series needs "values" that are numbers.')
        while len(x) < count:
            x.append(str(len(x) + 1))
        for s in series:
            s["values"] += [None] * (count - len(s["values"]))
        if kind == "pie" and not any((v or 0) > 0 for v in series[0]["values"]):
            raise SlidesError(f"{where} is a pie with nothing above zero; a pie shows parts of a whole.")
        spec["x"] = x
    spec["series"] = series
    unit = " ".join(_CTRL.sub(" ", str(raw.get("unit") or "")).split())[:8]
    if unit:
        spec["unit"] = unit
    for key in ("x_label", "y_label"):
        label = " ".join(_CTRL.sub(" ", str(raw.get(key) or "")).split())[:60]
        if len(label) >= 3 and label != unit:           # a lone unit or symbol says nothing the ticks don't
            spec[key] = label
    if raw.get("stacked") is True and kind != "scatter":
        spec["stacked"] = True
    if raw.get("horizontal") is True and kind == "bar":
        spec["horizontal"] = True
    return spec


def _image(raw, where: str, reading: dict) -> dict:
    if isinstance(raw, str):
        raw = {"src": raw}
    if not isinstance(raw, dict):
        raise SlidesError(f'{where} is {{"src": "path/to/picture.png", "alt": "what it shows", "caption": "…"}}.')
    for key in raw:
        if key not in ("src", "alt", "caption"):
            raise SlidesError(f'{where} has "{str(key)[:30]}"; an image has "src", "alt" and "caption".')
    src = str(raw.get("src") or "").strip()
    if not src:
        raise SlidesError(f'{where} needs "src": the path of a picture in the project.')
    data, mime = _image_bytes(src, where, reading.get("base"), reading.get("resolve"))
    if len(data) > MAX_IMAGE_BYTES:
        raise SlidesError(f"{where} is {len(data) / 1048576:.1f} MB; a slide's picture can be at most "
                          f"{MAX_IMAGE_BYTES // 1048576} MB. Use a smaller copy.")
    reading["bytes"] = reading.get("bytes", 0) + len(data)
    if reading["bytes"] > MAX_DECK_IMAGE_BYTES:
        slide_name = where.split("'")[0]
        raise SlidesError(f"The deck's pictures add up to more than {MAX_DECK_IMAGE_BYTES // 1048576} MB (at "
                          f"{slide_name}). Use smaller or fewer pictures.")
    if _image_size(data, mime) is None:
        raise SlidesError(f"{where} doesn't read as a {mime.split('/')[1].upper().replace('+XML', '')} picture "
                          "(it may be damaged). Use another file.")
    image = {"src": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}
    alt = _line(raw.get("alt"), f"{where}'s alt", "alt")
    caption = _line(raw.get("caption"), f"{where}'s caption", "caption")
    if alt:
        image["alt"] = alt
    if caption:
        image["caption"] = caption
    return image


def _image_bytes(src: str, where: str, base, resolve=None) -> tuple[bytes, str]:
    if src.lower().startswith("data:"):
        match = re.match(r"data:(image/(?:png|jpeg|jpg|gif|webp|svg\+xml))(;[^,]*)?,(.*)\Z", src, re.S | re.I)
        if not match:
            raise SlidesError(f"{where} is a data: URI that isn't a PNG, JPEG, GIF, WebP or SVG picture.")
        mime = match.group(1).lower().replace("image/jpg", "image/jpeg")
        params, payload = (match.group(2) or "").lower(), match.group(3)
        if len(payload) > MAX_IMAGE_BYTES * 4:
            raise SlidesError(f"{where} is too large; use a picture under {MAX_IMAGE_BYTES // 1048576} MB.")
        try:
            if ";base64" in params:
                data = base64.b64decode(re.sub(r"\s+", "", payload), validate=True)
            else:
                data = urllib.parse.unquote_to_bytes(payload)
        except ValueError:
            raise SlidesError(f"{where} is a data: URI whose bytes don't decode.") from None
        if _sniff(data) != mime:
            raise SlidesError(f"{where} says it's {mime} but its bytes aren't.")
        if mime == "image/svg+xml" and not _safe_svg(data):
            raise SlidesError(f"{where} has active or external SVG content; use a plain SVG picture.")
        return data, mime
    if re.match(r"[A-Za-z][A-Za-z0-9+.\-]*://", src) and not src.lower().startswith("file://") or src.startswith("//"):
        raise SlidesError(f'{where} is on the web ("{src[:80]}"); a DGC deck loads nothing remote. Save the picture '
                          "into the project and give its path.")
    if src.lower().startswith("file://"):
        src = urllib.parse.unquote(urllib.parse.urlparse(src).path)
    if resolve is not None:
        try:
            path = Path(resolve(src))
        except Exception as error:                  # the tool's rule says why, in its own words
            raise SlidesError(f"{where}: {error}") from None
    else:
        path = Path(src).expanduser()
        if not path.is_absolute():
            path = Path(base or os.getcwd()) / path
    suffix = path.suffix.lower()
    if suffix not in IMAGE_TYPES:
        raise SlidesError(f'{where} is "{path.name[:60]}"; a slide shows a PNG, JPEG, GIF, WebP or SVG picture.')
    try:
        if not path.is_file():
            raise SlidesError(f'{where}: there\'s no picture at "{src[:120]}". Check the path (relative paths start '
                              "in the project folder).")
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise SlidesError(f"{where} is {path.stat().st_size / 1048576:.1f} MB; a slide's picture can be at most "
                              f"{MAX_IMAGE_BYTES // 1048576} MB. Use a smaller copy.")
        with path.open("rb") as picture:
            data = picture.read(MAX_IMAGE_BYTES + 1)
    except OSError as error:
        raise SlidesError(f'{where}: "{src[:120]}" can\'t be read ({error.strerror or error}).') from None
    mime = _sniff(data)
    if mime is None or (mime != IMAGE_TYPES[suffix] and not (suffix in (".jpg", ".jpeg") and mime == "image/jpeg")):
        raise SlidesError(f'{where}: "{path.name[:60]}" isn\'t the {suffix[1:].upper()} picture its name says.')
    if mime == "image/svg+xml" and not _safe_svg(data):
        raise SlidesError(f"{where} has active or external SVG content; use a plain SVG picture.")
    return data, mime


def _safe_svg(data: bytes) -> bool:
    """Keep embedded SVGs passive in the HTML viewer and in exported PowerPoint files."""
    if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)\b", data, re.I):
        return False
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return False
    if root.tag != "{http://www.w3.org/2000/svg}svg":
        return False
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if tag in {"script", "foreignobject", "style", "image"}:
            return False
        for key, value in element.attrib.items():
            attr = key.rsplit("}", 1)[-1].lower()
            if attr.startswith("on") or (attr in {"href", "src"} and not value.startswith("#")):
                return False
            if "@import" in value.lower() or re.search(r"url\s*\(\s*[^#\s]", value, re.I):
                return False
    return True


def _sniff(data: bytes):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if re.match(rb"(<\?xml[^>]*>\s*)?(<!--.*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]", head, re.S):
        return "image/svg+xml"
    return None


def _image_size(data: bytes, mime: str):
    """(width, height) in pixels, or None when the bytes don't hold one."""
    try:
        if mime == "image/png":
            return struct.unpack(">II", data[16:24]) if data[12:16] == b"IHDR" else None
        if mime == "image/gif":
            return struct.unpack("<HH", data[6:10])
        if mime == "image/jpeg":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                    i += 1 if marker == 0xFF else 2
                    continue
                length = struct.unpack(">H", data[i + 2:i + 4])[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return (w, h) if w and h else None
                i += 2 + length
            return None
        if mime == "image/webp":
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return (w & 0x3FFF, h & 0x3FFF)
            if chunk == b"VP8L":
                b = data[21:25]
                return (1 + (b[0] | (b[1] & 0x3F) << 8), 1 + (b[1] >> 6 | b[2] << 2 | (b[3] & 0x0F) << 10))
            if chunk == b"VP8X":
                return (1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little"))
            return None
        if mime == "image/svg+xml":
            text = data[:8192].decode("utf-8", "replace")
            tag = re.search(r"<svg\b[^>]*>", text, re.S)
            if not tag:
                return None
            attrs = dict(re.findall(r'([\w:-]+)\s*=\s*["\']([^"\']*)["\']', tag.group(0)))
            box = [float(v) for v in re.split(r"[\s,]+", attrs.get("viewBox", "").strip()) if _num(v) is not None]
            w, h = (_num(re.sub(r"px\Z", "", attrs.get(k, "").strip())) for k in ("width", "height"))
            if w and h and w > 0 and h > 0:
                return (float(w), float(h))
            if len(box) == 4 and box[2] > 0 and box[3] > 0:
                return (box[2], box[3])
            return (4.0, 3.0)
    except (struct.error, IndexError, ValueError):
        return None
    return None


# =========================================================================== edits

def apply_edits(deck, edits, *, base=None, resolve=None) -> dict:
    """The deck after ``edits``, in order; slide numbers start at 1 and each edit sees the deck as the ones before
    it left it. Nothing changes unless every edit applies: an error names the edit and what to change."""
    current = normalize(deck, base=base, resolve=resolve)
    if isinstance(edits, dict):
        edits = [edits]
    if not isinstance(edits, list) or not edits:
        raise SlidesError('Give the edits as a list: [{"op": "set", "slide": 2, "field": "title", "value": "…"}]. '
                          f'The ops are {", ".join(EDIT_OPS)}.')
    if len(edits) > MAX_EDITS:
        raise SlidesError(f"That's {len(edits)} edits; make at most {MAX_EDITS} at once, or replace the deck.")
    slides = copy.deepcopy(current["slides"])
    theme = current["theme"]
    reading = {"base": base, "resolve": resolve, "bytes": 0}
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict):
            raise SlidesError(f'Edit {i} should be an object like {{"op": "delete", "slide": 3}}.')
        op = str(edit.get("op") or "").strip().lower()
        label = f"Edit {i} ({op})" if op else f"Edit {i}"
        allowed = {"replace": ("slide", "with"), "insert": ("at", "slide"), "delete": ("slide",),
                   "move": ("slide", "to"), "set": ("slide", "field", "value"), "theme": ("value",)}
        if op not in allowed:
            raise SlidesError(f'Edit {i}\'s op is one of {", ".join(EDIT_OPS)}; "{op[:20]}" isn\'t.')
        for key in edit:
            if key != "op" and key not in allowed[op]:
                fields = ", ".join(f'"{k}"' for k in allowed[op])
                raise SlidesError(f'{label} has "{str(key)[:20]}"; a {op} edit has {fields}.')

        def number(key: str, *, end: bool = False) -> int:
            value = edit.get(key)
            if isinstance(value, str) and value.strip().isdigit():
                value = int(value.strip())
            top = len(slides) + (1 if end else 0)
            if isinstance(value, bool) or not isinstance(value, int):
                raise SlidesError(f'{label} needs "{key}": a slide number from 1 to {top}.')
            if not 1 <= value <= top:
                raise SlidesError(f"{label}: there's no slide {value}; the deck has {len(slides)} slide"
                                  f"{'s' if len(slides) != 1 else ''}"
                                  + (f" (insert at 1 to {top})." if end else "."))
            return value

        try:
            if op == "replace":
                n = number("slide")
                slides[n - 1] = _slide(edit.get("with"), n, reading)
            elif op == "insert":
                if len(slides) >= MAX_SLIDES:
                    raise SlidesError(f"{label}: the deck already has {MAX_SLIDES} slides, the most it holds.")
                n = number("at", end=True)
                slides.insert(n - 1, _slide(edit.get("slide"), n, reading))
            elif op == "delete":
                n = number("slide")
                if len(slides) == 1:
                    raise SlidesError(f"{label}: that's the deck's only slide; a deck keeps at least one.")
                del slides[n - 1]
            elif op == "move":
                n, to = number("slide"), number("to")
                slides.insert(to - 1, slides.pop(n - 1))
            elif op == "set":
                n = number("slide")
                field = str(edit.get("field") or "").strip()
                if field not in SLIDE_FIELDS:
                    raise SlidesError(f'{label}\'s field is one of {", ".join(SLIDE_FIELDS)}; '
                                      f'"{field[:30]}" isn\'t.')
                changed = dict(slides[n - 1])
                if _empty(edit.get("value")) and field != "layout":
                    changed.pop(field, None)
                else:
                    changed[field] = edit.get("value")
                slides[n - 1] = _slide(changed, n, reading)
            else:
                if "value" not in edit:
                    raise SlidesError(f'{label} needs "value": a theme name or {{"bg", "fg", "accent", ...}}.')
                theme = _theme_value(edit.get("value"))
        except SlidesError as error:
            text = str(error)
            raise SlidesError(text if text.startswith(label) else f"{label}: {text}") from None
    return normalize({"size": current["size"], "theme": theme, "slides": slides}, base=base, resolve=resolve)


# =========================================================================== looks

_SANS = ('-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, "Liberation Sans", '
         '"Noto Sans", "Noto Sans Devanagari", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif')
_SERIF = ('Georgia, "Iowan Old Style", Charter, "Bitstream Charter", Cambria, "Noto Serif", "Noto Serif Devanagari", '
          '"Noto Serif CJK SC", "Songti SC", serif')


@dataclass(frozen=True)
class _Look:
    name: str
    bg: str
    fg: str
    muted: str
    accent: str
    on_accent: str
    rule: str
    surface: str
    page: str             # behind the slides when viewing
    page_fg: str
    head_css: str
    body_css: str
    head_font: str        # PowerPoint's font names
    body_font: str
    head_face: str        # "serif" or "sans": how the text is measured
    body_face: str
    head_weight: int
    quote_face: str
    quote_italic: bool
    marker: str           # "dot", "dash" or "square"
    palette: tuple
    cover_bg: str
    cover_fg: str
    cover_muted: str
    cover_accent: str
    section_bg: str
    section_fg: str
    section_muted: str
    section_accent: str
    deco: str             # "rule" (an accent rule on the cover) or "glow"
    bar: bool             # an accent bar over each content slide's title
    number_bold: bool


_LOOKS = {
    "paper": _Look("paper", bg="F5F0E6", fg="1E1A16", muted="6A6157", accent="B4472A", on_accent="FFFFFF",
                   rule="DCD3C3", surface="ECE4D5", page="E3DCCF", page_fg="3D362F", head_css=_SERIF,
                   body_css=_SANS, head_font="Georgia", body_font="Arial", head_face="serif", body_face="sans",
                   head_weight=400, quote_face="serif", quote_italic=True, marker="dash",
                   palette=("B4472A", "2E6A73", "D49A2E", "6A4C7A", "6F8A4E", "3E5E92", "C27A5A", "8A8075"),
                   cover_bg="F5F0E6", cover_fg="1E1A16", cover_muted="6A6157", cover_accent="B4472A",
                   section_bg="EAE1D0", section_fg="1E1A16", section_muted="5F564C", section_accent="B4472A",
                   deco="rule", bar=False, number_bold=False),
    "dusk": _Look("dusk", bg="121624", fg="ECEFF7", muted="9AA3BA", accent="F4B860", on_accent="121624",
                  rule="2A3149", surface="1A2034", page="0A0D16", page_fg="C9CEDB", head_css=_SANS, body_css=_SANS,
                  head_font="Arial", body_font="Arial", head_face="sans", body_face="sans", head_weight=700,
                  quote_face="sans", quote_italic=False, marker="dot",
                  palette=("F4B860", "7FA8FF", "63D2B4", "F07E95", "B79CFF", "A6D86F", "F59460", "8F98AF"),
                  cover_bg="121624", cover_fg="ECEFF7", cover_muted="A3ABC0", cover_accent="F4B860",
                  section_bg="1A2034", section_fg="ECEFF7", section_muted="A3ABC0", section_accent="F4B860",
                  deco="glow", bar=False, number_bold=False),
    "bold": _Look("bold", bg="FFFFFF", fg="0B0B12", muted="55576A", accent="2D4BFF", on_accent="FFFFFF",
                  rule="E3E4EC", surface="F2F3F8", page="DADBE3", page_fg="2A2B36", head_css=_SANS, body_css=_SANS,
                  head_font="Arial", body_font="Arial", head_face="sans", body_face="sans", head_weight=800,
                  quote_face="sans", quote_italic=False, marker="square",
                  palette=("2D4BFF", "FF5B3A", "0FB57E", "FFB000", "9B51FF", "00A6DB", "FF3D8B", "6B7280"),
                  cover_bg="2D4BFF", cover_fg="FFFFFF", cover_muted="DCE2FF", cover_accent="FFFFFF",
                  section_bg="0B0B12", section_fg="FFFFFF", section_muted="B4B7C9", section_accent="8C9BFF",
                  deco="rule", bar=True, number_bold=True),
    "plain": _Look("plain", bg="FFFFFF", fg="111827", muted="6B7280", accent="2563EB", on_accent="FFFFFF",
                   rule="E5E7EB", surface="F3F4F6", page="E5E7EB", page_fg="374151", head_css=_SANS, body_css=_SANS,
                   head_font="Arial", body_font="Arial", head_face="sans", body_face="sans", head_weight=700,
                   quote_face="sans", quote_italic=False, marker="dot",
                   palette=("2563EB", "F59E0B", "10B981", "A855F7", "EF4444", "14B8A6", "EC4899", "64748B"),
                   cover_bg="FFFFFF", cover_fg="111827", cover_muted="6B7280", cover_accent="2563EB",
                   section_bg="F3F4F6", section_fg="111827", section_muted="4B5563", section_accent="2563EB",
                   deco="rule", bar=False, number_bold=False),
}


def _lum(hex6: str) -> float:
    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(int(hex6[i:i + 2], 16) / 255) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a) + 0.05, _lum(b) + 0.05))
    return lb / la


def _mix(a: str, b: str, t: float) -> str:
    return "".join(f"{round(int(a[i:i + 2], 16) * (1 - t) + int(b[i:i + 2], 16) * t):02X}" for i in (0, 2, 4))


def _palette_for(accent: str) -> tuple:
    """Eight series colours led by the accent, without the ones a reader couldn't tell from it."""
    def far(a: str, b: str) -> bool:
        return sum((int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) ** 2 for i in (0, 2, 4)) ** 0.5 > 90
    rest = [c for c in _LOOKS["plain"].palette + ("0EA5E9", "84CC16", "F97316", "8B5CF6") if far(c, accent)]
    return (accent, *rest[:7])


def _look(theme) -> _Look:
    if isinstance(theme, str):
        return _LOOKS[theme]
    bg, fg, accent = (theme[k][1:].upper() for k in ("bg", "fg", "accent"))
    muted = theme["muted"][1:].upper() if theme.get("muted") else _mix(fg, bg, 0.38)
    t = 0.0
    while _contrast(muted, bg) < 4.5 and t < 1:               # a muted colour too faint to read is made readable
        t += 0.1
        muted = _mix(muted, fg, min(1.0, t))
    on_accent = "FFFFFF" if _contrast("FFFFFF", accent) >= _contrast("0B0B0F", accent) else "0B0B0F"
    font = theme.get("font", "")
    face = "serif" if font.lower() == "serif" else "sans"
    if font.lower() in ("serif", "sans-serif", "sans"):
        css, ppt = (_SERIF, "Georgia") if face == "serif" else (_SANS, "Arial")
    elif font:
        css, ppt = f'"{font}", ' + _SANS, font
    else:
        css, ppt = _SANS, "Arial"
    plain = _LOOKS["plain"]
    return _Look("custom", bg=bg, fg=fg, muted=muted, accent=accent, on_accent=on_accent, rule=_mix(bg, fg, 0.14),
                 surface=_mix(bg, fg, 0.05), page=_mix(bg, fg, 0.10), page_fg=_mix(fg, bg, 0.15), head_css=css,
                 body_css=css, head_font=ppt, body_font=ppt, head_face=face if not font or font.lower() in
                 ("serif", "sans-serif", "sans") else "custom", body_face=face if not font or font.lower() in
                 ("serif", "sans-serif", "sans") else "custom", head_weight=700, quote_face="sans",
                 quote_italic=face == "serif", marker="dot", palette=_palette_for(accent),
                 cover_bg=bg, cover_fg=fg, cover_muted=muted, cover_accent=accent, section_bg=_mix(bg, fg, 0.05),
                 section_fg=fg, section_muted=muted, section_accent=accent, deco="rule", bar=False,
                 number_bold=False)


# =========================================================================== measuring and fitting

# How much wider each face sets than Helvetica (measured in Chromium against Arial and Georgia), and a margin for
# the wider system fonts a page may get instead (SF Pro, Segoe UI, Noto Sans).
_FACE_K = {("sans", False): 1.0, ("sans", True): 1.0, ("serif", False): 1.0, ("serif", True): 1.08,
           ("custom", False): 1.06, ("custom", True): 1.08, ("italic", False): 1.03, ("italic", True): 1.08}
_SAFETY = 1.07
_EXACT = 1.02


def _measure(text: str, size: float, face: str = "sans", bold: bool = False) -> float:
    table = made._HELV_B if bold else made._HELV
    total = 0.0
    for ch in text:
        o = ord(ch)
        if 32 <= o < 127:
            total += table[o - 32]
        elif unicodedata.combining(ch):
            continue
        elif unicodedata.east_asian_width(ch) in ("W", "F"):
            total += 1000
        else:
            total += 610 if bold else 570
    return total * size / 1000 * _FACE_K.get((face, bold), 1.04)


def _wrap(text: str, width: float, size: float, face: str = "sans", bold: bool = False,
          safety: float = _SAFETY, track: float = 0.0) -> list[str]:
    """Greedy word wrap, as a browser and PowerPoint do it; a word longer than a line breaks where it must.
    ``safety`` widens every word: the page's fonts are the system's, so sizes are chosen with a margin, while
    PowerPoint's boxes (Arial, Georgia: known metrics) are placed with almost none. ``track`` is letter-spacing
    in em, as a title's."""
    limit = width / safety

    def measure(piece: str) -> float:
        return _measure(piece, size, face, bold) + track * size * len(piece)
    space = measure(" ")
    lines: list[str] = []
    current, used = "", 0.0
    for word in text.split():
        pieces = []
        while measure(word) > limit and len(word) > 1:
            cut = len(word) - 1
            while cut > 1 and measure(word[:cut]) > limit:
                cut -= 1
            pieces.append(word[:cut])
            word = word[cut:]
        pieces.append(word)
        for piece in pieces:
            w = measure(piece)
            if current and used + space + w > limit:
                lines.append(current)
                current, used = piece, w
            else:
                current, used = (current + " " + piece, used + space + w) if current else (piece, w)
    if current or not lines:
        lines.append(current)
    return lines


def _nlines(text: str, width: float, size: float, face: str = "sans", bold: bool = False,
            safety: float = _SAFETY, track: float = 0.0) -> int:
    return len(_wrap(text, width, size, face, bold, safety, track)) if text else 0


def _lines(text: str, width: float, size: float, face: str = "sans", bold: bool = False, track: float = 0.0) -> int:
    """Lines as PowerPoint will set them: where the plan places the next box."""
    return _nlines(text, width, size, face, bold, _EXACT, track)


def _balanced(text: str, width: float, size: float, face: str = "sans", bold: bool = False,
              track: float = 0.0) -> str:
    """The text with its line breaks where a page's ``text-wrap: balance`` puts them (lines of even length, no
    word alone on the last), for PowerPoint, which has no such setting. One line stays as it is."""
    lines = _wrap(text, width, size, face, bold, _EXACT, track)
    if len(lines) < 2:
        return text
    narrow = width
    while narrow > width * 0.4 and len(_wrap(text, narrow * 0.98, size, face, bold, _EXACT, track)) == len(lines):
        narrow *= 0.98
    return "\n".join(_wrap(text, narrow, size, face, bold, _EXACT, track))


def _fit(text: str, width: float, sizes, face: str, bold: bool, max_lines: int,
         track: float = 0.0) -> tuple[int, int]:
    """(size, lines): the largest size at which the text fits in max_lines; else the smallest size."""
    for size in sizes:
        lines = _nlines(text, width, size, face, bold, track=track)
        if lines <= max_lines:
            return size, lines
    return sizes[-1], _nlines(text, width, sizes[-1], face, bold, track=track)


# The layout grid, shared by the page and PowerPoint (units are the design grid's px).
TOP, BOTTOM, HEAD_GAP, SUBTITLE_GAP = 72, 72, 40, 12
BAR_W, BAR_H, BAR_GAP = 56, 8, 24
TITLE_LH, SUBTITLE_LH, BODY_LH, HEADING_LH = 1.12, 1.35, 1.38, 1.25
TITLE_TRACK, COVER_TRACK, SECTION_TRACK = -0.012, -0.022, -0.018      # titles set a little tight, in em
TITLE_SIZES = (48, 44, 40, 36, 32, 30, 28)
SUBTITLE_SIZES = (24, 22, 20, 18)
BULLET_SIZES = (32, 30, 28, 26, 24, 22, 20, 18, 16, 15, 14)
SIDE_SIZES = (26, 24, 22, 20, 18, 16, 15, 14)
BULLET_GAP, INDENT, SUB_SCALE, SUB_FIRST, SUB_BETWEEN, SUB_INDENT = 0.6, 1.15, 0.8, 0.3, 0.2, 1.0
COL_GAP, COL_PAD, SIDE_GAP = 64, 24, 56
COVER_TITLE_SIZES = (84, 76, 68, 60, 54, 48, 42, 38)
COVER_SUB_SIZES = (30, 28, 26, 24, 22, 20)
COVER_LH, COVER_SUB_GAP, COVER_BOTTOM, RULE_W, RULE_H, RULE_GAP = 1.06, 28, 112, 72, 6, 36
SECTION_TITLE_SIZES = (64, 58, 52, 46, 40, 36)
SECTION_LH, LABEL_SIZE, LABEL_GAP, SECTION_SUB_GAP = 1.08, 22, 24, 24
CLOSING_TITLE_SIZES = (72, 64, 56, 50, 44, 40)
QUOTE_SIZES = (52, 48, 44, 40, 36, 32, 28, 26, 24)
QUOTE_LH, QUOTE_MARK, QUOTE_MARK_H, BY_SIZE, BY_GAP = 1.3, 180, 72, 22, 28
TABLE_SIZES = (22, 20, 19, 18, 17, 16, 15, 14, 13, 12)
TABLE_LH, TABLE_VPAD, TABLE_HPAD, TABLE_HEAD = 1.3, 0.55, 0.7, 0.8
CAPTION, CAPTION_GAP, CHART_LABEL, CHART_LABEL_GAP = 18, 14, 20, 12
NUMBER_SIZE, NUMBER_BOTTOM = 14, 36


def _pad(W: int) -> int:
    return 88 if W >= 1280 else 64


def _bullets_height(bullets, width: float, s: float, face: str) -> float:
    ss = s * SUB_SCALE
    text_w, sub_w = width - INDENT * s, width - INDENT * s - SUB_INDENT * ss
    h = 0.0
    for i, bullet in enumerate(bullets):
        text, subs = _bt(bullet)
        if i:
            h += BULLET_GAP * s
        h += _nlines(text, text_w, s, face) * s * BODY_LH
        for j, sub in enumerate(subs):
            h += (SUB_FIRST if j == 0 else SUB_BETWEEN) * ss + _nlines(sub, sub_w, ss, face) * ss * BODY_LH
    return h


def _fit_bullets(bullets, width: float, height: float, sizes, face: str) -> int:
    for s in sizes:
        if _bullets_height(bullets, width, s, face) <= height:
            return s
    return sizes[-1]


def _table_fit(table: dict, width: float, height: float, face: str) -> dict:
    """The table's type size and column widths: the largest size at which it fits the box, each column at least as
    wide as its longest word (a header too, in its small capitals), the rest shared by how much each has to say.
    ``fits`` is False when even the smallest size doesn't fit."""
    cols, rows = table["columns"], table["rows"]
    numeric = []
    for c in range(len(cols)):
        cells = [r[c] for r in rows if r[c] != ""]
        numeric.append(bool(cells) and all(isinstance(v, (int, float)) or _looks_numeric(v) for v in cells))
    text = [[_cell_text(v) for v in row] for row in rows]

    def head_w(value: str, size: float) -> float:          # bold capitals, tracked .06em
        return (_measure(value.upper(), size, face, True) + 0.06 * size * len(value)) * _SAFETY
    best = None
    for s in TABLE_SIZES:
        hs, pad_x, pad_y = s * TABLE_HEAD, TABLE_HPAD * s, TABLE_VPAD * s
        natural, minimum = [], []
        for c, head in enumerate(cols):
            body = [row[c] for row in text]
            natural.append(max([head_w(head, hs) + TABLE_HPAD * hs * 2, s * 2.5] +
                               [_measure(v, s, face, c == 0) * _SAFETY + pad_x * 2 for v in body]))
            minimum.append(max([max((head_w(w, hs) for w in head.split()), default=0) + TABLE_HPAD * hs * 2,
                                s * 2.5] + [_measure(w, s, face, c == 0) * _SAFETY + pad_x * 2
                                            for v in body for w in ([v] if len(v) <= 14 else v.split())]))
        fits = sum(minimum) <= width
        if sum(natural) <= width:
            widths = [width * n / sum(natural) for n in natural]
        elif fits:
            extra = [n - m for n, m in zip(natural, minimum)]
            widths = [m + (width - sum(minimum)) * e / (sum(extra) or 1) for m, e in zip(minimum, extra)]
        else:
            widths = [width * m / sum(minimum) for m in minimum]
        head_lines = max(_nlines(h.upper(), (w - TABLE_HPAD * hs * 2) / 1.1, hs, face, True) or 1
                         for h, w in zip(cols, widths))
        head_h = head_lines * hs * TABLE_LH + TABLE_VPAD * hs * 2
        row_hs = []
        for row in text:
            lines = max(_nlines(v, w - pad_x * 2, s, face, c == 0) or 1 for c, (v, w) in enumerate(zip(row, widths)))
            row_hs.append(lines * s * TABLE_LH + pad_y * 2)
        total = head_h + sum(row_hs)
        best = {"fs": s, "widths": [w / width for w in widths], "head_h": head_h, "row_hs": row_hs,
                "numeric": numeric, "height": total, "fits": fits and total <= height}
        if best["fits"]:
            break
    return best


def _looks_numeric(value) -> bool:
    return bool(re.fullmatch(r"[-+−]?[$₹€£¥]?\s?[\d.,]+\s?(%|[kKmMbB]n?|x|pp|bps)?", str(value).strip()))


def _cell_text(value) -> str:
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return f"{int(value):,}"
        text = f"{value:,.2f}".rstrip("0").rstrip(".")
        return text if text not in ("-0", "") else "0"
    return str(value)


# =========================================================================== the plan: every box on every slide

def _run(text, size, color, font="body", *, bold=False, italic=False, caps=False, spacing=0.0) -> dict:
    return {"text": text, "size": size, "color": color, "font": font, "bold": bold, "italic": italic, "caps": caps,
            "spacing": spacing}


def _para(runs, *, align="l", lh=1.2, before=0.0, bullet=None, indent=0.0, hang=0.0, level=0) -> dict:
    """A paragraph; a bullet's text starts at ``indent`` and its marker ``hang`` to the left of that."""
    return {"runs": runs if isinstance(runs, list) else [runs], "align": align, "lh": lh, "before": before,
            "bullet": bullet, "indent": indent, "hang": hang, "level": level}


def _text_item(box, paras, *, anchor="t", role="", autofit=True) -> dict:
    return {"kind": "text", "box": box, "paras": paras, "anchor": anchor, "role": role, "autofit": autofit}


def _bullet_paras(bullets, s: float, look: _Look, *, color=None, muted=None) -> list:
    ss = round(s * SUB_SCALE, 2)
    fg, mu = color or look.fg, muted or look.muted
    char = {"dot": "•", "dash": "–", "square": "■"}[look.marker]
    scale = {"dot": 1.25, "dash": 1.0, "square": 0.62}[look.marker]
    paras = []
    for i, bullet in enumerate(bullets):
        text, subs = _bt(bullet)
        paras.append(_para(_run(text, s, fg), lh=BODY_LH, before=BULLET_GAP * s if i else 0,
                           bullet={"char": char, "color": look.accent, "scale": scale}, indent=INDENT * s,
                           hang=INDENT * s))
        for j, sub in enumerate(subs):
            paras.append(_para(_run(sub, ss, mu), lh=BODY_LH, before=(SUB_FIRST if j == 0 else SUB_BETWEEN) * ss,
                               bullet={"char": "–", "color": mu, "scale": 1.0},
                               indent=INDENT * s + SUB_INDENT * ss, hang=SUB_INDENT * ss, level=1))
    return paras


def _plan(slide: dict, n: int, look: _Look, dims: tuple, section_no: int) -> dict:
    """Where everything on a slide goes and how big it is. The page uses the sizes (``vars``) and lays itself out
    with the same spacing; PowerPoint and the plain PDF use the boxes (``items``)."""
    W, H = dims
    P = _pad(W)
    iw = W - 2 * P
    layout = slide["layout"]
    items: list = []
    css: dict = {}
    plan = {"layout": layout, "bg": look.bg, "items": items, "vars": css, "number": False}
    title, subtitle = slide.get("title", ""), slide.get("subtitle", "")
    hf, bf = look.head_face, look.body_face
    head_bold = look.head_weight >= 600

    if layout in ("title", "closing"):
        plan["bg"] = look.cover_bg
        closing = layout == "closing"
        bw = min(iw, 1000 if closing else 1040)
        sizes = CLOSING_TITLE_SIZES if closing else COVER_TITLE_SIZES
        ts = _fit(title, bw, sizes, hf, head_bold, 3, COVER_TRACK)[0] if title else sizes[0]
        ss = _fit(subtitle, bw, COVER_SUB_SIZES, bf, False, 3)[0] if subtitle else COVER_SUB_SIZES[0]
        tl = _lines(title, bw, ts, hf, head_bold, COVER_TRACK)
        sl = _lines(subtitle, bw, ss, bf)
        rule = look.deco == "rule"
        h = (RULE_H + RULE_GAP if rule else 0) + tl * ts * COVER_LH + \
            ((COVER_SUB_GAP if tl else 0) + sl * ss * SUBTITLE_LH if sl else 0)
        y = (H - h) / 2 if closing else max(TOP, H - COVER_BOTTOM - h)
        x = (W - bw) / 2 if closing else P
        align = "ctr" if closing else "l"
        if look.deco == "glow":
            spots = ((W - 470, -300, 700, 700), (W - 580, -390, 920, 920)) if not closing else \
                ((-300, H - 360, 680, 680), (-410, H - 470, 900, 900))
            items.append({"kind": "shape", "box": spots[0], "shape": "ellipse", "fill": look.palette[1], "alpha": 0.42,
                          "glow": True})
            items.append({"kind": "shape", "box": spots[1], "shape": "ellipse", "line": look.accent, "alpha": 0.32,
                          "line_w": 2})
            css["glow"] = spots
        if rule:
            rx = (W - RULE_W) / 2 if closing else P
            items.append({"kind": "shape", "box": (rx, y, RULE_W, RULE_H), "shape": "rect", "fill": look.cover_accent})
            y += RULE_H + RULE_GAP
        if tl:
            th = tl * ts * COVER_LH
            balanced = _balanced(title, bw, ts, hf, head_bold, COVER_TRACK)
            items.append(_text_item((x, y, bw, th), [_para(_run(balanced, ts, look.cover_fg, "head", bold=head_bold,
                                                                spacing=COVER_TRACK), align=align, lh=COVER_LH)],
                                    role="ctrTitle"))
            y += th + (COVER_SUB_GAP if sl else 0)
        if sl:
            items.append(_text_item((x, y, bw, sl * ss * SUBTITLE_LH),
                                    [_para(_run(_balanced(subtitle, bw, ss, bf), ss, look.cover_muted), align=align,
                                           lh=SUBTITLE_LH)],
                                    role="subTitle"))
        css.update(ts=ts, ss=ss, bw=bw)
        return plan

    if layout == "section":
        plan["bg"] = look.section_bg
        bw = min(iw, 980)
        ts = _fit(title, bw, SECTION_TITLE_SIZES, hf, head_bold, 3, SECTION_TRACK)[0]
        ss = _fit(subtitle, bw, COVER_SUB_SIZES[2:], bf, False, 3)[0] if subtitle else 24
        tl = _lines(title, bw, ts, hf, head_bold, SECTION_TRACK)
        sl = _lines(subtitle, bw, ss, bf)
        label_h = LABEL_SIZE * 1.2
        h = label_h + LABEL_GAP + tl * ts * SECTION_LH + (SECTION_SUB_GAP + sl * ss * SUBTITLE_LH if sl else 0)
        y = (H - h) / 2
        label = f"{section_no:02d}"
        lw = _measure(label, LABEL_SIZE, "sans", True) * 1.0 + LABEL_SIZE * 0.14 * len(label)
        items.append(_text_item((P, y, lw + 8, label_h), [_para(_run(label, LABEL_SIZE, look.section_accent,
                                                                     bold=True, spacing=0.14), lh=1.2)]))
        items.append({"kind": "shape", "box": (P + lw + 16, y + label_h / 2 - 1, 48, 2), "shape": "rect",
                      "fill": look.section_accent})
        y += label_h + LABEL_GAP
        th = tl * ts * SECTION_LH
        balanced = _balanced(title, bw, ts, hf, head_bold, SECTION_TRACK)
        items.append(_text_item((P, y, bw, th), [_para(_run(balanced, ts, look.section_fg, "head", bold=head_bold,
                                                            spacing=SECTION_TRACK), lh=SECTION_LH)], role="title"))
        y += th + SECTION_SUB_GAP
        if sl:
            items.append(_text_item((P, y, bw, sl * ss * SUBTITLE_LH),
                                    [_para(_run(_balanced(subtitle, bw, ss, bf), ss, look.section_muted),
                                           lh=SUBTITLE_LH)]))
        css.update(ts=ts, ss=ss, bw=bw)
        plan["label"] = label
        return plan

    # ------------------------------------------------------------------ content slides: a header, then a body
    chart = slide.get("chart") or {}
    if layout == "chart" and not title and chart.get("title"):
        title = chart["title"]                      # a chart slide without a title takes the chart's
    plan["title"] = title
    full_image = layout == "image" and not title and not subtitle
    plan["number"] = not full_image
    y = 48 if full_image else TOP
    if look.bar and (title or subtitle):
        items.append({"kind": "shape", "box": (P, y, BAR_W, BAR_H), "shape": "rect", "fill": look.accent})
        y += BAR_H + BAR_GAP
    if title:
        ts, tl = _fit(title, iw, TITLE_SIZES, hf, head_bold, 2, TITLE_TRACK)
        if tl > 2:
            ts = _fit(title, iw, TITLE_SIZES[-2:], hf, head_bold, 3, TITLE_TRACK)[0]
        tl = _lines(title, iw, ts, hf, head_bold, TITLE_TRACK)
        th = tl * ts * TITLE_LH
        balanced = _balanced(title, iw, ts, hf, head_bold, TITLE_TRACK)
        items.append(_text_item((P, y, iw, th), [_para(_run(balanced, ts, look.fg, "head", bold=head_bold,
                                                            spacing=TITLE_TRACK), lh=TITLE_LH)], anchor="b",
                                role="title"))
        y += th
        css["ts"] = ts
    if subtitle:
        ss = _fit(subtitle, iw, SUBTITLE_SIZES, bf, False, 2)[0]
        sl = _lines(subtitle, iw, ss, bf)
        if title:
            y += SUBTITLE_GAP
        items.append(_text_item((P, y, iw, sl * ss * SUBTITLE_LH),
                                [_para(_run(_balanced(subtitle, iw, ss, bf), ss, look.muted), lh=SUBTITLE_LH)]))
        y += sl * ss * SUBTITLE_LH
        css["ss"] = ss
    if title or subtitle:
        y += HEAD_GAP
    bottom = H - (48 if full_image else BOTTOM)
    bx, bw, bh = (48 if full_image else P), (W - 96 if full_image else iw), bottom - y
    by = y
    plan["body"] = (bx, by, bw, bh)

    if layout == "bullets":
        bullets = slide["bullets"]
        one = _fit_bullets(bullets, bw, bh, BULLET_SIZES, bf)
        cols = 1
        if one < 24 and len(bullets) >= 6:
            half = math.ceil(len(bullets) / 2)
            cw = (bw - COL_GAP) / 2
            two = BULLET_SIZES[-1]
            for s in BULLET_SIZES[2:]:
                if max(_bullets_height(bullets[:half], cw, s, bf), _bullets_height(bullets[half:], cw, s, bf)) <= bh:
                    two = s
                    break
            if two > one:
                cols, one = 2, two
        css["bs"] = one
        plan["cols"] = cols
        if cols == 1 and _bullets_height(bullets, bw, one, bf) > bh or cols == 2 and max(
                _bullets_height(bullets[:math.ceil(len(bullets) / 2)], (bw - COL_GAP) / 2, one, bf),
                _bullets_height(bullets[math.ceil(len(bullets) / 2):], (bw - COL_GAP) / 2, one, bf)) > bh:
            plan["overflow"] = ("bullets don't fit", "Shorten them, or split them across two slides.")
        if cols == 1:
            items.append(_text_item((bx, by, bw, bh), _bullet_paras(bullets, one, look)))
        else:
            half = math.ceil(len(bullets) / 2)
            cw = (bw - COL_GAP) / 2
            items.append(_text_item((bx, by, cw, bh), _bullet_paras(bullets[:half], one, look)))
            items.append(_text_item((bx + cw + COL_GAP, by, cw, bh), _bullet_paras(bullets[half:], one, look)))
            plan["split"] = half

    elif layout == "two_columns":
        cw = (bw - COL_GAP) / 2
        sides = [slide["left"], slide["right"]]

        def column_h(col, s):
            hs = s
            hh = _nlines(col.get("heading", ""), cw, hs, hf, True) * hs * HEADING_LH
            gap = 0.6 * s if col.get("heading") and col.get("bullets") else 0
            return COL_PAD + 2 + hh + gap + _bullets_height(col.get("bullets", []), cw, s, bf)
        s = BULLET_SIZES[-1]
        for size in BULLET_SIZES[2:]:
            if max(column_h(c, size) for c in sides) <= bh:
                s = size
                break
        css.update(bs=s, hs=s, hg=round(0.6 * s, 2))
        if max(column_h(c, s) for c in sides) > bh:
            plan["overflow"] = ("columns don't fit", "Shorten the longer column, or split it across two slides.")
        for k, col in enumerate(sides):
            cx = bx + k * (cw + COL_GAP)
            items.append({"kind": "shape", "box": (cx, by, cw, 2), "shape": "rect", "fill": look.rule})
            items.append({"kind": "shape", "box": (cx, by, 64, 2), "shape": "rect", "fill": look.accent})
            yy = by + 2 + COL_PAD
            if col.get("heading"):
                hh = _lines(col["heading"], cw, s, hf, True) * s * HEADING_LH
                items.append(_text_item((cx, yy, cw, hh), [_para(_run(col["heading"], s, look.fg, "head",
                                                                      bold=True), lh=HEADING_LH)]))
                yy += hh + (0.6 * s if col.get("bullets") else 0)
            if col.get("bullets"):
                items.append(_text_item((cx, yy, cw, by + bh - yy), _bullet_paras(col["bullets"], s, look)))

    elif layout in ("image", "chart"):
        side = slide.get("bullets")
        mw = bw
        if side:
            sw = round((bw - SIDE_GAP) * 0.38)
            mw = bw - SIDE_GAP - sw
            s = _fit_bullets(side, sw, bh, SIDE_SIZES, bf)
            css.update(bs=s, sw=sw)
            if _bullets_height(side, sw, s, bf) > bh:
                plan["overflow"] = (f"bullets beside the {layout} don't fit",
                                    f"Keep the bullets beside a {layout} to a few short lines.")
            sh = min(bh, _bullets_height(side, sw, s, bf) + 4)
            items.append(_text_item((bx + mw + SIDE_GAP, by + (bh - sh) / 2, sw, sh), _bullet_paras(side, s, look)))
        if layout == "chart":
            cy, ch = by, bh
            if chart.get("title") and chart["title"] != title:
                lh = CHART_LABEL * 1.3
                items.append(_text_item((bx, by, mw, lh), [_para(_run(chart["title"], CHART_LABEL, look.muted),
                                                                 lh=1.3)]))
                cy, ch = by + lh + CHART_LABEL_GAP, bh - lh - CHART_LABEL_GAP
                plan["chart_label"] = chart["title"]
            items.append({"kind": "chart", "box": (bx, cy, mw, ch), "spec": chart})
            plan["chart_box"] = (mw, ch)
        else:
            image = slide["image"]
            ch = 0.0
            if image.get("caption"):
                ch = min(2, _lines(image["caption"], mw, CAPTION, bf)) * CAPTION * 1.35
            room = bh - (ch + CAPTION_GAP if ch else 0)
            mime, data = _data_uri(image["src"])
            iw0, ih0 = _image_size(data, mime) or (4, 3)
            scale = min(mw / iw0, room / ih0)
            w, h = iw0 * scale, ih0 * scale
            top = by + (bh - h - (ch + CAPTION_GAP if ch else 0)) / 2
            items.append({"kind": "image", "box": (bx + (mw - w) / 2, top, w, h), "src": image["src"],
                          "alt": image.get("alt") or image.get("caption") or title or "Picture"})
            if ch:
                items.append(_text_item((bx, top + h + CAPTION_GAP, mw, ch),
                                        [_para(_run(image["caption"], CAPTION, look.muted), align="ctr", lh=1.35)]))
            css.update(iw=round(w, 1), ih=round(h, 1))
        plan["full"] = full_image

    elif layout == "quote":
        quote = slide["quote"]
        qw = min(bw, 1000)
        face = "italic" if look.quote_italic else look.quote_face
        qbold = look.quote_face != "serif" and look.head_weight >= 800
        qs = _fit(quote["text"], qw, QUOTE_SIZES, face, qbold, 6)[0]
        ql = _lines(quote["text"], qw, qs, face, qbold)
        by_h = BY_GAP + BY_SIZE * 1.35 if quote.get("by") else 0
        block = QUOTE_MARK_H + ql * qs * QUOTE_LH + by_h
        y0 = by + max(0, (bh - block) / 2)
        if _nlines(quote["text"], qw, qs, face, qbold) * qs * QUOTE_LH + QUOTE_MARK_H + by_h > bh:
            plan["overflow"] = ("quote doesn't fit", "Shorten the quote, or drop the slide's title.")
        items.append(_text_item((bx - 6, y0 - 38, 200, QUOTE_MARK * 1.25),
                                [_para(_run("“", QUOTE_MARK, look.accent, "mark"), lh=1.16)], autofit=False))
        y0 += QUOTE_MARK_H
        paras = [_para(_run(_balanced(quote["text"], qw, qs, face, qbold), qs, look.fg, "quote", italic=look.quote_italic,
                            bold=qbold), lh=QUOTE_LH)]
        if quote.get("by"):
            paras.append(_para(_run("— " + quote["by"], BY_SIZE, look.muted), lh=1.35, before=BY_GAP))
        items.append(_text_item((bx, y0, qw, ql * qs * QUOTE_LH + by_h), paras))
        css.update(qs=qs, qw=qw)

    elif layout == "table":
        fit = _table_fit(slide["table"], bw, bh, bf)
        css["fs"] = fit["fs"]
        plan["table_fit"] = fit
        if not fit["fits"]:
            table = slide["table"]
            plan["overflow"] = ("table doesn't fit", f"It has {len(table['rows'])} rows and {len(table['columns'])} "
                                "columns: shorten the longest cells, drop a column, or split the rows across two "
                                "slides.")
        items.append({"kind": "table", "box": (bx, by, bw, min(bh, fit["height"])), "table": slide["table"],
                      "fit": fit})
    return plan


def _plans(deck: dict, look: _Look) -> list:
    dims = SIZES[deck["size"]]
    out, section = [], 0
    for n, slide in enumerate(deck["slides"], 1):
        if slide["layout"] == "section":
            section += 1
        out.append(_plan(slide, n, look, dims, section))
    return out


def _data_uri(src: str) -> tuple[str, bytes]:
    head, _, payload = src.partition(",")
    mime = head[5:].split(";")[0]
    return mime, base64.b64decode(payload)


# =========================================================================== charts, drawn as SVG

def _ticks(lo: float, hi: float, count: int = 5) -> tuple[list, float]:
    """Round tick steps (1, 2, 2.5, 5 x 10^n) covering [lo, hi], as ChatDGC's charts draw them."""
    if lo == hi:
        hi, lo = lo + 1, min(0, lo)
    raw = (hi - lo) / count
    mag = 10 ** math.floor(math.log10(raw))
    step = next((m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw), 10 * mag)
    start, end = math.floor(lo / step) * step, math.ceil(hi / step) * step
    out, v = [], start
    while v <= end + step / 2:
        out.append(round(round(v / step) * step, 10))
        v += step
    return out, step


def _fmt(v, unit: str = "") -> str:
    if v is None:
        return "–"
    a = abs(v)
    if a >= 1e5:
        for div, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
            if a >= div:
                text = f"{v / div:.1f}".rstrip("0").rstrip(".") + suffix
                break
    else:
        digits = 3 if a < 1 else 2 if a < 100 else 0
        text = f"{v:,.{digits}f}"
        if digits:
            text = text.rstrip("0").rstrip(".")
        if text in ("-0", ""):
            text = "0"
    if not unit:
        return text
    if len(unit) == 1 and unit in "$₹€£¥":
        return "-" + unit + text[1:] if text.startswith("-") else unit + text
    return text + ("%" if unit == "%" else " " + unit)


def _legend_rows(names, width: float, fs: float) -> list:
    rows, row, used = [], [], 0.0
    for i, name in enumerate(names):
        w = 16 + 10 + _measure(name, fs) * 1.04 + 30
        if row and used + w > width:
            rows.append(row)
            row, used = [], 0.0
        row.append((i, name, used))
        used += w
    if row:
        rows.append(row)
    return rows


def chart_svg(spec: dict, width: float, height: float, look=None) -> str:
    """A chart spec (ChatDGC's, normalized) drawn as inline SVG in a box of width x height design px."""
    look = look if isinstance(look, _Look) else _look(look or "plain")
    W, H = float(width), float(height)
    pal = ["#" + c for c in look.palette]
    fg, muted, rule = "#" + look.fg, "#" + look.muted, "#" + look.rule
    fs = 18 if W >= 760 else 16 if W >= 520 else 14
    out: list = []
    e = html.escape

    def text(x, y, value, *, size=fs, fill=muted, anchor="start", weight=0, rotate=None):
        extra = f' font-weight="{weight}"' if weight else ""
        if rotate is not None:
            extra += f' transform="rotate({rotate} {x:.1f} {y:.1f})"'
        out.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" text-anchor="{anchor}"{extra}>'
                   f"{e(str(value))}</text>")

    kind, series, unit = spec["type"], spec["series"], spec.get("unit", "")
    label = e(spec.get("title") or f"{kind} chart")
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" preserveAspectRatio="xMidYMin '
            f'meet" role="img" aria-label="{label}">')

    if kind == "pie":
        s = series[0]
        slices = [(spec["x"][j], max(0.0, v or 0), j) for j, v in enumerate(s["values"]) if (v or 0) > 0]
        total = sum(v for _, v, _ in slices) or 1
        lfs = fs + 2
        name_w = max(_measure(name, lfs) * 1.04 for name, _, _ in slices)
        value_w = max(_measure(f"{_fmt(v, unit)}  {round(v / total * 100)}%", fs) * 1.04 for _, v, _ in slices)
        legend_w = min(W * 0.5, 14 + 12 + name_w + 28 + value_w)
        r = max(40.0, min((H - 16) / 2, (W - legend_w - 56) / 2))
        inner = r * 0.6
        cx, cy = r + 8, H / 2
        angle = -math.pi / 2
        for name, v, j in slices:
            sweep = v / total * math.pi * 2
            end = angle + sweep
            large = 1 if sweep > math.pi else 0

            def p(a, rad):
                return f"{cx + rad * math.cos(a):.2f} {cy + rad * math.sin(a):.2f}"
            if sweep >= math.pi * 2 - 1e-9:
                d = (f"M {p(angle, r)} A {r:.2f} {r:.2f} 0 1 1 {p(angle + math.pi, r)} A {r:.2f} {r:.2f} 0 1 1 "
                     f"{p(angle, r)} M {p(angle, inner)} A {inner:.2f} {inner:.2f} 0 1 0 {p(angle + math.pi, inner)} "
                     f"A {inner:.2f} {inner:.2f} 0 1 0 {p(angle, inner)} Z")
            else:
                d = (f"M {p(angle, r)} A {r:.2f} {r:.2f} 0 {large} 1 {p(end, r)} L {p(end, inner)} A {inner:.2f} "
                     f"{inner:.2f} 0 {large} 0 {p(angle, inner)} Z")
            out.append(f'<path d="{d}" fill="{pal[j % len(pal)]}" stroke="#{look.bg}" stroke-width="3" '
                       f'fill-rule="evenodd"><title>{e(name)}: {e(_fmt(v, unit))}</title></path>')
            angle = end
        if unit != "%":
            text(cx, cy + 4, _fmt(total, unit), size=round(fs * 1.9), fill=fg, anchor="middle", weight=700)
            text(cx, cy + fs * 1.9 * 0.5 + 14, "Total", size=fs - 1, anchor="middle")
        lx = cx + r + 56
        row_h = min(lfs * 2.1, (H - 8) / max(1, len(slices)))
        ly = cy - row_h * len(slices) / 2
        for k, (name, v, j) in enumerate(slices):
            yy = ly + row_h * k + row_h / 2
            out.append(f'<rect x="{lx:.1f}" y="{yy - 7:.1f}" width="14" height="14" rx="3" fill="{pal[j % len(pal)]}"/>')
            text(lx + 26, yy + 5.5, name, size=lfs, fill=fg)
            text(min(W - 2, lx + 26 + name_w + 28 + value_w), yy + 5.5,
                 f"{_fmt(v, unit)}  {round(v / total * 100)}%", anchor="end")
        return head + "".join(out) + "</svg>"

    legend = len(series) > 1
    top = 6.0
    if legend:
        rows = _legend_rows([s["name"] for s in series], W, fs)
        for r, row in enumerate(rows):
            for i, name, x in row:
                yy = 4 + r * (fs + 14)
                out.append(f'<rect x="{x:.1f}" y="{yy + fs * 0.12:.1f}" width="16" height="16" rx="3" fill="{pal[i]}"/>')
                text(x + 26, yy + fs * 0.88, name, fill=fg)
        top = 4 + len(rows) * (fs + 14) + 12

    if kind == "scatter":
        pts = [p for s in series for p in s["points"]]
        xt, _ = _ticks(min(p[0] for p in pts), max(p[0] for p in pts))
        yt, _ = _ticks(min(p[1] for p in pts), max(p[1] for p in pts))
        left = max(_measure(_fmt(v, unit), fs) for v in yt) + 14 + (30 if spec.get("y_label") else 0)
        plot = (left, top, W - left - 12, H - top - 34 - (30 if spec.get("x_label") else 0))

        def X(v):
            return plot[0] + (v - xt[0]) / ((xt[-1] - xt[0]) or 1) * plot[2]

        def Y(v):
            return plot[1] + plot[3] - (v - yt[0]) / ((yt[-1] - yt[0]) or 1) * plot[3]
        _axes(out, text, plot, [(Y(v), _fmt(v, unit)) for v in yt], [(X(v), _fmt(v)) for v in xt], spec, rule, fg,
              fs, numeric_x=True)
        for i, s in enumerate(series):
            for px, py in s["points"]:
                out.append(f'<circle cx="{X(px):.1f}" cy="{Y(py):.1f}" r="6" fill="{pal[i]}" fill-opacity="0.85">'
                           f"<title>{e(s['name'])}: {e(_fmt(px))}, {e(_fmt(py, unit))}</title></circle>")
        return head + "".join(out) + "</svg>"

    x = spec["x"]
    n = len(x)
    stacked, horizontal = spec.get("stacked", False), spec.get("horizontal", False)
    values = [v for s in series for v in s["values"] if v is not None]
    sums = [sum(max(0, s["values"][j] or 0) for s in series) for j in range(n)]
    negs = [sum(min(0, s["values"][j] or 0) for s in series) for j in range(n)]
    fit = kind == "line" and not stacked
    lo = min([0] + negs) if stacked else min(values) if fit else min([0] + values)
    hi = max([0] + sums) if stacked else max(values) if fit else max([0] + values)
    show_values = kind == "bar" and not stacked and n * len(series) <= 16
    vt, step = _ticks(lo, hi if hi != lo else lo + 1)
    if show_values and hi > 0 and (vt[-1] - hi) < (vt[-1] - vt[0]) * 0.1:
        vt.append(round(vt[-1] + step, 10))
    span = (vt[-1] - vt[0]) or 1
    short = [v if len(v) <= 18 else v[:17] + "…" for v in x]
    if horizontal:
        left = min(W * 0.32, max(_measure(v, fs) * 1.04 for v in short) + 16)
        plot = (left, top, W - left - 16, H - top - 30 - (30 if spec.get("x_label") else 0))

        def V(v):
            return plot[0] + (v - vt[0]) / span * plot[2]
        band = plot[3] / n
        _axes(out, text, plot, [(V(v), _fmt(v, unit)) for v in vt],
              [(plot[1] + band * (j + 0.5), short[j]) for j in range(n)], spec, rule, fg, fs, horizontal=True)
        _bars(out, spec, series, n, band, lambda j: plot[1] + band * j, V, pal, unit, fs, fg, show_values, True)
        return head + "".join(out) + "</svg>"
    left = max(_measure(_fmt(v, unit), fs) for v in vt) + 14 + (30 if spec.get("y_label") else 0)
    plot_w = W - left - 12
    band = plot_w / n
    widest = max(_measure(v, fs) * 1.04 for v in short)
    rotate = widest > band * 0.92
    bottom = (min(110.0, widest * 0.5 + fs + 14) if rotate else 34) + (30 if spec.get("x_label") else 0)
    plot = (left, top, plot_w, H - top - bottom)

    def V(v):
        return plot[1] + plot[3] - (v - vt[0]) / span * plot[3]
    _axes(out, text, plot, [(V(v), _fmt(v, unit)) for v in vt],
          [(plot[0] + band * (j + 0.5), short[j]) for j in range(n)], spec, rule, fg, fs, rotate=rotate)
    if kind == "bar":
        _bars(out, spec, series, n, band, lambda j: plot[0] + band * j, V, pal, unit, fs, fg, show_values, False)
        return head + "".join(out) + "</svg>"
    base = [0.0] * n
    for i, s in enumerate(series):
        pts, floor = [], []
        for j, v in enumerate(s["values"]):
            if v is None:
                pts.append(None)
                floor.append(None)
                continue
            below = base[j] if stacked else 0
            if stacked:
                base[j] += v
            pts.append((plot[0] + band * (j + 0.5), V(base[j] if stacked else v)))
            floor.append((plot[0] + band * (j + 0.5), V(below)))
        path = ""
        for j, p in enumerate(pts):
            if p:
                path += f"{'L' if path and pts[j - 1] else 'M'} {p[0]:.1f} {p[1]:.1f} "
        kept = [p for p in pts if p]
        if kind == "area" and len(kept) > 1:
            under = " ".join(f"L {q[0]:.1f} {q[1]:.1f}" for q in reversed([q for q in floor if q]))
            out.append(f'<path d="{path}{under} Z" fill="{pal[i]}" fill-opacity="{0.32 if stacked else 0.18}"/>')
        out.append(f'<path d="{path}" fill="none" stroke="{pal[i]}" stroke-width="3.5" stroke-linejoin="round" '
                   'stroke-linecap="round"/>')
        if n <= 30:
            for j, p in enumerate(pts):
                if p:
                    out.append(f'<circle cx="{p[0]:.1f}" cy="{p[1]:.1f}" r="5" fill="{pal[i]}" stroke="#{look.bg}" '
                               f'stroke-width="2"><title>{e(x[j])} · {e(s["name"])}: '
                               f"{e(_fmt(s['values'][j], unit))}</title></circle>")
    return head + "".join(out) + "</svg>"


def _axes(out, text, plot, value_ticks, category_ticks, spec, rule, fg, fs, *, horizontal=False, rotate=False,
          numeric_x=False):
    px, py, pw, ph = plot
    for pos, label in value_ticks:
        if horizontal:
            out.append(f'<line x1="{pos:.1f}" x2="{pos:.1f}" y1="{py:.1f}" y2="{py + ph:.1f}" stroke="{rule}" '
                       'stroke-width="1"/>')
            text(pos, py + ph + fs + 8, label, anchor="middle")
        else:
            out.append(f'<line x1="{px:.1f}" x2="{px + pw:.1f}" y1="{pos:.1f}" y2="{pos:.1f}" stroke="{rule}" '
                       'stroke-width="1"/>')
            text(px - 10, pos + fs * 0.35, label, anchor="end")
    every = max(1, math.ceil(len(category_ticks) / (14 if horizontal or rotate else 12)))
    for j, (pos, label) in enumerate(category_ticks):
        if j % every:
            continue
        if horizontal:
            text(px - 10, pos + fs * 0.35, label, anchor="end", fill=fg)
        elif rotate:
            text(pos, py + ph + fs + 4, label, anchor="end", rotate=-32)
        else:
            text(pos, py + ph + fs + 10, label, anchor="middle")
    if not horizontal:
        out.append(f'<line x1="{px:.1f}" x2="{px + pw:.1f}" y1="{py + ph:.1f}" y2="{py + ph:.1f}" stroke="{fg}" '
                   'stroke-opacity="0.45" stroke-width="1.5"/>')
    if spec.get("y_label") and not horizontal:
        text(fs * 0.9, py + ph / 2, spec["y_label"], anchor="middle", rotate=-90)
    if spec.get("x_label"):
        text(px + pw / 2, py + ph + (fs * 2 + 28 if not rotate else min(110.0, ph) + 20), spec["x_label"],
             anchor="middle")


def _bars(out, spec, series, n, band, start, V, pal, unit, fs, fg, show_values, horizontal):
    stacked = spec.get("stacked", False)
    gap = band * (0.34 if len(series) == 1 else 0.26)
    inner = band - gap
    width = inner if stacked else inner / max(1, len(series))
    up, down = [0.0] * n, [0.0] * n
    e = html.escape
    for k, s in enumerate(series):
        for j, v in enumerate(s["values"]):
            if v is None:
                continue
            a0 = (up[j] if v >= 0 else down[j]) if stacked else 0
            a1 = a0 + v
            if stacked:
                if v >= 0:
                    up[j] = a1
                else:
                    down[j] = a1
            lo_, hi_ = V(min(a0, a1)), V(max(a0, a1))
            offset = start(j) + gap / 2 + (0 if stacked else width * k)
            radius = min(4.0, width / 4)
            tip = f"<title>{e(spec['x'][j])} · {e(s['name'])}: {e(_fmt(v, unit))}</title>"
            if horizontal:
                out.append(f'<rect x="{lo_:.1f}" y="{offset:.1f}" width="{max(1.0, hi_ - lo_):.1f}" height="'
                           f'{width:.1f}" rx="{radius:.1f}" fill="{pal[k]}">{tip}</rect>')
                if show_values:
                    out.append(f'<text x="{hi_ + 8:.1f}" y="{offset + width / 2 + fs * 0.35:.1f}" font-size="{fs - 1}" '
                               f'fill="{fg}" font-weight="600">{e(_fmt(v, unit))}</text>')
            else:
                out.append(f'<rect x="{offset:.1f}" y="{hi_:.1f}" width="{width:.1f}" height="'
                           f'{max(1.0, lo_ - hi_):.1f}" rx="{radius:.1f}" fill="{pal[k]}">{tip}</rect>')
                if show_values:
                    ty = hi_ - 8 if v >= 0 else lo_ + fs + 4
                    out.append(f'<text x="{offset + width / 2:.1f}" y="{ty:.1f}" font-size="{fs - 1}" fill="{fg}" '
                               f'text-anchor="middle" font-weight="600">{e(_fmt(v, unit))}</text>')


# =========================================================================== HTML

_CSS = string.Template("""
:root{--bg:#$bg;--fg:#$fg;--muted:#$muted;--accent:#$accent;--rule:#$rule;--surface:#$surface;--page:#$page;
--page-fg:#$page_fg;--cover-bg:#$cover_bg;--cover-fg:#$cover_fg;--cover-muted:#$cover_muted;
--cover-accent:#$cover_accent;--sec-bg:#$section_bg;--sec-fg:#$section_fg;--sec-muted:#$section_muted;
--sec-accent:#$section_accent;--head:$head_css;--body:$body_css;--quote:$quote_css;--hw:$head_weight;
--qstyle:$quote_style}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--page-fg);font-family:var(--body);-webkit-font-smoothing:antialiased;
-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
.deck{max-width:1180px;margin:0 auto;padding:28px 20px 56px;display:flex;flex-direction:column;gap:30px}
.unit{display:flex;flex-direction:column;gap:10px}
.slide{position:relative;width:100%;aspect-ratio:$W/$H;container-type:inline-size;overflow:hidden;
background:var(--bg);color:var(--fg);border-radius:10px;box-shadow:0 1px 2px rgb(0 0 0/.07),0 12px 32px rgb(0 0 0/.13)}
.in{--u:calc(100cqw/$W);position:absolute;inset:0;display:flex;flex-direction:column;
padding:calc(var(--u)*$top) calc(var(--u)*$pad) calc(var(--u)*$bottom)}
.slide h1,.slide h2,.slide h3,.slide p,.slide ul,.slide figure,.slide blockquote,.slide figcaption{margin:0;padding:0}
.t{font-family:var(--head);font-weight:var(--hw);font-size:calc(var(--u)*var(--ts));line-height:$title_lh;
letter-spacing:${title_track}em;text-wrap:balance;overflow-wrap:break-word}
.st{font-size:calc(var(--u)*var(--ss));line-height:$subtitle_lh;color:var(--muted);text-wrap:balance;
overflow-wrap:break-word}
.t+.st{margin-top:calc(var(--u)*$subtitle_gap)}
.tbar{flex:none;width:calc(var(--u)*$bar_w);height:calc(var(--u)*$bar_h);background:var(--accent);
margin-bottom:calc(var(--u)*$bar_gap)}
.hd{flex:none;margin-bottom:calc(var(--u)*$head_gap)}
.bd{flex:1;min-height:0;display:flex;gap:calc(var(--u)*$col_gap);overflow:hidden}
ul.b{list-style:none;flex:1;min-width:0;font-size:calc(var(--u)*var(--bs));line-height:$body_lh;overflow-wrap:break-word}
ul.b>li{position:relative;padding-left:${indent}em}
ul.b>li+li{margin-top:${bullet_gap}em}
ul.b>li::before{content:"";position:absolute;background:var(--accent);$marker}
ul.s{list-style:none;margin-top:${sub_first}em;font-size:${sub_scale}em;color:var(--muted)}
ul.s>li{position:relative;padding-left:${sub_indent}em}
ul.s>li+li{margin-top:${sub_between}em}
ul.s>li::before{content:"";position:absolute;left:0;top:.74em;width:.5em;height:.09em;background:currentColor;opacity:.75}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--u)*$col_gap)}
.col{position:relative;min-width:0;border-top:calc(var(--u)*2) solid var(--rule);padding-top:calc(var(--u)*$col_pad);
display:flex;flex-direction:column}
.col::before{content:"";position:absolute;left:0;top:calc(var(--u)*-2);width:calc(var(--u)*64);height:calc(var(--u)*2);
background:var(--accent)}
.ch{font-family:var(--head);font-weight:$col_weight;font-size:calc(var(--u)*var(--hs));line-height:$heading_lh;
overflow-wrap:break-word}
.ch+ul.b{margin-top:calc(var(--u)*var(--hg))}
.col ul.b{flex:none}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.ct{flex:none;font-size:calc(var(--u)*$chart_label);line-height:1.3;color:var(--muted);
margin-bottom:calc(var(--u)*$chart_label_gap)!important}
.chart{flex:1;min-height:0;position:relative}
.chart svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.chart text{font-family:var(--body);font-variant-numeric:tabular-nums}
.pic{justify-content:center;align-items:center}
.pic img{display:block;flex:none;width:calc(var(--u)*var(--iw));height:calc(var(--u)*var(--ih));max-width:100%;
max-height:100%;object-fit:contain}
.cap{flex:none;align-self:stretch;font-size:calc(var(--u)*$caption);line-height:1.35;color:var(--muted);
text-align:center;margin-top:calc(var(--u)*$caption_gap)!important}
.side{flex:0 0 calc(var(--u)*var(--sw));display:flex;flex-direction:column;justify-content:center;min-width:0}
.side ul.b{flex:none}
.full .in{padding:calc(var(--u)*48)}
table.tb{width:100%;border-collapse:collapse;table-layout:fixed;font-size:calc(var(--u)*var(--fs));line-height:$table_lh;
font-variant-numeric:tabular-nums;align-self:flex-start}
.tb th,.tb td{padding:${table_vpad}em ${table_hpad}em;text-align:left;vertical-align:top;overflow-wrap:break-word}
.tb td{border-bottom:calc(var(--u)*1) solid var(--rule)}
.tb td:first-child{font-weight:600}
.tb tr:last-child td{border-bottom:0}
.tb th{font-size:${table_head}em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
border-bottom:calc(var(--u)*2) solid var(--fg)}
.tb .n{text-align:right}
.L-quote .in{justify-content:center}
.L-quote .bd{align-items:center}
.qblk{max-width:calc(var(--u)*var(--qw))}
.qm{font-family:Georgia,"Times New Roman",serif;font-size:calc(var(--u)*$quote_mark);line-height:1;
height:calc(var(--u)*$quote_mark_h);color:var(--accent);margin:calc(var(--u)*-26) 0 0 calc(var(--u)*-6);overflow:visible}
.qt{font-family:var(--quote);font-style:var(--qstyle);font-weight:$quote_weight;font-size:calc(var(--u)*var(--qs));
line-height:$quote_lh;text-wrap:pretty;overflow-wrap:break-word;margin-top:calc(var(--u)*26)!important}
.qb{margin-top:calc(var(--u)*$by_gap)!important;font-size:calc(var(--u)*$by_size);line-height:1.35;color:var(--muted)}
.cover{background:var(--cover-bg);color:var(--cover-fg)}
.cover .st{color:var(--cover-muted)}
.sec{background:var(--sec-bg);color:var(--sec-fg)}
.sec .st{color:var(--sec-muted)}
.L-title .in{justify-content:flex-end;padding-bottom:calc(var(--u)*$cover_bottom)}
.L-section .in,.L-closing .in{justify-content:center}
.L-closing .in{align-items:center;text-align:center}
.blk{max-width:calc(var(--u)*var(--bw));position:relative}
.cover .t{line-height:$cover_lh;letter-spacing:${cover_track}em}
.sec .t{line-height:$section_lh;letter-spacing:${section_track}em}
.cover .t+.st{margin-top:calc(var(--u)*$cover_sub_gap)}
.sec .t+.st{margin-top:calc(var(--u)*$section_sub_gap)}
.rule{width:calc(var(--u)*$rule_w);height:calc(var(--u)*$rule_h);background:var(--cover-accent);
margin-bottom:calc(var(--u)*$rule_gap)}
.L-closing .rule{margin-left:auto;margin-right:auto}
.lbl{display:flex;align-items:center;gap:calc(var(--u)*16);font-size:calc(var(--u)*$label_size);line-height:1.2;
font-weight:700;letter-spacing:.14em;color:var(--sec-accent);margin-bottom:calc(var(--u)*$label_gap)}
.lbl::after{content:"";width:calc(var(--u)*48);height:calc(var(--u)*2);background:currentColor}
.glow,.ring{position:absolute;border-radius:50%;pointer-events:none}
.glow{background:radial-gradient(closest-side,#${glow}6B,#${glow}24 55%,#${glow}00)}
.ring{border:calc(var(--u)*2) solid var(--accent);opacity:.32}
.no{position:absolute;right:calc(var(--u)*$pad);bottom:calc(var(--u)*$number_bottom);font-size:calc(var(--u)*$number_size);
line-height:1.3;color:var(--$number_color);font-weight:$number_weight;letter-spacing:.06em;font-variant-numeric:tabular-nums}
.notes{margin:0 4px;font-size:14px;line-height:1.55;color:var(--page-fg)}
.notes summary{cursor:pointer;opacity:.8;font-size:13px}
.notes p{margin:6px 0 0;white-space:pre-wrap;max-width:80ch}
@page{size:${W}px ${H}px;margin:0}
@media print{html,body{background:none}.deck{max-width:none;margin:0;padding:0;gap:0;display:block}
.unit{display:block}.slide{width:${W}px;height:${H}px;aspect-ratio:auto;border-radius:0;box-shadow:none;
break-after:page;page-break-after:always;break-inside:avoid}.unit:last-child .slide{break-after:auto;page-break-after:auto}
.notes{display:none}}
""")

_PRESENT_CSS = string.Template("""
html,body{height:100%;overflow:hidden;background:#000}
.deck{max-width:none;margin:0;padding:0;height:100%;display:block;position:relative}
.unit{display:contents}
.slide{position:absolute;left:50%;top:50%;width:min(100vw,calc(100vh*$W/$H));transform:translate(-50%,-50%);
border-radius:0;box-shadow:none;visibility:hidden}
.slide.on{visibility:visible}
.notes{display:none}
.progress{position:fixed;left:0;bottom:0;height:3px;width:0;background:var(--accent);opacity:.85;
transition:width .2s ease;z-index:2}
@media (prefers-reduced-motion:reduce){.progress{transition:none}}
""")

_PRESENT_JS = """(function(){
var slides=Array.prototype.slice.call(document.querySelectorAll('.slide'));
var bar=document.querySelector('.progress');var i=0;
function show(n){i=Math.max(0,Math.min(slides.length-1,n));
for(var k=0;k<slides.length;k++){var on=k===i;slides[k].classList.toggle('on',on);
slides[k].setAttribute('aria-hidden',on?'false':'true');}
if(bar){bar.style.width=((i+1)/slides.length*100)+'%';}
try{history.replaceState(null,'','#'+(i+1));}catch(e){}}
function leave(){if(document.fullscreenElement&&document.exitFullscreen){document.exitFullscreen().catch(function(){});}
try{window.parent.postMessage({type:'dgc-slides',event:'exit'},'*');}catch(e){}
try{window.dispatchEvent(new CustomEvent('dgc-slides-exit'));}catch(e){}}
document.addEventListener('keydown',function(e){if(e.altKey||e.ctrlKey||e.metaKey){return;}var k=e.key;
if(k==='ArrowRight'||k==='ArrowDown'||k==='PageDown'||k===' '||k==='Enter'||k==='n'){show(i+1);}
else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'||k==='Backspace'||k==='p'){show(i-1);}
else if(k==='Home'){show(0);}else if(k==='End'){show(slides.length-1);}
else if(k==='f'||k==='F'){if(document.fullscreenElement){document.exitFullscreen();}
else if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen().catch(function(){});}}
else if(k==='Escape'||k==='Esc'){leave();}else{return;}e.preventDefault();});
var x0=null,swiped=false;
document.addEventListener('touchstart',function(e){x0=e.touches[0].clientX;},{passive:true});
document.addEventListener('touchend',function(e){if(x0===null){return;}var dx=e.changedTouches[0].clientX-x0;x0=null;
if(Math.abs(dx)>40){swiped=true;show(i+(dx<0?1:-1));}},{passive:true});
document.addEventListener('click',function(e){if(swiped){swiped=false;return;}
if(e.target.closest&&e.target.closest('a,summary,button')){return;}
show(e.clientX<window.innerWidth*0.3?i-1:i+1);});
var start=parseInt((location.hash||'').slice(1),10);show(isNaN(start)?0:start-1);})();"""

_MARKERS = {"dot": "left:.1em;top:.6em;width:.34em;height:.34em;border-radius:50%",
            "dash": "left:0;top:.69em;width:.62em;height:.1em",
            "square": "left:.08em;top:.58em;width:.36em;height:.36em"}


def _css(look: _Look, dims: tuple) -> str:
    W, H = dims
    return _CSS.substitute(
        bg=look.bg, fg=look.fg, muted=look.muted, accent=look.accent, rule=look.rule, surface=look.surface,
        page=look.page, page_fg=look.page_fg, cover_bg=look.cover_bg, cover_fg=look.cover_fg,
        cover_muted=look.cover_muted, cover_accent=look.cover_accent, section_bg=look.section_bg,
        section_fg=look.section_fg, section_muted=look.section_muted, section_accent=look.section_accent,
        head_css=look.head_css, body_css=look.body_css,
        quote_css=_SERIF if look.quote_face == "serif" else look.head_css, head_weight=look.head_weight,
        quote_style="italic" if look.quote_italic else "normal", title_track=TITLE_TRACK, cover_track=COVER_TRACK,
        section_track=SECTION_TRACK, glow=look.palette[1], W=W, H=H, top=TOP, pad=_pad(W), bottom=BOTTOM,
        title_lh=TITLE_LH, subtitle_lh=SUBTITLE_LH, subtitle_gap=SUBTITLE_GAP, bar_w=BAR_W, bar_h=BAR_H,
        bar_gap=BAR_GAP, head_gap=HEAD_GAP, col_gap=COL_GAP, body_lh=BODY_LH, indent=INDENT, bullet_gap=BULLET_GAP,
        marker=_MARKERS[look.marker], sub_first=SUB_FIRST, sub_scale=SUB_SCALE, sub_indent=SUB_INDENT,
        sub_between=SUB_BETWEEN, col_pad=COL_PAD, col_weight=700, heading_lh=HEADING_LH, chart_label=CHART_LABEL,
        chart_label_gap=CHART_LABEL_GAP, caption=CAPTION, caption_gap=CAPTION_GAP, table_lh=TABLE_LH,
        table_vpad=TABLE_VPAD, table_hpad=TABLE_HPAD, table_head=TABLE_HEAD, quote_mark=QUOTE_MARK,
        quote_mark_h=QUOTE_MARK_H,
        quote_weight=700 if look.quote_face != "serif" and look.head_weight >= 800 else 400, quote_lh=QUOTE_LH,
        by_gap=BY_GAP, by_size=BY_SIZE, cover_bottom=COVER_BOTTOM, cover_lh=COVER_LH, section_lh=SECTION_LH,
        cover_sub_gap=COVER_SUB_GAP, section_sub_gap=SECTION_SUB_GAP, rule_w=RULE_W, rule_h=RULE_H,
        rule_gap=RULE_GAP, label_size=LABEL_SIZE, label_gap=LABEL_GAP, number_bottom=NUMBER_BOTTOM,
        number_size=NUMBER_SIZE, number_color="accent" if look.number_bold else "muted",
        number_weight=700 if look.number_bold else 400)


def _ul(bullets) -> str:
    e = html.escape
    items = []
    for bullet in bullets:
        text, subs = _bt(bullet)
        inner = "".join(f"<li>{e(s)}</li>" for s in subs)
        items.append(f"<li>{e(text)}" + (f'<ul class="s">{inner}</ul>' if subs else "") + "</li>")
    return '<ul class="b">' + "".join(items) + "</ul>"


def _num_css(value) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)


def _slide_html(slide: dict, n: int, plan: dict, look: _Look, dims: tuple) -> tuple[str, str]:
    e = html.escape
    W, H = dims
    layout = plan["layout"]
    v = plan["vars"]
    rules = [f"--{k}:{_num_css(val)}" for k, val in v.items() if k in ("ts", "ss", "bs", "hs", "hg", "qs", "qw",
                                                                      "fs", "sw", "bw", "iw", "ih")]
    css = f"#s{n}{{{';'.join(rules)}}}" if rules else ""
    title = plan.get("title", slide.get("title", ""))
    subtitle = slide.get("subtitle", "")
    label = f"Slide {n}" + (f": {title}" if title else "")
    classes = ["slide", f"L-{layout}"]
    deco = ""
    if layout in ("title", "closing"):
        classes.append("cover")
        if "glow" in v:
            (gx, gy, gw, gh), (rx, ry, rw, rh) = v["glow"]
            css += (f"#s{n} .glow{{left:calc(var(--u)*{gx:.0f});top:calc(var(--u)*{gy:.0f});width:calc(var(--u)*"
                    f"{gw:.0f});height:calc(var(--u)*{gh:.0f})}}#s{n} .ring{{left:calc(var(--u)*{rx:.0f});top:calc("
                    f"var(--u)*{ry:.0f});width:calc(var(--u)*{rw:.0f});height:calc(var(--u)*{rh:.0f})}}")
            deco = '<div class="glow"></div><div class="ring"></div>'
    elif layout == "section":
        classes.append("sec")
    if plan.get("full"):
        classes.append("full")
    body = ""
    if layout in ("title", "closing", "section"):
        tag = "h1" if layout == "title" else "h2"
        inner = ""
        if layout == "section":
            inner += f'<div class="lbl" aria-hidden="true">{e(plan["label"])}</div>'
        elif look.deco == "rule":
            inner += '<div class="rule"></div>'
        if title:
            inner += f'<{tag} class="t">{e(title)}</{tag}>'
        if subtitle:
            inner += f'<p class="st">{e(subtitle)}</p>'
        body = f'<div class="blk">{inner}</div>'
    else:
        head = ""
        if title or subtitle:
            head = ('<div class="tbar"></div>' if look.bar else "") + '<header class="hd">' + \
                (f'<h2 class="t">{e(title)}</h2>' if title else "") + \
                (f'<p class="st">{e(subtitle)}</p>' if subtitle else "") + "</header>"
        if layout == "bullets":
            bullets = slide["bullets"]
            if plan.get("cols") == 2:
                k = plan["split"]
                content = _ul(bullets[:k]) + _ul(bullets[k:])
            else:
                content = _ul(bullets)
            body = head + f'<div class="bd">{content}</div>'
        elif layout == "two_columns":
            cols = ""
            for side in ("left", "right"):
                col = slide[side]
                cols += '<div class="col">' + (f'<h3 class="ch">{e(col["heading"])}</h3>' if col.get("heading") else "")
                cols += (_ul(col["bullets"]) if col.get("bullets") else "") + "</div>"
            body = head + f'<div class="bd cols">{cols}</div>'
        elif layout in ("image", "chart"):
            if layout == "chart":
                mw, ch = plan["chart_box"]
                label_html = f'<p class="ct">{e(plan["chart_label"])}</p>' if plan.get("chart_label") else ""
                main = (f'<figure class="main">{label_html}<div class="chart">'
                        f'{chart_svg(slide["chart"], mw, ch, look)}</div></figure>')
            else:
                image = slide["image"]
                alt = image.get("alt") or image.get("caption") or ""
                cap = f'<figcaption class="cap">{e(image["caption"])}</figcaption>' if image.get("caption") else ""
                main = (f'<figure class="main pic"><img src="{e(image["src"])}" alt="{e(alt)}">{cap}</figure>')
            side = f'<div class="side">{_ul(slide["bullets"])}</div>' if slide.get("bullets") else ""
            body = head + f'<div class="bd">{main}{side}</div>'
        elif layout == "quote":
            quote = slide["quote"]
            by = f'<p class="qb">— {e(quote["by"])}</p>' if quote.get("by") else ""
            block = (f'<figure class="qblk"><div class="qm" aria-hidden="true">“</div><blockquote class="qt">'
                     f'{e(quote["text"])}</blockquote>{by}</figure>')
            body = head + (f'<div class="bd">{block}</div>' if head else block)
        elif layout == "table":
            fit = plan["table_fit"]
            table = slide["table"]
            cols = "".join("<col>" for _ in table["columns"])
            css += "".join(f"#s{n} col:nth-child({c + 1}){{width:{w * 100:.2f}%}}" for c, w in enumerate(fit["widths"]))
            right = [' class="n"' if numeric else "" for numeric in fit["numeric"]]      # numbers align right
            heads = "".join(f'<th scope="col"{right[c]}>{e(h)}</th>' for c, h in enumerate(table["columns"]))
            rows = ""
            for row in table["rows"]:
                rows += "<tr>" + "".join(f"<td{right[c]}>{e(_cell_text(val))}</td>" for c, val in enumerate(row)) + \
                    "</tr>"
            body = head + (f'<div class="bd"><table class="tb"><colgroup>{cols}</colgroup><thead><tr>{heads}</tr>'
                           f"</thead><tbody>{rows}</tbody></table></div>")
    number = f'<div class="no" aria-hidden="true">{n}</div>' if plan["number"] else ""
    section = (f'<section class="{" ".join(classes)}" id="s{n}" aria-label="{e(label)}">'
               f'<div class="in">{deco}{body}{number}</div></section>')
    notes = ""
    if slide.get("notes"):
        notes = f'<details class="notes"><summary>Speaker notes</summary><p>{e(slide["notes"])}</p></details>'
    return f'<article class="unit">{section}{notes}</article>', css


def render_html(deck, *, mode: str = "view", title: str = "", nonce: str | None = None) -> str:
    """The deck as one standalone HTML page. "view": every slide stacked, each in its exact shape, scaled to the
    width, speaker notes under each; no script. "present": one slide at a time filling the window; arrow keys,
    space or a click move, F goes full screen and Esc leaves (it posts {type: "dgc-slides", event: "exit"} to the
    page that framed it). The page loads nothing from anywhere and declares a policy that says so; its one script
    and its style carry ``nonce``, made here when none is given, so it runs under a nonce-only script policy."""
    if mode not in ("view", "present"):
        raise SlidesError('mode is "view" or "present".')
    d = normalize(deck)
    look = _look(d["theme"])
    dims = SIZES[d["size"]]
    plans = _plans(d, look)
    units, rules = [], []
    for n, (slide, plan) in enumerate(zip(d["slides"], plans), 1):
        unit, css = _slide_html(slide, n, plan, look, dims)
        units.append(unit)
        rules.append(css)
    if mode == "present" and units:
        units[0] = units[0].replace('class="slide ', 'class="slide on ', 1)
    nonce = nonce or secrets.token_urlsafe(16)
    if not re.fullmatch(r"[A-Za-z0-9+/=_\-]{8,128}", nonce):
        raise SlidesError("nonce is 8 to 128 base64 characters.")
    name = title or next((s.get("title") for s in d["slides"] if s.get("title")), "") or "Slides"
    style = _css(look, dims) + "".join(rules)
    policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    script = progress = ""
    if mode == "present":
        style += _PRESENT_CSS.substitute(W=dims[0], H=dims[1])
        policy += f"; script-src 'nonce-{nonce}'"
        script = f'<script nonce="{nonce}">{_PRESENT_JS}</script>'
        progress = '<div class="progress" aria-hidden="true"></div>'
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="{policy}">'
            f'<title>{html.escape(name)}</title><style nonce="{nonce}">{style}</style></head>'
            f'<body class="{mode}"><main class="deck" aria-label="{html.escape(name)}">{"".join(units)}</main>'
            f"{progress}{script}</body></html>")


# =========================================================================== PowerPoint

_EMU = 9525                       # one design px (1/96 in) in EMU
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PML = "application/vnd.openxmlformats-officedocument.presentationml"
_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"


def _emu(px: float) -> int:
    return int(round(px * _EMU))


def _font(look: _Look, kind: str) -> str:
    return {"head": look.head_font, "body": look.body_font, "mark": "Georgia",
            "quote": "Georgia" if look.quote_face == "serif" else look.head_font}[kind]


def _ppt_runs(runs, look: _Look) -> str:
    out = ""
    for r in runs:
        size = max(100, int(round(r["size"] * 75)))          # px to hundredths of a point
        extra = ' cap="all"' if r["caps"] else ""
        if r["spacing"]:
            extra += f' spc="{int(round(r["spacing"] * r["size"] * 75))}"'
        font = made._x(_font(look, r["font"]))
        rpr = (f'<a:rPr lang="en-US" sz="{size}" b="{1 if r["bold"] else 0}" i="{1 if r["italic"] else 0}"'
               f'{extra} dirty="0"><a:solidFill><a:srgbClr val="{r["color"]}"/></a:solidFill>'
               f'<a:latin typeface="{font}"/><a:cs typeface="{font}"/></a:rPr>')
        out += f"<a:br>{rpr}</a:br>".join(f"<a:r>{rpr}<a:t>{made._x(piece)}</a:t></a:r>"
                                          for piece in r["text"].split("\n"))
    return out


def _ppt_paras(paras, look: _Look) -> str:
    out = ""
    for p in paras:
        lh = int(round(p["lh"] / 1.16 * 100000))
        ppr = f'<a:lnSpc><a:spcPct val="{lh}"/></a:lnSpc>'
        if p["before"]:
            ppr += f'<a:spcBef><a:spcPts val="{int(round(p["before"] * 75))}"/></a:spcBef>'
        ppr += '<a:spcAft><a:spcPts val="0"/></a:spcAft>'
        attrs = f' algn="{p["align"]}"'
        if p["bullet"]:
            b = p["bullet"]
            ppr += (f'<a:buClr><a:srgbClr val="{b["color"]}"/></a:buClr><a:buSzPct val="{int(b["scale"] * 100000)}"/>'
                    f'<a:buFont typeface="Arial"/><a:buChar char="{made._x(b["char"])}"/>')
            attrs += f' marL="{_emu(p["indent"])}" indent="{-_emu(p["hang"])}" lvl="{p["level"]}"'
        else:
            ppr += "<a:buNone/>"
        out += f'<a:p><a:pPr{attrs}>{ppr}</a:pPr>{_ppt_runs(p["runs"], look)}</a:p>'
    return out


def _ppt_shape(sid: int, item: dict, look: _Look) -> str:
    x, y, w, h = item["box"]
    xfrm = f'<a:xfrm><a:off x="{_emu(x)}" y="{_emu(y)}"/><a:ext cx="{_emu(w)}" cy="{_emu(h)}"/></a:xfrm>'
    if item["kind"] == "shape":
        alpha = f'<a:alpha val="{int(item.get("alpha", 1) * 100000)}"/>' if item.get("alpha", 1) < 1 else ""
        fill = (f'<a:solidFill><a:srgbClr val="{item["fill"]}">{alpha}</a:srgbClr></a:solidFill>' if item.get("fill")
                else "<a:noFill/>")
        if item.get("glow"):
            stops = "".join(f'<a:gs pos="{pos}"><a:srgbClr val="{item["fill"]}"><a:alpha val="{a}"/></a:srgbClr></a:gs>'
                            for pos, a in ((0, 40000), (38000, 14000), (70000, 0), (100000, 0)))
            fill = (f'<a:gradFill flip="none" rotWithShape="1"><a:gsLst>{stops}</a:gsLst><a:path path="circle">'
                    '<a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>')
        line = (f'<a:ln w="{_emu(item.get("line_w", 1))}"><a:solidFill><a:srgbClr val="{item["line"]}">{alpha}'
                f"</a:srgbClr></a:solidFill></a:ln>" if item.get("line") else "<a:ln><a:noFill/></a:ln>")
        return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="Shape {sid}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>'
                f'{xfrm}<a:prstGeom prst="{item["shape"]}"><a:avLst/></a:prstGeom>{fill}{line}</p:spPr></p:sp>')
    role = item.get("role")
    ph = {"title": '<p:ph type="title"/>', "ctrTitle": '<p:ph type="ctrTitle"/>',
          "subTitle": '<p:ph type="subTitle" idx="1"/>'}.get(role, "")
    name = {"title": "Title", "ctrTitle": "Title", "subTitle": "Subtitle"}.get(role, "Text")
    fit = "<a:normAutofit/>" if item.get("autofit", True) else "<a:noAutofit/>"
    if item["anchor"] != "b":                       # room below the last line; the next box doesn't move
        xfrm = (f'<a:xfrm><a:off x="{_emu(x)}" y="{_emu(y)}"/><a:ext cx="{_emu(w)}" cy="{_emu(h * 1.04 + 4)}"/>'
                "</a:xfrm>")
    box = "" if ph else ' txBox="1"'
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name} {sid}"/><p:cNvSpPr{box}/>'
            f'<p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr>{xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'
            f'</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="{item["anchor"]}"'
            f' rtlCol="0">{fit}</a:bodyPr><a:lstStyle/>{_ppt_paras(item["paras"], look)}</p:txBody></p:sp>')


def _ppt_table(sid: int, item: dict, look: _Look) -> str:
    x, y, w, _ = item["box"]
    table, fit = item["table"], item["fit"]
    s = fit["fs"]
    hs = s * TABLE_HEAD
    widths = [_emu(w * f) for f in fit["widths"]]
    widths[-1] += _emu(w) - sum(widths)
    grid = "".join(f'<a:gridCol w="{cw}"/>' for cw in widths)
    font = made._x(look.body_font)

    def cell(text, size, *, head, bold, right, last):
        algn = "r" if right else "l"
        lh = int(round(TABLE_LH / 1.16 * 100000))
        caps = ' cap="all"' if head else ""
        spc = f' spc="{int(round(0.06 * size * 75))}"' if head else ""
        color = look.muted if head else look.fg
        run = (f'<a:r><a:rPr lang="en-US" sz="{int(round(size * 75))}" b="{1 if bold else 0}"{caps}{spc} dirty="0">'
               f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:latin typeface="{font}"/>'
               f'<a:cs typeface="{font}"/></a:rPr><a:t>{made._x(text)}</a:t></a:r>') if text else \
            f'<a:endParaRPr lang="en-US" sz="{int(round(size * 75))}" dirty="0"/>'
        pad_x, pad_y = _emu(TABLE_HPAD * size), _emu(TABLE_VPAD * size)
        bottom = (f'<a:lnB w="{_emu(2)}"><a:solidFill><a:srgbClr val="{look.fg}"/></a:solidFill></a:lnB>' if head else
                  "<a:lnB><a:noFill/></a:lnB>" if last else
                  f'<a:lnB w="{_emu(1)}"><a:solidFill><a:srgbClr val="{look.rule}"/></a:solidFill></a:lnB>')
        lines = "<a:lnL><a:noFill/></a:lnL><a:lnR><a:noFill/></a:lnR><a:lnT><a:noFill/></a:lnT>" + bottom
        return (f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="{algn}"><a:lnSpc><a:spcPct val="{lh}"/>'
                f'</a:lnSpc></a:pPr>{run}</a:p></a:txBody><a:tcPr marL="{pad_x}" marR="{pad_x}" marT="{pad_y}" '
                f'marB="{pad_y}">{lines}<a:noFill/></a:tcPr></a:tc>')
    num = fit["numeric"]
    rows = f'<a:tr h="{_emu(fit["head_h"])}">' + "".join(
        cell(h, hs, head=True, bold=True, right=num[c], last=False) for c, h in enumerate(table["columns"])) + "</a:tr>"
    for r, row in enumerate(table["rows"]):
        last = r == len(table["rows"]) - 1
        rows += f'<a:tr h="{_emu(fit["row_hs"][r])}">' + "".join(
            cell(_cell_text(v), s, head=False, bold=c == 0, right=num[c], last=last) for c, v in enumerate(row)) + \
            "</a:tr>"
    return (f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{sid}" name="Table {sid}"/><p:cNvGraphicFramePr>'
            '<a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
            f'<p:xfrm><a:off x="{_emu(x)}" y="{_emu(y)}"/><a:ext cx="{_emu(w)}" cy="{_emu(fit["height"])}"/></p:xfrm>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
            f'<a:tblPr firstRow="1" bandRow="0"/><a:tblGrid>{grid}</a:tblGrid>{rows}</a:tbl></a:graphicData>'
            "</a:graphic></p:graphicFrame>")


def _ppt_picture(sid: int, item: dict, rid: str, svg_rid: str = "") -> str:
    x, y, w, h = item["box"]
    ext = ""
    if svg_rid:
        ext = ('<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip '
               'xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" '
               f'r:embed="{svg_rid}"/></a:ext></a:extLst>')
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{sid}" name="Picture {sid}" descr="{made._x(item["alt"])}"/>'
            '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="{rid}">{ext}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="{_emu(x)}" y="{_emu(y)}"/><a:ext cx="{_emu(w)}" cy="{_emu(h)}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')


def _ppt_chart_frame(sid: int, item: dict, rid: str) -> str:
    x, y, w, h = item["box"]
    return (f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{sid}" name="Chart {sid}" '
            f'descr="{made._x(item["spec"].get("title") or "Chart")}"/><p:cNvGraphicFramePr/><p:nvPr/>'
            f'</p:nvGraphicFramePr><p:xfrm><a:off x="{_emu(x)}" y="{_emu(y)}"/><a:ext cx="{_emu(w)}" cy="{_emu(h)}"/>'
            '</p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
            f'<c:chart xmlns:c="{_C}" r:id="{rid}"/></a:graphicData></a:graphic></p:graphicFrame>')


def _number_format(unit: str, values) -> str:
    big = max([abs(v) for v in values if v is not None] + [0])
    integral = all(float(v).is_integer() for v in values if v is not None)
    if big >= 1e6:
        core = '#,##0.0,,"M"'
    elif big >= 1e5:
        core = '#,##0,"K"'
    else:
        core = "#,##0" if integral else "#,##0.0#"
    unit = unit.replace('"', "")
    if len(unit) == 1 and unit in "$₹€£¥":
        return f'"{unit}"{core}'
    if unit == "%":
        return core + '"%"'
    return core + (f'" {unit}"' if unit else "")


def _chart_part(spec: dict, look: _Look) -> tuple[str, bytes]:
    """A native PowerPoint chart for a spec, and the workbook that holds its numbers (so Edit Data works)."""
    kind, series, unit = spec["type"], spec["series"], spec.get("unit", "")
    pal = look.palette
    font = made._x(look.body_font)
    fs = 1350                                    # 18 px, as the page's chart text
    x = lambda t: made._x(t)                     # noqa: E731

    def txpr(size=fs, color=look.muted, bold=False):
        return (f'<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="{size}" b="{1 if bold else 0}">'
                f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:latin typeface="{font}"/>'
                f'<a:cs typeface="{font}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>')

    def str_ref(ref, values):
        pts = "".join(f'<c:pt idx="{i}"><c:v>{x(v)}</c:v></c:pt>' for i, v in enumerate(values))
        return f'<c:strRef><c:f>{ref}</c:f><c:strCache><c:ptCount val="{len(values)}"/>{pts}</c:strCache></c:strRef>'

    def num_ref(ref, values, code="General"):
        pts = "".join(f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in enumerate(values) if v is not None)
        return (f'<c:numRef><c:f>{ref}</c:f><c:numCache><c:formatCode>{x(code)}</c:formatCode>'
                f'<c:ptCount val="{len(values)}"/>{pts}</c:numCache></c:numRef>')

    def solid(color, alpha=None):
        a = f'<a:alpha val="{alpha}"/>' if alpha else ""
        return f'<a:solidFill><a:srgbClr val="{color}">{a}</a:srgbClr></a:solidFill>'

    def axis_title(text, rotate=False):
        rot = ' rot="-5400000" vert="horz"' if rotate else ""
        return (f'<c:title><c:tx><c:rich><a:bodyPr{rot}/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="{fs}" b="0">'
                f'{solid(look.muted)}<a:latin typeface="{font}"/></a:defRPr></a:pPr><a:r><a:rPr lang="en-US" '
                f'sz="{fs}" b="0">{solid(look.muted)}<a:latin typeface="{font}"/></a:rPr><a:t>{x(text)}</a:t></a:r>'
                '</a:p></c:rich></c:tx><c:overlay val="0"/></c:title>')

    grid = f'<c:majorGridlines><c:spPr><a:ln w="9525">{solid(look.rule)}</a:ln></c:spPr></c:majorGridlines>'
    no_line = "<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>"
    base_line = f'<c:spPr><a:ln w="15875">{solid(look.fg, 45000)}</a:ln></c:spPr>'

    def cat_ax(pos, title="", delete=False):
        return (f'<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
                f'<c:delete val="{1 if delete else 0}"/><c:axPos val="{pos}"/>'
                + (axis_title(title) if title else "")
                + '<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/>'
                f'<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>{base_line if pos == "b" else no_line}'
                f'{txpr(color=look.muted if pos == "b" else look.fg)}<c:crossAx val="222"/><c:crosses val="autoZero"/>'
                '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>')

    def val_ax(ax_id, cross, pos, ticks, code, title="", cross_between="between"):
        scaling = '<c:orientation val="minMax"/>'
        step = None
        if ticks:
            scaling += f'<c:max val="{ticks[0][-1]}"/><c:min val="{ticks[0][0]}"/>'
            step = ticks[1]
        return (f'<c:valAx><c:axId val="{ax_id}"/><c:scaling>{scaling}</c:scaling><c:delete val="0"/>'
                f'<c:axPos val="{pos}"/>{grid}' + (axis_title(title, rotate=pos == "l") if title else "")
                + f'<c:numFmt formatCode="{x(code)}" sourceLinked="0"/><c:majorTickMark val="none"/>'
                f'<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>{no_line}{txpr()}<c:crossAx val="{cross}"/>'
                f'<c:crosses val="autoZero"/><c:crossBetween val="{cross_between}"/>'
                + (f'<c:majorUnit val="{step}"/>' if step else "") + "</c:valAx>")

    def series_tx(col, name):
        return f"<c:tx>{str_ref(f'Sheet1!${col}$1', [name])}</c:tx>"

    rows: list = []
    legend = ""
    if kind == "scatter":
        longest = max(len(s["points"]) for s in series)
        header = []
        for s in series:
            header += [f"{s['name']} x", s["name"]]
        rows = [header] + [[""] * (2 * len(series)) for _ in range(longest)]
        sers = ""
        for i, s in enumerate(series):
            cx, cy = made._column(2 * i), made._column(2 * i + 1)
            for r, (px, py) in enumerate(s["points"], 1):
                rows[r][2 * i], rows[r][2 * i + 1] = px, py
            m = len(s["points"]) + 1
            sers += (f'<c:ser><c:idx val="{i}"/><c:order val="{i}"/>{series_tx(cy, s["name"])}<c:spPr><a:ln w="19050">'
                     f'<a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="8"/><c:spPr>'
                     f'{solid(pal[i], 85000)}<a:ln><a:noFill/></a:ln></c:spPr></c:marker>'
                     f'<c:xVal>{num_ref(f"Sheet1!${cx}$2:${cx}${m}", [p[0] for p in s["points"]])}</c:xVal>'
                     f'<c:yVal>{num_ref(f"Sheet1!${cy}$2:${cy}${m}", [p[1] for p in s["points"]])}</c:yVal>'
                     '<c:smooth val="0"/></c:ser>')
        pts = [p for s in series for p in s["points"]]
        xt = _ticks(min(p[0] for p in pts), max(p[0] for p in pts))
        yt = _ticks(min(p[1] for p in pts), max(p[1] for p in pts))
        plot = (f'<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>{sers}'
                '<c:axId val="111"/><c:axId val="222"/></c:scatterChart>'
                + val_ax(111, 222, "b", xt, _number_format("", [p[0] for p in pts]), spec.get("x_label", ""),
                         "midCat")
                + val_ax(222, 111, "l", yt, _number_format(unit, [p[1] for p in pts]), spec.get("y_label", ""),
                         "midCat"))
        if len(series) > 1:
            legend = f'<c:legend><c:legendPos val="t"/><c:overlay val="0"/>{txpr(color=look.fg)}</c:legend>'
    else:
        cats = list(spec["x"])
        cols_values = [list(s["values"]) for s in series]
        horizontal = spec.get("horizontal", False)
        if horizontal:                           # PowerPoint draws the first category at the bottom: reverse
            cats = cats[::-1]
            cols_values = [v[::-1] for v in cols_values]
        n = len(cats)
        rows = [[spec.get("x_label", "")] + [s["name"] for s in series]]
        for j in range(n):
            rows.append([cats[j]] + ["" if v[j] is None else v[j] for v in cols_values])
        cat_ref = f"Sheet1!$A$2:$A${n + 1}"
        allv = [v for vs in cols_values for v in vs if v is not None]
        code = _number_format(unit, allv)
        stacked = spec.get("stacked", False)
        sers = ""
        if kind == "pie":
            vals = cols_values[0]
            points = "".join(f'<c:dPt><c:idx val="{j}"/><c:bubble3D val="0"/><c:spPr>{solid(pal[j % len(pal)])}'
                             f'<a:ln w="28575">{solid(look.bg)}</a:ln></c:spPr></c:dPt>' for j in range(n))
            sers = (f'<c:ser><c:idx val="0"/><c:order val="0"/>{series_tx("B", series[0]["name"])}{points}'
                    f'<c:cat>{str_ref(cat_ref, cats)}</c:cat><c:val>{num_ref(f"Sheet1!$B$2:$B${n + 1}", vals, code)}'
                    "</c:val></c:ser>")
            plot = (f'<c:doughnutChart><c:varyColors val="1"/>{sers}<c:firstSliceAng val="0"/><c:holeSize val="60"/>'
                    "</c:doughnutChart>")
            legend = f'<c:legend><c:legendPos val="r"/><c:overlay val="0"/>{txpr(1275, look.fg)}</c:legend>'
        else:
            sums = [sum(max(0, v[j] or 0) for v in cols_values) for j in range(n)]
            negs = [sum(min(0, v[j] or 0) for v in cols_values) for j in range(n)]
            fit = kind == "line" and not stacked
            lo = min([0] + negs) if stacked else min(allv) if fit else min([0] + allv)
            hi = max([0] + sums) if stacked else max(allv) if fit else max([0] + allv)
            ticks = _ticks(lo, hi if hi != lo else lo + 1)
            show_values = kind == "bar" and not stacked and n * len(series) <= 16
            if show_values and hi > 0 and (ticks[0][-1] - hi) < (ticks[0][-1] - ticks[0][0]) * 0.1:
                ticks = (ticks[0] + [round(ticks[0][-1] + ticks[1], 10)], ticks[1])
            for i, s in enumerate(series):
                col = made._column(i + 1)
                vals = cols_values[i]
                ref = f"Sheet1!${col}$2:${col}${n + 1}"
                if kind == "bar":
                    labels = ""
                    if show_values:
                        labels = (f'<c:dLbls><c:numFmt formatCode="{x(code)}" sourceLinked="0"/><c:spPr><a:noFill/>'
                                  f'<a:ln><a:noFill/></a:ln></c:spPr>{txpr(1125, look.fg, True)}<c:dLblPos val="outEnd"/>'
                                  '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>'
                                  '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>'
                                  "</c:dLbls>")
                    sers += (f'<c:ser><c:idx val="{i}"/><c:order val="{i}"/>{series_tx(col, s["name"])}<c:spPr>'
                             f'{solid(pal[i])}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>{labels}'
                             f'<c:cat>{str_ref(cat_ref, cats)}</c:cat><c:val>{num_ref(ref, vals, code)}</c:val></c:ser>')
                elif kind == "line":
                    sers += (f'<c:ser><c:idx val="{i}"/><c:order val="{i}"/>{series_tx(col, s["name"])}<c:spPr>'
                             f'<a:ln w="44450" cap="rnd">{solid(pal[i])}<a:round/></a:ln></c:spPr><c:marker>'
                             f'<c:symbol val="{"circle" if n <= 30 else "none"}"/><c:size val="7"/><c:spPr>'
                             f'{solid(pal[i])}<a:ln w="19050">{solid(look.bg)}</a:ln></c:spPr></c:marker>'
                             f'<c:cat>{str_ref(cat_ref, cats)}</c:cat><c:val>{num_ref(ref, vals, code)}</c:val>'
                             '<c:smooth val="0"/></c:ser>')
                else:
                    sers += (f'<c:ser><c:idx val="{i}"/><c:order val="{i}"/>{series_tx(col, s["name"])}<c:spPr>'
                             f'{solid(pal[i], 30000)}<a:ln w="38100">{solid(pal[i])}</a:ln></c:spPr>'
                             f'<c:cat>{str_ref(cat_ref, cats)}</c:cat><c:val>{num_ref(ref, vals, code)}</c:val></c:ser>')
            grouping = "stacked" if stacked else ("clustered" if kind == "bar" else "standard")
            axes = '<c:axId val="111"/><c:axId val="222"/>'
            if kind == "bar":
                gap = 52 if len(series) == 1 else 36
                overlap = '<c:overlap val="100"/>' if stacked else '<c:overlap val="-8"/>'
                plot = (f'<c:barChart><c:barDir val="{"bar" if horizontal else "col"}"/><c:grouping val="{grouping}"/>'
                        f'<c:varyColors val="0"/>{sers}<c:gapWidth val="{gap}"/>{overlap}{axes}</c:barChart>')
            elif kind == "line":
                plot = (f'<c:lineChart><c:grouping val="{grouping}"/><c:varyColors val="0"/>{sers}<c:marker val="1"/>'
                        f"{axes}</c:lineChart>")
            else:
                plot = f'<c:areaChart><c:grouping val="{grouping}"/><c:varyColors val="0"/>{sers}{axes}</c:areaChart>'
            cat_pos, val_pos = ("l", "b") if horizontal else ("b", "l")
            plot += cat_ax(cat_pos, spec.get("x_label", "") if not horizontal else "") + \
                val_ax(222, 111, val_pos, ticks, code, spec.get("y_label", "") if not horizontal else
                       spec.get("x_label", ""))
            if len(series) > 1:
                legend = f'<c:legend><c:legendPos val="t"/><c:overlay val="0"/>{txpr(color=look.fg)}</c:legend>'
    chart = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
             f'<c:chartSpace xmlns:c="{_C}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
             f'xmlns:r="{_REL}"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>'
             f'<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>{plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln>'
             f'</c:spPr></c:plotArea>{legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>'
             f'<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>{txpr()}'
             '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>')
    workbook = made.xlsx([{"name": "Sheet1", "rows": rows, "header": True}])
    return chart, workbook


def _png_placeholder(color: str) -> bytes:
    """A 1x1 PNG of one colour: what an Office too old for SVG shows in a picture's place."""
    import zlib
    raw = b"\x00" + bytes(int(color[i:i + 2], 16) for i in (0, 2, 4))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _notes_master() -> str:
    clr = ('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
           'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:notesMaster {made._P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
            '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>'
            '<a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>'
            '</p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks '
            'noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr>'
            '</p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr '
            'val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes '
            'Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" '
            'idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" '
            'cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr '
            'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr '
            'lvl="0"/><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld>'
            f'<p:clrMap {clr}/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" '
            'latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/>'
            '</a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>'
            "</a:lvl1pPr></p:notesStyle></p:notesMaster>")


def _notes_slide(text: str) -> str:
    paras = "".join(f'<a:p><a:r><a:rPr lang="en-US" sz="1400" dirty="0"/><a:t>{made._x(line)}</a:t></a:r></a:p>'
                    if line else '<a:p><a:endParaRPr lang="en-US" sz="1400" dirty="0"/></a:p>' for line in text.split("\n"))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:notes {made._P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
            '</p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/>'
            '<a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image '
            'Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr>'
            '<p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes '
            'Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/>'
            f'</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp></p:spTree>'
            "</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>")


def export_pptx(deck, *, title: str = "") -> bytes:
    """The deck as a PowerPoint file: every layout, the theme's colours and fonts, pictures, native tables and
    charts (each with a workbook of its numbers), and each slide's speaker notes on its notes page."""
    d = normalize(deck)
    look = _look(d["theme"])
    W, H = SIZES[d["size"]]
    plans = _plans(d, look)
    name = title or next((s.get("title") for s in d["slides"] if s.get("title")), "") or "Slides"

    def rels(items) -> str:
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + "".join(f'<Relationship Id="{i}" Type="{t if t.startswith("http") else _REL + "/" + t}" '
                          f'Target="{target}"/>' for i, t, target in items) + "</Relationships>")
    parts: dict = {}
    overrides = {"/ppt/presentation.xml": f"{_PML}.presentation.main+xml",
                 "/ppt/slideMasters/slideMaster1.xml": f"{_PML}.slideMaster+xml",
                 "/ppt/slideLayouts/slideLayout1.xml": f"{_PML}.slideLayout+xml",
                 "/ppt/slideLayouts/slideLayout2.xml": f"{_PML}.slideLayout+xml",
                 "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
                 "/ppt/presProps.xml": f"{_PML}.presProps+xml", "/ppt/viewProps.xml": f"{_PML}.viewProps+xml",
                 "/ppt/tableStyles.xml": f"{_PML}.tableStyles+xml", **made._PROPS}
    defaults = dict(made._BASE_TYPES)
    media: dict = {}                       # sha -> (part name, extension)
    charts = 0
    has_notes = any(s.get("notes") for s in d["slides"])
    for n, (slide, plan) in enumerate(zip(d["slides"], plans), 1):
        slide_rels = [("rId1", "slideLayout", f"../slideLayouts/slideLayout{1 if plan['layout'] == 'title' else 2}"
                                              ".xml")]
        shapes, sid = "", 2
        for item in plan["items"]:
            if item["kind"] in ("shape", "text"):
                shapes += _ppt_shape(sid, item, look)
            elif item["kind"] == "table":
                shapes += _ppt_table(sid, item, look)
            elif item["kind"] == "chart":
                charts += 1
                chart_xml, workbook = _chart_part(item["spec"], look)
                parts[f"ppt/charts/chart{charts}.xml"] = chart_xml
                parts[f"ppt/embeddings/Microsoft_Excel_Worksheet{charts}.xlsx"] = workbook
                parts[f"ppt/charts/_rels/chart{charts}.xml.rels"] = rels(
                    [("rId1", "package", f"../embeddings/Microsoft_Excel_Worksheet{charts}.xlsx")])
                overrides[f"/ppt/charts/chart{charts}.xml"] = \
                    "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
                defaults["xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                rid = f"rId{len(slide_rels) + 1}"
                slide_rels.append((rid, "chart", f"../charts/chart{charts}.xml"))
                shapes += _ppt_chart_frame(sid, item, rid)
            elif item["kind"] == "image":
                mime, data = _data_uri(item["src"])
                ext = {"image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp",
                       "image/svg+xml": "svg"}[mime]
                defaults[ext] = mime

                def keep(raw: bytes, extension: str) -> str:
                    sha = hashlib.sha256(raw).hexdigest()
                    if sha not in media:
                        media[sha] = f"ppt/media/image{len(media) + 1}.{extension}"
                        parts[media[sha]] = raw
                    return media[sha]
                target = keep(data, ext)
                rid = f"rId{len(slide_rels) + 1}"
                if ext == "svg":                       # PowerPoint 2016+ draws the SVG; older ones the PNG
                    defaults["png"] = "image/png"
                    fallback = keep(_png_placeholder(look.surface), "png")
                    slide_rels.append((rid, "image", "../" + fallback[4:]))
                    svg_rid = f"rId{len(slide_rels) + 1}"
                    slide_rels.append((svg_rid, "image", "../" + target[4:]))
                    shapes += _ppt_picture(sid, item, rid, svg_rid)
                else:
                    slide_rels.append((rid, "image", "../" + target[4:]))
                    shapes += _ppt_picture(sid, item, rid)
            sid += 1
        if plan["number"]:
            P = _pad(W)
            shapes += _ppt_shape(sid, _text_item((W - P - 120, H - NUMBER_BOTTOM - NUMBER_SIZE * 1.3, 120,
                                                  NUMBER_SIZE * 1.3),
                                                 [_para(_run(str(n), NUMBER_SIZE, look.accent if look.number_bold
                                                             else look.muted, bold=look.number_bold,
                                                             spacing=0.06), align="r", lh=1.3)], anchor="b"), look)
            sid += 1
        if slide.get("notes"):
            parts[f"ppt/notesSlides/notesSlide{n}.xml"] = _notes_slide(slide["notes"])
            parts[f"ppt/notesSlides/_rels/notesSlide{n}.xml.rels"] = rels(
                [("rId1", "notesMaster", "../notesMasters/notesMaster1.xml"), ("rId2", "slide", f"../slides/slide{n}.xml")])
            overrides[f"/ppt/notesSlides/notesSlide{n}.xml"] = f"{_PML}.notesSlide+xml"
            slide_rels.append((f"rId{len(slide_rels) + 1}", "notesSlide", f"../notesSlides/notesSlide{n}.xml"))
        parts[f"ppt/slides/slide{n}.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<p:sld {made._P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{plan["bg"]}"/></a:solidFill>'
            '<a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
            '</p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/>'
            f'<a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{shapes}</p:spTree></p:cSld><p:clrMapOvr>'
            "<a:masterClrMapping/></p:clrMapOvr></p:sld>")
        parts[f"ppt/slides/_rels/slide{n}.xml.rels"] = rels(slide_rels)
        overrides[f"/ppt/slides/slide{n}.xml"] = f"{_PML}.slide+xml"
    count = len(d["slides"])
    ids = "".join(f'<p:sldId id="{255 + n}" r:id="rId{n + 4}"/>' for n in range(1, count + 1))
    notes_list = f'<p:notesMasterIdLst><p:notesMasterId r:id="rId{count + 6}"/></p:notesMasterIdLst>' if has_notes else ""
    parts["ppt/presentation.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<p:presentation {made._P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
        f'</p:sldMasterIdLst>{notes_list}<p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{_emu(W)}" cy="{_emu(H)}"/>'
        '<p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>'
        "</p:defaultTextStyle></p:presentation>")
    pres_rels = [("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "presProps", "presProps.xml"),
                 ("rId3", "viewProps", "viewProps.xml"), ("rId4", "theme", "theme/theme1.xml"),
                 *((f"rId{n + 4}", "slide", f"slides/slide{n}.xml") for n in range(1, count + 1)),
                 (f"rId{count + 5}", "tableStyles", "tableStyles.xml")]
    if has_notes:
        pres_rels.append((f"rId{count + 6}", "notesMaster", "notesMasters/notesMaster1.xml"))
        parts["ppt/notesMasters/notesMaster1.xml"] = _notes_master()
        parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = rels([("rId1", "theme", "../theme/theme2.xml")])
        parts["ppt/theme/theme2.xml"] = made._theme()
        overrides["/ppt/notesMasters/notesMaster1.xml"] = f"{_PML}.notesMaster+xml"
        overrides["/ppt/theme/theme2.xml"] = "application/vnd.openxmlformats-officedocument.theme+xml"
    parts["ppt/_rels/presentation.xml.rels"] = rels(pres_rels)
    parts["ppt/slideMasters/slideMaster1.xml"] = made._master(look.bg)
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels(
        [("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
         ("rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"), ("rId3", "theme", "../theme/theme1.xml")])
    for k, (kind, layout_name) in enumerate((("title", "Title Slide"), ("obj", "Title and Content")), 1):
        parts[f"ppt/slideLayouts/slideLayout{k}.xml"] = made._layout(kind, layout_name)
        parts[f"ppt/slideLayouts/_rels/slideLayout{k}.xml.rels"] = rels(
            [("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")])
    scheme = {"dk1": look.fg if _lum(look.fg) < _lum(look.bg) else look.bg,
              "lt1": look.bg if _lum(look.fg) < _lum(look.bg) else look.fg, "dk2": look.fg, "lt2": look.surface,
              "hlink": look.accent, "folHlink": look.palette[3]}
    scheme.update({f"accent{i + 1}": c for i, c in enumerate(look.palette[:6])})
    parts["ppt/theme/theme1.xml"] = made._theme(scheme, (look.head_font, look.body_font))
    parts["ppt/presProps.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                  f'<p:presentationPr {made._P}/>')
    parts["ppt/viewProps.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                  f'<p:viewPr {made._P}><p:normalViewPr><p:restoredLeft sz="15620"/>'
                                  '<p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/>'
                                  "</p:viewPr>")
    parts["ppt/tableStyles.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                                    '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                                    'def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>')
    return made._zip({"[Content_Types].xml": made._types(defaults, overrides),
                      "_rels/.rels": made._RELS.replace("{main}", "ppt/presentation.xml"),
                      **parts,
                      "docProps/core.xml": made._core(name),
                      "docProps/app.xml": made._app(f"<Slides>{count}</Slides>")})


# =========================================================================== PDF

def export_pdf(deck, path, browser=None, *, config=None, title: str = "") -> PdfExport:
    """The deck as a PDF at ``path``, one slide a page, printed by the user's Chrome or Edge (``dgc.browser``, the
    page DGC wrote and nothing else readable to it); ``browser`` is a session to print with instead. Without a
    browser, a plain built-in writer lays out each slide's words in Helvetica and the note says so."""
    d = normalize(deck)
    look = _look(d["theme"])
    W, H = SIZES[d["size"]]
    page = render_html(d, mode="view", title=title)
    note = ""
    try:
        raw = _print(page, W / 96, H / 96, config, browser)
        pages = len(re.findall(rb"/Type\s*/Page(?!s)", raw))
    except Exception as exc:                      # no browser, or it wouldn't print: the plain writer, and say so
        reason = made._why_plain(exc)
        raw, missing, pages = _plain_pdf(_plans(d, look), d, look, (W, H))
        note = (f"This PDF is plain text in Helvetica: {reason}"
                + (f" {missing} character{'s' if missing != 1 else ''} it can't draw show as ?." if missing else ""))
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    return PdfExport(str(target), pages, note)


def _print(page: str, width_in: float, height_in: float, config, browser) -> bytes:
    """made._print's path, at the slide's own page size with no margins and no footer."""
    from . import browser as cdp
    folder = tempfile.mkdtemp(prefix="dgc-slides-")
    path = os.path.join(folder, "deck.html")
    session = None
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(page)
        get = getattr(config, "get", None) or (lambda key, default=None: default)
        session = browser or cdp.BrowserSession(cdp.discover_browser(str(get("browser_path", "") or "")),
                                                allow_unsandboxed=bool(get("browser_allow_unsandboxed", False)),
                                                readable=(folder,))
        session.navigate("file://" + path if os.sep == "/" else "file:///" + path.replace("\\", "/"))
        result = session.command("Page.printToPDF", {
            "paperWidth": width_in, "paperHeight": height_in, "printBackground": True, "preferCSSPageSize": True,
            "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0, "displayHeaderFooter": False,
            "generateDocumentOutline": True}, timeout=90.0)
        raw = base64.b64decode(result.get("data") or "")
        if not raw.startswith(b"%PDF"):
            raise made.MadeError("the browser returned no PDF")
        return raw
    finally:
        if session is not None and browser is None:
            session.close()
        try:
            os.remove(path)
            os.rmdir(folder)
        except OSError:
            pass


def _plain_pdf(plans: list, deck: dict, look: _Look, dims: tuple) -> tuple[bytes, int, int]:
    """Each slide's words in Helvetica on its own page, in the theme's colours, where the plan puts them."""
    W, H = dims
    k = 0.75                                                  # design px to PDF points
    pw, ph = W * k, H * k
    missing = 0
    streams = []

    def rgb(hex6: str) -> str:
        return " ".join(f"{int(hex6[i:i + 2], 16) / 255:.3f}" for i in (0, 2, 4))

    def text_ops(x, y, value, size, color, font):
        nonlocal missing
        raw, lost = made._winansi(value)
        missing += lost
        return (f"{rgb(color)} rg BT /{font} {size * k:.2f} Tf {x * k:.2f} {ph - y * k:.2f} Td ".encode()
                + made._pdf_string(raw) + b" Tj ET")

    def font_of(run):
        return "F2" if run["bold"] else "F3" if run["italic"] else "F1"

    for n, (slide, plan) in enumerate(zip(deck["slides"], plans), 1):
        ops = [f"{rgb(plan['bg'])} rg 0 0 {pw:.2f} {ph:.2f} re f".encode()]
        for item in plan["items"]:
            x, y, w, h = item["box"]
            if item["kind"] == "shape":
                color = item.get("fill") or item.get("line")
                if item.get("alpha", 1) < 1:
                    color = _mix(plan["bg"], color, item["alpha"])
                if item["shape"] == "rect" and item.get("fill"):
                    ops.append(f"{rgb(color)} rg {x * k:.2f} {ph - (y + h) * k:.2f} {w * k:.2f} {h * k:.2f} re f".encode())
                continue
            if item["kind"] == "text":
                yy = y
                for p in item["paras"]:
                    run = p["runs"][0]
                    size, font = run["size"], font_of(run)
                    yy += p["before"]
                    lead = size * p["lh"]
                    indent = p["indent"] if p["bullet"] else 0
                    value = run["text"].upper() if run["caps"] else run["text"]
                    lines = _wrap(value, w - indent, size, "sans", run["bold"])
                    for i, line in enumerate(lines):
                        base = yy + lead * i + (lead - size) / 2 + size * 0.8
                        lw = made._width(line, size, "F2" if run["bold"] else "F1")
                        lx = x + indent + (0 if p["align"] == "l" else (w - indent - lw) if p["align"] == "r"
                                           else (w - indent - lw) / 2)
                        if i == 0 and p["bullet"]:
                            mark = "–" if p["bullet"]["char"] == "–" else "•"      # both in WinAnsi
                            ops.append(text_ops(x + indent - p["hang"], base, mark, size, p["bullet"]["color"], "F1"))
                        ops.append(text_ops(lx, base, line, size, run["color"], font))
                    yy += lead * len(lines)
            elif item["kind"] == "image":
                ops.append(f"{rgb(look.rule)} RG 1 w {x * k:.2f} {ph - (y + h) * k:.2f} {w * k:.2f} {h * k:.2f} re S"
                           .encode())
                label = f"[Picture: {item['alt']}]"
                ops.append(text_ops(x + 16, y + h / 2, label[:90], 16, look.muted, "F3"))
            elif item["kind"] == "chart":
                spec = item["spec"]
                yy = y + 24
                rows = ([f"{s['name']}: " + ", ".join(f"({_fmt(px)}, {_fmt(py, spec.get('unit', ''))})"
                                                       for px, py in s["points"][:12]) for s in spec["series"]]
                        if spec["type"] == "scatter" else
                        [f"{label}: " + ", ".join(f"{s['name']} {_fmt(s['values'][j], spec.get('unit', ''))}"
                                                  for s in spec["series"]) for j, label in enumerate(spec["x"])])
                for row in rows[:18]:
                    ops.append(text_ops(x, yy, row[:120], 16, look.fg, "F1"))
                    yy += 24
            elif item["kind"] == "table":
                fit, table = item["fit"], item["table"]
                s = fit["fs"]
                widths = [w * f for f in fit["widths"]]
                yy = y
                for r, row in enumerate([table["columns"]] + table["rows"]):
                    size = s * TABLE_HEAD if r == 0 else s
                    height = fit["head_h"] if r == 0 else fit["row_hs"][r - 1]
                    cx = x
                    for c, value in enumerate(row):
                        cell = _cell_text(value).upper() if r == 0 else _cell_text(value)
                        line = _wrap(cell, widths[c] - TABLE_HPAD * size * 2, size, "sans", r == 0)[0] if cell else ""
                        ops.append(text_ops(cx + TABLE_HPAD * size, yy + TABLE_VPAD * size + size, line, size,
                                            look.muted if r == 0 else look.fg, "F2" if r == 0 or c == 0 else "F1"))
                        cx += widths[c]
                    yy += height
                    ops.append(f"{rgb(look.fg if r == 0 else look.rule)} rg {x * k:.2f} {ph - yy * k:.2f} {w * k:.2f} "
                               f"{(2 if r == 0 else 1) * k:.2f} re f".encode())
        if plan["number"]:
            ops.append(text_ops(W - _pad(W) - made._width(str(n), NUMBER_SIZE, "F1"), H - NUMBER_BOTTOM - 3, str(n),
                                NUMBER_SIZE, look.muted, "F1"))
        streams.append(b"\n".join(ops))
    objects: list = [b"<< /Type /Catalog /Pages 2 0 R >>",
                     f"<< /Type /Pages /Kids [{' '.join(f'{9 + 2 * i} 0 R' for i in range(len(streams)))}] "
                     f"/Count {len(streams)} >>".encode()]
    for font in ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Courier"):
        objects.append(f"<< /Type /Font /Subtype /Type1 /BaseFont /{font} /Encoding /WinAnsiEncoding >>".encode())
    name, _ = made._winansi(next((s.get("title") for s in deck["slides"] if s.get("title")), "Slides"))
    objects.append(b"<< /Title " + made._pdf_string(name) + b" /Producer (DGC) >>")
    for stream in streams:
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2f} {ph:.2f}] /Contents "
                       f"{len(objects)} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> >>"
                       .encode())
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out), missing, len(streams)


# =========================================================================== reading a deck back

def outline(deck) -> str:
    """The deck as text the model reads back: each slide's number, layout and words, without the pictures' bytes."""
    d = normalize(deck)
    lines = [f"Deck: {len(d['slides'])} slides, {d['size']}, theme "
             f"{d['theme'] if isinstance(d['theme'], str) else json.dumps(d['theme'])}"]
    for n, s in enumerate(d["slides"], 1):
        lines.append(f"## Slide {n} ({s['layout']})" + (f": {s['title']}" if s.get("title") else ""))
        if s.get("subtitle"):
            lines.append(s["subtitle"])
        for key in ("bullets",):
            for b in s.get(key, []):
                text, subs = _bt(b)
                lines.append(f"- {text}")
                lines += [f"  - {x}" for x in subs]
        for side in ("left", "right"):
            if side in s:
                lines.append(f"{side.title()}: {s[side].get('heading', '')}")
                lines += [f"- {_bt(b)[0]}" for b in s[side].get("bullets", [])]
        if s.get("image"):
            lines.append(f"Picture: {s['image'].get('alt') or s['image'].get('caption') or '(no description)'}")
        if s.get("chart"):
            lines.append("Chart: " + json.dumps(s["chart"], ensure_ascii=False))
        if s.get("quote"):
            lines.append(f"> {s['quote']['text']}" + (f" ({s['quote']['by']})" if s["quote"].get("by") else ""))
        if s.get("table"):
            lines.append(made._csv_text([s["table"]["columns"]] + s["table"]["rows"]).rstrip())
        if s.get("notes"):
            lines.append(f"Notes: {s['notes']}")
    return "\n".join(lines)
