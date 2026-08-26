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
    def __init__(self, fp, validator=None, sanitizer=None):
        self.fp = fp
        self.validator = validator
        self.sanitizer = sanitizer
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
            try:
                self.fp.write(line + "\n")
                self.fp.flush()
            except (BrokenPipeError, ValueError):
                pass  # the front-end went away — let the read loop notice on EOF


class PendingRequests:
    """Blocking request registry. register() → (id, Event); the reader calls resolve(id, value)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._slots: dict[str, list] = {}   # id -> [Event, value]
        self._n = itertools.count(1)

    def register(self) -> tuple[str, threading.Event]:
        rid = f"r{next(self._n)}"
        ev = threading.Event()
        with self._lock:
            self._slots[rid] = [ev, None]
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
