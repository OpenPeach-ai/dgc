"""A checklist: the items of a job, each with what done means, a status, a note and its proof.

DGC makes one when the user asks for a job tracked ("make a checklist for X and work through it") and keeps it current
as it works: one item changed per edit, so the version history shows each step, and never the whole list rewritten.
The user ticks or reopens items and changes what done means in the checklist's panel; those are versions by "you".

The data::

    {"about": "", "pinned": true, "last": 3,
     "items": [{"id": "c1", "title": "…", "done_when": "…", "status": "Done", "note": "…",
                "proof": [{"kind": "text", "text": "pytest: 12 passed"},
                          {"kind": "image", "file": "proof/3fa9….png", "caption": "…"}],
                "by": "DGC", "at": "2026-…"}]}

``pinned``: the checklist belongs to its project's chats (``dgc.checklists``): a new chat there is told it and carries on
from the first item not done. A picture's bytes are a file of the version (``proof/<hash>.<ext>``), kept by the store
like a page's files, so every version shows the pictures it had. ``last`` is the highest item number ever given: an
item's id is never used again.
"""
from __future__ import annotations

import copy
import hashlib
import html as _html
import re
from datetime import datetime, timezone

STATUSES = ("Not started", "Building", "Testing", "Checked live", "Needs you", "Done")
DONE, NEEDS = "Done", "Needs you"
MAX_ITEMS = 200
MAX_PROOF = 12
MAX_PICTURE_BYTES = 8 * 1024 * 1024
PROOF_FOLDER = "proof/"
ITEM_ID = re.compile(r"c[1-9][0-9]{0,4}\Z")
PICTURE_FILE = re.compile(r"proof/[a-f0-9]{16,64}\.(?:png|jpg|gif|webp)\Z")

_SPELLED = {
    "not started": "Not started", "todo": "Not started", "to do": "Not started", "pending": "Not started",
    "open": "Not started", "new": "Not started",
    "building": "Building", "in progress": "Building", "doing": "Building", "started": "Building", "wip": "Building",
    "testing": "Testing", "in test": "Testing",
    "checked live": "Checked live", "checked": "Checked live", "live": "Checked live", "verified": "Checked live",
    "needs you": "Needs you", "needs user": "Needs you", "blocked": "Needs you", "waiting": "Needs you",
    "done": "Done", "complete": "Done", "completed": "Done", "finished": "Done",
}


class ChecklistError(ValueError):
    """What was asked can't be a checklist; the words say what to change."""


def status_of(value) -> str:
    text = " ".join(re.sub(r"[_\-]+", " ", str(value or "")).split()).casefold()
    if not text:
        return STATUSES[0]
    if text not in _SPELLED:
        raise ChecklistError(f"“{str(value)[:40]}” isn't a status. An item is one of: {', '.join(STATUSES)}.")
    return _SPELLED[text]


def _line(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _text(value, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip()[:limit]


def picture_kind(raw: bytes) -> str:
    """The file ending of a picture's bytes ("png", "jpg", "gif", "webp"), or "" when they aren't one."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return ""


def picture_name(raw: bytes) -> str:
    """The name a picture is kept under in a version: its own hash, so the same picture is one file."""
    kind = picture_kind(raw)
    if not kind:
        raise ChecklistError("A picture given as proof is a PNG, JPEG, GIF or WebP file.")
    if len(raw) > MAX_PICTURE_BYTES:
        raise ChecklistError(f"A picture given as proof can be at most {MAX_PICTURE_BYTES // (1024 * 1024)} MB.")
    return f"{PROOF_FOLDER}{hashlib.sha256(raw).hexdigest()[:32]}.{kind}"


def _proof(value, picture) -> list:
    """Proof as it is kept. ``picture(path)`` keeps a picture named by a path and returns its file name in the version."""
    if value is None:
        return []
    if isinstance(value, (str, dict)):
        value = [value]
    if not isinstance(value, list):
        raise ChecklistError("proof is a list: lines of text (test results), and pictures as {\"image\": \"path\"}.")
    out = []
    for entry in value:
        if isinstance(entry, str):
            if entry.strip():
                out.append({"kind": "text", "text": _text(entry, 2000)})
            continue
        if not isinstance(entry, dict):
            raise ChecklistError("Each proof is a line of text or {\"image\": \"path to a picture\"}.")
        kept = entry.get("file")
        if isinstance(kept, str) and PICTURE_FILE.fullmatch(kept):
            row = {"kind": "image", "file": kept}
        elif entry.get("image") or entry.get("path") or (entry.get("kind") == "image" and kept):
            if not callable(picture):
                raise ChecklistError("Add a picture as proof with edit_artifact, on the item it proves.")
            row = {"kind": "image", "file": picture(str(entry.get("image") or entry.get("path") or kept))}
        elif str(entry.get("text") or "").strip():
            out.append({"kind": "text", "text": _text(entry["text"], 2000)})
            continue
        else:
            raise ChecklistError("Each proof is a line of text or {\"image\": \"path to a picture\"}.")
        caption = _line(entry.get("caption"), 200)
        if caption:
            row["caption"] = caption
        out.append(row)
    if len(out) > MAX_PROOF:
        raise ChecklistError(f"An item holds at most {MAX_PROOF} pieces of proof.")
    return out


def normalize(data, *, picture=None) -> dict:
    """A checklist as it is kept, checked: what the model or the checklist's panel gave, made whole."""
    if isinstance(data, list):
        data = {"items": data}
    if not isinstance(data, dict):
        raise ChecklistError("A checklist is {\"items\": [{\"title\": \"…\", \"done_when\": \"…\"}]}.")
    rows = data.get("items")
    if not isinstance(rows, list) or not rows:
        raise ChecklistError("A checklist needs its items: {\"items\": [{\"title\": \"…\", \"done_when\": \"…\"}]}.")
    if len(rows) > MAX_ITEMS:
        raise ChecklistError(f"A checklist holds at most {MAX_ITEMS} items.")
    last = data.get("last")
    last = last if isinstance(last, int) and not isinstance(last, bool) and 0 <= last < 100_000 else 0
    given = [str(r.get("id")) for r in rows if isinstance(r, dict) and ITEM_ID.fullmatch(str(r.get("id") or ""))]
    last = max([last, *(int(i[1:]) for i in given)])
    items, seen = [], set()
    for row in rows:
        if isinstance(row, str):
            row = {"title": row}
        if not isinstance(row, dict):
            raise ChecklistError("Each item is {\"title\": \"…\", \"done_when\": \"…\"}.")
        title = _line(row.get("title"), 200)
        if not title:
            raise ChecklistError("Each item needs a title.")
        ident = str(row.get("id") or "")
        if not ITEM_ID.fullmatch(ident) or ident in seen:
            last += 1
            ident = f"c{last}"
        seen.add(ident)
        item = {"id": ident, "title": title,
                "done_when": _text(row.get("done_when") if row.get("done_when") is not None else row.get("done"), 1000),
                "status": status_of(row.get("status")), "note": _text(row.get("note"), 4000),
                "proof": _proof(row.get("proof"), picture)}
        by, at = _line(row.get("by"), 60), _line(row.get("at"), 40)
        if by:
            item["by"] = by
        if at:
            item["at"] = at
        items.append(item)
    return {"about": _text(data.get("about"), 2000), "pinned": bool(data.get("pinned", False)), "last": last,
            "items": items}


def pictures_in(data) -> set:
    """The picture files a checklist's proof names."""
    return {p["file"] for item in (data or {}).get("items") or [] for p in item.get("proof") or []
            if p.get("kind") == "image" and p.get("file")}


def find_item(data: dict, ref) -> dict:
    """An item by its id ("c2"), its place in the list (2) or its title."""
    items = data.get("items") or []
    if isinstance(ref, bool) or ref is None or ref == "":
        raise ChecklistError("Say which item: its id (c2), its number in the list, or its title.")
    if isinstance(ref, int) or (isinstance(ref, str) and ref.strip().isdigit()):
        place = int(ref)
        if 1 <= place <= len(items):
            return items[place - 1]
        raise ChecklistError(f"There is no item {place}: the checklist has {len(items)}.")
    text = " ".join(str(ref).split()).casefold()
    for item in items:
        if item["id"] == text:
            return item
    named = [item for item in items if item["title"].casefold() == text]
    if len(named) != 1:
        named = [item for item in items if text in item["title"].casefold()]
    if len(named) == 1:
        return named[0]
    have = ", ".join(f"{i['id']} “{i['title'][:40]}”" for i in items[:12])
    raise ChecklistError(f"No one item is “{str(ref)[:60]}”. The items: {have}.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_SET_FIELDS = ("status", "note", "done_when", "title", "proof")


def apply_edits(data: dict, edits, *, author: str = "DGC", picture=None, now: str | None = None) -> dict:
    """The checklist after ``edits``: one item's status, note, proof or done-when; an item added, removed or moved;
    pinned or not. Anyone but the user changes one item a call, gives a note and proof with Done, and says why with
    Needs you."""
    if not isinstance(edits, list) or not edits or not all(isinstance(e, dict) for e in edits):
        raise ChecklistError("edits is a list like [{\"op\": \"set\", \"item\": \"c2\", \"status\": \"Building\"}].")
    out = normalize(copy.deepcopy(data))
    strict = str(author or "").casefold() != "you"
    stamp = now or _now()
    touched: list[str] = []
    for edit in edits:
        op = str(edit.get("op") or ("set" if edit.get("item") is not None else "")).strip().lower()
        if op in ("set", "update", "status", "tick", "done"):
            item = find_item(out, edit.get("item"))
            if item["id"] not in touched:
                touched.append(item["id"])
            if strict and len(touched) > 1:
                raise ChecklistError(
                    f"One item at a time: this call changes {touched[0]} and {touched[1]}. Change {touched[0]} now, "
                    f"then call edit_artifact again for {touched[1]}: each change is its own line in the history.")
            if not any(edit.get(k) is not None for k in _SET_FIELDS) and op not in ("tick", "done"):
                raise ChecklistError("Say what to set on the item: status, note, proof, done_when or title.")
            if edit.get("title") is not None:
                title = _line(edit["title"], 200)
                if not title:
                    raise ChecklistError("An item's title can't be empty.")
                item["title"] = title
            if edit.get("done_when") is not None:
                item["done_when"] = _text(edit["done_when"], 1000)
            if edit.get("note") is not None:
                item["note"] = _text(edit["note"], 4000)
            if edit.get("proof") is not None:
                added = _proof(edit["proof"], picture)
                item["proof"] = added if edit.get("replace_proof") is True else [
                    *item["proof"], *(p for p in added if p not in item["proof"])]
                if len(item["proof"]) > MAX_PROOF:
                    raise ChecklistError(f"An item holds at most {MAX_PROOF} pieces of proof.")
            wanted = edit.get("status") if edit.get("status") is not None else (DONE if op in ("tick", "done") else None)
            if wanted is not None:
                status = status_of(wanted)
                if strict and status == DONE:
                    if not str(edit.get("note") or "").strip() and not item["note"]:
                        raise ChecklistError(
                            f"{item['id']} isn't marked Done yet: say what you did in note, and give its proof. Like "
                            "{\"op\": \"set\", \"item\": \"" + item["id"] + "\", \"status\": \"Done\", \"note\": \"what "
                            "you did\", \"proof\": [\"the test results\", {\"image\": \"path/to/screenshot.png\"}]}.")
                    if not item["proof"]:
                        raise ChecklistError(
                            f"{item['id']} isn't marked Done yet: give its proof, the evidence that what done means is "
                            "true (the test results as a line of text, a screenshot as {\"image\": \"path\"}).")
                if strict and status == NEEDS and not str(edit.get("note") or "").strip():
                    raise ChecklistError(f"{item['id']} isn't marked Needs you yet: say in note what you need from the "
                                         "user and why you can't go on without it.")
                if status != item["status"]:
                    item["status"], item["by"], item["at"] = status, _line(author, 60) or "DGC", stamp
        elif op == "add":
            if len(out["items"]) >= MAX_ITEMS:
                raise ChecklistError(f"A checklist holds at most {MAX_ITEMS} items.")
            title = _line(edit.get("title"), 200)
            if not title:
                raise ChecklistError("A new item needs a title.")
            out["last"] += 1
            item = {"id": f"c{out['last']}", "title": title, "done_when": _text(edit.get("done_when"), 1000),
                    "status": status_of(edit.get("status")), "note": _text(edit.get("note"), 4000), "proof": []}
            if strict and item["status"] in (DONE, NEEDS):
                raise ChecklistError("Add the item first; mark it with its own edit, with its note and proof.")
            place = len(out["items"])
            if edit.get("after") is not None:
                place = out["items"].index(find_item(out, edit["after"])) + 1
            elif edit.get("before") is not None:
                place = out["items"].index(find_item(out, edit["before"]))
            out["items"].insert(place, item)
        elif op in ("remove", "delete"):
            item = find_item(out, edit.get("item"))
            if len(out["items"]) == 1:
                raise ChecklistError("A checklist keeps at least one item.")
            out["items"].remove(item)
        elif op == "move":
            item = find_item(out, edit.get("item"))
            to = edit.get("to")
            if isinstance(to, bool) or not isinstance(to, int) or not 1 <= to <= len(out["items"]):
                raise ChecklistError(f"move needs to: the item's new place, 1 to {len(out['items'])}.")
            out["items"].remove(item)
            out["items"].insert(to - 1, item)
        elif op in ("pin", "unpin"):
            out["pinned"] = False if op == "unpin" else edit.get("pinned") is not False
        elif op == "about":
            out["about"] = _text(edit.get("text"), 2000)
        else:
            raise ChecklistError("A checklist edit's op is set (one item's status, note, proof, done_when or title), "
                                 "add, remove, move, pin or about.")
    return out


def _name(item: dict) -> str:
    return f"{item['id']} “{item['title'][:60]}”"


def describe(before: dict | None, after: dict) -> list[str]:
    """What changed between two versions, a line each: what the history says, and what DGC is told the user changed."""
    old = {i["id"]: i for i in (before or {}).get("items") or []}
    new = {i["id"]: i for i in after.get("items") or []}
    lines = []
    for ident, item in new.items():
        was = old.get(ident)
        if was is None:
            if before is not None:
                lines.append(f"Added {_name(item)}")
            continue
        if was["title"] != item["title"]:
            lines.append(f"{ident} renamed “{item['title'][:60]}”")
        if was["status"] != item["status"]:
            lines.append(f"{_name(item)}: {was['status']} → {item['status']}")
        if was.get("done_when", "") != item.get("done_when", ""):
            lines.append(f"{_name(item)}: done when is now “{item['done_when'][:140]}”" if item.get("done_when")
                         else f"{_name(item)}: done when removed")
        if was["status"] == item["status"]:
            if was.get("note", "") != item.get("note", ""):
                lines.append(f"{_name(item)}: note “{item['note'][:100]}”" if item.get("note")
                             else f"{_name(item)}: note removed")
            if was.get("proof") != item.get("proof"):
                lines.append(f"{_name(item)}: proof {'added' if len(item.get('proof') or []) > len(was.get('proof') or []) else 'changed'}")
    for ident, item in old.items():
        if ident not in new:
            lines.append(f"Removed {_name(item)}")
    kept = [i for i in old if i in new]
    if kept != [i for i in new if i in old]:
        lines.append("Items reordered")
    if before is not None and bool(before.get("pinned")) != bool(after.get("pinned")):
        lines.append("Pinned to the project" if after.get("pinned") else "Unpinned from the project")
    if before is not None and (before.get("about") or "") != (after.get("about") or ""):
        lines.append("Description changed")
    return lines


def changed_items(before: dict | None, after: dict) -> set:
    """The ids of the items that differ between two versions (in anything but who and when)."""
    def bare(item):
        return {k: v for k, v in item.items() if k not in ("by", "at")}
    old = {i["id"]: bare(i) for i in (before or {}).get("items") or []}
    new = {i["id"]: bare(i) for i in after.get("items") or []}
    return {ident for ident in old.keys() | new.keys() if old.get(ident) != new.get(ident)}


def progress(data: dict) -> dict:
    """How far along it is: for the views, Work's list and a goal that runs from it."""
    items = (data or {}).get("items") or []
    left = [i for i in items if i["status"] != DONE]
    nxt = left[0] if left else None
    waiting = [i for i in items if i["status"] == NEEDS]
    out = {"done": len(items) - len(left), "total": len(items),
           "needs": [i["id"] for i in waiting],
           "next": {"id": nxt["id"], "title": nxt["title"], "status": nxt["status"]} if nxt else None,
           "pinned": bool((data or {}).get("pinned"))}
    if waiting:
        out["waiting"] = {"id": waiting[0]["id"], "title": waiting[0]["title"]}     # the first item that needs the user
    return out


def _proof_words(item: dict) -> str:
    parts = []
    for p in item.get("proof") or []:
        if p.get("kind") == "image":
            parts.append("picture" + (f" ({p['caption']})" if p.get("caption") else ""))
        else:
            parts.append(" ".join(str(p.get("text") or "").split())[:160])
    return " · ".join(parts)


HOW = ("Change one item per call: edit_artifact(id, edits=[{\"op\": \"set\", \"item\": \"c2\", \"status\": \"Done\", "
       "\"note\": \"what you did\", \"proof\": [\"the test results\", {\"image\": \"path/to/screenshot.png\"}]}]). "
       f"Statuses: {', '.join(STATUSES)}. Mark an item Building when you start it; Done only when what its “done when” "
       "says is true and you have proved it; Needs you (with why, in note) when only the user can unblock it.")


def standing(data: dict) -> str:
    """One line on where it stands and what is next."""
    p = progress(data)
    items = {i["id"]: i for i in data.get("items") or []}
    line = f"{p['done']} of {p['total']} done"
    if p["needs"]:
        waiting = items[p["needs"][0]]
        line += f". Needs you: {_name(waiting)}" + (f": {waiting['note'][:200]}" if waiting.get("note") else "")
    if p["next"] is None:
        return line + ". Every item is Done."
    nxt = items[p["next"]["id"]]
    return (line + f". Next: {_name(nxt)}" + (f" (done when: {nxt['done_when'][:240]})" if nxt.get("done_when") else "")
            + ".")


def outline(data: dict) -> str:
    """What the model reads of it: each item with its status, what done means, its note and proof; then what is next."""
    p = progress(data)
    lines = [f"{p['done']} of {p['total']} done" + (" · pinned to this project" if p["pinned"] else "")]
    if data.get("about"):
        lines.append(data["about"])
    for item in data.get("items") or []:
        lines.append(f"{item['id']} [{item['status']}] {item['title']}")
        if item.get("done_when"):
            lines.append("   done when: " + " ".join(item["done_when"].split()))
        if item.get("note"):
            lines.append("   note: " + " ".join(item["note"].split())[:600])
        if item.get("proof"):
            lines.append("   proof: " + _proof_words(item)[:600])
        if item.get("by") and item["status"] != STATUSES[0]:
            lines.append(f"   set by: {item['by']}")
    lines.append(standing(data).split(". ", 1)[1] if ". " in standing(data) else "")
    lines.append(HOW)
    return "\n".join(line for line in lines if line)


def export_md(data: dict, title: str) -> str:
    """The checklist as Markdown: a task list, each item with what done means, its note and its proof in words."""
    p = progress(data)
    out = [f"# {title}", "", f"{p['done']} of {p['total']} done", ""]
    if data.get("about"):
        out += [data["about"], ""]
    for item in data.get("items") or []:
        out.append(f"- [{'x' if item['status'] == DONE else ' '}] **{item['title']}** ({item['status']})")
        if item.get("done_when"):
            out.append(f"  - Done when: {' '.join(item['done_when'].split())}")
        if item.get("note"):
            out.append(f"  - Note: {' '.join(item['note'].split())}")
        for proof in item.get("proof") or []:
            if proof.get("kind") == "image":
                out.append(f"  - Proof: a picture{(' (' + proof['caption'] + ')') if proof.get('caption') else ''}")
            else:
                out.append(f"  - Proof: {' '.join(str(proof.get('text') or '').split())}")
    return "\n".join(out) + "\n"


# DGC's page of a checklist (Open in browser, a download as HTML or PDF): no script, both themes. The panel in the
# editor draws the same look from the data (media/artifactChecklist.js).
_CSS = """
:root{color-scheme:light;--bg:#f6f5f2;--card:#fdfdfc;--ink:#161614;--ink2:#4f4e4a;--muted:#6b6a66;--line:#e4e3de;
--soft:#efeeea;--accent:#6747df;--good:#0b7a0b;--good-bg:#e4f3e4;--warn:#8a5300;--warn-bg:#fdf3e1;--info:#1d5fb8;
--info-bg:#e6effb;--bad:#c42b2b;--bad-bg:#fbe9e7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0f0f0e;--card:#1a1a19;
--ink:#f0efec;--ink2:#c9c8be;--muted:#a3a198;--line:#2c2c2a;--soft:#232321;--accent:#9b85ff;--good:#5bcb8b;
--good-bg:#16291d;--warn:#f2c46d;--warn-bg:#2e2615;--info:#7fb2f5;--info-bg:#152234;--bad:#ff8077;--bad-bg:#331a18}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0f0f0e;--card:#1a1a19;--ink:#f0efec;--ink2:#c9c8be;--muted:#a3a198;
--line:#2c2c2a;--soft:#232321;--accent:#9b85ff;--good:#5bcb8b;--good-bg:#16291d;--warn:#f2c46d;--warn-bg:#2e2615;
--info:#7fb2f5;--info-bg:#152234;--bad:#ff8077;--bad-bg:#331a18}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,
"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.015em;margin:0 0 6px;text-wrap:balance}
.about{color:var(--ink2);margin:0 0 12px;white-space:pre-wrap}
.sum{display:flex;align-items:center;gap:12px;margin:10px 0 18px;color:var(--ink2);font-size:13px}
.bar{flex:1;height:6px;border-radius:3px;background:var(--soft);overflow:hidden}
.bar i{display:block;height:100%;background:var(--good);border-radius:3px}
ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}
li{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px 14px;min-width:0}
.top{display:flex;align-items:flex-start;gap:10px}
.box{flex:none;width:16px;height:16px;margin-top:2px;border:1.5px solid var(--muted);border-radius:4px;
display:grid;place-items:center;font-size:11px;line-height:1;color:transparent}
li[data-status="Done"] .box{background:var(--good);border-color:var(--good);color:var(--card)}
.title{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
li[data-status="Done"] .title{color:var(--ink2)}
.chip{flex:none;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;font-size:12px;
font-weight:600;white-space:nowrap;background:var(--soft);color:var(--ink2)}
.chip[data-status="Building"],.chip[data-status="Testing"]{background:var(--info-bg);color:var(--info)}
.chip[data-status="Checked live"],.chip[data-status="Done"]{background:var(--good-bg);color:var(--good)}
.chip[data-status="Needs you"]{background:var(--warn-bg);color:var(--warn)}
.row{margin:6px 0 0 26px;color:var(--ink2);overflow-wrap:anywhere;white-space:pre-wrap}
.row b{font-weight:600;color:var(--muted);font-size:12px;margin-right:6px}
.proof{margin:8px 0 0 26px;display:grid;gap:6px}
.proof pre{margin:0;padding:8px 10px;border-radius:6px;background:var(--soft);font:12px/1.45 ui-monospace,"SF Mono",
Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.pics{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0;max-width:100%}
figure img{display:block;max-width:100%;max-height:360px;border:1px solid var(--line);border-radius:6px}
figcaption{font-size:12px;color:var(--muted);margin-top:3px}
.who{margin:6px 0 0 26px;font-size:12px;color:var(--muted)}
@media (max-width:420px){.top{flex-wrap:wrap}.chip{margin-left:26px}.title{flex-basis:calc(100% - 26px)}}
"""


def render_html(data: dict, *, title: str = "Checklist", pictures: dict | None = None) -> str:
    """One page of it. ``pictures``: each proof picture's file name to a data: address of its bytes."""
    e = _html.escape
    p = progress(data)
    pictures = pictures or {}
    share = round(100 * p["done"] / p["total"]) if p["total"] else 0
    rows = []
    for item in data.get("items") or []:
        bits = [f'<div class="top"><span class="box" aria-hidden="true">✓</span><span class="title">{e(item["title"])}</span>'
                f'<span class="chip" data-status="{e(item["status"])}">{e(item["status"])}</span></div>']
        if item.get("done_when"):
            bits.append(f'<div class="row"><b>Done when</b>{e(item["done_when"])}</div>')
        if item.get("note"):
            bits.append(f'<div class="row"><b>Note</b>{e(item["note"])}</div>')
        texts = [x for x in item.get("proof") or [] if x.get("kind") != "image"]
        shots = [x for x in item.get("proof") or [] if x.get("kind") == "image" and pictures.get(x.get("file"))]
        if texts or shots:
            proof = "".join(f"<pre>{e(str(x.get('text') or ''))}</pre>" for x in texts)
            if shots:
                proof += '<div class="pics">' + "".join(
                    f'<figure><img alt="{e(x.get("caption") or "Proof for " + item["title"])}" '
                    f'src="{e(pictures[x["file"]])}">'
                    + (f'<figcaption>{e(x["caption"])}</figcaption>' if x.get("caption") else "") + "</figure>"
                    for x in shots) + "</div>"
            bits.append(f'<div class="proof" aria-label="Proof">{proof}</div>')
        if item.get("by") and item["status"] != STATUSES[0]:
            bits.append(f'<div class="who">{e(item["status"])} by {e("you" if item["by"].casefold() == "you" else item["by"])}</div>')
        rows.append(f'<li data-item="{e(item["id"])}" data-status="{e(item["status"])}">{"".join(bits)}</li>')
    about = f'<p class="about">{e(data["about"])}</p>' if data.get("about") else ""
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{e(title)}</title><style>{_CSS}</style></head><body><main><h1>{e(title)}</h1>{about}"
            f'<div class="sum"><span>{p["done"]} of {p["total"]} done</span>'
            f'<span class="bar" role="img" aria-label="{share}% done"><i style="width:{share}%"></i></span></div>'
            f'<ol>{"".join(rows)}</ol></main></body></html>')
