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
  can make one from HTML it writes.

The model hands over data, never a file's bytes; DGC lays every artifact out the same way every time.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from . import artifact_store, workspace
from .artifact_store import ArtifactError, Store

# The Output chip's choices, and the type each makes. "auto" leaves the choice to the model.
OUTPUTS = {"auto": None, "document": "doc", "slides": "slides", "spreadsheet": "sheet", "page": "page",
           "dashboard": "dashboard"}
EXPORTS = {"doc": ("docx", "pdf", "md"), "slides": ("pptx", "pdf", "html"), "sheet": ("xlsx", "csv"),
           "dashboard": ("html", "pdf"), "page": ("html", "zip")}
LABELS = {"doc": "Document", "slides": "Slides", "sheet": "Spreadsheet", "dashboard": "Dashboard", "page": "Page"}
MAX_DOC_CHARS = 200_000
MAX_PAGE_BYTES = 2 * 1024 * 1024


class ArtifactUseError(ValueError):
    """Asked for something an artifact can't do; the text says what to change, for the model or the user."""


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
    else:
        raise ArtifactUseError(f"{type_} has no data module")
    return module


def _type(value) -> str:
    text = str(value or "").strip().lower()
    text = {"document": "doc", "docs": "doc", "deck": "slides", "presentation": "slides", "spreadsheet": "sheet",
            "sheets": "sheet", "table": "sheet", "html": "page", "web page": "page"}.get(text, text)
    if text not in artifact_store.TYPES:
        raise ArtifactUseError("An artifact is a doc, slides, sheet, dashboard or page.")
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

def make(type_, title, spec, *, origin: dict, author: str = "DGC", summary: str = "Made", store: Store | None = None,
         base=None, resolve=None) -> dict:
    """A new artifact. ``origin`` names where (``{"surface": "chat", "chat": …}``, ``{"surface": "work", …}``, …)."""
    from .chatdgc import made
    type_ = _type(type_)
    content = _content(type_, spec, base=base, resolve=resolve)
    entry = _page_files(spec)[1] if type_ == "page" else ""
    st = _store(store)
    try:
        art = st.create(type_, title or LABELS[type_], content, origin=origin, author=author,
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
        if content is None and edits is None:
            raise ArtifactUseError("Give content (the whole new artifact) or edits.")
        expected = None
        if art.type == "doc":
            if author != "you":
                expected = _theirs_first(st, art)
                art = st.get(aid)
            else:
                snapshot = _doc_snapshot(art)
                expected = snapshot[1] if snapshot else None
        if content is not None:
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


def view(aid: str, *, store: Store | None = None, versions: bool = True) -> dict:
    """An artifact as the screens, the CLI and the SDK show it."""
    st = _store(store)
    art = st.get(aid)
    out = {"id": art.id, "type": art.type, "label": LABELS[art.type], "title": art.title, "version": art.version,
           "created": art.created, "updated": art.updated, "origin": dict(art.origin),
           "exports": list(EXPORTS[art.type])}
    if art.link:
        out["link"] = dict(art.link)
    if art.legacy.get("canvas"):
        out["canvas"] = art.legacy["canvas"]
    if _doc_file(art) is not None:
        out["file"] = str(_doc_file(art))              # the file the editor opens
    if art.type == "dashboard":
        out["allowed_sources"] = list(art.sources)     # the sources the user allowed (allow_source), by id
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
    else:
        saved = state(aid, store=store, version=n)
        source = st.source(aid, n)
        results = dict(saved.get("results") or {})
        for widget in source.get("widgets") or []:
            if widget.get("source") not in art.sources:
                results[widget["id"]] = {"blocked": widget["source"]}
        html = _kind("dashboard").render_html(source, results, title=art.title)
    return {"index.html": html.encode("utf-8")}, "index.html"


def export(aid: str, fmt: str, *, n: int | None = None, config=None, browser=None, store: Store | None = None) -> Path:
    """The artifact as a file, written to its exports folder; returns the path."""
    from .chatdgc import made
    st = _store(store)
    art = st.get(aid)
    fmt = str(fmt or "").lower().lstrip(".")
    fmt = {"word": "docx", "powerpoint": "pptx", "excel": "xlsx", "markdown": "md"}.get(fmt, fmt)
    if fmt not in EXPORTS[art.type]:
        raise ArtifactUseError(f"A {LABELS[art.type].lower()} exports as {', '.join(EXPORTS[art.type])}.")
    n = art.version if n is None else n
    # Each request owns its bytes until its caller copies them, even if another window exports
    # the same title and format meanwhile. The directory is private and the path is handed out
    # only after a complete write; failed exports leave no partial copy behind.
    folder = Path(tempfile.mkdtemp(prefix="export-", dir=st.export_dir(aid)))
    target = folder / made.file_name(art.title, fmt)
    try:
        if art.type == "doc":
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
        served.store_id = aid
    url = served.page_url
    return url[:url.rfind("/") + 1] + PRESENT_FILE if mode == "present" else url
