"""What went wrong with a model request, in words a person can act on.

A pure module (no I/O): it turns the exception a transport raised, the HTTP status a server
answered, or the way a stream ended into a :class:`FailureCause` -- a kind from the editor
protocol's ``MODEL_FAILURE_KINDS``, a one-line summary DGC wrote, the provider/transport detail
with no credentials or query strings in it, and the hint ``dgc doctor`` would give.

Classification is by exception TYPE first, walking ``__cause__``/``__context__``/``args[0]`` and
urllib3's ``MaxRetryError.reason``; the message text is only a fallback for wrappers that lost
the original type. Every string that can carry a URL goes through :func:`scrub_urls`, because
``redaction`` knows secret VALUES but a key carried in ``base_url``'s query string, or a
``user:pass@`` in it, is not a configured secret.
"""
from __future__ import annotations

import errno as _errno
import http.client
import re
import socket
import ssl
from dataclasses import dataclass, replace

from .editor_protocol import MODEL_FAILURE_KINDS
from .model_watch import endpoint_host, format_seconds, is_local_endpoint, safe_endpoint

__all__ = ("MODEL_FAILURE_KINDS", "FailureCause", "classify_exception", "classify_status",
           "eof_cause", "stall_cause", "scrub_urls", "hint_for", "short_cause", "CONNECT_KINDS",
           "BUSY_KINDS", "TERMINATORS")

# The kinds a "Reconnecting" line describes; the rest retry an answered request.
CONNECT_KINDS = frozenset(("connect", "dns", "tls", "proxy", "reset", "connect_timeout", "stream_cut"))
BUSY_KINDS = frozenset(("rate_limited", "overloaded"))

# How each transport says a generation finished. A stream that ends without it was cut.
TERMINATORS = {
    "chat_completions": "[DONE]",
    "responses": "response.completed",
    "anthropic": "message_stop",
    "ollama": '"done": true',
}

_BUSY_BODY_RE = re.compile(r"busy|overload|capacity|maximum pending|try again later", re.I)
_MODEL_404_RE = re.compile(r"not found|no such model|does not exist|unknown model", re.I)
_DNS_RE = re.compile(r"name or service not known|nodename nor servname|getaddrinfo"
                     r"|temporary failure in name resolution|nameresolutionerror|failed to resolve",
                     re.I)
_REFUSED_RE = re.compile(r"connection refused", re.I)
_RESET_RE = re.compile(r"reset by peer|remote end closed|connection aborted", re.I)
_UNREACHABLE_RE = re.compile(r"network is unreachable|no route to host", re.I)
_TLS_RE = re.compile(r"certificate_verify_failed|certificate verify failed|sslerror|\[ssl", re.I)


@dataclass(frozen=True)
class FailureCause:
    """One failed model request attempt, described for the front end."""
    kind: str
    summary: str
    detail: str = ""
    hint: str = ""
    http_status: int = 0
    retryable: bool = True
    endpoint: str = ""
    model: str = ""
    api_mode: str = ""

    def with_context(self, *, endpoint: str = "", model: str = "", api_mode: str = "",
                     hint: str | None = None) -> "FailureCause":
        return replace(self, endpoint=safe_endpoint(endpoint) if endpoint else self.endpoint,
                       model=model or self.model, api_mode=api_mode or self.api_mode,
                       hint=self.hint if hint is None else hint)

    def as_dict(self) -> dict:
        """The ``error.cause`` shape (optional keys left out when empty)."""
        out: dict = {"kind": self.kind if self.kind in MODEL_FAILURE_KINDS else "other",
                     "summary": self.summary}
        for key in ("endpoint", "model", "api_mode", "detail", "hint"):
            value = getattr(self, key)
            if value:
                out[key] = value
        if self.http_status:
            out["http_status"] = int(self.http_status)
        return out


# ---- scrubbing -----------------------------------------------------------------------------------
_SCHEME_URL_RE = re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.\-]{0,15}://)([^\s'\"<>()\[\]{}`]+)")
_PATH_URL_RE = re.compile(r"(\burl\s*[:=]\s*)(/[^\s'\"<>()\[\]{}`]*)", re.I)


def _strip_query(rest: str) -> str:
    fragment = rest.find("#")
    if fragment >= 0:
        rest = rest[:fragment]
    query = rest.find("?")
    if query >= 0:
        rest = rest[:query] + "?…"
    return rest


def scrub_urls(text) -> str:
    """Remove ``user:pass@`` and query strings/fragments from every URL-shaped token.

    Covers ``scheme://`` URLs and the path forms urllib3/requests print (``Max retries exceeded
    with url: /v1/chat/completions?key=…``). A query is replaced with ``?…`` rather than dropped,
    so a reader can still tell one was there.
    """
    value = str(text or "")
    if "://" not in value and "url" not in value.lower():
        return value

    def scheme(match: re.Match) -> str:
        rest = match.group(2)
        slash = rest.find("/")
        authority, path = (rest, "") if slash < 0 else (rest[:slash], rest[slash:])
        query_in_authority = min((i for i in (authority.find("?"), authority.find("#")) if i >= 0),
                                 default=-1)
        if query_in_authority >= 0:                 # http://host?key=… with no path
            path = authority[query_in_authority:] + path
            authority = authority[:query_in_authority]
        if "@" in authority:
            authority = authority.rsplit("@", 1)[1]
        return match.group(1) + authority + _strip_query(path)

    value = _SCHEME_URL_RE.sub(scheme, value)
    return _PATH_URL_RE.sub(lambda m: m.group(1) + _strip_query(m.group(2)), value)


def _first_line(text, limit: int = 160) -> str:
    line = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    return line if len(line) <= limit else line[:limit - 1] + "…"


# ---- exceptions ----------------------------------------------------------------------------------
def _chain(exc: BaseException | None, limit: int = 16) -> list[BaseException]:
    """Every exception reachable from ``exc``: causes, contexts, wrapped args, urllib3 reasons."""
    seen: list[BaseException] = []
    queue = [exc]
    while queue and len(seen) < limit:
        item = queue.pop(0)
        if not isinstance(item, BaseException) or any(item is s for s in seen):
            continue
        seen.append(item)
        queue.extend((getattr(item, "reason", None), item.__cause__, item.__context__))
        args = getattr(item, "args", None) or ()
        queue.extend(arg for arg in args[:2] if isinstance(arg, BaseException))
    return seen


def _classes(module: str, *names: str) -> tuple[type, ...]:
    try:
        mod = __import__(module, fromlist=list(names))
    except Exception:
        return ()
    return tuple(getattr(mod, name) for name in names if isinstance(getattr(mod, name, None), type))


def _errno_of(exc: BaseException) -> int | None:
    value = getattr(exc, "errno", None)
    return value if isinstance(value, int) else None


def classify_exception(exc: BaseException | None, *, endpoint: str = "",
                       streaming: bool = False) -> FailureCause:
    """The cause of a transport exception. ``streaming`` means response headers had arrived."""
    host = endpoint_host(endpoint) or "the endpoint"
    try:
        from urllib.parse import urlsplit
        hostname = urlsplit(str(endpoint or "")).hostname or host
    except ValueError:
        hostname = host
    chain = _chain(exc)
    text = " ".join(scrub_urls(str(item)) for item in chain)
    detail = scrub_urls(str(exc or ""))
    detail_type = type(exc).__name__ if exc is not None else ""
    if detail and detail_type and not detail.startswith(detail_type):
        detail = f"{detail_type}: {detail}"

    def any_of(types: tuple[type, ...], exclude: tuple[type, ...] = ()) -> BaseException | None:
        if not types:
            return None
        return next((item for item in chain
                     if isinstance(item, types) and not (exclude and isinstance(item, exclude))),
                    None)

    def cause(kind: str, summary: str, **fields) -> FailureCause:
        return FailureCause(kind=kind, summary=summary, detail=detail, endpoint=safe_endpoint(endpoint),
                            **fields)

    tls = (any_of(_classes("requests.exceptions", "SSLError") + _classes("urllib3.exceptions", "SSLError")
                  + (ssl.SSLError,))
           or (exc if _TLS_RE.search(text) else None))
    if tls is not None:
        match = re.search(r"certificate verify failed(?::\s*([^()'\"\]]+))?", text, re.I)
        reason = "certificate verify failed" + (f": {match.group(1).strip()}" if match and match.group(1) else "") \
            if match else (_first_line(getattr(tls, "reason", "") or tls, 80) or "handshake failed")
        return cause("tls", f"TLS handshake with {host} failed: {reason}")
    if any_of(_classes("requests.exceptions", "ProxyError") + _classes("urllib3.exceptions", "ProxyError")):
        return cause("proxy", f"the proxy refused the connection to {host}")
    new_connection = _classes("urllib3.exceptions", "NewConnectionError")
    if any_of(_classes("requests.exceptions", "ConnectTimeout")
              + _classes("urllib3.exceptions", "ConnectTimeoutError"), exclude=new_connection):
        return cause("connect_timeout", f"no TCP connection to {host} within 15s")
    if (any_of(_classes("urllib3.exceptions", "NameResolutionError") + (socket.gaierror,))
            or _DNS_RE.search(text)):
        return cause("dns", f"could not resolve host {hostname}")
    refused = any_of((ConnectionRefusedError,))
    if refused is None:
        refused = next((item for item in chain if _errno_of(item) in (111, 61, 10061)), None)
    if refused is not None or _REFUSED_RE.search(text):
        return cause("connect", f"connection refused by {host}")
    unreachable = next((item for item in chain
                        if _errno_of(item) in (_errno.ENETUNREACH, _errno.EHOSTUNREACH)), None)
    if unreachable is not None or _UNREACHABLE_RE.search(text):
        return cause("connect", f"network unreachable — no route to {host}")
    if any_of((ConnectionResetError, http.client.RemoteDisconnected)) or _RESET_RE.search(text):
        return cause("reset", "connection reset by peer while streaming" if streaming
                     else f"connection reset by {host} before a response")
    broken = any_of(_classes("requests.exceptions", "ChunkedEncodingError")
                    + _classes("urllib3.exceptions", "ProtocolError", "IncompleteRead")
                    + (http.client.IncompleteRead,))
    if broken is not None:
        inner = next((item for item in chain if isinstance(item, http.client.IncompleteRead)
                      or type(item).__name__ == "IncompleteRead"), broken)
        return cause("stream_cut", f"connection broken while streaming: {_first_line(repr(inner), 100)}")
    if exc is None:
        return cause("other", "the request failed")
    return cause("other", f"{type(exc).__name__}: {_first_line(scrub_urls(str(exc)))}".rstrip(": "))


# ---- HTTP answers --------------------------------------------------------------------------------
def classify_status(status: int, body: str = "", headers=None, *, endpoint: str = "",
                    delay_s: float | None = None) -> FailureCause:
    """The cause of a non-200 answer. ``delay_s`` is the backoff actually used, when Retry-After set it."""
    host = endpoint_host(endpoint) or "the endpoint"
    try:
        code = int(status)
    except (TypeError, ValueError):
        code = 0
    reason = http.client.responses.get(code, "")
    text = scrub_urls(str(body or ""))
    detail = f"HTTP {code}{(' ' + reason) if reason else ''}" + (f" · {text[:1500]}" if text else "")
    summary = f"HTTP {code} from {host}"
    retry_after = bool(headers and str((headers or {}).get("Retry-After") or "").strip())
    if code == 429:
        waited = f" · waited {format_seconds(delay_s)}" if retry_after and delay_s is not None else ""
        kind, retryable = "rate_limited", True
        summary += waited
    elif code == 503 and _BUSY_BODY_RE.search(text):
        kind, retryable = "overloaded", True
    elif code == 408 or code >= 500:
        kind, retryable = "http", True
    elif code in (401, 403):
        kind, retryable = "auth", False
    elif code == 404 and _MODEL_404_RE.search(text):
        kind, retryable = "model_not_found", False
    else:
        kind, retryable = "http", False
    return FailureCause(kind=kind, summary=summary, detail=detail, http_status=code if 100 <= code <= 599 else 0,
                        retryable=retryable, endpoint=safe_endpoint(endpoint))


def eof_cause(transport: str, *, endpoint: str = "") -> FailureCause:
    """A stream that ended cleanly but never sent its transport's terminal event."""
    terminator = TERMINATORS.get(str(transport or ""), "its terminal event")
    host = endpoint_host(endpoint) or "the endpoint"
    return FailureCause(kind="stream_cut", summary=f"stream from {host} ended before {terminator}",
                        detail=f"stream closed before its terminal event ({terminator})",
                        endpoint=safe_endpoint(endpoint))


def stall_cause(info) -> FailureCause:
    """A request the stall watcher ended (StallInfo or its ``as_dict()``)."""
    data = info if isinstance(info, dict) else (info.as_dict() if hasattr(info, "as_dict") else {})
    phase = str(data.get("phase") or "")
    model = str(data.get("model") or "the model")
    endpoint = str(data.get("endpoint") or "")
    host = endpoint_host(endpoint) or "the endpoint"
    silent = format_seconds(float(data.get("window_s") or data.get("silent_s") or 0))
    if phase == "loading":
        kind, summary = "loading", f"{model} at {host} did not finish loading in {silent}"
    elif phase == "streaming":
        kind, summary = "stall", f"{model} at {host} stopped streaming for {silent}"
    elif phase == "first_token":
        kind, summary = "stall", f"no tokens from {model} at {host} for {silent}"
    else:
        kind, summary = "stall", f"no response from {model} at {host} for {silent}"
    return FailureCause(kind=kind, summary=summary, hint=hint_for(kind), endpoint=safe_endpoint(endpoint),
                        model=str(data.get("model") or ""))


# ---- words ---------------------------------------------------------------------------------------
def short_cause(cause: FailureCause) -> str:
    """Two or three words for a status row."""
    if cause.http_status:
        return f"HTTP {cause.http_status}"
    return {"connect": "connection refused" if "refused" in cause.summary else "network unreachable",
            "dns": "could not resolve host", "tls": "TLS failed", "proxy": "proxy error",
            "reset": "connection reset", "connect_timeout": "connect timeout",
            "stream_cut": "stream cut", "stall": "no tokens", "loading": "model loading",
            "auth": "key rejected", "model_not_found": "no such model"}.get(cause.kind, "request failed")


def hint_for(kind: str, *, model: str = "", base_url: str = "") -> str:
    """The hint for a failure kind; ``llm.explain_llm_error`` prints these same strings."""
    base = safe_endpoint(base_url) if base_url else ""
    if kind in ("stall", "loading"):
        from .llm import MODEL_STALL_HINT       # llm imports this module at load time
        return MODEL_STALL_HINT
    if kind == "dns":
        return (f"the host in {base or 'the configured URL'} does not resolve — check the URL for typos, "
                "your DNS or VPN; `dgc doctor` checks it")
    if kind == "tls":
        return (f"TLS to {base or 'the endpoint'} failed — use http:// for a local server, or trust its "
                "certificate (REQUESTS_CA_BUNDLE)")
    if kind == "proxy":
        return f"a proxy is between DGC and {base or 'the endpoint'} — check HTTPS_PROXY / NO_PROXY"
    if kind in ("connect", "connect_timeout", "reset"):
        if not base or is_local_endpoint(base_url):
            return (f"the endpoint {base or 'you configured'} is not answering — start your server "
                    "(ollama serve / llama-server / LM Studio) or fix the URL; `dgc doctor` checks both")
        return (f"{base} is not answering — check the URL, your network or the provider's status; "
                "`dgc doctor` checks it")
    if kind == "model_not_found":
        hint = (f"the server offers no model named '{model}'" if model else "the server does not know that model")
        return hint + (f" — pull it (ollama pull {model})" if model else " — pull it") + \
            ", pick one with /model or `dgc --model NAME`, or run `dgc setup`"
    if kind == "auth":
        return "the endpoint rejected the key — set it with /connect, `dgc --api-key-env NAME` or DGC_API_KEY"
    if kind == "rate_limited":
        return "the endpoint is rate-limiting this key — wait a moment, or lower max_parallel_tasks"
    if kind in ("http", "overloaded"):
        return "the server failed on its side — check its logs; `dgc doctor` shows what it offers"
    return ""
