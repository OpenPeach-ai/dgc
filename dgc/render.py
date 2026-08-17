"""Grok-style tool rendering: a clean unified-diff renderer (line-number gutter,
mono+purple bands, collapsed unchanged runs) plus a per-tool line formatter."""
from __future__ import annotations

import re

from . import glyphs, style

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
_CTX_COLLAPSE = 4   # context runs longer than this collapse to a single "… N unchanged" line


def render_diff(diff_text: str):
    """A unified diff → a rich Text: dim gutter line numbers, `+` bright / `-` faint,
    long unchanged runs collapsed to `⋯ N unchanged lines`."""
    from rich.text import Text
    t = style.theme()
    out = Text()
    new_ln = 0
    ctx_run: list[str] = []

    def flush_ctx():
        nonlocal ctx_run
        if not ctx_run:
            return
        if len(ctx_run) > _CTX_COLLAPSE:
            # keep 1 line of context on each side, collapse the middle
            _line(out, t, ctx_run[0][0], ctx_run[0][1], "ctx")
            out.append(f"        {glyphs.ELLIPSIS_V} {len(ctx_run) - 2} unchanged lines\n",
                       style=t.faint)
            _line(out, t, ctx_run[-1][0], ctx_run[-1][1], "ctx")
        else:
            for gutter, text in ctx_run:
                _line(out, t, gutter, text, "ctx")
        ctx_run = []

    for ln in diff_text.splitlines():
        if ln.startswith("+++") or ln.startswith("---") or ln.startswith("diff "):
            continue
        m = _HUNK.match(ln)
        if m:
            flush_ctx()
            new_ln = int(m.group(1))
            continue
        if ln.startswith("+"):
            flush_ctx()
            _line(out, t, new_ln, ln[1:], "add")
            new_ln += 1
        elif ln.startswith("-"):
            flush_ctx()
            _line(out, t, None, ln[1:], "del")
        else:  # context (leading space or bare)
            ctx_run.append((new_ln, ln[1:] if ln.startswith(" ") else ln))
            new_ln += 1
    flush_ctx()
    return out


def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def context_bar(used: int, size: int, width: int = 18):
    """A `used/size ████░░ NN%` usage bar, purple → red past 85% (Grok context_bar)."""
    from rich.text import Text
    t = style.theme()
    pct = (used / size) if size else 0.0
    pct = 1.0 if pct > 1 else pct
    filled = int(round(pct * width))
    color = t.accent if pct < 0.85 else t.err
    bar = Text()
    bar.append(f"{fmt_tokens(used)} / {fmt_tokens(size)}  ", style=t.muted)
    bar.append("█" * filled, style=color)
    bar.append("░" * (width - filled), style=t.border_strong)
    bar.append(f"  {int(pct * 100)}%", style=color)
    return bar


def _line(out, t, gutter, text: str, kind: str) -> None:
    num = f"{gutter:>4}" if gutter is not None else "    "
    if kind == "add":
        out.append(f"  {num} ", style=t.faint)
        out.append("+ ", style=t.accent)
        out.append(text + "\n", style=t.diff_add)
    elif kind == "del":
        out.append(f"  {num} ", style=t.faint)
        out.append("- ", style=t.faint)
        out.append(text + "\n", style=f"{t.diff_del} strike")
    else:
        out.append(f"  {num}   ", style=t.faint)
        out.append(text + "\n", style=t.muted)
