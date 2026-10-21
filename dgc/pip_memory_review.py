"""A Personal Pip's chat, looked back over for the user's one memory (memory_review.py), as ChatDGC's and Work's are.

When the user's own messages to a Pip add up to enough new words, or its chat goes quiet with something worth a look,
DGC looks back once, in the supervisor (which alone writes memory; a worker is not trusted), on the Pip's own model
(DGC's model when the Pip runs on a subscription CLI). Only the user's own messages from this computer count: never a
turn DGC wrote (a hello, a routine's turn, a "carry on"), never a run's post, never what the Pip read in an app or on
a page. What it keeps goes into the user's one memory tagged with this Pip and its latest reply, so the reply shows
"Remembered: … · Forget" and the Pip's page lists it under What it remembers.

Memory off (Settings -> Memory) means no look back, and what was said meanwhile is never looked back over later.
"""
from __future__ import annotations

import threading

from . import memory_review, shared_memory

MARK = "memory_reviewed:"          # metadata: the last user message (its seq) looked back over, per Pip
MAX_ROWS = 50
_REVIEWS: dict[str, memory_review.Reviews] = {}
_LOCK = threading.Lock()


def _mark(registry, pip_id) -> int:
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (MARK + pip_id,)).fetchone()
    try:
        return int(row[0]) if row is not None else 0
    except (TypeError, ValueError):
        return 0


def _set_mark(registry, pip_id, seq: int) -> None:
    with registry.transaction():
        registry.db.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET "
                            "value=excluded.value", (MARK + pip_id, str(int(seq))))


def turns_since(registry, pip_id) -> tuple[list[dict], int, str, str]:
    """The user's own exchanges with this Pip since the last look back: (turns, newest seq, latest run, its name)."""
    from .pip_chat import DGC_KEYS
    from .pip_notes import LOCAL
    rows = registry.db.execute(
        "SELECT m.seq,m.text,m.run_id,m.request_key,r.requested_by,r.status FROM pip_chat_messages m JOIN pip_runs r "
        "ON r.id=m.run_id WHERE m.pip_id=? AND m.role='user' AND m.seq>? ORDER BY m.seq LIMIT ?",
        (pip_id, _mark(registry, pip_id), MAX_ROWS)).fetchall()
    turns, newest, latest = [], 0, ""
    for row in rows:
        newest = max(newest, int(row["seq"]))
        if (row["requested_by"] not in LOCAL or str(row["request_key"] or "").startswith(DGC_KEYS)
                or row["status"] != "succeeded"):
            continue
        reply = registry.db.execute("SELECT text FROM pip_chat_messages WHERE run_id=? AND role='assistant'",
                                    (row["run_id"],)).fetchone()
        turns.append({"user": str(row["text"] or ""), "assistant": str(reply["text"] if reply else "")})
        latest = row["run_id"]
    name = ""
    if latest:
        found = registry.db.execute("SELECT v.definition FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND "
                                    "v.version=p.current_version WHERE p.id=?", (pip_id,)).fetchone()
        try:
            import json
            name = str((json.loads(found["definition"]) if found else {}).get("name") or "")
        except (TypeError, ValueError):
            name = ""
    return turns, newest, latest, name


def _memory_on(config) -> bool:
    """Settings -> Memory's switch, as this runner's settings say and as saved now (the runner may have started
    before the user turned it off)."""
    from .pip_notes import _shared_memory_on
    return _shared_memory_on(config) and _shared_memory_on(None)


def pending(directory, config, pip_id) -> int:
    from .workspace_registry import WorkspaceRegistry
    if not _memory_on(config):
        return 0
    with WorkspaceRegistry(directory) as registry:
        turns, _, _, _ = turns_since(registry, pip_id)
    said = memory_review.said_in(turns)
    return len(said) if memory_review.worth(said) else 0


def _client(registry, config, run_id):
    """The Pip's own model on DGC's connection, as its latest reply ran; DGC's own model for a subscription Pip."""
    import json
    row = registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()
    settings = (json.loads(row["manifest"]).get("model_settings") if row is not None else None) or {}
    if not isinstance(settings, dict) or "brain" in settings or not settings.get("model"):
        if not str(config.get("model", "") or "").strip():
            return None
        return memory_review.client_for(config)
    return memory_review.client_for(config, model=str(settings["model"]), base_url=str(settings.get("base_url") or "")
                                    or None, api_mode=str(settings.get("api_mode") or "") or None)


def review(directory, config, pip_id, *, client=None, memory=None) -> list[dict]:
    """One look back over this Pip's chat since the last; what it keeps, tagged with the Pip and its latest reply."""
    from .workspace_registry import WorkspaceRegistry
    with WorkspaceRegistry(directory) as registry:
        turns, newest, latest, name = turns_since(registry, pip_id)
        if not _memory_on(config):
            if newest:
                _set_mark(registry, pip_id, newest)      # never looked back over, even once memory is on
            return []
        said = memory_review.said_in(turns)
        if not turns or not memory_review.worth(said):
            if newest and not turns:
                _set_mark(registry, pip_id, newest)
            return []
        client = client or _client(registry, config, latest)
    if client is None:
        return []
    memory = memory or shared_memory.SharedMemory()
    try:
        candidates = memory_review.ask(client, turns, memory.facts())
    except Exception:                              # noqa: BLE001 -- nothing kept; tried again after its next reply
        return []
    if not _memory_on(config):
        return []
    saved = memory_review.keep(memory, candidates, said=said, surface="pip", where=name, pip=pip_id, run=latest)
    with WorkspaceRegistry(directory) as registry:
        _set_mark(registry, pip_id, newest)
    return saved


def _reviews(directory, config) -> memory_review.Reviews:
    key = str(directory)
    with _LOCK:
        found = _REVIEWS.get(key)
        if found is None:
            found = _REVIEWS[key] = memory_review.Reviews(
                lambda pip_id: pending(directory, config, pip_id),
                lambda pip_id: review(directory, config, pip_id), idle=memory_review.idle_seconds(config))
        return found


def after_run(registry, config, run_id) -> None:
    """From the runner, after a run finished: a reply to the user's own message may start the look back, or its wait.
    Never raises."""
    try:
        from .pip_notes import user_turn
        row = registry.db.execute("SELECT r.id,r.pip_id,r.status,json_extract(r.manifest,'$.run_kind') AS kind FROM "
                                  "pip_runs r JOIN pips p ON p.id=r.pip_id JOIN workspaces w ON w.id=p.workspace_id "
                                  "WHERE r.id=? AND w.kind='personal'", (run_id,)).fetchone()
        if row is None or row["kind"] != "conversation" or row["status"] != "succeeded":
            return
        if user_turn(registry, {"id": row["id"]}) is None:
            return
        _reviews(registry.directory, config).ended(row["pip_id"])
    except Exception:                              # noqa: BLE001 -- a look back is never worth a run
        pass


def run_started(directory, pip_id) -> None:
    found = _REVIEWS.get(str(directory))
    if found is not None:
        found.started(pip_id)
