"""How many Pips a workspace may have: 100 unless you choose another number (Pips settings).

A powerful machine can run thousands; the number is yours. Archived Pips do not count: they never
run, and you keep them. The limit lives in the registry beside the Pips it bounds.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

KEY = "pips_max"
DEFAULT = 100
MAXIMUM = 100000
LOCAL = ("editor-user", "local-console")


def limit(db) -> int:
    """The chosen limit, or the default. Takes a registry's database (or anything with execute)."""
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (KEY,)).fetchone()
        value = json.loads(row[0]) if row else DEFAULT
    except Exception:
        return DEFAULT
    return value if type(value) is int and 1 <= value <= MAXIMUM else DEFAULT


def live_count(db, workspace_id) -> int:
    return db.execute("SELECT count(*) FROM pips WHERE workspace_id=? AND status<>'archived'", (workspace_id,)).fetchone()[0]


def require_room(db, workspace_id) -> None:
    """Refuse a new Pip once the workspace has as many as the limit allows."""
    allowed = limit(db)
    if live_count(db, workspace_id) >= allowed:
        raise RegistryError("limit", f"This workspace already has {allowed:,} Pips. Archive one, or raise the number in "
                            "Pips settings.")


def status(registry) -> dict:
    return {"max_pips": limit(registry.db), "default": DEFAULT, "maximum": MAXIMUM}


def set_limit(registry, value, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you can change how many Pips you can have, on this computer.")
    if type(value) is not int or not 1 <= value <= MAXIMUM:
        raise RegistryError("invalid_request", f"Choose a number from 1 to {MAXIMUM:,}.")
    with registry.transaction():
        registry.db.execute("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (KEY, json.dumps(value)))
    return status(registry)
