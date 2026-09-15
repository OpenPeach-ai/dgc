"""A bounded, transient copy of the running turn for an atomic editor reload.

The saved transcript only contains completed model rounds. A reload in the middle of a
stream must also restore the bytes already sent, then resume strictly after the snapshot.
This cache is process-local, contains no image bytes, and is discarded between turns.
"""
from __future__ import annotations

import copy
import json
import threading

from .protocol import Emitter


DISPLAY_EVENTS = frozenset({
    "turn_start", "text_delta", "thinking_delta", "thinking_end", "stream_end",
    "tool_call", "tool_result", "tool_denied", "tool_images", "options_resolved",
    "model_retry", "monitor_event", "turn_activity", "turn_eta", "turn_end",
})


class HistoryEmitter(Emitter):
    """Serialize snapshots with display events, using the ordinary wire emitter underneath."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.history_lock = threading.RLock()
        self._turn_events = []
        self._turn_bytes = 0
        self._turn_id = ""
        self._complete = True

    def _remember(self, event):
        if not self._turn_id or not self._complete:
            return
        # Bound both text and event overhead. On overflow the persisted transcript remains the
        # fallback; it must not claim to cover unsaved bytes that we stopped retaining.
        size = len(json.dumps(event, ensure_ascii=True))
        self._turn_bytes += size
        if self._turn_bytes > 750_000:
            self._turn_events = []
            self._complete = False
            return
        previous = self._turn_events[-1] if self._turn_events else None
        if event.get("type") == "text_delta" and previous and previous.get("type") == "text_delta":
            previous["text"] += event["text"]
        else:
            self._turn_events.append(copy.deepcopy(event))

    def remember_steering(self, text):
        with self.history_lock:
            self._remember({"role": "steering", "text": str(text)[:50_000]})

    def emit(self, type: str, **fields) -> None:
        with self.history_lock:
            super().emit(type, **fields)
            if type in ("ready", "session", "rewound", "turn_start"):
                self._turn_events = []
                self._turn_bytes = 0
                self._complete = True
                self._turn_id = str(fields.get("turn_id") or "") if type == "turn_start" else ""
            if type in DISPLAY_EVENTS:
                self._remember({"type": type, **fields})

    def include_live(self, items, live):
        """Called under history_lock. Return the snapshot and whether its seq covers display."""
        if not live:
            return items, True
        if not self._complete or str(live.get("id") or "") != self._turn_id:
            return items, False
        start = next((i for i, item in enumerate(items)
                      if item.get("type") == "turn_start" and item.get("turn_id") == self._turn_id), len(items))
        # Leave enough room for the whole live turn. Drop old turns as units, never their prompts
        # alone, so a large snapshot still reaches the webview inside the normal replay budget.
        past = items[:start]
        while past and len(json.dumps(past, ensure_ascii=True)) + self._turn_bytes > 1_000_000:
            following = next((i for i, it in enumerate(past[1:], 1) if it.get("type") == "turn_start"), len(past))
            past = past[following:]
        if len(past) < start:
            past.insert(0, {"role": "notice", "text": "Showing the most recent saved context. Earlier messages remain in the session file."})
        return past + copy.deepcopy(self._turn_events), True
