"""A Project Pip's owner session (asked 12 Nov): the one Work chat its cards reach.

"For project Pips, there has to be a session owner; by default the session owner becomes the session who creates
those Pips, and their cards only appear on their owner sessions. User should be able to change the owner session on
Project Pips settings." Answers the same day: strictly one owner, and attaching a Pip to a chat makes that chat its
owner; archiving or deleting an owning session asks first (the editor reads `owned` and moves or deletes each Pip);
the Pips view and Home keep listing every card in the project.

The owner: the one you chose (`pip_owner_sessions`, set here, by attach_pip_to_session, or by the archive question),
else the chat it was set up in or most recently attached to (the creator, for a Pip made after this). A chosen "no
session" is kept as an empty session id: its reports then wait in the Pips view, as a Pip with no chat's always have.
A Personal Pip has no owner session: it has its own chat.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_owner_sessions(
 pip_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL CHECK(length(session_id)<=128),
 since TEXT NOT NULL, actor TEXT NOT NULL);
"""
SESSION = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
LOCAL = ("editor-user", "local-console")
MAX_OWNED = 200


def ensure(db) -> None:
    # One statement, never executescript: this runs inside the attach tool's transaction, which executescript commits.
    db.execute(SCHEMA.strip().rstrip(";"))


def _has(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_owner_sessions'").fetchone() is not None


def _linked(db, workspace_id: str | None = None, pip_id: str | None = None) -> dict:
    """pip_id -> (session_id, since): the newest chat it was set up in or attached to."""
    found: dict[str, tuple[str, str]] = {}
    where, params = [], []
    if workspace_id is not None:
        where.append("workspace_id=?"); params.append(workspace_id)
    if pip_id is not None:
        where.append("pip_id=?"); params.append(pip_id)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    for session, pip, since in db.execute("SELECT session_id,pip_id,created_at FROM session_pip_attachments" + clause, params):
        if isinstance(since, str) and isinstance(session, str) and SESSION.fullmatch(session):
            if pip not in found or since > found[pip][1]:
                found[pip] = (session, since)
    setup_clause = " AND workspace_id=?" if workspace_id is not None else ""
    for session, raw in db.execute("SELECT session_id,receipt FROM pip_setup_proposals WHERE status='accepted'"
                                   " AND length(CAST(receipt AS BLOB))<=4096" + setup_clause + " LIMIT 2000",
                                   [workspace_id] if workspace_id is not None else []):
        try:
            receipt = json.loads(raw)
        except (TypeError, ValueError, RecursionError):
            continue
        if not isinstance(receipt, dict) or receipt.get("accepted") is not True:
            continue
        pip, since = receipt.get("pip_id"), receipt.get("resolved_at")
        if (isinstance(pip, str) and (pip_id is None or pip == pip_id) and isinstance(since, str)
                and isinstance(session, str) and SESSION.fullmatch(session)):
            if pip not in found or since > found[pip][1]:
                found[pip] = (session, since)
    return found


def _chosen(db, workspace_id: str | None = None, pip_id: str | None = None) -> dict:
    if not _has(db):
        return {}
    where, params = [], []
    if workspace_id is not None:
        where.append("workspace_id=?"); params.append(workspace_id)
    if pip_id is not None:
        where.append("pip_id=?"); params.append(pip_id)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return {pip: (session, since) for pip, session, since in
            db.execute("SELECT pip_id,session_id,since FROM pip_owner_sessions" + clause, params)}


def owner(db, pip_id: str) -> dict | None:
    """{session_id (None: no session), since, chosen}, or None when it has none at all."""
    chosen = _chosen(db, pip_id=pip_id).get(pip_id)
    if chosen is not None:
        return {"session_id": chosen[0] or None, "chosen": True, "since": chosen[1]}
    linked = _linked(db, pip_id=pip_id).get(pip_id)
    return {"session_id": linked[0], "chosen": False, "since": linked[1]} if linked else None


def links(db, session_id: str, workspace_id: str) -> dict[str, str]:
    """pip_id -> since when this chat is its owner: the Pips of this project whose cards reach this chat."""
    owners = {pip: value for pip, value in _linked(db, workspace_id=workspace_id).items()}
    owners.update(_chosen(db, workspace_id=workspace_id))
    return {pip: since for pip, (session, since) in owners.items() if session and session == session_id}


def _project_pip(registry, pip_id) -> dict:
    if not isinstance(pip_id, str) or not re.fullmatch(r"pip_[0-9a-f]{32}", pip_id):
        raise RegistryError("invalid_request", "Choose a Pip.")
    row = registry.db.execute("SELECT id,workspace_id,status FROM pips WHERE id=?", (pip_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That Pip isn't here.")
    if registry.get(row["workspace_id"])["kind"] == "personal":
        raise RegistryError("personal", "A Personal Pip has its own chat: it has no owner session.")
    return dict(row)


def set_owner(registry, pip_id, session_id, actor: str) -> dict:
    """Make a session of the Pip's own project its owner, or no session (None or "")."""
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you choose a Pip's owner session, on this computer.")
    pip = _project_pip(registry, pip_id)
    if pip["status"] == "archived":
        raise RegistryError("archived", "Restore this Pip before giving it an owner session.")
    if session_id in (None, ""):
        session_id = ""
    else:
        if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
            raise RegistryError("invalid_request", "Choose one of this project's sessions.")
        identity = registry.session_identity(session_id)
        if identity is None or identity.get("workspace_id") != pip["workspace_id"]:
            raise RegistryError("invalid_request", "Choose one of this project's sessions: that session isn't one.")
    ensure(registry.db)
    registry.db.execute("INSERT OR REPLACE INTO pip_owner_sessions VALUES(?,?,?,?,?)",
                        (pip_id, pip["workspace_id"], session_id, registry.clock(), actor))
    registry.event(pip["workspace_id"], "pip_owner_changed", pip_id=pip_id,
                   payload={"actor": actor, "session": bool(session_id)})
    return {"pip_id": pip_id, "session_id": session_id or None}


def owned(registry, session_id) -> dict:
    """The Project Pips a session owns (not archived): what archiving or deleting it asks about."""
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise RegistryError("invalid_request", "Choose a session.")
    identity = registry.session_identity(session_id)
    if identity is None:
        return {"session_id": session_id, "pips": []}
    mine = links(registry.db, session_id, identity["workspace_id"])
    pips = []
    for row in registry.db.execute("""SELECT p.id,p.status,v.definition FROM pips p JOIN pip_versions v
            ON v.pip_id=p.id AND v.version=p.current_version WHERE p.workspace_id=? AND p.status<>'archived'
            ORDER BY p.created_at,p.id""", (identity["workspace_id"],)):
        if row["id"] not in mine:
            continue
        try:
            definition = json.loads(row["definition"])
        except (TypeError, ValueError, RecursionError):
            definition = {}
        pips.append({"id": row["id"], "name": str(definition.get("name") or "Pip")[:120],
                     "pip_type": str(definition.get("pip_type") or ""), "status": row["status"]})
        if len(pips) >= MAX_OWNED:
            break
    return {"session_id": session_id, "pips": pips}
