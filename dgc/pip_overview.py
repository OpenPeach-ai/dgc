"""Bounded, read-only runner summaries for paired Remote and local controllers.

All pages are one SQLite read snapshot. Pending is a saved state, not permission
or proof that acceptance will succeed: callers must inspect the original review.
"""
from __future__ import annotations

import contextlib
import json
from datetime import datetime, timezone

from .workspace_registry import MAX_EVENTS, MAX_WORKSPACES, RegistryError

MAX_PAGE_BYTES = 96 * 1024
MAX_CURSOR = 2**53 - 1
SESSION_STATEMENT_SUMMARY = "Review a session statement for shared context."
_REVIEW_UNION = """
 SELECT 'approval:'||a.id AS id,a.workspace_id,a.pip_id,a.created_at,a.expires_at,
        a.action_type AS kind,a.id AS origin_id
 FROM pip_approvals a WHERE a.status='pending' AND a.expires_at>?
 UNION ALL
 SELECT 'handoff:'||h.id AS id,h.workspace_id,h.target_pip_id AS pip_id,h.created_at,h.expires_at,
        'handoff' AS kind,h.id AS origin_id
 FROM pip_handoffs h WHERE h.status='pending' AND h.expires_at>?
"""


def _bad(message, code="invalid_overview"):
    return RegistryError(code, message)


def _text(value, label, maximum=128):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise _bad(f"{label} must be nonempty bounded text.", "invalid_request")
    try:
        if len(value.encode("utf-8")) > maximum or any(ord(c) < 32 for c in value):
            raise ValueError()
    except (UnicodeError, ValueError) as exc:
        raise _bad(f"{label} must be valid bounded text.", "invalid_request") from exc
    return value


def _integer(value, label, low, high):
    if type(value) is not int or not low <= value <= high:
        raise _bad(f"{label} must be an integer between {low} and {high}.", "invalid_cursor" if "cursor" in label else "invalid_request")
    return value


def _now(registry):
    value = _text(registry.clock(), "Timestamp", 40)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError as exc:
        raise _bad("The runner clock did not provide an ISO timestamp.") from exc


@contextlib.contextmanager
def _snapshot(registry):
    own = not registry.db.in_transaction
    if own:
        registry.db.execute("BEGIN")
    try:
        yield registry.db
    finally:
        if own:
            registry.db.rollback()


def _scope(db, workspace_id, runner_id):
    if workspace_id is not None:
        _text(workspace_id, "workspace_id")
        if not db.execute("SELECT 1 FROM bindings WHERE workspace_id=? AND runner_id=?", (workspace_id,runner_id)).fetchone():
            raise _bad("Workspace not found.", "not_found")
    return workspace_id


def _bounded(db, query, params, fields):
    """SQLite checks byte lengths before Python can allocate/decode TEXT values."""
    # fields maps fixed source identifiers to maximum bytes (None for integers).
    columns = []
    for key, maximum in fields.items():
        if maximum is None:
            columns.append(key)
        else:
            columns.extend((f"CASE WHEN {key} IS NULL OR (typeof({key})='text' AND length(CAST({key} AS BLOB))<={maximum}) THEN {key} ELSE NULL END AS {key}",
                            f"CASE WHEN {key} IS NULL OR (typeof({key})='text' AND length(CAST({key} AS BLOB))<={maximum}) THEN 1 ELSE 0 END AS ok_{key}"))
    rows = db.execute("SELECT " + ",".join(columns) + " FROM (" + query + ")", params).fetchall()
    results = []
    for row in rows:
        if any(row["ok_" + key] != 1 for key, maximum in fields.items() if maximum is not None):
            raise _bad("Stored overview data exceeds its bounded contract.", "stored_data_limit")
        results.append({key: row[key] for key in fields})
    return results


def _json_object(raw, maximum):
    if not isinstance(raw, str) or len(raw) > maximum:
        raise _bad("Stored overview JSON is unavailable.")
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError("duplicate key")
            out[key] = value
        return out
    try:
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError) as exc:
        raise _bad("Stored overview JSON is malformed.") from exc
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 16 or count > 2048:
            raise _bad("Stored overview JSON exceeds its structure budget.", "stored_data_limit")
        if isinstance(item, dict):
            pending.extend((v, depth + 1) for pair in item.items() for v in pair)
        elif isinstance(item, list):
            pending.extend((v, depth + 1) for v in item)
        elif isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeError as exc:
                raise _bad("Stored overview JSON contains invalid Unicode.") from exc
    if not isinstance(value, dict):
        raise _bad("Stored overview payload must be an object.")
    return value


def _statement_reviews(registry, workspace_id=None, *, proposal_id=None, pending=True):
    """Read bounded payloads one at a time; retain index metadata, never prose.

    The immutable statement ledger stores its creation time in the payload. A
    bounded scan avoids a new SQL schema/JSON extension requirement. Its global
    retained archive has at most 1,000 rows, independent of transcript sizes.
    """
    from .workspace_session_outcomes import MAX_PROPOSALS, _validate_payload, _hash
    clauses = ['workspace_id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)']
    params = [registry.runner_id]
    if workspace_id is not None:
        clauses.append('workspace_id=?'); params.append(workspace_id)
    if proposal_id is not None:
        clauses.append('id=?'); params.append(proposal_id)
    if pending:
        clauses.append("status='pending'")
    where = ' AND '.join(clauses)
    if registry.db.execute('SELECT count(*) FROM workspace_session_outcomes WHERE ' + where, params).fetchone()[0] > MAX_PROPOSALS:
        raise _bad('Session review metadata exceeds the bounded proposal archive.', 'stored_data_limit')
    query = ('SELECT CASE WHEN length(CAST(id AS BLOB))<=64 THEN id ELSE NULL END AS id, '
             'CASE WHEN length(CAST(workspace_id AS BLOB))<=64 THEN workspace_id ELSE NULL END AS workspace_id, '
             'CASE WHEN length(CAST(payload AS BLOB))<=8192 THEN payload ELSE NULL END AS payload, '
             'CASE WHEN length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END AS digest '
             'FROM workspace_session_outcomes WHERE ' + where + ' LIMIT ?')
    result = []
    for row in registry.db.execute(query, (*params, MAX_PROPOSALS + 1)):
        payload = _validate_payload(_json_object(row['payload'], 8192))
        if payload['id'] != row['id'] or payload['workspace_id'] != row['workspace_id'] or _hash(payload) != row['digest']:
            raise _bad('Stored session review identity is inconsistent.', 'stored_data_limit')
        result.append({'id': 'session_outcome:' + row['id'], 'workspace_id': row['workspace_id'], 'pip_id': None,
            'created_at': payload['created_at'], 'expires_at': None, 'kind': 'session_outcome', 'origin_id': row['id']})
    return result


def workspace_overviews(registry, after_id=None, limit=20):
    _integer(limit, "Page limit", 1, 20)
    if after_id is not None:
        _text(after_id, "Workspace cursor")
    with _snapshot(registry) as db:
        now = _now(registry)
        if after_id is not None and not db.execute("SELECT 1 FROM bindings WHERE workspace_id=? AND runner_id=?", (after_id,registry.runner_id)).fetchone():
            raise _bad("Workspace cursor does not belong to this runner.", "invalid_cursor")
        workspaces = _bounded(db, "SELECT id,name,kind FROM workspaces WHERE id>? AND id IN (SELECT workspace_id FROM bindings WHERE runner_id=?) ORDER BY id LIMIT ?",
                              (after_id or "", registry.runner_id, limit + 1), {"id":128,"name":512,"kind":64})
        more, workspaces = len(workspaces) > limit, workspaces[:limit]
        ids = [item["id"] for item in workspaces]
        counts = {key:dict.fromkeys(("pips_active","pips_paused","pips_archived","runs_active","runs_queued","reviews_job","reviews_schedule","reviews_handoff","reviews_session_outcome","reviews_total"), 0) for key in ids}
        if ids:
            marks = ",".join("?" for _ in ids)
            # Four grouped queries, independent of the number of Pips or runs.
            for row in db.execute(f"SELECT workspace_id,status,count(*) FROM pips WHERE workspace_id IN ({marks}) GROUP BY workspace_id,status", ids):
                key = "pips_" + row[1]
                if key not in counts[row[0]]:
                    raise _bad("Stored Pip status is unsupported.")
                counts[row[0]][key] = row[2]
            for row in db.execute(f"SELECT workspace_id,status,count(*) FROM pip_runs WHERE workspace_id IN ({marks}) AND status IN ('running','cancelling','queued') GROUP BY workspace_id,status", ids):
                counts[row[0]]["runs_queued" if row[1] == "queued" else "runs_active"] += row[2]
            for row in db.execute("SELECT workspace_id,kind,count(*) FROM (" + _REVIEW_UNION + f") WHERE workspace_id IN ({marks}) GROUP BY workspace_id,kind", (now, now, *ids)):
                counts[row[0]][{"job_update":"reviews_job","schedule_update":"reviews_schedule","handoff":"reviews_handoff"}[row[1]]] += row[2]
                counts[row[0]]["reviews_total"] += row[2]
            for row in db.execute(f"SELECT workspace_id,count(*) FROM workspace_session_outcomes WHERE status='pending' AND workspace_id IN ({marks}) GROUP BY workspace_id", ids):
                _integer(row[1], 'Stored session review count', 0, 1000)
                counts[row[0]]['reviews_session_outcome'] = row[1]
                counts[row[0]]['reviews_total'] += row[1]
        for item in workspaces:
            _text(item["id"], "Stored workspace ID")
            _text(item["name"], "Stored workspace name", 512)
            _text(item["kind"], "Stored workspace kind", 64)
            item["counts"] = counts[item["id"]]
        return {"runner_id":registry.runner_id,"as_of":now,"workspaces":workspaces,
                "next_after_id":workspaces[-1]["id"] if more else None,"has_more":more,
                "total_workspaces":db.execute("SELECT count(*) FROM workspaces WHERE id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)",(registry.runner_id,)).fetchone()[0]}


def pending_reviews(registry, workspace_id=None, before_id=None, limit=20):
    _integer(limit, "Page limit", 1, 20)
    if before_id is not None:
        _text(before_id, "Review cursor", 160)
    with _snapshot(registry) as db:
        _scope(db, workspace_id, registry.runner_id)
        now = _now(registry)
        scope = "workspace_id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)" + (" AND workspace_id=?" if workspace_id is not None else "")
        params = [now, now, registry.runner_id] + ([workspace_id] if workspace_id is not None else [])
        total = db.execute("SELECT count(*) FROM (" + _REVIEW_UNION + ") WHERE " + scope, params).fetchone()[0]
        statements = _statement_reviews(registry, workspace_id)
        total += len(statements)
        where = scope
        if before_id is not None:
            # Cursor lookup includes resolved/expired records, so another review
            # completing between pages does not break the next page's cursor.
            kind, sep, key = before_id.partition(":")
            if sep != ":" or kind not in ("approval", "handoff", "session_outcome"):
                raise _bad("Use the review cursor from the previous page.", "invalid_cursor")
            if kind == 'session_outcome':
                rows = _statement_reviews(registry, workspace_id, proposal_id=key, pending=False)
            else:
                table = "pip_approvals" if kind == "approval" else "pip_handoffs"
                rows = _bounded(db, f"SELECT workspace_id,created_at FROM {table} WHERE id=?", (key,), {"workspace_id":128,"created_at":40})
            if not rows or not db.execute("SELECT 1 FROM bindings WHERE workspace_id=? AND runner_id=?",(rows[0]["workspace_id"],registry.runner_id)).fetchone() or (workspace_id is not None and rows[0]["workspace_id"] != workspace_id):
                raise _bad("Review cursor does not belong to this scope.", "invalid_cursor")
            where += " AND (created_at,id)<(?,?)"
            params += [rows[0]["created_at"], before_id]
            statements = [item for item in statements if (item['created_at'], item['id']) < (rows[0]['created_at'], before_id)]
        rows = _bounded(db, "SELECT * FROM (" + _REVIEW_UNION + ") WHERE " + where + " ORDER BY created_at DESC,id DESC LIMIT ?",
                        (*params, limit + 1), {"id":160,"workspace_id":128,"pip_id":128,"created_at":40,"expires_at":40,"kind":32,"origin_id":128})
        for item in rows:
            _text(item['id'], 'Stored review identity', 160)
            _text(item['created_at'], 'Stored review timestamp', 40)
        rows = sorted([*rows, *statements], key=lambda item: (item['created_at'], item['id']), reverse=True)
        more, page = len(rows) > limit, rows[:limit]
        for item in page:
            origin = item.pop("origin_id")
            if item['kind'] == 'session_outcome':
                item['summary'] = SESSION_STATEMENT_SUMMARY
                item['reference'] = {'proposal_id': origin}
            elif item["kind"] == "handoff":
                fields = _bounded(db, "SELECT payload,payload_digest,revision,source_pip_id,source_run_id,target_pip_id FROM pip_handoffs WHERE id=?", (origin,),
                                  {"payload":24576,"payload_digest":64,"revision":None,"source_pip_id":128,"source_run_id":128,"target_pip_id":128})[0]
                from .pip_handoffs import validate_payload, _digest
                payload = validate_payload(_json_object(fields["payload"], 24576))
                if (payload["workspace_id"] != item["workspace_id"] or payload["source"]["pip_id"] != fields["source_pip_id"]
                        or payload["source"]["run_id"] != fields["source_run_id"] or payload["target"]["pip_id"] != item["pip_id"]
                        or fields["target_pip_id"] != item["pip_id"] or _digest(payload) != fields["payload_digest"] or fields["revision"] != 0):
                    raise _bad("Stored handoff review identity is inconsistent.")
                item["reference"] = {"handoff_id":origin,"expected_revision":0,"source_pip_id":fields["source_pip_id"],"source_run_id":fields["source_run_id"],
                                     "target_pip_id":item["pip_id"],"target_job_version":payload["target"]["job_version"],"source_kind":payload["type"]}
            else:
                fields = _bounded(db, "SELECT proposal_id,expected_version FROM pip_approvals WHERE id=?", (origin,), {"proposal_id":128,"expected_version":None})[0]
                _integer(fields["expected_version"], "Stored expected version", 1, 999999)
                item["reference"] = {"approval_id":origin,**fields}
            for key in ("id","workspace_id","pip_id","created_at","expires_at"):
                if item['kind'] == 'session_outcome' and key in ('pip_id', 'expires_at'):
                    if item[key] is not None:
                        raise _bad('Session review index must not invent a Pip or expiry.')
                    continue
                _text(item[key], "Stored review " + key, 160)
        return {"runner_id":registry.runner_id,"as_of":now,"workspace_id":workspace_id,"reviews":page,
                "next_before_id":page[-1]["id"] if more else None,"has_more":more,"total_pending":total}


def recent_activity(registry, workspace_id=None, before_seq=None, limit=50):
    _integer(limit, "Page limit", 1, 50)
    if before_seq is not None:
        _integer(before_seq, "Activity cursor", 0, MAX_CURSOR)
    with _snapshot(registry) as db:
        _scope(db, workspace_id, registry.runner_id)
        now = _now(registry)
        where = "workspace_id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)" + (" AND workspace_id=?" if workspace_id is not None else "")
        params = [registry.runner_id] + ([workspace_id] if workspace_id is not None else [])
        bounds = db.execute("SELECT min(seq),max(seq) FROM workspace_events WHERE " + where, params).fetchone()
        oldest, newest = bounds[0] or 0, bounds[1] or 0
        _integer(newest, "Stored activity cursor", 0, MAX_CURSOR)
        # Retention is per workspace. Sequence gaps alone cannot prove pruning:
        # another workspace may own those IDs. Inspect each initial event marker.
        firsts = _bounded(db, "SELECT e.event_type FROM workspaces w LEFT JOIN (SELECT workspace_id,min(seq) AS first_seq FROM workspace_events GROUP BY workspace_id) f ON f.workspace_id=w.id LEFT JOIN workspace_events e ON e.seq=f.first_seq" + " WHERE w.id IN (SELECT workspace_id FROM bindings WHERE runner_id=?)" + (" AND w.id=?" if workspace_id else "") + " LIMIT 257",
                          params, {"event_type":128})
        if len(firsts) > MAX_WORKSPACES:
            raise _bad("The registry exceeds its workspace limit.", "stored_data_limit")
        truncated = any(item["event_type"] != "workspace_resolved" for item in firsts)
        if before_seq is not None:
            where += " AND seq<?"
            params.append(before_seq)
        fields = {"seq":None,"event_id":128,"workspace_id":128,"event_type":128,"pip_id":128,"run_id":128,"payload":8192,"created_at":64}
        # First query includes only bounded rows, <=51*~9KiB; JSON is decoded one
        # event at a time and only whole events enter the response page.
        rows = _bounded(db, "SELECT * FROM workspace_events WHERE " + where + " ORDER BY seq DESC LIMIT ?", (*params, limit + 1), fields)
        events, size = [], 0
        for row in rows[:limit]:
            row["payload"] = _json_object(row["payload"], 8192)
            for key in ("event_id","workspace_id","event_type","created_at"):
                _text(row[key], "Stored event " + key)
            for key in ("pip_id","run_id"):
                if row[key] is not None:
                    _text(row[key], "Stored event " + key)
            _integer(row["seq"], "Stored activity cursor", 1, MAX_CURSOR)
            encoded = json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if size + len(encoded) > MAX_PAGE_BYTES:
                break
            size += len(encoded)
            events.append(row)
        more = len(rows) > len(events)
        return {"runner_id":registry.runner_id,"as_of":now,"workspace_id":workspace_id,"events":events,
                "next_before_seq":events[-1]["seq"] if more else None,"has_more":more,
                "oldest_cursor":oldest,"newest_cursor":newest,"retention_limit":MAX_EVENTS,
                "retention_scope":"workspace","history_may_be_truncated":truncated}


def proposal(registry, pip_id, proposal_id):
    """Read one immutable proposal without expiring it or exposing session linkage."""
    _text(pip_id, "pip_id")
    _text(proposal_id, "proposal_id")
    with _snapshot(registry) as db:
        owner = _bounded(db, "SELECT workspace_id FROM pips WHERE id=?", (pip_id,), {"workspace_id":128})
        if not owner:
            raise _bad("Pip not found on this runner.", "not_found")
        workspace_id = owner[0]["workspace_id"]
        _scope(db, workspace_id, registry.runner_id)
        # Membership is part of the SQL predicate, before any proposal JSON can
        # be fetched. A foreign Pip's malformed definition never gets decoded.
        fields = {"id":128,"pip_id":128,"expected_version":None,"definition":16384,
                  "actor":512,"reason":4000,"status":32,"created_at":40}
        rows = _bounded(db, "SELECT * FROM pip_proposals WHERE id=? AND pip_id=?", (proposal_id,pip_id), fields)
        if not rows:
            raise _bad("Proposal not found for this Pip.", "not_found")
        item = rows[0]
        item["definition"] = _json_object(item["definition"],16384)
        _integer(item["expected_version"],"Stored expected version",1,999999)
        if item["status"] not in ("proposed","accepted","rejected","expired","superseded"):
            raise _bad("Stored proposal status is invalid.")
        for key in ("id","pip_id","actor","created_at"):
            _text(item[key],"Stored proposal "+key,512 if key=="actor" else 128)
        if not isinstance(item["reason"],str):
            raise _bad("Stored proposal reason is invalid.")
        item["workspace_id"] = workspace_id
        approval_fields = {"id":128,"pip_id":128,"workspace_id":128,"expected_version":None,
                           "action_type":32,"action_summary":1024,"definition_digest":64,"status":32,"created_at":40,
                           "expires_at":40,"resolved_by":512,"resolved_at":40}
        approvals = _bounded(db,"SELECT * FROM pip_approvals WHERE proposal_id=?",(proposal_id,),approval_fields)
        if len(approvals)!=1:
            raise _bad("The proposal has no unique durable approval record.")
        approval = approvals[0]
        from .pip_approvals import digest
        if approval.pop("definition_digest") != digest(item["definition"]):
            raise _bad("The saved proposal does not match its durable approval digest.")
        if (approval.pop("pip_id")!=pip_id or approval.pop("workspace_id")!=workspace_id
                or approval.pop("expected_version")!=item["expected_version"]
                or approval["action_type"] not in ("job_update","schedule_update")
                or approval["status"] not in ("pending","approved","rejected","expired","superseded")):
            raise _bad("The proposal and approval metadata are inconsistent.")
        for key in ("id","action_summary","created_at","expires_at"):
            _text(approval[key],"Stored approval "+key,1024 if key=="action_summary" else 128)
        now = _now(registry)
        approval["effective_status"] = "expired" if approval["status"]=="pending" and approval["expires_at"]<=now else approval["status"]
        item["approval"] = approval
        return {"runner_id":registry.runner_id,"as_of":now,"proposal":item}
