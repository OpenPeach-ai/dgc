"""What fills a model's context window, as one list for every surface (CONTEXT_BREAKDOWN_PLAN.md): ChatDGC, main
DGC and Pips build their categories with their own counter, and this puts them in one shape for the screen and for
SDK users, as Claude's Usage sheet shows it.

A breakdown: {window, used, source, compact_at, categories: [{id, label, tokens, items?: [{name, tokens}]}], buffer,
free, deferred?}. Categories come biggest first; a category's items (a tool each, a file each) biggest first and at
most MAX_ITEMS of them. When the provider reported the last request's real count, the pieces (estimated) are scaled
to it, so they add up to what the model counted. `buffer` is the room kept free before the chat is compacted
(the window past `compact_at`), and `free` what's left of the window besides: they never go below zero, and a
window that's full past its buffer shows no free space rather than a negative one.
"""
from __future__ import annotations

MAX_ITEMS = 60


def category(id: str, label: str, tokens: int, items: list[tuple[str, int]] | None = None) -> dict:
    out = {"id": id, "label": label, "tokens": max(0, int(tokens or 0))}
    if items:
        out["items"] = [{"name": str(name)[:120], "tokens": max(0, int(n or 0))} for name, n in items]
    return out


def _scaled(categories: list[dict], to: int) -> list[dict]:
    """The pieces in proportion, adding up to exactly `to` (what's left over by rounding goes to the biggest)."""
    estimated = sum(c["tokens"] for c in categories)
    if not estimated or not to:
        return categories
    out = []
    for c in categories:
        k = to / estimated
        scaled = {**c, "tokens": round(c["tokens"] * k)}
        if c.get("items"):
            scaled["items"] = [{**i, "tokens": round(i["tokens"] * k)} for i in c["items"]]
        out.append(scaled)
    drift = to - sum(c["tokens"] for c in out)
    if drift and out:
        biggest = max(out, key=lambda c: c["tokens"])
        biggest["tokens"] = max(0, biggest["tokens"] + drift)
    return out


def build(window: int, categories: list[dict], *, compact_at: float, reported: int = 0,
          deferred: list[dict] | None = None) -> dict:
    """The breakdown of a window of `window` tokens, compacted past `compact_at` of it (a share, 0..1)."""
    window = max(0, int(window or 0))
    kept = [c for c in categories if c.get("tokens", 0) > 0]
    for c in kept:
        if c.get("items"):
            c["items"] = sorted((i for i in c["items"] if i["tokens"] > 0), key=lambda i: (-i["tokens"], i["name"]))[:MAX_ITEMS]
            if not c["items"]:
                del c["items"]
    reported = max(0, int(reported or 0))
    if reported:
        kept = _scaled(kept, reported)
    kept.sort(key=lambda c: -c["tokens"])
    used = sum(c["tokens"] for c in kept)
    at = int(window * min(1.0, max(0.0, float(compact_at))))
    buffer = max(0, window - max(at, used)) if window else 0
    free = max(0, window - used - buffer)
    out = {"window": window, "used": used, "source": "reported" if reported else "estimated", "compact_at": at,
           "categories": kept, "buffer": buffer, "free": free}
    if deferred:
        out["deferred"] = [d for d in deferred if d.get("tokens", 0) > 0]
    return out
