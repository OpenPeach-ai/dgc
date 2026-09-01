"""Turn real DGC sessions into scrubbed, training-ready JSONL.

`dgc export-training` reads the transcripts DGC already persists under
``~/.dgc/sessions/<project>/<id>.json`` (see :mod:`dgc.sessions`) and reshapes each one into a
single, self-contained training record: the conversation as a standard OpenAI-style ``messages``
array (``system`` / ``user`` / ``assistant``-with-``tool_calls`` / ``tool`` results) plus a small
``meta`` object with the outcome counters. The result is one JSON object per line — the shape
common SFT / tool-calling fine-tuning tooling expects — for fine-tuning a local model on your own
real work.

This is a read-only reader/exporter. It never mutates a session, and every field of every emitted
record is deep-scrubbed through :mod:`dgc.redaction` (``redact_value`` with ``secret_values(config)``
plus the shape-based credential detectors) before it leaves this module, so DGC-owned credentials
and high-confidence credential shapes cannot leak into a training corpus.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import sessions as sessions_mod
from .redaction import redact_value, secret_values

# The exported record documents its own shape so a downstream loader can validate it.
RECORD_SCHEMA_VERSION = 1
_TRAINING_ROLES = ("system", "user", "assistant", "tool")
_GOAL_COMPLETED = "completed"


def _coerce_arguments(value) -> str:
    """Normalize a tool call's arguments to a JSON string, as SFT tooling expects.

    Stored canonical calls carry either a decoded ``dict`` or the model's raw JSON string; both
    round-trip to a JSON string here so every exported call is uniform.
    """
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value if value is not None else {}, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return "{}"


def _clean_tool_calls(raw) -> list[dict]:
    """Keep only well-formed, named function calls in the portable Chat Completions shape."""
    calls: list[dict] = []
    if not isinstance(raw, list):
        return calls
    for index, call in enumerate(raw):
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = str(function.get("name") or "").strip()
        if not name:
            continue
        call_id = str(call.get("id") or "") or f"call_{index}"
        calls.append({
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": _coerce_arguments(function.get("arguments"))},
        })
    return calls


def _clean_messages(messages) -> tuple[list[dict], int]:
    """Reduce a stored transcript to a clean training trajectory.

    Only the training-relevant roles and fields survive: reasoning traces, provider continuation
    blobs, attached images and any ``_``-prefixed internal bookkeeping are dropped so the record is
    a portable conversation, not a DGC-internal replay buffer. Returns the trajectory and the number
    of user turns it contains.
    """
    out: list[dict] = []
    turns = 0
    if not isinstance(messages, list):
        return out, turns
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in _TRAINING_ROLES:
            continue
        content = message.get("content")
        content = content if isinstance(content, str) else ("" if content is None else str(content))
        clean: dict = {"role": role, "content": content}
        if role == "assistant":
            calls = _clean_tool_calls(message.get("tool_calls"))
            if calls:
                clean["tool_calls"] = calls
        elif role == "tool":
            clean["tool_call_id"] = str(message.get("tool_call_id") or "")
            name = str(message.get("name") or message.get("tool_name") or "").strip()
            if name:
                clean["name"] = name
        if role == "user":
            turns += 1
        out.append(clean)
    return out, turns


def _project_basename(record: dict) -> str:
    project = record.get("project")
    if not project:
        return ""
    try:
        return Path(str(project)).name
    except (TypeError, ValueError):
        return ""


def _outcome(record: dict, path: Path | None) -> dict:
    """Read the monotonic tool/edit counters — the outcome signal — for one session.

    Prefers the merged view (transcript + crash-safe ``.metrics`` journal) when a real path and its
    project are available; otherwise falls back to the counters embedded in the transcript.
    """
    project = record.get("project")
    if path is not None and project:
        try:
            return sessions_mod.activity_of(path, project, record=record)
        except Exception:
            pass
    activity = record.get("activity") if isinstance(record.get("activity"), dict) else {}
    out: dict[str, int] = {}
    for key in sessions_mod.ACTIVITY_KEYS:
        try:
            out[key] = max(0, int(activity.get(key, 0) or 0))
        except (TypeError, ValueError):
            out[key] = 0
    return out


def _is_successful(outcome: dict, record: dict) -> bool:
    """Heuristic for a session that shows real, successful work.

    True when the agent landed at least one edit with no failed edits, or when a standing goal was
    marked completed. Deliberately conservative: ``--successful-only`` should favor precision (clean
    finished work) over recall.
    """
    edits = int(outcome.get("edits", 0) or 0)
    edit_fails = int(outcome.get("edit_fails", 0) or 0)
    if edits > 0 and edit_fails == 0:
        return True
    return str(record.get("goal_status") or "") == _GOAL_COMPLETED


def build_record(record: dict, config=None, *, path: Path | None = None,
                 secrets: tuple[str, ...] | None = None) -> dict | None:
    """Build one fully scrubbed training record from a loaded session dict.

    Returns ``None`` for a structurally unusable or empty session (no messages / no user turn) so
    callers can skip it. Never raises on a malformed record.
    """
    try:
        if not isinstance(record, dict):
            return None
        messages, turns = _clean_messages(record.get("messages"))
        if not messages or turns == 0:
            return None
        outcome = _outcome(record, path)
        meta = {
            "session_id": str(record.get("id") or (path.stem if path is not None else "")),
            "model": str(getattr(config, "model", "") or ""),
            "project": _project_basename(record),
            "turns": turns,
            "messages": len(messages),
            "tool_calls": int(outcome.get("tool_calls", 0) or 0),
            "edits": int(outcome.get("edits", 0) or 0),
            "edit_fails": int(outcome.get("edit_fails", 0) or 0),
            "successful": _is_successful(outcome, record),
            "session_schema_version": record.get("schema_version"),
            "record_schema_version": RECORD_SCHEMA_VERSION,
        }
        name = record.get("name")
        if name:
            meta["name"] = str(name)
        clean = {"messages": messages, "meta": meta}
        # MANDATORY: no record leaves this function unscrubbed. Deep-redact every string leaf —
        # configured DGC credentials and high-confidence credential shapes alike.
        if secrets is None:
            secrets = secret_values(config)
        return redact_value(clean, secrets)
    except Exception:
        return None


def _load_session_file(path: Path) -> dict | None:
    """Read one session transcript defensively; never raise on a malformed/foreign file."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return None
    return data


def iter_training_records(session_files, config=None, *, successful_only: bool = False,
                          min_turns: int = 1):
    """Yield one scrubbed training record per usable session, skipping the rest.

    Skips (silently) any session that is malformed, empty, has fewer than ``min_turns`` user turns,
    or — when ``successful_only`` — does not show successful work.
    """
    secrets = secret_values(config)
    min_turns = max(1, int(min_turns or 1))
    for path in session_files:
        if path is None:
            continue
        path = Path(path)
        record = _load_session_file(path)
        if record is None:
            continue
        built = build_record(record, config, path=path, secrets=secrets)
        if built is None:
            continue
        if built["meta"]["turns"] < min_turns:
            continue
        if successful_only and not built["meta"]["successful"]:
            continue
        yield built


def write_jsonl(records, out_path) -> int:
    """Write records as one JSON object per line; returns the number written."""
    out = Path(out_path).expanduser()
    if out.parent and not out.parent.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with out.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, default=str))
            handle.write("\n")
            written += 1
    return written
