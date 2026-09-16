"""This chat's `task` sub-agents: the registry behind the agents indicator.

One record per sub-agent that actually started, at any depth. The editor pill, the TUI shortcut-bar
segment and `/agents` all read it; `dgc serve` publishes every change as `agent_started` /
`agent_updated` / `agent_ended` frames and answers `list_agents` with a snapshot.

``total`` retains this chat's history; ``active`` counts agents queued, running or waiting on the
user right now. The composer lists every agent in the current turn until that turn ends, rather
than presenting the historical total as ongoing work.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from typing import Callable

from .redaction import REDACTED

ACTIVE = ("queued", "running", "waiting")
ENDED = ("finished", "failed", "stopped")
WAITING_FOR = ("permission", "answer")

MAX_RECORDS = 512          # records kept per chat (the oldest ended one goes first)
MAX_ITEMS = 64             # items in one snapshot
COALESCE_S = 1.0           # activity / progress frames per agent per second, at most one
MAX_DESCRIPTION = 200
MAX_MESSAGE = 500
MAX_ACTIVITY = 80
MAX_AGENT_TYPE = 64
MAX_MODEL = 200
MAX_CALL_ID = 256
MAX_MESSAGE_LINE = 120     # the one line a terminal row shows of a failure message
_MAX_SAFE = 2 ** 53 - 1
_URL_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'<>`]+")


def clip(text, limit: int) -> str:
    """Bound ALREADY-REDACTED text to ``limit`` characters, never keeping part of ``[REDACTED]``.

    Clipping before redaction can cut a credential so no rule matches the half that is kept
    (``https://user:tok…`` has no ``@``, ``sk-abc…`` is too short), so callers redact the whole
    string first and only then clip it here.
    """
    value = str(text or "")
    limit = max(1, int(limit))
    if len(value) <= limit:
        return value
    cut = limit - 1                                   # room for the ellipsis
    start = value.rfind(REDACTED, max(0, cut - len(REDACTED) + 1), cut + len(REDACTED))
    if 0 <= start < cut < start + len(REDACTED):
        cut = start                                   # drop the marker whole
    return value[:cut].rstrip() + "…"


def scrub_urls(text) -> str:
    """Every URL in ``text`` without its userinfo, query or fragment (``scheme://host:port/path``).

    A provider error quotes the endpoint it called, and redact_text removes known credentials and
    URL userinfo but not a ``?token=…`` query, so a failure message would carry it into the agents
    list. URLs with none of the three are left exactly as written."""
    def clean(match: re.Match) -> str:
        url = match.group(0)
        if not any(mark in url for mark in "@?#"):
            return url
        scheme, rest = url.split("://", 1)
        end = min([len(rest)] + [at for at in (rest.find(c) for c in "/?#") if at >= 0])
        host = rest[:end].rpartition("@")[2]           # userinfo can hold "@", "[", ":"
        path = rest[end:].split("#", 1)[0].split("?", 1)[0]
        return f"{scheme}://{host}{path}"
    return _URL_RE.sub(clean, str(text or ""))


def first_line(text, limit: int = MAX_MESSAGE_LINE) -> str:
    """The first non-empty line of ``text``, bounded for a one-line row."""
    for line in str(text or "").splitlines():
        if line.strip():
            return clip(" ".join(line.split()), limit)
    return ""


def _int(value) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, min(_MAX_SAFE, number))


def format_elapsed(ms) -> str:
    """``48s`` / ``1m 12s`` / ``2h 3m`` for a duration in milliseconds."""
    seconds = _int(ms) // 1000
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {seconds}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


class _Record:
    __slots__ = ("id", "parent_id", "call_id", "description", "agent_type", "model", "depth",
                 "state", "waiting_for", "activity", "started_at", "started_mono", "began_mono",
                 "duration_ms", "tool_calls", "tokens", "isolated", "parallel", "background",
                 "message", "turn_id", "restored", "listed", "dirty", "sent_activity",
                 "sent_tool_calls", "sent_tokens", "order")

    def __init__(self, **fields):
        self.parent_id = None
        self.call_id = None
        self.agent_type = ""
        self.model = ""
        self.waiting_for = None
        self.activity = ""
        self.started_at = None
        self.started_mono = self.began_mono = None
        self.duration_ms = None
        self.tool_calls = 0
        self.tokens = None
        self.message = ""
        self.turn_id = ""
        self.background = False
        self.restored = False
        self.listed = True
        self.dirty = False
        self.sent_activity = ""
        self.sent_tool_calls = 0
        self.sent_tokens = None
        for key, value in fields.items():
            setattr(self, key, value)

    def elapsed_ms(self, now: float) -> int:
        since = self.began_mono if self.began_mono is not None else self.started_mono
        return _int((now - since) * 1000) if since is not None else 0

    def item(self, now: float) -> dict:
        item = {"id": self.id, "parent_id": self.parent_id, "call_id": self.call_id,
                "description": self.description, "depth": self.depth, "state": self.state,
                "tool_calls": _int(self.tool_calls), "isolated": bool(self.isolated),
                "parallel": bool(self.parallel), "restored": bool(self.restored)}
        if self.background:
            item["background"] = True
        if self.agent_type:
            item["agent_type"] = self.agent_type
        if self.model:
            item["model"] = self.model
        if self.state == "waiting" and self.waiting_for:
            item["waiting_for"] = self.waiting_for
        if self.state in ACTIVE and self.activity:
            item["activity"] = self.activity
        if self.started_at is not None:
            item["started_at"] = self.started_at
        if self.state in ACTIVE and not self.restored:
            item["elapsed_ms"] = self.elapsed_ms(now) if self.state != "queued" else 0
        if self.state in ENDED and self.duration_ms is not None:
            item["duration_ms"] = _int(self.duration_ms)
        if self.tokens is not None:
            item["tokens"] = _int(self.tokens)
        if self.message:
            item["message"] = self.message
        if self.turn_id:
            item["turn_id"] = self.turn_id
        return item


class SubagentRegistry:
    """This chat's task sub-agents.

    Locks: ``_lock`` guards the records and is held only for short reads and writes. ``_publish``
    is taken BEFORE ``_lock`` (never the other way round) around "build the payload + call the
    listener", and by snapshot()/reset()/rebuild()/prune_to(), so frames reach the listener in
    exactly the order the state changed. The listener must not call back into the registry. Its
    exceptions are swallowed (an emitter ValueError must never break a worker thread); a swallowed
    exception is followed by one ``resync`` call, so a front end can ask for a fresh snapshot.

    Listener kinds: ``started`` / ``updated`` / ``ended`` (payloads shaped exactly like the
    protocol frames of the same names) and ``resync`` (empty payload).
    """

    def __init__(self, listener: Callable[[str, dict], None] | None = None):
        self.listener = listener
        self._lock = threading.Lock()
        self._publish = threading.RLock()
        self._records: dict[str, _Record] = {}
        self._order = 0
        self._total = 0
        self._ended_counts = {state: 0 for state in ENDED}
        self._timer: threading.Timer | None = None
        self._trace: list | None = None           # tests: (id, state) per transition, under _lock

    # ---- publishing --------------------------------------------------------------------------
    def _notify(self, kind: str, payload: dict) -> None:
        listener = self.listener
        if listener is None:
            return
        try:
            listener(kind, payload)
        except Exception:
            if kind == "resync":
                return
            try:
                listener("resync", {})
            except Exception:
                pass

    def _transition(self, record: _Record, state: str) -> None:
        record.state = state
        if self._trace is not None:
            self._trace.append((record.id, state))

    def _updated_payload(self, record: _Record, *, model: bool = False) -> dict:
        payload = {"id": record.id, "state": record.state}
        if record.state == "waiting" and record.waiting_for:
            payload["waiting_for"] = record.waiting_for
        if record.activity != record.sent_activity:
            payload["activity"] = record.activity
            record.sent_activity = record.activity
        if record.tool_calls != record.sent_tool_calls:
            payload["tool_calls"] = _int(record.tool_calls)
            record.sent_tool_calls = record.tool_calls
        if record.tokens is not None and record.tokens != record.sent_tokens:
            payload["tokens"] = _int(record.tokens)
            record.sent_tokens = record.tokens
        if model and record.model:
            payload["model"] = record.model
        record.dirty = False
        return payload

    def _ensure_timer_locked(self) -> None:
        if self._timer is not None:
            return
        timer = threading.Timer(COALESCE_S, self._flush)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _flush(self) -> None:
        with self._publish:
            with self._lock:
                self._timer = None
                payloads = []
                for record in self._records.values():
                    if not record.dirty:
                        continue
                    if record.state not in ACTIVE:
                        record.dirty = False
                        continue
                    payload = self._updated_payload(record)
                    if set(payload) - {"id", "state", "waiting_for"}:
                        payloads.append(payload)
            for payload in payloads:
                self._notify("updated", payload)

    # ---- lifecycle ---------------------------------------------------------------------------
    def start(self, *, id: str, parent_id: str | None = None, call_id: str | None = None,
              description: str = "", agent_type: str = "", depth: int = 1, isolated: bool = False,
              parallel: bool = False, queued: bool = False, turn_hint: str = "",
              model: str = "", background: bool = False) -> None:
        """A sub-agent started: ``queued`` in a parallel batch, else ``running``."""
        agent_id = str(id or "")
        if not agent_id:
            return
        now = time.monotonic()
        with self._publish:
            with self._lock:
                if agent_id in self._records:
                    return
                record = _Record(
                    id=agent_id, parent_id=str(parent_id) if parent_id else None,
                    call_id=clip(call_id, MAX_CALL_ID) if call_id else None,
                    description=clip(description, MAX_DESCRIPTION),
                    agent_type=clip(agent_type, MAX_AGENT_TYPE) if agent_type else "",
                    model=clip(model, MAX_MODEL) if model else "",
                    depth=max(1, min(3, _int(depth) or 1)), state="",
                    started_at=round(time.time(), 3), started_mono=now,
                    began_mono=None if queued else now,
                    isolated=bool(isolated), parallel=bool(parallel),
                    background=bool(background),
                    turn_id=str(turn_hint) if isinstance(turn_hint, str) else "",
                    order=self._order)
                self._order += 1
                self._transition(record, "queued" if queued else "running")
                self._make_room_locked()
                record.listed = len(self._records) < MAX_RECORDS
                self._records[agent_id] = record
                self._total += 1
                payload = {"id": record.id, "parent_id": record.parent_id, "call_id": record.call_id,
                           "description": record.description, "depth": record.depth,
                           "state": record.state, "started_at": record.started_at,
                           "isolated": record.isolated, "parallel": record.parallel}
                if record.background:
                    payload["background"] = True
                if record.agent_type:
                    payload["agent_type"] = record.agent_type
                if record.model:
                    payload["model"] = record.model
                if record.turn_id:
                    payload["turn_id"] = record.turn_id
            self._notify("started", payload)

    def _make_room_locked(self) -> None:
        if len(self._records) < MAX_RECORDS:
            return
        ended = sorted((r for r in self._records.values() if r.state in ENDED),
                       key=lambda r: r.order)
        for record in ended[:len(self._records) - MAX_RECORDS + 1]:
            del self._records[record.id]

    def running(self, id: str, *, model: str = "") -> None:
        """queued -> running (a worker slot was taken); with ``model``, also say which model."""
        model = clip(model, MAX_MODEL) if model else ""
        with self._publish:
            with self._lock:
                record = self._records.get(str(id or ""))
                if record is None or record.state in ENDED:
                    return
                changed_model = bool(model and model != record.model)
                if changed_model:
                    record.model = model
                if record.state == "queued":
                    self._transition(record, "running")
                    record.began_mono = time.monotonic()
                elif not changed_model:
                    return
                payload = self._updated_payload(record, model=changed_model)
            self._notify("updated", payload)

    def waiting(self, id: str, what: str | None) -> None:
        """running -> waiting (``permission`` / ``answer``); ``None`` -> running again."""
        with self._publish:
            with self._lock:
                record = self._records.get(str(id or ""))
                if record is None:
                    return
                if what:
                    if record.state != "running" or what not in WAITING_FOR:
                        return
                    record.waiting_for = what
                    self._transition(record, "waiting")
                else:
                    if record.state != "waiting":
                        return
                    record.waiting_for = None
                    self._transition(record, "running")
                payload = self._updated_payload(record)
            self._notify("updated", payload)

    def activity(self, id: str, label: str) -> None:
        """What the agent is doing now (a stall notice, a retry); ``""`` clears it. Coalesced."""
        label = clip(scrub_urls(label), MAX_ACTIVITY) if label else ""
        with self._lock:
            record = self._records.get(str(id or ""))
            if record is None or record.state not in ACTIVE or record.activity == label:
                return
            record.activity = label
            record.dirty = True
            self._ensure_timer_locked()

    def progress(self, id: str, *, tool_calls: int, tokens: int | None) -> None:
        """Running totals (a child's include its descendants'). Coalesced."""
        with self._lock:
            record = self._records.get(str(id or ""))
            if record is None or record.state not in ACTIVE:
                return
            calls = _int(tool_calls)
            count = _int(tokens) if tokens else None
            if calls == record.tool_calls and count == record.tokens:
                return
            record.tool_calls = max(record.tool_calls, calls)
            if count is not None:
                record.tokens = count
            record.dirty = True
            self._ensure_timer_locked()

    def end(self, id: str, state: str, message: str = "", *, tool_calls: int = 0,
            tokens: int | None = None) -> None:
        """An active record reached ``finished`` / ``failed`` / ``stopped``. The first one wins."""
        if state not in ENDED:
            return
        with self._publish:
            with self._lock:
                record = self._records.get(str(id or ""))
                if record is None or record.state not in ACTIVE:
                    return
                payload = self._end_locked(record, state, message, tool_calls, tokens)
            self._notify("ended", payload)

    def _end_locked(self, record: _Record, state: str, message: str, tool_calls, tokens) -> dict:
        now = time.monotonic()
        since = record.began_mono if record.began_mono is not None else record.started_mono
        record.duration_ms = _int((now - since) * 1000) if since is not None else 0
        record.tool_calls = max(_int(record.tool_calls), _int(tool_calls))
        if tokens:
            record.tokens = _int(tokens)
        record.message = clip(scrub_urls(message), MAX_MESSAGE) if message else ""
        record.waiting_for = None
        record.activity = ""
        record.dirty = False
        self._transition(record, state)
        self._ended_counts[state] += 1
        payload = {"id": record.id, "state": state, "duration_ms": record.duration_ms,
                   "tool_calls": _int(record.tool_calls)}
        if record.tokens is not None:
            payload["tokens"] = _int(record.tokens)
        if record.message:
            payload["message"] = record.message
        return payload

    def end_open(self, state: str, message: str) -> None:
        """Safety net: end every record that is still active."""
        if state not in ENDED:
            return
        with self._publish:
            with self._lock:
                open_records = sorted((r for r in self._records.values()
                                       if r.state in ACTIVE and not r.background),
                                      key=lambda r: r.order)
                payloads = [self._end_locked(r, state, message, 0, None) for r in open_records]
            for payload in payloads:
                self._notify("ended", payload)

    # ---- chat boundaries ---------------------------------------------------------------------
    def _clear_locked(self) -> None:
        timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()
        self._records = {}
        self._total = 0
        self._ended_counts = {state: 0 for state in ENDED}

    def reset(self) -> None:
        """A new chat: forget every record. A straggler's later update finds no record."""
        with self._publish:
            with self._lock:
                self._clear_locked()

    def rebuild(self, messages: list, session_key: str, *,
                redact: Callable[[str], str] | None = None) -> None:
        """A resumed chat: restored records from the transcript's `task` calls (see restore_records)."""
        restored = restore_records(messages, session_key, redact=redact)
        with self._publish:
            with self._lock:
                self._clear_locked()
                for fields in restored[-MAX_RECORDS:]:
                    record = _Record(order=self._order, **fields)
                    self._order += 1
                    self._records[record.id] = record
                    self._ended_counts[record.state] += 1
                self._total = len(restored)

    def saved_state(self) -> dict:
        """Keep nested records and measured metrics; neither is recoverable from parent prose."""
        with self._publish:
            with self._lock:
                now = time.monotonic()
                records = sorted(self._records.values(), key=lambda r: r.order)
                return {"version": 1, "items": [r.item(now) for r in records[:MAX_RECORDS]],
                        "counts": self._counts_locked()}

    def restore_state(self, value, *, redact: Callable[[str], str] | None = None) -> bool:
        """Load bounded metadata, settling in-flight agents as stopped after a process exit.

        Older sessions have no metadata and are still reconstructed from their task calls.
        Saved state is display data only: it cannot restart an agent or authorize a tool.
        """
        if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("items"), list):
            return False
        redact = redact or (lambda text: text)
        records, seen = [], set()
        for item in value["items"][:MAX_RECORDS]:
            if not isinstance(item, dict):
                continue
            identity = item.get("id")
            if not isinstance(identity, str) or not re.fullmatch(r"sub-[0-9a-f]{12}", identity) or identity in seen:
                continue
            state = item.get("state")
            if state not in (*ACTIVE, *ENDED):
                continue
            parent = item.get("parent_id")
            fields = {"id": identity, "parent_id": parent if isinstance(parent, str) and parent in seen else None,
                      "depth": max(1, min(3, _int(item.get("depth")))),
                      "state": "stopped" if state in ACTIVE else state,
                      "restored": True, "listed": True,
                      "isolated": item.get("isolated") is True, "parallel": item.get("parallel") is True,
                      "background": item.get("background") is True,
                      "tool_calls": _int(item.get("tool_calls"))}
            for key, limit in (("description", MAX_DESCRIPTION), ("message", MAX_MESSAGE),
                               ("model", MAX_MODEL), ("agent_type", MAX_AGENT_TYPE),
                               ("call_id", MAX_CALL_ID), ("turn_id", 128)):
                raw = item.get(key)
                fields[key] = clip(scrub_urls(redact(raw)), limit) if isinstance(raw, str) else ""
            for key in ("started_at", "duration_ms", "tokens"):
                if isinstance(item.get(key), (int, float)) and not isinstance(item[key], bool):
                    fields[key] = _int(item[key])
            if state in ACTIVE:
                fields["duration_ms"] = _int(item.get("elapsed_ms"))
                fields["message"] = "the backend stopped before this agent reported"
            records.append(fields)
            seen.add(identity)
        if value["items"] and not records:
            return False
        counts = value.get("counts") if isinstance(value.get("counts"), dict) else {}
        ended = {state: max(sum(r["state"] == state for r in records), _int(counts.get(state))) for state in ENDED}
        ended["stopped"] = max(ended["stopped"], _int(counts.get("stopped"))
                               + sum(_int(counts.get(state)) for state in ACTIVE))
        with self._publish:
            with self._lock:
                self._clear_locked()
                for fields in records:
                    record = _Record(order=self._order, **fields)
                    self._order += 1
                    self._records[record.id] = record
                self._ended_counts.update(ended)
                self._total = max(sum(ended.values()), _int(counts.get("total")), len(records))
        return True

    def prune_to(self, messages: list) -> None:
        """A rewind: keep records whose `task` call is still in the transcript, drop the rest.

        call_ids repeat across turns (``call_0``…), so the match is positional: with k surviving
        `task` calls carrying an id that started an agent, the k earliest top-level records with
        that id survive. A surviving call whose result says no agent started (a permission
        denial, the depth limit, a hook) is not counted, or it would keep a later turn's record
        with the same id alive. Nested records follow their top-level ancestor.
        """
        surviving: dict[str, int] = {}
        for _index, _call_index, call, _args, outcome in _task_outcomes(messages):
            if outcome is None:
                continue
            call_id = clip(str(call.get("id") or ""), MAX_CALL_ID)
            surviving[call_id] = surviving.get(call_id, 0) + 1
        with self._publish:
            with self._lock:
                kept: dict[str, _Record] = {}
                used: dict[str, int] = {}
                ordered = sorted(self._records.values(), key=lambda r: r.order)
                for record in ordered:
                    if record.parent_id is not None:
                        continue
                    key = record.call_id or ""
                    if used.get(key, 0) < surviving.get(key, 0):
                        used[key] = used.get(key, 0) + 1
                        kept[record.id] = record
                for record in ordered:          # parents always start before their children
                    if record.parent_id is not None and record.parent_id in kept:
                        kept[record.id] = record
                self._records = kept
                self._total = len(kept)
                self._ended_counts = {state: sum(1 for r in kept.values() if r.state == state)
                                      for state in ENDED}

    # ---- reads -------------------------------------------------------------------------------
    def counts(self) -> dict:
        with self._lock:
            return self._counts_locked()

    def _counts_locked(self) -> dict:
        counts = {state: 0 for state in ACTIVE}
        waiting_for = {kind: 0 for kind in WAITING_FOR}
        for record in self._records.values():
            if record.state in ACTIVE:
                counts[record.state] += 1
                if record.state == "waiting" and record.waiting_for in waiting_for:
                    waiting_for[record.waiting_for] += 1
        counts.update(self._ended_counts)
        counts["waiting_permission"] = waiting_for["permission"]
        counts["waiting_answer"] = waiting_for["answer"]
        counts["active"] = counts["queued"] + counts["running"] + counts["waiting"]
        counts["total"] = max(self._total, counts["active"] + sum(self._ended_counts.values()))
        return counts

    def snapshot(self, emit: Callable[[dict], None] | None = None) -> dict:
        """``{"items": [...<=64], "total": n, "active": k}``: every active record first (oldest
        first), then the most recent ended ones. With ``emit``, it is called with the snapshot
        while the publish lock is held, so no delta can reach the listener between the two."""
        with self._publish:
            with self._lock:
                now = time.monotonic()
                ordered = sorted((r for r in self._records.values() if r.listed),
                                 key=lambda r: r.order)
                active = [r for r in ordered if r.state in ACTIVE]
                ended = [r for r in ordered if r.state not in ACTIVE]
                room = max(0, MAX_ITEMS - len(active))
                chosen = active[:MAX_ITEMS] + (ended[-room:] if room else [])
                counts = self._counts_locked()
                snap = {"items": [r.item(now) for r in chosen], "total": counts["total"],
                        "active": counts["active"]}
            if emit is not None:
                emit(snap)
            return snap


# ---- restore from a saved transcript ------------------------------------------------------------
_NOT_STARTED = ("Max sub-agent depth reached", "PERMISSION DENIED", "PERMISSION NEEDED",
                "The user DENIED", "BLOCKED by a PreToolUse hook", "error:")


def _task_calls(messages):
    """Yield ``(message_index, call_index, call, arguments)`` for every assistant `task` call."""
    for index, message in enumerate(messages or []):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call_index, call in enumerate(message.get("tool_calls") or []):
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            if not isinstance(function, dict) or function.get("name") != "task":
                continue
            raw = function.get("arguments")
            args = raw
            if isinstance(raw, str):
                try:
                    args = json.loads(raw)
                except ValueError:
                    args = {}
            yield index, call_index, call, (args if isinstance(args, dict) else {})


def _result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) for part in content
                       if isinstance(part, dict) and part.get("type") in ("text", None))
    return str(content or "")


def classify_result(description: str, content: str | None) -> tuple[str, str] | None:
    """``(state, message)`` for a saved `task` result, or ``None`` when no agent started."""
    if content is None:
        return "stopped", ""
    text = str(content).lstrip()
    if text.startswith("error: Sub-task "):
        text = text[len("error: "):]
    head = f"Sub-task '{description}' "
    if text.startswith(head):
        rest = text[len(head):]
    elif text.startswith("Sub-task '"):
        # The description in the result can differ from the arguments (redaction, clamping);
        # the verbs DGC writes never contain "' ", so take the first one that follows a quote.
        rest = ""
        for verb in ("' completed", "' did not complete: ", "' was not started", "' cancelled before"):
            at = text.find(verb)
            if at >= 0:
                rest = text[at + 2:]
                break
        if not rest:
            return ("failed", "") if text.startswith("Sub-task failed without") else ("finished", "")
    else:
        if text.startswith("Sub-task failed without"):
            return "failed", ""
        if text.startswith(_NOT_STARTED):
            return None
        return "finished", ""
    if rest.startswith("completed"):
        return "finished", ""
    if rest.startswith("did not complete: "):
        reason = rest[len("did not complete: "):]
        if reason.startswith(("turn cancelled", "cancelled")):
            return "stopped", ""
        return "failed", reason.strip()
    if rest.startswith("was not started because its isolated configuration could not be created"):
        return "failed", rest.strip()
    if rest.startswith(("was not started", "cancelled before")):
        return None
    return "finished", ""


def _task_outcomes(messages, redact: Callable[[str], str] | None = None):
    """Yield ``(message_index, call_index, call, arguments, outcome)`` for every `task` call, its
    outcome from classify_result (``None`` when no agent started). Paired positionally: an
    assistant message's `task` calls with the `tool` messages after it and before the next
    assistant message, so a call_id repeated in another turn never borrows this turn's result."""
    redact = redact or (lambda text: text)
    messages = list(messages or [])
    results_after: dict[int, dict[str, str]] = {}
    current = None
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            current = index
            results_after[index] = {}
        elif role == "tool" and current is not None:
            call_id = str(message.get("tool_call_id") or "")
            results_after[current].setdefault(call_id, _result_text(message.get("content")))
    for index, call_index, call, args in _task_calls(messages):
        call_id = str(call.get("id") or "")
        description = redact(str(args.get("description") or ""))
        yield index, call_index, call, args, classify_result(
            description, results_after.get(index, {}).get(call_id))


def restore_records(messages, session_key: str, *,
                    redact: Callable[[str], str] | None = None) -> list[dict]:
    """Records for a reopened chat, one per `task` call that started an agent (see _task_outcomes)."""
    redact = redact or (lambda text: text)
    records = []
    for index, call_index, call, args, outcome in _task_outcomes(messages, redact):
        if outcome is None:
            continue
        call_id = str(call.get("id") or "")
        description = redact(str(args.get("description") or ""))
        state, message = outcome
        digest = hashlib.sha1(f"{session_key}:{index}:{call_index}".encode()).hexdigest()[:12]
        agent_type = redact(str(args.get("agent") or "")) if isinstance(args.get("agent"), str) else ""
        records.append({
            "id": f"sub-{digest}", "parent_id": None,
            "call_id": clip(call_id, MAX_CALL_ID) if call_id else None,
            "description": clip(description, MAX_DESCRIPTION),
            "agent_type": clip(agent_type, MAX_AGENT_TYPE) if agent_type else "",
            "depth": 1, "state": state,
            "message": clip(scrub_urls(redact(message)), MAX_MESSAGE) if message else "",
            "isolated": False, "parallel": False, "restored": True, "listed": True,
        })
    return records


# ---- shared text for the terminal surfaces ------------------------------------------------------
def summary_parts(counts: dict) -> list[str]:
    """``["5 agents", "2 working", "1 waiting for your permission", "2 finished"]`` (zeros omitted)."""
    total = _int(counts.get("total"))
    parts = [f"{total} agent" + ("" if total == 1 else "s")]
    for key, label in (("running", "working"), ("waiting_permission", "waiting for your permission"),
                       ("waiting_answer", "waiting for your answer"), ("queued", "queued"),
                       ("finished", "finished"), ("failed", "failed"), ("stopped", "stopped")):
        value = _int(counts.get(key))
        if value:
            parts.append(f"{value} {label}")
    return parts


def tree_items(items: list[dict]) -> list[tuple[int, dict]]:
    """Items in display order (by start, children directly under their parent), with a level."""
    by_id = {item.get("id"): item for item in items}
    children: dict[str | None, list[dict]] = {}
    for item in items:
        parent = item.get("parent_id")
        children.setdefault(parent if parent in by_id else None, []).append(item)
    ordered: list[tuple[int, dict]] = []

    def walk(parent, level):
        for item in sorted(children.get(parent, []),
                           key=lambda it: (it.get("started_at") is None, it.get("started_at") or 0)):
            ordered.append((level, item))
            walk(item.get("id"), level + 1)
    walk(None, 0)
    return ordered


def meta_text(item: dict, *, main_model: str = "", fmt_tokens: Callable[[int], str] | None = None,
              finished_word: bool = True, capitalize: bool = False) -> str:
    """The meta line of one row, parts joined with `` · `` and omitted when unknown:
    ``reviewer · qwen3.8:27b · 1m 12s · 14 tools · 18.2K tokens``. An ended row starts with its
    state word and message; a running row shows its activity in place of a state word; a restored
    row shows only the state word (and why it failed or stopped)."""
    fmt_tokens = fmt_tokens or (lambda n: f"{n:,}")
    state = str(item.get("state") or "")

    def word(text: str) -> str:
        return text[:1].upper() + text[1:] if capitalize else text
    parts = []
    if state == "waiting":
        parts.append(word("waiting for your answer" if item.get("waiting_for") == "answer"
                          else "waiting for your permission"))
    elif state == "queued":
        parts.append(word("queued"))
    elif state in ENDED and (finished_word or state != "finished"):
        parts.append(word(state))
    elif state == "running" and item.get("activity"):
        parts.append(str(item["activity"]))
    if state in ENDED and item.get("message"):
        parts.append(first_line(item["message"]))
    if item.get("restored") and item.get("duration_ms") is None and item.get("tokens") is None:
        return " · ".join(parts)
    if item.get("agent_type"):
        parts.append(str(item["agent_type"]))
    if item.get("model") and item.get("model") != main_model:
        parts.append(str(item["model"]))
    if state in ("running", "waiting") and item.get("elapsed_ms") is not None:
        parts.append(format_elapsed(item["elapsed_ms"]))
    elif state in ENDED and item.get("duration_ms") is not None:
        parts.append(format_elapsed(item["duration_ms"]))
    calls = _int(item.get("tool_calls"))
    if calls:
        parts.append(f"{calls} tool" + ("" if calls == 1 else "s"))
    if item.get("tokens"):
        parts.append(f"{fmt_tokens(_int(item['tokens']))} tokens")
    return " · ".join(parts)
