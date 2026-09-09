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


def _image_dimensions(data: bytes) -> tuple[int, int] | None:
    width = height = 0
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    elif len(data) >= 10 and data.startswith((b"GIF87a", b"GIF89a")):
        width, height = int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
    elif len(data) >= 26 and data.startswith(b"BM"):
        width = abs(int.from_bytes(data[18:22], "little", signed=True))
        height = abs(int.from_bytes(data[22:26], "little", signed=True))
    elif len(data) >= 30 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8X" and len(data) >= 30:
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
        elif data[12:16] == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            width, height = 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        elif data[12:16] == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
    elif len(data) >= 12 and data.startswith(b"\xff\xd8\xff"):
        offset = 2
        sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB,
               0xCD, 0xCE, 0xCF}
        while offset + 9 <= len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(data):
                break
            length = int.from_bytes(data[offset:offset + 2], "big")
            if length < 2 or offset + length > len(data):
                break
            if marker in sof and length >= 7:
                height = int.from_bytes(data[offset + 3:offset + 5], "big")
                width = int.from_bytes(data[offset + 5:offset + 7], "big")
                break
            offset += length
    if 0 < width <= 1_000_000 and 0 < height <= 1_000_000:
        return width, height
    return None


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


def _bounded_json_response(response, maximum: int, label: str,
                           *, deadline: float | None = None):
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


def _bounded_json_lifecycle(response, maximum: int, label: str, cancel=None):
    """Read one bounded JSON body and distinguish cancellation from transport interruption."""
    stop_watch = threading.Event()
    if cancel is not None:
        def _watch(resp=response, ev=stop_watch, cx=cancel):
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
    try:
        value = _bounded_json_response(response, maximum, label)
    except Exception as exc:
        if cancel is not None and cancel.is_set():
            return None, "cancelled"
        if _is_transport_interruption(exc):
            return None, "incomplete"
        raise
    finally:
        stop_watch.set()
    if cancel is not None and cancel.is_set():
        return None, "cancelled"
    return value, ""


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

    total = 0
    pending = bytearray()
    for chunk in iterator(chunk_size=65_536):
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


class LLMError(Exception):
    pass


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

    return {
        "input_tokens": count(raw.get("input_tokens", raw.get("prompt_tokens", 0))),
        "output_tokens": count(raw.get("output_tokens", raw.get("completion_tokens", 0))),
        "cached_input_tokens": count(
            raw.get("cached_input_tokens", input_details.get("cached_tokens",
                    raw.get("cache_read_input_tokens", 0)))),
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
    _capability_lock = threading.Lock()
    _model_metadata_cache: dict[tuple[str, str], tuple[float, dict]] = {}
    _model_metadata_lock = threading.Lock()

    def __init__(self, base_url: str, api_key: str, model: str, read_timeout: int = 1800,
                 think_budget_tokens: int = 8000, max_tokens: int = 0, ollama_keep_alive: str = "",
                 sampling: dict | None = None, api_mode: str = "auto",
                 provider_capabilities: dict | None = None, capability_cache_ttl_s: int = 300,
                 provider_state: str = "stateless", prompt_cache: bool = True,
                 prompt_cache_key: str = "", context_size: int = 0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.adapter = provider_adapter(self.base_url)
        self.family = self.adapter.family                 # picks the reasoning wire format
        self._capability_overrides = (dict(provider_capabilities)
                                      if isinstance(provider_capabilities, dict) else {})
        self.capabilities = self.adapter.with_overrides(self._capability_overrides)
        self.capability_cache_ttl_s = max(1, int(capability_cache_ttl_s or 0))
        self.read_timeout = read_timeout  # seconds to wait BETWEEN streamed chunks (slow-prefill guard)
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

    def _mark_rejected(self, feature: str) -> None:
        with self._capability_lock:
            self._capability_rejections[self._capability_key(feature)] = (
                time.monotonic() + self.capability_cache_ttl_s)

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
        if self.api_mode == "responses":
            return self._chat_responses(messages, tools, reasoning_effort,
                                        on_text, on_thinking, cancel)
        if self.api_mode == "ollama":
            return self._chat_ollama(messages, tools, reasoning_effort,
                                     on_text, on_thinking, cancel)
        if self.api_mode == "anthropic":
            return self._chat_anthropic(messages, tools, reasoning_effort,
                                        on_text, on_thinking, cancel)
        return self._chat_completions(messages, tools, reasoning_effort,
                                      on_text, on_thinking, cancel)

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
                raise LLMError(
                    "Anthropic Messages image input must be a validated base64 JPEG, PNG, GIF, or WebP")
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
                    result.thinking += thinking
                    if on_thinking:
                        on_thinking(thinking)
            elif kind == "redacted_thinking":
                if retain_provider_state:
                    provider_content.append({k: copy.deepcopy(v) for k, v in source.items()
                                             if not str(k).startswith("_")})
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
        return self._anthropic_result_from_blocks(
            blocks, result, on_text, on_thinking, emit_complete=True,
            retain_provider_state=terminal)

    def _consume_anthropic(self, response: requests.Response, on_text, on_thinking,
                           cancel=None, think_budget: int = 0) -> ChatResult:
        if ("application/json" in response.headers.get("Content-Type", "").lower()
                and "text/event-stream" not in response.headers.get("Content-Type", "").lower()):
            value, finish = _bounded_json_lifecycle(
                response, _MAX_ANTHROPIC_JSON_BYTES, "Anthropic Messages response", cancel)
            if finish:
                return ChatResult(finish_reason=finish)
            return self._consume_anthropic_json(value, on_text, on_thinking)
        result = ChatResult()
        blocks: dict[int, dict] = {}
        produced = False
        message_started = False
        message_stopped = False
        stop_reason_seen = False
        active_blocks: set[int] = set()

        def terminal_received() -> bool:
            return (message_started and message_stopped
                    and not active_blocks and stop_reason_seen)

        stop_watch = threading.Event()
        if cancel is not None:
            def _watch(resp=response, ev=stop_watch, cx=cancel):
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
                        try:
                            resp.close()
                        except Exception:
                            pass
                        return
            threading.Thread(target=_watch, daemon=True).start()
        response.encoding = "utf-8"
        try:
            for line in _bounded_stream_lines(
                    response, _MAX_ANTHROPIC_STREAM_BYTES, "Anthropic Messages stream"):
                if cancel is not None and cancel.is_set():
                    if not terminal_received():
                        result.finish_reason = "cancelled"
                    break
                if not line.startswith("data:"):
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
                        result.thinking += initial
                        if on_thinking and initial:
                            on_thinking(initial)
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
                        result.thinking += chunk
                        if on_thinking and chunk:
                            on_thinking(chunk)
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
                if not terminal_received():
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            stop_watch.set()
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
        transient = 0
        disabled: set[str] = set()
        overthink = 0
        level = reasoning_effort
        lower = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off",
                 "none": "off", "off": "off"}
        last_err = ""
        max_tokens_limit: int | None = None
        for _ in range(10):
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            payload = self._anthropic_payload(
                messages, tools, level, disabled, max_tokens_limit)
            try:
                response = requests.post(
                    f"{self.base_url}/messages", headers=self._anthropic_headers(), json=payload,
                    stream=True, timeout=(15, self.read_timeout))
            except requests.ConnectionError as exc:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                last_err = f"connection: {exc}"
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"cannot connect to Anthropic Messages: {exc}") from exc
            except requests.Timeout as exc:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                last_err = f"timeout: {exc}"
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"Anthropic Messages timed out repeatedly: {exc}") from exc
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
                body = _error_body(response, 400)
                last_err = f"HTTP {status}: {body}"
                transient += 1
                if transient < 4:
                    delay = _retry_delay(headers, 0.5 * transient)
                    if not _wait_for_retry(delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"HTTP {status} from Anthropic Messages after {transient} tries: {body}")
            if response.status_code in (400, 413):
                status = response.status_code
                body = _error_body(response)
                low = body.lower()
                last_err = body
                if status == 413 or _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
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
                raise LLMError(f"{status} from Anthropic Messages: {body}")
            if response.status_code != 200:
                status = response.status_code
                body = _error_body(response, 400)
                raise LLMError(f"HTTP {status} from Anthropic Messages: {body}")
            budget = self.think_budget_chars
            try:
                result = self._consume_anthropic(
                    response, on_text, on_thinking, cancel, think_budget=budget)
            finally:
                _close_response(response)
            if result.finish_reason == "overthink":
                overthink += 1
                prior_level = str(level or "off").lower()
                level = lower.get(prior_level, "off")
                # If an explicit reasoning-off request still produces only hidden thought, hand
                # the bounded outcome to the Agent instead of launching an unbounded final try.
                if prior_level in ("none", "off"):
                    return result
                continue
            return result
        raise LLMError(f"Anthropic Messages request failed repeatedly: {last_err}")

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
        # GPT-OSS does not accept booleans and cannot fully disable reasoning. Honor an off request
        # with its lowest supported level rather than sending false, which that model ignores.
        if "gpt-oss" in self.model.lower():
            value = str(level).lower()
            if level in _REASONING_OFF:
                return "low"
            return value if value in ("low", "medium", "high") else "high"
        if level in _REASONING_OFF:
            return False
        value = str(level).lower()
        if value == "xhigh":                 # Ollama accepts low|medium|high|max — clamp the extra tier
            return "high"
        return value if value in ("low", "medium", "high", "max") else True

    def _consume_ollama(self, r: requests.Response, on_text, on_thinking, cancel=None,
                        think_budget: int = 0) -> ChatResult:
        """Consume native Ollama JSON/NDJSON without translating it through SSE semantics."""
        result = ChatResult()
        filt = _ThinkFilter()
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
            reasoning = str(message.get("thinking") or "")
            if reasoning:
                native_thinking += reasoning
                result.thinking += reasoning
                if on_thinking:
                    on_thinking(reasoning)
            content = str(message.get("content") or "")
            if content:
                native_content += content
                for kind, chunk in filt.feed(content):
                    if kind == "think":
                        result.thinking += chunk
                        if on_thinking:
                            on_thinking(chunk)
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
                result.usage = normalize_usage({
                    "prompt_tokens": obj.get("prompt_eval_count", 0),
                    "completion_tokens": obj.get("eval_count", 0),
                })

        stop_watch = threading.Event()
        if cancel is not None:
            def _watch(resp=r, ev=stop_watch, cx=cancel):
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
                        try:
                            resp.close()
                        except Exception:
                            pass
                        return
            threading.Thread(target=_watch, daemon=True).start()

        try:
            ctype = r.headers.get("Content-Type", "").lower()
            if "application/json" in ctype and "ndjson" not in ctype:
                try:
                    obj = _bounded_json_response(
                        r, _MAX_OLLAMA_JSON_BYTES, "Ollama response")
                except (ValueError, RecursionError) as exc:
                    raise LLMError("Ollama emitted malformed JSON") from exc
                if not isinstance(obj, dict):
                    raise LLMError("Ollama emitted a non-object JSON response")
                consume(obj)
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
                if not terminal_done:
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            stop_watch.set()

        if (not terminal_done and cancel is not None and cancel.is_set()
                and result.finish_reason != "overthink"):
            result.finish_reason = "cancelled"
        aborted = result.finish_reason in ("cancelled", "overthink")
        if not aborted and not terminal_done:
            result.finish_reason = "incomplete"
        for kind, chunk in filt.flush():
            if kind == "think":
                result.thinking += chunk
                if on_thinking:
                    on_thinking(chunk)
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
        ollama_messages = self._ollama_messages(messages)
        if (any(message.get("images") for message in ollama_messages)
                and not self.vision_supported):
            raise LLMError(
                f"Ollama model {self.model!r} does not advertise vision input support")
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
        transient = 0
        repaired = False
        overthink = 0
        level = reasoning_effort
        lower = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off",
                 "none": "off", "off": "off"}
        for _ in range(8):
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            try:
                r = requests.post(self._ollama_url, headers=self._headers(), json=payload,
                                  stream=True, timeout=(15, self.read_timeout))
            except requests.ConnectionError as exc:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                last_err = f"connection: {exc}"
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"cannot connect to {self._ollama_root} — is Ollama running? "
                    f"(/connect <url> to change it)\n{exc}") from exc
            except requests.Timeout as exc:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                last_err = f"timeout: {exc}"
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"request timed out repeatedly: {last_err}") from exc

            if r.status_code in (404, 405, 501) and self.requested_api_mode == "auto":
                _close_response(r)
                self._mark_rejected("native_chat")
                self.api_mode = "chat_completions"
                return self._chat_completions(messages, tools, reasoning_effort,
                                              on_text, on_thinking, cancel)
            if r.status_code == 429:
                transient += 1
                headers = r.headers
                body = _error_body(r)
                last_err = f"429 rate limited: {body[:200]}"
                if transient < 4:
                    delay = _retry_delay(headers, 0.5 * transient)
                    if not _wait_for_retry(delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"rate limited (429) after {transient} tries: {last_err}")
            if r.status_code in (400, 413):
                body = _error_body(r)
                low = body.lower()
                last_err = body
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
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
                raise LLMError(f"{r.status_code} from Ollama: {body}")
            if r.status_code >= 500:
                transient += 1
                status = r.status_code
                body = _error_body(r)
                last_err = f"HTTP {status}: {body[:300]}"
                if transient < 4:
                    if transient >= 2 and not repaired:
                        payload["messages"] = self._ollama_messages(_repair_for_retry(messages))
                        repaired = True
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"HTTP {status} from {self._ollama_url} after {transient} tries: {body[:400]}")
            if r.status_code != 200:
                status = r.status_code
                body = _error_body(r, 400)
                raise LLMError(f"HTTP {status} from {self._ollama_url}: {body}")
            budget = self.think_budget_chars
            try:
                result = self._consume_ollama(r, on_text, on_thinking, cancel, think_budget=budget)
            finally:
                _close_response(r)
            if result.finish_reason == "overthink":
                overthink += 1
                prior_level = str(level or "off").lower()
                level = lower.get(prior_level, "off")
                if prior_level in ("none", "off"):
                    return result
                if self.reasoning_supported:
                    payload["think"] = self._ollama_think(level)
                continue
            return result
        raise LLMError(f"Ollama request failed repeatedly: {last_err}")

    def _chat_completions(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        reasoning_effort: str | None = None,
        on_text=None,
        on_thinking=None,
        cancel=None,
    ) -> ChatResult:
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

        last_err = ""
        transient = 0      # count of retried timeouts / 5xx (bounded, with backoff)
        repaired = False   # whether we've swapped in the endpoint-agnostic repaired shape
        overthink = 0      # F4: times the reasoning-watchdog fired this turn (bounded)
        level = reasoning_effort   # current thinking level; the watchdog steps it down on a runaway
        _LOWER = {"xhigh": "high", "high": "medium", "medium": "low", "low": "off", "none": "off", "off": "off"}
        for _ in range(8):  # 400-fallbacks + up to 4 transient retries share this budget
            # A deadline may expire while requests.post is waiting for response headers. Never turn
            # that terminal cancellation into several fresh provider generations via the transient
            # retry path; the abandoned in-flight attempt is already billable work.
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            try:
                r = requests.post(self._url, headers=self._headers(), json=payload,
                                  stream=True, timeout=(15, self.read_timeout))
            except requests.ConnectionError as e:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                # transient network drops (connection reset / broken pipe / socket hang-up) recover on
                # a retry; a persistent refusal (server down) exhausts the budget and raises the hint.
                last_err = f"connection: {e}"
                transient += 1
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"cannot connect to {self.base_url} — is your local LLM server running? "
                    f"(/connect <url> to change it)\n{e}") from e
            except requests.Timeout as e:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                last_err = f"timeout: {e}"
                transient += 1
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"request timed out repeatedly: {last_err}") from e
            if r.status_code == 429:
                # rate limited — back off (honour Retry-After) and retry within the budget
                headers = r.headers
                body = _error_body(r)
                last_err = f"429 rate limited: {body[:200]}"
                transient += 1
                if transient < 4:
                    delay = _retry_delay(headers, 0.5 * transient)
                    if not _wait_for_retry(delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"rate limited (429) after {transient} tries: {last_err}")
            if r.status_code in (400, 413):
                body = _error_body(r)
                last_err = body
                low = body.lower()
                # Classify OVERFLOW first — some overflow bodies contain words like "invalid" that would
                # otherwise be misread as a sampling/tool rejection and permanently strip a capability.
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
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
                raise LLMError(f"{r.status_code} from server: {body}")
            if r.status_code >= 500:
                # Transient upstream error — retry instead of killing the turn (robust
                # clients do the same). Ollama, for one, intermittently 500s
                # "no user query found in messages" on long tool-loops.
                status = r.status_code
                body = _error_body(r)
                last_err = f"HTTP {status}: {body[:300]}"
                transient += 1
                if transient < 4:
                    # After a plain retry fails, also repair the message SHAPE — collapse
                    # native tool-calls/results into plain user/assistant text that even a
                    # brittle chat template can render. This is the DGC-level fix (works for
                    # any user's endpoint, not just one machine's Ollama models).
                    if transient >= 2 and not repaired:
                        payload["messages"] = _repair_for_retry(messages)
                        repaired = True
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"HTTP {status} from {self._url} after {transient} tries: {body[:400]}")
            if r.status_code != 200:
                status = r.status_code
                body = _error_body(r, 400)
                raise LLMError(f"HTTP {status} from {self._url}: {body}")
            budget = self.think_budget_chars
            try:
                res = self._consume(r, on_text, on_thinking, cancel, think_budget=budget)
            finally:
                _close_response(r)
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
                continue
            return res
        raise LLMError(f"request failed repeatedly: {last_err}")

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
            value = _bounded_json_response(
                response, _MAX_RESPONSES_COMPACTION_BYTES, "Responses compaction",
                deadline=deadline)
            response = None  # bounded decoder owns and closes it
        except (LLMError, requests.RequestException, ValueError, TypeError):
            return None
        finally:
            stop_watch.set()
            if response is not None:
                _close_response(response)
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
        transient = 0
        disabled: set[str] = set()
        for _ in range(10):
            if cancel is not None and cancel.is_set():
                return ChatResult(finish_reason="cancelled")
            payload, stateful = self._responses_payload(messages, tools, reasoning_effort, disabled)
            try:
                response = requests.post(f"{self.base_url}/responses", headers=self._headers(), json=payload,
                                         stream=True, timeout=(15, self.read_timeout))
            except requests.ConnectionError as e:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"cannot connect to {self.base_url}: {e}") from e
            except requests.Timeout as e:
                if cancel is not None and cancel.is_set():
                    return ChatResult(finish_reason="cancelled")
                transient += 1
                if transient < 4:
                    if not _wait_for_retry(0.5 * transient, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(f"Responses API timed out repeatedly: {e}") from e
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
                body = _error_body(response, 400)
                transient += 1
                if transient < 4:
                    delay = _retry_delay(headers, 0.5 * transient)
                    if not _wait_for_retry(delay, cancel):
                        return ChatResult(finish_reason="cancelled")
                    continue
                raise LLMError(
                    f"HTTP {status} from Responses API after {transient} tries: {body}")
            if response.status_code in (400, 413):
                body = _error_body(response)
                low = body.lower()
                if _OVERFLOW_RE.search(low):
                    raise ContextOverflowError("context window exceeded: " + body[:200])
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
                raise LLMError(f"{response.status_code} from Responses API: {body}")
            if response.status_code != 200:
                status = response.status_code
                body = _error_body(response, 400)
                raise LLMError(f"HTTP {status} from Responses API: {body}")
            try:
                result = self._consume_responses(response, on_text, on_thinking, cancel)
            finally:
                _close_response(response)
            if (stateful and result.response_id
                    and result.finish_reason in ("stop", "tool_calls")):
                self._response_id = result.response_id
                self._response_cursor = len(messages)
                self._response_prefix_hash = self._messages_hash(messages)
            else:
                self._reset_response_state()
            return result
        raise LLMError("Responses API request failed repeatedly")

    def _consume_responses(self, response: requests.Response, on_text, on_thinking,
                           cancel=None) -> ChatResult:
        if "application/json" in response.headers.get("Content-Type", ""):
            value, finish = _bounded_json_lifecycle(
                response, _MAX_RESPONSES_JSON_BYTES, "Responses API response", cancel)
            if finish:
                return ChatResult(finish_reason=finish)
            return self._consume_responses_json(value, on_text, on_thinking)
        result = ChatResult()
        calls: dict[str, dict] = {}
        # `response.output_item.done` may arrive in a different completion order from its declared
        # output position. Preserve both coordinates so stateless replay follows `response.output`,
        # never network timing. The terminal response's complete output array remains authoritative
        # when the provider includes it.
        provider_items: dict[str, tuple[int | None, int, dict]] = {}
        provider_item_arrival = 0
        terminal = ""
        terminal_output: list[dict] | None = None
        incomplete_reason = ""
        stop_watch = threading.Event()
        if cancel is not None:
            def _watch():
                while not stop_watch.wait(0.15):
                    if getattr(response, "_dgc_closed", False):
                        return
                    if cancel.is_set():
                        sock = _raw_socket(response)
                        if sock is not None:
                            try:
                                import socket as _socket
                                sock.shutdown(_socket.SHUT_RDWR)
                            except Exception:
                                pass
                        try:
                            response.close()
                        except Exception:
                            pass
                        return
            threading.Thread(target=_watch, daemon=True).start()
        response.encoding = "utf-8"
        try:
            for line in _bounded_stream_lines(
                    response, _MAX_RESPONSES_STREAM_BYTES, "Responses API stream"):
                if cancel is not None and cancel.is_set():
                    if not terminal:
                        result.finish_reason = "cancelled"
                    break
                if not line or not line.startswith("data:"):
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
                if terminal:
                    raise LLMError("Responses API emitted data after its terminal response event")
                if typ == "response.output_text.delta":
                    delta = str(event.get("delta") or "")
                    result.content += delta
                    if on_text and delta: on_text(delta)
                elif "reasoning" in typ and typ.endswith(".delta"):
                    delta = str(event.get("delta") or "")
                    result.thinking += delta
                    if on_thinking and delta: on_thinking(delta)
                elif typ in ("response.output_item.added", "response.output_item.done"):
                    item = event.get("item") or {}
                    if not isinstance(item, dict):
                        raise LLMError("Responses API emitted a malformed output item")
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
                if not terminal:
                    incomplete_reason = "stream_interrupted"
            else:
                raise
        finally:
            stop_watch.set()
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
        if result.tool_calls and result.finish_reason == "stop":
            result.finish_reason = "tool_calls"
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        return result

    def _consume_responses_json(self, obj: dict, on_text, on_thinking) -> ChatResult:
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
                for part in item.get("summary") or []:
                    text = str(part.get("text") or "")
                    result.thinking += text
                    if on_thinking and text: on_thinking(text)
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
                 think_budget: int = 0) -> ChatResult:
        ctype = r.headers.get("Content-Type", "")
        if "application/json" in ctype and "text/event-stream" not in ctype:
            return self._consume_json(
                r, on_text, on_thinking, cancel=cancel)   # server ignored stream:true
        result = ChatResult()
        filt = _ThinkFilter()
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
                    result.thinking += chunk
                    if on_thinking:
                        on_thinking(chunk)
                else:
                    result.content += chunk
                    # Raw ``content`` may still be a tagged reasoning stream. Seeing an opening
                    # tag is not progress; only normal-channel text is visible to the user.
                    produced = True
                    if on_text:
                        on_text(chunk)

        # Cancel watcher: a stalled iter_lines() — the model still prefilling a huge resumed
        # context, with no first token yet — never runs the in-loop cancel check, because the
        # loop body doesn't execute until a line arrives. Closing the socket from a watcher
        # thread unblocks the read, so Esc / Stop takes effect immediately instead of hanging
        # forever on "responding…".
        stop_watch = threading.Event()
        if cancel is not None:
            def _watch(resp=r, ev=stop_watch, cx=cancel):
                while not ev.wait(0.15):
                    if getattr(resp, "_dgc_closed", False):
                        return
                    if cx.is_set():
                        # Shutting the raw socket down is what actually unblocks a stalled
                        # recv(); resp.close() alone races and often waits for the server.
                        sock = _raw_socket(resp)
                        if sock is not None:
                            try:
                                import socket as _socket
                                sock.shutdown(_socket.SHUT_RDWR)
                            except Exception:
                                pass
                        try:
                            resp.close()
                        except Exception:
                            pass
                        return
            threading.Thread(target=_watch, daemon=True).start()
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
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
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
                    result.usage = normalize_usage(obj.get("usage"))
                choices = obj.get("choices")
                if not isinstance(choices, list):
                    raise LLMError("Chat Completions emitted a malformed choices array")
                # OpenAI documents an empty final choices array when include_usage is enabled.
                if not choices:
                    continue
                if saw_finish:
                    raise LLMError(
                        "Chat Completions emitted choice data after its finish reason")
                if not isinstance(choices[0], dict):
                    raise LLMError("Chat Completions emitted a malformed choice")
                choice = choices[0]
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
                reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                if reasoning is not None and not isinstance(reasoning, str):
                    raise LLMError("Chat Completions emitted malformed reasoning text")
                if reasoning:
                    result.thinking += reasoning
                    if on_thinking:
                        on_thinking(reasoning)
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
                if not saw_finish:
                    result.finish_reason = "incomplete"
            else:
                raise
        finally:
            stop_watch.set()

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
                      cancel=None) -> ChatResult:
        """A non-streaming server (ignored stream:true) returns one JSON completion — parse it
        through the same think-splitter / lenient-args / text-fallback path as the SSE stream."""
        try:
            obj, finish = _bounded_json_lifecycle(
                r, _MAX_CHAT_JSON_BYTES, "Chat Completions response", cancel)
        except Exception as exc:
            if isinstance(exc, (ValueError, RecursionError)) and not isinstance(exc, LLMError):
                raise LLMError("Chat Completions response returned malformed JSON") from exc
            raise
        if finish:
            return ChatResult(finish_reason=finish)
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
        result.usage = normalize_usage(usage)
        # A whole, valid JSON body can still omit the required finish reason on a compatible
        # gateway. Preserve its partial display/calls only for bounded non-executable reissue.
        result.finish_reason = finish_reason or "incomplete"
        if reasoning:
            result.thinking += reasoning
            if on_thinking:
                on_thinking(reasoning)
        filt = _ThinkFilter()
        for kind, chunk in filt.feed(content or "") + filt.flush():
            if kind == "think":
                result.thinking += chunk
                if on_thinking:
                    on_thinking(chunk)
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
