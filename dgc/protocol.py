"""Wire format for the headless backend: NDJSON events out, JSON commands in.

`Emitter` serializes one event per line (thread-safe, because the agent runs on a worker
thread while commands arrive on the reader thread). `PendingRequests` implements correlated
blocking round-trips (permission / plan / options / MCP input): the worker registers an id and
blocks on an Event; the reader resolves it when the front-end replies.
"""
from __future__ import annotations

import itertools
import json
import threading


def strict_json_loads(value):
    """Parse standards-compliant JSON, rejecting Python's non-standard NaN/Infinity extension."""
    def reject_constant(_value):
        raise ValueError("non-finite numbers are not valid JSON")

    return json.loads(value, parse_constant=reject_constant)


class Emitter:
    def __init__(self, fp, validator=None, sanitizer=None, max_event_bytes=None):
        from .editor_protocol import MAX_EVENT_BYTES
        self.fp = fp
        self.validator = validator
        self.sanitizer = sanitizer
        self.max_event_bytes = int(max_event_bytes or MAX_EVENT_BYTES)
        self._lock = threading.Lock()
        self._seq = itertools.count()

    def emit(self, type: str, **fields) -> None:
        with self._lock:
            # Allocate the sequence under the same lock as the write. Multiple worker/provider
            # threads can emit concurrently; allocating before the lock allowed seq=1 to reach the
            # wire before seq=0 even though each individual write was atomic.
            obj = {"type": type, "seq": next(self._seq)}
            obj.update(fields)
            if self.validator:
                problem = self.validator(obj)
                if problem:
                    raise ValueError(f"invalid protocol event: {problem}")
            if self.sanitizer:
                obj = self.sanitizer(obj)
                if not isinstance(obj, dict):
                    raise ValueError("protocol event sanitizer returned a non-object")
                if self.validator:
                    problem = self.validator(obj)
                    if problem:
                        raise ValueError(f"sanitized protocol event is invalid: {problem}")
            line = json.dumps(obj, default=str, ensure_ascii=False, allow_nan=False)
            # A frame larger than the protocol's own ceiling is not a frame the front-end will
            # read: the editor treats it as a protocol violation and shuts the backend down, so an
            # oversized event is a way for the backend to get itself killed. Nothing upstream can
            # be trusted to have measured the WIRE size -- a screenshot capped at 4MB of PNG is
            # about 5.6MB once base64 and JSON-escaped -- so the last writer checks, and sends a
            # bounded replacement rather than something fatal.
            if len(line.encode("utf-8")) > self.max_event_bytes:
                obj = self._too_large(obj)
                line = json.dumps(obj, default=str, ensure_ascii=False, allow_nan=False)
            try:
                self.fp.write(line + "\n")
                self.fp.flush()
            except (BrokenPipeError, ValueError):
                pass  # the front-end went away — let the read loop notice on EOF

    # Correlation fields are what a blocked worker is waiting on. An event that carries one is a
    # question, not a notification: replacing it wholesale would leave the front-end with nothing
    # to answer and the worker waiting on an approval that can never arrive (human reviews wait
    # with no deadline). So shrink the payload and keep the envelope wherever that is possible.
    _CORRELATION = ("id", "request_id", "call_id", "turn_id", "session_id", "name")
    _PLACEHOLDER = "[dropped: too large for one protocol frame]"

    def _too_large(self, obj: dict) -> dict:
        """Shrink an over-ceiling event to fit, keeping whatever the front-end must still answer."""
        kind = str(obj.get("type", "event"))
        shrunk = {"type": kind, "seq": obj.get("seq", 0)}
        for key in self._CORRELATION:
            if key in obj and isinstance(obj[key], (str, int, float, bool, type(None))):
                shrunk[key] = obj[key]
        # Put the payload back only if it is small; anything bulky becomes a marker.
        for key, value in obj.items():
            if key in shrunk or key in ("type", "seq"):
                continue
            encoded = len(json.dumps(value, default=str, ensure_ascii=False)) if value is not None else 0
            if encoded <= 2048:
                shrunk[key] = value
            elif isinstance(value, dict):
                shrunk[key] = {}          # the schema types the field; an empty one still validates
            elif isinstance(value, list):
                shrunk[key] = []
            else:
                shrunk[key] = self._PLACEHOLDER
        line = json.dumps(shrunk, default=str, ensure_ascii=False, allow_nan=False)
        if len(line.encode("utf-8")) <= self.max_event_bytes and (
                not self.validator or not self.validator(shrunk)):
            return shrunk
        # The envelope itself cannot be made to fit or to validate: say so and keep correlation.
        message = (f"DGC dropped a {kind} event that exceeded the {self.max_event_bytes}-byte "
                   "protocol frame limit. The work continued; only this one message was too "
                   "large to send.")
        fallback = {"type": "error", "seq": obj.get("seq", 0), "message": message}
        return fallback


class PendingRequests:
    """Blocking request registry. register() → (id, Event); the reader calls resolve(id, value)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._slots: dict[str, list] = {}   # id -> [Event, value, optional response validator]
        self._n = itertools.count(1)

    def register(self, validator=None) -> tuple[str, threading.Event]:
        rid = f"r{next(self._n)}"
        ev = threading.Event()
        with self._lock:
            self._slots[rid] = [ev, None, validator]
        return rid, ev

    def value(self, rid: str):
        with self._lock:
            slot = self._slots.pop(rid, None)
        return slot[1] if slot else None

    def resolve(self, rid: str, value) -> bool:
        with self._lock:
            slot = self._slots.get(rid)
            # A request has one terminal result. In particular, a late approval must never
            # overwrite a deny/cancel that already released the waiting worker.
            if not slot or slot[0].is_set():
                return False
            if slot[2] is not None and not slot[2](value):
                return False
            slot[1] = value
            slot[0].set()
            return True

    def cancel_all(self, value=None) -> list[str]:
        """Resolve every still-pending request once and return the IDs this call cancelled."""
        with self._lock:
            cancelled = []
            for rid, slot in self._slots.items():
                if slot[0].is_set():
                    continue
                slot[1] = value
                slot[0].set()
                cancelled.append(rid)
            return cancelled
