"""What a mod draws: one tree, checked here, drawn by the terminal (into the focus pane's segments, a band above the
prompt, a status line) and sent as it is to the editor's webviews.

Elements (each {"type": …}):
    Box {children, title?}             Row {children}               Column {children}
    Text {text, tone?}                 Markdown {text}              Button {id, label}
    Input {id, placeholder?, value?}   Select {id, options: [{value, label}], value?}
    Bar {segments: [{label, value, tone?}], total?}   Table {columns: [..], rows: [[..]]}
    Sparkline {values: [numbers], label?}
tone is one of muted, strong, accent, ok, warn, bad. A tree is at most MAX_NODES elements, MAX_DEPTH deep; text is
cut to its limits. Anything else is refused with a reason the mod's author can act on.
"""
from __future__ import annotations

import math
import re
import unicodedata

from ..pane import Segment

MAX_NODES = 400
MAX_DEPTH = 8
MAX_TEXT = 2000
MAX_ROWS = 60
MAX_COLUMNS = 8
ID = re.compile(r"[A-Za-z0-9_.:-]{1,64}\Z")
TONES = ("muted", "strong", "accent", "ok", "warn", "bad")
CONTAINERS = ("Box", "Row", "Column")
KINDS = CONTAINERS + ("Text", "Markdown", "Button", "Input", "Select", "Bar", "Table", "Sparkline")
# The pane's roles (dgc/pane.py) for each tone.
ROLE = {"muted": "muted-data", "strong": "strong", "accent": "accent", "ok": "good", "warn": "warn", "bad": "error",
        None: "text"}
SPARKS = "▁▂▃▄▅▆▇█"


class UIError(ValueError):
    """The tree isn't one DGC draws; the text says why."""


def _text(value, limit: int = MAX_TEXT) -> str:
    """Printable text only (no terminal control sequences), cut to the limit."""
    s = "".join(ch if ch in "\n\t" or unicodedata.category(ch)[0] != "C" else " " for ch in str(value or ""))
    return s[:limit]


def _finite_number(value) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            number = float(value)
            if math.isfinite(number):
                return number
        except OverflowError:
            pass
    raise UIError("numbers must be finite and small enough to display.")


def _table_cell(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        _finite_number(value)
        return value
    return _text(value, 80)


def clean(tree) -> dict:
    """The tree, checked and cut to its limits: what is kept, drawn and sent to the editor."""
    count = [0]

    def walk(node, depth):
        if not isinstance(node, dict):
            raise UIError("each element is an object with a type.")
        kind = node.get("type")
        if kind not in KINDS:
            raise UIError(f"{kind!r} isn't an element (one of {', '.join(KINDS)}).")
        count[0] += 1
        if count[0] > MAX_NODES:
            raise UIError(f"a tree has at most {MAX_NODES} elements.")
        if depth > MAX_DEPTH:
            raise UIError(f"a tree is at most {MAX_DEPTH} deep.")
        out = {"type": kind}
        tone = node.get("tone")
        if tone is not None:
            if tone not in TONES:
                raise UIError(f"tone is one of {', '.join(TONES)}.")
            out["tone"] = tone
        if kind in CONTAINERS:
            kids = node.get("children") or []
            if not isinstance(kids, list):
                raise UIError(f"{kind}.children is a list.")
            out["children"] = [walk(k, depth + 1) for k in kids]
            if kind == "Box" and node.get("title") is not None:
                out["title"] = _text(node["title"], 80)
        elif kind in ("Text", "Markdown"):
            out["text"] = _text(node.get("text"))
        elif kind in ("Button", "Input", "Select"):
            ident = node.get("id")
            if not isinstance(ident, str) or not ID.fullmatch(ident):
                raise UIError(f"{kind}.id is 1–64 letters, digits and _.:-")
            out["id"] = ident
            if kind == "Button":
                out["label"] = _text(node.get("label") or "OK", 40)
            elif kind == "Input":
                out["placeholder"] = _text(node.get("placeholder"), 80)
                out["value"] = _text(node.get("value"), 400)
            else:
                options = node.get("options") or []
                if (not isinstance(options, list) or not options or len(options) > 30
                        or not all(isinstance(o, dict) for o in options)):
                    raise UIError("Select.options is a list of 1–30 {value, label}.")
                out["options"] = [{"value": _text(o.get("value"), 80), "label": _text(o.get("label") or o.get("value"), 80)}
                                  for o in options if isinstance(o, dict)]
                out["value"] = _text(node.get("value"), 80)
        elif kind == "Bar":
            segments = node.get("segments") or []
            if not isinstance(segments, list) or len(segments) > 12:
                raise UIError("Bar.segments is a list of at most 12 {label, value, tone?}.")
            kept = []
            for seg in segments:
                if not isinstance(seg, dict):
                    raise UIError("each Bar segment has a value of 0 or more.")
                value = _finite_number(seg.get("value"))
                if value < 0:
                    raise UIError("each Bar segment has a value of 0 or more.")
                if seg.get("tone") is not None and seg["tone"] not in TONES:
                    raise UIError(f"tone is one of {', '.join(TONES)}.")
                kept.append({"label": _text(seg.get("label"), 40), "value": value,
                             **({"tone": seg["tone"]} if seg.get("tone") else {})})
            out["segments"] = kept
            total = node.get("total")
            if total is not None:
                total = _finite_number(total)
                if total <= 0:
                    raise UIError("Bar.total is a number above 0.")
                out["total"] = float(total)
        elif kind == "Table":
            columns, rows = node.get("columns") or [], node.get("rows") or []
            if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_COLUMNS:
                raise UIError(f"Table.columns is 1–{MAX_COLUMNS} names.")
            if not isinstance(rows, list):
                raise UIError("Table.rows is a list of rows.")
            out["columns"] = [_text(c, 40) for c in columns]
            out["rows"] = [[_table_cell(cell)
                            for cell in (r if isinstance(r, list) else [])[:len(columns)]] for r in rows[:MAX_ROWS]]
        elif kind == "Sparkline":
            values = node.get("values") or []
            if not isinstance(values, list) or len(values) > 120 or not all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
                raise UIError("Sparkline.values is at most 120 numbers.")
            out["values"] = [_finite_number(v) for v in values]
            out["label"] = _text(node.get("label"), 40)
        return out

    return walk(tree, 1)


# ---- the terminal ----------------------------------------------------------------------------------------------

def _wrap(text: str, width: int) -> list[str]:
    lines = []
    for para in text.split("\n"):
        words, line = para.split(" "), ""
        for w in words:
            while len(w) > width:
                if line:
                    lines.append(line)
                    line = ""
                lines.append(w[:width])
                w = w[width:]
            if not line:
                line = w
            elif len(line) + 1 + len(w) <= width:
                line += " " + w
            else:
                lines.append(line)
                line = w
        lines.append(line)
    return lines


def _markdown_plain(text: str) -> str:
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: m.group(1) or m.group(2), text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)


def _num(v) -> str:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, int) and abs(v) >= 1000:
        return f"{v / 1000:.1f}K".replace(".0K", "K") if abs(v) < 1_000_000 else f"{v / 1_000_000:.1f}M"
    return str(v)


def lines(tree: dict, width: int) -> list[tuple[Segment, ...]]:
    """A clean tree as the terminal's lines (pane segments), width at least 10."""
    width = max(10, width)
    kind = tree["type"]
    role = ROLE.get(tree.get("tone"))
    if kind == "Column":
        return [line for kid in tree["children"] for line in lines(kid, width)]
    if kind == "Box":
        inner = [line for kid in tree["children"] for line in lines(kid, width - 2)]
        head = [(Segment(tree["title"], "strong"),)] if tree.get("title") else []
        return head + [(Segment("  "),) + line for line in inner]
    if kind == "Row":
        flat = all(k["type"] in ("Text", "Button", "Input", "Select") for k in tree["children"])
        if not flat:
            return [line for kid in tree["children"] for line in lines(kid, width)]
        segs, used = [], 0
        for kid in tree["children"]:
            for seg in (lines(kid, width)[0] if lines(kid, width) else ()):
                piece = seg.text[:max(0, width - used)]
                if piece:
                    segs.append(Segment(piece, seg.role))
                    used += len(piece)
            if used < width:
                segs.append(Segment("  "))
                used += 2
        return [tuple(segs)]
    if kind == "Text":
        return [(Segment(line, role),) for line in _wrap(tree["text"], width)]
    if kind == "Markdown":
        return [(Segment(line, role),) for line in _wrap(_markdown_plain(tree["text"]), width)]
    if kind == "Button":
        return [(Segment(f"[ {tree['label']} ]", "accent"),)]
    if kind == "Input":
        shown = tree.get("value") or tree.get("placeholder") or ""
        return [(Segment(f"[ {shown} ]", "text" if tree.get("value") else "muted-data"),)]
    if kind == "Select":
        label = next((o["label"] for o in tree["options"] if o["value"] == tree.get("value")), tree["options"][0]["label"])
        return [(Segment(f"{label} ▾", "text"),)]
    if kind == "Bar":
        segs = tree["segments"]
        # Normalize before summing so large finite segments cannot overflow the total.
        scale = max((s["value"] for s in segs), default=0) or 1.0
        total = tree.get("total")
        normalized_total = sum(s["value"] / scale for s in segs) or 1.0
        cells, bar = width, []
        remaining = cells
        for s in segs:
            fraction = s["value"] / total if total is not None else (s["value"] / scale) / normalized_total
            n = min(remaining, int(round(cells * min(1.0, fraction))))
            if n:
                bar.append(Segment("█" * n, ROLE.get(s.get("tone"), "accent") if s.get("tone") else "accent"))
                remaining -= n
        if remaining:
            bar.append(Segment("░" * remaining, "muted-data"))
        legend = "  ".join(f"{s['label']} {_num(s['value'])}" for s in segs if s["label"])
        return [tuple(bar)] + ([(Segment(line, "muted-data"),) for line in _wrap(legend, width)] if legend else [])
    if kind == "Table":
        cols = tree["columns"]
        cells = [[_num(c) if isinstance(c, (int, float)) else str(c) for c in row] + [""] * (len(cols) - len(row))
                 for row in tree["rows"]]
        widths = [max([len(c)] + [len(r[i]) for r in cells]) for i, c in enumerate(cols)]
        while sum(widths) + 2 * (len(widths) - 1) > width and max(widths) > 4:
            widths[widths.index(max(widths))] -= 1
        fit = lambda s, w: (s if len(s) <= w else s[:max(1, w - 1)] + "…").ljust(w)  # noqa: E731
        head = tuple(Segment(fit(c, widths[i]) + ("  " if i < len(cols) - 1 else ""), "strong") for i, c in enumerate(cols))
        body = [tuple(Segment(fit(r[i], widths[i]) + ("  " if i < len(cols) - 1 else ""), role) for i in range(len(cols)))
                for r in cells]
        return [head] + body
    if kind == "Sparkline":
        values = tree["values"][-max(1, width - len(tree.get("label") or "") - 1):]
        if not values:
            return [(Segment(tree.get("label") or "", "muted-data"),)]
        scale = max(abs(v) for v in values) or 1.0
        values = [v / scale for v in values]
        lo, hi = min(values), max(values)
        spark = "".join(SPARKS[0 if hi == lo else int((v - lo) / (hi - lo) * (len(SPARKS) - 1))] for v in values)
        label = (tree.get("label") + " ") if tree.get("label") else ""
        return [(Segment(label, "muted-data"), Segment(spark, "accent"))]
    return []


def one_line(tree: dict, width: int) -> tuple[Segment, ...]:
    """The tree on one line, for the status bar: its first line, cut to the width."""
    got = lines(tree, max(10, width))
    out, used = [], 0
    for seg in (got[0] if got else ()):
        piece = seg.text[:max(0, width - used)]
        if piece:
            out.append(Segment(piece, seg.role))
            used += len(piece)
    return tuple(out)
