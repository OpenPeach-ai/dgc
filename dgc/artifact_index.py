"""What was made before the artifact store, in it too: Work's served pages (artifacts.json), ChatDGC's widgets and the
spreadsheets ChatDGC made. Each comes in once, as an artifact that says where it came from (its ``legacy``), and is
known again by that, so indexing twice adds nothing, and one the user moved to the trash isn't brought back. The
originals stay where they were: a widget still opens in its chat, a made file is still in the chat's Library.

The Library's listing calls index(); it does the work at most once every INTERVAL seconds per process, and one
process at a time (its own lock file, beside the store's: a store write inside it takes the store's lock).
"""
from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path

from . import artifact_store

INTERVAL = 30.0
_last = 0.0
_last_root: Path | None = None
_guard = threading.Lock()


def _known(st: artifact_store.Store) -> set[tuple[str, str]]:
    """Every (kind, id) already indexed: in the store, or moved to its trash."""
    records = [art.legacy for art in st.list()]
    try:
        trashed = [p / "artifact.json" for p in (st.root / ".trash").iterdir()]
    except OSError:
        trashed = []
    for path in trashed:
        data = st._read_json(path)
        if isinstance(data, dict) and isinstance(data.get("legacy"), dict):
            records.append(data["legacy"])
    return {(key, str(value)) for legacy in records for key, value in legacy.items()
            if key in ("server", "widget", "made") and value}


def _pages(st, known) -> int:
    """Work's pages served before they were versioned: each becomes a Page with what it serves now."""
    from . import artifacts
    if st.root != artifact_store.store().root:          # _record_version keeps versions in the user's own store
        return 0
    server, n = artifacts._SRV, 0
    with server.lock:
        waiting = [a for a in server.artifacts.values() if not a.store_id and ("server", a.id) not in known]
    for art in waiting:
        if not artifacts._record_version(server, art, Path(art.directory)):
            n += 1
    return n


def _widgets(st, chats, known) -> int:
    """ChatDGC's widgets: each becomes a Page of its own HTML."""
    from .chatdgc.store import MAX_LIST, ChatStoreError
    n, offset = 0, 0
    while offset is not None:
        page = chats.widgets(limit=MAX_LIST, offset=offset)
        for row in page["widgets"]:
            if ("widget", row["id"]) in known:
                continue
            try:
                html = chats.widget(row["chat_id"], row["id"]).get("html")
            except ChatStoreError:
                continue
            if not isinstance(html, str) or not html.strip():
                continue
            st.create("page", row.get("title") or "Interactive", {"index.html": html.encode("utf-8")},
                      origin={"surface": "chat", "chat": row["chat_id"]}, author="DGC",
                      summary="From a widget in a chat",
                      legacy={"widget": row["id"], "chat": row["chat_id"], "message": row.get("message_id", "")})
            known.add(("widget", row["id"]))
            n += 1
        offset = page.get("next_offset")
    return n


def _sheets(st, chats, known) -> int:
    """Spreadsheets ChatDGC made (.xlsx, .csv, .tsv): each becomes a Sheet. Files you uploaded stay files."""
    from . import artifact_sheet
    from .chatdgc.store import MAX_LIST, ChatStoreError
    n, offset = 0, 0
    while offset is not None:
        page = chats.library(kind="spreadsheet", origin="made", limit=MAX_LIST, offset=offset)
        for row in page["files"]:
            if row.get("source") != "chat" or ("made", row["id"]) in known:
                continue
            suffix = Path(row["name"]).suffix.lower()
            if suffix not in (".xlsx", ".csv", ".tsv"):
                continue
            try:
                raw, _text = chats.get_file(row["chat_id"], row["id"])
            except ChatStoreError:
                continue
            with tempfile.TemporaryDirectory(prefix="dgc-index-") as tmp:
                path = Path(tmp) / f"{Path(row['name']).stem or 'sheet'}{suffix}"
                path.write_bytes(raw)
                try:
                    spec = artifact_sheet.from_table_file(path)
                except artifact_sheet.SheetError:
                    continue
            try:
                # Keep the import identity in the same commit as the first version.
                # A crash between create and set_meta must not import the file again.
                st.create("sheet", Path(row["name"]).stem or "Sheet", artifact_sheet.normalize(spec),
                          origin={"surface": "chat", "chat": row["chat_id"]},
                          summary="From a file a chat made",
                          legacy={"made": row["id"], "chat": row["chat_id"]})
            except (artifact_sheet.SheetError, artifact_store.ArtifactError):
                continue
            known.add(("made", row["id"]))
            n += 1
        offset = page.get("next_offset")
    return n


def index(*, store: artifact_store.Store | None = None, chats=None, force: bool = False) -> int:
    """Bring in whatever isn't in the store yet; how many came in. Nothing here fails a listing: a part that can't
    be read is skipped, and tried again next time."""
    global _last, _last_root
    st = store or artifact_store.store()
    with _guard:
        if not force and st.root == _last_root and time.monotonic() - _last < INTERVAL:
            return 0
        _last = time.monotonic()
        _last_root = st.root
    try:
        import fcntl
    except ImportError:
        fcntl = None
    try:
        st.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(st.root / ".index.lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    except OSError:
        return 0                              # indexing may be unavailable while the store is still readable
    total = 0
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        known = _known(st)
        if chats is None:
            from .chatdgc.store import ChatStore
            # Index only the chats that belong to this artifact store. An isolated SDK
            # home must never import widgets or files from the host account's ChatDGC.
            chats = ChatStore(st.root.parent / "chat")
        for part in (lambda: _pages(st, known), lambda: _widgets(st, chats, known), lambda: _sheets(st, chats, known)):
            try:
                total += part()
            except Exception:                    # noqa: BLE001 -- the listing still lists what's there
                continue
    finally:
        os.close(fd)
    return total
