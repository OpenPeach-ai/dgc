"""Provider-aware LLM client with native streaming, thinking/tool continuity,
and a text-protocol fallback for models without tool support."""
from __future__ import annotations

import base64
import binascii
import copy
import json
import hashlib
import math
import re
import threading
import time
from urllib.parse import quote
from dataclasses import dataclass, field
from datetime import timezone
from email.utils import parsedate_to_datetime

import requests

from . import reasoning as _reasoning
from .image_views import parse_dimensions as _image_dimensions   # one header parser, shared
from .model_watch import (RequestWatch, StallInfo, WaitChannel, WaitEvent, bounded_retries,
                          bounded_seconds, format_seconds, is_hosted_ollama, ollama_model_listed,
                          resolve_first_token_timeout, safe_endpoint)
from .model_watch import is_local_endpoint
from .model_errors import classify_exception, classify_status, eof_cause, hint_for, scrub_urls


_DATA_IMAGE_RE = re.compile(
    r"\Adata:image/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})\Z", re.IGNORECASE)
_IMAGE_PREFIX_BYTES = 256 * 1024
_IMAGE_PATCH_PIXELS = 28
_MAX_ESTIMATED_IMAGE_TOKENS = 16_384
_MAX_MODEL_METADATA_BYTES = 2 * 1024 * 1024
_MAX_MODEL_INFO_FIELDS = 4_096
_MAX_MODEL_METADATA_CACHE_ENTRIES = 256
_MODEL_METADATA_FAILURE_TTL_S = 30
_MODEL_METADATA_TOTAL_S = 4.0
_MAX_OLLAMA_JSON_BYTES = 8 * 1024 * 1024
_MAX_OLLAMA_STREAM_BYTES = 8 * 1024 * 1024
_MAX_OLLAMA_TOOL_CALLS = 4_096
_MAX_CHAT_JSON_BYTES = 8 * 1024 * 1024
_MAX_CHAT_STREAM_BYTES = 8 * 1024 * 1024
_MAX_CHAT_TOOL_CALLS = 4_096
_MAX_RESPONSES_JSON_BYTES = 8 * 1024 * 1024
_MAX_RESPONSES_STREAM_BYTES = 8 * 1024 * 1024
_MAX_RESPONSES_OUTPUT_ITEMS = 4_096
_MAX_RESPONSES_COMPACTION_BYTES = 8 * 1024 * 1024
_MAX_RESPONSES_COMPACTION_ITEMS = 4_096
_MODEL_CAPABILITY_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
_ANTHROPIC_VERSION = "2023-06-01"
_MAX_ANTHROPIC_JSON_BYTES = 8 * 1024 * 1024
_MAX_ANTHROPIC_STREAM_BYTES = 8 * 1024 * 1024
_ANTHROPIC_BLOCK_TYPE_RE = re.compile(r"\A[a-z][a-z0-9_]{0,63}\Z")
_ANTHROPIC_IMAGE_RE = re.compile(
    r"\Adata:(image/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]*={0,2})\Z",
    re.IGNORECASE,
)


def _decoded_base64_size(payload: str) -> int:
    if not payload or len(payload) % 4:
        return 0
    padding = len(payload) - len(payload.rstrip("="))
    return max(0, (len(payload) * 3) // 4 - padding)


def _bounded_model_tokens(raw) -> int:
    """Normalize an untrusted provider token limit without accepting booleans or absurd values."""
    if isinstance(raw, bool):
        return 0
    try:
        parsed = int(raw)
    except (TypeError, ValueError, OverflowError):
        return 0
    return parsed if 0 < parsed <= 10_000_000 else 0


def _image_prefix(payload: str) -> bytes:
    # Decode only enough for common dimension headers. Context estimation runs every model round;
    # re-decoding a validated multi-megabyte attachment here would itself become a performance bug.
    encoded = payload[:4 * ((_IMAGE_PREFIX_BYTES + 2) // 3)]
    encoded = encoded[:len(encoded) - (len(encoded) % 4)]
    try:
        return base64.b64decode(encoded, validate=True) if encoded else b""
    except (binascii.Error, ValueError):
        return b""


def _estimate_base64_image_tokens(payload: str) -> int:
    decoded_size = _decoded_base64_size(payload)
    if decoded_size <= 0:
        return 0
    dimensions = _image_dimensions(_image_prefix(payload))
    if dimensions:
        width, height = dimensions
        # Common vision adapters operate on a resized patch/tile grid. Compressed file size does
        # not consume language tokens, so once dimensions are known it must not inflate context.
        estimate = max(
            256,
            math.ceil(width / _IMAGE_PATCH_PIXELS)
            * math.ceil(height / _IMAGE_PATCH_PIXELS),
        )
    else:
        # Valid ingress is signature-checked, but a malformed/unsupported header can still lack
        # dimensions. Keep a bounded conservative fallback instead of treating base64 as prose.
        estimate = max(256, math.ceil(decoded_size / 768))
    return min(_MAX_ESTIMATED_IMAGE_TOKENS, estimate)


def _scrub_multimodal_images(value) -> tuple[object, int]:
    if isinstance(value, list):
        output, tokens = [], 0
        for item in value:
            clean, item_tokens = _scrub_multimodal_images(item)
            output.append(clean); tokens += item_tokens
        return output, tokens
    if not isinstance(value, dict):
        return value, 0
    kind = value.get("type")
    if kind == "image" and isinstance(value.get("source"), dict):
        source = value["source"]
        if source.get("type") == "base64":
            payload = str(source.get("data") or "")
            tokens = _estimate_base64_image_tokens(payload)
            if tokens:
                clean = dict(value)
                clean["source"] = {**source, "data": "[image]"}
                return clean, tokens
    if kind in ("image_url", "input_image"):
        key = "image_url" if "image_url" in value else "image"
        slot = value.get(key)
        uri = slot.get("url") if isinstance(slot, dict) else slot
        match = _DATA_IMAGE_RE.fullmatch(str(uri or ""))
        if match:
            tokens = _estimate_base64_image_tokens(match.group(1))
            if tokens:
                clean = dict(value)
                if isinstance(slot, dict):
                    clean[key] = {**slot, "url": "[image]"}
                else:
                    clean[key] = "[image]"
                return clean, tokens
    output, tokens = {}, 0
    for key, item in value.items():
        clean, item_tokens = _scrub_multimodal_images(item)
        output[key] = clean; tokens += item_tokens
    return output, tokens


def _scrub_ollama_images(messages: list[dict]) -> tuple[list[dict], int]:
    output, tokens = [], 0
    for message in messages:
        clean = dict(message)
        images = message.get("images")
        if isinstance(images, list):
            clean["images"] = []
            for payload in images:
                image_tokens = _estimate_base64_image_tokens(str(payload or ""))
                tokens += image_tokens
                clean["images"].append("[image]" if image_tokens else str(payload or ""))
        output.append(clean)
    return output, tokens


# ---- images a text-only endpoint refuses ------------------------------------------------------------
# A generic OpenAI-compatible endpoint is assumed to accept images until it says otherwise. Its
# refusal ("does not support image input", "image_url is not supported", a pydantic error naming the
# image part) used to be read as a refusal of native TOOLS: tools were switched off, the text
# protocol failed the same way, and the image stayed in the transcript so every later request failed
# too. Matched only when the request really carried an image part.
_IMAGE_REFUSAL_RE = re.compile(
    r"image_url|input_image|image input|images? (?:are|is) not supported|does not support images?|"
    r"multimodal|multi-modal|vision|unknown variant .?image|content type .?image", re.IGNORECASE)
_VISION_REJECTION_MIN_TTL_S = 3600.0


def _is_image_part(part) -> bool:
    if not isinstance(part, dict):
        return False
    kind = part.get("type")
    return kind in ("image_url", "input_image") or (kind == "image" and isinstance(part.get("source"), dict))


def _image_parts_in(messages) -> int:
    """Image parts in canonical, Responses or Anthropic messages (and Ollama ``images`` arrays)."""
    count = 0
    for message in messages or ():
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, list):
            count += sum(1 for part in content if _is_image_part(part))
        images = message.get("images")
        if isinstance(images, list):
            count += len(images)
    return count


def _strip_images_with_note(messages: list, model: str) -> tuple[list, int]:
    """A copy of ``messages`` with every image part replaced by a note the model can act on. The
    transcript itself is never changed: this is applied to the outgoing request only."""
    out: list = []
    dropped = 0
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list) or not any(_is_image_part(part) for part in content):
            out.append(message)
            continue
        kept = [part for part in content if not _is_image_part(part)]
        count = len(content) - len(kept)
        dropped += count
        note = (f"[{count} image{'s were' if count > 1 else ' was'} attached here, but {model} cannot "
                "read images. Say so and ask for a description, or suggest switching to a "
                "vision-capable model. Do not pretend to have seen "
                f"{'them' if count > 1 else 'it'}.]")
        clean = dict(message)
        clean["content"] = [*kept, {"type": "text", "text": note}]
        out.append(clean)
    return out, dropped


def _raw_socket(resp):
    """Best-effort reach into requests/urllib3 for the live socket, so a cancel can shut it
    down (SHUT_RDWR) and unblock a stalled read. Returns None if the internals differ."""
    raw = getattr(resp, "raw", None)
    for path in (("_connection", "sock"), ("_fp", "fp", "raw", "_sock"), ("_fp", "fp", "_sock")):
        obj = raw
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None and hasattr(obj, "shutdown"):
            return obj
    return None


def _close_response(response) -> None:
    """Release a streamed HTTP response without letting cleanup hide the provider error."""
    try:
        setattr(response, "_dgc_closed", True)
    except Exception:
        pass
    try:
        response.close()
    except Exception:
        pass


def _is_transport_interruption(exc: BaseException) -> bool:
    """True only for socket/HTTP read failures that may safely enter bounded reissue."""
    # RequestException is intentionally too broad here: requests.JSONDecodeError and several
    # caller/protocol failures inherit from it. Only failures meaning response bytes may have
    # stopped in transit belong on the recoverable, non-executable continuation path.
    return isinstance(exc, (
        ConnectionError, TimeoutError,
        requests.exceptions.ConnectionError,
        requests.exceptions.Timeout,
        requests.exceptions.ChunkedEncodingError,
        requests.exceptions.ContentDecodingError,
    ))


def _error_body(response, limit: int = 600) -> str:
    """Read a bounded error body and always release its streamed response."""
    try:
        maximum = max(0, int(limit))
        iterator = getattr(response, "iter_content", None)
        if callable(iterator):
            body = bytearray()
            for chunk in iterator(chunk_size=min(65_536, max(1, maximum + 1))):
                if not chunk:
                    continue
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8", "replace")
                remaining = maximum - len(body)
                if remaining > 0:
                    body.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    break
            return bytes(body).decode("utf-8", "replace")
        return str(response.text or "")[:maximum]
    finally:
        _close_response(response)


def _bounded_body_text(response, maximum: int, label: str, *, on_chunk=None) -> str | None:
    """Read one bounded response body as text, without deciding what shape it is.

    Returns None when the response exposes no body to read (an injected double with only
    ``json()``), so the caller can take the object path instead. Every path that consumes or
    rejects the response releases it, exactly as the JSON reader does. ``on_chunk`` is told about
    each received chunk: a buffered body carries no keep-alive noise, so bytes are progress.
    """
    raw_length = str((getattr(response, "headers", {}) or {}).get("Content-Length") or "")
    if raw_length:
        try:
            declared = int(raw_length)
        except (TypeError, ValueError):
            _close_response(response)
            raise LLMError(f"{label} returned an invalid Content-Length") from None
        if declared < 0 or declared > maximum:
            _close_response(response)
            raise LLMError(f"{label} exceeded {maximum} bytes")
    iterator = getattr(response, "iter_content", None)
    if callable(iterator):
        try:
            body = bytearray()
            for chunk in iterator(chunk_size=65_536):
                if not chunk:
                    continue
                if on_chunk is not None:
                    on_chunk()
                body.extend(chunk)
                if len(body) > maximum:
                    raise LLMError(f"{label} exceeded {maximum} bytes")
            try:
                return bytes(body).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise LLMError(f"{label} returned malformed JSON") from exc
        finally:
            _close_response(response)
    text = getattr(response, "text", None)
    if not isinstance(text, str):
        return None                     # no body here; the caller uses the object path
    if len(text.encode("utf-8", "replace")) > maximum:
        _close_response(response)
        raise LLMError(f"{label} exceeded {maximum} bytes")
    return text


def _bounded_json_response(response, maximum: int, label: str,
                           *, deadline: float | None = None, on_chunk=None):
    """Decode one streamed JSON response without trusting its declared or actual body size."""
    def check_deadline() -> None:
        if deadline is not None and time.monotonic() >= deadline:
            raise LLMError(f"{label} exceeded its time limit")

    try:
        check_deadline()
        raw_length = str((getattr(response, "headers", {}) or {}).get("Content-Length") or "")
        if raw_length:
            try:
                declared = int(raw_length)
            except (TypeError, ValueError):
                raise LLMError(f"{label} returned an invalid Content-Length") from None
            if declared < 0 or declared > maximum:
                raise LLMError(f"{label} exceeded {maximum} bytes")
        iterator = getattr(response, "iter_content", None)
        if callable(iterator):
            body = bytearray()
            for chunk in iterator(chunk_size=65_536):
                check_deadline()
                if not chunk:
                    continue
                if on_chunk is not None:
                    on_chunk()
                body.extend(chunk)
                if len(body) > maximum:
                    raise LLMError(f"{label} exceeded {maximum} bytes")
            check_deadline()
            try:
                return json.loads(bytes(body).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
                raise LLMError(f"{label} returned malformed JSON") from exc
        # Lightweight injected/test responses may expose only json(). Bound their normalized shape.
        try:
            value = response.json()
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            raise LLMError(f"{label} returned malformed JSON") from exc
        check_deadline()
        try:
            encoded = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
        except (RecursionError, TypeError, ValueError) as exc:
            raise LLMError(f"{label} returned malformed JSON") from exc
        if len(encoded) > maximum:
            raise LLMError(f"{label} exceeded {maximum} bytes")
        return value
    finally:
        _close_response(response)


def _own_watch(response, cancel, watch):
    """The watch a consumer should use: the caller's, or a cancel-only one it owns.

    Consumers used to start their own copied cancel watcher after headers arrived. A chat loop
    now passes the attempt's RequestWatch (which already covers the header wait); a consumer
    called directly with only ``cancel`` still gets immediate cancellation.
    """
    if watch is not None or cancel is None:
        return watch, None
    owned = RequestWatch(cancel)
    owned.attach_response(response)
    owned.start()
    return owned, owned


def _bounded_json_lifecycle(response, maximum: int, label: str, cancel=None, watch=None):
    """Read one bounded JSON body and distinguish cancellation from transport interruption."""
    watch, owned = _own_watch(response, cancel, watch)
    try:
        value = _bounded_json_response(
            response, maximum, label, on_chunk=watch.progress if watch is not None else None)
    except Exception as exc:
        if cancel is not None and cancel.is_set():
            return None, "cancelled"
        if _is_transport_interruption(exc):
            if watch is not None:
                watch.observe_error(exc)
            return None, "incomplete"
        raise
    finally:
        if owned is not None:
            owned.stop()
    if cancel is not None and cancel.is_set():
        return None, "cancelled"
    return value, ""


def _stall_of(watch, finish_reason: str) -> dict | None:
    """The stall that ended an attempt, when the attempt really did end without a terminal event."""
    if watch is None or finish_reason != "incomplete":
        return None
    info = getattr(watch, "stall", None)
    return info.as_dict() if isinstance(info, StallInfo) else None


def _interruption_of(watch, finish_reason: str, transport: str) -> dict | None:
    """Why a generation ended before its terminal event, when no stall explains it.

    A transport error the watch saw (a reset, a broken chunked body) names itself; a clean EOF is
    described by the terminal event this transport never sent. ``None`` for anything that is not
    an interruption, and for a stall (``ChatResult.stall`` carries that one).
    """
    if finish_reason != "incomplete":
        return None
    if watch is not None and isinstance(getattr(watch, "stall", None), StallInfo):
        return None
    endpoint = str(getattr(watch, "endpoint", "") or "") if watch is not None else ""
    error = getattr(watch, "transport_error", None) if watch is not None else None
    cause = eof_cause(transport, endpoint=endpoint)
    if error is not None:
        seen = classify_exception(error, endpoint=endpoint, streaming=True)
        if seen.kind in ("reset", "stream_cut"):
            cause = seen
        else:
            from dataclasses import replace as _replace
            cause = _replace(cause, detail=seen.detail or cause.detail)
    return {"kind": cause.kind, "summary": cause.summary, "detail": cause.detail,
            "endpoint": cause.endpoint, "transport": transport}


def _with_cause(error: Exception, cause, attempts: int) -> Exception:
    """Attach the structured cause and the number of requests made to a raised model error."""
    error.cause = cause
    error.attempts = max(0, int(attempts))
    return error


def _raw_chunks(raw, response):
    """Read a close-delimited or Content-Length body as bytes arrive.

    ``iter_content(65536)`` asks urllib3 for 64 KiB, and for a body that is not chunked urllib3
    waits for all of it or EOF: tokens written 1.5 s apart all arrived together at the end, which
    an idle-token watcher would read as silence. ``read1`` returns what the socket has. Errors are
    translated exactly the way requests translates them for iter_content.
    """
    from urllib3.exceptions import DecodeError, ProtocolError, ReadTimeoutError
    from urllib3.exceptions import SSLError as _Urllib3SSLError
    while True:
        # Only the watcher's own close ends this early. `raw.closed` is not a stop signal: urllib3
        # can hold decoded bytes after the socket reached EOF, and read1 drains them first.
        if getattr(response, "_dgc_closed", False):
            return
        try:
            chunk = raw.read1(65_536, decode_content=True)
        except ProtocolError as exc:
            raise requests.exceptions.ChunkedEncodingError(exc) from exc
        except DecodeError as exc:
            raise requests.exceptions.ContentDecodingError(exc) from exc
        except ReadTimeoutError as exc:
            raise requests.exceptions.ConnectionError(exc) from exc
        except _Urllib3SSLError as exc:
            raise requests.exceptions.SSLError(exc) from exc
        except (ValueError, AttributeError):
            if getattr(response, "_dgc_closed", False) or getattr(raw, "closed", False):
                return          # the watcher closed the response under this read
            raise
        if not chunk:
            return
        yield chunk


def _bounded_stream_lines(response, maximum: int, label: str):
    """Yield decoded lines while bounding real streamed bodies before line buffering."""
    iterator = getattr(response, "iter_content", None)
    if not callable(iterator):
        total = 0
        for line in response.iter_lines(decode_unicode=True):
            raw = (line if isinstance(line, bytes)
                   else str(line or "").encode("utf-8", "replace"))
            total += len(raw)
            if total > maximum:
                raise LLMError(f"{label} exceeded its safety bound")
            yield raw.decode("utf-8", "replace")
        return

    body = getattr(response, "raw", None)
    if callable(getattr(body, "read1", None)) and getattr(body, "chunked", None) is False:
        chunks = _raw_chunks(body, response)          # a real, non-chunked urllib3 body
    else:
        chunks = iterator(chunk_size=65_536)          # chunked bodies and injected doubles
    total = 0
    pending = bytearray()
    for chunk in chunks:
        if not chunk:
            continue
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8", "replace")
        total += len(chunk)
        if total > maximum:
            raise LLMError(f"{label} exceeded its safety bound")
        pending.extend(chunk)
        while True:
            newline = pending.find(b"\n")
            if newline < 0:
                break
            line = bytes(pending[:newline])
            del pending[:newline + 1]
            yield line.rstrip(b"\r").decode("utf-8", "replace")
    if pending:
        yield bytes(pending).rstrip(b"\r").decode("utf-8", "replace")


def _retry_delay(headers, default: float, cap: float = 10.0) -> float:
    """Return a safe bounded Retry-After delay, accepting seconds or an HTTP date."""
    try:
        fallback = float(default)
    except (TypeError, ValueError, OverflowError):
        fallback = 0.0
    if not math.isfinite(fallback):
        fallback = 0.0

    raw = str((headers or {}).get("Retry-After") or "").strip()
    delay = fallback
    if raw:
        try:
            delay = float(raw)
        except (TypeError, ValueError, OverflowError):
            try:
                retry_at = parsedate_to_datetime(raw)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                delay = retry_at.timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = fallback
    if not math.isfinite(delay):
        delay = fallback
    return min(max(0.0, delay), max(0.0, cap))


def _wait_for_retry(delay: float, cancel=None) -> bool:
    """Wait for a retry budget, returning False as soon as cancellation becomes terminal."""
    try:
        bounded = float(delay)
    except (TypeError, ValueError, OverflowError):
        bounded = 0.0
    if not math.isfinite(bounded):
        bounded = 0.0
    bounded = min(max(0.0, bounded), 10.0)
    if cancel is not None and cancel.is_set():
        return False
    if bounded <= 0:
        return True
    if cancel is None:
        time.sleep(bounded)
        return True

    # threading.Event can wake immediately. Deadline/composite cancellation views only expose
    # is_set(), so poll those in short slices rather than sleeping through the turn deadline.
    waiter = getattr(cancel, "wait", None) if cancel is not None else None
    if callable(waiter):
        try:
            if waiter(bounded):
                return False
            return not cancel.is_set()
        except (AttributeError, TypeError):
            pass
    deadline = time.monotonic() + bounded
    while True:
        if cancel is not None and cancel.is_set():
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return cancel is None or not cancel.is_set()
        time.sleep(min(remaining, 0.05))


MODEL_STALL_HINT = (
    "the server is reachable but the model produced nothing — check its log (a model still loading, "
    "an overloaded or wedged worker); raise model_first_token_timeout_s for very large prompts, "
    "or set fallback_model")
_STALL_MESSAGE_RE = re.compile(
    r"no response from model '|opened a stream but sent no tokens|did not finish loading within"
    r"|stopped streaming: no tokens")


def explain_llm_error(message: str, *, model: str = "", base_url: str = "") -> str:
    """Turn a transport failure into the two lines `dgc doctor` would print.

    A fresh install's first message used to be a raw `HTTP 404 from http://…: model 'x' not
    found` or a `Connection refused`; doctor already knew what each meant and what to do.
    The original message stays first, so nothing is hidden.
    """
    text = str(message or "")
    low = text.lower()
    hint = ""
    kind = ""
    if _STALL_MESSAGE_RE.search(low):
        # The server is up -- it accepted the request -- so "start your server" would be wrong.
        kind = "stall"
    elif re.search(r"name or service not known|nodename nor servname|getaddrinfo"
                   r"|temporary failure in name resolution|nameresolutionerror|could not resolve host",
                   low):
        kind = "dns"
    elif re.search(r"certificate_verify_failed|sslerror|certificate verify failed|tls handshake", low):
        kind = "tls"
    elif re.search(r"proxyerror|unable to connect to proxy|the proxy refused", low):
        kind = "proxy"
    elif re.search(r"connection refused|failed to establish|max retries|could not connect"
                   r"|connection error|unreachable|timed out|timeout|no route to host", low):
        kind = "connect"
    elif re.search(r"\b404\b|not found|no such model|does not exist|unknown model", low):
        kind = "model_not_found"
    elif re.search(r"\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication|forbidden", low):
        kind = "auth"
    elif re.search(r"\b429\b|rate limit|too many requests", low):
        kind = "rate_limited"
    elif re.search(r"\b50[023]\b|bad gateway|service unavailable|internal server error", low):
        kind = "http"
    if kind:
        # The same words a retry line and an error row show (model_errors.hint_for), with the
        # endpoint stripped of credentials and query strings before it is printed.
        hint = hint_for(kind, model=model, base_url=base_url)
    return f"{text}\n  → {hint}" if hint else text


class LLMError(Exception):
    pass


class ModelStallError(LLMError):
    """A model request produced nothing within its window, on every allowed attempt.

    The endpoint answered the connection, so this is not an unreachable server: it names the
    model and endpoint (never credentials or a query string) and carries its own hint.
    """

    hint = MODEL_STALL_HINT

    def __init__(self, info: StallInfo, *, api_mode: str = "", attempts: int = 1):
        self.info = info
        self.endpoint = info.endpoint
        self.model = info.model
        self.api_mode = api_mode
        self.phase = info.phase
        self.silent_s = info.silent_s
        self.attempts = max(1, int(attempts))
        self.noise_frames = info.noise_frames
        super().__init__(self._message())

    def _message(self) -> str:
        seconds = format_seconds(self.info.window_s or self.silent_s)
        tries = f"{self.attempts} attempt{'s' if self.attempts != 1 else ''}"
        model, endpoint = self.model or "the model", self.endpoint or "the endpoint"
        if self.phase == "loading":
            return f"model '{model}' at {endpoint} did not finish loading within {seconds}"
        if self.phase == "headers":
            return (f"no response from model '{model}' at {endpoint}: the server accepted the "
                    f"request but sent no response headers for {seconds} ({tries})")
        noise = (f"; {self.noise_frames} keep-alive frame{'s' if self.noise_frames != 1 else ''} only"
                 if self.noise_frames else "")
        return (f"model '{model}' at {endpoint} opened a stream but sent no tokens for "
                f"{seconds} ({tries}{noise})")


class ContextOverflowError(LLMError):
    """The request exceeded the model's context window. Recoverable: the agent compacts + retries once."""


class ToolsUnsupportedError(LLMError):
    """The endpoint rejected native tools; caller must retry with text-tool instructions."""


# Overflow error strings across providers/local servers (adapted from a reference agent's overflow classifier) — so a
# real window smaller than the configured context_size is RECOVERED (compact+retry) instead of killing
# the turn. Local servers (llama.cpp/Ollama/LM Studio/vLLM/DS4) each phrase it differently.
_OVERFLOW_RE = re.compile(
    r"prompt is too long|request_too_large|exceeds the context window|maximum context length"
    r"|input token count.*exceeds|maximum prompt length is \d+|reduce the length of the messages"
    r"|exceeds the available context size|greater than the context length|context window exceeds limit"
    r"|exceeded model token limit|too large for model with \d+ maximum|but the configured context size"
    r"|prompt too long|range of input length should be|context[_ ]length[_ ]exceeded|too many tokens"
    r"|context.{0,12}(?:window|size|length).{0,20}(?:exceed|too|limit)", re.I)

# An endpoint that refuses ``stream_options`` names the field AND says what is wrong with it
# ("Unrecognized request argument supplied: stream_options", pydantic's extra_forbidden with
# loc [body, stream_options], "'stream_options' is not allowed"). A validation error about
# something else can echo the whole request body, field included, so the field's name alone
# is not a refusal.
_STREAM_USAGE_REFUSAL_RE = re.compile(
    r"(?:unrecogni[sz]ed|unsupported|unknown|unexpected|extra|not (?:permitted|allowed|supported)"
    r"|forbidden|does not support|invalid)[^\n{}]{0,80}?\b(?:stream_options|include_usage)\b"
    r"|\b(?:stream_options|include_usage)\b[^\n{}]{0,80}?(?:unrecogni[sz]ed|unsupported|unknown"
    r"|unexpected|extra|not (?:permitted|allowed|supported)|forbidden|invalid)"
    r"|\bloc[\"']?\s*[:=]\s*[\[(][^\])]*[\"'](?:stream_options|include_usage)[\"']", re.I)


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class ChatResult:
    content: str = ""
    thinking: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict = field(default_factory=dict)
    response_id: str = ""
    provider_items: list[dict] = field(default_factory=list)
    provider_message: dict = field(default_factory=dict)
    # Set when the stall watcher ended this generation after real output (finish "incomplete"):
    # StallInfo.as_dict(). The Agent continues from the partial answer instead of re-issuing.
    stall: dict | None = None
    # 0.40: why a generation ended early (a cut stream, a stall), filled by the reconnecting lane
    # so the Agent can report a continuation retry. None for a generation that was not interrupted.
    interruption: dict | None = None
    # 0.40: the reasoning blocks this generation produced, with their provenance, filled by the
    # thinking-provenance lane. Empty when the model produced no reasoning.
    reasoning: list = field(default_factory=list)


def usage_reported(usage) -> bool:
    """Whether a provider supplied a valid token counter, including an explicit zero.

    Check before normalization supplies default zeros for absent fields.
    """
    if not isinstance(usage, dict):
        return False
    for key in ("input_tokens", "prompt_tokens", "output_tokens", "completion_tokens",
                "cache_read_input_tokens", "cache_creation_input_tokens", "cached_input_tokens"):
        value = usage.get(key)
        if isinstance(value, bool) or value is None:
            continue
        try:
            parsed = int(value)
            if 0 <= parsed <= 1_000_000_000 and (not isinstance(value, float) or value == parsed):
                return True
        except (TypeError, ValueError, OverflowError):
            pass
    return False


def normalize_usage(usage: dict | None) -> dict[str, int]:
    """Normalize Chat, Responses, and common compatible-provider usage shapes."""
    raw = usage if isinstance(usage, dict) else {}
    input_details = raw.get("input_tokens_details") or raw.get("prompt_tokens_details") or {}
    output_details = raw.get("output_tokens_details") or raw.get("completion_tokens_details") or {}
    if not isinstance(input_details, dict):
        input_details = {}
    if not isinstance(output_details, dict):
        output_details = {}

    def count(value) -> int:
        if isinstance(value, bool):
            return 0
        try:
            parsed = int(value or 0)
        except (TypeError, ValueError, OverflowError):
            return 0
        return parsed if 0 <= parsed <= 1_000_000_000 else 0

    # Input counts every prompt token, cached ones included (OpenAI's prompt_tokens, DeepSeek's,
    # Anthropic after _anthropic_usage); cached_input_tokens is the part served from a cache.
    return {
        "input_tokens": count(raw.get("input_tokens", raw.get("prompt_tokens", 0))),
        "output_tokens": count(raw.get("output_tokens", raw.get("completion_tokens", 0))),
        "cached_input_tokens": count(
            raw.get("cached_input_tokens", input_details.get("cached_tokens",
                    raw.get("cache_read_input_tokens", raw.get("prompt_cache_hit_tokens", 0))))),
        "reasoning_tokens": count(
            raw.get("reasoning_tokens", output_details.get("reasoning_tokens", 0))),
    }


@dataclass(frozen=True)
class ProviderCapabilities:
    """Wire-level features an endpoint family is expected to support.

    These are optimistic defaults, not permanent truths. Runtime rejections are cached for a
    bounded interval per endpoint+model, and users may override any field in config.
    """

    tools: bool = True
    reasoning: bool = True
    responses: bool = False
    stateful_responses: bool = False
    response_compaction: bool = False
    native_chat: bool = False
    anthropic_messages: bool = False
    prompt_cache_key: bool = False
    encrypted_reasoning: bool = False
    usage: bool = True
    parallel_tools: bool = True
    max_output_tokens: bool = True
    sampling: bool = True
    vision: bool = True


@dataclass(frozen=True)
class ProviderAdapter:
    """Deterministic provider profile selected before a request is constructed."""

    family: str
    capabilities: ProviderCapabilities

    def with_overrides(self, overrides: dict | None) -> ProviderCapabilities:
        values = {name: getattr(self.capabilities, name)
                  for name in ProviderCapabilities.__dataclass_fields__}
        for name, value in (overrides or {}).items():
            if name in values and isinstance(value, bool):
                values[name] = value
        return ProviderCapabilities(**values)


_PROVIDER_ADAPTERS = {
    "openai": ProviderAdapter("openai", ProviderCapabilities(
        responses=True, stateful_responses=True, response_compaction=True,
        prompt_cache_key=True, encrypted_reasoning=True)),
    "ollama": ProviderAdapter("ollama", ProviderCapabilities(native_chat=True)),
    "vllm": ProviderAdapter("vllm", ProviderCapabilities()),
    "deepseek": ProviderAdapter("deepseek", ProviderCapabilities(reasoning=False)),
    "anthropic": ProviderAdapter("anthropic", ProviderCapabilities(
        anthropic_messages=True, sampling=False)),
    "openrouter": ProviderAdapter("openrouter", ProviderCapabilities()),
    "groq": ProviderAdapter("groq", ProviderCapabilities()),
    "together": ProviderAdapter("together", ProviderCapabilities(reasoning=False)),
    "mistral": ProviderAdapter("mistral", ProviderCapabilities(reasoning=False)),
    "llamacpp": ProviderAdapter("llamacpp", ProviderCapabilities()),
    "lmstudio": ProviderAdapter("lmstudio", ProviderCapabilities()),
    "compat": ProviderAdapter("compat", ProviderCapabilities()),
}


def _responses_reasoning_has_text(item: dict) -> bool:
    """A Responses reasoning output item carries readable text (a summary or reasoning_text)."""
    for part in list(item.get("summary") or []) + list(item.get("content") or []):
        if isinstance(part, dict) and str(part.get("text") or "").strip():
            return True
    return False


class _ThinkingParts:
    """``ChatResult.thinking`` keeps every reasoning part of one generation, joined with a blank line
    where the part changes (a new summary part, a new block, tags after a native field)."""

    __slots__ = ("last",)

    def __init__(self):
        self.last = None

    def add(self, result, part: str, chunk: str) -> None:
        if (self.last is not None and part != self.last and result.thinking
                and not result.thinking.endswith("\n\n")):
            result.thinking += "\n\n"
        self.last = part
        result.thinking += chunk


class _NativeThinkTags:
    """Native Ollama ``thinking`` text from some templates (qwen3-vl) is wrapped in a literal
    ``<think>`` ... ``</think>``: markup, not reasoning. Strips one leading ``<think>`` (with the
    whitespace after it) and one trailing ``</think>``, either possibly split across chunks. Text is
    held back only while it could still be one of those tags."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.head = ""          # the start, while it could still be "<think>"
        self.started = False
        self.skip_space = False  # whitespace right after a stripped "<think>"
        self.tail = ""          # the end, while it could still be "</think>"

    def feed(self, chunk: str) -> str:
        if not self.started:
            self.head += chunk
            probe = self.head.lstrip()
            if len(probe) < len(self.OPEN) and self.OPEN.startswith(probe):
                return ""
            self.started = True
            chunk, self.head = self.head, ""
            if probe.startswith(self.OPEN):
                chunk, self.skip_space = probe[len(self.OPEN):], True
        if self.skip_space:
            chunk = chunk.lstrip()
            if not chunk:
                return ""
            self.skip_space = False
        text = self.tail + chunk
        body = text.rstrip()
        keep = next((k for k in range(min(len(body), len(self.CLOSE)), 0, -1)
                     if self.CLOSE.startswith(body[-k:])), 0)
        self.tail = text[len(body) - keep:] if keep else ""
        return text[:len(text) - len(self.tail)]

    def finish(self) -> str:
        """The held text once the thinking channel has stopped (content, a call, or the end)."""
        held = self.head if not self.started else ""
        tail, self.tail, self.head = self.tail, "", ""
        if not self.started:
            return "" if held.strip() == self.OPEN else held
        return "" if tail.strip() == self.CLOSE else tail


class _ThinkFilter:
    """Incrementally split a token stream into ('text'|'think', chunk) events, tolerating
    tags split across chunks. Recognises several reasoning-marker pairs, because local
    models disagree: <think>, <thinking>, <reasoning>, and Kimi-style ◁think▷."""

    PAIRS = [("<think>", "</think>"), ("<thinking>", "</thinking>"),
             ("<reasoning>", "</reasoning>"), ("◁think▷", "◁/think▷")]

    def __init__(self):
        self.buf = ""
        self.in_think = False
        self._close = None                # the close tag we're waiting for while in_think

    @staticmethod
    def _hold(buf: str, tag: str) -> int:
        """Length of buf's tail that is a proper prefix of `tag`."""
        for k in range(min(len(buf), len(tag) - 1), 0, -1):
            if tag.startswith(buf[-k:]):
                return k
        return 0

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        self.buf += chunk
        events: list[tuple[str, str]] = []
        while self.buf:
            if self.in_think:
                i = self.buf.find(self._close)
                if i != -1:
                    if i:
                        events.append(("think", self.buf[:i]))
                    self.buf = self.buf[i + len(self._close):]
                    self.in_think, self._close = False, None
                    continue
                hold = self._hold(self.buf, self._close)
            else:
                # earliest open marker among all known pairs
                best_i, best = None, None
                for op, cl in self.PAIRS:
                    j = self.buf.find(op)
                    if j != -1 and (best_i is None or j < best_i):
                        best_i, best = j, (op, cl)
                if best_i is not None:
                    if best_i:
                        events.append(("text", self.buf[:best_i]))
                    op, cl = best
                    self.buf = self.buf[best_i + len(op):]
                    self.in_think, self._close = True, cl
                    continue
                hold = max((self._hold(self.buf, op) for op, _ in self.PAIRS), default=0)
            emit = self.buf[:len(self.buf) - hold] if hold else self.buf
            self.buf = self.buf[len(emit):]
            if emit:
                events.append(("think" if self.in_think else "text", emit))
            break
        return events

    def flush(self) -> list[tuple[str, str]]:
        if not self.buf:
            return []
        ev = [("think" if self.in_think else "text", self.buf)]
        self.buf = ""
        return ev


def _repair_json_control_chars(s):
    """Escape raw control chars and invalid backslashes INSIDE JSON string literals so a local
    model's tool arguments (go/rust source with unescaped newlines/tabs) parse instead of being
    dropped as {"_unparsed"}. Repairs raw control chars in JSON string literals before giving up."""
    out = []
    in_str = False
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if in_str:
            if c == "\\":
                nxt = s[i + 1] if i + 1 < n else ""
                if nxt in '"\\/bfnrtu':
                    out.append(c); out.append(nxt); i += 2; continue
                out.append("\\\\"); i += 1; continue        # double an invalid/trailing backslash
            if c == '"':
                in_str = False; out.append(c); i += 1; continue
            if ord(c) < 0x20:                               # raw control char in a string -> escape
                out.append("\\u%04x" % ord(c)); i += 1; continue
            out.append(c); i += 1; continue
        if c == '"':
            in_str = True
        out.append(c); i += 1
    return "".join(out)


def _loads_lenient(s):
    """Parse JSON a local model probably meant: tolerate trailing commas, single quotes,
    unquoted keys, and Python literals (True/False/None). Returns a dict or None."""
    if not isinstance(s, str):
        return s if isinstance(s, dict) else None
    s = s.strip()
    if not s:
        return {}
    for candidate in (s, re.sub(r",\s*([}\]])", r"\1", s)):     # drop trailing commas
        try:
            v = json.loads(candidate)
            return v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            pass
    repaired = _repair_json_control_chars(s)                    # unescaped control chars / backslashes
    if repaired != s:
        for candidate in (repaired, re.sub(r",\s*([}\]])", r"\1", repaired)):
            try:
                v = json.loads(candidate)
                return v if isinstance(v, dict) else None
            except json.JSONDecodeError:
                pass
    try:
        import ast
        v = ast.literal_eval(s)                                  # single quotes / True/False/None
        return v if isinstance(v, dict) else None
    except (ValueError, SyntaxError):
        return None


def _merge_stream_token(current: str, incoming) -> str:
    """Merge an identifier/name sent as fragments, repeats, or cumulative snapshots."""
    fragment = str(incoming or "")
    if not fragment:
        return current
    if not current:
        return fragment
    if fragment.startswith(current):
        return fragment
    if current.startswith(fragment):
        return current
    return current + fragment


def _merge_stream_arguments(current, incoming):
    """Merge spec-compliant argument fragments plus common compatible-server variants."""
    if incoming is None or incoming == "":
        return current
    if isinstance(incoming, dict):
        return dict(incoming)
    if not isinstance(incoming, str):
        return incoming
    if isinstance(current, dict):
        parsed = _loads_lenient(incoming)
        return parsed if isinstance(parsed, dict) else current
    if not isinstance(current, str):
        parsed = _loads_lenient(incoming)
        return parsed if isinstance(parsed, dict) else current

    fragment = str(incoming)
    if not current:
        return fragment
    # OpenAI sends disjoint fragments. Several local gateways instead repeat the full value or
    # send a growing JSON snapshot each event. Prefix replacement supports both without turning
    # `{"pa` + `{"path":"x"}` into invalid concatenated JSON.
    if fragment.startswith(current):
        return fragment
    if current.startswith(fragment):
        return current
    return current + fragment


def _tool_arguments(raw) -> dict:
    """Normalize a provider's complete tool arguments to DGC's always-dict contract."""
    if raw is None or raw == "":
        return {}
    parsed = _loads_lenient(raw)
    if isinstance(parsed, dict):
        return dict(parsed)
    if isinstance(raw, str):
        text = raw
    else:
        try:
            text = json.dumps(raw, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(raw)
    return {"_unparsed": text[:4000]}


def _tool_call_index(raw) -> int | None:
    """Accept non-negative integer indices, including strings emitted by local gateways."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= 0 else None
    if isinstance(raw, str) and re.fullmatch(r"\d+", raw.strip()):
        try:
            return int(raw.strip())
        except (ValueError, OverflowError):
            return None
    return None


def _wire_key(identifier, index, fallback) -> str:
    """Choose a provider item key without treating the valid numeric index zero as absent."""
    value = identifier
    if value is None or value == "":
        value = index
    if value is None or value == "":
        value = fallback
    return str(value)


# Fenced ```tool_call / ```tool_code / ```json blocks, and two XML shapes local models emit.
_FENCE = re.compile(r"```+[ \t]*(tool_call|tool_code|json)?[ \t]*\n(.*?)\n?```+", re.S)
_XML_TOOLCALL = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.S)
_XML_FUNCTION = re.compile(r"<function\s*=\s*([\w.\-]+)\s*>(.*?)</function>", re.S)


def parse_text_tool_calls(content: str) -> tuple[str, list[ToolCall]]:
    """Recover tool calls a model emitted as TEXT instead of native calls — fenced blocks
    (```tool_call / ```json) and XML (<tool_call>{…}</tool_call>, <function=name>{…}</function>)
    — parsing the arguments leniently. Returns (content-with-blocks-removed, calls)."""
    calls: list[ToolCall] = []

    def _add(name, args) -> None:
        parsed = _loads_lenient(args) if isinstance(args, str) else args
        calls.append(ToolCall(id=f"textcall_{len(calls)}", name=str(name),
                              arguments=parsed if isinstance(parsed, dict) else {}))

    def _obj_sub(m: re.Match) -> str:
        payload = _loads_lenient(m.group(1))
        if not isinstance(payload, dict) or not payload.get("name"):
            return m.group(0)
        _add(payload["name"], payload.get("arguments", {}))
        return ""

    def _fence_sub(m: re.Match) -> str:
        lang, payload = m.group(1), _loads_lenient(m.group(2))
        if not isinstance(payload, dict) or not payload.get("name"):
            return m.group(0)
        # a bare ```json block must clearly be a call (has "arguments") to avoid eating examples
        if lang not in ("tool_call", "tool_code") and "arguments" not in payload:
            return m.group(0)
        _add(payload["name"], payload.get("arguments", {}))
        return ""

    def _fn_sub(m: re.Match) -> str:
        body = m.group(2).strip()
        _add(m.group(1), _loads_lenient(body) if body else {})
        return ""

    clean = _XML_TOOLCALL.sub(_obj_sub, content)
    clean = _XML_FUNCTION.sub(_fn_sub, clean)
    clean = _FENCE.sub(_fence_sub, clean)
    if not calls:                                   # last-ditch: whole message is a bare call object
        stripped = clean.strip()
        payload = _loads_lenient(stripped) if stripped.startswith("{") else None
        if isinstance(payload, dict) and payload.get("name") and "arguments" in payload:
            _add(payload["name"], payload["arguments"])
            clean = ""
    return clean.strip(), calls


def _repair_for_retry(messages: list[dict]) -> list[dict]:
    """Collapse native tool-calling structure into plain user/assistant text.

    Some endpoints ship brittle chat templates — e.g. an Ollama model imported with a
    passthrough template intermittently 500s "no user query found in messages" once a turn
    becomes a chain of assistant(tool_calls) + tool results with no fresh user turn. Folding
    the tool results into a `user` message guarantees a "user query" exists, so ANY template
    can render it. This is DGC-level and endpoint-agnostic (it protects every user's models,
    not just one box's). Used only on a retry after a transient failure; it never mutates the
    caller's list or the stored conversation."""
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            name = m.get("name") or "tool"
            out.append({"role": "user", "content": f"[result of {name}]\n{m.get('content', '')}"})
        elif role == "assistant" and m.get("tool_calls"):
            names = ", ".join((tc.get("function") or {}).get("name", "tool") for tc in m["tool_calls"])
            text = (m.get("content") or "").strip()
            note = f"(calling {names})" if names else ""
            out.append({"role": "assistant", "content": (f"{text}\n{note}".strip() or "(working)")})
        else:
            out.append({k: v for k, v in m.items()
                        if k != "tool_calls" and not str(k).startswith("_")})
    # merge adjacent same-role turns — a run of user/user/user also trips some templates
    merged: list[dict] = []
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] = f"{merged[-1].get('content', '')}\n\n{m.get('content', '')}".strip()
        else:
            merged.append(dict(m))
    return merged


# --- reasoning / thinking control, per provider (F1) -------------------------
# There is no single wire format that toggles reasoning across every OpenAI-
# compatible backend, so we express DGC's thinking level in the right shape for
# the detected provider. Golden rule: never OMIT for a thinking-capable Ollama
# model — omitting forces thinking ON (Ollama routes.go), the bug behind the
# "200s think, never edits" symptom.
_REASONING_OFF = {None, "", "off", "none"}
_REASONING_KEYS = ("reasoning_effort", "chat_template_kwargs", "thinking", "reasoning")
_SAMPLING_KEYS = ("temperature", "top_p", "top_k", "min_p")


def _provider_family(base_url: str) -> str:
    u = base_url.lower()
    if "11434" in u or "ollama" in u:
        return "ollama"
    if "api.openai.com" in u:
        return "openai"
    if "openrouter.ai" in u:
        return "openrouter"
    if "api.groq.com" in u:
        return "groq"
    if "deepseek.com" in u:
        return "deepseek"
    if "together.xyz" in u:
        return "together"
    if "mistral.ai" in u:
        return "mistral"
    if "anthropic" in u:
        return "anthropic"
    if ":8080" in u or "llama.cpp" in u or "llamacpp" in u:
        return "llamacpp"
    if ":1234" in u or "lmstudio" in u or "lm-studio" in u:
        return "lmstudio"
    if ":8000" in u or ":30000" in u or "vllm" in u or "sglang" in u:
        return "vllm"
    return "compat"                 # LM Studio, llama.cpp, or any other OpenAI-compatible host


def provider_adapter(base_url: str) -> ProviderAdapter:
    """Return the stable profile for an endpoint; runtime negotiation happens in LLMClient."""
    return _PROVIDER_ADAPTERS[_provider_family(base_url)]


def _openai_reasoning_model(model: str) -> bool:
    m = model.lower()
    return m.startswith(("o1", "o3", "o4")) or m.startswith("gpt-5") or "gpt-5" in m


def is_reasoning_model(model: str) -> bool:
    """Heuristic: does this model reason by default (so `/think high` tends to help)?"""
    m = model.lower()
    return (_openai_reasoning_model(model) or "reasoner" in m or "-r1" in m or "deepseek-r" in m
            or "qwq" in m or "think" in m)


def _compat_reasoning_payload(off: bool, level) -> dict:
    """Reasoning fields for a generic OpenAI-compatible transport (llama.cpp `llama-server`,
    unsloth GGUFs served through it, vLLM/SGLang, LM Studio, or any other /v1 host).

    Qwen3-family Jinja chat templates (served via llama.cpp/unsloth) read the effort level ONLY
    from INSIDE `chat_template_kwargs` (`{"reasoning_effort": "medium"}`); other servers read a
    flat `reasoning_effort`. So when thinking is ON we send BOTH — each server ignores the field
    it does not understand — otherwise `/think <level>` silently no-ops on the template path.
    OFF sends only `enable_thinking: False` (no effort level)."""
    if off:
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {"reasoning_effort": level,
            "chat_template_kwargs": {"enable_thinking": True, "reasoning_effort": level}}


def _reasoning_payload(family: str, model: str, level) -> dict:
    """Request fields expressing thinking `level` (off|low|medium|high|xhigh|None) for
    this provider. `{}` means 'let the model's own default stand'."""
    off = level in _REASONING_OFF
    if family == "ollama":                              # omitting forces thinking ON → always send
        if "glm-5.3-flash" in model.lower():
            return {"reasoning_effort": "low" if off or level == "low" else
                    "max" if level in ("xhigh", "max") else "high"}
        if "gpt-oss" in model.lower() and off:
            return {"reasoning_effort": "low"}
        if off:
            return {"reasoning_effort": "none"}
        return {"reasoning_effort": "high" if str(level).lower() == "xhigh" else level}
    if family == "vllm":                                # server renders the chat template
        return _compat_reasoning_payload(off, level)
    if family == "openai":                              # only o-series / gpt-5 accept effort; no "none"
        if not _openai_reasoning_model(model):
            return {}
        return {"reasoning_effort": "low" if off else level}
    if family == "deepseek":                            # reasoning is selected by the model id
        return {}
    if family == "openrouter":                          # gateway-normalized control across model vendors
        return {"reasoning": {"effort": "none" if off else level}}
    if family == "groq":                                # supported Qwen/GPT-OSS models negotiate this field
        return {"reasoning_effort": "none" if off else level}
    if family in ("together", "mistral"):
        return {}                                        # no universal per-model switch; respect model defaults
    if family == "anthropic":
        if off:
            return {}
        budget = {"low": 2048, "medium": 8192, "high": 16384, "xhigh": 24576}.get(level, 8192)
        return {"thinking": {"type": "enabled", "budget_tokens": budget}}
    # unknown OpenAI-compatible host (llama.cpp / unsloth / LM Studio / …)
    return _compat_reasoning_payload(off, level)


class LLMClient:
    _capability_rejections: dict[tuple[str, str, str], float] = {}
    # Endpoints that refused `stream_options` (400/422 naming it). Remembered for the life of the
    # process, per endpoint rather than per model: the field is a server feature, and re-probing
    # it every capability TTL would cost a failed request each time.
    _stream_usage_rejections: set[str] = set()
    _capability_lock = threading.Lock()
    _model_metadata_cache: dict[tuple[str, str], tuple[float, dict]] = {}
    _model_metadata_lock = threading.Lock()

    def __init__(self, base_url: str, api_key: str, model: str, read_timeout: int = 1800,
                 think_budget_tokens: int = 8000, max_tokens: int = 0, ollama_keep_alive: str = "",
                 sampling: dict | None = None, api_mode: str = "auto",
                 provider_capabilities: dict | None = None, capability_cache_ttl_s: int = 300,
                 provider_state: str = "stateless", prompt_cache: bool = True,
                 prompt_cache_key: str = "", context_size: int = 0,
                 first_token_timeout="auto", idle_timeout=300, stall_notice=45,
                 stall_retries=2, load_timeout=900):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.adapter = provider_adapter(self.base_url)
        self.family = self.adapter.family                 # picks the reasoning wire format
        self._capability_overrides = (dict(provider_capabilities)
                                      if isinstance(provider_capabilities, dict) else {})
        self.capabilities = self.adapter.with_overrides(self._capability_overrides)
        self.capability_cache_ttl_s = max(1, int(capability_cache_ttl_s or 0))
        # Hard ceiling on socket silence, including the wait for response headers. The stall watcher
        # (below) normally acts first; this stays as the backstop and is never lowered by it.
        self.read_timeout = read_timeout
        # Stall watcher (dgc/model_watch.py). "auto" resolves per endpoint; 0 turns a window off.
        self.first_token_timeout = resolve_first_token_timeout(
            first_token_timeout, self.base_url, self.family)
        self.idle_timeout = bounded_seconds(idle_timeout, 300.0)
        self.stall_notice = bounded_seconds(stall_notice, 45.0)
        self.stall_retries = bounded_retries(stall_retries, 2)
        self.load_timeout = bounded_seconds(load_timeout, 900.0)
        self.stall_listener = None      # the Agent installs its wait handler for one _chat call
        self.stall_route = None         # runner that delivers a notice on the caller's UI session
        self._wait_channel: WaitChannel | None = None
        self._active_watch: RequestWatch | None = None
        self.think_budget_chars = max(0, think_budget_tokens) * 4   # F4 over-thinking watchdog (0=off)
        self.max_tokens = max(0, max_tokens)            # F3 output backstop per request (0=don't send)
        self.context_size = max(0, int(context_size or 0))
        self.keep_alive = ollama_keep_alive             # D2: keep Ollama model resident between turns
        self.sampling = dict(sampling or {})            # optional temperature/top_p/top_k/min_p overrides
        requested_mode = str(api_mode or "auto").lower()
        self.requested_api_mode = requested_mode
        if requested_mode == "auto":
            if self.family == "openai":
                self.api_mode = "responses"
            elif self.family == "ollama":
                self.api_mode = "ollama"
            elif self.family == "anthropic":
                self.api_mode = "anthropic"
            else:
                self.api_mode = "chat_completions"
        else:
            self.api_mode = requested_mode
        if self.api_mode not in ("chat_completions", "responses", "ollama", "anthropic"):
            self.api_mode = "chat_completions"
        self.provider_state = ("server" if str(provider_state).lower() == "server" else "stateless")
        self.prompt_cache = bool(prompt_cache)
        self.prompt_cache_key = str(prompt_cache_key or "")
        self._response_id = ""
        self._response_cursor = 0
        self._response_prefix_hash = ""
        self._native_call_seq = 0
        # Set by the owner (Agent._new_client): called once with (client, result) for every request
        # that finished, which is where the local usage ledger records it. None means no ledger.
        self.usage_sink = None
        self.usage_source = "main"
        self._usage_local = threading.local()
        if requested_mode == "auto" and not self._feature_supported("responses"):
            if self.api_mode == "responses":
                self.api_mode = "chat_completions"
        if (requested_mode == "auto" and self.api_mode == "ollama"
                and not self._feature_supported("native_chat")):
            self.api_mode = "chat_completions"
        if (requested_mode == "auto" and self.api_mode == "anthropic"
                and not self._feature_supported("anthropic_messages")):
            self.api_mode = "chat_completions"

    def _capability_key(self, feature: str) -> tuple[str, str, str]:
        return (self.base_url.lower(), self.model, feature)

    def _model_metadata_key(self) -> tuple[str, str]:
        return (self.base_url.lower(), self.model)

    def _cached_model_metadata(self) -> tuple[bool, dict]:
        key = self._model_metadata_key()
        now = time.monotonic()
        with self._model_metadata_lock:
            entry = self._model_metadata_cache.get(key)
            if entry and entry[0] <= now:
                self._model_metadata_cache.pop(key, None)
                entry = None
            return (True, dict(entry[1])) if entry else (False, {})

    def _cache_model_metadata_for(self, model: str, metadata: dict,
                                  ttl: int | float | None = None) -> None:
        lifetime = self.capability_cache_ttl_s if ttl is None else max(1, float(ttl))
        now = time.monotonic()
        key = (self.base_url.lower(), str(model))
        with self._model_metadata_lock:
            for stale in [candidate for candidate, entry in self._model_metadata_cache.items()
                          if entry[0] <= now]:
                self._model_metadata_cache.pop(stale, None)
            if (key not in self._model_metadata_cache
                    and len(self._model_metadata_cache) >= _MAX_MODEL_METADATA_CACHE_ENTRIES):
                oldest = min(self._model_metadata_cache,
                             key=lambda candidate: self._model_metadata_cache[candidate][0])
                self._model_metadata_cache.pop(oldest, None)
            self._model_metadata_cache[key] = (now + lifetime, dict(metadata))

    def _cache_model_metadata(self, metadata: dict, ttl: int | float | None = None) -> None:
        self._cache_model_metadata_for(self.model, metadata, ttl)

    @staticmethod
    def _ollama_metadata(value) -> dict:
        if (not isinstance(value, dict)
                or not any(key in value for key in
                           ("capabilities", "model_info", "details", "parameters"))):
            return {}
        raw_capabilities = value.get("capabilities")
        authoritative = (isinstance(raw_capabilities, list)
                         and len(raw_capabilities) <= 64
                         and all(isinstance(item, str)
                                 and bool(_MODEL_CAPABILITY_RE.fullmatch(item.strip().lower()))
                                 for item in raw_capabilities))
        capabilities = (sorted({item.strip().lower() for item in raw_capabilities if item.strip()})
                        if authoritative else [])
        info = value.get("model_info")
        info = info if isinstance(info, dict) else {}

        architecture = str(info.get("general.architecture") or "")[:128]
        preferred = (_bounded_model_tokens(info.get(f"{architecture}.context_length"))
                     if architecture else 0)
        contexts = []
        for index, (key, raw) in enumerate(info.items()):
            if index >= _MAX_MODEL_INFO_FIELDS:
                break
            normalized = str(key).lower()
            if (normalized.endswith(".context_length")
                    and ".vision." not in normalized and ".mm." not in normalized):
                context = _bounded_model_tokens(raw)
                if context:
                    contexts.append(context)
        context_length = preferred or (max(contexts) if contexts else 0)
        parameters = value.get("parameters")
        configured_context = 0
        if isinstance(parameters, str) and len(parameters) <= 64_000:
            match = re.search(r"(?im)^\s*num_ctx\s+(\d+)\s*$", parameters)
            configured_context = _bounded_model_tokens(match.group(1)) if match else 0
        details = value.get("details")
        details = details if isinstance(details, dict) else {}
        return {
            "source": "ollama_show",
            "capabilities_authoritative": authoritative,
            "capabilities": capabilities,
            "context_length": context_length,
            "configured_context": (min(configured_context, context_length)
                                   if configured_context and context_length else configured_context),
            "family": str(details.get("family") or architecture)[:128],
            "parameter_size": str(details.get("parameter_size") or "")[:64],
            "quantization_level": str(details.get("quantization_level") or "")[:64],
        }

    @staticmethod
    def _anthropic_metadata(value) -> dict:
        """Normalize one bounded Models API record; zero/null limits mean unspecified."""
        if not isinstance(value, dict):
            return {}
        model_id = str(value.get("id") or "")
        if not model_id or len(model_id) > 512:
            return {}
        raw_capabilities = value.get("capabilities")
        supported: list[str] = []
        if isinstance(raw_capabilities, dict):
            for key, details in list(raw_capabilities.items())[:64]:
                name = str(key).strip().lower()
                if (not _MODEL_CAPABILITY_RE.fullmatch(name)
                        or not isinstance(details, dict)
                        or details.get("supported") is not True):
                    continue
                supported.append(name)
        return {
            "source": "anthropic_models",
            "resolved_model": model_id,
            "context_length": _bounded_model_tokens(value.get("max_input_tokens")),
            "max_output_tokens": _bounded_model_tokens(value.get("max_tokens")),
            "capabilities": sorted(set(supported)),
        }

    def prepare_model(self, *, force: bool = False, cancel=None) -> dict:
        """Discover selected native-provider model metadata once per bounded cache generation.

        Discovery is advisory and never prevents a chat when an older/proxied endpoint lacks its
        model-info route. Ollama's valid capabilities array is authoritative unless explicitly
        overridden; Anthropic metadata supplies limits and diagnostics without guessing features.
        """
        if self.api_mode not in ("ollama", "anthropic") or not self.model:
            return {}
        if cancel is not None and cancel.is_set():
            return {}
        cached, metadata = self._cached_model_metadata()
        if cached and not force:
            return metadata
        deadline = time.monotonic() + _MODEL_METADATA_TOTAL_S
        try:
            if self.api_mode == "ollama":
                response = requests.post(
                    f"{self._ollama_root}/api/show", headers=self._headers(),
                    json={"model": self.model, "verbose": False}, stream=True, timeout=(2, 2))
                label = "Ollama model metadata"
            else:
                response = requests.get(
                    f"{self.base_url}/models/{quote(self.model, safe='')}",
                    headers=self._anthropic_headers(), stream=True, timeout=(2, 2))
                label = "Anthropic model metadata"
            if response.status_code != 200:
                _close_response(response)
                self._cache_model_metadata({}, min(
                    self.capability_cache_ttl_s, _MODEL_METADATA_FAILURE_TTL_S))
                return {}
            value = _bounded_json_response(
                response, _MAX_MODEL_METADATA_BYTES, label, deadline=deadline)
            metadata = (self._ollama_metadata(value) if self.api_mode == "ollama"
                        else self._anthropic_metadata(value))
        except (LLMError, requests.RequestException, ValueError, TypeError):
            self._cache_model_metadata({}, min(
                self.capability_cache_ttl_s, _MODEL_METADATA_FAILURE_TTL_S))
            return {}
        if cancel is not None and cancel.is_set():
            return {}
        self._cache_model_metadata(
            metadata, None if metadata else min(
                self.capability_cache_ttl_s, _MODEL_METADATA_FAILURE_TTL_S))
        return dict(metadata)

    def model_context_limit(self) -> int:
        """Return a discovered hard input limit, or zero when the provider did not report one."""
        _, metadata = self._cached_model_metadata()
        return _bounded_model_tokens(metadata.get("context_length"))

    def _note_dropped_images(self, count: int) -> None:
        """Record that images were withheld, so a frontend can tell the user once."""
        self.dropped_images = getattr(self, "dropped_images", 0) + count

    def _without_images(self, messages: list, *, refused: bool = False) -> list:
        """The outgoing copy of ``messages`` for a model that cannot read images. ``refused`` records
        the endpoint's refusal first: a text-only endpoint does not grow vision within a session, so
        the rejection is remembered for at least an hour and later requests skip the failed try."""
        if refused:
            self._mark_rejected("vision", ttl_s=max(float(self.capability_cache_ttl_s or 0),
                                                    _VISION_REJECTION_MIN_TTL_S))
        stripped, dropped = _strip_images_with_note(messages, self.model)
        if dropped:
            self._note_dropped_images(dropped)
        return stripped

    def effective_context_size(self, configured: int | None = None) -> int:
        """Clamp a requested operating window to a discovered model maximum without expanding it."""
        requested = _bounded_model_tokens(
            self.context_size if configured is None else configured)
        limit = self.model_context_limit()
        return min(requested, limit) if requested and limit else (requested or limit)

    def model_output_limit(self) -> int:
        """Return a discovered hard output limit, or zero when the provider did not report one."""
        _, metadata = self._cached_model_metadata()
        return _bounded_model_tokens(metadata.get("max_output_tokens"))

    def _feature_supported(self, feature: str) -> bool:
        supported = bool(getattr(self.capabilities, feature, False))
        _, metadata = self._cached_model_metadata()
        if (feature not in self._capability_overrides
                and metadata.get("capabilities_authoritative") is True):
            capability = {"tools": "tools", "reasoning": "thinking",
                          "vision": "vision"}.get(feature)
            if capability:
                supported = capability in set(metadata.get("capabilities") or ())
        if not supported:
            return False
        key = self._capability_key(feature)
        now = time.monotonic()
        with self._capability_lock:
            expiry = self._capability_rejections.get(key, 0)
            if expiry and expiry <= now:
                self._capability_rejections.pop(key, None)
                expiry = 0
        return not expiry

    def _mark_rejected(self, feature: str, ttl_s: float | None = None) -> None:
        with self._capability_lock:
            self._capability_rejections[self._capability_key(feature)] = (
                time.monotonic() + (self.capability_cache_ttl_s if ttl_s is None else ttl_s))

    def invalidate_capabilities(self) -> None:
        """Forget negotiated rejections for this endpoint+model (e.g. after a server upgrade)."""
        prefix = (self.base_url.lower(), self.model)
        with self._capability_lock:
            for key in list(self._capability_rejections):
                if key[:2] == prefix:
                    self._capability_rejections.pop(key, None)
        with self._model_metadata_lock:
            self._model_metadata_cache.pop(self._model_metadata_key(), None)

    @property
    def tools_supported(self) -> bool:
        return self._feature_supported("tools")

    @property
    def reasoning_supported(self) -> bool:
        return self._feature_supported("reasoning")

    @property
    def vision_supported(self) -> bool:
        return self._feature_supported("vision")

    def capability_snapshot(self) -> dict[str, bool | str | int | list]:
        snapshot = {name: self._feature_supported(name)
                    for name in ProviderCapabilities.__dataclass_fields__}
        # An explicit native transport can intentionally sit behind a generic loopback proxy whose
        # URL cannot identify Ollama. Report the transport actually in use, not only URL inference.
        snapshot["native_chat"] = self.api_mode == "ollama" or snapshot["native_chat"]
        snapshot["anthropic_messages"] = (
            self.api_mode == "anthropic" or snapshot["anthropic_messages"])
        if self.api_mode == "anthropic":
            snapshot["sampling"] = False
        _, metadata = self._cached_model_metadata()
        result: dict[str, bool | str | int | list] = {"provider": self.family, **snapshot}
        if not snapshot["reasoning"]:
            result["reasoning_control"] = "instructions"
        elif self.api_mode == "ollama":
            result["reasoning_control"] = ("glm-flash-levels" if "glm-5.3-flash" in self.model.lower()
                                           else "levels" if "gpt-oss" in self.model.lower() else "toggle")
        else:
            result["reasoning_control"] = "provider"
        if metadata.get("source") in ("ollama_show", "anthropic_models"):
            result["discovery"] = str(metadata["source"])
            result["model_capabilities"] = list(metadata.get("capabilities") or ())
            if metadata.get("context_length"):
                result["model_context_length"] = int(metadata["context_length"])
            if metadata.get("max_output_tokens"):
                result["model_max_output_tokens"] = int(metadata["max_output_tokens"])
            if metadata.get("resolved_model"):
                result["resolved_model"] = str(metadata["resolved_model"])
            if metadata.get("configured_context"):
                result["model_configured_context"] = int(metadata["configured_context"])
        return result

    def estimate_input_tokens(self, messages: list[dict],
                              tools: list[dict] | None = None) -> int:
        """Approximate the provider-visible input, including native tool definitions.

        The exact tokenizer is model-specific, but estimating the same transcript and tool-schema
        shapes used by the selected transport is materially safer than counting DGC's stored
        transcript alone. Responses deliberately counts the full stateless shape even when a
        server-side continuation can make the HTTP body smaller: the earlier context still occupies
        the model's context window.
        """
        image_tokens = 0
        compaction_tokens = 0
        if self.api_mode == "ollama":
            wire = self._ollama_messages(messages)
            wire, image_tokens = _scrub_ollama_images(wire)
            wire_tools = tools
        elif self.api_mode == "responses":
            instructions, items, compaction_tokens = self._responses_estimate_input(messages)
            wire = {"instructions": instructions, "input": items}
            wire, image_tokens = _scrub_multimodal_images(wire)
            wire_tools = self._responses_tools(tools)
        elif self.api_mode == "anthropic":
            system, anthropic_messages = self._anthropic_messages(messages)
            wire = {"system": system, "messages": anthropic_messages}
            wire, image_tokens = _scrub_multimodal_images(wire)
            wire_tools = self._anthropic_tools(tools)
        else:
            wire = [{k: v for k, v in message.items() if not str(k).startswith("_")}
                    for message in messages]
            wire, image_tokens = _scrub_multimodal_images(wire)
            wire_tools = tools
        chars = len(json.dumps(wire, default=str))
        if wire_tools and self.tools_supported:
            chars += len(json.dumps(wire_tools, default=str))
        return chars // 4 + image_tokens + compaction_tokens

    def _reset_response_state(self) -> None:
        self._response_id = ""
        self._response_cursor = 0
        self._response_prefix_hash = ""

    @property
    def _url(self) -> str:
        return f"{self.base_url}/chat/completions"

    @property
    def _ollama_root(self) -> str:
        base = self.base_url.rstrip("/")
        for suffix in ("/v1", "/api"):
            if base.lower().endswith(suffix):
                return base[:-len(suffix)].rstrip("/")
        return base

    @property
    def _ollama_url(self) -> str:
        return f"{self._ollama_root}/api/chat"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _anthropic_headers(self) -> dict:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    def list_models(self) -> list[str]:
        if self.api_mode == "ollama":
            r = requests.get(f"{self._ollama_root}/api/tags", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                return sorted(str(m.get("model") or m.get("name") or "?")
                              for m in r.json().get("models", []))
            if self.requested_api_mode != "auto" or r.status_code not in (404, 405, 501):
                r.raise_for_status()
            self._mark_rejected("native_chat")
            self.api_mode = "chat_completions"
        if self.api_mode == "anthropic":
            r = requests.get(f"{self.base_url}/models?limit=1000",
                             headers=self._anthropic_headers(), stream=True, timeout=(2, 2))
            if r.status_code == 200:
                value = _bounded_json_response(
                    r, _MAX_MODEL_METADATA_BYTES, "Anthropic model catalog",
                    deadline=time.monotonic() + _MODEL_METADATA_TOTAL_S)
                if not isinstance(value, dict) or not isinstance(value.get("data"), list):
                    raise LLMError("Anthropic model catalog returned an invalid shape")
                ids = []
                for model in value["data"]:
                    metadata = self._anthropic_metadata(model)
                    if metadata:
                        model_id = str(metadata["resolved_model"])
                        ids.append(model_id)
                        self._cache_model_metadata_for(model_id, metadata)
                return sorted(ids)
            if self.requested_api_mode != "auto" or r.status_code not in (404, 405, 501):
                status = r.status_code
                body = _error_body(r, 400)
                raise LLMError(f"HTTP {status} from Anthropic model catalog: {body}")
            _close_response(r)
            self._mark_rejected("anthropic_messages")
            self.api_mode = "chat_completions"
        r = requests.get(f"{self.base_url}/models", headers=self._headers(), timeout=10)
        r.raise_for_status()
        return sorted(m.get("id", "?") for m in r.json().get("data", []))

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        reasoning_effort: str | None = None,
        on_text=None,
        on_thinking=None,
        cancel=None,
    ) -> ChatResult:
        channel = WaitChannel(getattr(self, "stall_listener", None),
                              getattr(self, "stall_route", None))
        previous, self._wait_channel = getattr(self, "_wait_channel", None), channel
        # A request cancelled before it started never reached the provider; it is not a request.
        cancelled_before = cancel is not None and cancel.is_set()
        state = self._usage_state()
        state.open = 0
        try:
            try:
                if self.api_mode == "responses":
                    result = self._chat_responses(messages, tools, reasoning_effort,
                                                  on_text, on_thinking, cancel)
                elif self.api_mode == "ollama":
                    result = self._chat_ollama(messages, tools, reasoning_effort,
                                               on_text, on_thinking, cancel)
                elif self.api_mode == "anthropic":
                    result = self._chat_anthropic(messages, tools, reasoning_effort,
                                                  on_text, on_thinking, cancel)
                else:
                    result = self._chat_completions(messages, tools, reasoning_effort,
                                                    on_text, on_thinking, cancel)
            except BaseException:
                # The provider accepted the request and started answering, then the stream broke
                # (a dropped connection, a malformed frame, an error event, a stall past its
                # retries). It may have cost tokens nobody reported: count one unmetered request.
                if not cancelled_before and getattr(state, "open", 0) > 0:
                    self._report_usage(ChatResult(finish_reason="error"))
                raise
            if not cancelled_before:
                self._report_usage(result)
            return result
        finally:
            self._stop_watch()
            channel.close()             # nothing about this call may reach the UI after it returns
            self._wait_channel = previous

    # ---- stall watcher ---------------------------------------------------------------------------
    _load_probe_interval_s = 5.0

    def _stall_windows(self) -> tuple[float, float]:
        """First-token and idle windows, each clamped by this request's read timeout."""
        try:
            ceiling = float(self.read_timeout)
        except (TypeError, ValueError):
            ceiling = 0.0
        first = float(getattr(self, "first_token_timeout", 0.0) or 0.0)
        idle = float(getattr(self, "idle_timeout", 0.0) or 0.0)
        if ceiling > 0:
            first = min(first, ceiling) if first > 0 else 0.0
            idle = min(idle, ceiling) if idle > 0 else 0.0
        return first, idle

    def _post_timeout(self, watch: RequestWatch | None) -> tuple:
        """The socket timeout: the backstop, never lower than read_timeout and never ahead of the
        watcher's own first-token deadline."""
        first = watch.first_token_s if watch is not None else 0.0
        read = self.read_timeout
        return (15, max(read, first + 5) if first > 0 else read)

    def _streaming_rejected(self) -> bool:
        key = self._capability_key("streaming")
        now = time.monotonic()
        with self._capability_lock:
            expiry = self._capability_rejections.get(key, 0)
            if expiry and expiry <= now:
                self._capability_rejections.pop(key, None)
                return False
        return bool(expiry)

    def _note_non_streaming(self, response) -> None:
        """An endpoint that answered stream:true with one JSON body sends nothing until it has
        generated everything: later requests wait on read_timeout, not the first-token window.

        Unlike a negotiated feature rejection this never ages out on capability_cache_ttl_s: an
        endpoint does not start streaming on its own, and forgetting would put its next long
        generation back under the first-token deadline -- exactly the false stall this prevents.
        It lasts for the process, refreshed by every JSON body; invalidate_capabilities() clears it.
        """
        ctype = str((getattr(response, "headers", {}) or {}).get("Content-Type", "")).lower()
        if "application/json" in ctype and "event-stream" not in ctype and "ndjson" not in ctype:
            self._mark_rejected("streaming", ttl_s=math.inf)

    def _ollama_load_probe(self):
        """A read-only /api/ps probe: True when the model is loaded, False while it is not, None
        when this endpoint cannot say (never an error)."""
        if not (self.api_mode == "ollama" or self.family == "ollama") or not self.model:
            return None
        if is_hosted_ollama(self.base_url):
            # Ollama's own cloud loads models out of sight; its /api/ps (if any) describes no
            # hardware this request waits on, and an empty list would pause the clock for nothing.
            # Every self-hosted Ollama -- local, LAN or on a public address -- is probed.
            return None
        url = f"{self._ollama_root}/api/ps"
        headers = self._headers()
        model = self.model

        def probe():
            try:
                response = requests.get(url, headers=headers, stream=True, timeout=(1, 1))
            except requests.RequestException:
                return None
            try:
                if response.status_code != 200:
                    return None
                value = _bounded_json_response(
                    response, _MAX_MODEL_METADATA_BYTES, "Ollama loaded-model probe",
                    deadline=time.monotonic() + 2)
            except (LLMError, requests.RequestException, ValueError, TypeError):
                return None
            finally:
                _close_response(response)
            return ollama_model_listed(value, model)
        return probe

    def _begin_attempt(self, cancel, endpoint: str) -> RequestWatch:
        first, idle = self._stall_windows()
        watch = RequestWatch(
            cancel, first_token_s=first, idle_s=idle,
            notice_s=float(getattr(self, "stall_notice", 0.0) or 0.0),
            load_probe=self._ollama_load_probe(),
            load_timeout_s=float(getattr(self, "load_timeout", 0.0) or 0.0),
            load_poll_s=self._load_probe_interval_s,
            channel=getattr(self, "_wait_channel", None),
            headers_deadline=not self._streaming_rejected(),
            model=self.model, endpoint=safe_endpoint(endpoint))
        return watch.start()

    def _next_watch(self, cancel, endpoint: str) -> RequestWatch:
        """Stop the previous attempt's watch and start this attempt's."""
        self._stop_watch()
        watch = self._begin_attempt(cancel, endpoint)
        self._active_watch = watch
        return watch

    def _stop_watch(self) -> None:
        watch, self._active_watch = getattr(self, "_active_watch", None), None
        if watch is not None:
            watch.stop()

    def _retry_stall(self, info: StallInfo, stalls: int, cancel) -> bool:
        """Account for one stall that streamed nothing. True = issue the same request again;
        False = cancelled while backing off. Raises ModelStallError once retries are spent."""
        retries = int(getattr(self, "stall_retries", 0) or 0)
        if stalls > retries:
            raise ModelStallError(info, api_mode=self.api_mode, attempts=stalls)
        if getattr(self._usage_state(), "open", 0) > 0:
            # The provider accepted the abandoned attempt, so it may have cost tokens nobody
            # reported; the ledger shows it as one unmetered request, like a watchdog retry.
            self._report_usage(ChatResult(finish_reason="error"))
        channel = getattr(self, "_wait_channel", None)
        if channel is not None:
            channel.emit(WaitEvent(kind="retry", phase=info.phase, since=time.monotonic(),
                                   silent_s=info.silent_s, threshold_s=info.window_s,
                                   noise_frames=info.noise_frames, model=info.model,
                                   endpoint=info.endpoint, attempt=stalls, retries=retries))
        window = info.window_s if info.window_s > 0 else 10.0
        return _wait_for_retry(min(2 ** (stalls - 1), window, 10.0), cancel)

    def _transport_cause(self, exc: BaseException, url: str):
        cause = classify_exception(exc, endpoint=url)
        return cause.with_context(model=self.model, api_mode=self.api_mode,
                                  hint=hint_for(cause.kind, model=self.model, base_url=self.base_url))

    def _status_cause(self, status: int, body: str, headers, url: str, delay: float):
        cause = classify_status(status, body, headers, endpoint=url, delay_s=delay)
        return cause.with_context(model=self.model, api_mode=self.api_mode,
                                  hint=hint_for(cause.kind, model=self.model, base_url=self.base_url))

    def _retry_transport(self, cause, transient: int, delay: float, cancel) -> bool:
        """Say that a request failed in a way DGC retries, then back off. True = send it again;
        False = cancelled while backing off. The delay is the transport's own, unchanged."""
        channel = getattr(self, "_wait_channel", None)
        if channel is not None:
            channel.emit(WaitEvent(
                kind="retry", since=time.monotonic(), model=self.model, endpoint=cause.endpoint,
                attempt=int(transient), retries=3, cause=cause.kind, summary=cause.summary,
                detail=cause.detail, hint=cause.hint, http_status=int(cause.http_status or 0),
                delay_s=float(delay), api_mode=str(self.api_mode or "")))
        return _wait_for_retry(delay, cancel)

    def _connect_error(self, cause, exc: BaseException, attempts: int, *, target: str = "",
                       clause: str = "") -> LLMError:
        """``cannot connect to …``: the base URL without credentials or query, the scrubbed error."""
        where = safe_endpoint(target or self.base_url)
        if clause:
            message = f"cannot connect to {where} — {clause}\n{scrub_urls(exc)}"
        else:
            local = (" — is your local LLM server running?"
                     if is_local_endpoint(self.base_url, getattr(self, "family", "")) else "")
            message = f"cannot connect to {where} — {cause.summary}{local}\n{scrub_urls(exc)}"
        return _with_cause(LLMError(message), cause, attempts)

    def _answer_error(self, message: str, status: int, body: str, url: str, attempts: int) -> LLMError:
        """A final non-retried HTTP answer, carrying its cause (auth, model not found, 4xx)."""
        cause = self._status_cause(status, body, None, url, 0.0)
        return _with_cause(LLMError(message), cause, attempts)

    @staticmethod
    def _pre_progress_stall(result: ChatResult) -> StallInfo | None:
        stall = getattr(result, "stall", None)
        if not isinstance(stall, dict) or stall.get("progressed"):
            return None
        try:
            return StallInfo(**stall)
        except TypeError:
            return None

    def _usage_state(self):
        local = self.__dict__.get("_usage_local")
        if local is None:
            local = self.__dict__.setdefault("_usage_local", threading.local())
        return local

    def _usage_opened(self) -> None:
        """Mark that a provider accepted this request (HTTP 200) and began answering it."""
        state = self._usage_state()
        state.open = getattr(state, "open", 0) + 1

    def _report_usage(self, result: ChatResult) -> None:
        """The one usage hook: hand a finished request to the owner's sink, exactly once.

        Recording here, at the leaf, is what counts a sub-agent's request once: the Agent's session
        totals re-record child usage on the parent, so a ledger fed from there would double it.
        A sink failure is the ledger's problem and never the turn's.
        """
        state = self._usage_state()
        state.open = max(0, getattr(state, "open", 0) - 1)
        sink = getattr(self, "usage_sink", None)
        if sink is None:
            return
        try:
            sink(self, result)
        except Exception:
            pass

    # ---- thinking provenance --------------------------------------------------------------------------
    def _next_reasoning_attempt(self, requested_display: str = "") -> int:
        """One more HTTP attempt that may stream reasoning. Part keys carry the attempt number, so
        an overthink re-POST, a stall retry, a pause_turn continuation or the auto switch to Chat
        Completions never appends into an earlier attempt's block. ``requested_display`` is what
        this attempt really asked Anthropic for ("summarized" or "")."""
        attempt = int(self.__dict__.get("_reasoning_attempt", 0) or 0) + 1
        self._reasoning_attempt = attempt
        self._reasoning_display = str(requested_display or "")
        return attempt

    def _reasoning_origin(self, channel: str, local: str, *, api_mode: str, event: str = "delta",
                          t_start: float | None = None) -> _reasoning.ReasoningOrigin:
        resolved = _reasoning.resolve_source(
            api_mode=api_mode, channel=channel, base_url=str(getattr(self, "base_url", "") or ""),
            model=str(getattr(self, "model", "") or ""),
            requested_display=str(self.__dict__.get("_reasoning_display", "") or ""))
        attempt = int(self.__dict__.get("_reasoning_attempt", 0) or 0)
        return _reasoning.ReasoningOrigin(
            source=resolved.source, provider=resolved.provider, private=resolved.private,
            part=f"{attempt}:{local}", event=event, t_start=t_start)

    @staticmethod
    def _anthropic_content(content) -> list[dict]:
        """Translate DGC text/image content into Claude Messages content blocks."""
        if isinstance(content, str):
            return [{"type": "text", "text": content}] if content else []
        if not isinstance(content, list):
            text = str(content or "")
            return [{"type": "text", "text": text}] if text else []
        blocks: list[dict] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if kind in ("text", "input_text"):
                blocks.append({"type": "text", "text": str(part.get("text") or "")})
                continue
            if kind not in ("image_url", "input_image"):
                continue
            value = part.get("image_url") or part.get("image") or ""
            if isinstance(value, dict):
                value = value.get("url") or ""
            match = _ANTHROPIC_IMAGE_RE.fullmatch(str(value))
            if not match:
                # Raising here failed every later request too: the image stays in the transcript.
                blocks.append({"type": "text", "text": "[An image was left out here: only JPEG, PNG, "
                               "GIF and WebP images can be sent to this model.]"})
                continue
            blocks.append({
                "type": "image",
                "source": {"type": "base64", "media_type": match.group(1).lower(),
                           "data": match.group(2)},
            })
        return blocks

    @classmethod
    def _anthropic_messages(cls, messages: list[dict]) -> tuple[str, list[dict]]:
        """Map canonical history to the stateless Claude Messages transcript.

        Claude requires system instructions at the top level, assistant tool-use blocks followed
        immediately by user tool-result blocks, and exact signed thinking blocks on continuation.
        The agent's transcript repair already supplies every missing native tool result; this
        conversion additionally groups adjacent results into Claude's required user turn.
        """
        system: list[str] = []
        out: list[dict] = []

        def append(role: str, blocks: list[dict]) -> None:
            if not blocks:
                blocks = [{"type": "text", "text": ""}]
            if out and out[-1]["role"] == role:
                out[-1]["content"].extend(blocks)
            else:
                out.append({"role": role, "content": blocks})

        def append_tool_result(block: dict) -> None:
            if out and out[-1]["role"] == "user":
                content = out[-1]["content"]
                # Claude requires every tool_result before ordinary user text/image blocks. Insert
                # after prior results to preserve parallel-call order even for repaired transcripts.
                index = 0
                while index < len(content) and content[index].get("type") == "tool_result":
                    index += 1
                content.insert(index, block)
            else:
                out.append({"role": "user", "content": [block]})

        for source in messages:
            if not isinstance(source, dict):
                continue
            role = str(source.get("role") or "")
            if role == "system":
                parts = cls._anthropic_content(source.get("content", ""))
                system.extend(str(part.get("text") or "") for part in parts
                              if part.get("type") == "text")
                continue
            if role == "tool":
                content = str(source.get("content") or "")
                block: dict = {
                    "type": "tool_result",
                    "tool_use_id": str(source.get("tool_call_id") or ""),
                    "content": content,
                }
                lowered = content.lstrip().lower()
                exit_code = re.match(r"exit code:\s*(-?\d+)", lowered)
                if (lowered.startswith("error:")
                        or (exit_code and int(exit_code.group(1)) != 0)):
                    block["is_error"] = True
                append_tool_result(block)
                continue
            if role not in ("user", "assistant"):
                continue
            if role == "user":
                append("user", cls._anthropic_content(source.get("content", "")))
                continue

            provider_message = source.get("_provider_message") or {}
            exact = (provider_message.get("content")
                     if provider_message.get("provider") == "anthropic" else None)
            blocks = ([copy.deepcopy(block) for block in exact if isinstance(block, dict)]
                      if isinstance(exact, list) and exact else [])
            if not blocks:
                blocks = cls._anthropic_content(source.get("content", ""))
                for call in source.get("tool_calls") or []:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function") or {}
                    name = str(function.get("name") or "") if isinstance(function, dict) else ""
                    if not name:
                        continue
                    raw = function.get("arguments")
                    arguments = raw if isinstance(raw, dict) else _tool_arguments(raw)
                    blocks.append({"type": "tool_use", "id": str(call.get("id") or ""),
                                   "name": name, "input": arguments})
            append("assistant", blocks)
        return "\n\n".join(part for part in system if part), out

    @staticmethod
    def _anthropic_tools(tools: list[dict] | None) -> list[dict]:
        converted: list[dict] = []
        for tool in tools or []:
            if not isinstance(tool, dict):
                continue
            function = tool.get("function") or {}
            if not isinstance(function, dict) or not function.get("name"):
                continue
            schema = function.get("parameters")
            converted.append({
                "name": str(function["name"]),
                "description": str(function.get("description") or ""),
                "input_schema": (copy.deepcopy(schema) if isinstance(schema, dict)
                                 else {"type": "object", "properties": {}}),
            })
        return converted

    @staticmethod
    def _anthropic_adaptive_model(model: str) -> bool:
        value = model.lower()
        if "claude-mythos-preview" in value:
            return True
        match = re.search(
            r"claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?", value)
        if not match:
            return False
        major = int(match.group(1))
        minor = int(match.group(2) or 0)
        return major >= 5 or (major, minor) >= (4, 6)

    def _anthropic_thinking(self, level, max_tokens: int) -> dict:
        if level in _REASONING_OFF:
            return {"type": "disabled"}
        if self._anthropic_adaptive_model(self.model):
            return {"type": "adaptive", "display": "summarized"}
        target = {"low": 2048, "medium": 8192, "high": 16384, "xhigh": 24576}.get(
            str(level).lower(), 8192)
        # Legacy extended thinking requires budget_tokens < max_tokens. A tiny explicit output cap
        # cannot carry the minimum useful thinking budget, so honor the cap and disable thinking.
        if max_tokens <= 1024:
            return {"type": "disabled"}
        # max_tokens includes legacy thinking. Preserve a useful visible coding/tool budget instead
        # of allowing "high" to consume every token except one.
        visible_reserve = min(4096, max(1, max_tokens // 2))
        budget = min(target, max_tokens - visible_reserve)
        if budget < 1024:
            return {"type": "disabled"}
        return {"type": "enabled", "budget_tokens": budget}

    @staticmethod
    def _anthropic_finish_reason(reason) -> str:
        value = str(reason or "")
        mapped = {
            "end_turn": "stop",
            "stop_sequence": "stop",
            "tool_use": "tool_calls",
            "max_tokens": "length",
            "model_context_window_exceeded": "length",
            "pause_turn": "pause_turn",
            "refusal": "stop",
        }.get(value)
        if mapped is None:
            raise LLMError(
                f"Anthropic Messages emitted an unsupported stop reason: {value or '<missing>'}")
        return mapped

    @staticmethod
    def _anthropic_usage(usage: dict | None) -> dict:
        raw = dict(usage) if isinstance(usage, dict) else {}
        if not usage_reported(raw):
            return {}
        def count(key: str) -> int:
            try:
                return max(0, int(raw.get(key, 0) or 0))
            except (TypeError, ValueError, OverflowError):
                return 0
        cache_read = count("cache_read_input_tokens")
        # Claude reports uncached, cache-write, and cache-read input as disjoint counters. DGC's
        # normalized input total represents the whole occupied context while retaining cache reads.
        return {
            "input_tokens": (count("input_tokens")
                             + count("cache_creation_input_tokens") + cache_read),
            "output_tokens": count("output_tokens"),
            "cached_input_tokens": cache_read,
            "reasoning_tokens": count("thinking_tokens"),
        }

    @staticmethod
    def _anthropic_result_from_blocks(blocks: dict[int, dict], result: ChatResult,
                                      on_text=None, on_thinking=None,
                                      *, emit_complete: bool = False,
                                      retain_provider_state: bool = True) -> ChatResult:
        provider_content: list[dict] = []
        for index in sorted(blocks):
            source = blocks[index]
            kind = str(source.get("type") or "")
            if kind == "text":
                text = str(source.get("text") or "")
                block = {k: copy.deepcopy(v) for k, v in source.items()
                         if not str(k).startswith("_")}
                block["type"], block["text"] = "text", text
                if retain_provider_state:
                    provider_content.append(block)
                if emit_complete and text:
                    result.content += text
                    if on_text:
                        on_text(text)
            elif kind == "thinking":
                thinking = str(source.get("thinking") or "")
                if retain_provider_state and not source.get("signature"):
                    raise LLMError("Anthropic thinking block omitted its continuation signature")
                if retain_provider_state and len(str(source["signature"])) > 128_000:
                    raise LLMError("Anthropic thinking signature exceeded its safety bound")
                block = {"type": "thinking", "thinking": thinking}
                if retain_provider_state:
                    block["signature"] = str(source["signature"])
                    provider_content.append(block)
                if emit_complete and thinking:
                    if result.thinking:
                        result.thinking += "\n\n"
                    result.thinking += thinking
                    if on_thinking:
                        on_thinking(thinking, ("thinking", index))
            elif kind == "redacted_thinking":
                if retain_provider_state:
                    provider_content.append({k: copy.deepcopy(v) for k, v in source.items()
                                             if not str(k).startswith("_")})
                if emit_complete and on_thinking:
                    on_thinking("", ("redacted", index))
            elif kind in ("tool_use", "server_tool_use"):
                raw = source.get("_input_json", "")
                if (not raw and source.get("input") is not None
                        and not isinstance(source.get("input"), dict)):
                    raise LLMError(f"Anthropic {kind} block emitted a non-object input")
                if raw and kind == "server_tool_use":
                    parsed = _loads_lenient(raw)
                    if not isinstance(parsed, dict):
                        raise LLMError(
                            "Anthropic server_tool_use block emitted malformed input JSON")
                    arguments = dict(parsed)
                else:
                    arguments = (_tool_arguments(raw) if raw
                                 else (copy.deepcopy(source.get("input"))
                                       if isinstance(source.get("input"), dict) else {}))
                call_id = str(source.get("id") or f"toolu_{index}")
                name = str(source.get("name") or "")
                if (not source.get("id") or not name
                        or len(call_id) > 512 or len(name) > 256):
                    raise LLMError(f"Anthropic {kind} block emitted an invalid id or name")
                try:
                    input_size = len(json.dumps(
                        arguments, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                except (RecursionError, TypeError, ValueError) as exc:
                    raise LLMError(f"Anthropic {kind} block emitted invalid input") from exc
                if input_size > 512_000:
                    raise LLMError("Anthropic tool input exceeded its safety bound")
                if retain_provider_state:
                    provider_content.append({"type": kind, "id": call_id,
                                             "name": name, "input": arguments})
                if kind == "tool_use":
                    result.tool_calls.append(
                        ToolCall(id=call_id, name=name, arguments=arguments))
            else:
                # Server-tool results, fallbacks, and newly added complete block types are
                # provider-owned continuation state. Preserve them byte-for-byte at the JSON-value
                # level, but never promote them into executable DGC tool calls.
                if retain_provider_state:
                    provider_content.append({
                        k: copy.deepcopy(v) for k, v in source.items()
                        if not str(k).startswith("_")
                    })
        if retain_provider_state:
            result.provider_message = {"provider": "anthropic", "content": provider_content}
        result.usage = LLMClient._anthropic_usage(result.usage)
        if result.tool_calls and result.finish_reason == "stop":
            result.finish_reason = "tool_calls"
        if result.tool_calls and result.finish_reason == "pause_turn":
            raise LLMError("Anthropic pause_turn unexpectedly included an unfinished client tool call")
        if result.finish_reason == "tool_calls" and not result.tool_calls:
            raise LLMError("Anthropic tool_use stop omitted an executable client tool call")
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        return result

    def _consume_anthropic_json(self, obj: dict, on_text, on_thinking) -> ChatResult:
        on_thinking = _reasoning.origin_callback(on_thinking)
        if not isinstance(obj, dict):
            raise LLMError("Anthropic Messages emitted a non-object response")
        if obj.get("type") == "error" or obj.get("error"):
            error = obj.get("error") or {}
            raise LLMError(str(error.get("message") or error or "Anthropic Messages failed"))
        content = obj.get("content") or []
        if (not isinstance(content, list) or len(content) > 256
                or not all(isinstance(block, dict)
                           and _ANTHROPIC_BLOCK_TYPE_RE.fullmatch(
                               str(block.get("type") or "")) for block in content)):
            raise LLMError("Anthropic Messages emitted invalid content blocks")
        try:
            blocks = {index: copy.deepcopy(block) for index, block in enumerate(content)
                      if isinstance(block, dict)}
        except RecursionError as exc:
            raise LLMError("Anthropic Messages emitted excessively nested content") from exc
        stop_reason = obj.get("stop_reason")
        terminal = stop_reason not in (None, "")
        result = ChatResult(
            response_id=str(obj.get("id") or "")[:512],
            finish_reason=(self._anthropic_finish_reason(stop_reason)
                           if terminal else "incomplete"),
            usage=obj.get("usage") or {},
        )

        def complete_thinking(text: str, where: tuple) -> None:
            kind, index = where
            if kind == "redacted":
                on_thinking("", self._reasoning_origin(
                    "anthropic.redacted", f"a{index}", api_mode="anthropic", event="withheld"))
                return
            origin = self._reasoning_origin("anthropic.thinking", f"a{index}", api_mode="anthropic")
            on_thinking(text, origin)
            on_thinking("", self._reasoning_origin(
                "anthropic.thinking", f"a{index}", api_mode="anthropic", event="stop"))

        return self._anthropic_result_from_blocks(
            blocks, result, on_text, complete_thinking if on_thinking else None,
            emit_complete=True, retain_provider_state=terminal)

    def _consume_anthropic(self, response: requests.Response, on_text, on_thinking,
                           cancel=None, think_budget: int = 0,
                           watch: RequestWatch | None = None) -> ChatResult:
        on_thinking = _reasoning.origin_callback(on_thinking)
        if ("application/json" in response.headers.get("Content-Type", "").lower()
                and "text/event-stream" not in response.headers.get("Content-Type", "").lower()):
            self._note_non_streaming(response)
            value, finish = _bounded_json_lifecycle(
                response, _MAX_ANTHROPIC_JSON_BYTES, "Anthropic Messages response", cancel,
                watch=watch)
            if finish:
                return ChatResult(finish_reason=finish, stall=_stall_of(watch, finish),
                                  interruption=_interruption_of(watch, finish, "anthropic"))
            return self._consume_anthropic_json(value, on_text, on_thinking)
        result = ChatResult()
        blocks: dict[int, dict] = {}
        thinking_parts = _ThinkingParts()
        block_started: dict[int, float] = {}    # reasoning block index -> content_block_start stamp
        # message_start, then each content_block_stop: a redacted_thinking block arrives whole at its
        # start, so the time it took is the gap since the previous boundary, not start -> stop.
        last_boundary: float | None = None

        def think(index: int, chunk: str) -> None:
            thinking_parts.add(result, f"a{index}", chunk)
            if on_thinking:
                on_thinking(chunk, self._reasoning_origin(
                    "anthropic.thinking", f"a{index}", api_mode="anthropic",
                    t_start=block_started.get(index)))

        produced = False
        message_started = False
        message_stopped = False
        stop_reason_seen = False
        active_blocks: set[int] = set()

        def terminal_received() -> bool:
            return (message_started and message_stopped
                    and not active_blocks and stop_reason_seen)

        watch, owned_watch = _own_watch(response, cancel, watch)
        response.encoding = "utf-8"
        try:
            for line in _bounded_stream_lines(
                    response, _MAX_ANTHROPIC_STREAM_BYTES, "Anthropic Messages stream"):
                if cancel is not None and cancel.is_set():
                    if not terminal_received():
                        result.finish_reason = "cancelled"
                    break
                if not line.startswith("data:"):
                    if line.startswith(":") and watch is not None:
                        watch.noise()           # an SSE comment (the `event:` line pairs with data)
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    event = json.loads(data)
                except (json.JSONDecodeError, RecursionError) as exc:
                    raise LLMError("Anthropic Messages emitted malformed SSE JSON") from exc
                if not isinstance(event, dict):
                    raise LLMError("Anthropic Messages emitted a non-object stream event")
                typ = str(event.get("type") or "")
                if watch is not None:
                    delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
                    if (typ in ("content_block_start", "content_block_delta", "message_stop")
                            or (typ == "message_delta" and delta.get("stop_reason"))):
                        watch.progress()
                    else:
                        watch.noise()           # ping, message_start, usage-only message_delta
                if message_stopped and typ not in ("ping", ""):
                    raise LLMError("Anthropic stream emitted data after message_stop")
                if typ == "message_start":
                    if message_started:
                        raise LLMError("Anthropic stream emitted duplicate message_start")
                    message = event.get("message") or {}
                    if not isinstance(message, dict):
                        raise LLMError("Anthropic message_start omitted its message object")
                    result.response_id = str(message.get("id") or "")[:512]
                    message_started = True
                    last_boundary = _reasoning.now()
                    if isinstance(message.get("usage"), dict):
                        result.usage.update(message["usage"])
                elif typ == "content_block_start":
                    if not message_started:
                        raise LLMError("Anthropic content block arrived before message_start")
                    try:
                        index = int(event.get("index"))
                    except (TypeError, ValueError, OverflowError):
                        raise LLMError("Anthropic content block has an invalid index") from None
                    if index < 0 or index >= 256 or index in blocks:
                        raise LLMError("Anthropic content block index is duplicate or out of range")
                    block = event.get("content_block") or {}
                    kind = str(block.get("type") or "") if isinstance(block, dict) else ""
                    if (not isinstance(block, dict)
                            or not _ANTHROPIC_BLOCK_TYPE_RE.fullmatch(kind)):
                        raise LLMError("Anthropic content block start is invalid")
                    blocks[index] = copy.deepcopy(block)
                    active_blocks.add(index)
                    if kind == "thinking":
                        block_started[index] = _reasoning.now()
                    elif kind == "redacted_thinking":
                        block_started[index] = (last_boundary if last_boundary is not None
                                                else _reasoning.now())
                    if kind in ("tool_use", "server_tool_use"):
                        blocks[index]["_input_json"] = ""
                        produced = True
                    elif kind == "text":
                        initial = str(block.get("text") or "")
                        result.content += initial
                        produced = produced or bool(initial)
                        if on_text and initial:
                            on_text(initial)
                    elif kind == "thinking":
                        initial = str(block.get("thinking") or "")
                        if initial:
                            think(index, initial)
                elif typ == "content_block_delta":
                    try:
                        index = int(event.get("index"))
                    except (TypeError, ValueError, OverflowError):
                        raise LLMError("Anthropic content delta has an invalid index") from None
                    if index not in blocks:
                        raise LLMError("Anthropic content delta arrived before its block")
                    if index not in active_blocks:
                        raise LLMError("Anthropic content delta arrived after its block stopped")
                    delta = event.get("delta") or {}
                    if not isinstance(delta, dict):
                        raise LLMError("Anthropic content delta is invalid")
                    delta_type = str(delta.get("type") or "")
                    block = blocks[index]
                    if delta_type == "text_delta":
                        if block.get("type") != "text":
                            raise LLMError("Anthropic text delta targeted a non-text block")
                        chunk = str(delta.get("text") or "")
                        block["text"] = str(block.get("text") or "") + chunk
                        result.content += chunk
                        produced = produced or bool(chunk)
                        if on_text and chunk:
                            on_text(chunk)
                    elif delta_type == "thinking_delta":
                        if block.get("type") != "thinking":
                            raise LLMError("Anthropic thinking delta targeted a non-thinking block")
                        chunk = str(delta.get("thinking") or "")
                        block["thinking"] = str(block.get("thinking") or "") + chunk
                        if chunk:
                            think(index, chunk)
                    elif delta_type == "signature_delta":
                        if block.get("type") != "thinking":
                            raise LLMError("Anthropic signature delta targeted a non-thinking block")
                        signature = str(delta.get("signature") or "")
                        block["signature"] = str(block.get("signature") or "") + signature
                        if len(str(block["signature"])) > 128_000:
                            raise LLMError("Anthropic thinking signature exceeded its safety bound")
                    elif delta_type == "input_json_delta":
                        if block.get("type") not in ("tool_use", "server_tool_use"):
                            raise LLMError("Anthropic tool-input delta targeted a non-tool block")
                        partial = delta.get("partial_json")
                        block["_input_json"] = _merge_stream_arguments(
                            block.get("_input_json", ""), partial)
                        if len(str(block["_input_json"])) > 512_000:
                            raise LLMError("Anthropic tool input exceeded its safety bound")
                    elif delta_type == "citations_delta":
                        if block.get("type") != "text" or not isinstance(delta.get("citation"), dict):
                            raise LLMError("Anthropic citation delta targeted an invalid block")
                        citations = block.setdefault("citations", [])
                        if not isinstance(citations, list) or len(citations) >= 4096:
                            raise LLMError("Anthropic citations exceeded their safety bound")
                        citations.append(copy.deepcopy(delta["citation"]))
                    else:
                        # Unknown top-level events are forward compatible, but silently ignoring a
                        # block delta would corrupt exact continuation state.
                        raise LLMError(
                            f"Anthropic Messages emitted an unsupported content delta: "
                            f"{delta_type or '<missing>'}")
                elif typ == "message_delta":
                    if not message_started or active_blocks:
                        raise LLMError("Anthropic message_delta arrived out of sequence")
                    delta = event.get("delta") or {}
                    if isinstance(delta, dict) and delta.get("stop_reason"):
                        result.finish_reason = self._anthropic_finish_reason(delta["stop_reason"])
                        stop_reason_seen = True
                    if isinstance(event.get("usage"), dict):
                        result.usage.update(event["usage"])
                elif typ == "content_block_stop":
                    try:
                        index = int(event.get("index"))
                    except (TypeError, ValueError, OverflowError):
                        raise LLMError("Anthropic content stop has an invalid index") from None
                    if index not in active_blocks:
                        raise LLMError("Anthropic content stop has no active block")
                    active_blocks.remove(index)
                    last_boundary = _reasoning.now()
                    stopped_kind = str(blocks[index].get("type") or "")
                    if on_thinking and stopped_kind == "thinking" and blocks[index].get("thinking"):
                        on_thinking("", self._reasoning_origin(
                            "anthropic.thinking", f"a{index}", api_mode="anthropic", event="stop"))
                    elif on_thinking and stopped_kind == "redacted_thinking":
                        # Readable text never comes; the row keeps its place before later prose.
                        on_thinking("", self._reasoning_origin(
                            "anthropic.redacted", f"a{index}", api_mode="anthropic",
                            event="withheld", t_start=block_started.get(index)))
                elif typ == "message_stop":
                    if not message_started or active_blocks or message_stopped:
                        raise LLMError("Anthropic message_stop arrived out of sequence")
                    message_stopped = True
                elif typ == "error":
                    error = event.get("error") or {}
                    raise LLMError(str(error.get("message") or error or
                                       "Anthropic Messages stream failed"))
                # Ping and future event types are ignorable; structural events above stay strict.
                if think_budget and not produced and len(result.thinking) > think_budget:
                    result.finish_reason = "overthink"
                    response.close()
                    break
        except Exception as exc:
            if (cancel is not None and cancel.is_set()
                    and not terminal_received()):
                result.finish_reason = "cancelled"
            elif _is_transport_interruption(exc):
                if watch is not None:
                    watch.observe_error(exc)
                if not terminal_received():
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            if owned_watch is not None:
                owned_watch.stop()
        terminal = terminal_received()
        if (not terminal and cancel is not None and cancel.is_set()
                and result.finish_reason != "overthink"):
            # A socket shutdown can be reported as clean EOF, so classify from the cancellation
            # lifecycle before falling into the nonterminal-recovery path.
            result.finish_reason = "cancelled"
        if result.finish_reason in ("cancelled", "overthink"):
            # Never turn a partially received tool block into an executable call. A watchdog retry
            # also must not retain an unsigned partial thinking block as continuation state.
            result.usage = self._anthropic_usage(result.usage)
            return result
        if not terminal:
            result.finish_reason = "incomplete"
            result.stall = _stall_of(watch, result.finish_reason)
            result.interruption = _interruption_of(watch, result.finish_reason, "anthropic")
        return self._anthropic_result_from_blocks(
            blocks, result, retain_provider_state=terminal)

    def _anthropic_payload(self, messages, tools, reasoning_effort,
                           disabled: set[str], max_tokens_limit: int | None = None) -> dict:
        system, wire_messages = self._anthropic_messages(messages)
        maximum = max(1, int(self.max_tokens or 16_384))
        discovered_limit = self.model_output_limit()
        if discovered_limit:
            maximum = min(maximum, discovered_limit)
        if max_tokens_limit is not None:
            maximum = min(maximum, max(1, int(max_tokens_limit)))
        payload: dict = {"model": self.model, "messages": wire_messages,
                         "max_tokens": maximum, "stream": True}
        if system:
            payload["system"] = system
        converted_tools = self._anthropic_tools(
            tools if "tools" not in disabled and self.tools_supported else None)
        if converted_tools:
            payload["tools"] = converted_tools
            if "tool_choice" not in disabled:
                payload["tool_choice"] = {"type": "auto"}
        if "reasoning" not in disabled and self.reasoning_supported:
            payload["thinking"] = self._anthropic_thinking(reasoning_effort, maximum)
        effort = str(reasoning_effort or "").lower()
        if "effort" not in disabled and effort in {"low", "medium", "high", "xhigh", "max"}:
            payload["output_config"] = {"effort": effort}
        return payload

    def _chat_anthropic(self, messages, tools, reasoning_effort, on_text, on_thinking,
                        cancel) -> ChatResult:
        if _image_parts_in(messages) and not self.vision_supported:
            messages = self._without_images(messages)      # images: known text-only, skip the try
        transient = 0
        disabled: set[str] = set()
        overthink = 0
        level = reasoning_effort
        lower = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off",
                 "none": "off", "off": "off"}
        last_err = ""
        last_cause = None
        max_tokens_limit: int | None = None
        stalls = 0
        rounds = 0
        while rounds < 10:
            rounds += 1
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            payload = self._anthropic_payload(
                messages, tools, level, disabled, max_tokens_limit)
            watch = self._next_watch(cancel, f"{self.base_url}/messages")
            try:
                with watch.registered():
                    response = requests.post(
                        f"{self.base_url}/messages", headers=self._anthropic_headers(),
                        json=payload, stream=True, timeout=self._post_timeout(watch))
            except requests.ConnectionError as exc:
                watch.stop()        # this attempt is over; a backoff must not raise notices
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                if watch.stall is not None:
                    stalls += 1
                    rounds -= 1
                    if not self._retry_stall(watch.stall, stalls, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                transient += 1
                last_err = f"connection: {scrub_urls(exc)}"
                last_cause = self._transport_cause(exc, f"{self.base_url}/messages")
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, 0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise self._connect_error(last_cause, exc, transient) from exc
            except requests.Timeout:
                watch.stop()
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                stalls += 1
                rounds -= 1
                if not self._retry_stall(watch.stall_from_timeout(), stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            watch.attach_response(response)
            if response.status_code != 200:
                watch.disarm()
            if (response.status_code in (404, 405, 501)
                    and self.requested_api_mode == "auto"):
                _close_response(response)
                self._mark_rejected("anthropic_messages")
                self.api_mode = "chat_completions"
                return self._chat_completions(messages, tools, reasoning_effort,
                                              on_text, on_thinking, cancel)
            if response.status_code in (408, 429) or response.status_code >= 500:
                status = response.status_code
                headers = response.headers
                body = scrub_urls(_error_body(response, 400))
                if status >= 500 and _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    messages = self._without_images(messages, refused=True)   # images: a refusal
                    continue
                last_err = f"HTTP {status}: {body}"
                transient += 1
                delay = _retry_delay(headers, 0.5 * transient)
                last_cause = self._status_cause(status, body, headers, f"{self.base_url}/messages", delay)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(
                    f"HTTP {status} from Anthropic Messages after {transient} tries: {body}"),
                    last_cause, transient)
            if response.status_code in (400, 413):
                status = response.status_code
                body = _error_body(response)
                low = body.lower()
                last_err = body
                if status == 413 or _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
                if _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    # images: the endpoint refused the image part, not tools. Retry once without it.
                    messages = self._without_images(messages, refused=True)
                    continue
                if "tool_choice" in payload and re.search(r"tool.choice|tool_choice", low):
                    payload.pop("tool_choice", None)
                    disabled.add("tool_choice")
                    continue
                if "output_config" in payload and re.search(r"output_config|effort", low):
                    disabled.add("effort")
                    continue
                if "thinking" in payload and re.search(
                        r"think|budget_tokens|adaptive|signature", low):
                    self._mark_rejected("reasoning")
                    disabled.add("reasoning")
                    continue
                if re.search(r"max_tokens|max.{0,12}(?:output|token)", low):
                    maximum = int(payload["max_tokens"])
                    if maximum > 1024:
                        max_tokens_limit = max(1024, maximum // 2)
                        continue
                if "tools" in payload and re.search(r"tool|input_schema", low):
                    self._mark_rejected("tools")
                    raise ToolsUnsupportedError("Anthropic Messages rejected native tool calling")
                raise self._answer_error(f"{status} from Anthropic Messages: {scrub_urls(body)}",
                                         status, body, f"{self.base_url}/messages", transient + 1)
            if response.status_code != 200:
                status = response.status_code
                body = scrub_urls(_error_body(response, 400))
                if status == 422 and _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    messages = self._without_images(messages, refused=True)   # images: a refusal
                    continue
                raise self._answer_error(f"HTTP {status} from Anthropic Messages: {body}",
                                         status, body, f"{self.base_url}/messages", transient + 1)
            budget = self.think_budget_chars
            self._usage_opened()
            self._next_reasoning_attempt(
                str((payload.get("thinking") or {}).get("display") or "")
                if isinstance(payload.get("thinking"), dict) else "")
            try:
                result = self._consume_anthropic(
                    response, on_text, on_thinking, cancel, think_budget=budget, watch=watch)
            finally:
                _close_response(response)
                watch.stop()
            stall = self._pre_progress_stall(result)
            if stall is not None:
                stalls += 1
                rounds -= 1
                if not self._retry_stall(stall, stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            if result.finish_reason == "overthink":
                overthink += 1
                prior_level = str(level or "off").lower()
                level = lower.get(prior_level, "off")
                # If an explicit reasoning-off request still produces only hidden thought, hand
                # the bounded outcome to the Agent instead of launching an unbounded final try.
                if prior_level in ("none", "off"):
                    return result
                self._report_usage(result)   # the abandoned attempt was a real request
                continue
            return result
        raise _with_cause(LLMError(f"Anthropic Messages request failed repeatedly: {last_err}"),
                          last_cause, transient)

    @staticmethod
    def _ollama_content(content) -> tuple[str, list[str]]:
        """Translate OpenAI-style text/image content into one native Ollama message."""
        if isinstance(content, str):
            return content, []
        if not isinstance(content, list):
            return str(content or ""), []
        text: list[str] = []
        images: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") in ("text", "input_text"):
                text.append(str(part.get("text") or ""))
            elif part.get("type") in ("image_url", "input_image"):
                value = part.get("image_url") or part.get("image") or ""
                if isinstance(value, dict):
                    value = value.get("url") or ""
                value = str(value)
                if value.startswith("data:") and "," in value:
                    value = value.split(",", 1)[1]
                if value:
                    images.append(value)
        return "\n".join(part for part in text if part), images

    @classmethod
    def _ollama_messages(cls, messages: list[dict]) -> list[dict]:
        """Map DGC's canonical transcript to Ollama's native chat/tool history."""
        out: list[dict] = []
        call_names: dict[str, str] = {}
        for source in messages:
            if not isinstance(source, dict):
                continue
            role = str(source.get("role") or "")
            if role not in ("system", "user", "assistant", "tool"):
                continue
            content, images = cls._ollama_content(source.get("content", ""))
            provider_message = source.get("_provider_message") or {}
            if (role == "assistant" and provider_message.get("provider") == "ollama"):
                # The canonical content may include a deterministic DGC tool preamble. Replay the
                # provider's exact assistant message, including its required thinking continuation.
                content = str(provider_message.get("content") or "")
            message: dict = {"role": role, "content": content}
            if (role == "assistant" and provider_message.get("provider") == "ollama"):
                thinking = str(provider_message.get("thinking") or "")
                if thinking:
                    message["thinking"] = thinking
            if images:
                message["images"] = images
            canonical_calls = source.get("tool_calls") or []
            provider_calls = (provider_message.get("tool_calls")
                              if provider_message.get("provider") == "ollama" else None)
            if role == "assistant" and (canonical_calls or provider_calls):
                # Ollama's streaming contract requires the complete accumulated assistant
                # message on the next request. Prefer the exact native calls captured from that
                # stream; canonical calls remain the portable fallback (and carry DGC's local IDs).
                native_calls = [dict(call) for call in provider_calls
                                if isinstance(call, dict)] if isinstance(provider_calls, list) else []
                have_native_calls = bool(native_calls)
                for call in canonical_calls:
                    if not isinstance(call, dict):
                        continue
                    fn = call.get("function") or {}
                    name = str(fn.get("name") or "")
                    if not name:
                        continue
                    raw_args = fn.get("arguments")
                    args = raw_args if isinstance(raw_args, dict) else _loads_lenient(str(raw_args or "{}"))
                    if not isinstance(args, dict):
                        args = {"_unparsed": str(raw_args or "")}
                    if not have_native_calls:
                        native_calls.append({"function": {"name": name, "arguments": args}})
                    call_id = str(call.get("id") or "")
                    if call_id:
                        call_names[call_id] = name
                if native_calls:
                    message["tool_calls"] = native_calls
            elif role == "tool":
                call_id = str(source.get("tool_call_id") or "")
                tool_name = str(source.get("name") or call_names.get(call_id) or "")
                if tool_name:
                    message["tool_name"] = tool_name
            out.append(message)
        return out

    def _ollama_think(self, level):
        # This model always reasons and has three native tiers, rather than an off switch.
        if "glm-5.3-flash" in self.model.lower():
            if level in _REASONING_OFF or level == "low":
                return "low"
            return "max" if level in ("xhigh", "max") else "high"
        # GPT-OSS does not accept booleans and cannot fully disable reasoning. Honor an off request
        # with its lowest supported level rather than sending false, which that model ignores.
        if "gpt-oss" in self.model.lower():
            value = str(level).lower()
            if level in _REASONING_OFF:
                return "low"
            return value if value in ("low", "medium", "high") else "high"
        if level in _REASONING_OFF:
            return False
        # Most thinking models accept a boolean, not graded effort strings. A string can cause
        # Ollama to reject the entire control and retry with the model's default, even for "low".
        return True

    def _consume_ollama(self, r: requests.Response, on_text, on_thinking, cancel=None,
                        think_budget: int = 0, watch: RequestWatch | None = None) -> ChatResult:
        """Consume native Ollama JSON/NDJSON without translating it through SSE semantics."""
        on_thinking = _reasoning.origin_callback(on_thinking)
        result = ChatResult()
        filt = _ThinkFilter()
        thinking_parts = _ThinkingParts()
        native_tags = _NativeThinkTags()

        def think(channel: str, local: str, chunk: str) -> None:
            thinking_parts.add(result, local, chunk)
            if on_thinking:
                on_thinking(chunk, self._reasoning_origin(channel, local, api_mode="ollama"))

        def native_think_end() -> None:
            held = native_tags.finish()
            if held:
                think("ollama.thinking", "ol", held)

        produced = False
        native_content = ""
        native_thinking = ""
        native_calls: list[dict] = []
        terminal_done = False

        def consume(obj: dict) -> None:
            nonlocal produced, native_content, native_thinking, terminal_done
            if terminal_done:
                raise LLMError("Ollama emitted data after the terminal done event")
            done = obj.get("done")
            if done is not None and not isinstance(done, bool):
                raise LLMError("Ollama emitted a non-boolean done field")
            if obj.get("error"):
                raise LLMError(f"Ollama stream error: {str(obj['error'])[:400]}")
            message = obj.get("message") or {}
            if not isinstance(message, dict):
                raise LLMError("Ollama emitted a non-object message")
            if watch is not None:
                if (done is True or message.get("thinking") or message.get("content")
                        or message.get("tool_calls")):
                    watch.progress()
                else:
                    watch.noise()
            reasoning = str(message.get("thinking") or "")
            if reasoning:
                native_thinking += reasoning            # the provider's own text, for continuation
                shown = native_tags.feed(reasoning)
                if shown:
                    think("ollama.thinking", "ol", shown)
            if message.get("content") or message.get("tool_calls") or done is True:
                native_think_end()
            content = str(message.get("content") or "")
            if content:
                native_content += content
                for kind, chunk in filt.feed(content):
                    if kind == "think":
                        think("tags", "tags", chunk)
                    else:
                        result.content += chunk
                        # Some local templates put reasoning inside ``<think>`` tags in the
                        # ordinary content field. Only text that survives into the normal channel
                        # is a user-visible answer and may disarm the reasoning watchdog.
                        produced = True
                        if on_text:
                            on_text(chunk)
            calls = message.get("tool_calls") or []
            if not isinstance(calls, list):
                raise LLMError("Ollama emitted non-list tool_calls")
            for call in calls:
                if len(native_calls) >= _MAX_OLLAMA_TOOL_CALLS:
                    raise LLMError("Ollama emitted too many tool calls")
                if not isinstance(call, dict):
                    raise LLMError("Ollama emitted a non-object tool call")
                fn = call.get("function") or {}
                if not isinstance(fn, dict):
                    raise LLMError("Ollama emitted a non-object tool function")
                name = str(fn.get("name") or "")
                raw_args = fn.get("arguments")
                args = raw_args if isinstance(raw_args, dict) else _loads_lenient(str(raw_args or "{}"))
                if not name or not isinstance(args, dict):
                    raise LLMError("Ollama emitted an invalid native tool call")
                # Native Ollama emits each complete tool-call object in the stream. Calls must be
                # extended across chunks (not merged by each chunk's zero-based array position).
                native_call = {k: v for k, v in call.items() if k != "function"}
                native_fn = {k: v for k, v in fn.items() if k != "arguments"}
                native_fn["arguments"] = args
                native_call["function"] = native_fn
                native_calls.append(native_call)
                produced = True
            if done is True:
                terminal_done = True
                result.finish_reason = str(obj.get("done_reason") or result.finish_reason)
                raw_usage = {key: obj[source] for key, source in (
                    ("prompt_tokens", "prompt_eval_count"), ("completion_tokens", "eval_count"),
                    ("cached_input_tokens", "prompt_eval_cached_count")) if source in obj}
                result.usage = normalize_usage(raw_usage) if usage_reported(raw_usage) else {}

        watch, owned_watch = _own_watch(r, cancel, watch)

        try:
            ctype = r.headers.get("Content-Type", "").lower()
            if "application/json" in ctype and "ndjson" not in ctype:
                # The declared type does not settle this. A local Ollama labels a stream
                # `application/x-ndjson`, but Ollama's cloud serves the same newline-delimited
                # stream as `application/json` -- the identical header it uses for a single
                # object -- so trusting the header parsed every cloud turn as one object and
                # failed with "malformed JSON". This request always asks for `stream: true`, so
                # read the body once and let its shape decide.
                chunk_seen = watch.progress if watch is not None else None
                text = _bounded_body_text(r, _MAX_OLLAMA_JSON_BYTES, "Ollama response",
                                          on_chunk=chunk_seen)
                if text is None:
                    frames = [_bounded_json_response(
                        r, _MAX_OLLAMA_JSON_BYTES, "Ollama response", on_chunk=chunk_seen)]
                    text = ""
                try:
                    frames = frames if text == "" else [json.loads(text)]
                except (ValueError, RecursionError):
                    frames = []
                    for line in text.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            frames.append(json.loads(line))
                        except (ValueError, RecursionError) as exc:
                            raise LLMError("Ollama emitted malformed JSON") from exc
                    if not frames:
                        raise LLMError("Ollama emitted malformed JSON")
                for frame in frames:
                    if not isinstance(frame, dict):
                        raise LLMError("Ollama emitted a non-object JSON response")
                    consume(frame)
                    if cancel is not None and cancel.is_set():
                        break
            else:
                r.encoding = "utf-8"
                lines = iter(_bounded_stream_lines(
                    r, _MAX_OLLAMA_STREAM_BYTES, "Ollama stream"))
                while True:
                    try:
                        line = next(lines)
                    except StopIteration:
                        break
                    except Exception:
                        if cancel is not None and cancel.is_set():
                            if not terminal_done:
                                result.finish_reason = "cancelled"
                            break
                        raise
                    if cancel is not None and cancel.is_set():
                        if not terminal_done:
                            result.finish_reason = "cancelled"
                        break
                    if isinstance(line, bytes):
                        line = line.decode("utf-8", "replace")
                    line = str(line or "").strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except (json.JSONDecodeError, RecursionError) as exc:
                        raise LLMError("Ollama emitted malformed NDJSON") from exc
                    if not isinstance(obj, dict):
                        raise LLMError("Ollama emitted a non-object stream event")
                    consume(obj)
                    if think_budget and not produced and len(result.thinking) > think_budget:
                        result.finish_reason = "overthink"
                        try:
                            r.close()
                        except Exception:
                            pass
                        break
        except Exception as exc:
            if cancel is not None and cancel.is_set() and not terminal_done:
                result.finish_reason = "cancelled"
            elif _is_transport_interruption(exc):
                if watch is not None:
                    watch.observe_error(exc)
                if not terminal_done:
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            if owned_watch is not None:
                owned_watch.stop()

        if (not terminal_done and cancel is not None and cancel.is_set()
                and result.finish_reason != "overthink"):
            result.finish_reason = "cancelled"
        aborted = result.finish_reason in ("cancelled", "overthink")
        if not aborted and not terminal_done:
            result.finish_reason = "incomplete"
            result.stall = _stall_of(watch, result.finish_reason)
            result.interruption = _interruption_of(watch, result.finish_reason, "ollama")
        native_think_end()
        for kind, chunk in filt.flush():
            if kind == "think":
                think("tags", "tags", chunk)
            else:
                result.content += chunk
                if on_text:
                    on_text(chunk)
        if aborted:
            # Cancellation and the reasoning watchdog deliberately end before Ollama's terminal
            # event. Partial native or text-shaped calls are never executable continuation state.
            return result
        for call in native_calls:
            fn = call["function"]
            self._native_call_seq += 1
            result.tool_calls.append(ToolCall(
                id=str(call.get("id") or f"ollama_call_{self._native_call_seq}"),
                name=str(fn["name"]), arguments=dict(fn["arguments"])))
        if result.tool_calls and result.finish_reason == "stop":
            result.finish_reason = "tool_calls"
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        if terminal_done:
            result.provider_message = {
                "provider": "ollama", "content": native_content, "thinking": native_thinking,
            }
            if native_calls:
                result.provider_message["tool_calls"] = native_calls
        return result

    def _chat_ollama(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        reasoning_effort: str | None = None,
        on_text=None,
        on_thinking=None,
        cancel=None,
    ) -> ChatResult:
        self.prepare_model(cancel=cancel)
        if tools and not self.tools_supported:
            raise ToolsUnsupportedError(
                "Ollama model metadata reports no native tool-calling capability")
        if _image_parts_in(messages) and not self.vision_supported:
            # Refusing the turn stranded the run: the image stays in the conversation, so every
            # later turn -- and every attempt to resume a standing goal -- re-sent it and failed
            # the same way. An attachment this model cannot read is a fact to tell it about, not a
            # reason to stop working. Drop the pixels from the request and say so in their place.
            messages = self._without_images(messages)
        ollama_messages = self._ollama_messages(messages)
        payload: dict = {"model": self.model, "messages": ollama_messages,
                         "stream": True}
        if tools and self.tools_supported:
            payload["tools"] = tools
        if self.reasoning_supported:
            payload["think"] = self._ollama_think(reasoning_effort)
        options: dict = {}
        if self.max_tokens and self._feature_supported("max_output_tokens"):
            options["num_predict"] = self.max_tokens
        context_size = self.effective_context_size()
        if context_size:
            options["num_ctx"] = context_size
        if self.sampling and self._feature_supported("sampling"):
            options.update(self.sampling)
        if options:
            payload["options"] = options
        if self.keep_alive:
            payload["keep_alive"] = self.keep_alive

        last_err = ""
        last_cause = None
        transient = 0
        repaired = False
        overthink = 0
        level = reasoning_effort
        lower = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off",
                 "none": "off", "off": "off"}
        stalls = 0
        rounds = 0
        while rounds < 8:
            rounds += 1
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            watch = self._next_watch(cancel, self._ollama_url)
            try:
                with watch.registered():
                    r = requests.post(self._ollama_url, headers=self._headers(), json=payload,
                                      stream=True, timeout=self._post_timeout(watch))
            except requests.ConnectionError as exc:
                watch.stop()        # this attempt is over; a backoff must not raise notices
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                if watch.stall is not None:
                    stalls += 1
                    rounds -= 1
                    if not self._retry_stall(watch.stall, stalls, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                transient += 1
                last_err = f"connection: {scrub_urls(exc)}"
                last_cause = self._transport_cause(exc, self._ollama_url)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, 0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise self._connect_error(
                    last_cause, exc, transient, target=self._ollama_root,
                    clause="is Ollama running? (/connect <url> to change it)") from exc
            except requests.Timeout:
                watch.stop()
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                stalls += 1
                rounds -= 1
                if not self._retry_stall(watch.stall_from_timeout(), stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            watch.attach_response(r)
            if r.status_code != 200:
                watch.disarm()

            if r.status_code in (404, 405, 501) and self.requested_api_mode == "auto":
                _close_response(r)
                self._mark_rejected("native_chat")
                self.api_mode = "chat_completions"
                return self._chat_completions(messages, tools, reasoning_effort,
                                              on_text, on_thinking, cancel)
            if r.status_code == 429:
                transient += 1
                headers = r.headers
                body = scrub_urls(_error_body(r))
                last_err = f"429 rate limited: {body[:200]}"
                delay = _retry_delay(headers, 0.5 * transient)
                last_cause = self._status_cause(429, body, headers, self._ollama_url, delay)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(f"rate limited (429) after {transient} tries: {last_err}"),
                                  last_cause, transient)
            if r.status_code in (400, 413):
                body = _error_body(r)
                low = body.lower()
                last_err = body
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
                if _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    # images: /api/show can be silent about capabilities, so a text-only model's
                    # "Multimodal data provided, but model does not support multimodal requests"
                    # is the first word. It refuses the image, not tools: retry once without it.
                    messages = self._without_images(messages, refused=True)
                    payload["messages"] = self._ollama_messages(messages)
                    continue
                if (r.status_code == 400 and self.tools_supported and "tools" in payload
                        and re.search(r"tool|function", low)):
                    self._mark_rejected("tools")
                    raise ToolsUnsupportedError("Ollama rejected native tool calling")
                if (r.status_code == 400 and "think" in payload
                        and re.search(r"think|reason", low)):
                    self._mark_rejected("reasoning")
                    payload.pop("think", None)
                    continue
                native_options = payload.get("options") or {}
                if ("num_predict" in native_options
                        and re.search(r"num_predict|max.{0,8}(?:token|output)", low)):
                    self._mark_rejected("max_output_tokens")
                    native_options.pop("num_predict", None)
                    continue
                if ("num_ctx" in native_options and re.search(r"num_ctx|context", low)):
                    native_options.pop("num_ctx", None)
                    continue
                if (self.sampling and any(k in native_options for k in _SAMPLING_KEYS)
                        and re.search(r"top_k|top_p|min_p|temperature|sampl", low)):
                    self._mark_rejected("sampling")
                    for key in _SAMPLING_KEYS:
                        native_options.pop(key, None)
                    continue
                raise self._answer_error(f"{r.status_code} from Ollama: {scrub_urls(body)}",
                                         r.status_code, body, self._ollama_url, transient + 1)
            if r.status_code >= 500:
                status = r.status_code
                body = scrub_urls(_error_body(r))
                if _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    messages = self._without_images(messages, refused=True)   # images: a refusal
                    payload["messages"] = self._ollama_messages(
                        _repair_for_retry(messages) if repaired else messages)
                    continue
                transient += 1
                last_err = f"HTTP {status}: {body[:300]}"
                delay = _retry_delay(r.headers, 0.5 * transient)     # a busy 503 may say how long
                last_cause = self._status_cause(status, body, r.headers, self._ollama_url, delay)
                if transient < 4:
                    if transient >= 2 and not repaired:
                        payload["messages"] = self._ollama_messages(_repair_for_retry(messages))
                        repaired = True
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(
                    f"HTTP {status} from {safe_endpoint(self._ollama_url)} after {transient} tries: "
                    f"{body[:400]}"), last_cause, transient)
            if r.status_code != 200:
                status = r.status_code
                body = scrub_urls(_error_body(r, 400))
                raise self._answer_error(f"HTTP {status} from {safe_endpoint(self._ollama_url)}: {body}",
                                         status, body, self._ollama_url, transient + 1)
            budget = self.think_budget_chars
            self._usage_opened()
            self._next_reasoning_attempt()
            try:
                result = self._consume_ollama(r, on_text, on_thinking, cancel, think_budget=budget,
                                              watch=watch)
            finally:
                _close_response(r)
                watch.stop()
            stall = self._pre_progress_stall(result)
            if stall is not None:
                stalls += 1
                rounds -= 1
                if not self._retry_stall(stall, stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            if result.finish_reason == "overthink":
                overthink += 1
                prior_level = str(level or "off").lower()
                level = lower.get(prior_level, "off")
                if prior_level in ("none", "off"):
                    return result
                if self.reasoning_supported:
                    payload["think"] = self._ollama_think(level)
                self._report_usage(result)   # the abandoned attempt was a real request
                continue
            return result
        raise _with_cause(LLMError(f"Ollama request failed repeatedly: {last_err}"),
                          last_cause, transient)

    def _chat_completions(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        reasoning_effort: str | None = None,
        on_text=None,
        on_thinking=None,
        cancel=None,
    ) -> ChatResult:
        if _image_parts_in(messages) and not self.vision_supported:
            messages = self._without_images(messages)      # images: known text-only, skip the try
        # Provider-private continuation metadata belongs only to Responses input items.
        chat_messages = [{k: v for k, v in message.items() if not str(k).startswith("_")}
                         for message in messages]
        payload: dict = {"model": self.model, "messages": chat_messages, "stream": True}
        if tools and self.tools_supported:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
            if self._feature_supported("parallel_tools"):
                payload["parallel_tool_calls"] = True
        if self.reasoning_supported:        # F1: provider-aware reasoning/thinking control
            payload.update(_reasoning_payload(self.family, self.model, reasoning_effort))
        if self.max_tokens and self._feature_supported("max_output_tokens"):
            payload["max_tokens"] = self.max_tokens
        if self.sampling and self._feature_supported("sampling"):
            payload.update(self.sampling)
        if self.family == "ollama" and self.keep_alive:   # D2: model residency (Ollama honours it on /v1)
            payload["keep_alive"] = self.keep_alive
        # Ollama, vLLM, LM Studio and others stream token usage only when asked. Without this a
        # whole session on a /v1 route recorded zero tokens and goal token budgets never advanced.
        if (self._feature_supported("usage")
                and self.base_url.lower() not in LLMClient._stream_usage_rejections):
            payload["stream_options"] = {"include_usage": True}

        last_err = ""
        last_cause = None  # the classified cause of the last retried failure (for the final error)
        transient = 0      # count of retried timeouts / 5xx (bounded, with backoff)
        repaired = False   # whether we've swapped in the endpoint-agnostic repaired shape
        overthink = 0      # F4: times the reasoning-watchdog fired this turn (bounded)
        level = reasoning_effort   # current thinking level; the watchdog steps it down on a runaway
        usage_retry = False   # stream_options was just dropped after a refusal; 200 confirms it
        _LOWER = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off", "none": "off", "off": "off"}
        stalls = 0         # attempts the stall watcher ended before anything streamed
        rounds = 0
        while rounds < 8:  # 400-fallbacks + up to 4 transient retries share this budget
            rounds += 1
            # A deadline may expire while requests.post is waiting for response headers. Never turn
            # that terminal cancellation into several fresh provider generations via the transient
            # retry path; the abandoned in-flight attempt is already billable work.
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            watch = self._next_watch(cancel, self._url)
            try:
                with watch.registered():
                    r = requests.post(self._url, headers=self._headers(), json=payload,
                                      stream=True, timeout=self._post_timeout(watch))
            except requests.ConnectionError as e:
                watch.stop()        # this attempt is over; a backoff must not raise notices
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                if watch.stall is not None:
                    # The watcher closed a request that sent nothing. The same payload is safe to
                    # re-issue: nothing reached the UI. Stall retries have their own bound.
                    stalls += 1
                    rounds -= 1
                    if not self._retry_stall(watch.stall, stalls, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                # transient network drops (connection reset / broken pipe / socket hang-up) recover on
                # a retry; a persistent refusal (server down) exhausts the budget and raises the hint.
                last_err = f"connection: {scrub_urls(e)}"
                transient += 1
                last_cause = self._transport_cause(e, self._url)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, 0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                if is_local_endpoint(self.base_url, getattr(self, "family", "")):
                    raise self._connect_error(
                        last_cause, e, transient,
                        clause="is your local LLM server running? (/connect <url> to change it)") from e
                raise self._connect_error(
                    last_cause, e, transient,
                    clause=f"{last_cause.summary} (/connect <url> to change it)") from e
            except requests.Timeout:
                watch.stop()
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                # The socket read timeout is the watcher's backstop; silence is silence either way.
                stalls += 1
                rounds -= 1
                if not self._retry_stall(watch.stall_from_timeout(), stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            watch.attach_response(r)
            if r.status_code != 200:
                watch.disarm()      # an error body is not a generation; only cancel applies
            if r.status_code == 429:
                # rate limited — back off (honour Retry-After) and retry within the budget
                headers = r.headers
                body = scrub_urls(_error_body(r))
                last_err = f"429 rate limited: {body[:200]}"
                transient += 1
                delay = _retry_delay(headers, 0.5 * transient)
                last_cause = self._status_cause(429, body, headers, self._url, delay)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(f"rate limited (429) after {transient} tries: {last_err}"),
                                  last_cause, transient)
            if r.status_code in (400, 413, 422):
                body = _error_body(r)
                last_err = body
                low = body.lower()
                # Classify OVERFLOW first — some overflow bodies contain words like "invalid" that would
                # otherwise be misread as a sampling/tool rejection and permanently strip a capability.
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
                if (r.status_code in (400, 422) and _image_parts_in(payload["messages"])
                        and _IMAGE_REFUSAL_RE.search(body)):
                    # images: the endpoint refused the image part, not tools. Retry once without it.
                    messages = self._without_images(messages, refused=True)
                    payload["messages"] = (_repair_for_retry(messages) if repaired else
                                           [{k: v for k, v in message.items() if not str(k).startswith("_")}
                                            for message in messages])
                    continue
                if (r.status_code in (400, 422) and "stream_options" in payload
                        and _STREAM_USAGE_REFUSAL_RE.search(body)):
                    # An endpoint that refuses the usage request still streams: retry once without
                    # it. It is remembered only if that retry succeeds (see usage_retry above).
                    payload.pop("stream_options", None)
                    usage_retry = True
                    continue
                if r.status_code == 422:
                    raise self._answer_error(
                        f"HTTP 422 from {safe_endpoint(self._url)}: {scrub_urls(body)[:400]}",
                        422, body, self._url, transient + 1)
                # only disable a capability when the server actually blames THAT capability —
                # a 400 about something else must not permanently strip tools/reasoning.
                if (r.status_code == 400 and "parallel_tool_calls" in payload
                        and re.search(r"parallel", low)):
                    self._mark_rejected("parallel_tools")
                    payload.pop("parallel_tool_calls", None)
                    continue
                if (r.status_code == 400 and self.tools_supported and "tools" in payload
                        and re.search(r"tool|function", low)):
                    self._mark_rejected("tools")
                    raise ToolsUnsupportedError("endpoint rejected native tool calling")
                if (r.status_code == 400 and self.reasoning_supported
                        and any(k in payload for k in _REASONING_KEYS)
                        and re.search(r"reason|effort|think|template", low)):
                    self._mark_rejected("reasoning")        # F2: server rejects our reasoning shape →
                    for k in _REASONING_KEYS:               # strip every reasoning key, respect its default
                        payload.pop(k, None)
                    continue
                if (r.status_code == 400 and "max_tokens" in payload
                        and re.search(r"max_tokens|max_completion|max.{0,8}output", low)):
                    self._mark_rejected("max_output_tokens")
                    payload.pop("max_tokens", None)         # F3: server rejects our cap → drop it, retry
                    continue
                if (r.status_code == 400 and self.sampling
                        and any(k in payload for k in _SAMPLING_KEYS)
                        and re.search(r"unrecognized|unsupported|unexpected|unknown|invalid|"
                                      r"top_k|top_p|min_p|temperature|sampl", low)):
                    self._mark_rejected("sampling")
                    for k in _SAMPLING_KEYS:                # server rejects a sampling knob → drop ALL of
                        payload.pop(k, None)                #   them (respect its defaults) and don't re-add,
                    continue
                # unclear 400 with tools present: fall back to the text protocol (still robust)
                if r.status_code == 400 and self.tools_supported and "tools" in payload:
                    self._mark_rejected("tools")
                    raise ToolsUnsupportedError("endpoint rejected native tool calling")
                raise self._answer_error(f"{r.status_code} from server: {scrub_urls(body)}",
                                         r.status_code, body, self._url, transient + 1)
            if r.status_code >= 500:
                # Transient upstream error — retry instead of killing the turn (robust
                # clients do the same). Ollama, for one, intermittently 500s
                # "no user query found in messages" on long tool-loops.
                status = r.status_code
                body = scrub_urls(_error_body(r))
                if _image_parts_in(payload["messages"]) and _IMAGE_REFUSAL_RE.search(body):
                    # images: a server without an image encoder (llama.cpp without mmproj) says so
                    # with a 500. That is a refusal, not a transient failure: retry without it.
                    messages = self._without_images(messages, refused=True)
                    payload["messages"] = (_repair_for_retry(messages) if repaired else
                                           [{k: v for k, v in message.items() if not str(k).startswith("_")}
                                            for message in messages])
                    continue
                last_err = f"HTTP {status}: {body[:300]}"
                transient += 1
                delay = _retry_delay(r.headers, 0.5 * transient)     # a busy 503 may say how long
                last_cause = self._status_cause(status, body, r.headers, self._url, delay)
                if transient < 4:
                    # After a plain retry fails, also repair the message SHAPE — collapse
                    # native tool-calls/results into plain user/assistant text that even a
                    # brittle chat template can render. This is the DGC-level fix (works for
                    # any user's endpoint, not just one machine's Ollama models).
                    if transient >= 2 and not repaired:
                        payload["messages"] = _repair_for_retry(messages)
                        repaired = True
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(
                    f"HTTP {status} from {safe_endpoint(self._url)} after {transient} tries: {body[:400]}"),
                    last_cause, transient)
            if r.status_code != 200:
                status = r.status_code
                body = scrub_urls(_error_body(r, 400))
                raise self._answer_error(f"HTTP {status} from {safe_endpoint(self._url)}: {body}",
                                         status, body, self._url, transient + 1)
            budget = self.think_budget_chars
            self._usage_opened()
            self._next_reasoning_attempt()
            if usage_retry:
                # The same endpoint accepted the request once stream_options was gone: that is
                # proof it refuses the field, so stop asking it for the rest of this process.
                LLMClient._stream_usage_rejections.add(self.base_url.lower())
                usage_retry = False
            try:
                res = self._consume(r, on_text, on_thinking, cancel, think_budget=budget,
                                    watch=watch)
            finally:
                _close_response(r)
                watch.stop()
            stall = self._pre_progress_stall(res)
            if stall is not None:
                stalls += 1
                rounds -= 1
                if not self._retry_stall(stall, stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            if res.finish_reason == "overthink":          # F4: reasoning ran away → retry with less
                overthink += 1
                prior_level = str(level or "off").lower()
                level = _LOWER.get(prior_level, "off")     # high→medium→low→off (floor)
                if prior_level in ("none", "off"):
                    return res
                for k in _REASONING_KEYS:
                    payload.pop(k, None)
                if self.reasoning_supported:
                    payload.update(_reasoning_payload(self.family, self.model, level))
                self._report_usage(res)   # the abandoned attempt was a real request
                continue
            return res
        raise _with_cause(LLMError(f"request failed repeatedly: {last_err}"), last_cause, transient)

    @staticmethod
    def _responses_input(messages: list[dict]) -> tuple[str, list[dict]]:
        """Translate stored Chat-Completions history into Responses API input items."""
        instructions: list[str] = []
        items: list[dict] = []
        for message in messages:
            role = message.get("role")
            content = message.get("content")
            if role == "system":
                instructions.append(str(content or ""))
                continue
            if message.get("_responses_compaction_display") is True:
                # The adjacent assistant item contains the provider's opaque compacted state. This
                # mechanical summary exists only so resume/history UIs remain intelligible; replaying
                # it as additional provider input would duplicate the compacted prefix.
                continue
            if role == "tool":
                items.append({"type": "function_call_output",
                              "call_id": str(message.get("tool_call_id") or ""),
                              "output": str(content or "")})
                continue
            if role not in ("user", "assistant"):
                continue
            provider_output = message.get("_responses_output") if role == "assistant" else None
            if isinstance(provider_output, list) and provider_output:
                # In stateless mode the exact provider output (including encrypted reasoning) must
                # be replayed. Do not also reconstruct its visible text/function calls.
                items.extend(dict(item) for item in provider_output if isinstance(item, dict))
                continue
            if isinstance(content, list):
                converted: list[dict] = []
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") in ("text", "input_text"):
                        converted.append({"type": "input_text", "text": str(part.get("text", ""))})
                    elif part.get("type") in ("image_url", "input_image"):
                        value = part.get("image_url")
                        url = value.get("url") if isinstance(value, dict) else value
                        if url:
                            converted.append({"type": "input_image", "image_url": str(url)})
                if converted:
                    items.append({"role": role, "content": converted})
            elif content:
                items.append({"role": role, "content": str(content)})
            if role == "assistant":
                for call in message.get("tool_calls") or []:
                    fn = call.get("function") or {}
                    items.append({"type": "function_call", "call_id": str(call.get("id") or ""),
                                  "name": str(fn.get("name") or ""),
                                  "arguments": str(fn.get("arguments") or "{}")})
        return "\n\n".join(instructions), items

    @staticmethod
    def _responses_estimate_input(messages: list[dict]) -> tuple[str, list[dict], int]:
        """Return Responses wire input with opaque compaction blobs token-estimated safely.

        A compaction item's encrypted bytes are transport state, not a useful character proxy for
        its effective model-context footprint. When Agent persisted a sane provider-reported output
        token count, remove only that item's ciphertext from the JSON estimate and add the token
        count directly. Missing/tampered hints deliberately retain the full ciphertext estimate.
        """
        instructions, items = LLMClient._responses_input(messages)
        hints: list[int] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            provider_output = message.get("_responses_output")
            if not isinstance(provider_output, list):
                continue
            hint = _bounded_model_tokens(message.get("_responses_compaction_tokens"))
            valid_envelope = bool(
                provider_output
                and isinstance(provider_output[-1], dict)
                and provider_output[-1].get("type") == "compaction"
                and isinstance(provider_output[-1].get("encrypted_content"), str)
                and bool(provider_output[-1].get("encrypted_content"))
                and all(isinstance(item, dict)
                        and item.get("type") == "message" and item.get("role") == "user"
                        for item in provider_output[:-1]))
            for item in provider_output:
                if isinstance(item, dict) and item.get("type") == "compaction":
                    hints.append(hint if valid_envelope else 0)

        estimated: list[dict] = []
        compaction_tokens = 0
        hint_index = 0
        for item in items:
            if isinstance(item, dict) and item.get("type") == "compaction":
                hint = hints[hint_index] if hint_index < len(hints) else 0
                hint_index += 1
                if hint:
                    item = copy.deepcopy(item)
                    item["encrypted_content"] = ""
                    compaction_tokens += hint
            estimated.append(item)
        return instructions, estimated, compaction_tokens

    def compact_responses(self, messages: list[dict], *, cancel=None,
                          deadline: float | None = None) -> tuple[list[dict], dict] | None:
        """Loss-aware native compaction for a group-aligned Responses transcript prefix.

        The returned items are opaque continuation state. They are shape/size checked but never
        interpreted or rewritten. Unsupported, transient, malformed, cancelled, or late responses
        return ``None`` so the Agent can use its deterministic local compaction path instead.
        """
        if (self.api_mode != "responses"
                or not self._feature_supported("response_compaction")
                or not messages or (cancel is not None and cancel.is_set())):
            return None
        now = time.monotonic()
        if deadline is not None and deadline <= now:
            return None
        instructions, items = self._responses_input(messages)
        if not items:
            return None
        payload: dict = {"model": self.model, "input": items}
        if instructions:
            payload["instructions"] = instructions
        if self.prompt_cache and self._feature_supported("prompt_cache_key"):
            payload["prompt_cache_key"] = self._effective_prompt_cache_key(instructions)
        remaining = self.read_timeout
        if deadline is not None:
            remaining = max(1, min(remaining, int(max(1.0, deadline - now))))
        response = None
        accepted = False    # the endpoint answered 200: a request that costs tokens either way
        stop_watch = threading.Event()
        try:
            response = requests.post(
                f"{self.base_url}/responses/compact", headers=self._headers(), json=payload,
                stream=True, timeout=(min(15, remaining), remaining))
            if cancel is not None:
                def _watch(resp=response, ev=stop_watch, cx=cancel) -> None:
                    while not ev.wait(0.15):
                        if getattr(resp, "_dgc_closed", False):
                            return
                        if cx.is_set():
                            sock = _raw_socket(resp)
                            if sock is not None:
                                try:
                                    import socket as _socket
                                    sock.shutdown(_socket.SHUT_RDWR)
                                except Exception:
                                    pass
                            _close_response(resp)
                            return
                threading.Thread(target=_watch, daemon=True).start()
            if response.status_code != 200:
                status = response.status_code
                _error_body(response, 400)
                response = None  # _error_body owns and closes it
                if status in (400, 404, 405, 422):
                    self._mark_rejected("response_compaction")
                return None
            accepted = True
            value = _bounded_json_response(
                response, _MAX_RESPONSES_COMPACTION_BYTES, "Responses compaction",
                deadline=deadline)
            response = None  # bounded decoder owns and closes it
        except (LLMError, requests.RequestException, ValueError, TypeError):
            if accepted:     # answered, then broke: an unmetered request, not a missing one
                self._report_usage(ChatResult(finish_reason="compaction"))
            return None
        finally:
            stop_watch.set()
            if response is not None:
                _close_response(response)
        self._report_usage(ChatResult(
            finish_reason="compaction",
            usage=(value.get("usage") if isinstance(value, dict)
                   and isinstance(value.get("usage"), dict) else {})))
        if cancel is not None and cancel.is_set():
            return None
        if (deadline is not None and time.monotonic() >= deadline) or not isinstance(value, dict):
            return None
        output = value.get("output")
        if (value.get("object") != "response.compaction" or not isinstance(output, list)
                or not 1 <= len(output) <= _MAX_RESPONSES_COMPACTION_ITEMS
                or not all(isinstance(item, dict) for item in output)):
            return None
        try:
            compacted = copy.deepcopy(output)
        except Exception:
            return None
        # The documented response is zero or more retained user messages followed by exactly one
        # opaque compaction item. Validate only that public envelope and never interpret the blob.
        opaque = compacted[-1]
        if (opaque.get("type") != "compaction"
                or not isinstance(opaque.get("encrypted_content"), str)
                or not opaque["encrypted_content"]
                or any(item.get("type") != "message" or item.get("role") != "user"
                       for item in compacted[:-1])):
            return None
        self._reset_response_state()
        return compacted, (value.get("usage") if isinstance(value.get("usage"), dict) else {})

    @staticmethod
    def _responses_tools(tools: list[dict] | None) -> list[dict]:
        converted = []
        for tool in tools or []:
            fn = tool.get("function") or {}
            if fn.get("name"):
                converted.append({"type": "function", "name": fn["name"],
                                  "description": fn.get("description", ""),
                                  "parameters": fn.get("parameters") or {"type": "object"}})
        return converted

    @staticmethod
    def _messages_hash(messages: list[dict]) -> str:
        encoded = json.dumps(messages, sort_keys=True, separators=(",", ":"), default=str).encode()
        return hashlib.sha256(encoded).hexdigest()

    def _continued_responses_input(self, messages: list[dict]) -> tuple[bool, list[dict]]:
        """Return only items added after the stored response, or invalidate stale state.

        DGC stores the response itself in its Chat-style transcript. The Responses service already
        owns that assistant item, so continuation skips the first assistant message and sends only
        later user input or function outputs.
        """
        if not self._response_id or self._response_cursor > len(messages):
            return False, []
        if self._messages_hash(messages[:self._response_cursor]) != self._response_prefix_hash:
            self._reset_response_state()
            return False, []
        tail = messages[self._response_cursor:]
        if tail and tail[0].get("role") == "assistant":
            tail = tail[1:]
        _, items = self._responses_input(tail)
        return True, items

    def _effective_prompt_cache_key(self, instructions: str) -> str:
        if self.prompt_cache_key:
            raw = self.prompt_cache_key
            if len(raw) <= 64:
                return raw
            return "dgc-" + hashlib.sha256(raw.encode()).hexdigest()[:60]
        material = f"{self.model}\0{instructions}".encode()
        return "dgc-" + hashlib.sha256(material).hexdigest()[:48]

    def _responses_payload(self, messages, tools, reasoning_effort,
                           disabled: set[str]) -> tuple[dict, bool]:
        instructions, full_input = self._responses_input(messages)
        stateful = ("stateful_responses" not in disabled and self.provider_state == "server"
                    and self._feature_supported("stateful_responses"))
        continued, input_items = (self._continued_responses_input(messages)
                                  if stateful else (False, []))
        if not continued:
            input_items = full_input
        payload: dict = {"model": self.model, "input": input_items, "stream": True,
                         "store": bool(stateful)}
        if stateful and continued:
            payload["previous_response_id"] = self._response_id
        elif not stateful:
            self._reset_response_state()
        # Instructions are deliberately repeated: previous_response_id does not carry them forward.
        if instructions:
            payload["instructions"] = instructions
        converted_tools = self._responses_tools(
            tools if "tools" not in disabled and self.tools_supported else None)
        if converted_tools:
            payload["tools"] = converted_tools
            payload["tool_choice"] = "auto"
            if self._feature_supported("parallel_tools"):
                payload["parallel_tool_calls"] = True
        if ("reasoning" not in disabled and self.reasoning_supported
                and _openai_reasoning_model(self.model)):
            level = "low" if reasoning_effort in _REASONING_OFF else reasoning_effort
            payload["reasoning"] = {"effort": level, "summary": "auto"}
        if (self.max_tokens and "max_output_tokens" not in disabled
                and self._feature_supported("max_output_tokens")):
            payload["max_output_tokens"] = self.max_tokens
        if "sampling" not in disabled and self._feature_supported("sampling"):
            for key in ("temperature", "top_p"):
                if key in self.sampling:
                    payload[key] = self.sampling[key]
        if (self.prompt_cache and "prompt_cache_key" not in disabled
                and self._feature_supported("prompt_cache_key")):
            payload["prompt_cache_key"] = self._effective_prompt_cache_key(instructions)
        if (not stateful and "encrypted_reasoning" not in disabled
                and _openai_reasoning_model(self.model)
                and self._feature_supported("encrypted_reasoning")):
            payload["include"] = ["reasoning.encrypted_content"]
        return payload, stateful

    def _chat_responses(self, messages, tools, reasoning_effort, on_text, on_thinking,
                        cancel) -> ChatResult:
        if _image_parts_in(messages) and not self.vision_supported:
            messages = self._without_images(messages)      # images: known text-only, skip the try
        transient = 0
        last_cause = None
        disabled: set[str] = set()
        stalls = 0
        rounds = 0
        while rounds < 10:
            rounds += 1
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            payload, stateful = self._responses_payload(messages, tools, reasoning_effort, disabled)
            watch = self._next_watch(cancel, f"{self.base_url}/responses")
            try:
                with watch.registered():
                    response = requests.post(f"{self.base_url}/responses", headers=self._headers(),
                                             json=payload, stream=True,
                                             timeout=self._post_timeout(watch))
            except requests.ConnectionError as e:
                watch.stop()        # this attempt is over; a backoff must not raise notices
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                if watch.stall is not None:
                    stalls += 1
                    rounds -= 1
                    if not self._retry_stall(watch.stall, stalls, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                transient += 1
                last_cause = self._transport_cause(e, f"{self.base_url}/responses")
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, 0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise self._connect_error(last_cause, e, transient) from e
            except requests.Timeout:
                watch.stop()
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                stalls += 1
                rounds -= 1
                if not self._retry_stall(watch.stall_from_timeout(), stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            watch.attach_response(response)
            if response.status_code != 200:
                watch.disarm()
            if response.status_code == 404:
                self._mark_rejected("responses")
                self._reset_response_state()
                if self.requested_api_mode == "auto":
                    # Defensive compatibility for proxies in front of OpenAI-style URLs.
                    _close_response(response)
                    self.api_mode = "chat_completions"
                    return self._chat_completions(messages, tools, reasoning_effort,
                                                  on_text, on_thinking, cancel)
            if response.status_code == 429 or response.status_code >= 500:
                status = response.status_code
                headers = response.headers
                body = scrub_urls(_error_body(response, 400))
                if status >= 500 and _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    messages = self._without_images(messages, refused=True)   # images: a refusal
                    continue
                transient += 1
                delay = _retry_delay(headers, 0.5 * transient)
                last_cause = self._status_cause(status, body, headers, f"{self.base_url}/responses",
                                                delay)
                if transient < 4:
                    if not self._retry_transport(last_cause, transient, delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise _with_cause(LLMError(
                    f"HTTP {status} from Responses API after {transient} tries: {body}"),
                    last_cause, transient)
            if response.status_code in (400, 413):
                body = _error_body(response)
                low = body.lower()
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
                if _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    # images: the endpoint refused the image part, not tools. Retry once without it.
                    messages = self._without_images(messages, refused=True)
                    continue
                if ("parallel_tool_calls" in payload and re.search(r"parallel", low)):
                    self._mark_rejected("parallel_tools")
                    disabled.add("parallel_tools")
                    continue
                if "tools" in payload and re.search(r"tool|function", low):
                    self._mark_rejected("tools")
                    raise ToolsUnsupportedError("endpoint rejected native tool calling")
                if "reasoning" in payload and re.search(r"reason|effort|summary", low):
                    self._mark_rejected("reasoning")
                    disabled.add("reasoning")
                    continue
                if "max_output_tokens" in payload and re.search(r"max.{0,12}(?:output|token)", low):
                    self._mark_rejected("max_output_tokens")
                    disabled.add("max_output_tokens")
                    continue
                if (any(key in payload for key in ("temperature", "top_p"))
                        and re.search(r"temperature|top_p|sampl|unsupported|unrecognized", low)):
                    self._mark_rejected("sampling")
                    disabled.add("sampling")
                    continue
                if ("prompt_cache_key" in payload
                        and re.search(r"prompt.{0,8}cache|cache.{0,8}key", low)):
                    self._mark_rejected("prompt_cache_key")
                    disabled.add("prompt_cache_key")
                    continue
                if ("include" in payload
                        and re.search(r"encrypted.{0,12}reason|reasoning.{0,12}encrypted|\binclude\b", low)):
                    self._mark_rejected("encrypted_reasoning")
                    disabled.add("encrypted_reasoning")
                    continue
                if (stateful and re.search(r"previous_response|previous response|\bstore\b|stored response", low)):
                    self._mark_rejected("stateful_responses")
                    disabled.add("stateful_responses")
                    self._reset_response_state()
                    continue
                raise self._answer_error(f"{response.status_code} from Responses API: {scrub_urls(body)}",
                                         response.status_code, body, f"{self.base_url}/responses",
                                         transient + 1)
            if response.status_code != 200:
                status = response.status_code
                body = scrub_urls(_error_body(response, 400))
                if status == 422 and _image_parts_in(messages) and _IMAGE_REFUSAL_RE.search(body):
                    messages = self._without_images(messages, refused=True)   # images: a refusal
                    continue
                raise self._answer_error(f"HTTP {status} from Responses API: {body}",
                                         status, body, f"{self.base_url}/responses", transient + 1)
            self._usage_opened()
            self._next_reasoning_attempt()
            try:
                result = self._consume_responses(response, on_text, on_thinking, cancel,
                                                 watch=watch)
            finally:
                _close_response(response)
                watch.stop()
            stall = self._pre_progress_stall(result)
            if stall is not None:
                self._reset_response_state()
                stalls += 1
                rounds -= 1
                if not self._retry_stall(stall, stalls, cancel):
                    return ChatResult(finish_reason="cancelled")
                continue
            if (stateful and result.response_id
                    and result.finish_reason in ("stop", "tool_calls")):
                self._response_id = result.response_id
                self._response_cursor = len(messages)
                self._response_prefix_hash = self._messages_hash(messages)
            else:
                self._reset_response_state()
            return result
        raise _with_cause(LLMError("Responses API request failed repeatedly"), last_cause, transient)

    def _consume_responses(self, response: requests.Response, on_text, on_thinking,
                           cancel=None, watch: RequestWatch | None = None) -> ChatResult:
        on_thinking = _reasoning.origin_callback(on_thinking)
        if "application/json" in response.headers.get("Content-Type", ""):
            self._note_non_streaming(response)
            value, finish = _bounded_json_lifecycle(
                response, _MAX_RESPONSES_JSON_BYTES, "Responses API response", cancel,
                watch=watch)
            if finish:
                return ChatResult(finish_reason=finish, stall=_stall_of(watch, finish),
                                  interruption=_interruption_of(watch, finish, "responses"))
            return self._consume_responses_json(value, on_text, on_thinking)
        result = ChatResult()
        calls: dict[str, dict] = {}
        thinking_parts = _ThinkingParts()
        reasoning_started: dict[str, float] = {}   # reasoning item -> output_item.added stamp
        reasoning_texted: set[str] = set()          # reasoning items that streamed readable text
        reasoning_last_part: dict[str, str] = {}    # reasoning item -> its last streamed part

        def reasoning_item(event: dict, item: dict | None = None) -> str:
            identifier = (item or {}).get("id") if item is not None else event.get("item_id")
            if identifier:
                return str(identifier)[:200]
            return f"#{event.get('output_index')}"

        def think(channel: str, item_key: str, local: str, chunk: str) -> None:
            thinking_parts.add(result, local, chunk)
            reasoning_texted.add(item_key)
            reasoning_last_part[item_key] = local
            if on_thinking:
                on_thinking(chunk, self._reasoning_origin(
                    channel, local, api_mode="responses", t_start=reasoning_started.get(item_key)))

        # `response.output_item.done` may arrive in a different completion order from its declared
        # output position. Preserve both coordinates so stateless replay follows `response.output`,
        # never network timing. The terminal response's complete output array remains authoritative
        # when the provider includes it.
        provider_items: dict[str, tuple[int | None, int, dict]] = {}
        provider_item_arrival = 0
        terminal = ""
        terminal_output: list[dict] | None = None
        incomplete_reason = ""
        watch, owned_watch = _own_watch(response, cancel, watch)
        response.encoding = "utf-8"
        try:
            for line in _bounded_stream_lines(
                    response, _MAX_RESPONSES_STREAM_BYTES, "Responses API stream"):
                if cancel is not None and cancel.is_set():
                    if not terminal:
                        result.finish_reason = "cancelled"
                    break
                if not line or not line.startswith("data:"):
                    if line.startswith(":") and watch is not None:
                        watch.noise()           # an SSE comment keep-alive
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except (json.JSONDecodeError, RecursionError) as exc:
                    raise LLMError("Responses API emitted malformed streaming JSON") from exc
                if not isinstance(event, dict):
                    raise LLMError("Responses API emitted a non-object streaming event")
                typ = str(event.get("type") or "")
                if watch is not None:
                    if (typ == "response.output_text.delta" or typ.startswith("response.reasoning")
                            or ("reasoning" in typ and typ.endswith(".delta"))
                            or typ == "response.function_call_arguments.delta"
                            or typ in ("response.output_item.added", "response.output_item.done",
                                       "response.completed", "response.incomplete")):
                        watch.progress()
                    else:
                        watch.noise()           # response.created / in_progress and the like
                if terminal:
                    raise LLMError("Responses API emitted data after its terminal response event")
                if typ == "response.output_text.delta":
                    delta = str(event.get("delta") or "")
                    result.content += delta
                    if on_text and delta: on_text(delta)
                elif typ == "response.reasoning_summary_text.delta":
                    delta = str(event.get("delta") or "")
                    key = reasoning_item(event)
                    if delta:
                        think("responses.summary", key,
                              f"rs:{key}:{event.get('summary_index', 0)}", delta)
                elif typ == "response.reasoning_text.delta":
                    delta = str(event.get("delta") or "")
                    key = reasoning_item(event)
                    if delta:
                        think("responses.reasoning_text", key,
                              f"rt:{key}:{event.get('content_index', 0)}", delta)
                elif "reasoning" in typ and typ.endswith(".delta"):
                    # A reasoning-looking event this parser does not know proves nothing.
                    delta = str(event.get("delta") or "")
                    key = reasoning_item(event)
                    if delta:
                        think("responses.other", key, f"ro:{typ[:80]}:{key}", delta)
                elif typ in ("response.reasoning_summary_part.done", "response.reasoning_text.done"):
                    key = reasoning_item(event)
                    local = (f"rs:{key}:{event.get('summary_index', 0)}"
                             if typ == "response.reasoning_summary_part.done"
                             else f"rt:{key}:{event.get('content_index', 0)}")
                    if on_thinking and reasoning_last_part.get(key) == local:
                        channel = ("responses.summary" if local.startswith("rs:")
                                   else "responses.reasoning_text")
                        on_thinking("", self._reasoning_origin(
                            channel, local, api_mode="responses", event="stop"))
                elif typ in ("response.output_item.added", "response.output_item.done"):
                    item = event.get("item") or {}
                    if not isinstance(item, dict):
                        raise LLMError("Responses API emitted a malformed output item")
                    if item.get("type") == "reasoning":
                        key = reasoning_item(event, item)
                        if typ == "response.output_item.added":
                            reasoning_started.setdefault(key, _reasoning.now())
                        elif on_thinking and key in reasoning_texted:
                            local = reasoning_last_part.get(key, "")
                            channel = ("responses.summary" if local.startswith("rs:") else
                                       "responses.reasoning_text" if local.startswith("rt:")
                                       else "responses.other")
                            on_thinking("", self._reasoning_origin(
                                channel, local, api_mode="responses", event="stop"))
                        elif on_thinking and not _responses_reasoning_has_text(item):
                            on_thinking("", self._reasoning_origin(
                                "responses.no_text", f"rw:{key}", api_mode="responses",
                                event="withheld", t_start=reasoning_started.get(key)))
                    if typ == "response.output_item.done" and item:
                        output_index = _tool_call_index(event.get("output_index"))
                        key = (f"index:{output_index}" if output_index is not None else
                               "id:" + _wire_key(item.get("id"), None, provider_item_arrival))
                        completed_item = dict(item)
                        previous = provider_items.get(key)
                        if previous is not None and previous[2] != completed_item:
                            raise LLMError("Responses API reused an output position for another item")
                        if previous is None:
                            if len(provider_items) >= _MAX_RESPONSES_OUTPUT_ITEMS:
                                raise LLMError("Responses API emitted too many output items")
                            provider_items[key] = (
                                output_index, provider_item_arrival, completed_item)
                            provider_item_arrival += 1
                    if item.get("type") == "function_call":
                        key = _wire_key(item.get("id"), event.get("output_index"), len(calls))
                        slot = calls.setdefault(key, {})
                        if len(calls) > _MAX_RESPONSES_OUTPUT_ITEMS:
                            raise LLMError("Responses API emitted too many function calls")
                        output_index = _tool_call_index(event.get("output_index"))
                        if output_index is not None:
                            slot["_output_index"] = output_index
                        slot.update({k: item[k] for k in ("call_id", "name") if item.get(k)})
                        if item.get("arguments") is not None:
                            raw_arguments = item.get("arguments")
                            # `added` commonly carries an empty prefix before delta events; treating
                            # that as the complete string "{}" corrupts every following fragment.
                            # `done`, by contrast, is authoritative and may legitimately be empty.
                            slot["arguments"] = ((raw_arguments if raw_arguments != "" else "{}")
                                                 if typ == "response.output_item.done"
                                                 else raw_arguments)
                        if typ == "response.output_item.done":
                            slot["_done"] = True
                            slot["_status"] = item.get("status")
                elif typ == "response.function_call_arguments.delta":
                    key = _wire_key(event.get("item_id"), event.get("output_index"), 0)
                    slot = calls.setdefault(key, {})
                    if len(calls) > _MAX_RESPONSES_OUTPUT_ITEMS:
                        raise LLMError("Responses API emitted too many function calls")
                    output_index = _tool_call_index(event.get("output_index"))
                    if output_index is not None:
                        slot["_output_index"] = output_index
                    slot["arguments"] = _merge_stream_arguments(
                        slot.get("arguments", ""), event.get("delta"))
                elif typ in ("response.completed", "response.incomplete"):
                    obj = event.get("response") or {}
                    if not isinstance(obj, dict):
                        raise LLMError("Responses API emitted a malformed terminal response")
                    terminal = "completed" if typ == "response.completed" else "incomplete"
                    reported_status = str(obj.get("status") or "")
                    if reported_status and reported_status != terminal:
                        raise LLMError("Responses API terminal event contradicted its response status")
                    result.response_id = str(obj.get("id") or "")
                    result.usage = obj.get("usage") or {}
                    if "output" in obj:
                        raw_output = obj.get("output")
                        if (not isinstance(raw_output, list)
                                or len(raw_output) > _MAX_RESPONSES_OUTPUT_ITEMS
                                or not all(isinstance(item, dict) for item in raw_output)):
                            raise LLMError("Responses API emitted a malformed terminal output array")
                        terminal_output = [dict(item) for item in raw_output]
                    if typ == "response.incomplete":
                        details = obj.get("incomplete_details") or {}
                        incomplete_reason = (str(details.get("reason") or "")
                                             if isinstance(details, dict) else "")
                elif typ in ("error", "response.failed"):
                    err = event.get("error") or (event.get("response") or {}).get("error") or {}
                    raise LLMError(str(err.get("message") or err or "Responses API stream failed"))
        except Exception as exc:
            if cancel is not None and cancel.is_set() and not terminal:
                result.finish_reason = "cancelled"
            elif _is_transport_interruption(exc):
                if watch is not None:
                    watch.observe_error(exc)
                if not terminal:
                    incomplete_reason = "stream_interrupted"
            else:
                raise
        finally:
            if owned_watch is not None:
                owned_watch.stop()
        if not terminal and cancel is not None and cancel.is_set():
            # requests may turn the watcher's socket shutdown into ordinary iterator exhaustion.
            result.finish_reason = "cancelled"
        if result.finish_reason == "cancelled":
            return result
        if not terminal:
            # Clean EOF is recoverable but never replayable provider state. Normalize it through
            # the same non-executable path as an explicit token-incomplete response.
            terminal = "incomplete"
            incomplete_reason = "stream_interrupted"

        completed_items = (terminal_output if terminal_output is not None else [
            row[2] for row in sorted(
                provider_items.values(),
                key=lambda row: (row[0] is None, row[0] if row[0] is not None else 0, row[1]))
        ])
        if terminal_output is not None:
            # The terminal response contains the authoritative, already ordered output array.
            calls = {}
            for output_index, item in enumerate(terminal_output):
                if item.get("type") != "function_call":
                    continue
                key = _wire_key(item.get("id"), output_index, len(calls))
                calls[key] = {
                    "call_id": item.get("call_id"), "name": item.get("name"),
                    "arguments": item.get("arguments"), "_output_index": output_index,
                    "_done": True, "_status": item.get("status"),
                }
        ordered_calls = sorted(
            calls.values(),
            key=lambda slot: (slot.get("_output_index") is None, slot.get("_output_index", 0)))
        if terminal == "completed":
            def _invalid_completed_call(slot: dict) -> bool:
                if (not isinstance(slot.get("call_id"), str) or not slot.get("call_id")
                        or not isinstance(slot.get("name"), str) or not slot.get("name")):
                    return True
                if slot.get("_done"):
                    return (slot.get("_status") not in (None, "completed")
                            or not isinstance(slot.get("arguments"), str)
                            or set(_tool_arguments(slot.get("arguments"))) == {"_unparsed"})
                # A few Responses-compatible gateways omit output_item.done but still send an
                # explicit response.completed event. Retain that compatibility only when the final
                # cumulative/object arguments form is a complete JSON object. An unterminated or
                # otherwise unparseable call remains non-executable.
                parsed = _tool_arguments(slot.get("arguments"))
                return set(parsed) == {"_unparsed"}

            invalid_call = any(_invalid_completed_call(slot) for slot in ordered_calls)
            if invalid_call:
                raise LLMError("Responses API completed with an unfinished function-call item")
        for slot in ordered_calls:
            name = str(slot.get("name") or "")
            if not name:
                # Nonterminal state is never replayed, and a nameless partial call cannot form a
                # valid assistant/tool group for the fresh bounded continuation request.
                continue
            result.tool_calls.append(ToolCall(
                id=str(slot.get("call_id") or f"call_{len(result.tool_calls)}"),
                name=name, arguments=_tool_arguments(slot.get("arguments"))))
        # Incomplete provider state must never be replayed as though it were a completed response.
        # The Agent's existing length path records non-executable tool errors and requests one clean
        # re-issue; stateful continuation is reset by the caller.
        result.provider_items = completed_items if terminal == "completed" else []
        if terminal == "incomplete":
            result.finish_reason = (
                "incomplete" if incomplete_reason == "stream_interrupted" else
                "length" if result.tool_calls or "token" in incomplete_reason else
                "max_turn_requests")
            if incomplete_reason == "stream_interrupted":
                result.stall = _stall_of(watch, result.finish_reason)
                result.interruption = _interruption_of(watch, result.finish_reason, "responses")
        if result.tool_calls and result.finish_reason == "stop":
            result.finish_reason = "tool_calls"
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        return result

    def _consume_responses_json(self, obj: dict, on_text, on_thinking) -> ChatResult:
        on_thinking = _reasoning.origin_callback(on_thinking)
        if not isinstance(obj, dict):
            raise LLMError("Responses API emitted a non-object JSON response")
        status = str(obj.get("status") or "")
        if status not in ("completed", "incomplete"):
            raise LLMError(f"Responses API returned non-terminal status: {status or 'missing'}")
        raw_output = obj.get("output")
        if raw_output is None:
            raw_output = []
        if (not isinstance(raw_output, list)
                or len(raw_output) > _MAX_RESPONSES_OUTPUT_ITEMS
                or not all(isinstance(item, dict) for item in raw_output)):
            raise LLMError("Responses API emitted a malformed output array")
        output = [dict(item) for item in raw_output]
        result = ChatResult(response_id=str(obj.get("id") or ""), usage=obj.get("usage") or {},
                            provider_items=(output if status == "completed" else []))
        if status == "incomplete":
            details = obj.get("incomplete_details") or {}
            if not isinstance(details, dict):
                raise LLMError("Responses API emitted malformed incomplete details")
            reason = str(details.get("reason") or "")
            result.finish_reason = "length" if "token" in reason else "max_turn_requests"
        for item in output:
            if item.get("type") == "message":
                for content in item.get("content") or []:
                    if content.get("type") in ("output_text", "text"):
                        text = str(content.get("text") or "")
                        result.content += text
                        if on_text and text: on_text(text)
            elif item.get("type") == "reasoning":
                key = str(item.get("id") or f"#{next(i for i, x in enumerate(output) if x is item)}")[:200]
                streamed = False
                parts = [("responses.summary", f"rs:{key}:{index}", part)
                         for index, part in enumerate(item.get("summary") or [])]
                parts += [("responses.reasoning_text", f"rt:{key}:{index}", part)
                          for index, part in enumerate(item.get("content") or [])
                          if isinstance(part, dict) and part.get("type") == "reasoning_text"]
                for channel, local, part in parts:
                    text = str(part.get("text") or "") if isinstance(part, dict) else ""
                    if not text:
                        continue
                    streamed = True
                    if result.thinking:
                        result.thinking += "\n\n"
                    result.thinking += text
                    if on_thinking:
                        on_thinking(text, self._reasoning_origin(channel, local, api_mode="responses"))
                        on_thinking("", self._reasoning_origin(
                            channel, local, api_mode="responses", event="stop"))
                if not streamed and on_thinking:
                    on_thinking("", self._reasoning_origin(
                        "responses.no_text", f"rw:{key}", api_mode="responses", event="withheld"))
            elif item.get("type") == "function_call":
                if (status == "completed"
                        and (item.get("status") not in (None, "completed")
                             or not isinstance(item.get("call_id"), str)
                             or not item.get("call_id")
                             or not isinstance(item.get("name"), str) or not item.get("name")
                             or not isinstance(item.get("arguments"), str)
                             or set(_tool_arguments(item.get("arguments"))) == {"_unparsed"})):
                    raise LLMError("Responses API completed with an unfinished function-call item")
                result.tool_calls.append(ToolCall(id=str(item.get("call_id") or item.get("id") or "call_0"),
                                                  name=str(item.get("name") or ""),
                                                  arguments=_tool_arguments(item.get("arguments"))))
        if status == "incomplete" and result.tool_calls:
            result.finish_reason = "length"
        if result.tool_calls and result.finish_reason == "stop":
            result.finish_reason = "tool_calls"
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        return result

    def _consume(self, r: requests.Response, on_text, on_thinking, cancel=None,
                 think_budget: int = 0, watch: RequestWatch | None = None) -> ChatResult:
        on_thinking = _reasoning.origin_callback(on_thinking)
        ctype = r.headers.get("Content-Type", "")
        if "application/json" in ctype and "text/event-stream" not in ctype:
            self._note_non_streaming(r)
            return self._consume_json(
                r, on_text, on_thinking, cancel=cancel, watch=watch)   # server ignored stream:true
        result = ChatResult()
        filt = _ThinkFilter()
        thinking_parts = _ThinkingParts()

        def think(channel: str, local: str, chunk: str) -> None:
            thinking_parts.add(result, local, chunk)
            if on_thinking:
                on_thinking(chunk, self._reasoning_origin(channel, local, api_mode="chat_completions"))

        produced = False               # F4: has any content/tool-call appeared yet? (disarms the watchdog)
        partial: dict[int, dict] = {}  # index -> accumulated native tool call
        noidx = -1                     # fallback slot cursor when a server omits tool_call 'index'
        idmap: dict[str, int] = {}     # tool-call id -> slot, so repeated ids don't split a call
        last_idx: int | None = None    # best-effort continuation when a gateway omits both id + index

        def emit(events):
            nonlocal produced
            for kind, chunk in events:
                if not chunk:
                    continue
                if kind == "think":
                    think("tags", "tags", chunk)
                else:
                    result.content += chunk
                    # Raw ``content`` may still be a tagged reasoning stream. Seeing an opening
                    # tag is not progress; only normal-channel text is visible to the user.
                    produced = True
                    if on_text:
                        on_text(chunk)

        # A stalled read -- the model still prefilling a huge resumed context, with no first token
        # yet -- never runs the in-loop cancel check, because the loop body doesn't execute until a
        # line arrives. The request watch shuts the socket down from its own thread, so Esc / Stop
        # (or a stall deadline) takes effect immediately instead of hanging on "responding…".
        watch, owned_watch = _own_watch(r, cancel, watch)
        # SSE streams are UTF-8, but requests defaults to latin-1 when the Content-Type carries no
        # charset — which mangles every multibyte char (→ becomes "â\x86\x92", ° becomes "Â°"). Pin it.
        r.encoding = "utf-8"
        saw_done = False
        saw_finish = False
        try:
            for line in _bounded_stream_lines(
                    r, _MAX_CHAT_STREAM_BYTES, "Chat Completions stream"):
                if cancel is not None and cancel.is_set():
                    if not (saw_done or saw_finish):
                        result.finish_reason = "cancelled"
                    break
                if not line or not line.startswith("data:"):
                    if line.startswith(":") and watch is not None:
                        watch.noise()           # an SSE comment keep-alive carries no tokens
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    if watch is not None:
                        watch.progress()
                    saw_done = True
                    break
                try:
                    obj = json.loads(data)
                except (ValueError, RecursionError) as exc:
                    raise LLMError(
                        "Chat Completions emitted malformed streaming JSON") from exc
                if not isinstance(obj, dict):
                    raise LLMError("Chat Completions emitted a non-object streaming event")
                if obj.get("error"):
                    error = obj.get("error")
                    message = error.get("message") if isinstance(error, dict) else error
                    raise LLMError(str(message or "Chat Completions stream failed"))
                if obj.get("usage") is not None:
                    if not isinstance(obj.get("usage"), dict):
                        raise LLMError("Chat Completions emitted malformed usage")
                    if usage_reported(obj["usage"]):
                        result.usage = normalize_usage(obj["usage"])
                choices = obj.get("choices")
                if choices is None and isinstance(obj.get("usage"), dict):
                    choices = []        # a usage-only chunk from a gateway that omits the array
                if not isinstance(choices, list):
                    raise LLMError("Chat Completions emitted a malformed choices array")
                # OpenAI documents an empty final choices array when include_usage is enabled.
                if not choices:
                    if watch is not None:
                        watch.noise()
                    continue
                if saw_finish:
                    raise LLMError(
                        "Chat Completions emitted choice data after its finish reason")
                if not isinstance(choices[0], dict):
                    raise LLMError("Chat Completions emitted a malformed choice")
                choice = choices[0]
                if watch is not None:
                    # Before any callback: a "cleared" notice must precede the text it announces.
                    peek = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                    if (choice.get("finish_reason") not in (None, "") or peek.get("content")
                            or peek.get("reasoning") or peek.get("reasoning_content")
                            or peek.get("tool_calls") or peek.get("function_call")):
                        watch.progress()
                    else:
                        watch.noise()           # role-only or empty delta
                finish_reason = choice.get("finish_reason")
                if finish_reason not in (None, ""):
                    if not isinstance(finish_reason, str):
                        raise LLMError("Chat Completions emitted an invalid finish reason")
                    result.finish_reason = finish_reason
                    saw_finish = True
                delta = choice.get("delta")
                if delta is None:
                    delta = {}
                elif not isinstance(delta, dict):
                    raise LLMError("Chat Completions emitted a malformed delta")
                # reasoning is streamed in a separate field: Ollama-compatible gateways use
                # `reasoning`; others commonly use `reasoning_content`.
                reasoning_field = "reasoning" if delta.get("reasoning") else "reasoning_content"
                reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                if reasoning is not None and not isinstance(reasoning, str):
                    raise LLMError("Chat Completions emitted malformed reasoning text")
                if reasoning:
                    think(f"chat.{reasoning_field}", reasoning_field, reasoning)
                content = delta.get("content")
                if content is not None and not isinstance(content, str):
                    raise LLMError("Chat Completions emitted malformed content text")
                if content:
                    emit(filt.feed(content))
                raw_calls = delta.get("tool_calls")
                if raw_calls is None:
                    raw_calls = []
                if not isinstance(raw_calls, list):
                    raise LLMError("Chat Completions emitted malformed tool calls")
                legacy_call = delta.get("function_call")
                if legacy_call is not None:
                    if raw_calls or not isinstance(legacy_call, dict):
                        raise LLMError("Chat Completions emitted a malformed legacy function call")
                    # Older compatible gateways still use the deprecated single-call field.
                    raw_calls = [{"index": 0, "function": legacy_call}]
                for tc in raw_calls:
                    produced = True
                    if not isinstance(tc, dict):
                        raise LLMError("Chat Completions emitted a malformed tool call")
                    tcid = str(tc.get("id") or "")
                    idx = _tool_call_index(tc.get("index"))
                    if idx is None and tcid and tcid in idmap:
                        idx = idmap[tcid]
                    elif idx is None and tcid:
                        noidx += 1
                        while noidx in partial:
                            noidx += 1
                        idx = noidx
                    elif idx is None and last_idx is not None:
                        idx = last_idx
                    elif idx is None:
                        noidx += 1
                        while noidx in partial:
                            noidx += 1
                        idx = noidx
                    if idx not in partial and len(partial) >= _MAX_CHAT_TOOL_CALLS:
                        raise LLMError("Chat Completions emitted too many tool calls")
                    if tcid:
                        idmap[tcid] = idx
                    last_idx = idx
                    slot = partial.setdefault(idx, {"id": "", "name": "", "args": ""})
                    if tcid:
                        slot["id"] = _merge_stream_token(slot["id"], tcid)
                    fn = tc.get("function") or {}
                    if not isinstance(fn, dict):
                        raise LLMError("Chat Completions emitted a malformed function call")
                    if fn.get("name") is not None and not isinstance(fn.get("name"), str):
                        raise LLMError("Chat Completions emitted a malformed function name")
                    if fn.get("name"):
                        slot["name"] = _merge_stream_token(slot["name"], fn["name"])
                    if fn.get("arguments") is not None:
                        slot["args"] = _merge_stream_arguments(slot["args"], fn["arguments"])

                if think_budget and not produced and len(result.thinking) > think_budget:
                    result.finish_reason = "overthink"     # F4: reasoning ran away before any output
                    try:
                        r.close()
                    except Exception:
                        pass
                    break
        except Exception as exc:
            # Socket errors caused by cancellation are terminal; other transport interruptions
            # retain only non-executable partial state for the Agent's bounded recovery path.
            if (cancel is not None and cancel.is_set()
                    and not (saw_done or saw_finish)):
                result.finish_reason = "cancelled"
            elif _is_transport_interruption(exc):
                if watch is not None:
                    watch.observe_error(exc)
                if not saw_finish:
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            if owned_watch is not None:
                owned_watch.stop()

        if (not saw_done and not saw_finish and cancel is not None and cancel.is_set()
                and result.finish_reason != "overthink"):
            # A watcher-triggered socket shutdown may surface as clean EOF rather than an
            # exception.  Cancellation still wins over the recoverable-incomplete EOF path,
            # matching the native Ollama lifecycle and discarding partial executable state.
            result.finish_reason = "cancelled"
        if result.finish_reason in ("cancelled", "overthink"):
            # Neither partial native calls nor text-shaped calls may survive an aborted generation.
            return result
        # `[DONE]` is the canonical SSE terminator. Some local compatible gateways close the stream
        # after a non-null finish_reason instead; retain that safe, explicit-terminal variant.
        if not saw_done and not saw_finish:
            # A clean EOF is recoverable, but never terminal: the Agent's bounded incomplete path
            # records non-executable call results or continues partial text on a fresh request.
            result.finish_reason = "incomplete"
            result.stall = _stall_of(watch, result.finish_reason)
            result.interruption = _interruption_of(watch, result.finish_reason, "chat_completions")
        emit(filt.flush())

        for idx in sorted(partial):
            slot = partial[idx]
            if not slot["name"]:
                if result.finish_reason in ("length", "incomplete"):
                    # A nameless unfinished call cannot form a valid assistant/tool transcript
                    # group. Drop it and continue any partial prose on a fresh request.
                    continue
                raise LLMError("Chat Completions completed with an unfinished tool call")
            result.tool_calls.append(ToolCall(
                id=slot["id"] or f"call_{idx}", name=slot["name"],
                arguments=_tool_arguments(slot["args"])))

        # fallback: model emitted tool calls as text despite native support
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content = clean
                result.tool_calls = text_calls
        if result.tool_calls:
            if result.finish_reason == "stop":
                result.finish_reason = "tool_calls"
            elif result.finish_reason not in (
                    "tool_calls", "function_call", "length", "incomplete"):
                # Content filtering or an unknown stop cannot attest that call arguments finished.
                result.finish_reason = "length"
        return result

    def _consume_json(self, r: requests.Response, on_text, on_thinking,
                      cancel=None, watch: RequestWatch | None = None) -> ChatResult:
        """A non-streaming server (ignored stream:true) returns one JSON completion — parse it
        through the same think-splitter / lenient-args / text-fallback path as the SSE stream."""
        on_thinking = _reasoning.origin_callback(on_thinking)
        try:
            obj, finish = _bounded_json_lifecycle(
                r, _MAX_CHAT_JSON_BYTES, "Chat Completions response", cancel, watch=watch)
        except Exception as exc:
            if isinstance(exc, (ValueError, RecursionError)) and not isinstance(exc, LLMError):
                raise LLMError("Chat Completions response returned malformed JSON") from exc
            raise
        if finish:
            return ChatResult(finish_reason=finish, stall=_stall_of(watch, finish),
                              interruption=_interruption_of(watch, finish, "chat_completions"))
        if not isinstance(obj, dict):
            raise LLMError("Chat Completions emitted a non-object JSON response")
        choices = obj.get("choices")
        if (not isinstance(choices, list) or not choices
                or not isinstance(choices[0], dict)):
            raise LLMError("Chat Completions emitted a malformed choices array")
        choice = choices[0]
        msg = choice.get("message")
        if msg is None:
            msg = {}
        elif not isinstance(msg, dict):
            raise LLMError("Chat Completions emitted a malformed assistant message")
        finish_reason = choice.get("finish_reason")
        if finish_reason not in (None, "") and not isinstance(finish_reason, str):
            raise LLMError("Chat Completions emitted an invalid finish reason")
        reasoning = msg.get("reasoning") or msg.get("reasoning_content")
        if reasoning is not None and not isinstance(reasoning, str):
            raise LLMError("Chat Completions emitted malformed reasoning text")
        content = msg.get("content")
        if content is not None and not isinstance(content, str):
            raise LLMError("Chat Completions emitted malformed content text")
        raw_calls = msg.get("tool_calls")
        if raw_calls is None:
            raw_calls = []
        if not isinstance(raw_calls, list) or len(raw_calls) > _MAX_CHAT_TOOL_CALLS:
            raise LLMError("Chat Completions emitted malformed or excessive tool calls")
        legacy_call = msg.get("function_call")
        if legacy_call is not None:
            if raw_calls or not isinstance(legacy_call, dict):
                raise LLMError("Chat Completions emitted a malformed legacy function call")
            raw_calls = [{"function": legacy_call}]
        result = ChatResult()
        usage = obj.get("usage")
        if usage is not None and not isinstance(usage, dict):
            raise LLMError("Chat Completions emitted malformed usage")
        result.usage = normalize_usage(usage) if usage_reported(usage) else {}
        # A whole, valid JSON body can still omit the required finish reason on a compatible
        # gateway. Preserve its partial display/calls only for bounded non-executable reissue.
        result.finish_reason = finish_reason or "incomplete"
        thinking_parts = _ThinkingParts()

        def think(channel: str, local: str, chunk: str) -> None:
            thinking_parts.add(result, local, chunk)
            if on_thinking:
                on_thinking(chunk, self._reasoning_origin(channel, local, api_mode="chat_completions"))

        if reasoning:
            field_name = "reasoning" if msg.get("reasoning") else "reasoning_content"
            think(f"chat.{field_name}", field_name, reasoning)
        filt = _ThinkFilter()
        for kind, chunk in filt.feed(content or "") + filt.flush():
            if kind == "think":
                think("tags", "tags", chunk)
            else:
                result.content += chunk
                if on_text:
                    on_text(chunk)
        for tc in raw_calls:
            if not isinstance(tc, dict):
                raise LLMError("Chat Completions emitted a malformed tool call")
            fn = tc.get("function") or {}
            if not isinstance(fn, dict):
                raise LLMError("Chat Completions emitted a malformed function call")
            name = fn.get("name")
            if not isinstance(name, str):
                raise LLMError("Chat Completions completed with an unfinished tool call")
            if not name:
                if result.finish_reason in ("length", "incomplete"):
                    continue
                raise LLMError("Chat Completions completed with an unfinished tool call")
            call_id = tc.get("id")
            if call_id is not None and not isinstance(call_id, str):
                raise LLMError("Chat Completions emitted a malformed tool-call ID")
            result.tool_calls.append(ToolCall(id=call_id or f"call_{len(result.tool_calls)}",
                                              name=name,
                                              arguments=_tool_arguments(fn.get("arguments"))))
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        if result.tool_calls:
            if result.finish_reason == "stop":
                result.finish_reason = "tool_calls"
            elif result.finish_reason not in (
                    "tool_calls", "function_call", "length", "incomplete"):
                result.finish_reason = "length"
        return result
