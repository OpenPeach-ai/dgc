"""The model's two artifact tools, the same in a chat and in a Work session: make_artifact and edit_artifact.

The model hands over what an artifact says (a document's Markdown, a page's HTML, a deck's, a sheet's or a
dashboard's data) and DGC keeps it as a versioned artifact (dgc/artifact_service), shows it as a card the user opens,
and lays it out the same way every time. edit_artifact with nothing to change reads it back, so the model can change
what the user changed since.

The Output chip (``OUTPUT_LINES``) asks for one kind of artifact for the next reply: the line goes into the turn's
instructions, and ``made_kind`` tells the caller afterwards whether that kind was made, so a reply that didn't make
it says so under it rather than quietly doing something else.
"""
from __future__ import annotations

import json

from . import artifact_service as service

_TYPES = ["doc", "slides", "sheet", "dashboard", "page", "checklist", "design"]

MAKE_ARTIFACT = {"type": "function", "function": {
    "name": "make_artifact",
    "description": (
        "Make an artifact the user keeps and opens beside the conversation, with every version kept: a doc "
        "(a document in Markdown), slides (a deck), a sheet (a spreadsheet), a dashboard (charts over data the user "
        "allows), a page (one HTML page), a checklist (the items of a job, each with what done means and a status, "
        "which you keep current as you work and the user ticks too) or a design (a canvas of artboards: screens, a "
        "landing page at desktop and phone sizes, a poster, a clickable prototype; you name the artboards first, then "
        "draw them one at a time while the user watches; asked to design something, make a design rather than files "
        "in the project; a design's page is what the user calls the Canvas, so \"show it in the Canvas\" or \"on the "
        "canvas\" asks for a design). Use it when they ask for one of these, or when "
        "what they want is plainly one (a report to keep editing, a deck to present, a budget, a small tool; \"make a "
        "checklist for X and work through it\"). DGC keeps it in its own store: it "
        "needs no file, and nothing is written to the project, so it is the way to make a page that isn't part of the "
        "project (a summary of mail, a one-off report). It shows as a card under your "
        "reply: say in a sentence or two what's in it; don't paste it into your reply. To change it later, use "
        "edit_artifact, not a new one. Names are unique per kind: when the user may mean one they already have (made "
        "here or in another conversation), look with find_artifacts and change that one; make a second one only when "
        "they want both kept, under a name that says how it differs."),
    "parameters": {"type": "object", "properties": {
        "type": {"type": "string", "enum": _TYPES},
        "title": {"type": "string", "description": "A short title, as the user would name it."},
        "content": {"type": "string", "description": (
            "doc: the whole text in Markdown (# title, ## headings, lists, tables, **bold**, links). "
            "page: the whole HTML page, self-contained (no remote scripts, styles or images).")},
        "data": {"type": "object", "description": (
            "slides: {\"theme\": \"paper|dusk|bold|plain\", \"slides\": [{\"layout\": \"title|section|bullets|"
            "two_columns|image|chart|quote|table|closing\", \"title\", \"subtitle\", \"bullets\": [\"…\"], "
            "\"left\"/\"right\": {\"heading\", \"bullets\"}, \"chart\": {\"type\": \"bar|line|area|pie|scatter\", "
            "\"x\": […], \"series\": [{\"name\", \"values\"}], \"unit\"}, \"quote\": {\"text\", \"by\"}, \"table\": "
            "{\"columns\": […], \"rows\": [[…]]}, \"notes\"}]}. Keep a slide to about 6 short bullets. "
            "sheet: {\"sheets\": [{\"name\", \"columns\": [{\"name\", \"type\": \"text|number|currency|percent|date|"
            "bool\"}], \"rows\": [[value or \"=SUM(B2:B9)\"]]}]}. "
            "dashboard: {\"sources\": [{\"id\", \"kind\": \"file|sqlite|postgres|plugin\", \"path\"?, \"server\"?}], "
            "\"widgets\": [{\"id\", \"kind\": \"number|chart|table\", \"title\", \"source\", \"query\": \"SELECT …\", "
            "\"chart\"?: {\"type\", \"x\": \"<column>\", \"series\": [\"<column>\"]}, \"value\"?: \"<column>\"}]}; "
            "queries are read-only SELECTs, and the user allows each source once. "
            "checklist: {\"items\": [{\"title\": \"a short name for the step\", \"done_when\": \"what must be true, "
            "and checkable, for it to be done\"}]} (every item starts Not started; it is pinned to this project, so a "
            "later chat carries on from it). "
            "design: {\"artboards\": [{\"title\": \"Desktop\", \"size\": \"desktop\"}, {\"title\": \"Phone\", \"size\": "
            "\"phone\"}]} with size one of phone (390x844), tablet, desktop (1440x900), wide, square, story, poster, or "
            "page (a whole web page, as tall as it is); or w and h in px. Give no HTML here: this makes the named, empty "
            "frames, and DGC places them. Then draw each with edit_artifact, one artboard per call.")}},
        "required": ["type", "title"]}}}

EDIT_ARTIFACT = {"type": "function", "function": {
    "name": "edit_artifact",
    "description": (
        "Change an artifact you or the user made, by its id (ar_…): the whole new content or data, or exact edits. "
        "Each change is a new version; the user can go back to any. Called with only the id, it returns the "
        "artifact as it is now, with the user's own changes: read it before changing something the user may have "
        "edited."),
    "parameters": {"type": "object", "properties": {
        "id": {"type": "string"},
        "edits": {"type": "array", "items": {"type": "object"}, "description": (
            "doc: [{\"find\": exact text, \"replace\": new text}]. slides: [{\"op\": \"replace|insert|delete|move|"
            "set|theme\", \"slide\": n, …}]. sheet: [{\"op\": \"set\", \"cell\": \"B4\", \"value\": …}, {\"op\": "
            "\"insert_rows\" …}]. dashboard: [{\"op\": \"add_widget|change_widget|remove_widget|…\", …}]. "
            "checklist (always by edits, ONE item per call): [{\"op\": \"set\", \"item\": \"c2\", \"status\": \"Not "
            "started|Building|Testing|Checked live|Needs you|Done\", \"note\": \"what you did, or what you need\", "
            "\"proof\": [\"test results as text\", {\"image\": \"path/to/screenshot.png\", \"caption\"}]}]; Done needs "
            "note and proof, Needs you needs note; also {\"op\": \"add\", \"title\", \"done_when\"}, {\"op\": "
            "\"remove|move|pin\", …}. "
            "design (always by edits, one artboard per call): [{\"op\": \"change\", \"board\": \"b1\", \"html\": \"<!doctype "
            "html>…\"}] draws or redraws one artboard; {\"op\": \"change\", \"board\", \"edits\": [{\"find\", \"replace\"}]} "
            "changes exact text in it; {\"op\": \"read\", \"board\"} returns its HTML. An artboard is one self-contained "
            "HTML page that fills its frame: styles in a <style> tag, pictures as inline SVG, CSS or data: addresses, "
            "nothing loaded from the web; real copy for the user's subject, never filler text; real buttons, links and "
            "labelled fields; at phone widths columns stack and text stays readable. To make an element open another "
            "artboard give it data-goto=\"<that artboard's title>\" (no script needed); behaviour of its own goes in a "
            "<script> tag with addEventListener and runs when the user plays it. Values the user may want to change "
            "can be declared with \"tweaks\": [{\"name\": \"accent\", \"label\": \"Accent colour\", \"type\": \"color|size|"
            "switch|choice\", \"value\": \"#b5651d\"}] and read in its CSS as var(--accent). Also {\"op\": \"add\", \"title\", "
            "\"size\"} (DGC places it in a free spot), {\"op\": \"move\", \"board\", \"x\", \"y\"}, {\"op\": \"resize\", "
            "\"board\", \"w\", \"h\"}, {\"op\": \"rename|duplicate|remove\", \"board\", …}, {\"op\": \"tweak\", \"board\", "
            "\"name\", \"value\"}, {\"op\": \"note_add\", \"kind\": \"title|sticky\", \"text\", \"over\": \"b1\"}, {\"op\": "
            "\"note_change|note_remove\", \"note\"}, {\"op\": \"page_add|page_rename\", …}. The user moves and edits "
            "artboards too: read the design (only its id) before placing or changing anything they may have touched. The "
            "user watches the canvas as you draw: don't render, screenshot or open the design in a browser to check "
            "it unless they ask.")},
        "content": {"type": "string", "description": "doc or page: the whole new text or HTML."},
        "data": {"type": "object", "description": "slides, sheet or dashboard: the whole new data."},
        "note": {"type": "string", "description": "What changed, in a few words (shown in the version history)."},
        "title": {"type": "string", "description": (
            "A new name, to rename it (alone, or with a change). No other artifact of its kind may have it.")}},
        "required": ["id"]}}}

FIND_ARTIFACTS = {"type": "function", "function": {
    "name": "find_artifacts",
    "description": (
        "Find the user's artifacts (docs, decks, sheets, dashboards, pages, checklists, designs) by words from their names, newest first, "
        "each with its id: before making one they may already have, and to change one made in another conversation "
        "with edit_artifact. With no words, the most recent ones. Changes nothing."),
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "Words from its name."},
        "type": {"type": "string", "enum": _TYPES}},
        "required": []}}}

TOOLS = [MAKE_ARTIFACT, EDIT_ARTIFACT, FIND_ARTIFACTS]
NAMES = frozenset({"make_artifact", "edit_artifact", "find_artifacts"})
FIND_LIMIT = 20

# The Output chip's line for the turn. Kept short: small local models follow one plain sentence best.
OUTPUT_LINES = {
    "document": "The user chose Document for this reply: make it a doc with make_artifact (type doc), then say "
                "briefly what's in it.",
    "slides": "The user chose Slides for this reply: make one deck with make_artifact (type slides), then say "
              "briefly what's in it.",
    "spreadsheet": "The user chose Spreadsheet for this reply: make it a sheet with make_artifact (type sheet), "
                   "then say briefly what's in it.",
    "page": "The user chose Page for this reply: make one self-contained HTML page with make_artifact (type page), "
            "then say briefly what it does.",
    "dashboard": "The user chose Dashboard for this reply: make one with make_artifact (type dashboard) over the "
                 "data they mean, then say briefly what it shows.",
    "checklist": "The user chose Checklist for this reply: make one with make_artifact (type checklist), its items "
                 "the steps of the job, then say briefly what's on it.",
    "design": "The user chose Design for this reply: make one with make_artifact (type design), its artboards the "
              "screens they mean, then say briefly what you drew.",
}
OUTPUT_TYPES = {"document": "doc", "slides": "slides", "spreadsheet": "sheet", "page": "page",
                "dashboard": "dashboard", "checklist": "checklist", "design": "design"}


def output_line(output) -> str:
    return OUTPUT_LINES.get(str(output or ""), "")


def missing_note(output, made_types) -> str:
    """What to say under a reply that didn't make what the Output chip asked for ("" when it did, or for Auto)."""
    wanted = OUTPUT_TYPES.get(str(output or ""))
    if not wanted or wanted in set(made_types or ()):
        return ""
    label = service.LABELS[wanted].lower()
    noun = label if wanted == "slides" else f"a {label}"
    return (f"The model didn't make {noun}. Try again, or pick another model for this "
            "reply.")


def _summary(view: dict, op: str) -> str:
    verb = {"made": "Made", "changed": "Changed"}.get(op, op.title())
    if view.get("type") == "checklist":
        return _checklist_summary(view, verb)
    if view.get("type") == "design":
        return _design_summary(view, verb)
    return (f"{verb} {view['label']} “{view['title']}” ({view['id']}, version {view['version']}). It shows as a card "
            "the user opens; don't repeat its content in your reply.")


def _checklist_summary(view: dict, verb: str) -> str:
    """What the model reads after making or changing a checklist: what the history now says, where it stands and the
    next item, so it carries on without reading the list again."""
    from . import artifact_checklist as checklist
    from .artifact_store import store
    head = f"{verb} Checklist “{view['title']}” ({view['id']}, version {view['version']})"
    try:
        data = store().source(view["id"], view["version"])
    except Exception:                                     # noqa: BLE001 -- made, even if it can't be read back here
        return head + "."
    last = (view.get("versions") or [{}])[-1].get("summary") or ""
    said = f": {last}" if verb == "Changed" and last else ""
    tail = (" It shows as a card the user opens and ticks too, pinned to this project. Keep it current as you work: "
            "mark an item Building when you start it, and Done (with a note and its proof) when what its “done when” "
            "says is true, one item per edit_artifact call." if verb == "Made" else "")
    return f"{head}{said}. {checklist.standing(data)}{tail}"


def _design_summary(view: dict, verb: str, told: str = "") -> str:
    """What the model reads after making or changing a design: what the history now says and what is still to draw,
    so it draws the next artboard without reading the canvas again."""
    from . import artifact_design as design
    from .artifact_store import store
    head = f"{verb} Design “{view['title']}” ({view['id']}, version {view['version']})"
    try:
        index = store().source(view["id"], view["version"])
    except Exception:                                     # noqa: BLE001 -- made, even if it can't be read back here
        return head + "."
    last = (view.get("versions") or [{}])[-1].get("summary") or ""
    said = f": {last}" if verb == "Changed" and last else ""
    tail = (" It shows as a card; opened, it is a canvas the user watches fill as you draw, and they can move, edit "
            "and comment on every artboard." if verb == "Made" else "")
    return f"{head}{said}.{f' {told}' if told else ''} {design.standing(index)}{tail}"


def _design_edit(aid: str, args: dict, *, author: str, on_change, title) -> str:
    """edit_artifact on a design: each op is its own version, said to the screens as it is made, so the canvas fills
    while the turn runs. A read op changes nothing."""
    from . import artifact_design as design
    from .artifact_store import store
    edits = args.get("edits")
    if args.get("data") is not None or args.get("content") is not None or not isinstance(edits, list) or not edits:
        # (Refused by the service, in the words that say how.)
        service.edit(aid, edits=None, content=args.get("data") if args.get("data") is not None else args.get("content") or {},
                     author=author)
    reads = [e for e in edits if isinstance(e, dict) and str(e.get("op") or "").strip().lower() == "read"]
    if reads:
        index = store().source(aid)
        files = service._design_files(store(), aid)
        out = "\n\n".join(design.read_board(index, files, e.get("board")) for e in reads)
        if len(reads) == len(edits):
            return out + "\n\n(You only read it: nothing has changed.)"
        edits = [e for e in edits if e not in reads]
    note = str(args.get("note") or "")
    view, told = None, []
    for i, op in enumerate(edits):
        try:
            more = service.design_told(aid, op, author=author)
            view = service.edit(aid, edits=[op], author=author, note=note,
                                title=title if i == len(edits) - 1 else None)
        except service.ArtifactUseError as exc:
            if view is None:
                raise
            # (What was made before it stays made; the model is told which op failed and why.)
            return (_design_summary(view, "Changed", " ".join(told)) + f"\nerror in edit {i + 1}: {exc} "
                    "The edits before it were made; the rest were not.")
        if more and not design.BOARD_ID.fullmatch(more):
            told.append(more)
        elif more and str(op.get("op") or "").strip().lower() in ("add", "duplicate"):
            told.append(f"The new artboard is {more}.")
        if callable(on_change):
            try:
                on_change(view, "changed")
            except Exception:                                 # noqa: BLE001 -- a screen never fails the call
                pass
    return _design_summary(view, "Changed", " ".join(told))


def _checklist_guard(aid: str, args: dict, reader: str) -> tuple[str, str]:
    """Before a checklist changes: what the user changed since this chat last read it. Returns (refusal, note): a
    refusal when the call would change an item the user changed meanwhile (the model reads theirs first), else the note
    its result carries."""
    from . import artifact_checklist as checklist
    from . import checklists
    from .artifact_store import store
    last = checklists.seen(reader, aid)
    version = service.view(aid, versions=False)["version"]
    if last is None or last >= version:
        return "", ""
    lines, theirs, only_user = checklists.since(aid, last)
    checklists.mark(reader, aid, version)
    if not lines:
        return "", ""
    words = checklists.changed_words(lines, only_user)
    if theirs:
        data = store().source(aid, version)
        for edit in args.get("edits") or []:
            if not isinstance(edit, dict) or edit.get("item") is None:
                continue
            try:
                item = checklist.find_item(data, edit.get("item"))
            except ValueError:
                continue
            if item["id"] in theirs:
                return (f"error: nothing changed. {words} Your call would change {item['id']}, which the user just "
                        f"changed (it is {item['status']} now). {checklist.standing(data)} Decide again from that."), ""
    return "", words


def _when(stamp) -> str:
    """'changed 3 days ago' style words for an ISO time, or ''."""
    from datetime import datetime, timezone
    try:
        then = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        mins = max(0, int((datetime.now(timezone.utc) - then).total_seconds() // 60))
    except (TypeError, ValueError):
        return ""
    if mins < 60:
        return "changed just now" if mins < 2 else f"changed {mins} minutes ago"
    if mins < 48 * 60:
        return f"changed {mins // 60} hour{'s' if mins // 60 != 1 else ''} ago"
    return f"changed {mins // 1440} days ago"


def _maker(view: dict) -> str:
    m = view.get("made_by") or {}
    where = {"session": "in Work", "chat": "in a chat", "pip": "by a Pip", "app": "by an app", "cli": "in the terminal"}
    words = where.get(m.get("kind"), "")
    return f"{words} ({m['name']})" if words and m.get("name") else words


def _line(view: dict) -> str:
    bits = [f"{view['id']} · {view['label']} “{view['title']}” · version {view['version']}", _when(view.get("updated")),
            _maker(view)]
    return " · ".join(b for b in bits if b)


def taken_words(existing: dict, op: str, mine=None) -> str:
    label = str(existing.get("label") or "artifact").lower()
    if callable(mine) and not mine(existing):
        # (Not the caller's to change, and not the caller's to see: only that the name is used.)
        return (f"error: the user already has a {label} named “{existing.get('title')}”. Give yours a different name "
                "that says what it is.")
    if op == "make_artifact" and existing.get("type") == "checklist":
        p = existing.get("progress") or {}
        nxt = p.get("next") or {}
        return (f"error: this project already has a checklist named “{existing.get('title')}” ({_line(existing)}; "
                f"{p.get('done', 0)} of {p.get('total', 0)} done). Work from that one: read it with edit_artifact "
                f"(only its id) and carry on from {nxt.get('id') or 'its first item not done'}; add what's missing with "
                "{\"op\": \"add\"} edits. Make another only if the user wants a separate one, under a name that says "
                "how it differs.")
    if op == "make_artifact":
        return (f"error: there's already a {label} named “{existing.get('title')}” ({_line(existing)}). If the user "
                "means that one, change it with edit_artifact (each change is a new version they can go back to; "
                "read it first with edit_artifact and only its id). If they want another beside it, call make_artifact "
                "again with a name that says how it differs.")
    return (f"error: another {label} is already named “{existing.get('title')}” ({existing.get('id')}). Pick a name "
            "that isn't taken.")


def find(args, *, mine=None) -> str:
    """find_artifacts: the user's artifacts whose names have every word asked, newest first (only the caller's own
    when ``mine`` says which those are)."""
    words = service.same_name(args.get("query") if isinstance(args, dict) else "").split()
    type_ = str(args.get("type") or "") if isinstance(args, dict) else ""
    try:
        found = service.listing(type=type_ or None)
    except Exception as exc:                                  # noqa: BLE001 -- say why, never a crash
        return f"error: {type(exc).__name__}: {exc}"
    found = [v for v in found if all(w in service.same_name(v.get("title")) for w in words)]
    if callable(mine):
        found = [v for v in found if mine(v)]
    found.sort(key=lambda v: str(v.get("updated") or ""), reverse=True)
    if not found:
        asked = f" named with “{' '.join(words)}”" if words else ""
        return f"No artifacts{asked}{f' of type {type_}' if type_ else ''}. Try other words, or none to see the latest."
    more = len(found) - FIND_LIMIT
    lines = [_line(v) for v in found[:FIND_LIMIT]]
    return "\n".join(lines + ([f"(and {more} more: add words to narrow it)"] if more > 0 else []))


def run(name: str, args, *, origin: dict, author: str = "DGC", on_change=None, base=None, resolve=None,
        mine=None) -> str:
    """Do one call; return what the model reads back. ``on_change(view, op)`` tells the screens. ``mine(view)``: which
    artifacts the caller may change and see (a Pip: its own); None for all."""
    if not isinstance(args, dict):
        return "error: give the tool's arguments as an object."
    if name == "find_artifacts":
        return find(args, mine=mine)
    told = ""                  # what the user changed in a checklist since this chat last read it
    try:
        if name == "make_artifact":
            type_ = str(args.get("type") or "")
            spec = (args.get("data") if type_ in ("slides", "sheet", "dashboard", "checklist")
                    else {"content": args.get("content")})
            if type_ == "page":
                spec = {"html": args.get("content")}
            pending = []
            if type_ == "design":
                # The index first; any artboard given with its HTML is then drawn as its own version, one at a time.
                from . import artifact_design as design
                spec = args.get("data") if args.get("data") is not None else {"artboards": args.get("artboards")}
                try:
                    pending = design.start(spec)[1]
                except design.DesignError as exc:
                    return f"error: {exc}"
            if spec is None:
                return f"error: a {type_ or 'deck, sheet, dashboard or checklist'} needs its data."
            view = service.make(type_, args.get("title"), spec, origin=origin, author=author, base=base,
                                resolve=resolve)
            op = "made"
            if pending:
                if callable(on_change):
                    try:
                        on_change(view, op)
                    except Exception:                         # noqa: BLE001 -- a screen never fails the call
                        pass
                drawn = _design_edit(view["id"], {"edits": pending}, author=author, on_change=on_change, title=None)
                return drawn.replace("Changed Design", "Made Design", 1) if not drawn.startswith("error") else drawn
        elif name == "edit_artifact":
            aid = str(args.get("id") or "")
            # One op given as an object, or its fields beside the id, is that one change (user test round 2, D9: a
            # refused call the model then resent showed in the turn as a failure). Only where it can mean nothing else.
            if isinstance(args.get("edits"), dict):
                args = {**args, "edits": [args["edits"]]}
            elif args.get("edits") is None and args.get("data") is None and args.get("content") is None and isinstance(args.get("op"), str):
                args = {"id": aid, **({"note": args["note"]} if "note" in args else {}),
                        **({"title": args["title"]} if isinstance(args.get("title"), str) else {}),
                        "edits": [{k: v for k, v in args.items() if k not in ("id", "note", "title")}]}
            content = args.get("data") if args.get("data") is not None else args.get("content")
            title = args.get("title") if isinstance(args.get("title"), str) else None
            kind = _kind_of(aid)
            if content is None and not args.get("edits") and title is None:
                # (Read only. Said, so a model doesn't tell the user it changed something it only read.)
                if kind == "checklist":
                    from . import checklists
                    checklists.mark(checklists.reader_of(origin), aid, service.view(aid, versions=False)["version"])
                    return (service.outline(aid) + "\n\n(You only read it: nothing has changed.)")
                return (service.outline(aid) + "\n\n(You only read it: nothing has changed. To change it, call "
                        "edit_artifact again with edits or the whole new content.)")
            if kind == "checklist":
                from . import checklists
                refusal, told = _checklist_guard(aid, args, checklists.reader_of(origin))
                if refusal:
                    return refusal
            if kind == "design" and not (content is None and not args.get("edits")):
                return _design_edit(aid, args, author=author, on_change=on_change, title=title)
            if isinstance(content, str) and service.view(aid, versions=False)["type"] == "page":
                content = {"html": content}
            view = service.edit(aid, edits=args.get("edits") or None, content=content, author=author,
                                note=str(args.get("note") or ""), title=title, base=base, resolve=resolve)
            op = "changed"
        else:
            return f"error: {name} isn't an artifact tool."
    except service.ArtifactNameTaken as exc:
        return taken_words(exc.existing, name, mine)
    except service.ArtifactUseError as exc:
        return f"error: {exc}"
    except Exception as exc:                                  # noqa: BLE001 -- the store said no; say why
        return f"error: {type(exc).__name__}: {exc}"
    if callable(on_change):
        try:
            on_change(view, op)
        except Exception:                                     # noqa: BLE001 -- a screen never fails the call
            pass
    if view.get("type") == "checklist":
        from . import checklists
        checklists.mark(checklists.reader_of(origin), view["id"], view["version"])
        return _summary(view, op) + (f"\n{told}" if told else "")
    return _summary(view, op)


def _kind_of(aid: str) -> str:
    try:
        return str(service.view(aid, versions=False).get("type") or "")
    except Exception:                                         # noqa: BLE001 -- the edit itself says what is wrong
        return ""


def args_preview(args) -> str:
    """A short line for the transcript's step header."""
    if not isinstance(args, dict):
        return ""
    if args.get("query") is not None and not args.get("id") and not args.get("title"):
        return f"“{str(args.get('query') or '')[:60]}”" if args.get("query") else "the latest"
    if args.get("title") and not args.get("id"):
        return f"{args.get('type', '')} “{str(args['title'])[:60]}”".strip()
    return str(args.get("id") or "")[:40] + (f" · {str(args['note'])[:60]}" if args.get("note") else "")


def schema_json() -> str:
    return json.dumps(TOOLS)
