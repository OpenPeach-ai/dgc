"""Every widget kept in the Library (0.52; decided 15 Nov: "every widget, automatically").

A ``dgc-ui`` card a Work session's or a Pip's reply draws (genui_prompt) becomes a Page of its own in the artifact store,
as ChatDGC's widgets already do (artifact_index): drawn from the card's JSON in DGC's look, its origin the session or
Pip that drew it. Kept together by where it was made and its title: the same card drawn again there is a new version of
that Page (each version kept), never a new item; nothing is ever deleted here. Every word of a card is escaped: HTML in
it shows as words, never runs. Never raises: a card that can't be kept leaves the reply as it was.
"""
from __future__ import annotations

import hashlib
import html as _html
import json
import re

_FENCE = re.compile(r"^```dgc-ui[ \t]*\n(.*?)^```[ \t]*(?:\n|$)", re.MULTILINE | re.DOTALL)
MAX_CARDS = 3                       # a reply draws one (genui_prompt); a few more are kept, never a flood
MAX_JSON = 32_000
STATE_WORDS = {"done": "Done", "running": "Running", "attention": "Needs attention", "waiting": "Waiting"}


def cards_in(text: str) -> list[dict]:
    """The valid dgc-ui cards in a reply, in order."""
    out = []
    for match in _FENCE.finditer(text or ""):
        raw = match.group(1)
        if len(raw) > MAX_JSON:
            continue
        try:
            card = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        if isinstance(card, dict) and isinstance(card.get("blocks"), list) and str(card.get("title") or "").strip():
            out.append(card)
        if len(out) >= MAX_CARDS:
            break
    return out


def _e(value) -> str:
    return _html.escape(str(value if value is not None else ""), quote=True)


def _block(block: dict) -> str:
    kind, label = block.get("type"), block.get("label")
    head = f"<h2>{_e(label)}</h2>" if label else ""
    items = [i for i in block.get("items") or [] if isinstance(i, dict)][:8]
    if kind == "metrics":
        cells = "".join(f'<div class="m"><div class="ml">{_e(i.get("label"))}</div><div class="mv">{_e(i.get("value"))}</div>'
                        f'<div class="md">{_e(i.get("detail"))}</div></div>' for i in items)
        return f'{head}<div class="metrics">{cells}</div>'
    if kind == "steps":
        rows = "".join(f'<li class="s-{_e(i.get("state"))}"><b>{_e(i.get("label"))}</b> '
                       f'<span class="st">{_e(STATE_WORDS.get(str(i.get("state")), i.get("state") or ""))}</span>'
                       f'{(" · " + _e(i.get("detail"))) if i.get("detail") else ""}</li>' for i in items)
        return f'{head}<ol class="steps">{rows}</ol>'
    if kind == "bars":
        values = [float(i["value"]) for i in items if isinstance(i.get("value"), (int, float)) and not isinstance(i.get("value"), bool)]
        top = max(values) if values and max(values) > 0 else 1.0
        rows = "".join(f'<div class="b"><span class="bl">{_e(i.get("label"))}</span><span class="bt">'
                       f'<span class="bf" style="width:{max(0.0, min(100.0, float(i.get("value") or 0) / top * 100)):.1f}%"></span></span>'
                       f'<span class="bv">{_e(i.get("value"))}</span></div>'
                       for i in items if isinstance(i.get("value"), (int, float)) and not isinstance(i.get("value"), bool))
        return f'{head}<div class="bars">{rows}</div>'
    if kind == "table":
        columns = [c for c in block.get("columns") or []][:12]
        rows = [r for r in block.get("rows") or [] if isinstance(r, list)][:50]
        th = "".join(f"<th>{_e(c)}</th>" for c in columns)
        trs = "".join("<tr>" + "".join(f"<td>{_e(c)}</td>" for c in r[:12]) + "</tr>" for r in rows)
        return f'{head}<div class="tw"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'
    if kind == "choices":
        chips = "".join(f'<li><b>{_e(i.get("label"))}</b>{(" · " + _e(i.get("description"))) if i.get("description") else ""}</li>'
                        for i in items)
        return f'{head}<ul class="choices">{chips}</ul>'
    return ""


def page_html(card: dict) -> str:
    """The card as a page of its own, light and dark."""
    blocks = "".join(_block(b) for b in card.get("blocks") or [] if isinstance(b, dict))
    sub = f'<p class="sub">{_e(card.get("subtitle"))}</p>' if card.get("subtitle") else ""
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
            f"<title>{_e(card.get('title'))}</title><style>"
            ":root{--bg:#fff;--fg:#1f1f1f;--muted:#666;--line:#e3e3e3;--soft:#f4f4f5;--acc:#6d5acd}"
            "@media(prefers-color-scheme:dark){:root{--bg:#1e1e1e;--fg:#e6e6e6;--muted:#a0a0a0;--line:#333;--soft:#262626;--acc:#a596ff}}"
            "body{margin:0;padding:20px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}"
            "h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 8px;color:var(--muted);font-weight:600}"
            ".sub{color:var(--muted);margin:4px 0 0}.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}"
            ".m{border:1px solid var(--line);border-radius:6px;padding:10px}.ml{color:var(--muted);font-size:12px}"
            ".mv{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}.md{color:var(--muted);font-size:12px}"
            ".steps,.choices{margin:0;padding-left:18px}.st{color:var(--muted);font-size:12px}"
            ".b{display:grid;grid-template-columns:minmax(80px,30%) 1fr auto;gap:8px;align-items:center;margin:4px 0}"
            ".bt{height:8px;background:var(--soft);border-radius:4px;overflow:hidden}.bf{display:block;height:100%;background:var(--acc)}"
            ".bv{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}.tw{overflow-x:auto}"
            "table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}"
            f"</style></head><body><h1>{_e(card.get('title'))}</h1>{sub}{blocks}</body></html>")


def _place(origin: dict) -> str:
    """Where it was made, as a stable key: the session, the Pip, the chat (or the project)."""
    o = origin if isinstance(origin, dict) else {}
    return ":".join(str(o.get(k) or "") for k in ("surface", "session", "pip", "chat")) or str(o.get("project") or "")


def keep(text: str, *, origin: dict, author: str = "DGC") -> list[str]:
    """Keep each card a reply draws; returns the ids of the Pages kept (new or a new version)."""
    try:
        cards = cards_in(text)
    except Exception:                                    # noqa: BLE001 -- a reply is never lost to this
        return []
    if not cards:
        return []
    kept = []
    try:
        from .artifact_store import store
        st = store()
        place = _place(origin)
        mine = {(a.legacy.get("card_place"), a.legacy.get("card")): a for a in st.list(type="page") if a.legacy.get("card")}
        for card in cards:
            title = str(card.get("title") or "Card").strip()[:200]
            key = hashlib.sha256(f"{place}\0{title.casefold()}".encode()).hexdigest()[:24]
            content = {"index.html": page_html(card).encode("utf-8")}
            found = mine.get((place, key))
            if found is not None:
                art = st.update(found.id, content, author=author, summary="The card, drawn again")
            else:
                art = st.create("page", title, content, origin=dict(origin), author=author, summary="A card from a reply",
                                legacy={"card": key, "card_place": place})
            kept.append(art.id)
    except Exception:                                    # noqa: BLE001 -- never fails the reply that drew it
        return kept
    return kept
