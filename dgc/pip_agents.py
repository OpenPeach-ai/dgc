"""Sub-agents in a Pip's chat (0.52, his calls of 14 Nov; 052-plan/pip-subagents-plan.md).

A Pip hands a job (first: a fix) to a sub-agent and keeps talking with you. The sub-agent works in a copy of its own,
made from the Pip's copy of its folder when the job starts (files/agents/<job>/<folder> in the Pip's computer), with
the Pip's tools and level, never more. When it ends the Pip checks its work in its own chat (a message from DGC with
the change and the tests): PASS puts the change into the Pip's copy, three-way (a file the Pip's copy changed meanwhile
is held and said, never overwritten), and then it is the Pip's change as before (Apply, or applied at Do it all);
RETRY sends it back with the Pip's notes, three tries at most; after the last the Pip says what it tried and asks.

A sub-agent's turn is a conversation run with no chat rows (``manifest["agent"]``): it runs beside the Pip's chat, at
most ``slots`` at once for a Pip, and nothing that reads the Pip's chat (unread, previews, memory) ever sees it.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import secrets
import stat

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_agent_jobs(
 id TEXT PRIMARY KEY, pip_id TEXT NOT NULL REFERENCES pips(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 kind TEXT NOT NULL, fix_id TEXT, title TEXT NOT NULL, brief TEXT NOT NULL, folder TEXT, copy TEXT,
 base TEXT NOT NULL DEFAULT '{}', tries INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
 run_id TEXT, check_run_id TEXT, notes TEXT, verdict TEXT, held TEXT, said TEXT, reason TEXT, ended_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pip_agent_jobs_pip ON pip_agent_jobs(pip_id, state);
CREATE INDEX IF NOT EXISTS pip_agent_jobs_run ON pip_agent_jobs(run_id);
CREATE INDEX IF NOT EXISTS pip_agent_jobs_check ON pip_agent_jobs(check_run_id)
"""
MAX_TRIES = 3
SLOTS_DEFAULT, SLOTS_ULTRA = 1, 4
AGENT_KEY, CHECK_KEY = "dgcagent_", "dgccheck_"
SLOTS_KEY = "pip_agent_slots:"
DIFF_MOST = 60_000                          # characters of the change shown to the Pip's check
FILE_MOST = 2_000_000                       # a file bigger than this is listed, never diffed
# States: queued (no run yet) · working (its run) · check_due · checking (the Pip's check turn) · retry_due ·
# merged (its change is the Pip's now) · held (the Pip's copy changed the same files) · asked (after the last try) ·
# failed · stopped · left (Leave it: never asked again).
LIVE = ("queued", "working", "check_due", "checking", "retry_due")


def ensure(db) -> None:
    for statement in SCHEMA.strip().split(";"):
        if statement.strip():
            db.execute(statement)


def _has(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_agent_jobs'").fetchone() is not None


def _now(registry) -> str:
    return registry.clock()


def short(job_id: str) -> str:
    return job_id.split("_", 1)[1]


def _row(db, job_id):
    return db.execute("SELECT * FROM pip_agent_jobs WHERE id=?", (job_id,)).fetchone() if _has(db) else None


# ---- slots --------------------------------------------------------------------------------------------------------
def slots(registry, pip_id) -> int:
    """How many of its sub-agents a Pip runs at once: 1, 4 with Ultra (his call), any number Dev Mode allows."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SLOTS_KEY + pip_id,)).fetchone()
    try:
        value = int(json.loads(row[0])) if row else SLOTS_DEFAULT
    except (TypeError, ValueError):
        value = SLOTS_DEFAULT
    return max(1, value)


def set_slots(registry, pip_id, value) -> int:
    try:
        from .dev_mode import chosen
        most = chosen("pip_agent_slots") or SLOTS_ULTRA     # Dev Mode lifts the most (his call)
    except KeyError:
        most = SLOTS_ULTRA
    if type(value) is not int or not 1 <= value <= most:
        raise RegistryError("invalid_request", f"A Pip runs 1 to {most} sub-agents at once.")
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SLOTS_KEY + pip_id, json.dumps(value)))
    return value


# ---- its own copy -------------------------------------------------------------------------------------------------
def _files_root(registry, pip_id):
    from .pip_computer import computer_root
    from .pip_computer_files import files_root
    return files_root(computer_root(registry.directory, pip_id))


def copy_root(registry, pip_id, copy_rel):
    """Where a sub-agent's own copy is, in its Pip's computer."""
    return _files_root(registry, pip_id) / copy_rel


def _digest_file(path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _tree(root) -> dict:
    """{rel: sha256} of every regular file below root, never through a link."""
    from .pip_project_copies import DIR, _walk
    out = {}
    if not root.is_dir():
        return out
    fd = os.open(root, DIR)
    try:
        for rel, kind, _size, _mtime in _walk(fd):
            if kind == "file":
                out[rel] = _digest_file(root / rel)
    finally:
        os.close(fd)
    return out


def _copy_tree(src, dst) -> dict:
    """Copy src's regular files to dst (made fresh), never through a link; returns {rel: sha256} of what was copied."""
    import shutil
    from .pip_project_copies import DIR, _walk
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, mode=0o700)
    base = {}
    fd = os.open(src, DIR)
    try:
        for rel, kind, _size, _mtime in _walk(fd):
            if kind != "file":
                continue
            target = dst / rel
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(src / rel, target, follow_symlinks=False)
            base[rel] = _digest_file(target)
    finally:
        os.close(fd)
    return base


def _make_copy(store, pip_id, job_id):
    """The Pip's copy of its folder, brought up to date, copied for the job. (folder, copy_rel, base) or raises."""
    from . import pip_project_copies
    own = pip_project_copies.own_folder(store, pip_id)
    if not isinstance(own, dict) or not own.get("folder") or own.get("error"):
        raise RegistryError("unavailable", (own or {}).get("error") or "This Pip has no copy of a folder to work in.")
    folder = own["folder"]                                   # projects/<name>
    rel = f"agents/{short(job_id)}/{folder.rsplit('/', 1)[-1]}"
    root = _files_root(store.registry, pip_id)
    base = _copy_tree(root / folder, root / rel)
    return folder, rel, base


# ---- start a job ----------------------------------------------------------------------------------------------------
def start(store, config, pip_id, *, kind, title, brief, fix_id=None) -> dict:
    """A sub-agent job: its own copy, then its first run. A Pip whose slots are full queues it (its run waits)."""
    registry, db = store.registry, store.db
    ensure(db)
    job_id = "pipagent_" + secrets.token_hex(16)
    workspace_id = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
    folder, rel, base = _make_copy(store, pip_id, job_id)
    now = _now(registry)
    with registry.transaction():
        db.execute("INSERT INTO pip_agent_jobs(id,pip_id,workspace_id,kind,fix_id,title,brief,folder,copy,base,tries,state,"
                   "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,'queued',?,?)",
                   (job_id, pip_id, workspace_id, kind, fix_id, title[:200], brief, folder, rel, json.dumps(base), now, now))
    _run(store, config, job_id, brief)
    return view(db, _row(db, job_id))


def _run(store, config, job_id, text, *, counted=True):
    """Its next try: a conversation run with no chat rows, marked as this job's. `counted` False: a held step's carry-on,
    which isn't one of its three tries."""
    registry, db = store.registry, store.db
    row = _row(db, job_id)
    tries = row["tries"] + (1 if counted else 0)
    from .pip_routines import ACTOR as UNATTENDED_ACTOR
    key = f"{AGENT_KEY}{short(job_id)}_{tries}" + ("" if counted else f"_more{secrets.token_hex(3)}")
    request = {"text": text, "request_key": key,
               "agent": {"job_id": job_id, "folder": row["folder"], "copy": row["copy"], "try": tries}}
    run = store.enqueue(row["pip_id"], key, UNATTENDED_ACTOR, config, conversation_request=request)
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET run_id=?,tries=?,state='working',updated_at=? WHERE id=?",
                   (run["id"], tries, _now(registry), job_id))
    return run


# ---- its run ended: the Pip checks ----------------------------------------------------------------------------------
def is_fix_run(state_directory, run_id) -> bool:
    """Whether a run is a fix's own work: its sub-agent's try or the Pip's check of that work (careful mode lets it work
    in its box without holds: his call 15 Nov, A). False when it can't be told."""
    if not run_id or not state_directory:
        return False
    try:
        from .workspace_registry import WorkspaceRegistry
        with WorkspaceRegistry(state_directory) as registry:
            if not _has(registry.db):
                return False
            return registry.db.execute("SELECT 1 FROM pip_agent_jobs WHERE run_id=? OR check_run_id=? LIMIT 1",
                                       (run_id, run_id)).fetchone() is not None
    except Exception:                                    # noqa: BLE001 -- unknown: careful mode as before
        return False


def job_of_run(db, run_id):
    return db.execute("SELECT * FROM pip_agent_jobs WHERE run_id=?", (run_id,)).fetchone() if _has(db) else None


def change(registry, row) -> list[dict]:
    """What the sub-agent changed in its copy since the job started: each file, added/changed/removed, with its diff."""
    root = copy_root(registry, row["pip_id"], row["copy"])
    base, now = json.loads(row["base"] or "{}"), _tree(root)
    files = []
    from .pip_project_copies import leftover
    for rel in sorted(set(base) | set(now)):
        if base.get(rel) == now.get(rel):
            continue
        if leftover(rel):
            continue           # what a test run leaves behind is never its change, new or already in the copy (15 Nov)
        state = "added" if rel not in base else "removed" if rel not in now else "changed"
        files.append({"path": rel, "state": state, "sha256": now.get(rel)})
    return files


def diff_text(registry, row, files) -> str:
    """The change as a unified diff against the Pip's copy, clipped for the check."""
    root, pip_root = copy_root(registry, row["pip_id"], row["copy"]), _files_root(registry, row["pip_id"]) / row["folder"]
    parts, used = [], 0
    for f in files:
        rel = f["path"]
        def lines(path):
            try:
                if path.stat().st_size > FILE_MOST:
                    return None
                data = path.read_bytes()
            except OSError:
                return []
            if b"\x00" in data[:8192]:
                return "binary"                             # never pasted into the Pip's chat (a NUL is refused there)
            return data.decode("utf-8", errors="replace").splitlines(keepends=True)
        old = lines(pip_root / rel) if f["state"] != "added" else []
        new = lines(root / rel) if f["state"] != "removed" else []
        if old == "binary" or new == "binary":
            chunk = f"--- {rel} (binary, {f['state']}, not shown)\n"
        elif old is None or new is None:
            chunk = f"--- {rel} (too big to show)\n"
        else:
            chunk = "".join(difflib.unified_diff(old, new, f"a/{rel}", f"b/{rel}"))
        if used + len(chunk) > DIFF_MOST:
            parts.append(f"… and {len(files) - len(parts)} more file(s) not shown.\n")
            break
        parts.append(chunk)
        used += len(chunk)
    return "".join(parts)


CARRY_KEY = "pip_agent_carry:"                  # metadata: a held step allowed while its try still ran


def after_held_step(store, config, job_id, summary) -> None:
    """You allowed a step its sub-agent held (careful mode, on something leaving its computer): it carries on in its
    own next try, which isn't one of its three. A try that still runs carries on once it ends."""
    db, registry = store.db, store.registry
    row = _row(db, job_id)
    if row is None:
        return None
    what = " ".join(str(summary.get(k) or "") for k in ("method", "host") if isinstance(summary, dict)).strip() or "it"
    note = f"The step DGC held for the user ({what}) was allowed and done. Carry on from there with the rest of the job."
    with registry.transaction():
        if row["state"] == "working":
            db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)", (CARRY_KEY + job_id, note))
        elif row["state"] in ("check_due", "retry_due"):
            db.execute("UPDATE pip_agent_jobs SET state='retry_due',notes=?,updated_at=? WHERE id=?",
                       (note, _now(registry), job_id))
            db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)", (CARRY_KEY + job_id, "uncounted"))
    return None


def after_agent_run(store, run, status, result, error) -> None:
    """Its try ended: due for the Pip's check (a failed or stopped run is said, never retried by itself)."""
    db, registry = store.db, store.registry
    row = job_of_run(db, run["id"])
    if row is None or row["state"] != "working":
        return
    text = str((result or {}).get("text") or "") if isinstance(result, dict) else ""
    carry = db.execute("SELECT value FROM metadata WHERE key=?", (CARRY_KEY + row["id"],)).fetchone()
    if status == "succeeded" and carry is not None and carry[0] != "uncounted":
        with registry.transaction():                     # a held step was allowed meanwhile: its carry-on, first
            db.execute("UPDATE pip_agent_jobs SET state='retry_due',said=?,notes=?,updated_at=? WHERE id=?",
                       (text[:4000], carry[0], _now(registry), row["id"]))
            db.execute("UPDATE metadata SET value='uncounted' WHERE key=?", (CARRY_KEY + row["id"],))
        return
    with registry.transaction():
        if status == "succeeded":
            db.execute("UPDATE pip_agent_jobs SET state='check_due',said=?,updated_at=? WHERE id=?",
                       (text[:4000], _now(registry), row["id"]))
        else:
            db.execute("UPDATE pip_agent_jobs SET state=?,said=?,updated_at=? WHERE id=?",
                       ("stopped" if status == "cancelled" else "failed", str(error or text)[:1000], _now(registry), row["id"]))
    if status != "succeeded":
        _job_ended(store, _row(db, row["id"]))


CHECK_TEXT = (
    "This message is from DGC, not the user. A sub-agent you handed a job to has finished try {try_} of {most}. Check its "
    "work before anything reaches your copy: read the change below and what it said about its tests. Tell the user in a "
    "few plain sentences what you found (don't paste the diff). Then end your reply with one line per finding the "
    "change settles, \"FINDING n: fixed\", \"FINDING n: already fixed\", \"FINDING n: not a defect\" or \"FINDING n: needs "
    "you\", each followed by \" — \" and why in a few words, and a last line \"RESULT: PASS\" when the change is right, or "
    "\"RESULT: RETRY — what the sub-agent must do differently\" to send it back (it carries on in its copy).\n\n"
    "The job: {title}\n{findings}\n\nWhat the sub-agent said:\n{said}\n\nThe change ({count} file(s)):\n{diff}")


def _findings(db, row) -> list:
    if not row["fix_id"]:
        return []
    fix = db.execute("SELECT findings FROM pip_fixes WHERE id=?", (row["fix_id"],)).fetchone()
    try:
        return json.loads(fix[0]) if fix else []
    except ValueError:
        return []


def send_due(registry, config) -> int:
    """The supervisor's tick: each due check (into the Pip's own chat, when it is free) and each due retry."""
    db = registry.db
    if not _has(db):
        return 0
    from .pips import PipStore
    from . import pip_chat
    from .pip_routines import ACTOR as UNATTENDED_ACTOR
    store, sent = PipStore(registry), 0
    for row in db.execute("SELECT * FROM pip_agent_jobs WHERE state IN ('check_due','retry_due') ORDER BY updated_at LIMIT 20").fetchall():
        if row["state"] == "retry_due":
            carry = db.execute("SELECT value FROM metadata WHERE key=?", (CARRY_KEY + row["id"],)).fetchone()
            _run(store, config, row["id"], _retry_text(row, carry=carry is not None), counted=carry is None)
            if carry is not None:
                with registry.transaction():
                    db.execute("DELETE FROM metadata WHERE key=?", (CARRY_KEY + row["id"],))
            sent += 1
            continue
        files = change(registry, row)
        findings = _findings(db, row)
        text = CHECK_TEXT.format(try_=row["tries"], most=MAX_TRIES, title=row["title"],
                                 findings="\n".join(f"FINDING {n}: {f.get('title', '')} — {f.get('path', '')}:{f.get('line', '')}"
                                                    for n, f in enumerate(findings, 1)),
                                 said=row["said"] or "(nothing)", count=len(files),
                                 diff=diff_text(registry, row, files) or "(no change)")
        try:
            answer = pip_chat._send_in(store, row["pip_id"], text.replace("\x00", ""),
                                       f"{CHECK_KEY}{short(row['id'])}_{row['tries']}", UNATTENDED_ACTOR, config, None)
        except RegistryError as exc:
            if exc.code == "conversation_busy":
                continue                                    # its chat is answering you: the next tick
            # Anything else won't pass on the next tick either (live test 15 Nov: it hung at check_due, "1 sub-agent"
            # with nothing happening): the job ends, and the Pip's message says why.
            with registry.transaction():
                db.execute("UPDATE pip_agent_jobs SET state='failed',said=?,updated_at=? WHERE id=?",
                           (f"its check couldn't be sent to the Pip's chat: {exc}"[:2000], _now(registry), row["id"]))
            _job_ended(store, _row(db, row["id"]))
            continue
        run_id = ((answer or {}).get("run") or {}).get("id")
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state='checking',check_run_id=?,updated_at=? WHERE id=?",
                       (run_id, _now(registry), row["id"]))
        sent += 1
    return sent


def _retry_text(row, *, carry=False) -> str:
    if carry:                                             # a held step was allowed: not a try the Pip sent back
        return (f"{row['notes']} What you did so far is still in your copy. Finish the job: {row['title']}.\n\n{row['brief']}")
    return (f"Try {row['tries'] + 1} of {MAX_TRIES}. Your Pip checked your last try and sent it back: {row['notes'] or 'it was not right yet'}. "
            f"Carry on in your copy (what you did so far is still there) and finish the job: {row['title']}.\n\n{row['brief']}")


_RESULT = re.compile(r"^\s*RESULT:\s*(PASS|RETRY)\b\s*[—\-:]*\s*(.*)$", re.I | re.M)


def check_of_run(db, run_id):
    return db.execute("SELECT * FROM pip_agent_jobs WHERE check_run_id=?", (run_id,)).fetchone() if _has(db) else None


def after_check_turn(store, run, status, result) -> None:
    """The Pip's check ended: PASS puts the change in its copy; RETRY sends it back (three tries at most)."""
    db, registry = store.db, store.registry
    row = check_of_run(db, run["id"])
    if row is None or row["state"] != "checking":
        return
    text = str((result or {}).get("text") or "") if isinstance(result, dict) else ""
    found = _RESULT.findall(text)
    verdict, notes = (found[-1][0].upper(), found[-1][1].strip()) if found else ("", "")
    if status != "succeeded" or not verdict:
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state='check_due',updated_at=? WHERE id=?", (_now(registry), row["id"]))
        return                                              # (a check that said nothing is asked again next tick)
    if verdict == "RETRY":
        state = "retry_due" if row["tries"] < MAX_TRIES else "asked"
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state=?,verdict=?,notes=?,reason=?,updated_at=? WHERE id=?",
                       (state, text[-4000:], notes[:2000], reason_of(text), _now(registry), row["id"]))
        if state == "asked":
            _job_ended(store, _row(db, row["id"]))
        return
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET verdict=?,updated_at=? WHERE id=?", (text[-4000:], _now(registry), row["id"]))
    merge(store, _row(db, row["id"]))


def merge(store, row) -> None:
    """PASS: its change into the Pip's copy, three-way. A file the Pip's copy changed since the job began is held."""
    import shutil
    registry, db = store.registry, store.db
    pip_root = _files_root(registry, row["pip_id"]) / row["folder"]
    mine, base = copy_root(registry, row["pip_id"], row["copy"]), json.loads(row["base"] or "{}")
    files, held = change(registry, row), []
    for f in files:
        rel = f["path"]
        target = pip_root / rel
        try:
            now = _digest_file(target) if target.is_file() and not target.is_symlink() else None
        except OSError:
            now = None
        if now != base.get(rel):
            held.append(rel)
    if not held:
        for f in files:
            rel, target = f["path"], pip_root / f["path"]
            if f["state"] == "removed":
                if target.is_file() and not target.is_symlink():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(mine / rel, target, follow_symlinks=False)
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET state=?,held=?,updated_at=? WHERE id=?",
                   ("held" if held else "merged", json.dumps(held) if held else None, _now(registry), row["id"]))
    _job_ended(store, _row(db, row["id"]))


def reason_of(text: str) -> str:
    """The Pip's own words from its check, without the lines meant for DGC (FINDING, TESTS, RESULT): what the chat shows
    when it sends the work back ("Not yet: an empty cart breaks it.")."""
    from .pip_fixes import shown_text
    return " ".join(shown_text(text).split())[:600]


def leave(store, row) -> None:
    """Leave it: the job is done with; nothing more is tried or asked."""
    with store.registry.transaction():
        store.db.execute("UPDATE pip_agent_jobs SET state='left',updated_at=? WHERE id=?", (_now(store.registry), row["id"]))


def _job_ended(store, row) -> None:
    """Tell the fix it belongs to (pip_fixes) what became of it."""
    if row is not None and not row["ended_at"]:
        with store.registry.transaction():
            store.db.execute("UPDATE pip_agent_jobs SET ended_at=? WHERE id=?", (_now(store.registry), row["id"]))
        row = _row(store.db, row["id"])
    if row is None or not row["fix_id"]:
        return
    from . import pip_fixes
    pip_fixes.after_agent_job(store, row)


# ---- what the editor reads ------------------------------------------------------------------------------------------
def view(db, row) -> dict:
    run = db.execute("SELECT status,started_at,finished_at,manifest FROM pip_runs WHERE id=?", (row["run_id"],)).fetchone() \
        if row["run_id"] else None
    model = ""
    if run is not None:
        try:
            model = str((json.loads(run["manifest"]) or {}).get("model") or "")
        except ValueError:
            model = ""
    return {"id": row["id"], "pip_id": row["pip_id"], "kind": row["kind"], "fix_id": row["fix_id"], "title": row["title"],
            "state": row["state"], "try": row["tries"], "tries": MAX_TRIES, "run_id": row["run_id"],
            "run_status": run["status"] if run else None, "started_at": run["started_at"] if run else None,
            "model": model, "held": json.loads(row["held"]) if row["held"] else [], "notes": row["notes"] or "",
            "said": row["reason"] or "", "check_run_id": row["check_run_id"], "ended_at": row["ended_at"],
            "created_at": row["created_at"], "updated_at": row["updated_at"]}


def listing(store, pip_id) -> dict:
    db = store.db
    if not _has(db):
        return {"agents": [], "slots": slots(store.registry, pip_id)}
    rows = db.execute("SELECT * FROM pip_agent_jobs WHERE pip_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50", (pip_id,)).fetchall()
    return {"agents": [view(db, row) for row in rows], "slots": slots(store.registry, pip_id)}


def stop(store, pip_id, job_id, actor) -> dict:
    """Stop a sub-agent: its run is cancelled; nothing of its copy reaches the Pip's."""
    db, registry = store.db, store.registry
    row = _row(db, job_id)
    if row is None or row["pip_id"] != pip_id:
        raise RegistryError("not_found", "That sub-agent isn't this Pip's.")
    if row["state"] not in LIVE:
        return view(db, row)
    if row["run_id"] and row["state"] == "working":
        try:
            store.cancel(row["run_id"], actor)
        except RegistryError:
            pass
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET state='stopped',updated_at=? WHERE id=?", (_now(registry), job_id))
    _job_ended(store, _row(db, job_id))
    return view(db, _row(db, job_id))
