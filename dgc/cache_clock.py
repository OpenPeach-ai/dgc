"""The prompt cache's clock for a chat: when its cached conversation runs out, from the provider's own word.

The editor shows a small clock after the context meter, as Claude Code does (0.48): the minutes the
cached prefix has left, in whole minutes, or the clock alone in the error colour once it has gone. It
is shown only where DGC knows the answer from the provider itself, and only after a reply proved a
cache is in use:

* Anthropic: a reply's own cache read/write counters, and the lifetime its write used
  (``cache_creation.ephemeral_1h_input_tokens`` / ``ephemeral_5m_input_tokens``). An entry lives from
  the START of the request that wrote or read it (Anthropic's documentation), so the clock is anchored
  at that request's send time.
* A local Ollama: ``/api/ps`` lists the loaded model with the moment Ollama will unload it
  (``expires_at``), and the cached conversation goes with the model. Once it is no longer listed, it is
  gone.

Every other route -- OpenAI, DeepSeek, an Ollama ``:cloud`` model (never listed in /api/ps), a
subscription CLI -- does not publish a lifetime DGC can read, so the clock shows no minutes there
(the editor dims it and names the provider). The caching itself (cache markers, a stable request
start, Ollama's keep-alive) applies everywhere.

A record is what one reply taught: ``{"source", "anchor_ms", "ttl_s"?, "tokens", "model",
"endpoint"}`` plus ``compacted_ms`` once the conversation was compacted past it. ``wire_state`` turns
it into the ``cache_clock`` event's fields. Nothing here raises.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

TTL_SECONDS = {"5m": 300, "1h": 3600}
SOURCES = ("anthropic", "ollama")
# A loaded model Ollama keeps for good (keep_alive -1) reports an unload time centuries away.
_KEPT_FOR_GOOD_S = 30 * 24 * 3600


def _count(value) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 0 <= number <= 1_000_000_000 else 0


def record_from_reply(client, result, sent_at: float, previous: dict | None = None) -> dict | None:
    """What a finished main-conversation request says about the chat's prompt cache, or None.

    None means DGC cannot know for this route (or this reply showed no cache in use): no minutes.
    """
    try:
        model = str(getattr(client, "model", "") or "")
        base_url = str(getattr(client, "base_url", "") or "")
        api_mode = str(getattr(client, "api_mode", "") or "")
        family = str(getattr(client, "family", "") or "")
        cache = getattr(result, "cache", None) or {}
        if api_mode == "anthropic":
            if not isinstance(cache, dict) or not (_count(cache.get("read_tokens"))
                                                   or _count(cache.get("write_tokens"))):
                return None
            # The lifetime the provider says this reply's write used; a reply that only read keeps the
            # entry's own lifetime, which the last write named (or, failing that, what DGC asked for).
            ttl = str(cache.get("ttl") or "")
            if ttl not in TTL_SECONDS and previous and previous.get("source") == "anthropic" \
                    and previous.get("model") == model:
                ttl = {300: "5m", 3600: "1h"}.get(_count(previous.get("ttl_s")), "")
            if ttl not in TTL_SECONDS:
                ttl = str(cache.get("requested_ttl") or "5m")
            ttl = ttl if ttl in TTL_SECONDS else "5m"
            anchor = float(cache.get("sent_at") or sent_at or time.time())
            return {"source": "anthropic", "anchor_ms": int(anchor * 1000), "ttl_s": TTL_SECONDS[ttl],
                    "tokens": _count(cache.get("prompt_tokens")), "model": model[:512],
                    "endpoint": _endpoint(base_url)}
        if api_mode == "ollama" or family == "ollama":
            from .model_watch import is_local_endpoint, is_ollama_cloud_model
            if is_ollama_cloud_model(model) or not is_local_endpoint(base_url, family):
                return None
            usage = getattr(result, "usage", None) or {}
            tokens = _count(usage.get("input_tokens") if isinstance(usage, dict) else 0)
            return {"source": "ollama", "anchor_ms": int(float(sent_at or time.time()) * 1000),
                    "tokens": tokens, "model": model[:512], "endpoint": _ollama_root(base_url)}
    except Exception:                        # noqa: BLE001 -- a clock never costs a turn
        return None
    return None


def compacted(record: dict | None, at: float | None = None) -> dict | None:
    """The conversation was compacted: whatever was cached does not cover it any more."""
    if not record:
        return None
    return {**record, "compacted_ms": int((at if at is not None else time.time()) * 1000)}


def clean(record) -> dict | None:
    """A record read back from a saved session, or None when it is not one."""
    if not isinstance(record, dict) or record.get("source") not in SOURCES:
        return None
    anchor = _epoch_ms(record.get("anchor_ms"))
    if not anchor:
        return None
    out = {"source": record["source"], "anchor_ms": anchor, "tokens": _count(record.get("tokens")),
           "model": str(record.get("model") or "")[:512], "endpoint": str(record.get("endpoint") or "")[:2048]}
    if record["source"] == "anthropic":
        ttl = _count(record.get("ttl_s"))
        if ttl not in TTL_SECONDS.values():
            return None
        out["ttl_s"] = ttl
    if _epoch_ms(record.get("compacted_ms")):
        out["compacted_ms"] = _epoch_ms(record.get("compacted_ms"))
    return out


def _epoch_ms(value) -> int:
    """A wall-clock time in epoch milliseconds (2000..2200), or 0."""
    if isinstance(value, bool):
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 946_684_800_000 <= number <= 7_258_118_400_000 else 0


def wire_state(record: dict | None, *, now_ms: int | None = None, listed=None) -> dict:
    """The ``cache_clock`` event's fields for ``record``.

    ``listed`` is an Ollama /api/ps answer for the record's model: (True, expires_ms) while loaded,
    (False, 0) once unloaded, None when Ollama could not be asked (unknown: DGC does not know).
    """
    record = clean(record)
    if record is None:
        return {"state": "unknown"}
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    base = {"source": record["source"], "anchor_ms": record["anchor_ms"], "tokens": record["tokens"]}
    if record.get("compacted_ms"):
        return {**base, "state": "cold", "reason": "compacted", "anchor_ms": record["compacted_ms"]}
    if record["source"] == "anthropic":
        expires = record["anchor_ms"] + record["ttl_s"] * 1000
        state = {**base, "ttl_s": record["ttl_s"], "expires_ms": expires}
        return {**state, "state": "warm"} if expires > now else {**state, "state": "cold", "reason": "expired"}
    if not listed:
        return {"state": "unknown"}
    loaded, expires = listed
    if not loaded:
        return {**base, "state": "cold", "reason": "unloaded"}
    if expires and expires - now > _KEPT_FOR_GOOD_S * 1000:
        return {**base, "state": "warm"}            # kept loaded until Ollama stops: no countdown
    if not expires or expires <= now:
        return {**base, "state": "cold", "reason": "unloaded"}
    return {**base, "state": "warm", "expires_ms": int(expires)}


def ollama_listed(endpoint: str, model: str, *, timeout: float = 2.0):
    """Ask Ollama's /api/ps whether ``model`` is loaded and until when: (loaded, expires_ms), or None."""
    try:
        import requests
        response = requests.get(f"{str(endpoint).rstrip('/')}/api/ps", timeout=(timeout, timeout))
        if response.status_code != 200:
            return None
        payload = response.json()
    except Exception:                        # noqa: BLE001 -- Ollama not reachable: not known
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return None

    def normal(name) -> str:
        name = str(name or "").strip()
        return name[:-len(":latest")] if name.endswith(":latest") else name

    wanted = normal(model)
    for entry in payload["models"][:256]:
        if isinstance(entry, dict) and wanted in (normal(entry.get("name")), normal(entry.get("model"))):
            return True, parse_time_ms(entry.get("expires_at"))
    return False, 0


def parse_time_ms(value) -> int:
    """Ollama's RFC 3339 time (nanosecond fraction, any offset) as epoch milliseconds, or 0."""
    text = str(value or "").strip()
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})", text)
    if not match:
        return 0
    stamp, fraction, zone = match.groups()
    try:
        moment = datetime.fromisoformat(stamp + ("+00:00" if zone == "Z" else zone))
    except ValueError:
        return 0
    micros = int((fraction or "0")[:6].ljust(6, "0"))
    return int(moment.replace(microsecond=micros).astimezone(timezone.utc).timestamp() * 1000)


def _endpoint(url: str) -> str:
    from .model_watch import safe_endpoint
    return safe_endpoint(url)[:2048]


def _ollama_root(url: str) -> str:
    base = _endpoint(url).rstrip("/")
    for suffix in ("/v1", "/api"):
        if base.lower().endswith(suffix):
            return base[:-len(suffix)].rstrip("/")
    return base
