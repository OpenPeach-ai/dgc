"""A design: a canvas of artboards (screens, pages, posters) the model draws one at a time while the user watches.

The data (``design.json``, the index)::

    {"pages": [{"id": "p1", "name": "Page 1"}],
     "boards": [{"id": "b1", "page": "p1", "title": "Desktop", "x": 0, "y": 0, "w": 1440, "h": 900,
                 "fit": "fixed", "interactive": false, "state": "ready", "rev": 1,
                 "tweaks": [{"name": "accent", "label": "Accent colour", "type": "color", "value": "#b5651d"}]}],
     "notes": [{"id": "n1", "page": "p1", "kind": "title", "text": "Landing page", "x": 0, "y": -170}],
     "start": {"page": "p1", "board": ""},
     "last": {"b": 1, "n": 1, "p": 1}}

- A board is a frame on the canvas. ``boards`` is in back-to-front order. Its HTML is a file of the version
  (``boards/<id>.html``), one self-contained page: nothing loaded from the web, so it draws the same anywhere. Until it
  is drawn its ``state`` is "drawing" and it has no file: the canvas shows a named frame that says so.
- ``fit``: "fixed" (a phone, a poster: exactly w by h) or "page" (a whole web page: shown at its width, as tall as it
  is at that width; ``h`` is then the least it is given).
- ``interactive``: its own scripts run when the user plays it (never otherwise). A link to another artboard needs no
  script: any element with ``data-goto="<its id or title>"``.
- ``tweaks``: values the artboard declares for the user to change in a panel (a colour, a size, a switch, a choice).
  Each is a CSS variable on the artboard's root (``--accent``); a switch or a choice is also an attribute there
  (``data-tweak-badge="on"``), so plain CSS can follow it.
- ``rev`` counts the changes to a board's HTML: a change the user made in the editor says which one it started from.
- ``last`` holds the highest number ever given to a board, a note and a page: an id is never used again.

DGC makes the index first, then each artboard as its own version, so every screen shows the canvas filling; a change is
one op (``apply``), and a new frame the model adds is placed in a free spot: 80 px from the last in its row, a new row
120 px below, never over another frame.
"""
from __future__ import annotations

import copy
import html as _html
import re

SOURCE = "design.json"
BOARD_DIR = "boards/"
GAP_X, GAP_Y = 80, 120
ROW_LIMIT = 6400                  # a row grows to about this wide, then the next frame starts a new row
MAX_BOARDS = 60
MAX_NOTES = 100
MAX_PAGES = 12
MAX_TWEAKS = 16
MAX_BOARD_BYTES = 400 * 1024
MAX_TITLE = 80
MAX_NOTE = 2000
MIN_SIDE, MAX_W, MAX_H = 100, 4000, 20000
MAX_AT = 200_000                  # how far from the origin a frame can sit
READ_LIMIT = 60_000
SIZES = {"phone": (390, 844), "tablet": (834, 1194), "desktop": (1440, 900), "wide": (1920, 1080),
         "square": (1080, 1080), "story": (1080, 1920), "poster": (1240, 1754), "page": (1280, 800)}
NOTE_COLORS = ("yellow", "pink", "blue", "green", "grey")
STICKY_W = 220
BOARD_ID = re.compile(r"b[1-9][0-9]{0,4}\Z")
NOTE_ID = re.compile(r"n[1-9][0-9]{0,4}\Z")
PAGE_ID = re.compile(r"p[1-9][0-9]{0,3}\Z")
TWEAK_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
TWEAK_TYPES = ("color", "size", "switch", "choice")
_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z")
_SIZE = re.compile(r"(-?[0-9]{1,5}(?:\.[0-9]{1,3})?)(px|rem|em|%|vw|vh)\Z")
_CHOICE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,39}\Z")
# What every artboard may reach: its own inline styles and, when played, its own inline scripts; pictures and fonts only
# as data inside it. The canvas, DGC's page of a design and every export put this policy in the artboard's page.
POLICY = ("default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; "
          "base-uri 'none'; form-action 'none'")
POLICY_PLAY = POLICY + "; script-src 'unsafe-inline'"


class DesignError(ValueError):
    """What was asked can't be done to a design; the words say what to change."""


def plain(value) -> str:
    """Words as they are read, not as HTML writes them: a model that writes “Kettle &amp; Cane” in a title means
    “Kettle & Cane” (a title, a name and a note are shown as text, never as markup)."""
    return _html.unescape(str(value or ""))


def _line(value, limit: int) -> str:
    return " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", plain(value)).split())[:limit].strip()


def _text(value, limit: int) -> str:
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", plain(value)).replace("\r\n", "\n").strip()[:limit]


def _int(value, what: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise DesignError(f"{what} is a number.")
    n = int(round(value))
    if not low <= n <= high:
        raise DesignError(f"{what} is between {low} and {high}.")
    return n


def board_file(bid: str) -> str:
    return f"{BOARD_DIR}{bid}.html"


# ---- an artboard's HTML -----------------------------------------------------------------------------------------------
_LOADS = re.compile(r"<(script|link|img|video|audio|source|track|input|image|use)\b[^>]*?\s(?:src|href|poster|xlink:href)"
                    r"\s*=\s*[\"']?\s*((?:https?:)?//[^\"'\s>]{1,200})", re.I)
_CSS_LOADS = re.compile(r"(?:@import\s+(?:url\()?\s*[\"']?|url\(\s*[\"']?)\s*((?:https?:)?//[^\"')\s]{1,200})", re.I)
_BANNED = re.compile(r"<(iframe|frame|object|embed|base|portal)\b|<meta\b[^>]*http-equiv|<link\b", re.I)
_HANDLER = re.compile(r"<[a-zA-Z][^<>]*?\s(on[a-z]{3,24})\s*=", re.S)
_SCRIPT = re.compile(r"<script\b", re.I)
_FILLER = re.compile(r"lorem\s+ipsum|dolor\s+sit\s+amet", re.I)
_GOTO = re.compile(r"\sdata-goto\s*=\s*(?:\"([^\"]{1,120})\"|'([^']{1,120})')", re.I)
_HAS_TAG = re.compile(r"<[a-zA-Z][^<>]*>")
_HAS_HTML = re.compile(r"<html[\s>]", re.I)


def clean_html(value, *, interactive: bool | None = None) -> tuple[str, bool, list[str]]:
    """An artboard's page as the store keeps it: (html, interactive, notes for the model). Refused when it would not
    draw as written (it loads something from the web, it holds a frame, its script is in an attribute)."""
    if not isinstance(value, str) or not value.strip():
        raise DesignError("An artboard needs its HTML: one whole page, in html.")
    page = value.replace("\r\n", "\n").replace("\x00", "").strip()
    if len(page.encode("utf-8")) > MAX_BOARD_BYTES:
        raise DesignError(f"An artboard's HTML is at most {MAX_BOARD_BYTES // 1024} KB. Make its pictures smaller, or "
                          "split it into two artboards.")
    if page.lstrip().startswith("@@FILE:"):
        raise DesignError("A file reference was sent instead of the artboard's HTML. Send the HTML itself.")
    if not _HAS_TAG.search(page):
        raise DesignError("An artboard is an HTML page: give its markup in html.")
    loads = _LOADS.search(page) or _CSS_LOADS.search(page)
    if loads:
        raise DesignError(f"An artboard is self-contained: “{loads.group(loads.lastindex)[:120]}” would not load here. "
                          "Put styles and scripts inline, draw pictures as inline SVG or CSS, or use a data: address.")
    banned = _BANNED.search(page)
    if banned:
        what = banned.group(1) or ("link" if banned.group(0).lower().startswith("<link") else "meta http-equiv")
        raise DesignError(f"<{what.lower()}> isn't allowed in an artboard: it is one self-contained page. Put its "
                          "styles in a <style> tag and leave out frames, redirects and policies.")
    if _FILLER.search(page):
        raise DesignError("Write real copy for this artboard (what the user's product would say), not filler text.")
    scripted = bool(_SCRIPT.search(page))
    notes = []
    handler = _HANDLER.search(page)
    if handler and (interactive or scripted):
        raise DesignError(f"The {handler.group(1)}=\"…\" attribute doesn't run in an artboard. Put the script in a "
                          "<script> tag and use addEventListener; to go to another artboard, give the element "
                          "data-goto=\"<that artboard's title>\" and no script.")
    if handler:
        notes.append(f"The {handler.group(1)}=\"…\" attribute doesn't run here; to go to another artboard use "
                     "data-goto=\"<its title>\".")
    if not _HAS_HTML.search(page):
        page = ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>\n<body>\n"
                f"{page}\n</body></html>")
    elif not page.lower().lstrip().startswith("<!doctype"):
        page = "<!doctype html>\n" + page
    return page, (scripted if interactive is None else bool(interactive)), notes


def goto_targets(page: str) -> list[str]:
    return [a or b for a, b in _GOTO.findall(page or "")]


def exact_edits(page: str, edits) -> str:
    """A board's HTML with each ``find`` (in it exactly once) replaced: only what was asked changes."""
    if not isinstance(edits, list) or not edits:
        raise DesignError("Give edits: [{\"find\": exact text in the artboard now, \"replace\": the new text}].")
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict) or not isinstance(edit.get("find"), str) or not edit["find"]:
            raise DesignError(f"Edit {i} needs find: the exact text in the artboard's HTML to change.")
        find, replace = edit["find"], str(edit.get("replace") if edit.get("replace") is not None else "")
        count = page.count(find)
        if not count:
            raise DesignError(f"Edit {i}: “{find[:80]}” isn't in the artboard now (the user may have changed it). Read "
                              "it with {\"op\": \"read\", \"board\": …} and copy the text exactly.")
        if count > 1 and not edit.get("all"):
            raise DesignError(f"Edit {i}: “{find[:80]}” is in the artboard {count} times. Include more of the text "
                              "around it, so it's found once (or set all to change every one).")
        page = page.replace(find, replace) if edit.get("all") else page.replace(find, replace, 1)
    return page


# ---- tweaks ---------------------------------------------------------------------------------------------------------------
def _tweak_value(kind: str, value, options=()):
    if kind == "color":
        if not isinstance(value, str) or not _COLOR.fullmatch(value.strip()):
            raise DesignError("A colour tweak's value is a hex colour, like #b5651d.")
        return value.strip().lower()
    if kind == "size":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = f"{value:g}px"
        if not isinstance(value, str) or not _SIZE.fullmatch(value.strip()):
            raise DesignError("A size tweak's value is a length, like 24px, 1.5rem or 60%.")
        return value.strip()
    if kind == "switch":
        if isinstance(value, str) and value.strip().lower() in ("on", "off", "true", "false"):
            value = value.strip().lower() in ("on", "true")
        if not isinstance(value, bool):
            raise DesignError("A switch tweak's value is true or false.")
        return value
    if not isinstance(value, str) or value not in options:
        raise DesignError("A choice tweak's value is one of its options: " + ", ".join(options) + ".")
    return value


def clean_tweaks(value) -> list:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TWEAKS:
        raise DesignError(f"tweaks is a list of at most {MAX_TWEAKS}: [{{\"name\", \"label\", \"type\": \"color|size|"
                          "switch|choice\", \"value\"}].")
    out, seen = [], set()
    for raw in value:
        if not isinstance(raw, dict):
            raise DesignError("Each tweak is {\"name\", \"label\", \"type\", \"value\"}.")
        name = str(raw.get("name") or "").strip().lower().lstrip("-")
        if not TWEAK_NAME.fullmatch(name) or name in seen:
            raise DesignError("A tweak's name is a short CSS name of its own, like accent or hero-height (the artboard "
                              "reads it as var(--accent)).")
        seen.add(name)
        kind = str(raw.get("type") or "").strip().lower()
        kind = {"colour": "color", "toggle": "switch", "boolean": "switch", "length": "size", "select": "choice"}.get(kind, kind)
        if kind not in TWEAK_TYPES:
            raise DesignError("A tweak's type is color, size, switch or choice.")
        tweak = {"name": name, "label": _line(raw.get("label") or name.replace("-", " ").capitalize(), 60), "type": kind}
        if kind == "choice":
            options = raw.get("options")
            if (not isinstance(options, list) or not 2 <= len(options) <= 12
                    or not all(isinstance(o, str) and _CHOICE.fullmatch(o) for o in options) or len(set(options)) != len(options)):
                raise DesignError("A choice tweak needs options: 2 to 12 short words.")
            tweak["options"] = list(options)
        tweak["value"] = _tweak_value(kind, raw.get("value"), tweak.get("options", ()))
        if kind == "size":
            for key in ("min", "max"):
                if raw.get(key) is not None:
                    if isinstance(raw[key], bool) or not isinstance(raw[key], (int, float)) or not -10000 <= raw[key] <= 10000:
                        raise DesignError("A size tweak's min and max are numbers.")
                    tweak[key] = raw[key]
        out.append(tweak)
    return out


def tweak_style(tweaks) -> tuple[str, dict]:
    """The CSS that sets an artboard's tweaks on its root, and the attributes its root gets: what the canvas, DGC's
    page of the design and every export add to the artboard's page."""
    rules, attrs = [], {}
    for tweak in tweaks or []:
        name, value = tweak["name"], tweak["value"]
        if tweak["type"] == "switch":
            rules.append(f"--{name}:{1 if value else 0}")
            attrs[f"data-tweak-{name}"] = "on" if value else "off"
        elif tweak["type"] == "choice":
            rules.append(f"--{name}:\"{value}\"")
            attrs[f"data-tweak-{name}"] = value.lower().replace(" ", "-")
        else:
            rules.append(f"--{name}:{value}")
    return (":root{" + ";".join(rules) + "}" if rules else ""), attrs


# ---- the index ----------------------------------------------------------------------------------------------------------
def _size(raw: dict) -> tuple[int, int, str]:
    named = str(raw.get("size") or "").strip().lower()
    named = {"mobile": "phone", "iphone": "phone", "web": "desktop", "laptop": "desktop", "ipad": "tablet",
             "web page": "page", "landing": "page", "instagram": "square", "social": "square"}.get(named, named)
    if named and named not in SIZES:
        raise DesignError("An artboard's size is one of: " + ", ".join(SIZES) + "; or give w and h in px.")
    fit = str(raw.get("fit") or ("page" if named == "page" else "fixed")).strip().lower()
    if fit not in ("fixed", "page"):
        raise DesignError("fit is \"fixed\" (exactly w by h) or \"page\" (a whole web page, as tall as it is).")
    w, h = SIZES.get(named, SIZES["desktop"] if fit == "fixed" else SIZES["page"])
    if raw.get("w") is not None:
        w = _int(raw["w"], "w", MIN_SIDE, MAX_W)
    if raw.get("h") is not None:
        h = _int(raw["h"], "h", MIN_SIDE, MAX_H)
    return w, h, fit


def _board(raw: dict, bid: str, page: str) -> dict:
    title = _line(raw.get("title") or raw.get("name"), MAX_TITLE)
    if not title:
        raise DesignError("An artboard needs a title, as the user would name it (Desktop, Phone, Sign in).")
    w, h, fit = _size(raw)
    return {"id": bid, "page": page, "title": title, "x": 0, "y": 0, "w": w, "h": h, "fit": fit,
            "interactive": bool(raw.get("interactive")), "state": "drawing", "rev": 0,
            "tweaks": clean_tweaks(raw.get("tweaks"))}


def normalize(data) -> dict:
    """The index, checked, as the store keeps it (a stored one that no longer reads as a design is refused)."""
    if not isinstance(data, dict):
        raise DesignError("A design is data: {\"artboards\": [{\"title\", \"size\"}]}.")
    pages = []
    for raw in data.get("pages") or [{"id": "p1", "name": "Page 1"}]:
        if not isinstance(raw, dict) or not PAGE_ID.fullmatch(str(raw.get("id") or "")):
            raise DesignError("A page is {\"id\": \"p1\", \"name\"}.")
        pages.append({"id": raw["id"], "name": _line(raw.get("name"), 60) or "Page"})
    if not pages or len(pages) > MAX_PAGES or len({p["id"] for p in pages}) != len(pages):
        raise DesignError(f"A design has 1 to {MAX_PAGES} pages.")
    known = {p["id"] for p in pages}
    boards = []
    for raw in data.get("boards") or []:
        if not isinstance(raw, dict) or not BOARD_ID.fullmatch(str(raw.get("id") or "")) or raw.get("page") not in known:
            raise DesignError("An artboard has an id (b1, b2, …) and a page of the design.")
        board = _board({**raw, "size": ""}, raw["id"], raw["page"])
        board["x"], board["y"] = _int(raw.get("x", 0), "x", -MAX_AT, MAX_AT), _int(raw.get("y", 0), "y", -MAX_AT, MAX_AT)
        board["state"] = "ready" if raw.get("state") == "ready" else "drawing"
        board["rev"] = _int(raw.get("rev", 0), "rev", 0, 10 ** 9)
        boards.append(board)
    if len(boards) > MAX_BOARDS or len({b["id"] for b in boards}) != len(boards):
        raise DesignError(f"A design holds at most {MAX_BOARDS} artboards, each with its own id.")
    notes = []
    for raw in data.get("notes") or []:
        if not isinstance(raw, dict) or not NOTE_ID.fullmatch(str(raw.get("id") or "")) or raw.get("page") not in known:
            raise DesignError("A note has an id (n1, n2, …) and a page of the design.")
        notes.append(_note(raw, raw["id"], raw["page"]))
    if len(notes) > MAX_NOTES or len({n["id"] for n in notes}) != len(notes):
        raise DesignError(f"A design holds at most {MAX_NOTES} notes, each with its own id.")
    last = data.get("last") if isinstance(data.get("last"), dict) else {}

    def top(key: str, items) -> int:
        have = max([int(i["id"][1:]) for i in items] or [0])
        given = last.get(key)
        return max(have, given if isinstance(given, int) and not isinstance(given, bool) and 0 <= given < 10 ** 5 else 0)
    start = data.get("start") if isinstance(data.get("start"), dict) else {}
    page = start.get("page") if start.get("page") in known else pages[0]["id"]
    board = start.get("board") if any(b["id"] == start.get("board") and b["page"] == page for b in boards) else ""
    return {"pages": pages, "boards": boards, "notes": notes, "start": {"page": page, "board": board},
            "last": {"b": top("b", boards), "n": top("n", notes), "p": top("p", pages)}}


def _note(raw: dict, nid: str, page: str) -> dict:
    kind = str(raw.get("kind") or "sticky").strip().lower()
    kind = {"heading": "title", "label": "title", "note": "sticky"}.get(kind, kind)
    if kind not in ("title", "sticky"):
        raise DesignError("A note's kind is \"title\" (big words over a row of artboards) or \"sticky\".")
    text = _line(raw.get("text"), 200) if kind == "title" else _text(raw.get("text"), MAX_NOTE)
    if not text:
        raise DesignError("A note needs its words, in text.")
    note = {"id": nid, "page": page, "kind": kind, "text": text,
            "x": _int(raw.get("x", 0), "x", -MAX_AT, MAX_AT), "y": _int(raw.get("y", 0), "y", -MAX_AT, MAX_AT)}
    if kind == "sticky":
        color = str(raw.get("color") or raw.get("colour") or "yellow").strip().lower()
        if color not in NOTE_COLORS:
            raise DesignError("A sticky note's color is one of: " + ", ".join(NOTE_COLORS) + ".")
        note["color"] = color
    return note


def start(spec) -> tuple[dict, list]:
    """A new design from what the model gave ({"artboards": [{"title", "size" or w and h, "html"?}], "notes"?}): the
    index with every artboard waiting to be drawn, and the pages given along with it, to be drawn one at a time
    ([(board id, change op)])."""
    if isinstance(spec, list):
        spec = {"artboards": spec}
    if not isinstance(spec, dict):
        raise DesignError("A design is data: {\"artboards\": [{\"title\": \"Desktop\", \"size\": \"desktop\"}, "
                          "{\"title\": \"Phone\", \"size\": \"phone\"}]}.")
    boards = spec.get("artboards", spec.get("boards"))
    if not isinstance(boards, list) or not boards:
        raise DesignError("A design needs at least one artboard: {\"artboards\": [{\"title\": \"Desktop\", \"size\": "
                          "\"desktop\"}]} (size is one of " + ", ".join(SIZES) + ", or give w and h).")
    if len(boards) > MAX_BOARDS:
        raise DesignError(f"A design holds at most {MAX_BOARDS} artboards.")
    index = {"pages": [{"id": "p1", "name": "Page 1"}], "boards": [], "notes": [], "start": {"page": "p1", "board": ""},
             "last": {"b": 0, "n": 0, "p": 1}}
    pending = []
    for raw in boards:
        if not isinstance(raw, dict):
            raise DesignError("Each artboard is {\"title\", \"size\"}.")
        op = {"op": "add", **{k: v for k, v in raw.items() if k not in ("html", "x", "y", "page")}}
        index, _files, _said, made = apply(index, {}, op)
        if isinstance(raw.get("html"), str) and raw["html"].strip():
            clean_html(raw["html"], interactive=raw.get("interactive"))        # refused now, before anything is made
            pending.append({"op": "change", "board": made, "html": raw["html"],
                            **({"interactive": raw["interactive"]} if raw.get("interactive") is not None else {})})
    for raw in spec.get("notes") or []:
        if isinstance(raw, dict):
            index, _files, _said, _made = apply(index, {}, {"op": "note_add", **raw})
    return index, pending


# ---- finding and placing -----------------------------------------------------------------------------------------------
def find_board(index: dict, ref) -> dict:
    """The board by its id, or by its title when one board has it."""
    text = _line(ref, 200)
    if not text:
        raise DesignError("Say which artboard, by its id (b1, b2, …) or its title.")
    for board in index["boards"]:
        if board["id"] == text:
            return board
    named = [b for b in index["boards"] if b["title"].casefold() == text.casefold()]
    if len(named) == 1:
        return named[0]
    have = ", ".join(f"{b['id']} “{b['title']}”" for b in index["boards"]) or "none"
    if named:
        raise DesignError(f"{len(named)} artboards are named “{text[:60]}”: say which by its id ({have}).")
    raise DesignError(f"There's no artboard “{text[:60]}”. This design has: {have}.")


def _find_page(index: dict, ref) -> dict:
    text = _line(ref, 80)
    for page in index["pages"]:
        if page["id"] == text or page["name"].casefold() == text.casefold():
            return page
    raise DesignError(f"There's no page “{text[:60]}”. This design has: "
                      + ", ".join(f"{p['id']} “{p['name']}”" for p in index["pages"]) + ".")


def _find_note(index: dict, ref) -> dict:
    for note in index["notes"]:
        if note["id"] == str(ref or "").strip():
            return note
    raise DesignError("Say which note, by its id: " + (", ".join(n["id"] for n in index["notes"]) or "there are none") + ".")


def _tall(board: dict, heights) -> int:
    measured = (heights or {}).get(board["id"])
    return max(board["h"], measured) if board["fit"] == "page" and isinstance(measured, int) else board["h"]


def _over(x, y, w, h, others, heights, gx=0, gy=0):
    """The first frame this one would be over (closer than the gaps), or None."""
    for o in others:
        if x < o["x"] + o["w"] + gx and o["x"] < x + w + gx and y < o["y"] + _tall(o, heights) + gy and o["y"] < y + h + gy:
            return o
    return None


def free_spot(index: dict, page: str, w: int, h: int, *, after: dict | None = None, at=None, skip: str = "",
              heights=None) -> tuple[int, int]:
    """Where a new frame goes on a page: right of ``after`` (or of the last frame there), 80 px apart; past a row about
    ROW_LIMIT wide, a new row 120 px below everything; moved right until it is over no other frame. ``at``: a place
    that was asked for, kept when it is free."""
    others = [b for b in index["boards"] if b["page"] == page and b["id"] != skip]
    if not others:
        return (at if at else (0, 0))
    left = min(b["x"] for b in others)
    if at:
        x, y = at
        if _over(x, y, w, h, others, heights) is None:
            return x, y
    else:
        last = after or others[-1]
        x, y = last["x"] + last["w"] + GAP_X, last["y"]
        if x + w - left > ROW_LIMIT and x > left:
            x, y = left, max(b["y"] + _tall(b, heights) for b in others) + GAP_Y
    for _ in range(4 * MAX_BOARDS):
        hit = _over(x, y, w, h, others, heights, GAP_X, GAP_Y)
        if hit is None:
            return x, y
        x = hit["x"] + hit["w"] + GAP_X
        if x + w - left > ROW_LIMIT + MAX_W:
            x, y = left, max(b["y"] + _tall(b, heights) for b in others) + GAP_Y
    return left, max(b["y"] + _tall(b, heights) for b in others) + GAP_Y


def _free_title(index: dict, title: str) -> str:
    have = {b["title"].casefold() for b in index["boards"]}
    if title.casefold() not in have:
        return title
    base = re.sub(r" \d+\Z", "", title)
    for n in range(2, 1000):
        if f"{base} {n}".casefold() not in have:
            return f"{base} {n}"[:MAX_TITLE]
    return title


# ---- one change -------------------------------------------------------------------------------------------------------------
OPS = ("add", "change", "move", "resize", "rename", "duplicate", "remove", "order", "tweak", "note_add", "note_change",
       "note_remove", "page_add", "page_rename", "page_remove", "open_at")


def apply(index: dict, files: dict, op, *, author: str = "DGC", heights=None) -> tuple[dict, dict, str, str]:
    """One op on a design: (the new index, its board files {name: bytes}, what the history says, what the model is
    told besides: the id it made, where a frame landed). The user's own changes (``author`` "you") are kept as made;
    a frame the model places is never left over another."""
    if not isinstance(op, dict):
        raise DesignError("Each edit is an object with an op: " + ", ".join(OPS) + ".")
    kind = str(op.get("op") or "").strip().lower()
    kind = {"draw": "change", "set": "change", "update": "change", "delete": "remove", "add_note": "note_add",
            "add_page": "page_add", "rename_page": "page_rename", "copy": "duplicate"}.get(kind, kind)
    if kind not in OPS:
        raise DesignError(f"“{str(op.get('op'))[:40]}” isn't a design op. Use one of: " + ", ".join(OPS) + ", read.")
    by_user = str(author or "").casefold() == "you"
    index, files = copy.deepcopy(index), dict(files)
    boards, last = index["boards"], index["last"]

    if kind == "add":
        if len(boards) >= MAX_BOARDS:
            raise DesignError(f"A design holds at most {MAX_BOARDS} artboards.")
        page = _find_page(index, op["page"])["id"] if op.get("page") else index["start"]["page"]
        last["b"] += 1
        board = _board(op, f"b{last['b']}", page)
        board["title"] = _free_title(index, board["title"])
        after = find_board(index, op["after"]) if op.get("after") else None
        if after is not None and after["page"] != page:
            after = None
        at = None
        if op.get("x") is not None and op.get("y") is not None:
            at = (_int(op["x"], "x", -MAX_AT, MAX_AT), _int(op["y"], "y", -MAX_AT, MAX_AT))
        board["x"], board["y"] = at if (by_user and at) else free_spot(index, page, board["w"], board["h"], after=after,
                                                                         at=at, heights=heights)
        boards.append(board)
        said, told = f"Added the artboard “{board['title']}”", board["id"]
        if isinstance(op.get("html"), str) and op["html"].strip():
            index, files, _said, _told = apply(index, files, {"op": "change", "board": board["id"], "html": op["html"],
                                                             "interactive": op.get("interactive")}, author=author)
            said = f"Added and drew “{board['title']}”"
        return index, files, said, told

    if kind in ("change", "move", "resize", "rename", "duplicate", "remove", "order", "tweak"):
        board = find_board(index, op.get("board"))
        name, title = board_file(board["id"]), board["title"]
        if kind == "change":
            was_drawn = board["state"] == "ready"
            if by_user and op.get("rev") is not None and op["rev"] != board["rev"]:
                raise DesignError(f"“{title}” changed since version {op['rev']} of it (DGC or another window changed "
                                  "that artboard). Reload it, then make your change again.")
            told = ""
            if op.get("html") is not None:
                page, interactive, notes = clean_html(op["html"], interactive=op.get("interactive"))
                told = " ".join(notes)
            elif op.get("edits") is not None:
                if not was_drawn:
                    raise DesignError(f"“{title}” isn't drawn yet: give its whole page in html.")
                page, interactive, notes = clean_html(exact_edits(files[name].decode("utf-8"), op["edits"]),
                                                      interactive=op.get("interactive", board["interactive"]))
                told = " ".join(notes)
            elif op.get("tweaks") is not None or op.get("interactive") is not None:
                page, interactive = (files[name].decode("utf-8") if was_drawn else None), bool(
                    op.get("interactive", board["interactive"]))
            else:
                raise DesignError("To draw or change an artboard give html (its whole page) or edits ([{\"find\", "
                                  "\"replace\"}]).")
            if op.get("tweaks") is not None:
                board["tweaks"] = clean_tweaks(op["tweaks"])
            board["interactive"] = interactive
            if page is not None:
                missing = [t for t in goto_targets(page) if not _goes(index, t)]
                if missing:
                    told = (told + f" data-goto=\"{missing[0]}\" names no artboard yet: add one with that title, or "
                            "name one of " + ", ".join(f"“{b['title']}”" for b in boards) + ".").strip()
                if not was_drawn or files.get(name) != page.encode("utf-8"):
                    board["rev"] += 1
                files[name] = page.encode("utf-8")
                board["state"] = "ready"
            verb = "Changed" if was_drawn else "Drew"
            words = _line(op.get("note"), 60) if by_user else ""
            return index, files, (f"{words} in “{title}”" if words else f"{verb} “{title}”"), told
        if kind == "move":
            x, y = _int(op.get("x"), "x", -MAX_AT, MAX_AT), _int(op.get("y"), "y", -MAX_AT, MAX_AT)
            if not by_user:
                x, y = free_spot(index, board["page"], board["w"], _tall(board, heights), at=(x, y), skip=board["id"],
                                 heights=heights)
            board["x"], board["y"] = x, y
            return index, files, f"Moved “{title}”", f"“{title}” is at ({x}, {y})."
        if kind == "resize":
            board["w"] = _int(op.get("w", board["w"]), "w", MIN_SIDE, MAX_W)
            board["h"] = _int(op.get("h", board["h"]), "h", MIN_SIDE, MAX_H)
            if op.get("x") is not None and op.get("y") is not None and by_user:
                board["x"], board["y"] = _int(op["x"], "x", -MAX_AT, MAX_AT), _int(op["y"], "y", -MAX_AT, MAX_AT)
            if op.get("fit") in ("fixed", "page"):
                board["fit"] = op["fit"]
            if not by_user:
                board["x"], board["y"] = free_spot(index, board["page"], board["w"], board["h"],
                                                   at=(board["x"], board["y"]), skip=board["id"], heights=heights)
            return index, files, f"Resized “{title}”", f"“{title}” is {board['w']}×{board['h']} at ({board['x']}, {board['y']})."
        if kind == "rename":
            new = _line(op.get("title"), MAX_TITLE)
            if not new:
                raise DesignError("A new title is needed.")
            board["title"] = new
            return index, files, f"Renamed “{title}” to “{new}”", ""
        if kind == "duplicate":
            if len(boards) >= MAX_BOARDS:
                raise DesignError(f"A design holds at most {MAX_BOARDS} artboards.")
            last["b"] += 1
            twin = {**copy.deepcopy(board), "id": f"b{last['b']}", "rev": 1 if board["state"] == "ready" else 0}
            twin["title"] = _free_title(index, _line(op.get("title"), MAX_TITLE) or board["title"])
            twin["x"], twin["y"] = free_spot(index, board["page"], board["w"], board["h"], after=board, heights=heights)
            boards.insert(boards.index(board) + 1, twin)
            if name in files:
                files[board_file(twin["id"])] = files[name]
            return index, files, f"Duplicated “{title}” as “{twin['title']}”", twin["id"]
        if kind == "remove":
            boards.remove(board)
            files.pop(name, None)
            if index["start"]["board"] == board["id"]:
                index["start"]["board"] = ""
            return index, files, f"Removed “{title}”", ""
        if kind == "order":
            to = str(op.get("to") or "front").strip().lower()
            if to not in ("front", "back"):
                raise DesignError("order's to is \"front\" or \"back\".")
            boards.remove(board)
            boards.insert(len(boards) if to == "front" else 0, board)
            return index, files, (f"Brought “{title}” to the front" if to == "front" else f"Sent “{title}” to the back"), ""
        tweak = next((t for t in board["tweaks"] if t["name"] == str(op.get("name") or "").strip().lower()), None)
        if tweak is None:
            raise DesignError(f"“{title}” declares no tweak “{str(op.get('name'))[:40]}”. It has: "
                              + (", ".join(t["name"] for t in board["tweaks"]) or "none") + ".")
        tweak["value"] = _tweak_value(tweak["type"], op.get("value"), tweak.get("options", ()))
        return index, files, f"Set {tweak['label']} in “{title}”", ""

    if kind == "note_add":
        if len(index["notes"]) >= MAX_NOTES:
            raise DesignError(f"A design holds at most {MAX_NOTES} notes.")
        by = find_board(index, op.get("over") or op.get("near")) if (op.get("over") or op.get("near")) else None
        page = by["page"] if by else _find_page(index, op["page"])["id"] if op.get("page") else index["start"]["page"]
        on_page = [b for b in boards if b["page"] == page]
        title = str(op.get("kind") or "sticky").strip().lower() in ("title", "heading", "label")
        if op.get("x") is not None and op.get("y") is not None:
            x, y = op["x"], op["y"]
        elif by is not None:
            x, y = (by["x"], by["y"] - 170) if title else (by["x"], by["y"] + _tall(by, heights) + 24)
        elif on_page:
            left, top = min(b["x"] for b in on_page), min(b["y"] for b in on_page)
            x, y = (left, top - 170) if title else (left - STICKY_W - 40, top)
        else:
            x, y = 0, -170 if title else 0
        last["n"] += 1
        note = _note({**op, "x": x, "y": y}, f"n{last['n']}", page)
        index["notes"].append(note)
        return index, files, ("Added the title “" + note["text"][:60] + "”" if note["kind"] == "title" else "Added a note"), note["id"]
    if kind == "note_change":
        note = _find_note(index, op.get("note"))
        merged = {**note, **{k: op[k] for k in ("text", "color", "colour", "x", "y") if op.get(k) is not None}}
        index["notes"][index["notes"].index(note)] = _note(merged, note["id"], note["page"])
        moved = (op.get("x") is not None or op.get("y") is not None) and op.get("text") is None and op.get("color") is None
        return index, files, ("Moved a note" if moved else "Changed a note"), ""
    if kind == "note_remove":
        index["notes"].remove(_find_note(index, op.get("note")))
        return index, files, "Removed a note", ""

    if kind == "page_add":
        if len(index["pages"]) >= MAX_PAGES:
            raise DesignError(f"A design has at most {MAX_PAGES} pages.")
        name = _line(op.get("name"), 60)
        if not name:
            raise DesignError("A page needs a name.")
        if any(p["name"].casefold() == name.casefold() for p in index["pages"]):
            raise DesignError(f"This design already has a page named “{name}”.")
        last["p"] += 1
        index["pages"].append({"id": f"p{last['p']}", "name": name})
        return index, files, f"Added the page “{name}”", f"p{last['p']}"
    if kind == "page_rename":
        page, name = _find_page(index, op.get("page")), _line(op.get("name"), 60)
        if not name:
            raise DesignError("A page needs a name.")
        was, page["name"] = page["name"], name
        return index, files, f"Renamed the page “{was}” to “{name}”", ""
    if kind == "page_remove":
        page = _find_page(index, op.get("page"))
        if len(index["pages"]) == 1:
            raise DesignError("A design keeps at least one page.")
        for board in [b for b in boards if b["page"] == page["id"]]:
            boards.remove(board)
            files.pop(board_file(board["id"]), None)
        index["notes"] = [n for n in index["notes"] if n["page"] != page["id"]]
        index["pages"].remove(page)
        if index["start"]["page"] == page["id"]:
            index["start"] = {"page": index["pages"][0]["id"], "board": ""}
        return index, files, f"Removed the page “{page['name']}”", ""
    # open_at: where the canvas opens
    board = find_board(index, op["board"]) if op.get("board") else None
    page = board["page"] if board else _find_page(index, op.get("page") or index["start"]["page"])["id"]
    index["start"] = {"page": page, "board": board["id"] if board else ""}
    return index, files, "Changed where it opens", ""


def _goes(index: dict, target: str) -> bool:
    try:
        find_board(index, target)
        return True
    except DesignError:
        return False


# ---- what the model and the screens read --------------------------------------------------------------------------------
def counts(index: dict) -> dict:
    boards = index.get("boards") or []
    return {"boards": len(boards), "drawing": sum(1 for b in boards if b.get("state") != "ready"),
            "pages": len(index.get("pages") or [])}


def waiting(index: dict) -> list[dict]:
    return [b for b in index["boards"] if b["state"] != "ready"]


def standing(index: dict) -> str:
    """Where the design stands, for the model after each change: what is still to draw, in order."""
    todo = waiting(index)
    if not todo:
        return (f"All {len(index['boards'])} artboard{'s are' if len(index['boards']) != 1 else ' is'} drawn. The user "
                "is watching the canvas: don't render, screenshot or open the design to check it unless they ask.")
    nxt = todo[0]
    return ("Still to draw: " + ", ".join(f"{b['id']} “{b['title']}” ({b['w']}×{b['h']})" for b in todo)
            + f". Draw {nxt['id']} next, alone in its own edit_artifact call: "
            + "{\"op\": \"change\", \"board\": \"" + nxt["id"] + "\", \"html\": \"<!doctype html>…\"}.")


def outline(index: dict, sizes: dict | None = None) -> str:
    """The canvas in words: each page's artboards (id, title, size, place, drawn or not) and notes."""
    lines = []
    for page in index["pages"]:
        lines.append(f"Page {page['id']} “{page['name']}”" + (" (it opens here)" if index["start"]["page"] == page["id"] else ""))
        for b in [b for b in index["boards"] if b["page"] == page["id"]]:
            state = (f"drawn, {(sizes or {}).get(b['id'], 0):,} characters" if b["state"] == "ready" else "not drawn yet")
            extra = "".join([", a whole page (as tall as it is)" if b["fit"] == "page" else "",
                             ", interactive" if b["interactive"] else "",
                             ", tweaks: " + ", ".join(f"{t['name']}={t['value']}" for t in b["tweaks"]) if b["tweaks"] else ""])
            lines.append(f"- {b['id']} “{b['title']}” {b['w']}×{b['h']} at ({b['x']}, {b['y']}): {state}{extra}")
        for n in [n for n in index["notes"] if n["page"] == page["id"]]:
            lines.append(f"- {n['id']} {n['kind']} note at ({n['x']}, {n['y']}): “{n['text'][:120]}”")
    lines.append("To read one artboard's HTML: edit_artifact with edits [{\"op\": \"read\", \"board\": \"b1\"}]. To change "
                 "one: {\"op\": \"change\", \"board\": \"b1\", \"edits\": [{\"find\": …, \"replace\": …}]} or its whole html.")
    return "\n".join(lines)


def read_board(index: dict, files: dict, ref) -> str:
    board = find_board(index, ref)
    if board["state"] != "ready":
        return f"{board['id']} “{board['title']}” ({board['w']}×{board['h']}) isn't drawn yet."
    page = files[board_file(board["id"])].decode("utf-8", "replace")
    more = f"\n… ({len(page) - READ_LIMIT:,} more characters)" if len(page) > READ_LIMIT else ""
    return f"{board['id']} “{board['title']}” ({board['w']}×{board['h']}):\n{page[:READ_LIMIT]}{more}"


# ---- showing and exporting ------------------------------------------------------------------------------------------------
_HEAD_END = re.compile(r"</head\s*>", re.I)
_HEAD_START = re.compile(r"<head\b[^>]*>", re.I)
_HTML_START = re.compile(r"<html\b([^>]*)>", re.I)
_SCRIPT_BLOCK = re.compile(r"<script\b.*?(?:</script\s*>|\Z)", re.I | re.S)


def board_page(board: dict, page: str, *, play: bool = False) -> str:
    """An artboard's page as it is shown outside the editor (DGC's page of the design, an export): its tweaks set on its
    root and the policy that keeps it from reaching anything. Its scripts stay only when it plays."""
    css, attrs = tweak_style(board.get("tweaks"))
    runs = play and board.get("interactive")
    if not runs:
        page = _SCRIPT_BLOCK.sub("", page)
    head = (f'<meta http-equiv="Content-Security-Policy" content="{POLICY_PLAY if runs else POLICY}">'
            + (f"<style>{css}</style>" if css else ""))
    if attrs:
        extra = "".join(f' {k}="{_html.escape(v, quote=True)}"' for k, v in attrs.items())
        page = _HTML_START.sub(lambda m: f"<html{m.group(1)}{extra}>", page, count=1)
    found = _HEAD_START.search(page)
    if found:
        return page[:found.end()] + head + page[found.end():]
    found = _HTML_START.search(page)
    at = found.end() if found else 0
    return page[:at] + f"<head>{head}</head>" + page[at:]


_CANVAS_STYLE = """
:root{color-scheme:light dark;--bg:#f3f2f5;--fg:#1d1c21;--muted:#6d6a75;--line:#d9d6de;--note:#fff6c9}
@media (prefers-color-scheme:dark){:root{--bg:#141317;--fg:#ecebef;--muted:#a19dab;--line:#34313b;--note:#4a4320}}
html[data-theme=light]{color-scheme:light;--bg:#f3f2f5;--fg:#1d1c21;--muted:#6d6a75;--line:#d9d6de;--note:#fff6c9}
html[data-theme=dark]{color-scheme:dark;--bg:#141317;--fg:#ecebef;--muted:#a19dab;--line:#34313b;--note:#4a4320}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--fg);font:14px/1.45 system-ui,-apple-system,
'Segoe UI',sans-serif;padding:28px 28px 64px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 10px;
color:var(--muted);font-weight:600}.sub{color:var(--muted);margin:0}.stage{position:relative;overflow:auto;
border:1px solid var(--line);border-radius:10px;background:var(--bg)}.world{position:relative;transform-origin:0 0}
.board{position:absolute}.board>p{position:absolute;left:0;bottom:100%;margin:0 0 8px;font-weight:600;
white-space:nowrap;transform-origin:0 100%}.board iframe{display:block;border:0;background:#fff;
box-shadow:0 0 0 1px var(--line),0 8px 30px rgba(0,0,0,.12)}.wait{display:grid;place-items:center;
border:2px dashed var(--line);color:var(--muted);border-radius:6px}.note{position:absolute;transform-origin:0 0}
.note.title{font-weight:700;white-space:nowrap}.note.sticky{background:var(--note);padding:12px 14px;border-radius:4px;
white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.12)}
"""


def render_html(index: dict, files: dict, *, title: str = "Design", width: int = 1400) -> str:
    """DGC's page of a design: each page of the canvas with its artboards where they sit, scaled to fit, each in a frame
    of its own with no script and no way to reach anything. What Open in browser shows and what the HTML export is."""
    e = _html.escape
    parts = [f"<h1>{e(title)}</h1>",
             f"<p class=\"sub\">{len(index['boards'])} artboard{'s' if len(index['boards']) != 1 else ''}</p>"]
    for page in index["pages"]:
        boards = [b for b in index["boards"] if b["page"] == page["id"]]
        notes = [n for n in index["notes"] if n["page"] == page["id"]]
        if not boards and not notes:
            continue
        left = min([b["x"] for b in boards] + [n["x"] for n in notes])
        top = min([b["y"] for b in boards] + [n["y"] for n in notes]) - 60
        right = max([b["x"] + b["w"] for b in boards] + [n["x"] + 400 for n in notes])
        bottom = max([b["y"] + b["h"] for b in boards] + [n["y"] + 160 for n in notes])
        scale = min(1.0, width / max(1, right - left))
        if len(index["pages"]) > 1:
            parts.append(f"<h2>{e(page['name'])}</h2>")
        inner = []
        for n in notes:
            size = 44 if n["kind"] == "title" else 15
            style = f"left:{n['x'] - left}px;top:{n['y'] - top}px;font-size:{size}px" + (
                f";width:{STICKY_W}px" if n["kind"] == "sticky" else "")
            inner.append(f"<div class=\"note {n['kind']}\" style=\"{style}\">{e(n['text'])}</div>")
        for b in boards:
            box = f"left:{b['x'] - left}px;top:{b['y'] - top}px;width:{b['w']}px;height:{b['h']}px"
            label = f"<p style=\"transform:scale({1 / scale:.4f})\">{e(b['title'])}</p>"
            raw = files.get(board_file(b["id"]))
            if b["state"] == "ready" and raw is not None:
                doc = board_page(b, raw.decode("utf-8", "replace"))
                body = (f"<iframe sandbox=\"\" referrerpolicy=\"no-referrer\" loading=\"lazy\" title=\"{e(b['title'])}\" "
                        f"width=\"{b['w']}\" height=\"{b['h']}\" srcdoc=\"{e(doc, quote=True)}\"></iframe>")
            else:
                body = f"<div class=\"wait\" style=\"width:{b['w']}px;height:{b['h']}px\">Not drawn yet</div>"
            inner.append(f"<div class=\"board\" style=\"{box}\">{label}{body}</div>")
        tall = (bottom - top) * scale
        parts.append(f"<div class=\"stage\" style=\"height:{tall + 2:.0f}px\"><div class=\"world\" style=\"width:{right - left}px;"
                     f"height:{bottom - top}px;transform:scale({scale:.4f})\">{''.join(inner)}</div></div>")
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{e(title)}</title><style>{_CANVAS_STYLE}</style></head><body>{''.join(parts)}</body></html>")


def _shown(index: dict, files: dict, ref) -> list[tuple[dict, str]]:
    """The drawn boards an export is of: the one asked for, or all of them in canvas order (pages, then back to front)."""
    if ref:
        board = find_board(index, ref)
        if board["state"] != "ready":
            raise DesignError(f"“{board['title']}” isn't drawn yet, so there's nothing of it to download.")
        return [(board, files[board_file(board["id"])].decode("utf-8", "replace"))]
    order = {p["id"]: i for i, p in enumerate(index["pages"])}
    drawn = sorted((b for b in index["boards"] if b["state"] == "ready"), key=lambda b: order[b["page"]])
    if not drawn:
        raise DesignError("No artboard is drawn yet, so there's nothing to download.")
    return [(b, files[board_file(b["id"])].decode("utf-8", "replace")) for b in drawn]


def standalone(index: dict, files: dict, ref) -> tuple[dict, str]:
    """One artboard as a page of its own: (the board, its HTML as the canvas plays it)."""
    board, page = _shown(index, files, ref)[0]
    return board, board_page(board, page, play=True)


_SETTLED = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))"


def _each(index: dict, files: dict, ref, config, browser, work) -> list:
    """Open each board's page in a browser at its own size and hand it to ``work(session, board, w, h)``."""
    from .chatdgc import made
    import shutil
    out, session = [], browser
    try:
        for board, page in _shown(index, files, ref):
            # (As it is shown, its scripts off: a picture or a print of what the canvas shows.)
            session, folder = made._opened(board_page(board, page), config, session, None, "artboard.html")
            try:
                w, h = board["w"], board["h"]
                session.command("Emulation.setDeviceMetricsOverride",
                                {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": False})
                session.evaluate_json(_SETTLED)
                if board["fit"] == "page":
                    tall = session.evaluate_json("Math.ceil(Math.max(document.documentElement.scrollHeight, "
                                                 "document.body ? document.body.scrollHeight : 0))")
                    if isinstance(tall, (int, float)) and not isinstance(tall, bool):
                        h = max(h, min(int(tall), MAX_H))
                        session.command("Emulation.setDeviceMetricsOverride",
                                        {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": False})
                        session.evaluate_json(_SETTLED)
                out.append((board, work(session, board, w, h)))
            finally:
                shutil.rmtree(folder, ignore_errors=True)
    finally:
        if browser is None and session is not None:
            session.close()
    return out


def pictures(index: dict, files: dict, ref=None, *, config=None, browser=None) -> list[tuple[dict, bytes]]:
    """Each board as a PNG at its own size (twice as sharp): [(board, bytes)]."""
    import base64

    def shot(session, _board, _w, _h):
        raw = base64.b64decode(session.command("Page.captureScreenshot", {"format": "png"}, timeout=60.0).get("data") or "")
        if not raw.startswith(b"\x89PNG"):
            raise DesignError("the browser returned no picture")
        return raw
    return _each(index, files, ref, config, browser, shot)


def pdf(index: dict, files: dict, ref=None, *, config=None, browser=None) -> bytes:
    """The boards as one PDF, an artboard a page, each page the artboard's own size."""
    import base64
    import io

    def printed(session, _board, w, h):
        raw = base64.b64decode(session.command("Page.printToPDF", {
            "paperWidth": w / 96, "paperHeight": h / 96, "printBackground": True, "preferCSSPageSize": False,
            "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0, "pageRanges": "1"},
            timeout=90.0).get("data") or "")
        if not raw.startswith(b"%PDF"):
            raise DesignError("the browser returned no PDF")
        return raw
    pages = _each(index, files, ref, config, browser, printed)
    if len(pages) == 1:
        return pages[0][1]
    from pypdf import PdfReader, PdfWriter
    writer, out = PdfWriter(), io.BytesIO()
    for _board, raw in pages:
        writer.add_page(PdfReader(io.BytesIO(raw)).pages[0])
    writer.write(out)
    return out.getvalue()
