"""The Pips tab's one-time welcome after the update to 0.52 (pips-flow-design §3.3, item 2; Pips API 96).

"Your Pips moved into one list": shown once, the first time the Pips tab opens in 0.52, only if this user had Pips
before the update (never for a new user: nothing moved). The registry marks the moment it upgraded a database from 0.51
or before (``mark_upgrade``); ``welcome`` names the Pips that existed then, as the pop-up says them: the ones that were
Project Pips, by folder, the Personal ones, and the Personal ones on Do it all (they keep what it meant before; the
user chooses it again to let them do more). Core alone is not "had Pips". Reads only.
"""
from __future__ import annotations

import json

MARK = "pips_before_052"
MAX_LISTED = 50


def mark_upgrade(db, now: str) -> None:
    """In the registry's upgrade transaction, once: when this database came from 0.51 or before."""
    db.execute("INSERT OR IGNORE INTO metadata VALUES(?,?)", (MARK, json.dumps({"at": now})))


def welcome(registry) -> dict:
    """get_pips_welcome: {had_pips, folders [{workspace_id, folder, pips [{id, name}]}], personal [{id, name}],
    do_it_all [{id, name}]}."""
    db = registry.db
    empty = {"had_pips": False, "folders": [], "personal": [], "do_it_all": []}
    row = db.execute("SELECT value FROM metadata WHERE key=?", (MARK,)).fetchone()
    try:
        at = json.loads(row[0])["at"] if row else None
    except (ValueError, TypeError, KeyError):
        at = None
    if not isinstance(at, str):
        return empty
    rows = db.execute(
        "SELECT p.id,p.workspace_id,w.kind,w.name AS folder,json_extract(v.definition,'$.name') AS name,"
        "json_extract(v.definition,'$.pip_type') AS pip_type FROM pips p JOIN workspaces w ON w.id=p.workspace_id "
        "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
        "WHERE p.created_at<=? AND p.status<>'archived' ORDER BY p.created_at,p.id LIMIT 500", (at,)).fetchall()
    from . import pip_levels
    folders: dict = {}
    personal, full = [], []
    for item in rows:
        if item["pip_type"] == "core" or not isinstance(item["name"], str):
            continue
        pip = {"id": item["id"], "name": item["name"][:120]}
        if item["kind"] == "personal":
            personal.append(pip)
            try:
                if pip_levels.level(registry, item["id"]) == pip_levels.FULL:
                    full.append(pip)
            except Exception:                    # noqa: BLE001 - a level that doesn't read says nothing
                pass
        else:
            place = folders.setdefault(item["workspace_id"], {"workspace_id": item["workspace_id"],
                                                              "folder": str(item["folder"] or "")[:200], "pips": []})
            place["pips"].append(pip)
    listed = list(folders.values())[:MAX_LISTED]
    return {"had_pips": bool(personal or listed), "folders": listed, "personal": personal[:MAX_LISTED],
            "do_it_all": full[:MAX_LISTED]}
