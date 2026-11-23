"""Comments on an artifact: you point at part of it and say something; DGC answers in that thread, or changes the
artifact and says so there (dgc/artifact_comment_turn), or offers its wording as suggestions you accept or reject.

The threads live with the artifact in its store (``<store>/<id>/comments.json``, beside its versions: a comment is not a
version), so every window, a reload and a Pip read the same threads, and removing the artifact takes them along to the
trash. A thread keeps the version it was made on and a place that survives later versions where it can:

- a doc (``text``): the words picked (``quote``) and the words around them (``before``, ``after``);
- a sheet (``cells``): the sheet, the cells (``range``, "B3" or "B2:C4") and what they held (``values``);
- a deck (``slide``): the slide (its number and its title then) and the field (``field``: title, bullets, notes, …)
  with the words picked;
- a checklist (``item``): the item ("c3") and its title;
- a page (``element``): the element (``path``, a CSS-ish path), the words picked and the heading over them (``near``);
- any of them (``whole``): the whole artifact.

Each thread is read against the current version: ``found`` is "here", "moved" (a slide moved, rows were put above some
cells) or "changed" (what it pointed at isn't there any more), and ``where`` says the place in words. A thread that
lost its place says so; it never points somewhere else.

A suggestion is a wording change in a doc or a page ({old, new}): Accept makes it a new version through the artifact's
own edit path (dgc/artifact_service), changing those words and nothing else; Reject leaves the artifact as it is.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

from . import artifact_service as service
from . import artifact_store
from .artifact_store import ArtifactError, Store

FILE = "comments.json"
MAX_THREADS = 500
MAX_MESSAGES = 200
MAX_TEXT = 4000                 # one message
MAX_QUOTE = 2000                # the words a comment points at
MAX_SHORT = 200                 # the words around them, a title, a heading
MAX_PATH = 600
MAX_CELLS = 50
MAX_SUGGESTIONS = 40            # in one thread
ANSWERING_FOR = timedelta(minutes=10)      # past this, a crashed answer no longer says "answering"
# Where a comment on each kind of artifact can point.
KINDS = {"doc": ("text", "whole"), "page": ("element", "whole"), "sheet": ("cells", "whole"),
         "slides": ("slide", "whole"), "checklist": ("item", "whole"), "dashboard": ("whole",)}
PLACE_WORDS = {"text": "words of it", "element": "part of the page", "cells": "its cells", "slide": "a slide",
               "item": "one of its items", "whole": "the whole of it"}
# A deck's fields, as the panel names them, and the words for each.
FIELDS = {"title": "title", "subtitle": "subtitle", "bullets": "points", "left": "left column", "right": "right column",
          "quote": "quote", "table": "table", "notes": "speaker notes", "caption": "caption", "alt": "picture's description",
          "chart": "chart", "slide": "slide"}
RANGE = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?\Z")
ITEM = re.compile(r"c[1-9][0-9]{0,4}\Z")
THREAD_ID = re.compile(r"t_[a-f0-9]{12}\Z")
SUGGESTION_ID = re.compile(r"s_[a-f0-9]{12}\Z")
SUGGEST_TYPES = ("doc", "page")


class CommentError(service.ArtifactUseError):
    """A comment can't be made or changed as asked; the words say what to change."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _store(store: Store | None) -> Store:
    return store or artifact_store.store()


def _line(value, limit: int) -> str:
    return " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).split())[:limit]


def _words(value, limit: int = MAX_TEXT) -> str:
    """A message as typed: its lines kept, control characters dropped, at most ``limit`` characters."""
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(value or "")).replace("\r\n", "\n").strip()
    return text[:limit]


# ---- what a comment points at -------------------------------------------------------------------------------------
def clean_anchor(type_: str, raw) -> dict:
    """What a comment points at, checked for this kind of artifact (the panel and the page frame say it; never trusted)."""
    if not isinstance(raw, dict):
        raise CommentError("Say what the comment points at.")
    kind = raw.get("kind")
    allowed = KINDS.get(type_, ("whole",))
    if kind not in allowed:
        label = service.LABELS.get(type_, "artifact").lower()
        raise CommentError(f"A comment on a {label} points at " + " or ".join(PLACE_WORDS[k] for k in allowed) + ".")
    out: dict = {"kind": kind}

    def text(key: str, limit: int = MAX_SHORT, need: bool = False) -> None:
        value = raw.get(key)
        if value is None or value == "":
            if need:
                raise CommentError("Pick the words the comment is about.")
            return
        if not isinstance(value, str):
            raise CommentError(f"{key} is words.")
        if len(value) > limit:
            raise CommentError("That's a lot to comment on at once: pick fewer words." if key == "quote"
                               else f"{key} is at most {limit} characters.")
        value = value.strip() if key == "quote" else value
        if need and not value.strip():
            raise CommentError("Pick the words the comment is about.")
        if value:
            out[key] = value
    text("quote", MAX_QUOTE, need=kind == "text")
    if kind == "text":
        text("before")
        text("after")
    elif kind == "cells":
        sheet, rng = raw.get("sheet"), raw.get("range")
        if not isinstance(sheet, str) or not sheet.strip() or len(sheet) > 80:
            raise CommentError("Say which sheet the cells are on.")
        if not isinstance(rng, str) or not RANGE.fullmatch(rng.strip().upper()):
            raise CommentError("Say which cells, like B3 or B2:C4.")
        out["sheet"], out["range"] = sheet, _tidy_range(rng.strip().upper())
        values = raw.get("values")
        if values is not None:
            if (not isinstance(values, list) or not values or not all(isinstance(r, list) and r for r in values)
                    or sum(len(r) for r in values) > MAX_CELLS
                    or not all(v is None or isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= MAX_QUOTE)
                               for r in values for v in r)):
                raise CommentError(f"A comment points at {MAX_CELLS} cells at most.")
            out["values"] = values
    elif kind == "slide":
        n = raw.get("slide")
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 1000:
            raise CommentError("Say which slide, by its number.")
        field = raw.get("field") or "slide"
        if field not in FIELDS:
            raise CommentError("Say which part of the slide: " + ", ".join(FIELDS) + ".")
        out["slide"], out["field"] = n, field
        text("title")
    elif kind == "item":
        item = raw.get("item")
        if not isinstance(item, str) or not ITEM.fullmatch(item):
            raise CommentError("Say which item, by its id (c1, c2, …).")
        out["item"] = item
        text("title")
    elif kind == "element":
        path = raw.get("path")
        if path is not None and (not isinstance(path, str) or len(path) > MAX_PATH):
            raise CommentError("That part of the page is too deep to point at.")
        if path:
            out["path"] = path
        text("near")
        tag = raw.get("tag")
        if isinstance(tag, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,19}", tag):
            out["tag"] = tag
    return out


def _col(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _letters(c: int) -> str:
    out = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        out = chr(65 + r) + out
    return out


def _span(rng: str) -> tuple[int, int, int, int]:
    """(first row, first column, last row, last column), rows as the sheet numbers them (1 is the names)."""
    m = RANGE.fullmatch(rng)
    r1, c1 = int(m.group(2)), _col(m.group(1))
    r2, c2 = (int(m.group(4)), _col(m.group(3))) if m.group(3) else (r1, c1)
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def _tidy_range(rng: str) -> str:
    r1, c1, r2, c2 = _span(rng)
    one = f"{_letters(c1)}{r1}"
    return one if (r1, c1) == (r2, c2) else f"{one}:{_letters(c2)}{r2}"


# ---- reading a thread against the current version ---------------------------------------------------------------------
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_MD_MARK = re.compile(r"(\*\*|__|~~|`+|\*|_|\\)")
_MD_LEAD = re.compile(r"^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)", re.M)


def plain(text: str, lead: bool = True) -> str:
    """Words as a reader sees them, for finding: a doc's Markdown without its marks, spacing made single."""
    t = _MD_LINK.sub(r"\1", str(text or ""))
    if lead:
        t = _MD_LEAD.sub("", t)
    t = _MD_MARK.sub("", t).replace("|", " ")
    return " ".join(t.split())


def _common_tail(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _common_head(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def _locate_text(md: str, anchor: dict) -> dict:
    blocks = [b for b in re.split(r"\n[ \t]*\n", md) if b.strip()]
    plains = [plain(b) for b in blocks]
    starts, joined = [], ""
    for p in plains:
        if joined:
            joined += " "
        starts.append(len(joined))
        joined += p
    q = plain(anchor.get("quote", ""), lead=False)
    hits, at = [], joined.find(q) if q else -1
    while at >= 0:
        hits.append(at)
        at = joined.find(q, at + 1)
    if not hits:
        return {"found": "changed", "where": "The text it pointed at changed since", "part": ""}
    before, after = plain(anchor.get("before", ""), lead=False), plain(anchor.get("after", ""), lead=False)
    best = max(hits, key=lambda h: (_common_tail(joined[:h].rstrip(), before.rstrip()) +
                                    _common_head(joined[h + len(q):].lstrip(), after.lstrip()), -h))
    first = max(i for i, s in enumerate(starts) if s <= best)
    last = max(i for i, s in enumerate(starts) if s <= best + max(0, len(q) - 1))
    heading = ""
    for i in range(first, -1, -1):
        m = re.match(r"[ \t]{0,3}#{1,6}[ \t]+(.+)", blocks[i])
        if m:
            heading = plain(m.group(1))[:120]
            if i == first:
                return {"found": "here", "where": f"the heading “{heading}”", "part": "\n\n".join(blocks[first:last + 1])[:2000]}
            break
    where = f"a paragraph under “{heading}”" if heading else f"paragraph {first + 1}"
    return {"found": "here", "where": where, "part": "\n\n".join(blocks[first:last + 1])[:2000]}


def _sheet_rows(sheet: dict) -> list[list]:
    """A sheet as rows the way its addresses count them: row 1 the names, then the data."""
    return [[c.get("name") for c in sheet.get("columns") or []], *[list(r) for r in sheet.get("rows") or []]]


def _block(rows: list[list], r1: int, c1: int, r2: int, c2: int):
    if r1 < 1 or r2 > len(rows):
        return None
    out = []
    for r in range(r1, r2 + 1):
        row = rows[r - 1]
        if c2 >= len(row):
            return None
        out.append(row[c1:c2 + 1])
    return out


def _cells_words(rows, r1, c1, r2, c2) -> str:
    lines = []
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            value = rows[r - 1][c] if r - 1 < len(rows) and c < len(rows[r - 1]) else None
            lines.append(f"{_letters(c)}{r} = {'(empty)' if value is None else json.dumps(value, ensure_ascii=False)}")
    return "\n".join(lines[:MAX_CELLS])


def _locate_cells(book: dict, anchor: dict) -> dict:
    sheets = book.get("sheets") or []
    sheet = next((s for s in sheets if s.get("name") == anchor["sheet"]), None)
    if sheet is None:
        return {"found": "changed", "where": f"The sheet “{anchor['sheet']}” it pointed at is gone", "part": ""}
    rows = _sheet_rows(sheet)
    r1, c1, r2, c2 = _span(anchor["range"])
    name = anchor["sheet"]

    def said(found: str, rng: str, a: int, b: int, c: int, d: int) -> dict:
        cells = "cell" if (a, b) == (c, d) else "cells"
        return {"found": found, "where": f"{cells} {rng} on “{name}”", "part": _cells_words(rows, a, b, c, d),
                **({"range": rng} if found == "moved" else {})}
    now = _block(rows, r1, c1, r2, c2)
    want = anchor.get("values")
    if want is None:
        return said("here", anchor["range"], r1, c1, r2, c2) if now is not None else \
            {"found": "changed", "where": f"Cells {anchor['range']} on “{name}” are gone", "part": ""}
    if now == want:
        return said("here", anchor["range"], r1, c1, r2, c2)
    # Rows or columns put in or taken out: the same cells somewhere else in the sheet (first match nearest the old place).
    h, w = len(want), max(len(r) for r in want)
    if all(len(r) == w for r in want) and any(v is not None for r in want for v in r):
        found = []
        for r in range(1, min(len(rows), 5000) - h + 2):
            for c in range(0, max(len(rows[0]) if rows else 0, 1) - w + 1):
                if _block(rows, r, c, r + h - 1, c + w - 1) == want:
                    found.append((abs(r - r1) + abs(c - c1), r, c))
        if found:
            _d, r, c = min(found)
            rng = _tidy_range(f"{_letters(c)}{r}:{_letters(c + w - 1)}{r + h - 1}")
            return said("moved", rng, r, c, r + h - 1, c + w - 1)
    return {"found": "changed", "where": f"What cells {anchor['range']} on “{name}” held changed since",
            "part": _cells_words(rows, r1, c1, r2, c2) if now is not None else ""}


def _bullet_words(items) -> str:
    out = []
    for b in items or []:
        if isinstance(b, str):
            out.append(b)
        elif isinstance(b, dict):
            out.append(str(b.get("text") or ""))
            out += [str(s) for s in b.get("sub") or []]
    return "\n".join(out)


def field_words(slide: dict, field: str) -> str:
    """A slide's field as words (for finding the words a comment picked, and for the model)."""
    if field in ("title", "subtitle", "notes"):
        return str(slide.get(field) or "")
    if field == "bullets":
        return _bullet_words(slide.get("bullets"))
    if field in ("left", "right"):
        side = slide.get(field) or {}
        return "\n".join([str(side.get("heading") or ""), _bullet_words(side.get("bullets"))]).strip()
    if field == "quote":
        q = slide.get("quote") or {}
        return "\n".join([str(q.get("text") or ""), str(q.get("by") or "")]).strip()
    if field == "table":
        t = slide.get("table") or {}
        return "\n".join(" | ".join(str(v) for v in row) for row in [t.get("columns") or [], *(t.get("rows") or [])])
    if field in ("caption", "alt"):
        return str((slide.get("image") or {}).get(field) or "")
    if field == "chart":
        return json.dumps(slide.get("chart") or {}, ensure_ascii=False)
    return "\n".join(w for w in (field_words(slide, f) for f in FIELDS if f not in ("slide", "chart")) if w)


def _locate_slide(deck: dict, anchor: dict) -> dict:
    slides = deck.get("slides") or []
    n, field, title = anchor["slide"] - 1, anchor["field"], anchor.get("title", "")
    q = plain(anchor.get("quote", ""), lead=False)
    has = lambda i: not q or q in plain(field_words(slides[i], field), lead=False)  # noqa: E731
    at = None
    if 0 <= n < len(slides) and (not title or str(slides[n].get("title") or "") == title) and has(n):
        at = n
    else:
        named = [i for i, s in enumerate(slides) if title and str(s.get("title") or "") == title and has(i)]
        holding = [i for i in range(len(slides)) if q and has(i)]
        pick = named or holding
        if pick:
            at = min(pick, key=lambda i: abs(i - n))
    if at is None:
        return {"found": "changed", "where": f"What slide {anchor['slide']}'s {FIELDS[field]} said changed since"
                if 0 <= n < len(slides) else f"Slide {anchor['slide']} is gone", "part": ""}
    words = f"slide {at + 1}" + ("" if field == "slide" else f" · its {FIELDS[field]}")
    out = {"found": "here" if at == n else "moved", "where": words,
           "part": field_words(slides[at], field)[:2000]}
    if at != n:
        out["slide"] = at + 1
    return out


def _locate_item(data: dict, anchor: dict) -> dict:
    item = next((i for i in data.get("items") or [] if i.get("id") == anchor["item"]), None)
    if item is None:
        return {"found": "changed", "where": f"The item {anchor['item']} it pointed at was removed", "part": ""}
    lines = [f"{item['id']} [{item.get('status')}] {item.get('title')}"]
    if item.get("done_when"):
        lines.append(f"done when: {item['done_when']}")
    if item.get("note"):
        lines.append(f"note: {item['note']}")
    return {"found": "here", "where": f"{item['id']} “{_line(item.get('title'), 120)}”", "part": "\n".join(lines)[:2000]}


class _Words(HTMLParser):
    """A page's words as a reader sees them: no script, style or head."""

    SKIP = {"script", "style", "head", "template", "noscript", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in ("p", "div", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "td", "th"):
            self.out.append(" ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def page_words(html: str) -> str:
    parser = _Words()
    try:
        parser.feed(str(html or ""))
        parser.close()
    except Exception:                                      # noqa: BLE001 -- a broken page has the words it has
        pass
    return " ".join("".join(parser.out).split())


def _locate_element(html: str, anchor: dict) -> dict:
    near = anchor.get("near", "")
    where = f"the page, under “{_line(near, 120)}”" if near else "the page"
    q = " ".join(str(anchor.get("quote") or "").split())
    if not q:
        return {"found": "here", "where": where, "part": ""}
    words = page_words(html)
    at = words.find(q)
    if at < 0:
        return {"found": "changed", "where": "The text it pointed at changed since", "part": ""}
    return {"found": "here", "where": where, "part": words[max(0, at - 300):at + len(q) + 300]}


def locate(type_: str, content, anchor: dict, *, label: str = "") -> dict:
    """Where a thread's anchor is in this version: {found: here|moved|changed, where: words, part: the text there now
    (for the model), and the place it moved to (range, slide) when it moved}."""
    kind = anchor.get("kind")
    try:
        if kind == "whole":
            return {"found": "here", "where": f"the whole {(label or service.LABELS.get(type_, 'artifact')).lower()}", "part": ""}
        if kind == "text" and isinstance(content, str):
            return _locate_text(content, anchor)
        if kind == "cells" and isinstance(content, dict):
            return _locate_cells(content, anchor)
        if kind == "slide" and isinstance(content, dict):
            return _locate_slide(content, anchor)
        if kind == "item" and isinstance(content, dict):
            return _locate_item(content, anchor)
        if kind == "element" and isinstance(content, str):
            return _locate_element(content, anchor)
    except (KeyError, TypeError, ValueError, AttributeError):
        pass
    return {"found": "changed", "where": "What it pointed at changed since", "part": ""}


def current_content(aid: str, *, store: Store | None = None):
    """What a thread is read against: a doc's text, a page's start file, or the data of a deck, sheet or checklist."""
    st = _store(store)
    art = st.get(aid)
    if art.type == "page":
        try:
            return st.read_file(aid, art.entry or "index.html").decode("utf-8", "replace")
        except FileNotFoundError:
            return ""
    return st.source(aid)


# ---- the file ---------------------------------------------------------------------------------------------------------
def _valid(thread) -> bool:
    return (isinstance(thread, dict) and THREAD_ID.fullmatch(str(thread.get("id") or "")) is not None
            and isinstance(thread.get("anchor"), dict) and isinstance(thread.get("messages"), list)
            and all(isinstance(m, dict) for m in thread["messages"]) and thread.get("status") in ("open", "resolved")
            and isinstance(thread.get("suggestions", []), list))


def _read(st: Store, aid: str) -> list[dict]:
    path = st._dir(aid) / FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    threads = data.get("threads") if isinstance(data, dict) else None
    return [t for t in threads if _valid(t)][:MAX_THREADS] if isinstance(threads, list) else []


def _write(st: Store, aid: str, threads: list[dict]) -> None:
    st._write_json(st._dir(aid) / FILE, {"version": 1, "threads": threads})


def _change(aid: str, work, *, store: Store | None = None):
    """Read, change and write the threads under the store's lock; ``work(threads, art)`` returns what to hand back."""
    st = _store(store)
    with st.lock():
        try:
            art = st.get(aid)
        except ArtifactError as exc:
            raise CommentError(str(exc)) from None
        threads = _read(st, aid)
        out = work(threads, art)
        _write(st, aid, threads)
        return out


def _find(threads: list[dict], tid: str) -> dict:
    for thread in threads:
        if thread["id"] == tid:
            return thread
    raise CommentError("That comment isn't there any more (it may have been deleted in another window).")


def _message(by: str, text: str, kind: str, **extra) -> dict:
    return {"id": _id("m"), "by": _line(by, 60) or "you", "at": _now(), "text": text, "kind": kind, **extra}


# ---- what the screens and the model do ----------------------------------------------------------------------------------
def add(aid: str, anchor, text, *, by: str = "you", store: Store | None = None) -> dict:
    """A new thread: what it points at, and the first words."""
    words = _words(text)
    if not words:
        raise CommentError("Write the comment first.")

    def work(threads, art):
        clean = clean_anchor(art.type, anchor)
        if clean["kind"] == "item":
            data = _store(store).source(aid)
            if not any(i.get("id") == clean["item"] for i in data.get("items") or []):
                raise CommentError(f"This checklist has no item {clean['item']}.")
        if len(threads) >= MAX_THREADS:
            raise CommentError(f"An artifact keeps {MAX_THREADS} comment threads at most. Delete resolved ones first.")
        thread = {"id": _id("t"), "anchor": clean, "version": art.version, "status": "open", "at": _now(),
                  "by": _line(by, 60) or "you", "messages": [_message(by, words, "comment")], "suggestions": []}
        threads.append(thread)
        return thread
    return _change(aid, work, store=store)


def reply(aid: str, tid: str, text, *, by: str = "you", kind: str = "reply", store: Store | None = None,
          **extra) -> dict:
    words = _words(text)
    if not words:
        raise CommentError("Write the reply first.")

    def work(threads, art):
        thread = _find(threads, tid)
        if len(thread["messages"]) >= MAX_MESSAGES:
            raise CommentError("This thread is full. Start a new comment.")
        thread["messages"].append(_message(by, words, kind, **extra))
        if by == "you" and thread["status"] == "resolved":
            thread["status"] = "open"                      # a new word from you opens it again
        return thread
    return _change(aid, work, store=store)


def resolve(aid: str, tid: str, resolved: bool = True, *, by: str = "you", store: Store | None = None) -> dict:
    def work(threads, art):
        thread = _find(threads, tid)
        thread["status"] = "resolved" if resolved else "open"
        if resolved:
            thread["resolved_at"], thread["resolved_by"] = _now(), _line(by, 60) or "you"
        else:
            thread.pop("resolved_at", None)
            thread.pop("resolved_by", None)
        return thread
    return _change(aid, work, store=store)


def delete(aid: str, tid: str, *, store: Store | None = None) -> None:
    def work(threads, art):
        threads.remove(_find(threads, tid))
    _change(aid, work, store=store)


def answering(aid: str, tid: str, on: bool, *, store: Store | None = None) -> dict:
    """DGC is answering this thread (said on every screen), or has finished."""
    def work(threads, art):
        thread = _find(threads, tid)
        if on:
            thread["answering"] = _now()
        else:
            thread.pop("answering", None)
        return thread
    return _change(aid, work, store=store)


def get(aid: str, tid: str, *, store: Store | None = None) -> dict:
    st = _store(store)
    try:
        st.get(aid)
    except ArtifactError as exc:
        raise CommentError(str(exc)) from None
    return _find(_read(st, aid), tid)


def _busy(thread: dict) -> bool:
    stamp = str(thread.get("answering") or "")
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(timezone.utc) - when < ANSWERING_FOR


def threads(aid: str, *, store: Store | None = None) -> list[dict]:
    """Every thread, oldest first, each read against the current version (found, where, part)."""
    st = _store(store)
    try:
        art = st.get(aid)
    except ArtifactError as exc:
        raise CommentError(str(exc)) from None
    kept = _read(st, aid)
    if not kept:
        return []
    try:
        content = current_content(aid, store=st)
    except (ArtifactError, OSError, ValueError):
        content = None
    out = []
    for thread in kept:
        found = locate(art.type, content, thread["anchor"], label=service.LABELS.get(art.type, ""))
        shown = {**thread, "answering": _busy(thread), "found": found["found"], "where": found["where"],
                 "part": found.get("part", "")}
        if found["found"] == "moved":
            shown["anchor"] = {**thread["anchor"], **{k: found[k] for k in ("range", "slide") if k in found}}
        out.append(shown)
    return out


def wire(threads_: list[dict]) -> list[dict]:
    """The threads as an event carries them: without the text the model reads."""
    return [{k: v for k, v in t.items() if k != "part"} for t in threads_]


def counts(aid: str, *, store: Store | None = None) -> dict | None:
    """{open, all} for the Library and a card; None when it has no comments."""
    try:
        kept = _read(_store(store), aid)
    except ArtifactError:
        return None
    if not kept:
        return None
    return {"open": sum(1 for t in kept if t["status"] == "open"), "all": len(kept)}


def _between(md: str, before: str, after: str) -> str:
    """The words now between a comment's neighbours (its own words were changed), or "" when they can't be found."""
    b, a = plain(before, lead=False), plain(after, lead=False)
    if len(b) < 8 or len(a) < 8:
        return ""
    joined = " ".join(plain(x) for x in re.split(r"\n[ \t]*\n", md) if x.strip())
    found = []
    at = joined.find(b)
    while at >= 0:
        end = joined.find(a, at + len(b))
        if end >= 0 and end - (at + len(b)) <= MAX_QUOTE:
            found.append(joined[at + len(b):end].strip())
        at = joined.find(b, at + 1)
    return found[0] if len(found) == 1 and found[0] else ""


def reanchor(aid: str, tid: str, *, replaced=(), store: Store | None = None) -> dict:
    """After a change made from this thread (DGC's edit, a suggestion accepted): the thread points at the same place in
    the new version, as it is now (the cells' new values, the words now between its neighbours, the slide's new title),
    rather than saying the place changed when it changed because the comment asked for it. ``replaced``: the words
    that change put in place of others ([(old, new)]: a suggestion accepted, DGC's exact edits)."""
    st = _store(store)
    art = st.get(aid)
    content = current_content(aid, store=st)

    def work(threads, _art):
        thread = _find(threads, tid)
        a = dict(thread["anchor"])
        found = locate(art.type, content, a)
        kind = a["kind"]
        if kind == "cells":
            sheet = next((x for x in (content.get("sheets") or []) if x.get("name") == a["sheet"]), None)
            rng = found.get("range") or a["range"]
            block = _block(_sheet_rows(sheet), *_span(rng)) if sheet is not None else None
            if block is not None:
                a["range"] = rng
                if sum(len(r) for r in block) <= MAX_CELLS:
                    a["values"] = block
                a["quote"] = "\n".join("  ".join("" if v is None else str(v) for v in r) for r in block)[:MAX_QUOTE]
        elif kind == "text" and found["found"] == "changed":
            q, now = plain(a.get("quote", ""), lead=False), ""
            for old, new in replaced or ():
                was, put = plain(str(old), lead=False), plain(str(new), lead=False)
                if not was:
                    continue
                if q and q in was:
                    now = put                                 # its words were rewritten: the new words
                elif was in q:
                    now = q.replace(was, put)                 # part of its words were: the same words, changed
                if now:
                    break
            now = now or _between(content, a.get("before", ""), a.get("after", ""))
            if now and locate(art.type, content, {**a, "quote": now})["found"] == "here":
                a["quote"] = now[:MAX_QUOTE]
        elif kind == "slide":
            slides = content.get("slides") or []
            n = found.get("slide", a["slide"]) - 1
            if 0 <= n < len(slides):
                a["slide"] = n + 1
                a["title"] = str(slides[n].get("title") or "")[:MAX_SHORT]
                if found["found"] == "changed":
                    a.pop("quote", None)
        elif kind == "element" and found["found"] == "changed":
            a.pop("quote", None)
        elif kind == "item" and found["found"] == "here":
            item = next(i for i in content.get("items") or [] if i.get("id") == a["item"])
            a["title"] = str(item.get("title") or "")[:MAX_SHORT]
        thread["anchor"], thread["version"] = clean_anchor(art.type, a), art.version
        return thread
    return _change(aid, work, store=st)


# ---- suggestions ------------------------------------------------------------------------------------------------------
def _once(where: str, old: str, what: str) -> None:
    count = where.count(old)
    if not count:
        raise CommentError(f"“{old[:80]}” isn't in the {what} now. Copy the words exactly as they are in it.")
    if count > 1:
        raise CommentError(f"“{old[:80]}” is in the {what} {count} times. Include more of the words around it, so it's "
                           "found once.")


def suggest(aid: str, tid: str, changes, *, by: str = "DGC", store: Store | None = None) -> list[dict]:
    """Wording changes for the user to accept or reject one by one: each {old: words in it now, new: words instead}."""
    st = _store(store)
    art = st.get(aid)
    if art.type not in SUGGEST_TYPES:
        raise CommentError("Suggestions are for the words of a document or a page. Change this one with edit_artifact.")
    if not isinstance(changes, list) or not changes:
        raise CommentError("Give the changes: [{\"old\": the exact words now, \"new\": the words instead}].")
    if len(changes) > 20:
        raise CommentError("Suggest 20 changes at most at a time.")
    text = current_content(aid, store=st)
    what = "document" if art.type == "doc" else "page"
    made = []
    for i, change in enumerate(changes, 1):
        if not isinstance(change, dict) or not isinstance(change.get("old"), str) or not change["old"]:
            raise CommentError(f"Change {i} needs old: the exact words in the {what} now.")
        new = change.get("new")
        if not isinstance(new, str):
            raise CommentError(f"Change {i} needs new: the words to put instead (\"\" to take them out).")
        if len(change["old"]) > MAX_TEXT or len(new) > MAX_TEXT:
            raise CommentError(f"Change {i} is too long: suggest smaller changes.")
        if change["old"] == new:
            raise CommentError(f"Change {i} changes nothing.")
        _once(text, change["old"], what)
        made.append({"id": _id("s"), "old": change["old"], "new": new, "state": "open", "at": _now(),
                     "by": _line(by, 60) or "DGC"})

    def work(threads, _art):
        thread = _find(threads, tid)
        thread.setdefault("suggestions", [])
        if len(thread["suggestions"]) + len(made) > MAX_SUGGESTIONS:
            raise CommentError("This thread has as many suggestions as it can hold. Start a new comment.")
        thread["suggestions"].extend(made)
        return made
    return _change(aid, work, store=st)


def _suggestion(thread: dict, sid: str) -> dict:
    for item in thread.get("suggestions") or []:
        if item.get("id") == sid:
            return item
    raise CommentError("That suggestion isn't there any more.")


def accept(aid: str, tid: str, sid: str, *, store: Store | None = None) -> dict:
    """Make one suggestion's change: a new version (by you, "From a comment"), those words only. Returns the artifact."""
    st = _store(store)
    thread = get(aid, tid, store=st)
    item = _suggestion(thread, sid)
    if item.get("state") != "open":
        raise CommentError(f"That suggestion was {item.get('state')} already.")
    art = st.get(aid)
    note = f"From a comment: “{_line(item['old'], 40)}” → “{_line(item['new'], 40)}”"
    gone = CommentError("The words this suggestion would change aren't in it any more (it changed since). Ask DGC again.")
    if art.type == "doc":
        service.keep_users_edits(aid, store=store)        # what you typed in its file is kept first, as your version
        try:
            view = service.edit(aid, edits=[{"find": item["old"], "replace": item["new"]}], author="you", note=note,
                                store=store)
        except service.ArtifactUseError as exc:
            if "isn't in the canvas" in str(exc) or "times" in str(exc):
                raise gone from None
            raise
    elif art.type == "page":
        with st.edit_lock(aid):
            art = st.get(aid)
            files = st.files(aid)
            entry = art.entry or "index.html"
            html = files.get(entry, b"").decode("utf-8", "replace")
            if html.count(item["old"]) != 1:
                raise gone
            files[entry] = html.replace(item["old"], item["new"], 1).encode("utf-8")
            try:
                st.update(aid, files, author="you", summary=note, base_version=art.version, entry=entry)
            except ArtifactError as exc:
                raise CommentError(str(exc)) from None
        view = service.view(aid, store=store)
    else:
        raise CommentError("Suggestions are for the words of a document or a page.")

    def work(threads, _art):
        found = _suggestion(_find(threads, tid), sid)
        found.update(state="accepted", answered_at=_now(), version=view["version"])
    _change(aid, work, store=st)
    reanchor(aid, tid, replaced=[(item["old"], item["new"])], store=st)
    return view


def reject(aid: str, tid: str, sid: str, *, store: Store | None = None) -> dict:
    """Leave the artifact as it is; the suggestion says it was rejected."""
    def work(threads, _art):
        thread = _find(threads, tid)
        item = _suggestion(thread, sid)
        if item.get("state") != "open":
            raise CommentError(f"That suggestion was {item.get('state')} already.")
        item.update(state="rejected", answered_at=_now())
        return thread
    return _change(aid, work, store=store)
