"""Which Pips a session is related to (pips-flow-design Q2, 14 Nov; Pips API 96 list_related_pips).

No session owns a Pip. A session is *related* to some Pips, worked out from what happened; nobody sets it, and nothing
is routed by it: reports go to the Pip's own chat whatever it relates to. Three ways, strongest first:
  asked    this session gave the Pip a job (run_pip_now from that chat) in the last 30 days
  set_up   the Pip was set up there (an accepted setup card, or a 0.51 attachment, kept one release for this alone)
  folder   the Pip works on this session's folder
A Pip can relate to many sessions; an archived Pip relates to nothing. It orders and shows (the agent map's Pips
section, the @ list), nothing else. Reads only; no table of its own.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

JOB_DAYS = 30
MAX_LISTED = 100
_ORDER = {"asked": 0, "set_up": 1, "folder": 2}


def _floor(now: str) -> str:
    try:
        moment = datetime.fromisoformat(str(now).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        moment = datetime.now(timezone.utc)
    return (moment - timedelta(days=JOB_DAYS)).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _table(db, name) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def related(registry, session_id: str) -> list[dict]:
    """[{id, name, pip_type, workspace_id, why: [asked|set_up|folder], running, needs_you}], strongest first."""
    if not isinstance(session_id, str) or not session_id:
        return []
    try:
        identity = registry.session_identity(session_id)
    except Exception:                                    # noqa: BLE001 - a session id that doesn't read: none
        return []
    db = registry.db
    why: dict[str, set] = {}
    from .pip_report_delivery import chat_identity
    for row in db.execute("SELECT DISTINCT pip_id FROM pip_runs WHERE requested_by=? AND created_at>=? LIMIT 500",
                          (chat_identity(session_id), _floor(registry.clock()))):
        why.setdefault(row[0], set()).add("asked")
    if _table(db, "pip_setup_proposals"):
        for row in db.execute("SELECT json_extract(receipt,'$.pip_id') FROM pip_setup_proposals WHERE session_id=? "
                              "AND status='accepted' AND json_valid(receipt) LIMIT 500", (session_id,)):
            if isinstance(row[0], str):
                why.setdefault(row[0], set()).add("set_up")
    if _table(db, "session_pip_attachments"):
        for row in db.execute("SELECT pip_id FROM session_pip_attachments WHERE session_id=? LIMIT 500", (session_id,)):
            why.setdefault(row[0], set()).add("set_up")
    if identity is not None:
        for row in db.execute("SELECT id FROM pips WHERE workspace_id=? AND status<>'archived' LIMIT 500",
                              (identity["workspace_id"],)):
            why.setdefault(row[0], set()).add("folder")
    if not why:
        return []
    ids = sorted(why)
    marks = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT p.id,p.workspace_id,p.created_at,json_extract(v.definition,'$.name') AS name,"
        f"json_extract(v.definition,'$.pip_type') AS pip_type FROM pips p JOIN pip_versions v ON v.pip_id=p.id "
        f"AND v.version=p.current_version WHERE p.id IN ({marks}) AND p.status<>'archived'", ids).fetchall()
    running = {row[0] for row in db.execute(
        f"SELECT DISTINCT pip_id FROM pip_runs WHERE pip_id IN ({marks}) AND status IN ('running','cancelling')", ids)}
    needs: dict[str, int] = {}
    try:
        from .pip_fixes import attention_rows
        for item in attention_rows(db, ids, registry.clock()):
            needs[item["pip_id"]] = needs.get(item["pip_id"], 0) + 1
    except Exception:                                    # noqa: BLE001 - a registry before the flow: none
        pass
    out = []
    for row in rows:
        reasons = sorted(why[row["id"]], key=_ORDER.get)
        out.append({"id": row["id"], "name": str(row["name"] or "Pip")[:120], "pip_type": row["pip_type"] or "scout",
                    "workspace_id": row["workspace_id"], "why": reasons, "running": row["id"] in running,
                    "needs_you": needs.get(row["id"], 0), "_created": row["created_at"]})
    out.sort(key=lambda p: (_ORDER[p["why"][0]], p["_created"], p["id"]))
    for item in out:
        item.pop("_created")
    return out[:MAX_LISTED]
