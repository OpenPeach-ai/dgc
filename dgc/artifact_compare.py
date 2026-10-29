"""Bounded, read-only comparisons of immutable artifact versions.

Only text and data leave this module. A page comparison uses blob identities, never runs or
renders the page, and never reads files outside the artifact store.
"""
from __future__ import annotations

import difflib
import json

from .artifact_store import ArtifactError, Store

MAX_CHANGES = 200
MAX_VALUE = 1000
MAX_DIFF = 40_000
MAX_LINES = 2000


def compare(store: Store, aid: str, before: int, after: int | None = None) -> dict:
    art = store.get(aid)
    after = art.version if after is None else after
    if any(isinstance(n, bool) or not isinstance(n, int) or n < 1 for n in (before, after)):
        raise ArtifactError("Choose two positive version numbers to compare.")
    left, right = store.version(aid, before), store.version(aid, after)
    result = {"id": aid, "type": art.type, "title": art.title, "before": before, "after": after,
              "changes": [], "total": 0, "truncated": False}

    def text(value):
        raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
        if len(raw) > MAX_VALUE:
            result["truncated"] = True
            return raw[:MAX_VALUE] + "…"
        return raw

    def add(label, old, new, *, kind="changed"):
        result["total"] += 1
        if len(result["changes"]) >= MAX_CHANGES:
            result["truncated"] = True
            return
        result["changes"].append({"label": label, "kind": kind, "before": text(old), "after": text(new)})

    def diff(old, new):
        # Bound both matching work and output. A long or repetitive document must not hold
        # the editor's wire or make a comparison event larger than the frame limit.
        old_lines, new_lines = old[:MAX_DIFF].splitlines(keepends=True), new[:MAX_DIFF].splitlines(keepends=True)
        if len(old) > MAX_DIFF or len(new) > MAX_DIFF or max(len(old_lines), len(new_lines)) > MAX_LINES:
            result["truncated"] = True
        lines = difflib.unified_diff(old_lines[:MAX_LINES], new_lines[:MAX_LINES],
                                     fromfile=f"Version {before}", tofile=f"Version {after}", lineterm="")
        chunks, size = [], 0
        for index, line in enumerate(lines):
            marker = ""
            if index >= 2 and line[:1] in ("+", "-", " ") and not line.endswith("\n"):
                marker = "\n\\ No newline at end of file"
            shown = line.rstrip("\n") + marker
            if size + len(shown) + 1 > MAX_DIFF:
                result["truncated"] = True
                break
            chunks.append(shown)
            size += len(shown) + 1
        return "\n".join(chunks)

    if left.files == right.files and left.entry == right.entry:
        return result
    if art.type == "page":
        if left.entry != right.entry:
            add("Start file", left.entry, right.entry)
        for name in sorted(left.files.keys() | right.files.keys()):
            old, new = left.files.get(name), right.files.get(name)
            if old == new:
                continue
            add(name, f"{old['size']} bytes" if old else "Absent", f"{new['size']} bytes" if new else "Absent",
                kind="added" if old is None else "removed" if new is None else "changed")
        return result
    old, new = store.source(aid, before), store.source(aid, after)
    if art.type == "doc":
        result["diff"] = diff(old, new)
        result["total"] = 1
    elif art.type == "slides":
        old_slides, new_slides = old.get("slides", []), new.get("slides", [])
        for i in range(max(len(old_slides), len(new_slides))):
            a = old_slides[i] if i < len(old_slides) else None
            b = new_slides[i] if i < len(new_slides) else None
            if a != b:
                add(f"Slide {i + 1}", a, b, kind="added" if a is None else "removed" if b is None else "changed")
        a, b = ({k: v for k, v in deck.items() if k != "slides"} for deck in (old, new))
        if a != b:
            add("Deck settings", a, b)
    elif art.type == "sheet":
        from .artifact_sheet import letters
        old_sheets = {s["name"]: s for s in old.get("sheets", [])}
        new_sheets = {s["name"]: s for s in new.get("sheets", [])}
        if list(old_sheets) != list(new_sheets):
            add("Sheet order", list(old_sheets), list(new_sheets))
        for name in dict.fromkeys([*old_sheets, *new_sheets]):
            a, b = old_sheets.get(name), new_sheets.get(name)
            if a is None or b is None:
                add(name, "Present" if a else "Absent", "Present" if b else "Absent",
                    kind="added" if a is None else "removed")
                continue
            am, bm = ({k: v for k, v in sheet.items() if k != "rows"} for sheet in (a, b))
            if am != bm:
                add(f"{name} · columns and settings", am, bm)
            ar, br = a.get("rows", []), b.get("rows", [])
            if len(ar) != len(br):
                add(f"{name} · row count", len(ar), len(br))
            for r in range(max(len(ar), len(br))):
                ac = ar[r] if r < len(ar) else []
                bc = br[r] if r < len(br) else []
                for c in range(max(len(ac), len(bc))):
                    av, bv = ac[c] if c < len(ac) else None, bc[c] if c < len(bc) else None
                    if av != bv or type(av) is not type(bv):
                        add(f"{name}!{letters(c)}{r + 2}", av, bv)
    else:
        for key in sorted(old.keys() | new.keys()):
            if old.get(key) != new.get(key):
                add(key, old.get(key), new.get(key))
    return result
