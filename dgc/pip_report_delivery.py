"""A finished Pip's report reaches the chat it reports to, as an item the user acts on.

"Pips detect, the chat fixes" had no path: nothing a Pip found ever reached a chat, so a model built
a polling monitor that woke a long chat on every run and applied fixes unattended. Now a finished
run appears in its chat's transcript as a card -- the Pip, what it found, and Ask DGC to fix / Open
report / Dismiss. It never starts a turn and never reaches the model by itself (the card is a
``_dgc_pip_reports`` record on a transcript message, and private keys never reach a provider). The
model reads a report only when the user sends a prompt that asks it to: the card's prepared prompt
names the run, and ``pips_context`` reads it.

Which chat. The chat a Pip was set up in, every chat it is attached to (``attach_pip_to_session``),
and, for that one run, the chat that ran it (``run_pip_now``). A Pip with no chat reports where it
always has: the Pips view, Needs attention and the home strip.

Which runs. A finished source review (Scout, Lens, Rook, Lock) or Pulse check, and a failed run of
either, said when it changes: a clean run after a clean run, the same findings again or the same
failure again is entered in the ledger but not shown. A run the chat asked for is always shown.
Older runs of one Pip that waited together fold into the newest ("2 earlier runs"). Conversation
replies, drafts and Patch work are not reports and stay in Pips.

Exactly once per chat. The ledger (``pip_report_deliveries``, keyed by chat and run) says a run
reached a chat; the chat's transcript says where. A run is entered in the ledger only after the
transcript that shows it is saved, and a run already in the transcript is never shown again, so a
crash between the two heals on the next look instead of showing the card twice.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from .redaction import redact_value, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, in_use, state_directory

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_report_deliveries(
 session_id TEXT NOT NULL, run_id TEXT NOT NULL, pip_id TEXT NOT NULL,
 outcome TEXT NOT NULL, signature TEXT NOT NULL, shown INTEGER NOT NULL CHECK(shown IN (0,1)),
 finished_at TEXT NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY(session_id,run_id));
CREATE INDEX IF NOT EXISTS pip_report_deliveries_pip ON pip_report_deliveries(session_id,pip_id,finished_at);
"""
KEY = "_dgc_pip_reports"           # on a transcript message: the cards that arrived after it
OUTCOMES = ("findings", "clear", "failed", "checks_failed", "checks_passed")
SEVERITIES = ("critical", "high", "medium", "low")
MAX_AGE = timedelta(days=7)         # an older run is history, not news
MAX_CANDIDATES = 200
MAX_SHOWN = 16                      # cards per look; one per Pip, and a chat has at most 16 attached
TOP_FINDINGS = 3
MAX_LEDGER = 20000
_RUN = re.compile(r"run_[0-9a-f]{32}\Z")
_PIP = re.compile(r"pip_[0-9a-f]{32}\Z")
_TYPES = ("core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill")

# What stopped a run, in a sentence a person can act on. The saved message goes beside it.
_REASONS = {
    "snapshot_limit": "The project is too big for it to copy for review.",
    "invalid_report": "Its model did not return a report in the format Pips needs.",
    "unverified_report": "A finding quoted code that does not match the file, so Pips refused the report.",
    "interrupted": "Pips stopped before the run finished.",
    "timeout": "It ran out of time.",
    "timed_out": "It ran out of time.",
    "source_unavailable": "It could not read the project's code.",
    "unsafe_snapshot": "The project has a file Pips will not copy.",
    "unsupported_source": "The project has a file Pips will not copy.",
    "output_limit": "It produced more output than Pips keeps.",
    "resource_limit": "It ran out of memory or processes.",
    "stale_grant": "Its checks changed after they were approved.",
    "execution_unavailable": "This computer cannot run its checks.",
    "unsupported_model": "Its model is not available.",
    "worker_failed": "Its worker stopped unexpectedly.",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def ensure(db) -> None:
    for statement in (part.strip() for part in SCHEMA.split(";")):
        if statement:
            db.execute(statement)


def _has_ledger(db) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pip_report_deliveries'").fetchone() is not None


def chat_identity(session_id: str) -> str:
    """What `run_pip_now` writes in `requested_by` for a run this chat started."""
    return "main-chat:" + hashlib.sha256(session_id.encode()).hexdigest()[:32]


def _links(db, session_id: str, workspace_id: str) -> dict[str, str]:
    """pip_id -> since when this chat hears from it: attached, or set up here (accepted)."""
    links: dict[str, str] = {}
    for row in db.execute("SELECT pip_id,created_at FROM session_pip_attachments WHERE session_id=? AND workspace_id=?",
                          (session_id, workspace_id)):
        links[row[0]] = row[1]
    for (raw,) in db.execute("""SELECT receipt FROM pip_setup_proposals WHERE session_id=? AND workspace_id=?
            AND status='accepted' AND length(CAST(receipt AS BLOB))<=4096 LIMIT 200""", (session_id, workspace_id)):
        try:
            receipt = json.loads(raw)
            pip_id, since = receipt["pip_id"], receipt["resolved_at"]
        except (TypeError, ValueError, KeyError, RecursionError):
            continue
        if receipt.get("accepted") is True and isinstance(pip_id, str) and isinstance(since, str):
            links[pip_id] = min(links.get(pip_id, since), since)
    return {pip: since for pip, since in links.items() if isinstance(pip, str) and _PIP.match(pip)}


def report_chats(registry, pip_id: str) -> int:
    """How many chats this Pip's reports reach (the Pip page says so, or how to attach one)."""
    ids = {row[0] for row in registry.db.execute(
        "SELECT session_id FROM session_pip_attachments WHERE pip_id=?", (pip_id,))}
    for session, raw in registry.db.execute("""SELECT session_id,receipt FROM pip_setup_proposals
            WHERE status='accepted' AND length(CAST(receipt AS BLOB))<=4096 LIMIT 2000"""):
        try:
            receipt = json.loads(raw)
        except (TypeError, ValueError, RecursionError):
            continue
        if isinstance(receipt, dict) and receipt.get("pip_id") == pip_id and receipt.get("accepted") is True:
            ids.add(session)
    return len(ids)


def report_session(registry, pip_id: str) -> str | None:
    """The newest chat this Pip reports to (attached, or set up there), or None: where Ask DGC to fix
    goes from the Pip's own chat."""
    found: list[tuple[str, str]] = [(row[1], row[0]) for row in registry.db.execute(
        "SELECT session_id,created_at FROM session_pip_attachments WHERE pip_id=?", (pip_id,))]
    for session, raw in registry.db.execute("""SELECT session_id,receipt FROM pip_setup_proposals
            WHERE status='accepted' AND length(CAST(receipt AS BLOB))<=4096 LIMIT 2000"""):
        try:
            receipt = json.loads(raw)
        except (TypeError, ValueError, RecursionError):
            continue
        if (isinstance(receipt, dict) and receipt.get("pip_id") == pip_id and receipt.get("accepted") is True
                and isinstance(receipt.get("resolved_at"), str)):
            found.append((receipt["resolved_at"], session))
    found = [(at, session) for at, session in found
             if isinstance(at, str) and isinstance(session, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session)]
    return max(found)[1] if found else None


def _pip(db, pip_id: str) -> dict | None:
    row = db.execute("""SELECT p.status,CASE WHEN length(CAST(v.definition AS BLOB))<=24576 THEN v.definition END
        FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?""", (pip_id,)).fetchone()
    if row is None or row[0] == "archived" or row[1] is None:
        return None
    try:
        definition = json.loads(row[1])
    except (ValueError, RecursionError):
        return None
    kind = definition.get("pip_type", "rook")
    name = definition.get("name")
    if kind not in _TYPES or not isinstance(name, str) or not name.strip():
        return None
    return {"name": _text(name, 120), "pip_type": kind}


def _reason(error) -> tuple[str, str]:
    error = error if isinstance(error, dict) else {}
    code = str(error.get("code") or "")
    detail = _text(error.get("message"), 600)
    return _REASONS.get(code, "It stopped with an error." if not detail else "It stopped: " + _text(detail, 200)), detail


def _check_label(test) -> str:
    argv = test.get("argv") if isinstance(test, dict) else None
    if not isinstance(argv, list) or not argv:
        return "a check"
    if argv[0] == "dgc-http-check" and len(argv) >= 3:
        return _text(f"GET {argv[1]} → {argv[2]}", 200)
    return _text(" ".join(str(part) for part in argv), 200)


def _audit(row, result) -> tuple[str, str, dict]:
    findings = [f for f in (result.get("findings") or []) if isinstance(f, dict)][:16] if isinstance(result, dict) else []
    counts = {level: 0 for level in SEVERITIES}
    for finding in findings:
        if finding.get("severity") in counts:
            counts[finding["severity"]] += 1
    ranked = sorted(findings, key=lambda f: SEVERITIES.index(f["severity"]) if f.get("severity") in SEVERITIES else 9)
    top = []
    for finding in ranked[:TOP_FINDINGS]:
        item = {"title": _text(finding.get("title"), 200), "severity": finding.get("severity") if finding.get("severity") in SEVERITIES else "low"}
        path = finding.get("path")
        if isinstance(path, str) and path.strip():
            item["path"] = _text(path, 300)
            if type(finding.get("line")) is int and finding["line"] > 0:
                item["line"] = finding["line"]
        top.append(item)
    key = sorted((str(f.get("severity")), str(f.get("title")), str(f.get("path")), str(f.get("line"))) for f in findings)
    signature = "findings:" + hashlib.sha256(json.dumps(key).encode()).hexdigest()[:24] if findings else "clear"
    return ("findings" if findings else "clear"), signature, {"total": len(findings), "counts": counts, "findings": top}


def _pulse(registry, row) -> tuple[str, str, dict] | None:
    from .pip_pulse_results import stored
    saved = stored(registry, row["workspace_id"], row["id"])
    if saved is None:
        return None
    progress, tests = saved["progress"], saved["manifest"]["job"]["verification_plan"]["action"]["tests"]
    failing = [index for index, command in enumerate(saved["receipt"]["commands"])
               if not (command["launch_state"] == "finished" and command["outcome"]["status"] == "passed")]
    checks = {"passed": progress["passed"], "failed": progress["total"] - progress["passed"], "total": progress["total"]}
    labels = [_check_label(tests[index]) for index in failing[:TOP_FINDINGS] if index < len(tests)]
    outcome = "checks_failed" if failing else "checks_passed"
    return outcome, "checks:" + ",".join(map(str, failing)) if failing else "checks:ok", {"checks": checks, "failed_checks": labels}


def _candidate(registry, row, pip) -> dict | None:
    """The card for one terminal run, with its ledger outcome and signature; None: not a report."""
    try:
        manifest = json.loads(row["manifest"]) if row["manifest"] else {}
    except (ValueError, RecursionError):
        manifest = {}
    kind = manifest.get("run_kind", "audit") if isinstance(manifest, dict) else None
    if kind not in ("audit", "test"):
        return None
    if registry.db.execute("SELECT 1 FROM pip_chat_messages WHERE run_id=? LIMIT 1", (row["id"],)).fetchone():
        return None                                     # a reply in the Pip's own chat, not a report
    report = {"run_id": row["id"], "pip_id": row["pip_id"], **pip, "kind": "checks" if kind == "test" else "audit",
              "finished_at": row["finished_at"], "earlier": 0}
    if row["status"] == "failed":
        try:
            error = json.loads(row["error"]) if row["error"] else None
        except (ValueError, RecursionError):
            error = None
        reason, detail = _reason(error)
        report.update(outcome="failed", reason=reason, detail=detail)
        signature = "failed:" + str((error or {}).get("code") or "")[:64]
        return {"report": report, "outcome": "failed", "signature": signature}
    if kind == "test":
        try:
            pulse = _pulse(registry, row)
        except (RegistryError, ValueError, TypeError, KeyError, IndexError, RecursionError):
            pulse = None
        if pulse is None:
            return None                                 # a handoff's test run, or evidence that no longer reads
        outcome, signature, fields = pulse
    else:
        try:
            result = json.loads(row["result"]) if row["result"] else {}
        except (ValueError, RecursionError):
            result = {}
        outcome, signature, fields = _audit(row, result)
    report.update(outcome=outcome, **fields)
    return {"report": report, "outcome": outcome, "signature": signature}


def pending(registry, session_id: str, *, exclude=(), now: datetime | None = None, secrets=()) -> list[dict]:
    """What this chat has not been told yet, oldest first: ``{"report", "outcome", "signature",
    "run_id", "pip_id", "finished_at", "shown"}`` for every run to enter in the ledger, with
    ``shown`` False for the runs that are recorded without a card. Reads only."""
    if not isinstance(session_id, str) or not session_id:
        return []
    identity = registry.session_identity(session_id)
    if identity is None:
        return []
    workspace_id = identity["workspace_id"]
    links = _links(registry.db, session_id, workspace_id)
    requester = chat_identity(session_id)
    floor = _iso((now or _now()) - MAX_AGE)
    ledger = _has_ledger(registry.db)
    marks = ",".join("?" for _ in links) or "NULL"
    rows = registry.db.execute(f"""SELECT id,pip_id,workspace_id,status,finished_at,
            CASE WHEN length(CAST(requested_by AS BLOB))<=128 THEN requested_by END AS requested_by,
            CASE WHEN length(CAST(manifest AS BLOB))<=131072 THEN manifest END AS manifest,
            CASE WHEN length(CAST(result AS BLOB))<=131072 THEN result END AS result,
            CASE WHEN length(CAST(error AS BLOB))<=16384 THEN error END AS error
        FROM pip_runs WHERE workspace_id=? AND status IN ('succeeded','failed') AND finished_at>=?
          AND (pip_id IN ({marks}) OR requested_by=?)
          {"AND id NOT IN (SELECT run_id FROM pip_report_deliveries WHERE session_id=?)" if ledger else ""}
        ORDER BY finished_at,id LIMIT ?""",
        (workspace_id, floor, *links, requester, *([session_id] if ledger else []), MAX_CANDIDATES)).fetchall()
    skip = set(exclude)
    by_pip: dict[str, list] = {}
    for row in rows:
        if row["id"] in skip or not _RUN.match(row["id"] or ""):
            continue
        asked = row["requested_by"] == requester
        if not asked and not (row["pip_id"] in links and row["finished_at"] >= links[row["pip_id"]]):
            continue                                     # finished before this chat heard from the Pip
        by_pip.setdefault(row["pip_id"], []).append((row, asked))
    out = []
    for pip_id, runs in by_pip.items():
        pip = _pip(registry.db, pip_id)
        made = []
        for row, asked in runs:
            candidate = _candidate(registry, row, pip) if pip else None
            entry = {"run_id": row["id"], "pip_id": pip_id, "finished_at": row["finished_at"], "asked": asked,
                     "outcome": candidate["outcome"] if candidate else "clear",
                     "signature": candidate["signature"] if candidate else "none",
                     "report": candidate["report"] if candidate else None, "shown": False}
            made.append(entry)
        reports = [entry for entry in made if entry["report"] is not None]
        previous = registry.db.execute("""SELECT signature FROM pip_report_deliveries WHERE session_id=? AND pip_id=?
            AND signature!='none' ORDER BY finished_at DESC,run_id DESC LIMIT 1""", (session_id, pip_id)).fetchone() if ledger else None
        newest = reports[-1] if reports else None
        if newest is not None:
            # Say it when it changes (any run since the last one told differs), or when this chat asked.
            if (newest["asked"] or previous is None
                    or any(entry["signature"] != previous[0] for entry in reports)):
                newest["shown"] = True
                newest["report"]["earlier"] = len(reports) - 1
            for entry in reports[:-1]:
                if entry["asked"]:                       # a run this chat asked for is never folded
                    entry["shown"] = True
                    if newest["shown"]:
                        newest["report"]["earlier"] -= 1
        out.extend(made)
    out.sort(key=lambda entry: (entry["finished_at"], entry["run_id"]))
    shown = [entry for entry in out if entry["shown"]]
    for entry in shown[:-MAX_SHOWN] if len(shown) > MAX_SHOWN else ():
        entry["shown"] = False
    for entry in out:
        if entry["report"] is not None:
            entry["report"] = redact_value(entry["report"], secrets)
    return out


def record(registry, session_id: str, entries) -> int:
    """Enter runs in this chat's ledger: once each, whatever happens later."""
    rows = [entry for entry in entries if _RUN.match(str(entry.get("run_id") or ""))]
    if not rows:
        return 0
    with registry.transaction():
        ensure(registry.db)
        now = registry.clock()
        added = 0
        for entry in rows:
            added += registry.db.execute("INSERT OR IGNORE INTO pip_report_deliveries VALUES(?,?,?,?,?,?,?,?)",
                (session_id, entry["run_id"], entry["pip_id"], entry["outcome"], entry["signature"],
                 1 if entry.get("shown") else 0, entry["finished_at"], now)).rowcount
        if registry.db.execute("SELECT count(*) FROM pip_report_deliveries").fetchone()[0] > MAX_LEDGER:
            # Only rows older than anything `pending` still looks at: they can never come back.
            registry.db.execute("DELETE FROM pip_report_deliveries WHERE finished_at<?",
                                (_iso(_now() - MAX_AGE - timedelta(days=1)),))
    return added


# ---- the transcript -------------------------------------------------------------------------------
def transcript_runs(messages) -> set[str]:
    """Run ids already shown in this transcript."""
    found = set()
    for message in list(messages or ()):
        records = message.get(KEY) if isinstance(message, dict) else None
        if isinstance(records, list):
            found.update(r.get("run_id") for r in records if isinstance(r, dict))
    return found


def valid_report(value) -> dict | None:
    if (not isinstance(value, dict) or not _RUN.match(str(value.get("run_id") or ""))
            or not _PIP.match(str(value.get("pip_id") or "")) or value.get("outcome") not in OUTCOMES
            or value.get("pip_type") not in _TYPES or not isinstance(value.get("name"), str)):
        return None
    return value


def history_items(message) -> list[dict]:
    """The replay items of the cards that arrived after ``message`` (dismissed ones are gone)."""
    records = message.get(KEY) if isinstance(message, dict) else None
    if not isinstance(records, list):
        return []
    return [{"role": "pip_report", "report": {k: v for k, v in r.items() if k != "dismissed"}}
            for r in records[:MAX_SHOWN] if valid_report(r) and r.get("dismissed") is not True]


class ChatReports:
    """One chat's live delivery. ``look`` reads the registry (any thread, one at a time) and returns
    the cards to show now; ``flush`` writes them into the transcript, saves it and enters them in the
    ledger. ``flush`` must run where the transcript may change: no turn running, or the turn's own
    thread between turns. Shown and not yet written, a card waits at the message that was last when
    it arrived, so a card that came during a turn is written after that turn, wherever it ends."""

    def __init__(self):
        self.waiting: dict[str, dict] = {}   # run_id -> {"session", "anchor", "entry"}: shown, not saved
        self.quiet: list[tuple[str, dict]] = []
        self.dismissed: set[str] = set()
        self.dirty = False
        self._signature = None
        self._lock = threading.RLock()
        self._looking = threading.Lock()

    def _changed(self) -> bool:
        """Cheap gate: has the registry been written since the last look? (SQLite in WAL mode)"""
        signature = []
        for name in ("registry.sqlite3", "registry.sqlite3-wal"):
            try:
                info = (state_directory() / name).stat()
                signature.append((info.st_mtime_ns, info.st_size))
            except OSError:
                signature.append(None)
        if signature == self._signature:
            return False
        self._signature = signature
        return True

    def look(self, agent, config, *, force: bool = False) -> list[dict]:
        if config.get("pips_enabled", False) is not True or not in_use():
            return []
        session = getattr(agent, "session_file", None)
        if session is None or not getattr(agent, "_session_exists", False):
            return []
        with self._looking:
            if not force and not self._changed():
                return []
            session_id = session.stem
            with self._lock:
                exclude = set(self.waiting)
            try:
                with WorkspaceRegistry() as registry:
                    registry.db.execute("BEGIN")
                    found = pending(registry, session_id, exclude=exclude, secrets=secret_values(config))
            except (RegistryError, OSError, sqlite3.Error, ValueError, TypeError, KeyError):
                self._signature = None               # look again next time
                return []
            messages = list(getattr(agent, "messages", None) or [])
            written = transcript_runs(messages)
            anchor = messages[-1] if messages else None
            shown = []
            with self._lock:
                for entry in found:
                    if entry["run_id"] in self.waiting:
                        continue
                    if entry["run_id"] in written:
                        # Saved in the transcript but not in the ledger (a crash between the two):
                        # enter it, never show it twice.
                        self.quiet.append((session_id, {**entry, "shown": True}))
                    elif entry["shown"]:
                        self.waiting[entry["run_id"]] = {"session": session_id, "anchor": anchor, "entry": entry}
                        shown.append(entry["report"])
                    else:
                        self.quiet.append((session_id, entry))
            return shown

    def dismiss(self, agent, run_id: str) -> bool:
        """Dismiss a card: in the transcript if it is there, else when it is written."""
        if not isinstance(run_id, str) or not _RUN.match(run_id):
            return False
        with self._lock:
            self.dismissed.add(run_id)
            for message in list(getattr(agent, "messages", None) or ()):
                records = message.get(KEY) if isinstance(message, dict) else None
                for item in records if isinstance(records, list) else ():
                    if isinstance(item, dict) and item.get("run_id") == run_id and item.get("dismissed") is False:
                        item["dismissed"] = True    # a value change, never a new key: safe beside a save
                        self.dirty = True
        return True

    def pending_write(self) -> bool:
        with self._lock:
            return bool(self.waiting or self.quiet or self.dirty)

    def flush(self, agent) -> bool:
        """Write waiting cards into the transcript, save it, then enter them in the ledger."""
        session = getattr(agent, "session_file", None)
        session_id = session.stem if session is not None else None
        with self._lock:
            for run in [run for run, item in self.waiting.items() if item["session"] != session_id]:
                self.waiting.pop(run, None)         # another chat now: it hears again when reopened
            self.quiet = [(sid, entry) for sid, entry in self.quiet if sid == session_id]
            if session_id is None or not (self.waiting or self.quiet or self.dirty):
                return True
            messages = getattr(agent, "messages", None)
            written = []
            if self.waiting and isinstance(messages, list) and messages:
                already = transcript_runs(messages)
                for run_id, item in list(self.waiting.items()):
                    if run_id not in already:
                        anchor = item["anchor"]
                        target = next((m for m in reversed(messages) if m is anchor), None) if anchor is not None else None
                        target = target if isinstance(target, dict) else messages[-1]
                        target.setdefault(KEY, []).append(dict(item["entry"]["report"], dismissed=run_id in self.dismissed))
                    written.append(item["entry"])
            saved = True
            if written or self.dirty:
                persist = getattr(agent, "_persist", None)
                saved = bool(persist()) if callable(persist) else False
            if not saved:
                return False                        # still waiting; the next look saves it
            self.dirty = False
            entries = [*written, *(entry for _sid, entry in self.quiet)]
            for entry in written:
                self.waiting.pop(entry["run_id"], None)
            self.quiet = []
        if entries:
            try:
                with WorkspaceRegistry() as registry:
                    record(registry, session_id, entries)
            except (RegistryError, OSError, sqlite3.Error):
                pass        # the transcript has them; the next look finds them there and enters them
        return True


def summary_line(report: dict) -> str:
    """The terminal's one line for a card: "Pip 'ERP daily audit' finished: 5 findings (2 high, 3 medium)"."""
    name = _text(report.get("name"), 120)
    outcome = report.get("outcome")
    if outcome == "failed":
        return f"Pip '{name}' failed: {_text(report.get('reason'), 200)}"
    if outcome == "clear":
        return f"Pip '{name}' finished: nothing found"
    checks = report.get("checks") if isinstance(report.get("checks"), dict) else {}
    if outcome == "checks_passed":
        return f"Pip '{name}' finished: all {checks.get('total', 0)} checks passed"
    if outcome == "checks_failed":
        return f"Pip '{name}' finished: {checks.get('failed', 0)} of {checks.get('total', 0)} checks failed"
    total = report.get("total", 0)
    counts = report.get("counts") if isinstance(report.get("counts"), dict) else {}
    worst = [f"{counts[s]} {s}" for s in SEVERITIES if isinstance(counts.get(s), int) and counts[s]]
    return (f"Pip '{name}' finished: {total} finding{'' if total == 1 else 's'}"
            + (f" ({', '.join(worst)})" if worst else ""))
