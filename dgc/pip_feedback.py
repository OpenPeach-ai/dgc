"""Feedback on a Pip's results: thumbs up or down, and an optional note, that later runs read.

The user's own record, kept in the registry outside the reviewed job: rating a result needs no
review and no model can rate on the user's behalf. Each later Personal task, audit or Quill
draft of the same Pip receives its newest five ratings (notes redacted with the current secrets)
as reference "where it fits the approved goal", never as a new task or a permission. The newest
50 per Pip are kept.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

PREFIX = "pip_feedback:"
MAX_PER_PIP = 50
MAX_NOTE = 500
IN_RUNS = 5
RATED_KINDS = ("personal_task", "audit", "draft")


def _key(pip_id, run_id):
    return f"{PREFIX}{pip_id}:{run_id}"


def _rows(registry, pip_id):
    start = f"{PREFIX}{pip_id}:"
    rows = []
    for key, value in registry.db.execute("SELECT key,value FROM metadata WHERE key>=? AND key<?",
                                          (start, start + "\U0010ffff")).fetchall():
        try:
            item = json.loads(value)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("rating") in ("up", "down"):
            seq = item.get("seq") if isinstance(item.get("seq"), int) else 0
            rows.append((seq, {"run_id": key[len(start):], "rating": item["rating"],
                               "note": str(item.get("note") or "")[:MAX_NOTE], "at": str(item.get("at") or "")[:40]}))
    rows.sort(key=lambda pair: (pair[0], pair[1]["at"]), reverse=True)   # the order they were given, newest first
    return [row for _, row in rows]


def _next_seq(registry, pip_id):
    start = f"{PREFIX}{pip_id}:"
    seqs = [0]
    for (value,) in registry.db.execute("SELECT value FROM metadata WHERE key>=? AND key<?", (start, start + "\U0010ffff")):
        try:
            seq = json.loads(value).get("seq")
        except (ValueError, AttributeError):
            continue
        if isinstance(seq, int):
            seqs.append(seq)
    return max(seqs) + 1


def set_feedback(registry, run_id, rating, note, actor) -> dict:
    """Rate one finished run; rating None clears it. Returns the Pip's feedback, newest first."""
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Only you can rate a Pip's results, on this computer.")
    if rating not in ("up", "down", None):
        raise RegistryError("invalid_request", "Rate it up or down, or clear the rating.")
    note = "" if note is None else note
    if not isinstance(note, str) or len(note) > MAX_NOTE or any(ord(c) < 32 and c not in "\n\t" for c in note):
        raise RegistryError("invalid_request", f"Keep the note to {MAX_NOTE} characters of plain text.")
    row = registry.db.execute("SELECT pip_id,workspace_id,status,manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()
    if row is None:
        raise RegistryError("not_found", "Run not found on this runner.")
    try:
        kind = json.loads(row["manifest"]).get("run_kind", "audit")
    except (ValueError, AttributeError):
        kind = "audit"
    if row["status"] != "succeeded" or kind not in RATED_KINDS:
        raise RegistryError("invalid_request", "Rate a finished result: a Personal task, an audit or a Quill draft.")
    with registry.transaction():
        if rating is None:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(row["pip_id"], run_id),))
        else:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (_key(row["pip_id"], run_id), json.dumps(
                {"rating": rating, "note": note.strip(), "at": registry.clock(), "seq": _next_seq(registry, row["pip_id"])},
                ensure_ascii=False)))
            for old in _rows(registry, row["pip_id"])[MAX_PER_PIP:]:
                registry.db.execute("DELETE FROM metadata WHERE key=?", (_key(row["pip_id"], old["run_id"]),))
        registry.event(row["workspace_id"], "pip_feedback_recorded", pip_id=row["pip_id"], run_id=run_id,
                       payload={"rating": rating, "has_note": bool(note.strip())})
    return {"pip_id": row["pip_id"], "feedback": _rows(registry, row["pip_id"])[:20]}


def list_feedback(registry, pip_id) -> dict:
    if registry.db.execute("SELECT 1 FROM pips WHERE id=?", (pip_id,)).fetchone() is None:
        raise RegistryError("not_found", "Pip not found on this runner.")
    return {"pip_id": pip_id, "feedback": _rows(registry, pip_id)[:20]}


def for_run(registry, pip_id, secrets) -> list:
    """What a new run of this Pip is told: the newest ratings, notes redacted."""
    from .redaction import redact_text
    return [{"rating": row["rating"], "note": redact_text(row["note"], secrets), "at": row["at"]}
            for row in _rows(registry, pip_id)[:IN_RUNS]]
