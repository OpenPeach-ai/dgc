"""Give a Pip a folder later, and Remove its folder (0.52, Pips API 110).

His call (14 Nov): a Pip made without a folder (a Pip for anything) can become a folder Pip for a folder you give it, and
a folder Pip can become a Pip for anything again. Either way it keeps its chat, notes, routines, computer (its Files),
level, model, sub-agents and history.

How: the Pip moves. A Pip's kind is where it lives: a Pip for anything is in the one personal workspace (which every such
Pip and Core share, so it has no workspace of its own to bind a folder to), and a folder Pip is in its folder's
workspace. Giving it a folder moves it into that folder's workspace, and removing the folder moves it back, in one
transaction, with the next version of its job written for its new place exactly as a Pip made there from the start
would have it (its source rules, what fits there). Every read of its kind, its folder, its copy and its runs then
reads it as a Pip made there.

Its history stays where it happened: runs, chat rows, findings and what it learned about a folder's code keep the
workspace they were made in (most of them are immutable), and every read of them is by the Pip, or checks a row
against its own run. Its own current rows (its conversations, notes, routines, plugin and app grants) move with it.

What is pending has an outcome, said first in plain words (``dry_run``) and in the answer:
- a run or a sub-agent working: refused until it ends;
- a change waiting at Apply, an applied change's Undo, its copy in its Files: they belong to the folder's copy, never to
  the Pip's kind, so they carry over both ways (after Remove, @ the folder in a message works on that copy again);
- a reviewed change waiting for the user: carried to the new version where it still fits, else closed;
- a handoff waiting for it or from it, a message it prepared that waits for the user's Send: closed (the Pip changed);
- on Remove, a fix that asks or waits to start, what only the user can do for the folder, and a sub-agent's question
  after its last try: closed, since they are about the folder;
- a schedule stops (its run would quietly become the other kind of work), and an event trigger or command plan a Pip for
  anything can't have goes: each said. Its routines, turns of its chat, go on.

Only the user, on this computer: never a Pip, a model, a routine or another device.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from .workspace_registry import RegistryError

COMMANDS = ("give_pip_folder", "remove_pip_folder")
LOCAL = ("editor-user", "local-console")
GIVEN, REMOVED = "pip_folder_given", "pip_folder_removed"
PIP = re.compile(r"pip_[0-9a-f]{32}\Z")
# The Pip's own current rows: they follow it (its history stays where it happened).
OWN_ROWS = ("pip_conversations", "pip_notes", "pip_routines", "pip_plugin_grants", "pip_app_links")
HOMES = "pip_homes:"            # metadata: + pip id, the JSON list of every workspace the Pip has lived in (once moved)


def lived_in(db, pip_id, workspace_id) -> bool:
    """Whether this Pip lived in that workspace before it was given a folder or had it removed: its runs made there are
    its history. False for a Pip that was never moved, and for a workspace it never lived in."""
    try:
        row = db.execute("SELECT value FROM metadata WHERE key=?", (HOMES + str(pip_id),)).fetchone()
        homes = json.loads(row[0]) if row else []
    except (sqlite3.Error, TypeError, ValueError):
        return False
    return isinstance(homes, list) and workspace_id in homes


def _remember_home(db, pip_id, *spaces) -> None:
    """Inside the move: every workspace this Pip has lived in, for lived_in."""
    row = db.execute("SELECT value FROM metadata WHERE key=?", (HOMES + pip_id,)).fetchone()
    try:
        known = json.loads(row["value"]) if row else []
    except (TypeError, ValueError):
        known = []
    known = [s for s in known if isinstance(s, str)] if isinstance(known, list) else []
    db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
               (HOMES + pip_id, json.dumps(list(dict.fromkeys([*known, *spaces]))[:512])))


def control(store, command, request, actor, config=None) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Give a Pip a folder, or remove it, on this computer.")
    pip_id = request.get("pip_id")
    if not isinstance(pip_id, str) or not PIP.fullmatch(pip_id):
        raise RegistryError("invalid_request", "Choose a Pip.")
    dry_run = request.get("dry_run", False)
    if type(dry_run) is not bool:
        raise RegistryError("invalid_request", "dry_run is true or false.")
    if command == "give_pip_folder":
        return give(store, pip_id, request.get("folder"), actor, dry_run=dry_run)
    return remove(store, pip_id, actor, dry_run=dry_run)


# --------------------------------------------------------------------------------------------- the checks

def _table(db, name) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _live(store, pip_id) -> dict:
    from .pip_archive import require_live
    require_live(store, pip_id)
    return store._job(pip_id)


def _not_busy(store, job) -> None:
    db = store.db
    if db.execute("SELECT 1 FROM pip_runs WHERE pip_id=? AND status IN ('queued','running','cancelling') LIMIT 1",
                  (job["id"],)).fetchone():
        raise RegistryError("busy", f"{job['name']} is working right now. Wait for it to finish, or stop it, then try "
                                    "again.")
    if _table(db, "pip_agent_jobs"):
        from .pip_agents import LIVE
        marks = ",".join("?" * len(LIVE))
        if db.execute(f"SELECT 1 FROM pip_agent_jobs WHERE pip_id=? AND state IN ({marks}) LIMIT 1",
                      (job["id"], *LIVE)).fetchone():
            raise RegistryError("busy", f"A sub-agent of {job['name']}'s is working right now. Wait for it to finish, "
                                        "or stop it, then try again.")


def _folder(folder) -> Path:
    """The folder you gave it: one DGC opens as a project (Add a folder's own rules), and one a folder Pip can work in:
    listed among your projects (never a temporary one) and a Git project with a commit, at its top folder."""
    from . import project_folders, sessions
    root = project_folders.checked(folder)
    if sessions.not_a_project(root):
        raise RegistryError("invalid_request", "That folder is a temporary one, or DGC's own. Choose one of your "
                                               "projects.")
    from .pips import source_revision
    try:
        source_revision(root, "HEAD")
    except RegistryError as exc:
        if exc.code == "unsupported_source":
            raise RegistryError("unsupported_source", "Choose the top folder of that Git project, where its .git folder "
                                                      "is.") from None
        raise RegistryError("unsupported_source", f"{root.name or 'That folder'} isn't a Git project with a commit yet. "
                            "A Pip works on a folder's committed files: commit it once, then give it this folder.") from None
    return root


# --------------------------------------------------------------------------------------------- its next version

def _next_definition(job, *, to_folder: bool) -> tuple[dict, list[str]]:
    """Its job as a Pip made in its new place from the start would have it, everything of its own carried: (definition,
    what it couldn't take along)."""
    from .pips import PipStore, _definition, has_box
    merged = {key: job.get(key) for key in PipStore._OWN_KEYS}
    merged["pip_type"], merged["source_ref"] = job["pip_type"], "HEAD"
    dropped = []
    if to_folder:
        merged["source_policy"] = None                       # the folder's source rules for its type, as at creation
    else:
        merged["source_policy"] = {"mode": "personal"}
        for key in ("event_trigger", "verification_plan", "live_plan", "github_plan"):
            if merged.get(key) is not None:
                dropped.append(key)
                merged[key] = None
        # The box it had is its computer now; a folder Pip whose computer you removed stays without one.
        merged["computer_plan"] = merged.get("computer_plan") or ({"schema_version": 1} if has_box(job) else None)
    if merged.get("schedule") is not None:
        # A schedule's run is a check of its folder for a folder Pip and a task of its own for a Pip for anything: carried
        # over, it would quietly start doing the other. It stops, and is said; its routines (turns of its chat) go on.
        dropped.append("schedule")
        merged["schedule"] = None
    return _definition(**merged), dropped


# --------------------------------------------------------------------------------------------- what is pending

def _count(db, table, sql, args) -> int:
    return db.execute(f"SELECT count(*) FROM {table} WHERE {sql}", args).fetchone()[0] if _table(db, table) else 0


def _pending(store, job, *, removing: bool, folder_ws=None) -> dict:
    db, pip_id = store.db, job["id"]
    out = {
        "handoffs": _count(db, "pip_handoffs", "status='pending' AND (source_pip_id=? OR target_pip_id=?)", (pip_id, pip_id)),
        "actions": _count(db, "pip_app_actions", "status='pending' AND pip_id=?", (pip_id,)),
        "drafts": _count(db, "pip_message_drafts", "status='pending' AND pip_id=?", (pip_id,)),
        "proposals": db.execute("SELECT count(*) FROM pip_proposals WHERE pip_id=? AND status='proposed'",
                                (pip_id,)).fetchone()[0],
        "waiting_changes": 0, "undo": 0, "fixes": 0, "waiting": 0, "asked": 0, "learned": 0,
    }
    if _table(db, "pip_project_changes") and folder_ws is not None:
        out["waiting_changes"] = _count(db, "pip_project_changes", "pip_id=? AND workspace_id=? AND status='pending'",
                                        (pip_id, folder_ws))
        out["undo"] = _count(db, "pip_project_changes", "pip_id=? AND workspace_id=? AND status IN ('applied','partial')",
                             (pip_id, folder_ws))
    if removing:
        out["fixes"] = _count(db, "pip_fixes", "pip_id=? AND state IN ('ask','queued')", (pip_id,))
        out["waiting"] = _count(db, "pip_waiting", "pip_id=? AND state IN ('waiting','later')", (pip_id,))
        out["asked"] = _count(db, "pip_agent_jobs", "pip_id=? AND state IN ('asked','held')", (pip_id,))
        out["learned"] = (_count(db, "pip_checkpoints", "pip_id=? AND workspace_id=?", (pip_id, folder_ws))
                          + _count(db, "pip_memories", "pip_id=? AND workspace_id=?", (pip_id, folder_ws)))
    return out


def _plural(n, one, many=None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _words(job, name, *, to_folder: bool, boxed: bool, dropped, pending) -> tuple[list[str], list[str]]:
    """What stays and what changes, as its confirmation says it."""
    keeps = ["Its chat, notes and routines stay as they are.",
             "Its level, model and sub-agents stay as you set them."]
    if boxed:
        keeps.insert(1, "Its computer and everything in its Files stay." if to_folder else
                     f"Its computer and everything in its Files stay, with its copy of {name}.")
    elif to_folder:
        keeps.insert(1, f"It still has no computer: give it one on its page when you want it to work on a copy of {name}.")
    changes = []
    if to_folder:
        changes.append(f"It works on {name}: it reads {name}'s committed files"
                       + (f", and its computer gets its own copy of {name} to work in." if boxed else "."))
        if boxed:
            changes.append(f"{name} itself changes only when you apply what it changed (at Do it all it applies them by "
                           "itself, with Undo).")
    else:
        changes.append(f"It's a Pip for anything again: it no longer works on {name} by itself. Name @{name} in a message "
                       "to work on its copy again.")
    if pending["waiting_changes"]:
        keeps.append(f"Its change to {name} still waits for you on its card: Apply or Discard it there.")
    if pending["undo"]:
        keeps.append(f"Undo stays on what it applied to {name}.")
    said = {"schedule": "Its schedule stops; set one again on its page if you still want it. Its routines go on.",
            "event_trigger": f"It no longer runs by itself when {name} changes.",
            "verification_plan": f"Its approved commands for {name} go.",
            "live_plan": f"Its approved live data commands for {name} go.",
            "github_plan": f"It no longer reads {name}'s GitHub issues and pull requests."}
    changes += [said[key] for key in dropped if key in said]
    if pending["fixes"]:
        changes.append(f"{_plural(pending['fixes'], 'fix', 'fixes')} for {name} that waited for you close.")
    if pending["waiting"]:
        changes.append(f"{_plural(pending['waiting'], 'thing')} only you could do for {name} close.")
    if pending["asked"]:
        changes.append(f"{_plural(pending['asked'], 'sub-agent question')} about {name} close.")
    if pending["handoffs"]:
        changes.append(f"{_plural(pending['handoffs'], 'handoff')} waiting for your review close: hand it over again from "
                       "its chat.")
    if pending["actions"] or pending["drafts"]:
        count = pending["actions"] + pending["drafts"]
        changes.append(f"{_plural(count, 'message')} it prepared for you to send close: ask it again in its chat.")
    if pending["proposals"]:
        changes.append(f"{_plural(pending['proposals'], 'change')} to it waiting for your review wait on, written for its "
                       "new place where they still fit.")
    if pending["learned"]:
        changes.append(f"What it learned about {name}'s code stays with {name}, and comes back if you give it {name} again.")
    return keeps, changes


# --------------------------------------------------------------------------------------------- the move

def _close(store, job, actor, now, *, removing: bool, words: str) -> None:
    """Inside the move's transaction: what can't follow the Pip closes, each in its own way."""
    db, registry, pip_id = store.db, store.registry, job["id"]
    if _table(db, "pip_handoffs"):
        from .pip_handoffs import _resolve
        for row in db.execute("SELECT * FROM pip_handoffs WHERE status='pending' AND (source_pip_id=? OR target_pip_id=?)",
                              (pip_id, pip_id)).fetchall():
            _resolve(store, row, "expired", actor, now, words)
    if _table(db, "pip_app_actions"):
        db.execute("UPDATE pip_app_actions SET status='expired',resolved_by='folder_change',resolved_at=? "
                   "WHERE pip_id=? AND status='pending'", (now, pip_id))
    if _table(db, "pip_message_drafts"):
        db.execute("UPDATE pip_message_drafts SET status='dismissed' WHERE pip_id=? AND status='pending'", (pip_id,))
    if not removing:
        return
    if _table(db, "pip_fixes"):
        db.execute("UPDATE pip_fixes SET state='ended',note='folder_removed',message=?,revision=revision+1,updated_at=? "
                   "WHERE pip_id=? AND state IN ('ask','queued')",
                   ("Its folder was removed, so this fix closed.", now, pip_id))
    if _table(db, "pip_waiting"):
        db.execute("UPDATE pip_waiting SET state='dismissed',answered_at=?,updated_at=? WHERE pip_id=? "
                   "AND state IN ('waiting','later')", (now, now, pip_id))
    if _table(db, "pip_agent_jobs"):
        db.execute("UPDATE pip_agent_jobs SET state='left',said=?,ended_at=?,updated_at=? WHERE pip_id=? "
                   "AND state IN ('asked','held')", ("Its folder was removed, so this closed.", now, now, pip_id))


def _carry_reviews(store, job, version, actor, now) -> None:
    """A reviewed change still waiting for the user was written against the version before: superseded, and carried to
    the new version with the same request where it still fits its new place (as when a Pip changes itself)."""
    from . import pip_approvals
    from .pips import PipStore
    db = store.db
    waiting = db.execute("SELECT * FROM pip_proposals WHERE pip_id=? AND status='proposed' ORDER BY rowid",
                         (job["id"],)).fetchall()
    for other in db.execute("SELECT * FROM pip_approvals WHERE pip_id=? AND status='pending'", (job["id"],)).fetchall():
        pip_approvals.resolve(store.registry, other, "superseded", actor, now)
    db.execute("UPDATE pip_proposals SET status='superseded' WHERE pip_id=? AND status='proposed'", (job["id"],))
    for row in waiting:
        try:
            proposed = json.loads(row["definition"])
        except (TypeError, ValueError):
            continue
        carried = {key: proposed[key] for key in PipStore._OWN_KEYS
                   if key in proposed and proposed[key] != job.get(key) and key != "source_policy"}
        if not carried:
            continue
        try:
            with _Savepoint(db):
                store.propose(job["id"], version, carried, row["actor"], row["reason"],
                              expected_workspace_id=store._job(job["id"])["workspace_id"])
        except RegistryError:
            continue                             # it doesn't fit its new place: it stays superseded


class _Savepoint:
    """A savepoint inside the move's transaction: a carried review that doesn't fit leaves nothing half-written."""

    def __init__(self, db):
        self.db = db

    def __enter__(self):
        self.db.execute("SAVEPOINT pip_folder_carry")

    def __exit__(self, kind, value, trace):
        if kind is not None:
            self.db.execute("ROLLBACK TO pip_folder_carry")
        self.db.execute("RELEASE pip_folder_carry")
        return False


def _move(store, job, target, definition, actor, *, to_folder: bool, folder_ws, name) -> dict:
    """In one transaction: its next version, its new place, its own rows, what closes, and its events in both places."""
    from . import pip_levels
    from .pip_event_triggers import reset_trigger
    from .pip_limits import require_room
    from .pip_schedules import reset_schedule
    from .pips import _json, _set_box_off, has_box
    registry, db = store.registry, store.db
    with registry.transaction():
        now = registry.clock()
        fresh = _live(store, job["id"])
        if (fresh["current_version"], fresh["workspace_id"]) != (job["current_version"], job["workspace_id"]):
            raise RegistryError("conflict", f"{job['name']} changed just now. Refresh and try again.")
        _not_busy(store, fresh)
        require_room(db, target)
        version = job["current_version"] + 1
        if version >= 1000000:
            raise RegistryError("limit", f"{job['name']} has reached its version limit.")
        reason = f"Given the folder {name}" if to_folder else f"Its folder {name} removed"
        db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)", (job["id"], version, _json(definition), actor, reason, now))
        moved = db.execute("UPDATE pips SET workspace_id=?,current_version=?,updated_at=? WHERE id=? AND current_version=?",
                           (target, version, now, job["id"], job["current_version"]))
        if moved.rowcount != 1:
            raise RegistryError("conflict", f"{job['name']} changed just now. Refresh and try again.")
        _remember_home(db, job["id"], job["workspace_id"], target)
        reset_schedule(registry, job["id"], version, definition["schedule"], now)
        reset_trigger(registry, job["id"], version, definition["event_trigger"], now)
        if to_folder:
            # No computer stays no computer (a folder Pip otherwise has its box by default).
            _set_box_off(db, job["id"], definition.get("computer_plan") is None)
        else:
            _set_box_off(db, job["id"], False)
        for table in OWN_ROWS:
            if _table(db, table):
                db.execute(f"UPDATE {table} SET workspace_id=? WHERE pip_id=?", (target, job["id"]))
        if to_folder and has_box(store._job(job["id"])):
            # Its level was chosen for its computer: it governs its box in the folder too (pip_levels.level).
            row = db.execute("SELECT value FROM metadata WHERE key=?", (pip_levels.KEY + job["id"],)).fetchone()
            if row is not None:
                try:
                    saved = json.loads(row["value"])
                except (TypeError, ValueError):
                    saved = None
                if isinstance(saved, dict):
                    db.execute("UPDATE metadata SET value=? WHERE key=?",
                               (json.dumps({**saved, "box": True}), pip_levels.KEY + job["id"]))
        words = (f"{job['name']} now works in the folder {name}." if to_folder
                 else f"{job['name']} is a Pip for anything now.")
        _close(store, job, actor, now, removing=not to_folder, words=words)
        _carry_reviews(store, job, version, actor, now)
        payload = {"actor": actor, "version": version, "from_workspace_id": job["workspace_id"],
                   "to_workspace_id": target, "folder_workspace_id": folder_ws, "name": name[:160]}
        for space in dict.fromkeys((job["workspace_id"], target)):
            registry.event(space, GIVEN if to_folder else REMOVED, pip_id=job["id"], payload=payload)
    return store.get(job["id"])


def _answer(pip, folder, keeps, changes, *, done) -> dict:
    return {"pip": pip, "folder": folder, "keeps": keeps, "changes": changes, "done": done}


def give(store, pip_id, folder, actor, *, dry_run=False) -> dict:
    registry = store.registry
    job = _live(store, pip_id)
    if registry.get(job["workspace_id"])["kind"] != "personal":
        raise RegistryError("invalid_request", f"{job['name']} already works in a folder. Remove its folder first, then "
                                               "give it another.")
    if job["pip_type"] == "core":
        raise RegistryError("unavailable_pip_type", "Core is your Primary Pip and works on anything. Make another Pip "
                                                    "for a folder.")
    root = _folder(folder)
    _not_busy(store, job)
    workspace = registry.lookup(root) if dry_run else registry.resolve(root)
    name = (workspace["name"] if workspace else root.name)[:80] or "the folder"
    definition, dropped = _next_definition(job, to_folder=True)
    boxed = definition.get("computer_plan") is not None
    pending = _pending(store, job, removing=False, folder_ws=workspace["id"] if workspace else None)
    keeps, changes = _words(job, name, to_folder=True, boxed=boxed, dropped=dropped, pending=pending)
    place = {"name": name, "folder": str(root), "workspace_id": workspace["id"] if workspace else None}
    if dry_run:
        return _answer(store.get(pip_id), place, keeps, changes, done=False)
    pip = _move(store, job, workspace["id"], definition, actor, to_folder=True, folder_ws=workspace["id"], name=name)
    return _answer(pip, place, keeps, changes, done=True)


def remove(store, pip_id, actor, *, dry_run=False) -> dict:
    registry = store.registry
    job = _live(store, pip_id)
    here = registry.get(job["workspace_id"])
    if here["kind"] == "personal":
        raise RegistryError("invalid_request", f"{job['name']} has no folder to remove: it's a Pip for anything.")
    _not_busy(store, job)
    try:
        root = registry.binding(job["workspace_id"])["canonical_root"]
    except RegistryError:
        root = None
    name = here["name"][:80] or "its folder"
    definition, dropped = _next_definition(job, to_folder=False)
    boxed = definition.get("computer_plan") is not None
    pending = _pending(store, job, removing=True, folder_ws=job["workspace_id"])
    keeps, changes = _words(job, name, to_folder=False, boxed=boxed, dropped=dropped, pending=pending)
    place = {"name": name, "folder": root, "workspace_id": job["workspace_id"]}
    if dry_run:
        return _answer(store.get(pip_id), place, keeps, changes, done=False)
    personal = registry.personal()
    pip = _move(store, job, personal["id"], definition, actor, to_folder=False, folder_ws=job["workspace_id"], name=name)
    return _answer(pip, place, keeps, changes, done=True)
