"""A Personal Pip's own page, as on Grok's bots (Pips API 43, schema 41).

Its look (one of the eight Pip faces, and a colour), a short title under its name, and whether it
tells you when it finishes something on its own or needs you. All of it is the user's, set on this
computer; none of it grants or changes what a Pip can do, and a Pip never changes it.

The page's Links, Media and Files tabs list what was shared in its chat: the links in its messages
(yours and its own), the images, and the files, newest first.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_profiles (
 pip_id TEXT PRIMARY KEY REFERENCES pips(id),
 title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=60),
 body TEXT CHECK(body IS NULL OR body IN ('core','scout','lens','patch','rook','pulse','lock','quill')),
 color TEXT CHECK(color IS NULL OR color IN ('peach','rose','lilac','sky','mint','sun','slate')),
 notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
 updated_at TEXT NOT NULL
);
"""
BODIES = ("core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill")
COLORS = ("peach", "rose", "lilac", "sky", "mint", "sun", "slate")
FIELDS = ("title", "body", "color", "notify")
LOCAL = ("editor-user", "local-console")
SHARED_KINDS = ("links", "media", "files")
MAX_SHARED = 60
SCAN_MESSAGES = 400                 # links are found in the newest messages only
URL = re.compile(r"https?://[^\s<>()\[\]{}\"'`]+", re.I)


def default() -> dict:
    return {"title": "", "body": None, "color": None, "notify": True}


def _view(row) -> dict:
    if row is None:
        return default()
    return {"title": row["title"], "body": row["body"], "color": row["color"], "notify": bool(row["notify"])}


def get(db, pip_id: str) -> dict:
    try:
        return _view(db.execute("SELECT * FROM pip_profiles WHERE pip_id=?", (pip_id,)).fetchone())
    except Exception:                    # a registry from before schema 41
        return default()


def profiles(db, pip_ids) -> dict:
    """Every listed Pip's profile in one read (the Pips list shows each one's face)."""
    ids = list(pip_ids)
    found = {}
    if ids:
        try:
            marks = ",".join("?" * len(ids))
            for row in db.execute(f"SELECT * FROM pip_profiles WHERE pip_id IN ({marks})", ids).fetchall():
                found[row["pip_id"]] = _view(row)
        except Exception:
            pass
    return {pip_id: found.get(pip_id, default()) for pip_id in ids}


def notifies(db, pip_id: str) -> bool:
    return get(db, pip_id)["notify"]


def update(store, pip_id: str, changes, actor: str) -> dict:
    """The user's change to its title, face, colour or notifications. null face or colour: its default."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Change a Pip's page on this computer.")
    job = store._job(pip_id)
    if job["status"] == "archived":
        raise RegistryError("archived", f"{job['name']} is archived. Restore it first.")
    if not isinstance(changes, dict) or not changes or set(changes) - set(FIELDS):
        raise RegistryError("invalid_request", "Change its title, face, colour or notifications.")
    fields = get(store.db, pip_id)
    if "title" in changes:
        title = changes["title"]
        if not isinstance(title, str) or len(title.strip()) > 60 or re.search(r"[\x00-\x1f\x7f]", title):
            raise RegistryError("invalid_request", "Keep its title to one line, under 60 characters.")
        fields["title"] = title.strip()
    if "body" in changes:
        if changes["body"] is not None and changes["body"] not in BODIES:
            raise RegistryError("invalid_request", "Choose one of the eight faces.")
        fields["body"] = changes["body"]
    if "color" in changes:
        if changes["color"] is not None and changes["color"] not in COLORS:
            raise RegistryError("invalid_request", "Choose one of the colours.")
        fields["color"] = changes["color"]
    if "notify" in changes:
        if type(changes["notify"]) is not bool:
            raise RegistryError("invalid_request", "Notifications are on or off.")
        fields["notify"] = changes["notify"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    with store.registry.transaction():
        store.db.execute("INSERT INTO pip_profiles(pip_id,title,body,color,notify,updated_at) VALUES(?,?,?,?,?,?) "
                         "ON CONFLICT(pip_id) DO UPDATE SET title=excluded.title,body=excluded.body,color=excluded.color,"
                         "notify=excluded.notify,updated_at=excluded.updated_at",
                         (pip_id, fields["title"], fields["body"], fields["color"], int(fields["notify"]), now))
        store.registry.event(job["workspace_id"], "pip_profile_changed", pip_id=pip_id, payload={"fields": sorted(changes)})
    return {"pip_id": pip_id, "profile": get(store.db, pip_id)}


def _clean_url(url: str) -> str:
    url = url.rstrip(".,;:!?*_~")
    while url.endswith(")") and url.count("(") < url.count(")"):
        url = url[:-1]
    return url[:2048]


def shared(store, pip_id: str, kind) -> dict:
    """What was shared in its chat, newest first: links, images, or files."""
    job = store._job(pip_id)
    if kind not in SHARED_KINDS:
        raise RegistryError("invalid_request", "Choose links, media or files.")
    from .pip_chat import DGC_KEYS
    db = store.db
    items = []
    if kind == "links":
        rows = db.execute("SELECT id,role,text,created_at,request_key FROM pip_chat_messages WHERE pip_id=? "
                          "ORDER BY seq DESC LIMIT ?", (pip_id, SCAN_MESSAGES)).fetchall()
        seen = set()
        for row in rows:
            if row["role"] == "user" and isinstance(row["request_key"], str) and row["request_key"].startswith(DGC_KEYS):
                continue                 # a turn DGC wrote, not something anyone shared
            for match in URL.finditer(row["text"]):
                url = _clean_url(match.group(0))
                if len(url) < 12 or url in seen:
                    continue
                seen.add(url)
                host = re.sub(r"^www\.", "", re.split(r"[/?#:]", url.split("://", 1)[1], 1)[0].lower())[:255]
                items.append({"url": url, "host": host, "message_id": row["id"], "from": "you" if row["role"] == "user" else "pip",
                              "at": row["created_at"]})
                if len(items) >= MAX_SHARED:
                    break
            if len(items) >= MAX_SHARED:
                break
    elif kind == "media":
        for row in db.execute("SELECT m.id,m.role,m.created_at,i.idx,i.mime,i.bytes FROM pip_chat_images i "
                              "JOIN pip_chat_messages m ON m.id=i.message_id WHERE m.pip_id=? ORDER BY m.seq DESC,i.idx "
                              "LIMIT ?", (pip_id, MAX_SHARED)).fetchall():
            items.append({"message_id": row["id"], "index": row["idx"], "mime": row["mime"], "bytes": row["bytes"],
                          "from": "you" if row["role"] == "user" else "pip", "at": row["created_at"]})
    else:
        for row in db.execute("SELECT m.id,m.role,m.created_at,f.idx,f.name,f.bytes FROM pip_chat_files f "
                              "JOIN pip_chat_messages m ON m.id=f.message_id WHERE m.pip_id=? ORDER BY m.seq DESC,f.idx "
                              "LIMIT ?", (pip_id, MAX_SHARED)).fetchall():
            items.append({"message_id": row["id"], "index": row["idx"], "name": row["name"], "bytes": row["bytes"],
                          "from": "you" if row["role"] == "user" else "pip", "at": row["created_at"]})
    return {"pip_id": pip_id, "workspace_id": job["workspace_id"], "kind": kind, "items": items}
