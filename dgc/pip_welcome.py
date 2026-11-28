"""The Pips tab's one-time welcome after the update to 0.52 (pips-flow-design §3.3, item 2; Pips API 96).

"Your Pips moved into one list": shown once, the first time the Pips tab opens in 0.52, only if this user had Pips
before the update (never for a new user: nothing moved). The registry marks the moment it upgraded a database from 0.51
or before by copying it aside (workspace_registry: backups/before-0.52, the copy's name says when; nothing is written
into the database, whose upgrade tests compare it byte for byte); ``welcome`` names the Pips that existed then, as the pop-up says them: the ones that were
Project Pips, by folder, the Personal ones, and the Personal ones on Do it all (they keep what it meant before; the
user chooses it again to let them do more). Core alone is not "had Pips". Reads only.
"""
from __future__ import annotations

import json

import re
from datetime import datetime, timezone

MAX_LISTED = 50
_COPY = re.compile(r"registry-v\d+-(\d{8}T\d{6})(\d{0,6})Z\.sqlite3\Z")


def upgraded_at(registry) -> str | None:
    """When 0.52 first upgraded this database from 0.51 or before: the oldest pre-0.52 copy's own stamp. None for a
    database that never came from 0.51 (or whose copy is gone after its 30 days)."""
    from .workspace_registry import BACKUP_FOLDER
    folder = registry.directory.joinpath(*BACKUP_FOLDER)
    stamps = sorted((match.group(1), match.group(2).ljust(6, "0")) for match in (
        _COPY.match(p.name) for p in (folder.glob("registry-v*.sqlite3") if folder.is_dir() else [])) if match)
    if not stamps:
        return None
    second, micro = stamps[0]
    moment = datetime.strptime(second, "%Y%m%dT%H%M%S").replace(microsecond=int(micro), tzinfo=timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def welcome(registry) -> dict:
    """get_pips_welcome: {had_pips, folders [{workspace_id, folder, pips [{id, name}]}], personal [{id, name}],
    do_it_all [{id, name}]}."""
    db = registry.db
    empty = {"had_pips": False, "folders": [], "personal": [], "do_it_all": []}
    at = upgraded_at(registry)
    if not isinstance(at, str):
        return empty
    rows = db.execute(
        "SELECT p.id,p.workspace_id,w.kind,w.name AS folder,json_extract(v.definition,'$.name') AS name,"
        "json_extract(v.definition,'$.pip_type') AS pip_type FROM pips p JOIN workspaces w ON w.id=p.workspace_id "
        "JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version "
        "WHERE p.created_at<=? AND p.status<>'archived' ORDER BY p.created_at,p.rowid LIMIT 500", (at,)).fetchall()
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
