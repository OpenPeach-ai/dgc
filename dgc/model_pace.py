"""How long each model usually takes to start replying, so "No response from the model" means something.

A slow model (a large cloud model behind a local Ollama, say) can take a minute or more to send its first token
on every request, and a fixed 45 s notice said "No response from the model" on most turns while nothing was wrong
(reported 28 Oct). DGC keeps each model's last few first-token waits, per endpoint, and the notice waits until a
request is well past what that model usually takes: twice its usual wait, never sooner than
``model_stall_notice_s``, and always before the first-token deadline that retries the request. A model DGC has
seen fewer than MIN_SAMPLES times keeps the plain setting.

The waits live in ~/.dgc/model-pace.json. Nothing here ever raises: a store that can't be read or written only
means the plain setting applies.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path

from .workspace import WorkspaceBoundaryError, read_regular_bytes

KEEP = 20            # waits kept per model
MODELS = 64          # models kept, the most recently used
MIN_SAMPLES = 5      # fewer, and the configured notice applies as it is
MAX_STORE_BYTES = 128 * 1024
_lock = threading.Lock()


def _path() -> Path:
    from . import config
    return Path(config.USER_HOME) / "model-pace.json"


def _key(model: str, endpoint: str) -> str:
    return f"{model}@{endpoint}"


def _load() -> dict:
    try:
        result = read_regular_bytes(_path(), maximum=MAX_STORE_BYTES, missing_ok=True)
        if result is None:
            return {}
        data = json.loads(result[0].decode("utf-8"))
    except (OSError, ValueError, UnicodeError, WorkspaceBoundaryError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, entry in list(data.items())[:MODELS]:
        if isinstance(key, str) and len(key) <= 512 and isinstance(entry, dict) and isinstance(entry.get("waits"), list):
            waits = [float(w) for w in entry["waits"][-KEEP:] if isinstance(w, (int, float))
                     and not isinstance(w, bool) and 0 < w < 3600]
            at = entry.get("at")
            try:
                valid_at = (isinstance(at, (int, float)) and not isinstance(at, bool)
                            and math.isfinite(at) and at >= 0)
            except OverflowError:
                valid_at = False
            if not valid_at:
                at = 0.0
            out[key] = {"waits": waits, "at": float(at)}
    return out


def record(model: str, endpoint: str, seconds: float) -> None:
    """One request's wait for its first token (a model load excluded)."""
    try:
        seconds = float(seconds)
    except (TypeError, ValueError, OverflowError):
        return
    if not model or len(_key(model, endpoint)) > 512 or not 0 < seconds < 3600:
        return
    with _lock:
        try:
            data = _load()
            entry = data.setdefault(_key(model, endpoint), {"waits": [], "at": 0.0})
            entry["waits"] = (entry["waits"] + [round(seconds, 2)])[-KEEP:]
            entry["at"] = time.time()
            if len(data) > MODELS:
                for key in sorted(data, key=lambda k: data[k]["at"])[:len(data) - MODELS]:
                    del data[key]
            path = _path()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".model-pace-", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(data, stream, separators=(",", ":"))
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        except OSError:
            pass


def usual(model: str, endpoint: str) -> float | None:
    """How long this model usually takes to start (its 90th-percentile wait), once DGC has seen enough."""
    waits = sorted(_load().get(_key(model, endpoint), {}).get("waits", []))
    if len(waits) < MIN_SAMPLES:
        return None
    return waits[max(0, math.ceil(0.9 * len(waits)) - 1)]


def usual_for(model: str, base_url: str) -> float:
    """How long ``model`` usually takes to start on the server at ``base_url``, whichever of its APIs DGC asked it
    through (its waits are kept per request URL: /api/chat, /v1/chat/completions …); 0 when DGC hasn't seen it
    enough. For saying, before the model is asked, how long the wait is likely to be."""
    try:
        from urllib.parse import urlsplit
        from .model_watch import safe_endpoint
        parts = urlsplit(safe_endpoint(str(base_url or "")))
        server = f"{parts.scheme}://{parts.netloc}"
        best = 0.0
        for key, entry in _load().items():
            name, _, endpoint = key.rpartition("@")
            if name != model or not (endpoint == server or endpoint.startswith(server + "/")):
                continue
            waits = sorted(entry.get("waits", []))
            if len(waits) >= MIN_SAMPLES:
                best = max(best, waits[max(0, math.ceil(0.9 * len(waits)) - 1)])
        return best
    except Exception:                        # noqa: BLE001 - only a hint: never fails what asks
        return 0.0


def notice_after(configured: float, model: str, endpoint: str, first_token_s: float = 0.0) -> tuple[float, float]:
    """``(threshold, usual)``: when to say "No response from the model" for this model's first token, and its
    usual wait (0 when unknown). 0 configured stays 0: the notice is off."""
    if configured <= 0:
        return configured, 0.0
    pace = usual(model, endpoint) or 0.0
    if not pace:
        return configured, 0.0
    threshold = max(configured, 2 * pace)
    if first_token_s > 0:                # say it before the request is retried, not after
        threshold = min(threshold, max(configured, 0.8 * first_token_s))
    return threshold, pace
