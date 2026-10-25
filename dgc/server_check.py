"""Ask a model server on this computer or network whether it is still working on a request.

A local model can take tens of minutes before its first token: a load from a slow disk, then a long
prefill. That silence is not a stall, and closing the request only makes the server start the
prompt again. So before DGC gives up on a silent request to a local server, it asks the server,
with the cheapest read-only call each kind offers:

    Ollama        GET /api/ps          the model is listed (loaded): working; not listed: loading.
                                       Once it was seen loaded, its disappearing means the model went
                                       away: idle. (``expires_at`` is no busy flag: Ollama freezes it
                                       during every request but the first after a load.)
    llama.cpp     GET /slots           a slot is processing: working; every slot idle: idle. A /slots
                                       that does not answer while /health does: its worker is busy.
                  GET /health          503 "Loading model": loading; 200: up.
    LM Studio     GET /api/v0/models   the model's state "loaded": working; "not-loaded": loading.
    vLLM, SGLang  GET /metrics         requests running or waiting: working; none: idle.
    any other     GET <base>/models    any answer: up, and nothing more can be said.

A server that refuses or cannot be reached is "gone"; one that accepted the connection but was slow
to answer a check is never gone (a llama.cpp worker answers /slots only between batches). Every
check is bounded (time and bytes), follows no redirect, and sends the request's own key, as the
request did, to the same host.

The verdicts are what :class:`dgc.model_watch.RequestWatch` acts on: it keeps waiting while the
server says ``working`` (or ``loading``), and closes the request only once the server has said
``gone`` or ``idle`` more than once in a row.
"""
from __future__ import annotations

import json
import re
import threading
import time
import requests

WORKING = "working"
LOADING = "loading"
IDLE = "idle"
GONE = "gone"
UNKNOWN = "unknown"

KINDS = ("ollama", "llamacpp", "lmstudio", "vllm", "generic")

_MAX_JSON_BYTES = 1 << 20
_MAX_METRICS_BYTES = 4 << 20
_TIMEOUT = (2.0, 5.0)           # connect, read: a check never waits long on its own
_TOTAL_S = 6.0

# What a compat endpoint turned out to be, per server root. Only positive answers are kept, so a
# server that was down when DGC first asked is asked again.
_detected: dict[str, str] = {}
_detected_lock = threading.Lock()

_METRIC_RE = re.compile(
    r"^(vllm:num_requests_running|vllm:num_requests_waiting|sglang:num_running_reqs"
    r"|sglang:num_queue_reqs)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$")


class _Unreachable(Exception):
    """The server refused the connection or could not be reached at all."""


class _Slow(Exception):
    """Connected, but no answer within the check's time."""


def server_root(base_url: str) -> str:
    """The server itself: the base URL without a trailing /v1 or /api."""
    base = str(base_url or "").rstrip("/")
    for suffix in ("/v1", "/api"):
        if base.lower().endswith(suffix):
            return base[:-len(suffix)].rstrip("/")
    return base


def _normal_name(name) -> str:
    text = str(name or "").strip()
    return text[:-len(":latest")] if text.endswith(":latest") else text


def _get(url: str, headers: dict, limit: int) -> tuple[int, bytes, str]:
    """(status, body up to ``limit`` bytes, content type). Raises _Unreachable or _Slow."""
    deadline = time.monotonic() + _TOTAL_S
    try:
        response = requests.get(url, headers=headers, stream=True, timeout=_TIMEOUT,
                                allow_redirects=False)
    except requests.ConnectTimeout as exc:
        raise _Unreachable(str(exc)) from exc
    except requests.Timeout as exc:          # connected; the answer was slow
        raise _Slow(str(exc)) from exc
    except requests.ConnectionError as exc:
        raise _Unreachable(str(exc)) from exc
    except (requests.RequestException, ValueError) as exc:
        raise _Slow(str(exc)) from exc
    try:
        body = bytearray()
        try:
            for chunk in response.iter_content(chunk_size=65_536):
                if chunk:
                    body.extend(chunk)
                if len(body) > limit or time.monotonic() > deadline:
                    break
        except requests.RequestException as exc:
            raise _Slow(str(exc)) from exc
        ctype = str((response.headers or {}).get("Content-Type", "")).lower()
        return int(response.status_code), bytes(body[:limit]), ctype
    finally:
        try:
            response.close()
        except Exception:
            pass


def _json(body: bytes):
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None


def _ollama_shape(value) -> bool:
    return isinstance(value, dict) and isinstance(value.get("models"), list)


def _slots_shape(value) -> bool:
    return (isinstance(value, list) and bool(value)
            and all(isinstance(slot, dict) for slot in value[:64])
            and any("is_processing" in slot or "state" in slot for slot in value[:64]))


def _lmstudio_shape(value) -> bool:
    return (isinstance(value, dict) and isinstance(value.get("data"), list)
            and any(isinstance(entry, dict) and "state" in entry for entry in value["data"][:512]))


def _metrics(body: bytes) -> float | None:
    """Requests running plus waiting, from a vLLM or SGLang /metrics page; None when it has neither."""
    total, seen = 0.0, False
    for line in body.decode("utf-8", "replace").splitlines():
        if not line or line[0] == "#":
            continue
        match = _METRIC_RE.match(line.strip())
        if not match:
            continue
        try:
            value = float(match.group(2))
        except ValueError:
            continue
        if value == value and value >= 0:
            total += value
            seen = True
    return total if seen else None


class ServerCheck:
    """One request's checks against its server. Call it for a verdict; it never raises.

    ``kind`` is what DGC already knows the server to be ("ollama", "llamacpp", "lmstudio", "vllm"),
    or "" to find out (once per server). ``num_ctx`` is the context an Ollama request asked for: a
    loaded copy of the model with another context is another request's, so its going away says
    nothing about this one.
    """

    def __init__(self, base_url: str, model: str, *, kind: str = "", headers: dict | None = None,
                 num_ctx: int = 0):
        self.base_url = str(base_url or "").rstrip("/")
        self.root = server_root(self.base_url)
        self.model = str(model or "")
        self.kind = kind if kind in KINDS else ""
        self.headers = dict(headers or {})
        try:
            self.num_ctx = max(0, int(num_ctx or 0))
        except (TypeError, ValueError):
            self.num_ctx = 0
        self.calls = 0
        self._seen_loaded = False       # this request's model was seen loaded at a settled check

    @property
    def reports_loading(self) -> bool:
        """Whether a check at the very start can tell a load (so it is worth asking at once)."""
        return self.kind in ("ollama", "lmstudio")

    def __call__(self) -> str:
        self.calls += 1
        try:
            kind = self.kind or self._detect()
            if kind == "ollama":
                return self._ollama()
            if kind == "llamacpp":
                return self._llamacpp()
            if kind == "lmstudio":
                return self._lmstudio()
            if kind == "vllm":
                return self._vllm()
            return self._generic()
        except _Unreachable:
            return GONE
        except _Slow:
            return UNKNOWN
        except Exception:
            return UNKNOWN

    # ---- per kind -------------------------------------------------------------------------------
    def _ollama(self) -> str:
        status, body, _ = _get(f"{self.root}/api/ps", self.headers, _MAX_JSON_BYTES)
        value = _json(body) if status == 200 else None
        if not _ollama_shape(value):
            return UNKNOWN
        target = _normal_name(self.model)
        if not target:
            return UNKNOWN
        ours = False
        for entry in value["models"][:256]:
            if not isinstance(entry, dict):
                continue
            if target not in (_normal_name(entry.get("name")), _normal_name(entry.get("model"))):
                continue
            try:
                window = int(entry.get("context_length") or 0)
            except (TypeError, ValueError):
                window = 0
            if not self.num_ctx or not window or window == self.num_ctx:
                ours = True
        return self._loaded(ours)

    def _loaded(self, ours: bool) -> str:
        """A server that lists loaded models: working while this request's model is loaded, loading
        until it is, idle when it went away after being seen. The first check (at the request's
        start) never counts as seen: a copy loaded then may be about to make room for this one."""
        if ours:
            if self.calls > 1:
                self._seen_loaded = True
            return WORKING
        # Not loaded, or only a copy with another context (another request's; this one waits for
        # it to make room): still to load, unless this request's copy was loaded and went away.
        return IDLE if self._seen_loaded else LOADING

    def _llamacpp(self) -> str:
        try:
            status, body, _ = _get(f"{self.root}/slots", self.headers, _MAX_JSON_BYTES)
        except _Slow:
            # /slots waits for the worker between batches; /health does not. Up and slow to
            # answer: the worker is busy.
            status, _, _ = _get(f"{self.root}/health", self.headers, _MAX_JSON_BYTES)
            return WORKING if status == 200 else UNKNOWN
        if status == 200:
            value = _json(body)
            if isinstance(value, list) and value and all(isinstance(slot, dict) for slot in value[:256]):
                busy = any(slot.get("is_processing") is True
                           or (isinstance(slot.get("state"), int) and not isinstance(slot.get("state"), bool)
                               and slot.get("state") != 0)
                           for slot in value[:256])
                return WORKING if busy else IDLE
        if status == 503 and b"loading" in body.lower():
            return LOADING
        status, body, _ = _get(f"{self.root}/health", self.headers, _MAX_JSON_BYTES)
        if status == 503 and b"loading" in body.lower():
            return LOADING
        return UNKNOWN

    def _lmstudio(self) -> str:
        status, body, _ = _get(f"{self.root}/api/v0/models", self.headers, _MAX_JSON_BYTES)
        value = _json(body) if status == 200 else None
        if not isinstance(value, dict) or not isinstance(value.get("data"), list):
            return UNKNOWN
        target = self.model.strip()
        for entry in value["data"][:512]:
            if isinstance(entry, dict) and str(entry.get("id") or "").strip() == target:
                state = str(entry.get("state") or "").lower()
                if state == "loaded":
                    return self._loaded(True)
                if state in ("not-loaded", "not_loaded", "unloaded"):
                    return self._loaded(False)
                return UNKNOWN
        return UNKNOWN

    def _vllm(self) -> str:
        status, body, _ = _get(f"{self.root}/metrics", self.headers, _MAX_METRICS_BYTES)
        if status == 200:
            pending = _metrics(body)
            if pending is not None:
                return WORKING if pending > 0 else IDLE
        status, _, _ = _get(f"{self.root}/health", self.headers, _MAX_JSON_BYTES)
        return UNKNOWN

    def _generic(self) -> str:
        _get(f"{self.base_url}/models", self.headers, 4096)
        return UNKNOWN                  # it answered: up, and that is all it can say

    # ---- what a compat endpoint is --------------------------------------------------------------
    def _detect(self) -> str:
        key = self.root.lower()
        with _detected_lock:
            known = _detected.get(key)
        if known:
            return known
        kind = "generic"
        for path, limit, test in (("/api/ps", _MAX_JSON_BYTES, lambda s, b: s == 200 and _ollama_shape(_json(b))),
                                  ("/slots", _MAX_JSON_BYTES,
                                   lambda s, b: (s == 200 and _slots_shape(_json(b)))
                                   or (s == 503 and b"loading" in b.lower())),
                                  ("/api/v0/models", _MAX_JSON_BYTES,
                                   lambda s, b: s == 200 and _lmstudio_shape(_json(b))),
                                  ("/metrics", _MAX_METRICS_BYTES,
                                   lambda s, b: s == 200 and _metrics(b) is not None)):
            try:
                status, body, _ = _get(f"{self.root}{path}", self.headers, limit)
            except _Slow:
                continue
            if test(status, body):
                kind = {"/api/ps": "ollama", "/slots": "llamacpp", "/api/v0/models": "lmstudio",
                        "/metrics": "vllm"}[path]
                break
        with _detected_lock:
            if len(_detected) > 256:
                _detected.clear()
            _detected[key] = kind
        return kind


def kind_for(family: str, api_mode: str = "") -> str:
    """The server kind DGC's provider family names, or "" to find out."""
    if api_mode == "ollama" or family == "ollama":
        return "ollama"
    if family in ("llamacpp", "lmstudio", "vllm"):
        return family
    return ""


def forget_detected(base_url: str = "") -> None:
    """Drop what was learned about a server (or every server)."""
    with _detected_lock:
        if base_url:
            _detected.pop(server_root(base_url).lower(), None)
        else:
            _detected.clear()

