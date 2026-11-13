"""A Pip's "Knows about you" switch (pips-flow-design Q8, 14 Nov): what DGC remembers about you (you, the people in your
life, how you like things done) reaches every Pip, on by default; this switch on its page turns it off for that Pip.
Settings → Memory's main switch still turns it off for everything. Only the user sets it.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

KEY = "pip_knows_you:"                 # metadata: present only when the user turned it off
LOCAL = ("editor-user", "local-console")


def knows_you(registry, pip_id: str) -> bool:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (KEY + str(pip_id),)).fetchone()
    if row is None:
        return True
    try:
        return json.loads(row[0]).get("on") is not False
    except (ValueError, TypeError, AttributeError):
        return True


def set_knows_you(store, pip_id: str, on, actor: str) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you choose what a Pip knows about you, on this computer.")
    if type(on) is not bool:
        raise RegistryError("invalid_request", "on is true or false.")
    store._job(pip_id)
    registry = store.registry
    with registry.transaction():
        if on:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (KEY + pip_id,))
        else:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                (KEY + pip_id, json.dumps({"on": False, "at": registry.clock(), "by": actor})))
    return {"pip_id": pip_id, "knows_you": on}
