"""Thinking provenance: where each reasoning block came from, and how it is shown.

Every reasoning block DGC shows carries one of five sources:

- ``raw``         the model's own reasoning tokens, split out by a runtime serving open weights;
- ``summarized``  the provider (Anthropic, OpenAI) returned a summary of the reasoning;
- ``narration``   a between-tool progress note (Anthropic ``display:"updates"``);
- ``withheld``    the provider sent a reasoning item with no readable text;
- ``unknown``     DGC cannot prove raw or summarized.

``resolve_source`` is the only producer of a source. It keys on the exact hostname of the endpoint
that parsed the bytes, the model id and the wire channel -- never on an event name alone -- and it
enforces two rules as its last step: a provider-only source always names its provider (R1), and a
private or loopback host can never be summarized, narration or withheld (R2).

``ReasoningTracker`` owns block identity, close, timing and placement for one model request. Both
``Agent._chat`` and ``subscriptions.delegate_turn`` use it, and every front-end consumes the
``ReasoningBlock`` objects it hands to ``ui.on_thinking(chunk, block)`` / ``ui.on_thinking_end``.
"""
from __future__ import annotations

import dataclasses
import functools
import inspect
import ipaddress
import logging
import math
import time
from dataclasses import dataclass
from typing import Callable, NamedTuple
from urllib.parse import urlsplit

from .editor_protocol import REASONING_PROVIDERS, REASONING_SOURCES

SOURCES = REASONING_SOURCES
PROVIDERS = REASONING_PROVIDERS
PROVIDER_SOURCES = frozenset({"summarized", "narration", "withheld"})
INLINE_SOURCES = frozenset({"summarized", "narration"})
PROVIDER_NAMES = {"anthropic": "Anthropic", "openai": "OpenAI"}

NARRATION_HARD_CAP = 1200
INLINE_MAX_CHARS_DEFAULT = 280
INLINE_MAX_CHARS_LIMIT = 1000
INLINE_MAX_LINES = 4

# Persistence bounds (per saved assistant message) and history replay bounds (per payload).
PERSIST_MAX_BLOCKS = 64
PERSIST_BLOCK_CHARS = 8000
PERSIST_MESSAGE_CHARS = 24000
REPLAY_BLOCK_CHARS = 4000
REPLAY_PAYLOAD_CHARS = 200_000
REPLAY_STUB_CHARS = 1000
MAX_SECONDS = 86400.0

CHANNELS = ("ollama.thinking", "tags", "chat.reasoning", "chat.reasoning_content",
            "responses.summary", "responses.reasoning_text", "responses.no_text",
            "responses.other", "anthropic.thinking", "anthropic.redacted", "subscription")

_LOCAL_FAMILIES = frozenset({"ollama", "vllm", "llamacpp", "lmstudio"})
_PRIVATE_SUFFIXES = (".local", ".lan", ".internal", ".home.arpa", ".ts.net", ".localhost")
_CLOSED_PREFIXES = ("claude-", "gpt-5", "o1", "o3", "o4", "gemini-", "grok-")
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")

_LOG = logging.getLogger("dgc.reasoning")
_LOG.addHandler(logging.NullHandler())   # never write into a full-screen terminal by default
_LOGGED: set = set()


def now() -> float:
    """The clock every stamp uses (parsers and trackers alike); tests replace it."""
    return time.monotonic()


def _log_once(key: tuple, message: str, *args) -> None:
    if key in _LOGGED:
        return
    _LOGGED.add(key)
    _LOG.warning(message, *args)


# ---- host and model predicates ------------------------------------------------------------------

def host_of(base_url) -> str:
    """The lowercase hostname of an endpoint, without a trailing dot. Never log ``base_url``: it can
    carry ``user:pass@``."""
    try:
        host = urlsplit(str(base_url or "")).hostname or ""
    except ValueError:
        host = ""
    return host.lower().rstrip(".")


def anthropic_host(host: str) -> bool:
    return host == "api.anthropic.com" or host.endswith(".anthropic.com")


def openai_host(host: str) -> bool:
    return host == "api.openai.com" or host.endswith(".openai.azure.com")


def private_host(host: str) -> bool:
    """Loopback, RFC 1918, link-local, 100.64/10, IPv6 ULA/loopback, ``localhost``, single-label
    names and conventional LAN suffixes. An empty or unparseable host counts as private: widening
    this set can only move a label toward ``unknown``/``raw``."""
    value = str(host or "").lower().rstrip(".")
    if not value:
        return True
    address = value.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        ip = None
    if ip is not None:
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        return bool(ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified
                    or (ip.version == 4 and ip in _SHARED_ADDRESS_SPACE)
                    or (ip.version == 6 and ip in ipaddress.ip_network("fc00::/7")))
    if value == "localhost" or "." not in value:
        return True
    return value.endswith(_PRIVATE_SUFFIXES)


def host_class(host: str) -> str:
    """What a log line may say about a host: never the host or the URL itself."""
    if anthropic_host(host):
        return "anthropic"
    if openai_host(host):
        return "openai"
    return "private" if private_host(host) else "other"


def _family(base_url: str) -> str:
    from .llm import _provider_family
    return _provider_family(str(base_url or ""))


def local_runtime(base_url: str) -> bool:
    return private_host(host_of(base_url)) and _family(base_url) in _LOCAL_FAMILIES


def closed_reasoning_model(model: str) -> bool:
    """A closed model's id. On a local runtime it means a proxy is in the path."""
    value = str(model or "").strip().lower()
    tail = value.rsplit("/", 1)[-1]
    return value.startswith(_CLOSED_PREFIXES) or tail.startswith(_CLOSED_PREFIXES)


def claude_summarizing_model(model: str) -> bool:
    """Exactly the models DGC asks for ``display:"summarized"`` adaptive thinking: legacy
    ``enabled``-path ids are not proven to return summaries and resolve to ``unknown``."""
    from .llm import LLMClient
    return LLMClient._anthropic_adaptive_model(str(model or ""))


# ---- the resolver ---------------------------------------------------------------------------------

class Resolved(NamedTuple):
    source: str
    provider: str
    private: bool


def enforce_rules(source: str, provider: str, *, private: bool, channel: str,
                  klass: str) -> tuple[str, str]:
    """R1 and R2, the resolver's last step. A violation downgrades to ``unknown`` and logs once,
    with the rule, the host class and the channel only (no text, no URL)."""
    source = source if source in SOURCES else "unknown"
    provider = provider if provider in PROVIDERS else ""
    if source in PROVIDER_SOURCES and not provider:
        _log_once(("R1", klass, channel),
                  "reasoning provenance downgraded: rule=R1 host_class=%s channel=%s", klass, channel)
        return "unknown", ""
    if source in PROVIDER_SOURCES and private:
        _log_once(("R2", klass, channel),
                  "reasoning provenance downgraded: rule=R2 host_class=%s channel=%s", klass, channel)
        return "unknown", ""
    if source not in PROVIDER_SOURCES:
        provider = ""
    return source, provider


@functools.lru_cache(maxsize=512)
def _resolve(api_mode: str, channel: str, base_url: str, model: str,
             requested_display: str) -> Resolved:
    host = host_of(base_url)
    private = private_host(host)
    closed = closed_reasoning_model(model)
    local = private and _family(base_url) in _LOCAL_FAMILIES
    source, provider = "unknown", ""
    if channel == "ollama.thinking":
        if api_mode == "ollama" and not closed:
            source = "raw"
    elif channel == "tags":
        if (api_mode == "ollama" or local) and not closed:
            source = "raw"
    elif channel in ("chat.reasoning", "chat.reasoning_content"):
        if api_mode == "chat_completions" and local and not closed:
            source = "raw"
    elif channel == "responses.summary":
        if api_mode == "responses" and openai_host(host):
            source, provider = "summarized", "openai"
        elif api_mode == "responses" and local and not closed:
            source = "raw"
    elif channel == "responses.reasoning_text":
        if api_mode == "responses" and local and not closed:
            source = "raw"
    elif channel == "responses.no_text":
        if api_mode == "responses" and openai_host(host):
            source, provider = "withheld", "openai"
    elif channel == "anthropic.thinking":
        if api_mode == "anthropic" and anthropic_host(host):
            if requested_display == "updates":
                source, provider = "narration", "anthropic"
            elif claude_summarizing_model(model):
                source, provider = "summarized", "anthropic"
        elif api_mode == "anthropic" and local and not closed:
            source = "raw"
    elif channel == "anthropic.redacted":
        if api_mode == "anthropic" and anthropic_host(host):
            source, provider = "withheld", "anthropic"
    # "subscription" and every other channel: unknown (a subscription engine cannot report the
    # endpoint it really talks to, so nothing about it is proven).
    source, provider = enforce_rules(source, provider, private=private, channel=channel,
                                     klass=host_class(host))
    return Resolved(source, provider, private)


def resolve_source(*, api_mode: str, channel: str, base_url: str, model: str,
                   requested_display: str = "") -> Resolved:
    """The provenance of one reasoning channel. Pure apart from the once-per-kind downgrade log."""
    return _resolve(str(api_mode or ""), str(channel or ""), str(base_url or ""),
                    str(model or ""), str(requested_display or ""))


# ---- origins, blocks and placement -----------------------------------------------------------------

@dataclass(frozen=True)
class ReasoningOrigin:
    """What a parser knows about one reasoning event."""
    source: str = "unknown"          # raw|summarized|narration|withheld|unknown
    provider: str = ""               # ""|anthropic|openai
    private: bool = False
    part: str = ""                   # f"{attempt}:{local}", unique per HTTP attempt
    event: str = "delta"             # delta | stop | withheld
    t_start: float | None = None     # parser-observed block start, when the wire has one


LEGACY_ORIGIN = ReasoningOrigin(source="unknown", part="legacy")


@dataclass(frozen=True)
class ReasoningBlock:
    key: str
    agent: str = ""
    source: str = "unknown"
    provider: str = ""
    private: bool = False
    text: str = ""
    seconds: float | None = None
    placement: str = "collapsed"
    truncated: bool = False
    tools: bool | None = None
    after_text: bool = False


def clamp_max_chars(value) -> int:
    if isinstance(value, bool):
        return INLINE_MAX_CHARS_DEFAULT
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return INLINE_MAX_CHARS_DEFAULT
    return max(0, min(INLINE_MAX_CHARS_LIMIT, number))


def _summary_fits_inline(text: str, max_chars: int) -> bool:
    value = str(text or "").strip()
    return bool(value) and len(value) <= clamp_max_chars(max_chars) and "```" not in value \
        and value.count("\n") < INLINE_MAX_LINES


def placement(source: str, text: str, *, round_called_tools, inline_enabled: bool,
              max_chars, from_subagent: bool) -> str:
    """``inline`` or ``collapsed``. Raw and unknown reasoning is never inline."""
    if not inline_enabled or from_subagent:
        return "collapsed"
    value = str(text or "").strip()
    if source == "narration":
        return ("inline" if value and len(value) <= NARRATION_HARD_CAP and "```" not in value
                else "collapsed")
    if source != "summarized":
        return "collapsed"
    if not _summary_fits_inline(value, max_chars):
        return "collapsed"                   # decidable at block close
    if round_called_tools is not True:       # the only input that needs the request to end
        return "collapsed"
    return "inline"


def can_decide_at_close(source: str, text: str, *, inline_enabled: bool, max_chars,
                        from_subagent: bool) -> bool:
    """False only for a summarized block that could still go inline once the request ends."""
    return not (source == "summarized" and inline_enabled and not from_subagent
                and _summary_fits_inline(text, max_chars))


def wire_identity(source, provider) -> tuple[str, str]:
    """Enum shape and R1 for a frame about to be emitted (R2 is the resolver's job)."""
    source = source if source in SOURCES else "unknown"
    provider = provider if provider in PROVIDERS else ""
    if source in PROVIDER_SOURCES and not provider:
        return "unknown", ""
    if source not in PROVIDER_SOURCES:
        provider = ""
    return source, provider


def finite_seconds(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > MAX_SECONDS:
        return None
    return round(number, 1)


def label_suffix(source: str, provider: str, *, width: int = 0) -> str:
    """The muted provenance suffix: `` · raw``, `` · summarized by Anthropic``, ``""`` for unknown.
    ``width`` below 60 columns drops the provider name."""
    source, provider = wire_identity(source, provider)
    name = PROVIDER_NAMES.get(provider, "")
    by = f" by {name}" if name and not (width and width < 60) else ""
    if source == "raw":
        return " · raw"
    if source in ("summarized", "narration"):
        return f" · summarized{by}"
    if source == "withheld":
        return f" · hidden{by}"
    return ""


def cli_thinking_label(source: str, provider: str) -> str:
    """The line CLI's reasoning header: ``· thinking (raw)…``, ``· thinking (summarized by
    Anthropic)…``, ``· thinking…`` (unknown), ``· thinking (hidden by Anthropic)`` (withheld), and a
    bare ``·`` before a progress note (its `` · summarized`` hint follows the text)."""
    source, provider = wire_identity(source, provider)
    name = PROVIDER_NAMES.get(provider, "")
    if source == "raw":
        return "· thinking (raw)…"
    if source == "summarized":
        return f"· thinking (summarized by {name})…"
    if source == "withheld":
        return f"· thinking (hidden by {name})"
    if source == "narration":
        return "·"
    return "· thinking…"


def _accepts_block(callback) -> bool:
    target = getattr(callback, "__func__", callback)
    try:
        return _accepts_block_cached(target, hasattr(callback, "__self__"))
    except TypeError:                         # an unhashable callable
        return _signature_accepts_block(callback)


@functools.lru_cache(maxsize=256)
def _accepts_block_cached(target, bound: bool) -> bool:
    accepts = _signature_accepts_block(target)
    if bound and not accepts:
        return False
    if bound:
        # The unbound function counts ``self``; a bound method needs one more positional slot.
        try:
            parameters = list(inspect.signature(target).parameters.values())
        except (TypeError, ValueError):
            return True
        if any(p.kind is inspect.Parameter.VAR_POSITIONAL or p.name == "block" for p in parameters):
            return True
        positional = [p for p in parameters if p.kind in (
            inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]
        return len(positional) >= 3
    return accepts


def _signature_accepts_block(callback) -> bool:
    try:
        parameters = inspect.signature(callback).parameters.values()
    except (TypeError, ValueError):
        return True
    positional = 0
    for parameter in parameters:
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            return True
        if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY,
                              inspect.Parameter.POSITIONAL_OR_KEYWORD):
            positional += 1
        if parameter.name == "block":
            return True
    return positional >= 2


def origin_callback(on_thinking):
    """A parser's ``on_thinking(chunk, origin)``. A caller written for the one-argument callback
    (``thinking_chunks.append``) keeps receiving exactly the text chunks it always did: stop and
    withheld events carry no text and are not delivered to it."""
    if on_thinking is None or getattr(on_thinking, "_dgc_origin_callback", False):
        return on_thinking
    if _accepts_block(on_thinking):
        return on_thinking

    def text_only(chunk, origin=None):
        if chunk:
            on_thinking(chunk)
    text_only._dgc_origin_callback = True
    return text_only


def deliver_thinking(ui, chunk: str, block: ReasoningBlock) -> None:
    """``ui.on_thinking(chunk, block)``; a UI written for the one-argument callback still works."""
    callback = getattr(ui, "on_thinking", None)
    if not callable(callback):
        return
    if _accepts_block(callback):
        callback(chunk, block)
    else:
        callback(chunk)


def deliver_thinking_end(ui, block: ReasoningBlock) -> None:
    callback = getattr(ui, "on_thinking_end", None)
    if callable(callback):
        callback(block)


# ---- the tracker ------------------------------------------------------------------------------------

class _Open:
    __slots__ = ("identity", "part", "withheld", "redactor", "parts", "chars", "truncated",
                 "t_start", "t_first", "t_last", "t_stop", "after_text")

    def __init__(self, identity: ReasoningBlock, part: str, *, withheld: bool, redactor,
                 t_start, after_text: bool):
        self.identity = identity
        self.part = part
        self.withheld = withheld
        self.redactor = redactor
        self.parts: list[str] = []
        self.chars = 0
        self.truncated = False
        self.t_start = t_start
        self.t_first = None
        self.t_last = None
        self.t_stop = None
        self.after_text = after_text


class ReasoningTracker:
    """Block identity, close, timing and placement for one model request (or one delegated turn).

    A new block opens when the parser's ``part`` or the resolved source changes, or after a text
    boundary. A block closes on the parser's stop, on a new block, on a text boundary, or at
    ``finish``; its StreamingRedactor is flushed into it first. ``thinking_end`` is sent at close
    when the placement is already decidable, and at ``finish`` for a summarized block that could
    still be inline (the only input it waits for is whether the request called tools).
    """

    def __init__(self, ui, *, seq: Callable[[], int], redactor_factory=None,
                 inline_enabled: bool = True, max_chars=INLINE_MAX_CHARS_DEFAULT,
                 from_subagent: bool = False):
        self.ui = ui
        self._seq = seq
        self._redactor_factory = redactor_factory
        self.inline_enabled = bool(inline_enabled)
        self.max_chars = clamp_max_chars(max_chars)
        self.from_subagent = bool(from_subagent)
        self._open: _Open | None = None
        self._closed: list[list] = []        # [block, decided]
        self._saw_text = False

    # events ------------------------------------------------------------------------------------------
    def thinking(self, chunk, origin: ReasoningOrigin | None = None) -> None:
        origin = origin if isinstance(origin, ReasoningOrigin) else LEGACY_ORIGIN
        stamp = now()
        if origin.event == "stop":
            current = self._open
            if current is not None and not current.withheld and current.part == origin.part:
                current.t_stop = stamp
                self._close()
            return
        source, provider = wire_identity(origin.source, origin.provider)
        if origin.event == "withheld":
            if source != "withheld":
                return                      # a no-text item that proves nothing shows nothing
            current = self._open
            if (current is not None and current.withheld
                    and current.identity.provider == provider):
                current.t_stop = stamp       # consecutive withheld items are one row
                return
            self._close()
            opened = self._begin(source, provider, origin, withheld=True)
            opened.t_start = origin.t_start if origin.t_start is not None else stamp
            opened.t_stop = stamp
            return
        text = str(chunk or "")
        if not text:
            return
        current = self._open
        if current is not None and (current.withheld or current.part != origin.part
                                    or current.identity.source != source
                                    or current.identity.provider != provider):
            self._close()
            current = None
        if current is None:
            current = self._begin(source, provider, origin, withheld=False)
        if current.t_first is None:
            current.t_first = stamp
        current.t_last = stamp
        safe = current.redactor.feed(text) if current.redactor is not None else text
        if safe:
            self._append(current, safe)
            deliver_thinking(self.ui, safe, current.identity)

    def text_boundary(self) -> None:
        """Prose started: the open block closes, and the next one is ``after_text``."""
        self._saw_text = True
        self._close()

    def finish(self, *, round_called_tools) -> list[ReasoningBlock]:
        """Close what is open, decide the pending placements, emit their ends, and return every
        block of this request in order with ``tools`` set."""
        self._close()
        tools = round_called_tools if isinstance(round_called_tools, bool) else None
        blocks: list[ReasoningBlock] = []
        closed, self._closed = self._closed, []
        for block, decided in closed:
            if not decided:
                block = dataclasses.replace(block, placement=placement(
                    block.source, block.text, round_called_tools=tools,
                    inline_enabled=self.inline_enabled, max_chars=self.max_chars,
                    from_subagent=self.from_subagent), tools=tools)
                deliver_thinking_end(self.ui, block)
            else:
                block = dataclasses.replace(block, tools=tools)
            blocks.append(block)
        return blocks

    @property
    def open(self) -> bool:
        return self._open is not None

    # internals ---------------------------------------------------------------------------------------
    def _begin(self, source: str, provider: str, origin: ReasoningOrigin, *, withheld: bool) -> _Open:
        key = f"r{int(self._seq())}"
        identity = ReasoningBlock(key=key, source=source, provider=provider,
                                  private=bool(origin.private), after_text=self._saw_text)
        redactor = (self._redactor_factory() if self._redactor_factory is not None and not withheld
                    else None)
        self._open = _Open(identity, origin.part, withheld=withheld, redactor=redactor,
                           t_start=origin.t_start, after_text=self._saw_text)
        return self._open

    @staticmethod
    def _append(current: _Open, text: str) -> None:
        room = PERSIST_BLOCK_CHARS - current.chars
        if room <= 0:
            current.truncated = True
            return
        if len(text) > room:
            current.truncated = True
            text = text[:room]
        current.parts.append(text)
        current.chars += len(text)

    def _close(self) -> None:
        current, self._open = self._open, None
        if current is None:
            return
        if current.redactor is not None:
            tail = current.redactor.flush()
            if tail:
                self._append(current, tail)
                deliver_thinking(self.ui, tail, current.identity)
        start = current.t_start if current.t_start is not None else current.t_first
        stop = current.t_stop if current.t_stop is not None else current.t_last
        seconds = None
        if start is not None and stop is not None:
            seconds = finite_seconds(max(0.0, min(MAX_SECONDS, stop - start)))
        text = "".join(current.parts)
        block = dataclasses.replace(current.identity, text=text, seconds=seconds,
                                    truncated=current.truncated)
        if current.withheld or can_decide_at_close(
                block.source, text, inline_enabled=self.inline_enabled,
                max_chars=self.max_chars, from_subagent=self.from_subagent):
            block = dataclasses.replace(block, placement=placement(
                block.source, text, round_called_tools=None, inline_enabled=self.inline_enabled,
                max_chars=self.max_chars, from_subagent=self.from_subagent))
            deliver_thinking_end(self.ui, block)
            self._closed.append([block, True])
        else:
            self._closed.append([block, False])


# ---- persistence ------------------------------------------------------------------------------------

def persisted_reasoning(blocks) -> list[dict]:
    """``_dgc_reasoning`` for one saved assistant message: at most 64 blocks, 8,000 chars per block
    and 24,000 per message; past a bound the text is cut and ``truncated`` set. Placement is not
    stored: replay recomputes it from the current settings."""
    entries: list[dict] = []
    budget = PERSIST_MESSAGE_CHARS
    for block in list(blocks or []):
        if len(entries) >= PERSIST_MAX_BLOCKS:
            break
        if not isinstance(block, ReasoningBlock):
            continue
        source, provider = wire_identity(block.source, block.provider)
        text = str(block.text or "")
        truncated = bool(block.truncated)
        limit = max(0, min(PERSIST_BLOCK_CHARS, budget))
        if len(text) > limit:
            text, truncated = text[:limit], True
        budget -= len(text)
        entry = {"v": 1, "source": source, "provider": provider, "private": bool(block.private),
                 "text": text, "tools": block.tools is True, "after_text": bool(block.after_text)}
        seconds = finite_seconds(block.seconds)
        if seconds is not None:
            entry["seconds"] = seconds
        if truncated:
            entry["truncated"] = True
        entries.append(entry)
    return entries


def extend_persisted_reasoning(existing, new) -> list[dict]:
    """A pause_turn continuation replaces the paused assistant message: its record keeps the
    earlier request's entries first, within the same per-message bounds."""
    merged: list[dict] = []
    budget = PERSIST_MESSAGE_CHARS
    for entry in list(existing or []) + list(new or []):
        if len(merged) >= PERSIST_MAX_BLOCKS:
            break
        if not isinstance(entry, dict):
            continue
        entry = dict(entry)
        text = entry.get("text") if isinstance(entry.get("text"), str) else ""
        limit = max(0, min(PERSIST_BLOCK_CHARS, budget))
        if len(text) > limit:
            entry["text"], entry["truncated"] = text[:limit], True
            text = entry["text"]
        budget -= len(text)
        merged.append(entry)
    return merged


def subagent_block(block: ReasoningBlock, prefix: str, *, end: bool = False) -> ReasoningBlock:
    """A child's block as its parent UI sees it: the key namespaced by the child's call prefix,
    ``agent`` set to that prefix only when no inner child already set it, and (on the end) never
    inline."""
    fields: dict = {"key": f"{prefix}:{block.key}"}
    if not block.agent:
        fields["agent"] = prefix
    if end:
        fields["placement"] = "collapsed"
    return dataclasses.replace(block, **fields)


def sanitize_saved_reasoning(value) -> list[dict]:
    """A saved (possibly hand-edited) ``_dgc_reasoning`` list as entries every emitter accepts."""
    if not isinstance(value, list):
        return []
    entries: list[dict] = []
    for raw in value[:PERSIST_MAX_BLOCKS]:
        if not isinstance(raw, dict):
            continue
        source = raw.get("source") if raw.get("source") in SOURCES else "unknown"
        provider = raw.get("provider") if raw.get("provider") in PROVIDERS else ""
        private = raw.get("private") is True
        if source in PROVIDER_SOURCES and (not provider or private):
            source, provider = "unknown", ""          # R1, and R2 on replay
        if source not in PROVIDER_SOURCES:
            provider = ""
        text = raw.get("text")
        text = text if isinstance(text, str) else ("" if text is None else str(text))
        truncated = raw.get("truncated") is True
        if len(text) > PERSIST_BLOCK_CHARS:
            text, truncated = text[:PERSIST_BLOCK_CHARS], True
        if source == "withheld":
            text = ""
        entries.append({"source": source, "provider": provider, "private": private, "text": text,
                        "seconds": finite_seconds(raw.get("seconds")),
                        "tools": bool(raw.get("tools")), "after_text": bool(raw.get("after_text")),
                        "truncated": truncated})
    return entries


_SPLICE_OPEN = "<think>\n"
_SPLICE_CLOSE = "\n</think>\n"


def splice_prefix_length(content: str, thinking: str) -> int:
    """Length of the ``<think>`` prefix ``_assistant_content_with_thinking`` writes, or 0."""
    value = str(thinking or "").strip()
    if not value:
        return 0
    prefix = _SPLICE_OPEN + value + _SPLICE_CLOSE
    return len(prefix) if str(content or "").startswith(prefix) else 0


def display_text(message: dict, text: str) -> str:
    """The assistant text as displayed: the exact thinking splice stripped."""
    text = str(text or "")
    if not isinstance(message, dict) or not text.startswith(_SPLICE_OPEN):
        return text
    marker = message.get("_dgc_think_splice")
    if isinstance(marker, int) and not isinstance(marker, bool):
        if 0 < marker <= len(text) and text[:marker].endswith(_SPLICE_CLOSE):
            return text[marker:]
        return text
    legacy = _legacy_splice(message, text)
    return text if legacy is None else legacy[1]


def _legacy_splice(message: dict, text: str):
    """(thinking, displayed text) for a v13 message whose content starts with the exact splice, or
    None. Only a message with no ``_provider_message`` (the only case the splice is written) and no
    v14 reasoning record qualifies; the thinking runs to the last ``\\n</think>\\n``."""
    if message.get("_provider_message") or "_dgc_reasoning" in message:
        return None
    if not text.startswith(_SPLICE_OPEN):
        return None
    end = text.rfind(_SPLICE_CLOSE)
    if end < len(_SPLICE_OPEN) - 1:
        return None
    thinking = text[len(_SPLICE_OPEN):end]
    if not thinking.strip():
        return None
    return thinking, text[end + len(_SPLICE_CLOSE):]


def legacy_reasoning(message: dict) -> list[dict]:
    """Entries for a v13 assistant message that carries no ``_dgc_reasoning``."""
    if not isinstance(message, dict) or "_dgc_reasoning" in message:
        return []
    tools = bool(message.get("tool_calls"))

    def entry(source: str, text: str, after_text: bool = False) -> dict:
        text = str(text or "")
        truncated = len(text) > PERSIST_BLOCK_CHARS
        return {"source": source, "provider": "", "private": False,
                "text": text[:PERSIST_BLOCK_CHARS], "seconds": None, "tools": tools,
                "after_text": after_text, "truncated": truncated}

    content = message.get("content")
    if isinstance(content, str):
        spliced = _legacy_splice(message, content)
        if spliced is not None:
            return [entry("unknown", spliced[0].strip())]
    provider_message = message.get("_provider_message")
    if isinstance(provider_message, dict):
        kind = provider_message.get("provider")
        if kind == "ollama":
            thinking = provider_message.get("thinking")
            if isinstance(thinking, str) and thinking.strip():
                return [entry("raw", thinking)]
            return []
        if kind == "anthropic":
            entries, seen_text = [], False
            for part in list(provider_message.get("content") or [])[:PERSIST_MAX_BLOCKS]:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and str(part.get("text") or "").strip():
                    seen_text = True
                elif part.get("type") == "thinking":
                    thinking = part.get("thinking")
                    if isinstance(thinking, str) and thinking.strip():
                        entries.append(entry("unknown", thinking, seen_text))
            return entries
    output = message.get("_responses_output")
    if isinstance(output, list):
        entries = []
        for item in output[:PERSIST_MAX_BLOCKS]:
            if not isinstance(item, dict) or item.get("type") != "reasoning":
                continue
            texts = [str(part.get("text") or "") for part in list(item.get("summary") or [])
                     if isinstance(part, dict) and str(part.get("text") or "").strip()]
            if texts:
                entries.append(entry("unknown", "\n\n".join(texts)))
        return entries
    return []


def saved_reasoning(message: dict) -> list[dict]:
    """The sanitized reasoning entries of a saved assistant message, v14 or legacy."""
    if not isinstance(message, dict):
        return []
    if "_dgc_reasoning" in message:
        return sanitize_saved_reasoning(message.get("_dgc_reasoning"))
    return legacy_reasoning(message)


# ---- frame invariants ---------------------------------------------------------------------------------

def reasoning_frame_error(frames, *, history: bool = False, private: bool = False) -> str | None:
    """The first violation of the v14 reasoning invariants in a captured stream, or None.

    1. source, provider and agent never change within a block;
    2. every block with a delta gets exactly one ``thinking_end`` after its last delta, before the
       request's ``stream_end`` / the turn's ``turn_end`` (history: also before the next
       ``text_delta`` or ``tool_call``); a block without deltas must be withheld (history: or cut);
    3. R1; with ``private`` (the fixture's host is private) also R2;
    4. ``placement == "inline"`` only for summarized/narration without ``agent``;
    5. a withheld block has no delta;
    6. block ids are unique within one turn (live) or one payload (history).
    """
    blocks: dict[str, dict] = {}

    def open_blocks():
        return [bid for bid, state in blocks.items() if state["deltas"] and not state["ended"]]

    for index, frame in enumerate(frames or []):
        if not isinstance(frame, dict):
            continue
        kind = frame.get("type")
        where = f"frame {index} ({kind})"
        if kind == "turn_start" and not history:
            left = open_blocks()
            if left:
                return f"{where}: block {left[0]!r} never ended"
            blocks = {}
            continue
        if kind in ("thinking_delta", "thinking_end"):
            bid = frame.get("block")
            if not isinstance(bid, str) or not bid:
                return f"{where}: missing block id"
            source, provider, agent = frame.get("source"), frame.get("provider", ""), frame.get("agent", "")
            if source not in SOURCES:
                return f"{where}: bad source {source!r}"
            if provider and provider not in PROVIDERS:
                return f"{where}: bad provider"
            if source in PROVIDER_SOURCES and not provider:
                return f"{where}: R1 (provider missing for {source})"
            if private and source in PROVIDER_SOURCES:
                return f"{where}: R2 ({source} on a private host)"
            state = blocks.get(bid)
            identity = (source, provider or "", agent or "")
            if state is not None:
                if state["ended"]:
                    return f"{where}: block {bid!r} reused after its thinking_end"
                if state["identity"] != identity:
                    return f"{where}: block {bid!r} changed its source/provider/agent"
            if kind == "thinking_delta":
                if source == "withheld":
                    return f"{where}: withheld block {bid!r} has a delta"
                if state is None:
                    state = blocks[bid] = {"identity": identity, "deltas": 0, "ended": False}
                state["deltas"] += 1
            else:
                if state is None:
                    if source != "withheld" and not (history and frame.get("truncated") is True):
                        return f"{where}: block {bid!r} ended without a delta"
                    state = blocks[bid] = {"identity": identity, "deltas": 0, "ended": False}
                placement_value = frame.get("placement")
                if placement_value not in ("inline", "collapsed"):
                    return f"{where}: bad placement"
                if placement_value == "inline" and (source not in INLINE_SOURCES or agent):
                    return f"{where}: inline placement for {source} (agent={bool(agent)})"
                state["ended"] = True
            continue
        if kind in ("stream_end", "turn_end") or (history and kind in ("text_delta", "tool_call")):
            left = open_blocks()
            if left:
                return f"{where}: block {left[0]!r} had no thinking_end before {kind}"
            if history and kind == "turn_end":
                continue
    left = open_blocks()
    if left:
        return f"end of stream: block {left[0]!r} never ended"
    return None
