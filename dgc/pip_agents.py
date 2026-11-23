"""Sub-agents in a Pip's chat (0.52).

A Pip hands a job (first: a fix) to a sub-agent and keeps talking with you. The sub-agent works in a copy of its own,
made from the Pip's copy of its folder when the job starts (files/agents/<job>/<folder> in the Pip's computer), with
the Pip's tools and level, never more. When it ends the Pip checks its work in its own chat (a message from DGC with
the change and the tests): PASS puts the change into the Pip's copy, three-way (a file the Pip's copy changed meanwhile
is held and said, never overwritten), and then it is the Pip's change as before (Apply, or applied at Do it all);
RETRY sends it back with the Pip's notes, three tries at most; after the last the Pip says what it tried and asks.

A sub-agent's turn is a conversation run with no chat rows (``manifest["agent"]``): it runs beside the Pip's chat, at
most ``slots`` at once for a Pip, and nothing that reads the Pip's chat (unread, previews, memory) ever sees it.

Its own model (Pips API 104): ``set_pip_agents`` also takes the model a Pip's sub-agents run on (``model_choice``: "This
Pip's model" by default, a model on DGC's own connection, or a saved provider's), their ``thinking``, their
``context_size`` and their ``fallback``, kept in metadata ``pip_agent_model:<pip>``. A sub-agent job's run runs on them
and carries on with that fallback; every run of the Pip gives DGC's own helpers inside it the same settings
(``for_worker``, read from today's settings when the run starts, never kept in a manifest). A subscription CLI and DGC
Router are refused.
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
    """How many of its sub-agents a Pip runs at once: 1, 4 with Ultra, any number Dev Mode allows."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (SLOTS_KEY + pip_id,)).fetchone()
    try:
        value = int(json.loads(row[0])) if row else SLOTS_DEFAULT
    except (TypeError, ValueError):
        value = SLOTS_DEFAULT
    return max(1, value)


def _valid_slots(value) -> int:
    try:
        from .dev_mode import chosen
        most = chosen("pip_agent_slots") or SLOTS_ULTRA     # Dev Mode lifts the most
    except KeyError:
        most = SLOTS_ULTRA
    if type(value) is not int or not 1 <= value <= most:
        raise RegistryError("invalid_request", f"A Pip runs 1 to {most} sub-agents at once.")
    return value


def set_slots(registry, pip_id, value) -> int:
    value = _valid_slots(value)
    with registry.transaction():
        registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SLOTS_KEY + pip_id, json.dumps(value)))
    return value


# ---- its own model (Pips API 104) -----------------------------------------------------------------------------------
MODEL_KEY = "pip_agent_model:"              # metadata: JSON {model_choice, thinking, context_size, fallback}
MODEL_FIELDS = ("model_choice", "thinking", "context_size", "fallback")
CONTEXT_MOST = 16_777_216                   # what DGC's own sub-agents' window takes (config.subagent_window_arg)
NO_CLI = "It runs its own tools, so it can’t run DGC’s sub-agents."
NO_ROUTER = ("DGC Router can’t run a Pip’s sub-agents: a Pip’s run holds one of its systems at most. Choose a model "
             "or a saved provider.")


def _model_defaults() -> dict:
    return {"model_choice": {"mode": "default"}, "thinking": "", "context_size": 0,
            "fallback": {"provider": "", "model": ""}}


def _valid_choice(value) -> dict:
    """The Pip's model_choice shape: "This Pip's model" (default), a model on DGC's own connection, or a saved
    provider's. Never a subscription CLI (it runs its own tools) or DGC Router."""
    from .pip_models import validate_model_choice
    choice = validate_model_choice(value)
    if choice["mode"] == "subscription":
        raise RegistryError("invalid_model_choice", NO_CLI)
    if choice["mode"] == "router":
        raise RegistryError("invalid_model_choice", NO_ROUTER)
    return choice


def _valid_thinking(value) -> str:
    from .pip_chat_options import THINKING_LEVELS
    if type(value) is not str or value not in ("", *THINKING_LEVELS):
        raise RegistryError("invalid_request", 'thinking is "" (the same as the Pip), off, low, medium, high or xhigh.')
    return value


def _valid_context(value) -> int:
    if type(value) is not int or not (value == 0 or 2_048 <= value <= CONTEXT_MOST):
        raise RegistryError("invalid_request", "context_size is 0 (the same as the Pip) or 2,048 to 16,777,216 tokens.")
    return value


def _valid_fallback(value) -> dict:
    """{provider, model} as a Pip's fallback is kept (pip_backup): a model DGC runs itself, never a CLI or the Router."""
    if not isinstance(value, dict):
        raise RegistryError("invalid_request", "fallback is {provider, model}: model \"\" for none.")
    if "engine" in value or "router" in value:
        raise RegistryError("invalid_request", "A sub-agents’ fallback is a model DGC runs itself: never a subscription "
                                               "CLI or DGC Router.")
    if set(value) - {"provider", "model"}:
        raise RegistryError("invalid_request", "fallback takes only provider and model.")
    from .pip_backup import _choice
    return _choice(value.get("model", ""), value.get("provider", ""))


_VALID = {"model_choice": _valid_choice, "thinking": _valid_thinking, "context_size": _valid_context,
          "fallback": _valid_fallback}


def agents_model(registry, pip_id) -> dict:
    """What a Pip's sub-agents run on: {model_choice, thinking, context_size, fallback}. A value that can't be read is
    the default ("This Pip's model", its thinking and window, no fallback of their own)."""
    out = _model_defaults()
    try:
        row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (MODEL_KEY + str(pip_id),)).fetchone()
        stored = json.loads(row[0]) if row else {}
    except (TypeError, ValueError):
        stored = {}
    if not isinstance(stored, dict):
        return out
    for field in MODEL_FIELDS:
        if field in stored:
            try:
                out[field] = _VALID[field](stored[field])
            except RegistryError:
                pass                                         # unreadable: its default
    return out


def configure(registry, pip_id, request) -> dict:
    """set_pip_agents: slots and its own model, each optional, at least one; a field not given keeps its value. Every
    field is checked before anything is written. Answers {slots, model_choice, thinking, context_size, fallback}."""
    given = [field for field in ("slots", *MODEL_FIELDS) if field in request]
    if not given:
        raise RegistryError("invalid_request", "Give slots, model_choice, thinking, context_size or fallback.")
    slots_value = _valid_slots(request["slots"]) if "slots" in request else None
    chosen = agents_model(registry, pip_id)
    for field in MODEL_FIELDS:
        if field in request:
            chosen[field] = _VALID[field](request[field])
    with registry.transaction():
        if slots_value is not None:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (SLOTS_KEY + pip_id, json.dumps(slots_value)))
        if set(given) & set(MODEL_FIELDS):
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (MODEL_KEY + pip_id, json.dumps(chosen)))
    return {"slots": slots(registry, pip_id), **agents_model(registry, pip_id)}


def own_choice(agents) -> dict | None:
    """The model choice a sub-agent job's run takes in place of its Pip's, or None for "This Pip's model"."""
    choice = agents["model_choice"]
    return None if choice.get("mode") == "default" else choice


def job_settings(settings, agents, config) -> dict:
    """A sub-agent job's model settings: its thinking and window in place of the Pip's chat options, where set."""
    out = dict(settings)
    if agents["thinking"]:
        from .pip_chat_options import apply
        out = apply(out, {"context_size": out["context_size"], "thinking": agents["thinking"]}, config)
    if agents["context_size"]:
        out["context_size"] = agents["context_size"]
    return out


def _route(config, provider, model) -> dict | None:
    """{model, base_url, api_mode, api_key}: a model on DGC's own connection (provider "") or a saved provider's, from
    today's settings. None when that connection has no web address. A removed provider raises, in plain words."""
    if provider:
        from .pip_models import provider_view
        config = provider_view(config, {"provider": provider, "model": model})
    base = str(config.get("base_url", "") or "").rstrip("/")
    if not base.startswith(("http://", "https://")):
        return None
    return {"model": model, "base_url": base, "api_mode": str(config.get("api_mode", "auto") or "auto"),
            "api_key": str(config.get("api_key", "") or "")}


def for_worker(registry, config, pip_id) -> dict | None:
    """What DGC's own helpers inside any run of this Pip follow: the subagent_* settings its worker sets, read from
    today's settings when the run starts (a saved provider's address, API and key), never kept in a manifest. None when
    nothing is set, and when the chosen provider was removed (the run's helpers stay as they are). A fallback whose
    provider was removed is left out: no fallback, never another."""
    agents = agents_model(registry, pip_id)
    out = {}
    choice = own_choice(agents)
    if choice is not None:
        try:
            route = _route(config, choice.get("provider", ""), choice["model"])
        except RegistryError:
            return None
        if route is None:
            return None
        out.update(subagent_model=route["model"], subagent_base_url=route["base_url"],
                   subagent_api_mode=route["api_mode"], subagent_api_key=route["api_key"])
    if agents["thinking"]:
        out["subagent_thinking"] = agents["thinking"]
    if agents["context_size"]:
        out["subagent_context_size"] = agents["context_size"]
    fallback = agents["fallback"]
    if fallback["model"]:
        try:
            route = _route(config, fallback["provider"], fallback["model"])
        except RegistryError:
            route = None
        if route is not None:
            out.update(subagent_fallback_model=route["model"], subagent_fallback_base_url=route["base_url"],
                       subagent_fallback_api_mode=route["api_mode"], subagent_fallback_api_key=route["api_key"])
    return out or None


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
def start(store, config, pip_id, *, kind, title, brief, fix_id=None, words=None) -> dict:
    """A sub-agent job: its own copy, then its first run. A Pip whose slots are full queues it (its run waits).
    kind "work" (pip_work_agents): no copy, a real Work run in the Pip's folder itself, on its Sub-agents model (never
    a subscription CLI or DGC Router: refused before anything starts); `words` are the user's own words it carries."""
    registry, db = store.registry, store.db
    ensure(db)
    job_id = "pipagent_" + secrets.token_hex(16)
    workspace_id = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
    if kind == "work":
        from . import pip_work_agents as work
        root = work.folder_of(store, pip_id)
        work.route_check(store, config, pip_id)
        folder, rel, base = str(root), None, {}
    else:
        folder, rel, base = _make_copy(store, pip_id, job_id)
    now = _now(registry)
    with registry.transaction():
        db.execute("INSERT INTO pip_agent_jobs(id,pip_id,workspace_id,kind,fix_id,title,brief,folder,copy,base,tries,state,"
                   "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,'queued',?,?)",
                   (job_id, pip_id, workspace_id, kind, fix_id, title[:200], brief, folder, rel, json.dumps(base), now, now))
        if kind == "work":
            work.save_state(registry, job_id, words=work.words_of(words or []))
    try:
        _run(store, config, job_id, _first_text(store, _row(db, job_id)))
    except RegistryError as exc:
        # Its run was refused (its sub-agents' provider was removed, say): it ends here in those words, never left
        # queued with no run. The caller says why.
        ended = _now(registry)
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state='failed',said=?,ended_at=?,updated_at=? WHERE id=?",
                       (str(exc)[:1000], ended, ended, job_id))
        raise
    return view(db, _row(db, job_id))


def _first_text(store, row) -> str:
    """What its first try is sent: the brief; for a work job, DGC's framing with the user's own words quoted as theirs."""
    if row["kind"] != "work":
        return row["brief"]
    from . import pip_work_agents as work
    return work.first_prompt(store, row, work.words_of(work.state(store.db, row["id"]).get("words")))


def insert_queued(store, pip_id, *, kind, title, brief, fix_id=None, folder=None, words=None) -> str:
    """A job kept now and started on the supervisor's next tick (send_due): what a Pip's reply asked for, kept inside
    that reply's own transaction, where no run can be queued yet. Returns its id."""
    registry, db = store.registry, store.db
    ensure(db)
    job_id = "pipagent_" + secrets.token_hex(16)
    workspace_id = db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()[0]
    now = _now(registry)
    db.execute("INSERT INTO pip_agent_jobs(id,pip_id,workspace_id,kind,fix_id,title,brief,folder,copy,base,tries,state,"
               "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,'{}',0,'queued',?,?)",
               (job_id, pip_id, workspace_id, kind, fix_id, title[:200], brief, folder, now, now))
    if kind == "work":
        from . import pip_work_agents as work
        work.save_state(registry, job_id, words=work.words_of(words or []))
    return job_id


def _run(store, config, job_id, text, *, counted=True):
    """Its next try: a conversation run with no chat rows, marked as this job's. `counted` False: a held step's carry-on,
    which isn't one of its three tries."""
    registry, db = store.registry, store.db
    row = _row(db, job_id)
    tries = row["tries"] + (1 if counted else 0)
    from .pip_routines import ACTOR as UNATTENDED_ACTOR
    key = f"{AGENT_KEY}{short(job_id)}_{tries}" + ("" if counted else f"_more{secrets.token_hex(3)}")
    request = {"text": text, "request_key": key,
               "agent": {"job_id": job_id, "folder": row["folder"], "copy": row["copy"], "try": tries,
                         **({"work": True} if row["kind"] == "work" else {})}}
    run = store.enqueue(row["pip_id"], key, UNATTENDED_ACTOR, config, conversation_request=request)
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET run_id=?,tries=?,state='working',updated_at=? WHERE id=?",
                   (run["id"], tries, _now(registry), job_id))
    return run


# ---- its run ended: the Pip checks ----------------------------------------------------------------------------------
def is_fix_run(state_directory, run_id) -> bool:
    """Whether a run is a fix's own work: its sub-agent's try or the Pip's check of that work (careful mode lets it work
    in its box without holds: decided 15 Nov, A). False when it can't be told."""
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
    """What the sub-agent changed in its copy since the job started: each file, added/changed/removed, with its diff.
    A work job's is what it changed in the folder itself (its session's checkpoints, pip_work_agents.changes)."""
    if row["kind"] == "work":
        from . import pip_work_agents as work
        return work.changes(registry, row)
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
    if row["kind"] == "work":
        from . import pip_work_agents as work
        return work.diff_text(registry, row, files)
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
    _settle_lost(store)
    for row in db.execute("SELECT * FROM pip_agent_jobs WHERE state='queued' AND run_id IS NULL ORDER BY created_at "
                          "LIMIT 20").fetchall():
        # Kept by a Pip's reply (insert_queued), started now: its first try, in a slot of the Pip's sub-agents.
        try:
            if row["kind"] == "work":
                from . import pip_work_agents as work
                work.folder_of(store, row["pip_id"])
                work.route_check(store, config, row["pip_id"])
            _run(store, config, row["id"], _first_text(store, row))
        except RegistryError as exc:
            if exc.code in ("runner_stopped", "limit"):
                continue
            with registry.transaction():
                db.execute("UPDATE pip_agent_jobs SET state='failed',said=?,ended_at=?,updated_at=? WHERE id=?",
                           (str(exc)[:1000], _now(registry), _now(registry), row["id"]))
            _job_ended(store, _row(db, row["id"]))
            continue
        sent += 1
    for row in db.execute("SELECT * FROM pip_agent_jobs WHERE state IN ('check_due','retry_due') ORDER BY updated_at LIMIT 20").fetchall():
        if row["state"] == "retry_due":
            carry = db.execute("SELECT value FROM metadata WHERE key=?", (CARRY_KEY + row["id"],)).fetchone()
            try:
                _run(store, config, row["id"], _retry_text(row, carry=carry is not None, store=store), counted=carry is None)
            except RegistryError as exc:
                if exc.code in ("runner_stopped", "limit"):
                    continue                                # Pips are paused or the queue is full: the next tick
                # Anything else (its sub-agents' provider was removed, say) won't run on the next tick either: the
                # job ends, in those words.
                with registry.transaction():
                    db.execute("UPDATE pip_agent_jobs SET state='failed',said=?,updated_at=? WHERE id=?",
                               (str(exc)[:1000], _now(registry), row["id"]))
                _job_ended(store, _row(db, row["id"]))
                continue
            if carry is not None:
                with registry.transaction():
                    db.execute("DELETE FROM metadata WHERE key=?", (CARRY_KEY + row["id"],))
            sent += 1
            continue
        files = change(registry, row)
        findings = _findings(db, row)
        if row["kind"] == "work":
            from . import pip_work_agents as work
            template = work.CHECK_TEXT                   # its change is in the real folder already
        else:
            template = CHECK_TEXT
        text = template.format(try_=row["tries"], most=MAX_TRIES, title=row["title"],
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


def _settle_lost(store) -> None:
    """A job whose try's run ended with nobody to say so (the runner stopped or restarted while it ran: recover() ends
    such a run, and a Work run is never run again by itself) never stays working: stopped, in those words."""
    registry, db = store.registry, store.db
    rows = db.execute("SELECT j.id, r.status AS run_status, r.error AS run_error, r.finished_at FROM pip_agent_jobs j "
                      "JOIN pip_runs r ON r.id=j.run_id WHERE j.state='working' AND r.status IN ('failed','cancelled') "
                      "LIMIT 50").fetchall()
    from datetime import timedelta
    from .pip_fixes import _instant
    now = _instant(_now(registry))
    for found in rows:
        try:
            code = str((json.loads(found["run_error"] or "{}") or {}).get("code") or "")
        except (TypeError, ValueError, AttributeError):
            code = ""
        restarted = code.startswith(("interrupted", "restart"))
        ended = _instant(found["finished_at"])
        if not restarted and (now is None or ended is None or now - ended < timedelta(seconds=60)):
            continue                                     # (its own runner says how it ended, a moment from now)
        row = _row(db, found["id"])
        if row["kind"] == "work":
            from . import pip_work_agents as work
            said = work.RESTARTED if restarted else ("It was stopped. What it changed stays in your folder; Undo puts it back."
                                                     if found["run_status"] == "cancelled" else
                                                     "Its run ended with an error. What it changed stays in your folder; "
                                                     "Undo puts it back.")
            try:
                work.remember_changes(registry, row)
            except Exception:                            # noqa: BLE001 -- its card says what it can
                pass
        else:
            said = ("DGC's Pips restarted while it worked, so it was stopped." if restarted else
                    "It was stopped." if found["run_status"] == "cancelled" else "Its run ended with an error.")
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state=?,said=?,updated_at=? WHERE id=? AND state='working'",
                       ("stopped" if restarted or found["run_status"] == "cancelled" else "failed", said[:1000],
                        _now(registry), row["id"]))
        _job_ended(store, _row(db, row["id"]))


def _retry_text(row, *, carry=False, store=None) -> str:
    if row["kind"] == "work" and store is not None:
        from . import pip_work_agents as work
        return work.retry_prompt(store, row, carry=carry)
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
        # (A work job's PASS keeps the Pip's own words too: its chat shows them with its Undo, fix or no fix.)
        db.execute("UPDATE pip_agent_jobs SET verdict=?,reason=CASE WHEN kind='work' THEN ? ELSE reason END,updated_at=? "
                   "WHERE id=?", (text[-4000:], reason_of(text), _now(registry), row["id"]))
    merge(store, _row(db, row["id"]))


def merge(store, row) -> None:
    """PASS: its change into the Pip's copy, three-way. A file the Pip's copy changed since the job began is held.
    A work job's change is in the folder already: it ends done, with Undo (pip_work_agents.undo)."""
    import shutil
    registry, db = store.registry, store.db
    if row["kind"] == "work":
        with registry.transaction():
            db.execute("UPDATE pip_agent_jobs SET state='merged',updated_at=? WHERE id=?", (_now(registry), row["id"]))
        _job_ended(store, _row(db, row["id"]))
        return
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
    out = {"id": row["id"], "pip_id": row["pip_id"], "kind": row["kind"], "fix_id": row["fix_id"], "title": row["title"],
           "state": row["state"], "try": row["tries"], "tries": MAX_TRIES, "run_id": row["run_id"],
           "run_status": run["status"] if run else None, "started_at": run["started_at"] if run else None,
           "model": model, "held": json.loads(row["held"]) if row["held"] else [], "notes": row["notes"] or "",
           "said": row["reason"] or "", "check_run_id": row["check_run_id"], "ended_at": row["ended_at"],
           "created_at": row["created_at"], "updated_at": row["updated_at"]}
    if row["kind"] == "work":
        # A sub-agent with Work tools (Pips API 109): what it changed in the folder itself, and its Undo.
        from . import pip_work_agents as work
        out.update(work.view_fields(db, row))
        if not out["said"] and row["state"] in ("stopped", "failed"):
            out["said"] = str(row["said"] or "")[:600]
    return out


def listing(store, pip_id) -> dict:
    """list_pip_agents: {agents, slots, model_choice, thinking, context_size, fallback}."""
    db = store.db
    own = agents_model(store.registry, pip_id)
    if not _has(db):
        return {"agents": [], "slots": slots(store.registry, pip_id), **own}
    rows = db.execute("SELECT * FROM pip_agent_jobs WHERE pip_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50", (pip_id,)).fetchall()
    return {"agents": [view(db, row) for row in rows], "slots": slots(store.registry, pip_id), **own}


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
            store.cancel(row["run_id"], actor)       # a work job's runner ends its child and all it started
        except RegistryError:
            pass
    with registry.transaction():
        db.execute("UPDATE pip_agent_jobs SET state='stopped',updated_at=? WHERE id=?", (_now(registry), job_id))
    _job_ended(store, _row(db, job_id))
    return view(db, _row(db, job_id))


# ---- its helpers' model, by the user's words (decided 18 Nov) ------------------------------------------------------
# "Fix it with GLM 5 flash on my Ollama Cloud": the Pip's chat sets what its helpers run on (the same setting as its
# Sub-agents tab: its fixes and the helpers inside its runs), from the user's own message only, and only on one of the
# user's saved connections (never a subscription CLI or DGC Router). "Back to your own model" undoes it.
MODEL_TOOL = "set_helper_model"


def runtime(config, run, manifest: dict) -> dict:
    """In the supervisor, as a chat turn the user started begins: their saved connections, by name (no key), for the
    worker's set_helper_model."""
    if not isinstance(manifest.get("conversation"), dict) or manifest.get("user_turn") is not True:
        return manifest
    try:
        named = config.saved_provider_names()[:20]
    except Exception:                                   # noqa: BLE001 - no connections to name: no tool
        named = []
    return {**manifest, "helper_connections": named} if named else manifest


def model_schema(connections) -> dict:
    listing = ", ".join(c["name"] + (f" ({c['host']})" if c.get("host") else "") for c in connections)
    return {"type": "function", "function": {"name": MODEL_TOOL, "description": (
        "Only when the user asks in their own message for your helpers (the sub-agents that fix things for you, and "
        "the helpers you start) to run on a model of theirs, like \"fix it with GLM 5 flash on my Ollama Cloud\": set "
        "it here. connection is one of their saved connections: " + listing + ". Leave both empty to go back to your "
        "own model. It stays until they change it (they see it on your Sub-agents tab)."),
        "parameters": {"type": "object", "properties": {
            "connection": {"type": "string", "description": "the saved connection's name, or \"\" for your own model"},
            "model": {"type": "string", "description": "the model's id on that connection, or \"\""}},
            "required": ["connection", "model"], "additionalProperties": False}}}


def _norm(text) -> str:
    text = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower())
    return " ".join(w for w in text.split() if w not in ("my", "the", "on", "connection", "account"))


def connection_named(connections, said):
    """The saved connection a name means ("my ollama cloud"), or None."""
    want = _norm(said)
    if not want:
        return None
    return next((c for c in connections if _norm(c["name"]) == want), None) or next(
        (c for c in connections if want in _norm(c["name"]) or _norm(c["name"]) in want
         or (c.get("host") and want.replace(" ", "") in c["host"].replace(".", ""))), None)


def model_tool_result(connections, arguments) -> tuple[dict | None, str]:
    """In the worker: (the choice to keep, what the tool says)."""
    args = arguments if isinstance(arguments, dict) else {}
    said, model = str(args.get("connection") or "").strip(), str(args.get("model") or "").strip()
    if not said and not model:
        return {"mode": "default"}, ("Your helpers go back to your own model as your reply is kept. Say so in one "
                                     "short sentence.")
    names = ", ".join(c["name"] for c in connections) or "none"
    found = connection_named(connections, said)
    if found is None:
        return None, (f"Not set: no saved connection called {said[:60]}. The user's saved connections: {names}. Ask "
                      "which they meant.")
    if not model:
        return None, f"Not set: say which model on {found['name']} (its id)."
    try:
        choice = _valid_choice({"mode": "provider", "provider": found["id"], "model": model[:200]})
    except RegistryError as exc:
        return None, "Not set: " + str(exc)
    return choice, (f"Your helpers run on {model[:80]} on {found['name']} as your reply is kept. Say so in one short "
                    "sentence; the user can change it on your Sub-agents tab.")


def commit_model(store, run, result) -> None:
    """In the supervisor, as a chat reply is kept: the helpers' model the user asked for. Only a reply to the user's
    own message; only a saved connection's model or its own (checked again here, never the worker's word)."""
    choice = result.get("helper_model") if isinstance(result, dict) else None
    if choice is None:
        return
    choice = _valid_choice(choice)              # a bad one fails the reply's keep, as any forged result does
    from .pip_notes import user_turn
    if user_turn(store.registry, run) is None:
        return
    if choice["mode"] not in ("provider", "default"):
        return                                  # a saved connection or its own model, nothing else
    # A connection removed meanwhile is said in plain words when a helper starts on it (provider_view), as the tab's is.
    chosen = agents_model(store.registry, run["pip_id"])
    chosen["model_choice"] = choice
    store.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (MODEL_KEY + run["pip_id"], json.dumps(chosen)))
