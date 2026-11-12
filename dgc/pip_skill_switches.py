"""A switch per skill on each Personal Pip (pips-12, Pips API 88).

Every skill a Personal Pip may use (the user's own, plugin skills and the everyday built-ins: pips.personal_skills) is
on until switched off on that Pip's page. The supervisor pins the switched-off ones into each chat reply's or task's
manifest (``skills_off``), and the worker never offers them to the model. Other Pips keep them. Only the user, on this
computer, changes a switch.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError

KEY = "pip_skills_off:"            # metadata: a Pip's skills switched off, a JSON list of skill names
NAME = re.compile(r"[a-z0-9][a-z0-9_.-]{0,63}\Z")
LOCAL = ("editor-user", "local-console")
MOST = 200


def off(registry, pip_id) -> set:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (KEY + pip_id,)).fetchone()
    try:
        value = json.loads(row[0]) if row is not None else []
    except ValueError:
        value = []
    return {v for v in value if isinstance(v, str) and NAME.fullmatch(v)} if isinstance(value, list) else set()


def set_skill(registry, pip_id, skill, on, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you can choose a Pip's skills, on this computer.")
    if not isinstance(skill, str) or not NAME.fullmatch(skill):
        raise RegistryError("invalid_request", "Choose one of the skills on this Pip's page.")
    if type(on) is not bool:
        raise RegistryError("invalid_request", "Switch a skill on or off: on is true or false.")
    from .pips import PipStore
    PipStore(registry)._job(pip_id)
    now = off(registry, pip_id)
    (now.discard if on else now.add)(skill)
    if len(now) > MOST:
        raise RegistryError("limit", "Too many skills are switched off on this Pip.")
    workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
    with registry.transaction():
        if now:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (KEY + pip_id, json.dumps(sorted(now))))
        else:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (KEY + pip_id,))
        if workspace is not None:
            registry.event(workspace[0], "pip_skill_switched", pip_id=pip_id, payload={"skill": skill, "on": on, "actor": actor})
    return {"skill": skill, "on": on}


def listing(registry, pip_id, skills) -> dict:
    """This Pip's skills for its page: every skill a Personal Pip may use, each with its switch."""
    gone = off(registry, pip_id)
    rows = [{"name": name, "description": str(getattr(skill, "description", "") or "")[:300],
             "source": str(getattr(skill, "source", "") or ""), "on": name not in gone}
            for name, skill in sorted(skills.items())]
    return {"pip_id": pip_id, "skills": rows[:MOST]}


def runtime(registry, run, manifest) -> dict:
    """In the supervisor, as a Personal Pip's chat reply or task starts: its switched-off skills, for the worker."""
    if manifest.get("run_kind") not in ("conversation", "personal_task") or "handoff" in manifest:
        return manifest
    gone = off(registry, run["pip_id"])
    return {**manifest, "skills_off": sorted(gone)} if gone else manifest


def offered(skills, manifest) -> dict:
    """The skills the worker offers its model: every one but those the run says are switched off."""
    gone = manifest.get("skills_off", [])
    if not isinstance(gone, list) or len(gone) > MOST or not all(isinstance(v, str) and NAME.fullmatch(v) for v in gone):
        raise RegistryError("invalid_run", "This run's switched-off skills are malformed.")
    return {name: skill for name, skill in skills.items() if name not in set(gone)}
