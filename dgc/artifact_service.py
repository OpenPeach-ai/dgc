"""Artifacts for every part of DGC: one place that makes, edits, shows, exports and serves them.

The store (``dgc.artifact_store``) keeps an artifact's versions; this module knows what each type is. The model's
``make_artifact`` and ``edit_artifact`` tools (in a chat and in Work), the screens (the Library, an artifact's card and
editor), ``dgc artifacts`` on the command line and the SDK all come through here, so an artifact made in one place
behaves the same everywhere.

The types and what each is made from:

- ``doc``: Markdown text (a canvas is one). Shown as a page, exported as Word, PDF or Markdown.
- ``slides``: a deck as data (``dgc.artifact_slides``). Exported as PowerPoint, PDF or one HTML file.
- ``sheet``: sheets of typed columns and rows, formulas allowed (``dgc.artifact_sheet``). Exported as Excel or CSV.
- ``dashboard``: sources, widgets and their read-only queries (``dgc.artifact_dashboard``). Its numbers come from
  ``refresh``, which runs the queries on this computer with no model; they are kept beside the artifact, not as
  versions, so a dashboard refreshed every hour doesn't fill its history.
- ``page``: an HTML page or small site. Work's ``artifact`` tool makes one linked to the project's files; the model
  can make one from HTML it writes. Exported as Word or PDF, as Excel when it holds a table, as HTML or a zip of its files.

- ``checklist``: the items of a job, each with what done means, a status, a note and proof (``dgc.artifact_checklist``).
  DGC changes one item per edit, so the history shows each step; the user ticks in its panel. Exported as Markdown,
  HTML or PDF. Its proof pictures are files of the version.
- ``design``: a canvas of artboards, each one self-contained HTML page (``dgc.artifact_design``). DGC makes the index
  first and draws one artboard per edit, so the canvas fills while the user watches; the user moves, resizes and edits
  them in its panel. Exported as pictures (PNG), PDF (an artboard a page) or HTML.

The model hands over data, never a file's bytes; DGC lays every artifact out the same way every time.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from . import artifact_store, workspace
from .artifact_store import ArtifactError, Store

# The Output chip's choices, and the type each makes. "auto" leaves the choice to the model.
OUTPUTS = {"auto": None, "document": "doc", "slides": "slides", "spreadsheet": "sheet", "page": "page",
           "dashboard": "dashboard", "checklist": "checklist", "design": "design"}
EXPORTS = {"doc": ("docx", "pdf", "md"), "slides": ("pptx", "pdf", "html"), "sheet": ("xlsx", "csv"),
           "dashboard": ("pdf", "html"), "page": ("docx", "pdf", "html", "zip"), "checklist": ("md", "html", "pdf"),
           # A design: png is one artboard's picture (the export names the board); zip is every artboard's picture.
           "design": ("png", "pdf", "html", "zip")}
LABELS = {"doc": "Document", "slides": "Slides", "sheet": "Spreadsheet", "dashboard": "Dashboard", "page": "Page",
          "checklist": "Checklist", "design": "Design"}
# A document holds about a megabyte of text (it was 200,000 characters): a Pip's reply past 256 KB is kept whole as its
# document (pips.keep_long_reply, Limits for everyone, 10 Nov).
MAX_DOC_CHARS = 1_048_576
MAX_PAGE_BYTES = 2 * 1024 * 1024


class ArtifactUseError(ValueError):
    """Asked for something an artifact can't do; the text says what to change, for the model or the user."""


class ArtifactNameTaken(ArtifactUseError):
    """A name another artifact of the same kind already has in the same place (place_of): a change is made to the one
    that's there (a new version) or a second one gets a name of its own. ``existing`` is that one, as view() shows it."""

    def __init__(self, existing: dict):
        self.existing = existing
        super().__init__(f"There's already a {LABELS.get(existing.get('type'), 'artifact').lower()} named "
                         f"“{existing.get('title')}”. Choose another name.")


def same_name(title) -> str:
    """A name as two names are compared: case and spacing don't make it another name."""
    return " ".join(str(title or "").split()).casefold()


def place_of(origin) -> str:
    """Where an artifact belongs, for its name: a project folder (Work's, a chat's or a Pip's folder: one place,
    whichever made it), else the chat, the Pip or the app that made it. "logo" can be in every project; within one
    place, a name is one item."""
    o = origin if isinstance(origin, dict) else {}
    project = str(o.get("project") or "")
    if project:
        try:
            project = str(Path(project).expanduser().resolve())
        except (OSError, RuntimeError, ValueError):
            pass
        return "project:" + project
    surface = str(o.get("surface") or "")
    ident = {"chat": o.get("chat"), "pip": o.get("pip"), "sdk": o.get("app"), "work": o.get("session")}.get(surface)
    return f"{surface}:{ident or ''}"


def taken(type_, title, *, place: str | None = None, except_id: str = "", store: Store | None = None) -> dict | None:
    """The artifact of this kind (not removed) already named ``title`` in ``place`` (anywhere when None), or None."""
    key = same_name(title)
    if not key:
        return None
    for art in _store(store).list(type=_type(type_)):
        if art.id != except_id and same_name(art.title) == key and (place is None or place_of(art.origin) == place):
            return view(art.id, store=store, versions=False)
    return None


def free_name(type_, title=None, *, place: str | None = None, store: Store | None = None) -> str:
    """``title`` (or the kind's own name) when no other artifact of the kind has it in ``place``, else the first free
    "<it> 2", "<it> 3"."""
    base = " ".join(str(title or "").split())[:190] or LABELS[_type(type_)]
    if taken(type_, base, place=place, store=store) is None:
        return base
    for n in range(2, 1000):
        if taken(type_, f"{base} {n}", place=place, store=store) is None:
            return f"{base} {n}"
    return base


def _store(store: Store | None) -> Store:
    return store or artifact_store.store()


def _kind(type_: str):
    """The module that knows a typed artifact's data (imported when first used)."""
    if type_ == "slides":
        from . import artifact_slides as module
    elif type_ == "sheet":
        from . import artifact_sheet as module
    elif type_ == "dashboard":
        from . import artifact_dashboard as module
    elif type_ == "checklist":
        from . import artifact_checklist as module
    elif type_ == "design":
        from . import artifact_design as module
    else:
        raise ArtifactUseError(f"{type_} has no data module")
    return module


def _type(value) -> str:
    text = str(value or "").strip().lower()
    text = {"document": "doc", "docs": "doc", "deck": "slides", "presentation": "slides", "spreadsheet": "sheet",
            "sheets": "sheet", "table": "sheet", "html": "page", "web page": "page",
            "checklists": "checklist", "check list": "checklist", "designs": "design", "canvas": "design",
            "artboards": "design", "mockup": "design"}.get(text, text)
    if text not in artifact_store.TYPES:
        raise ArtifactUseError("An artifact is a doc, slides, sheet, dashboard, page, checklist or design.")
    return text


# making and changing -----------------------------------------------------------------------------------------
def _doc_text(spec) -> str:
    text = spec.get("content") if isinstance(spec, dict) else spec
    if not isinstance(text, str) or not text.strip():
        raise ArtifactUseError("A document needs its text, as Markdown, in content.")
    if len(text) > MAX_DOC_CHARS:
        raise ArtifactUseError(f"A document holds at most {MAX_DOC_CHARS:,} characters.")
    return text


def _page_files(spec) -> tuple[dict, str]:
    if isinstance(spec, str):
        spec = {"html": spec}
    if not isinstance(spec, dict):
        raise ArtifactUseError("A page needs its HTML (html), or its files ({name: text}) and an entry.")
    files = spec.get("files") if isinstance(spec.get("files"), dict) else None
    if files is None:
        html = spec.get("html") or spec.get("content")
        if not isinstance(html, str) or not html.strip():
            raise ArtifactUseError("A page needs its HTML in html.")
        files = {"index.html": html}
    if any(isinstance(value, str) and value.lstrip().startswith('@@FILE:')
           for name, value in files.items() if str(name).lower().endswith(('.html', '.htm'))):
        raise ArtifactUseError("A file reference was sent instead of Page HTML. Read the file and send its full contents; "
                               "to change an existing Page, retry edit_artifact with the same id.")
    try:
        files = Store._encode("page", files)
    except ArtifactError as exc:
        raise ArtifactUseError(str(exc)) from None
    total = sum(len(v) for v in files.values())
    if total > MAX_PAGE_BYTES:
        raise ArtifactUseError(f"A page the model writes can be at most {MAX_PAGE_BYTES // (1024 * 1024)} MB.")
    return files, str(spec.get("entry") or ("index.html" if "index.html" in files else sorted(files)[0]))


def _content(type_: str, spec, *, base=None, resolve=None):
    """A type's content from what the model or the user gave, checked: what the store keeps."""
    try:
        if type_ == "doc":
            return _doc_text(spec)
        if type_ == "page":
            return _page_files(spec)[0]
        module = _kind(type_)
        data = spec.get("data", spec) if isinstance(spec, dict) and set(spec) == {"data"} else spec
        if type_ == "slides":
            return module.normalize(data, base=base, resolve=resolve)
        return module.normalize(data)
    except ArtifactUseError:
        raise
    except (ValueError, TypeError) as exc:            # each type's own error is a ValueError
        raise ArtifactUseError(str(exc)) from None


# A document is edited in a real file (the canvas editor opens it): a chat's canvas has one beside the chat, and
# every other doc gets one in its own folder (``<store>/<id>/work/<title>.md``). The store keeps the versions: before
# a change, the file's text is the user's version if they typed in it since; after one, the file says it too.
def _doc_file(art) -> Path | None:
    path = art.legacy.get("file") if art.type == "doc" else None
    return Path(path) if isinstance(path, str) and path else None


def _doc_snapshot(art):
    path = _doc_file(art)
    if path is None:
        return None
    try:
        return workspace.read_regular_bytes(path, maximum=artifact_store.MAX_VERSION_BYTES, missing_ok=True)
    except (OSError, ValueError) as exc:
        raise ArtifactUseError(f"The document's working file couldn't be read safely: {exc}") from None


def _theirs_first(st: Store, art):
    snapshot = _doc_snapshot(art)
    if snapshot is None:
        return None
    raw, version = snapshot
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise ArtifactUseError("The document's working file isn't UTF-8 text.") from None
    if text != st.source(art.id, art.version):
        st.update(art.id, text, author="you", summary="Your edits", base_version=art.version)
    return version


def _write_doc_file(st: Store, aid: str, *, expected=None, version: int | None = None) -> None:
    art = st.get(aid)
    path = _doc_file(art)
    if path is None:
        return
    try:
        workspace.atomic_write_bytes(path, st.source(aid, version).encode("utf-8"), expected=expected, mode=0o600)
    except (OSError, ValueError):
        raise ArtifactUseError("The document's working file changed while the edit was being saved. "
                               "Your file was kept, and the proposed edit is in Versions. Read it again before editing.") from None


def doc_for_file(path, *, store: Store | None = None) -> str:
    """The id of the document whose working file this is ("" when none): a save in the editor finds its artifact."""
    try:
        target = str(Path(path).resolve())
    except (OSError, RuntimeError):
        return ""
    for art in _store(store).list(type="doc"):
        own = _doc_file(art)
        if own is not None and str(own.resolve()) == target:
            return art.id
    return ""


def keep_users_edits(aid: str, *, store: Store | None = None) -> bool:
    """The user saved a doc's file in the editor: keep it as their version now. True when one was made."""
    st = _store(store)
    with st.edit_lock(aid):
        art = st.get(aid)
        before = art.version
        _theirs_first(st, art)
        return st.get(aid).version != before

# A checklist's proof pictures: the model names a picture file in the project; its bytes are kept as a file of the
# version (the file itself may go). The data names each by its kept name.
def _checklist_picture(base, resolve, into: dict):
    from . import artifact_checklist as checklist

    def keep(path: str) -> str:
        if not str(path or "").strip():
            raise ArtifactUseError("A picture given as proof needs its path.")
        try:
            if callable(resolve):
                found = Path(resolve(path))
            else:
                if base is None:
                    raise ArtifactUseError("There is no project folder here to read a picture from: give the proof "
                                           "as text.")
                root = Path(base).resolve()
                found = (root / str(path)).resolve()
                found.relative_to(root)
            raw, _ = workspace.read_regular_bytes(found, maximum=checklist.MAX_PICTURE_BYTES)
        except ArtifactUseError:
            raise
        except Exception as exc:                          # noqa: BLE001 -- outside the project, missing, too big
            raise ArtifactUseError(f"The picture “{str(path)[:120]}” couldn't be read as proof ({type(exc).__name__}: "
                                   f"{str(exc)[:160]}). Give a PNG, JPEG, GIF or WebP file inside the project.") from None
        try:
            name = checklist.picture_name(raw)
        except ValueError as exc:
            raise ArtifactUseError(f"“{str(path)[:120]}”: {exc}") from None
        into[name] = raw
        return name
    return keep


def _checklist_files(st: Store, aid: str, n: int | None = None) -> dict:
    """The pictures a version of a checklist holds: {file name: bytes}."""
    own = artifact_store.SOURCE_FILE["checklist"]
    return {name: raw for name, raw in st.files(aid, n).items() if name != own}


def _checklist_content(data: dict, have: dict) -> dict:
    """What the store keeps of a checklist: its data, and the pictures its proof names (no others)."""
    from . import artifact_checklist as checklist
    wanted = checklist.pictures_in(data)
    missing = sorted(wanted - have.keys())
    if missing:
        raise ArtifactUseError("The checklist names a proof picture it doesn't hold. Add pictures with an edit: "
                               "{\"op\": \"set\", \"item\": …, \"proof\": [{\"image\": \"path\"}]}.")
    return {**data, artifact_store.CHECKLIST_FILES: {name: have[name] for name in sorted(wanted)}}


def checklist_pictures(aid: str, n: int | None = None, *, store: Store | None = None) -> dict:
    """A checklist version's proof pictures as data: addresses, for the screens that draw it."""
    import base64
    kinds = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
    return {name: f"data:{kinds.get(name.rsplit('.', 1)[-1], 'image/png')};base64,{base64.b64encode(raw).decode('ascii')}"
            for name, raw in _checklist_files(_store(store), aid, n).items()}


# A design's artboards are files of the version beside its index (boards/<id>.html), kept by the store like a page's.
def _design_files(st: Store, aid: str, n: int | None = None) -> dict:
    """The artboard pages a version of a design holds: {file name: bytes}."""
    own = artifact_store.SOURCE_FILE["design"]
    return {name: raw for name, raw in st.files(aid, n).items() if name != own}


def design_boards(aid: str, n: int | None = None, *, store: Store | None = None) -> dict:
    """A design version's drawn artboards, for the panel that shows them: {board id: its HTML}."""
    from . import artifact_design as design
    st = _store(store)
    files = _design_files(st, aid, n)
    out = {}
    for board in st.source(aid, n).get("boards") or []:
        raw = files.get(design.board_file(board["id"]))
        if raw is not None:
            out[board["id"]] = raw.decode("utf-8", "replace")
    return out


def _design_heights(st: Store, aid: str) -> dict:
    """How tall each whole-page artboard was measured to be, by the panel that drew it (kept beside the versions)."""
    try:
        value = json.loads((st._dir(aid) / "design-state.json").read_text(encoding="utf-8"))
        heights = value.get("heights") if isinstance(value, dict) else None
        return {k: v for k, v in (heights or {}).items() if isinstance(k, str) and isinstance(v, int)}
    except (OSError, ValueError):
        return {}


def design_measured(aid: str, board: str, height, *, store: Store | None = None) -> None:
    """The panel measured a whole-page artboard at its width: remembered beside the versions (never a version), so a
    frame DGC adds later is placed below all of it."""
    from . import artifact_design as design
    st = _store(store)
    if isinstance(height, bool) or not isinstance(height, (int, float)) or not design.MIN_SIDE <= height <= design.MAX_H:
        raise ArtifactUseError("A measured height is a number of px.")
    with st.lock():
        art = st.get(aid)
        if art.type != "design":
            raise ArtifactUseError("Only a design's artboards are measured.")
        ids = {b["id"] for b in st.source(aid, art.version).get("boards") or []}
        if board not in ids:
            raise ArtifactUseError("That artboard isn't in the design.")
        heights = {k: v for k, v in _design_heights(st, aid).items() if k in ids}
        heights[board] = int(height)
        st._write_json(st._dir(aid) / "design-state.json", {"heights": heights})


def _design_edit(st: Store, art, *, edits, content, author: str, note: str) -> tuple[dict, str]:
    """A design's next version and the line the history says of it: the ops given, applied in order. Never the whole
    design rewritten."""
    from . import artifact_design as design
    if content is not None or not isinstance(edits, list) or not edits:
        raise ArtifactUseError(
            "A design is changed one artboard at a time, never rewritten: use edits, like [{\"op\": \"change\", "
            "\"board\": \"b1\", \"html\": \"<!doctype html>…\"}] to draw or redraw one artboard, or {\"op\": \"add\", "
            "\"title\": …, \"size\": …} for a new one.")
    index, files = st.source(art.id, art.version), _design_files(st, art.id, art.version)
    heights = _design_heights(st, art.id)
    by_user, said = str(author or "").casefold() == "you", []
    try:
        index = design.normalize(index)
        for op in edits:
            if by_user and note and isinstance(op, dict) and op.get("op") == "change" and not op.get("note"):
                op = {**op, "note": note}                     # (what the person did there: "Edited text")
            index, files, line, _told = design.apply(index, files, op, author=author, heights=heights)
            said.append(line)
        index = design.normalize(index)
    except design.DesignError as exc:
        raise ArtifactUseError(str(exc)) from None
    line = "; ".join(said)
    if note.startswith("From a comment"):
        line = f"From a comment: {line}"
    return {**index, artifact_store.CHECKLIST_FILES: files}, (line[:artifact_store.MAX_SUMMARY] or note or "Changed")


def design_told(aid: str, op, *, author: str = "DGC", store: Store | None = None) -> str:
    """What one op would tell the model besides its summary (where a frame landed, a link that names no artboard),
    read from the design as it is: asked before the op is made."""
    from . import artifact_design as design
    st = _store(store)
    try:
        art = st.get(aid)
        index = design.normalize(st.source(aid, art.version))
        return design.apply(index, _design_files(st, aid, art.version), op, author=author,
                            heights=_design_heights(st, aid))[3]
    except (design.DesignError, ArtifactError, KeyError):
        return ""


def make(type_, title, spec, *, origin: dict, author: str = "DGC", summary: str = "Made", store: Store | None = None,
         base=None, resolve=None) -> dict:
    """A new artifact. ``origin`` names where (``{"surface": "chat", "chat": …}``, ``{"surface": "work", …}``, …)."""
    from .chatdgc import made
    type_ = _type(type_)
    if type_ == "checklist":
        # Pinned to its project from the start (a new chat there carries on from it), unless the maker says not.
        from . import artifact_checklist as checklist
        given_spec = spec.get("data", spec) if isinstance(spec, dict) and set(spec) == {"data"} else spec
        if isinstance(given_spec, list):
            given_spec = {"items": given_spec}
        if isinstance(given_spec, dict) and "pinned" not in given_spec:
            given_spec = {**given_spec, "pinned": bool((origin or {}).get("project"))}
        pictures: dict = {}
        try:
            content = _checklist_content(
                checklist.normalize(given_spec, picture=_checklist_picture(base, resolve, pictures)), pictures)
        except checklist.ChecklistError as exc:
            raise ArtifactUseError(str(exc)) from None
    elif type_ == "design":
        # The index first: every artboard a named frame waiting to be drawn (each is then drawn as its own version).
        from . import artifact_design as design
        given_spec = spec.get("data", spec) if isinstance(spec, dict) and set(spec) == {"data"} else spec
        try:
            content = {**design.start(given_spec)[0], artifact_store.CHECKLIST_FILES: {}}
        except design.DesignError as exc:
            raise ArtifactUseError(str(exc)) from None
    else:
        content = _content(type_, spec, base=base, resolve=resolve)
    entry = _page_files(spec)[1] if type_ == "page" else ""
    st = _store(store)
    # Names are unique per kind: a name that's taken is refused (the caller changes that one, or names this one apart);
    # with no name at all, it gets the kind's own, numbered past the ones there are.
    if type_ == "design":
        from . import artifact_design as design
        title = design.plain(title)                        # (a model's “&amp;” in a name is “&”)
    given, place = " ".join(str(title or "").split()), place_of(origin)
    if given:
        clash = taken(type_, given, place=place, store=store)
        if clash is not None:
            raise ArtifactNameTaken(clash)
    name = given or free_name(type_, place=place, store=store)
    try:
        art = st.create(type_, name, content, origin=origin, author=author,
                        summary=summary, entry=entry)
        if type_ == "doc":
            st.set_meta(art.id, legacy={"file": str(st._dir(art.id) / "work" / made.file_name(art.title, "md"))})
            _write_doc_file(st, art.id)
    except ArtifactError as exc:
        raise ArtifactUseError(str(exc)) from None
    return view(art.id, store=store)


def edit(aid: str, *, edits=None, content=None, author: str = "DGC", note: str = "", base_version: int | None = None,
         title: str | None = None, store: Store | None = None, base=None, resolve=None) -> dict:
    """A new version: the whole new content, or edits to the current one (a doc's [{find, replace}], a deck's,
    a sheet's or a dashboard's own ops). Nothing is written if the artifact moved on since ``base_version``."""
    st = _store(store)
    with st.edit_lock(aid):
        try:
            art = st.get(aid)
        except ArtifactError as exc:
            raise ArtifactUseError(str(exc)) from None
        if title is not None and art.type == "design":
            from . import artifact_design as design
            title = design.plain(title)
        renaming = title is not None and same_name(title) != same_name(art.title)
        if title is not None and not same_name(title):
            raise ArtifactUseError("A name can't be empty.")
        if renaming:
            clash = taken(art.type, title, place=place_of(art.origin), except_id=aid, store=store)
            if clash is not None:
                raise ArtifactNameTaken(clash)
        only_name = content is None and edits is None
        if only_name and title is None:
            raise ArtifactUseError("Give content (the whole new artifact) or edits.")
        expected = None
        if art.type == "doc":
            if author != "you":
                expected = _theirs_first(st, art)
                art = st.get(aid)
            else:
                snapshot = _doc_snapshot(art)
                expected = snapshot[1] if snapshot else None
        if only_name:
            # Only a new name: the same content as it's kept, as a new version that says so.
            new = st.files(aid, art.version) if art.type == "page" else st.source(aid, art.version)
            if art.type == "checklist":
                new = {**new, artifact_store.CHECKLIST_FILES: _checklist_files(st, aid, art.version)}
            if art.type == "design":
                new = {**new, artifact_store.CHECKLIST_FILES: _design_files(st, aid, art.version)}
            note = note or "Renamed"
        elif art.type == "checklist":
            new, note = _checklist_edit(st, art, edits=edits, content=content, author=author, note=note, base=base,
                                        resolve=resolve)
        elif art.type == "design":
            new, note = _design_edit(st, art, edits=edits, content=content, author=author, note=note)
        elif content is not None:
            new = _content(art.type, content, base=base, resolve=resolve)
        elif art.type == "doc":
            from .chatdgc.canvas import CanvasError, apply_edits
            try:
                new = _doc_text(apply_edits(st.source(aid, art.version), edits))
            except CanvasError as exc:
                raise ArtifactUseError(str(exc)) from None
        elif art.type == "page":
            raise ArtifactUseError("Change a page by giving its whole new HTML (or files) as content.")
        else:
            module = _kind(art.type)
            try:
                changed = (module.apply_edits(st.source(aid, art.version), edits, base=base, resolve=resolve) if art.type == "slides"
                           else module.apply_edits(st.source(aid, art.version), edits))
            except (ValueError, TypeError) as exc:
                raise ArtifactUseError(str(exc)) from None
            new = _content(art.type, changed, base=base, resolve=resolve)
        entry = _page_files(content)[1] if art.type == "page" and content is not None else None
        try:
            changed = st.update(aid, new, author=author, summary=note or "Changed",
                                base_version=art.version if base_version is None else base_version, title=title, entry=entry)
            _write_doc_file(st, aid, expected=expected, version=changed.version)
        except ArtifactError as exc:
            raise ArtifactUseError(str(exc)) from None
        return view(aid, store=store)

def _checklist_edit(st: Store, art, *, edits, content, author: str, note: str, base, resolve) -> tuple[dict, str]:
    """A checklist's next version and the line the history says of it. DGC (and a Pip) change one item per call with
    edits; the user's panel hands back the list with their change. The history's line is what changed, item by item."""
    from . import artifact_checklist as checklist
    current = st.source(art.id, art.version)
    have = _checklist_files(st, art.id, art.version)
    by_user = str(author or "").casefold() == "you"
    try:
        if content is not None:
            if not by_user:
                raise ArtifactUseError(
                    "A checklist is changed one item at a time, never rewritten: use edits, like [{\"op\": \"set\", "
                    "\"item\": \"c2\", \"status\": \"Done\", \"note\": \"what you did\", \"proof\": [\"the test "
                    "results\"]}] (one item per call), or {\"op\": \"add\", \"title\": …, \"done_when\": …} for a new item.")
            given = content.get("data", content) if isinstance(content, dict) and set(content) == {"data"} else content
            if isinstance(given, dict):
                given = {key: value for key, value in given.items() if key != artifact_store.CHECKLIST_FILES}
                given.setdefault("pinned", bool(current.get("pinned")))
                given.setdefault("last", current.get("last", 0))
            data = checklist.normalize(given)
            before = {item["id"]: item for item in current.get("items") or []}
            stamp = checklist._now()
            for item in data["items"]:
                was = before.get(item["id"])
                if was is not None and was["status"] != item["status"]:
                    item["by"], item["at"] = "you", stamp
        else:
            data = checklist.apply_edits(current, edits, author=author,
                                         picture=_checklist_picture(base, resolve, have))
    except checklist.ChecklistError as exc:
        raise ArtifactUseError(str(exc)) from None
    said = "; ".join(checklist.describe(current, data))
    return _checklist_content(data, have), (said[:artifact_store.MAX_SUMMARY] or note or "Changed")


def restore(aid: str, n: int, *, author: str = "you", store: Store | None = None) -> dict:
    st = _store(store)
    with st.edit_lock(aid):
        try:
            expected = _theirs_first(st, st.get(aid))
            changed = st.restore(aid, int(n), author=author)
            _write_doc_file(st, aid, expected=expected, version=changed.version)
        except (ArtifactError, ValueError) as exc:
            raise ArtifactUseError(str(exc)) from None
        return view(aid, store=store)

def remove(aid: str, *, store: Store | None = None) -> None:
    try:
        _store(store).remove(aid)
    except ArtifactError as exc:
        raise ArtifactUseError(str(exc)) from None


# reading ------------------------------------------------------------------------------------------------------
def compare(aid: str, before: int, after: int | None = None, *, store: Store | None = None) -> dict:
    """Read-only changes between two saved versions, with explicit limits for large artifacts."""
    from .artifact_compare import compare as compare_versions
    try:
        return compare_versions(_store(store), aid, before, after)
    except ArtifactError as exc:
        raise ArtifactUseError(str(exc)) from None


# Which versions of a page hold a table of data, so listing pages reads each one once.
_PAGE_TABLES: dict[tuple[str, int], bool] = {}


def _page_has_table(art, st) -> bool:
    key = (art.id, art.version)
    if key not in _PAGE_TABLES:
        from . import artifact_page_export as page_export
        if len(_PAGE_TABLES) > 512:
            _PAGE_TABLES.clear()
        try:
            files, entry = render(art.id, art.version, store=st)
            _PAGE_TABLES[key] = page_export.has_table(files[entry].decode("utf-8", "replace"))
        except Exception:          # noqa: BLE001 - a menu entry fewer, never a failed listing
            return False
    return _PAGE_TABLES[key]


def _exports(art, st) -> list[str]:
    """What this artifact downloads as, its most useful first. A page with a table of data is a workbook too."""
    out = list(EXPORTS[art.type])
    if art.type == "design":
        out.remove("png")                        # (one artboard's picture: asked from the artboard, never the whole)
    if art.type == "page" and _page_has_table(art, st):
        out.insert(2, "xlsx")
    return out


def made_by(origin: dict, resolve=None) -> dict:
    """Who made it, by name (decided 15 Nov: the Library says exactly who made each item, one click back to it): a
    Pip, a Work session, a chat, an app, the terminal. ``resolve(kind, id)`` gives the name ("" when unknown)."""
    o = origin if isinstance(origin, dict) else {}
    surface = str(o.get("surface") or "")
    kind, ident = {"pip": ("pip", o.get("pip")), "work": ("session", o.get("session")), "chat": ("chat", o.get("chat")),
                   "sdk": ("app", o.get("app")), "cli": ("cli", "")}.get(surface, (surface or "unknown", ""))
    ident = str(ident or "")
    name = ""
    if ident and callable(resolve):
        try:
            name = str(resolve(kind, ident) or "")[:120]
        except Exception:                                  # noqa: BLE001 -- a name is a courtesy, never a failure
            name = ""
    return {"kind": kind, "id": ident, "name": name}


_NAMES: dict = {}


def maker_name(kind: str, ident: str) -> str:
    """The name of what made an artifact, read from DGC's own records and kept for this process: a Pip's, a Work
    session's, a chat's title."""
    key = (kind, ident)
    if key in _NAMES:
        return _NAMES[key]
    name = ""
    try:
        if kind == "pip":
            from .pips import PipStore
            from .workspace_registry import WorkspaceRegistry
            with WorkspaceRegistry() as registry:
                name = str(PipStore(registry).get(ident).get("name") or "")
        elif kind == "session":
            from . import sessions
            for path in sessions.SESSIONS_DIR.rglob(f"{ident}.json") if hasattr(sessions, "SESSIONS_DIR") else []:
                import json as _json
                name = str((_json.loads(path.read_text(encoding="utf-8")) or {}).get("name") or "")
                break
        elif kind == "chat":
            from .chatdgc.store import ChatStore
            name = str((ChatStore().get(ident) or {}).get("title") or "")
    except Exception:                                      # noqa: BLE001 -- unknown: the Library says the kind only
        name = ""
    if len(_NAMES) > 2000:
        _NAMES.clear()
    _NAMES[key] = name
    return name


def view(aid: str, *, store: Store | None = None, versions: bool = True) -> dict:
    """An artifact as the screens, the CLI and the SDK show it."""
    st = _store(store)
    art = st.get(aid)
    out = {"id": art.id, "type": art.type, "label": LABELS[art.type], "title": art.title, "version": art.version,
           "created": art.created, "updated": art.updated, "origin": dict(art.origin),
           "made_by": made_by(art.origin, maker_name),
           # What made it, for the Library's Widgets filter: a dgc-ui card a reply drew (artifact_cards), a ChatDGC widget
           # (artifact_index), or "" for anything else.
           "made_as": "card" if art.legacy.get("card") else "widget" if art.legacy.get("widget") else "",
           "exports": _exports(art, st)}
    if art.link:
        out["link"] = dict(art.link)
    if art.legacy.get("canvas"):
        out["canvas"] = art.legacy["canvas"]
    if _doc_file(art) is not None:
        out["file"] = str(_doc_file(art))              # the file the editor opens
    if art.type == "dashboard":
        out["allowed_sources"] = list(art.sources)     # the sources the user allowed (allow_source), by id
    if art.type == "checklist":
        # How far along it is ({done, total, needs: [ids], next: {id, title, status} | None, pinned}): its card, the
        # Library and Work's list say it without reading the list.
        try:
            out["progress"] = _kind("checklist").progress(st.source(aid, art.version))
        except Exception:                                  # noqa: BLE001 -- unreadable data: shown without it
            pass
    if art.type == "design":
        # How many artboards it has and how many are still to draw ({boards, drawing, pages}): its card says it.
        try:
            out["design"] = _kind("design").counts(st.source(aid, art.version))
        except Exception:                                  # noqa: BLE001 -- unreadable data: shown without it
            pass
    # Its comment threads, counted ({open, all}; dgc/artifact_comments): the Library row and the panel say how many.
    from .artifact_comments import counts
    said = counts(aid, store=st)
    if said:
        out["comments"] = said
    if versions:
        out["versions"] = [{"n": v.n, "author": v.author, "at": v.at, "summary": v.summary, "size": v.size}
                           for v in st.versions(aid)]
    return out


def listing(*, type: str | None = None, surface: str | None = None, store: Store | None = None) -> list[dict]:
    if store is None:                   # what was made before the store (old pages, widgets, made sheets) comes in
        from . import artifact_index
        artifact_index.index()
    return [view(a.id, store=store, versions=False) for a in _store(store).list(type=type, surface=surface)]


def outline(aid: str, *, store: Store | None = None, limit: int = 12_000) -> str:
    """What the model reads of an artifact before changing it: a doc's text, a deck's outline, a sheet's or a
    dashboard's data, a page's start file."""
    st = _store(store)
    art = st.get(aid)
    head = f"{LABELS[art.type]} “{art.title}” ({art.id}, version {art.version})\n"
    if art.type == "doc":
        body = st.source(aid)
    elif art.type == "page":
        try:
            body = st.read_file(aid, art.entry or "index.html").decode("utf-8", "replace")
        except FileNotFoundError:
            body = ""
    elif art.type == "design":
        sizes = {bid: len(page) for bid, page in design_boards(aid, store=st).items()}
        body = _kind("design").outline(st.source(aid), sizes)
    else:
        module = _kind(art.type)
        data = st.source(aid)
        body = module.outline(data) if hasattr(module, "outline") else json.dumps(data, ensure_ascii=False, indent=1)
    if len(body) > limit:
        body = body[:limit] + f"\n… ({len(body) - limit:,} more characters)"
    return head + body


# showing and exporting --------------------------------------------------------------------------------------
_DOC_STYLE = """
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1d1c21;--muted:#6d6a75;--rule:#e6e3ea;--accent:#6747df;--code:#f2f0f5}
@media (prefers-color-scheme:dark){:root{--bg:#141317;--fg:#ecebef;--muted:#a19dab;--rule:#2b2930;--accent:#9b85ff;
--code:#1e1c23}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--fg);
font:17px/1.65 ui-serif,Georgia,'Iowan Old Style',serif;padding:56px 20px 96px}
main{max-width:720px;margin:0 auto}h1,h2,h3,h4{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
line-height:1.2;letter-spacing:-.01em;text-wrap:balance}h1{font-size:2.1em;margin:0 0 .6em}h2{font-size:1.45em;
margin:1.8em 0 .5em}h3{font-size:1.15em;margin:1.5em 0 .4em}a{color:var(--accent)}code{font:.88em ui-monospace,
'SF Mono',Menlo,monospace;background:var(--code);padding:.1em .35em;border-radius:4px}pre{background:var(--code);
padding:14px 16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}blockquote{margin:1.2em 0;
padding:0 1em;border-left:3px solid var(--accent);color:var(--muted)}table{border-collapse:collapse;width:100%;
font:14px/1.45 system-ui,sans-serif;margin:1.2em 0;display:block;overflow-x:auto}th,td{border-bottom:1px solid
var(--rule);padding:8px 10px;text-align:left}th{font-weight:600}hr{border:0;border-top:1px solid var(--rule);
margin:2em 0}img{max-width:100%}
"""


def doc_html(title: str, markdown: str) -> str:
    """A document as one quiet page: Markdown through markdown-it with raw HTML off, so the text can't add script."""
    from markdown_it import MarkdownIt
    import html as _html
    body = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table").enable("strikethrough") \
        .render(markdown)
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{_html.escape(title)}</title><style>{_DOC_STYLE}</style></head>"
            f"<body><main>{body}</main></body></html>")


def state(aid: str, *, store: Store | None = None, version: int | None = None) -> dict:
    """What an artifact keeps beside its versions: a dashboard's last refresh."""
    st = _store(store)
    version = st.get(aid).version if version is None else version
    path = st._dir(aid) / "state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and value.get("version") == version else {}
    except (OSError, ValueError):
        return {}


def _put_state(aid: str, value: dict, store: Store | None = None) -> None:
    st = _store(store)
    with st.lock():
        st._write_json(st._dir(aid) / "state.json", value)


def render(aid: str, n: int | None = None, *, mode: str = "view", store: Store | None = None) -> tuple[dict, str]:
    """The files that show a version: ({name: bytes}, entry). A page is its own files; every other type is one
    HTML page DGC lays out."""
    st = _store(store)
    art = st.get(aid)
    n = art.version if n is None else n
    if art.type == "page":
        return st.files(aid, n), st.version(aid, n).entry
    if art.type == "doc":
        html = doc_html(art.title, st.source(aid, n))
    elif art.type == "slides":
        html = _kind("slides").render_html(st.source(aid, n), mode=mode, title=art.title)
    elif art.type == "sheet":
        html = _kind("sheet").render_html(st.source(aid, n))
    elif art.type == "checklist":
        html = _kind("checklist").render_html(st.source(aid, n), title=art.title,
                                              pictures=checklist_pictures(aid, n, store=st))
    elif art.type == "design":
        html = _kind("design").render_html(st.source(aid, n), _design_files(st, aid, n), title=art.title)
    else:
        saved = state(aid, store=store, version=n)
        source = st.source(aid, n)
        results = dict(saved.get("results") or {})
        for widget in source.get("widgets") or []:
            if widget.get("source") not in art.sources:
                results[widget["id"]] = {"blocked": widget["source"]}
        html = _kind("dashboard").render_html(source, results, title=art.title)
    return {"index.html": html.encode("utf-8")}, "index.html"


# An export's own folder is kept this long: every caller copies its file at once, so older ones are removed.
EXPORT_KEEP_SECONDS = 3600


def _sweep_exports(folder: Path) -> None:
    """Remove export folders older than EXPORT_KEEP_SECONDS, so repeated exports don't pile up in the store."""
    cutoff = time.time() - EXPORT_KEEP_SECONDS
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return
    for entry in entries:
        try:
            if (entry.name.startswith("export-") and entry.is_dir(follow_symlinks=False)
                    and entry.stat(follow_symlinks=False).st_mtime < cutoff):
                shutil.rmtree(entry.path, ignore_errors=True)
        except OSError:
            continue


def export(aid: str, fmt: str, *, n: int | None = None, config=None, browser=None, store: Store | None = None,
           board: str | None = None) -> Path:
    """The artifact as a file, written to its exports folder; returns the path. ``board``: one artboard of a design
    (its picture, its PDF, its page) rather than the whole canvas."""
    from .chatdgc import made
    st = _store(store)
    art = st.get(aid)
    fmt = str(fmt or "").lower().lstrip(".")
    fmt = {"word": "docx", "powerpoint": "pptx", "excel": "xlsx", "markdown": "md"}.get(fmt, fmt)
    if fmt not in EXPORTS[art.type] and not (art.type == "page" and fmt == "xlsx"):
        raise ArtifactUseError(f"A {LABELS[art.type].lower()} exports as {', '.join(EXPORTS[art.type])}.")
    n = art.version if n is None else n
    # Each request owns its bytes until its caller copies them, even if another window exports
    # the same title and format meanwhile. The directory is private and the path is handed out
    # only after a complete write; failed exports leave no partial copy behind.
    _sweep_exports(st.export_dir(aid))
    folder = Path(tempfile.mkdtemp(prefix="export-", dir=st.export_dir(aid)))
    target = folder / made.file_name(art.title, fmt)
    try:
        if board and art.type != "design":
            raise ArtifactUseError("Only a design has artboards to download one by one.")
        if art.type == "design":
            target = _design_export(st, art, fmt, n, board, folder, config, browser)
        elif art.type == "doc":
            out = made.make({"name": art.title, "format": fmt, "content": st.source(aid, n)}, config, browser=browser)
            target.write_bytes(out.raw)
        elif art.type == "slides":
            module, deck = _kind("slides"), st.source(aid, n)
            if fmt == "pptx":
                target.write_bytes(module.export_pptx(deck, title=art.title))
            elif fmt == "pdf":
                module.export_pdf(deck, target, browser, config=config, title=art.title)
            else:
                target.write_text(module.render_html(deck, mode="present", title=art.title), encoding="utf-8")
        elif art.type == "sheet":
            module, sheet = _kind("sheet"), st.source(aid, n)
            if fmt == "xlsx":
                target.write_bytes(module.export_xlsx(sheet))
            else:
                first = (sheet.get("sheets") or [{}])[0].get("name", "")
                target.write_text(module.export_csv(sheet, first), encoding="utf-8-sig")
        elif art.type == "checklist":
            if fmt == "md":
                target.write_text(_kind("checklist").export_md(st.source(aid, n), art.title), encoding="utf-8")
            else:
                page = render(aid, n, store=store)[0]["index.html"]
                if fmt == "pdf":
                    try:
                        page = made._print(page.decode("utf-8"), config, browser)
                    except Exception as exc:
                        raise ArtifactUseError(f"The checklist PDF couldn't be printed: {made._why_plain(exc)} "
                                               "Set up Chrome or Edge with `dgc doctor`, or download it as Markdown.") from None
                target.write_bytes(page)
        elif art.type == "dashboard":
            page = render(aid, n, store=store)[0]["index.html"]
            if fmt == "pdf":
                try:
                    raw = made._print(page.decode("utf-8"), config, browser)
                except Exception as exc:
                    raise ArtifactUseError(f"The dashboard PDF couldn't be printed: {made._why_plain(exc)} "
                                           "Set up Chrome or Edge with `dgc doctor`, then export again.") from None
                target.write_bytes(raw)
            else:
                target.write_bytes(page)
        else:
            files, entry = render(aid, n, store=store)
            if fmt == "html":
                target.write_bytes(files[entry])
            elif fmt in ("docx", "pdf", "xlsx"):
                target.write_bytes(_page_file(art.title, fmt, files, entry, config, browser))
            else:
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                    for name, data in sorted(files.items()):
                        zf.writestr(name, data)
                target.write_bytes(buffer.getvalue())
        os.chmod(target, 0o600)
        return target
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def _design_export(st: Store, art, fmt: str, n: int, board, folder: Path, config, browser) -> Path:
    """A design as a file in ``folder``: one artboard (its page, its picture, its PDF) or the canvas (DGC's page of it,
    every artboard's picture in a zip, a PDF with an artboard a page). Pictures and PDFs are made by a browser."""
    from . import artifact_design as design
    from .chatdgc import made
    index, files = st.source(art.id, n), _design_files(st, art.id, n)
    try:
        one = design.find_board(index, board) if board else None
        name = f"{art.title} - {one['title']}" if one else art.title
        target = folder / made.file_name(name, fmt)
        if fmt == "html":
            target.write_text(design.standalone(index, files, one["id"])[1] if one
                              else design.render_html(index, files, title=art.title), encoding="utf-8")
            return target
        if fmt == "png" and one is None:
            raise ArtifactUseError("A picture is of one artboard: choose it on the canvas, or download every artboard "
                                   "as pictures (the zip).")
        if fmt == "zip" and one is not None:
            raise ArtifactUseError("The zip holds every artboard's picture; for one artboard download its PNG.")
        try:
            if fmt == "pdf":
                target.write_bytes(design.pdf(index, files, one and one["id"], config=config, browser=browser))
                return target
            shots = design.pictures(index, files, one and one["id"], config=config, browser=browser)
        except design.DesignError:
            raise
        except Exception as exc:                           # noqa: BLE001 -- no browser, or it wouldn't draw it
            raise ArtifactUseError(f"The design's {'PDF' if fmt == 'pdf' else 'pictures'} couldn't be made: "
                                   f"{made._why_plain(exc)} Set up Chrome or Edge with `dgc doctor`, or download it "
                                   "as a web page.") from None
        if fmt == "png":
            target.write_bytes(shots[0][1])
            return target
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, (shown, raw) in enumerate(shots, 1):
                zf.writestr(made.file_name(f"{i} {shown['title']}", "png"), raw)
        target.write_bytes(buffer.getvalue())
        return target
    except design.DesignError as exc:
        raise ArtifactUseError(str(exc)) from None


def _page_file(title: str, fmt: str, files: dict, entry: str, config, browser) -> bytes:
    """A page as Word, PDF or Excel. A PDF is the page as the browser prints it, with its look and pictures; Word and Excel
    hold what it says. A page that writes itself with script is read after it has run."""
    from . import artifact_page_export as page_export
    from .chatdgc import made
    html = files[entry].decode("utf-8", "replace")
    if fmt == "pdf":
        try:
            return made._print(html, config, browser, files=files, entry=entry)
        except Exception:      # noqa: BLE001 - no browser, or it wouldn't print: its words, with the built-in writer
            pass
    page = page_export.read(html)
    if not page_export.has_words(page) and "<script" in html.lower():
        try:
            page = page_export.read(made.page_after_scripts(html, config, browser, files=files, entry=entry))
        except Exception:      # noqa: BLE001 - said just below
            pass
    if not page_export.has_words(page):
        raise ArtifactUseError("This page has no text DGC can read: it draws itself. "
                               + ("Set up Chrome or Edge with `dgc doctor`, then download it as PDF."
                                  if fmt == "pdf" else "Download it as PDF instead."))
    if fmt == "pdf":
        return made.plain_pdf(title, page.blocks)[0]
    if fmt == "docx":
        return made.docx(title, page.blocks)
    tables = page_export.sheets(page)
    if not tables:
        raise ArtifactUseError("This page has no table to put in a workbook. Download it as Word or PDF instead.")
    return made.xlsx(page_export.workbook(made._sheets({"sheets": tables})))


def refresh(aid: str, *, project_root=None, call=None, is_read_only=None, store: Store | None = None) -> dict:
    """Run a dashboard's queries now, on this computer, with no model; keep the numbers beside it."""
    st = _store(store)
    with st.lock():
        art = st.get(aid)
        if art.type != "dashboard":
            raise ArtifactUseError("Only a dashboard refreshes.")
        source = st.source(aid, art.version)
    results = _kind("dashboard").refresh(source, allowed=list(art.sources), project_root=project_root,
                                         call=call, is_read_only=is_read_only)
    _put_state(aid, {"results": results, "version": art.version}, store)
    return results


def allow_source(aid: str, source_id: str, allowed: bool = True, *, store: Store | None = None,
                 base_version: int | None = None) -> dict:
    """The user allows (or stops allowing) one of a dashboard's sources: asked once per dashboard."""
    st = _store(store)
    try:
        st.allow_source(aid, source_id, allowed, base_version=base_version)
    except ArtifactError as exc:
        raise ArtifactUseError(str(exc)) from None
    return view(aid, store=store)


PRESENT_FILE = "present.html"


def write_view(aid: str, files: dict, *, store: Store | None = None) -> Path:
    """Publish rendered files for both CLI and served previews without competing writers."""
    st = _store(store)
    with st.edit_lock(aid):
        folder = st._dir(aid) / "view"
        fresh = Path(tempfile.mkdtemp(prefix=".view-", dir=st._dir(aid)))
        try:
            for name, data in files.items():
                target = fresh / artifact_store.safe_rel(name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            if folder.exists():
                shutil.rmtree(folder)
            os.replace(fresh, folder)
        finally:
            if fresh.exists():
                shutil.rmtree(fresh, ignore_errors=True)
    return folder


def serve(aid: str, *, mode: str = "view", store: Store | None = None) -> str:
    """Show an artifact in the browser at an address of its own: its current version is written to its view folder
    (``<store>/<id>/view``) and served from there by the artifact server, with every rule that server applies.
    A Work page linked to a project is served from the project, as published. A deck's folder holds its present mode
    too (present.html: a slide at a time, arrow keys, F for full screen); ``mode="present"`` is its address."""
    from . import artifacts
    if mode not in ("view", "present"):
        raise ArtifactUseError('mode is "view" or "present".')
    st = _store(store)
    art = st.get(aid)
    if mode == "present" and art.type != "slides":
        raise ArtifactUseError("Only slides have a present mode.")
    if art.link.get("path") and Path(art.link["path"]).is_dir():
        served = next((a for a in artifacts.registry() if a.store_id == aid), None)
        if served is not None:
            return served.page_url
    files, entry = render(aid, store=store)
    if art.type == "slides":
        # The view links its present mode (an alternate, unseen), so the artifact server, which serves a folder's start
        # page and only what that page links, serves present.html too.
        view_html = files[entry].replace(b"</head>", f'<link rel="alternate" href="{PRESENT_FILE}" title="Present">'
                                         "</head>".encode(), 1)
        files = {entry: view_html, PRESENT_FILE: render(aid, mode="present", store=store)[0][entry]}
    folder = write_view(aid, files, store=st)
    served = artifacts.add(entry, folder, art.title)
    if served.store_id != aid:
        # Marked as this artifact's own view, and saved at once: a served folder without its mark would be taken for a
        # page of its own by the next listing (artifact_index), in this process or another.
        with artifacts._SRV.lock:
            served.store_id = aid
            artifacts._SRV._save()
    url = served.page_url
    return url[:url.rfind("/") + 1] + PRESENT_FILE if mode == "present" else url
