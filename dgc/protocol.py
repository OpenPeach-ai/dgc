"""Wire format for the headless backend: NDJSON events out, JSON commands in.

`Emitter` serializes one event per line (thread-safe, because the agent runs on a worker
thread while commands arrive on the reader thread). `PendingRequests` implements the three
blocking round-trips (permission / plan / options): the worker registers an id and blocks on
an Event; the reader resolves it when the front-end replies.
"""
from __future__ import annotations

import itertools
import json
import threading


class Emitter:
    def __init__(self, fp, validator=None):
        self.fp = fp
        self.validator = validator
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
            line = json.dumps(obj, default=str, ensure_ascii=False)
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
            if not slot:
                return False
            slot[1] = value
            slot[0].set()
            return True

    def cancel_all(self, value=None) -> None:
        with self._lock:
            for slot in self._slots.values():
                slot[1] = value
                slot[0].set()
