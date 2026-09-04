"""Credential-aware redaction for transcripts, UI events, and diagnostics.

Redaction is deliberately narrow: DGC-owned credential values and high-confidence credential
shapes are removed, while ordinary source code such as ``api_key = config.get(...)`` remains
readable.  This is a disclosure boundary, not a general PII detector.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections.abc import Callable, Iterable


REDACTED = "[REDACTED]"
_MARKER = "\x00DGC-CREDENTIAL-REDACTED\x00"
_MIN_EXACT_SECRET = 8
_MAX_SECRET_VALUES = 256
_MAX_SECRET_CHARS = 16_384
_SAFE_PLACEHOLDERS = frozenset({
    "ollama", "sk-local", "lm-studio", "none", "null", "undefined", "password",
    "changeme", "example", "placeholder",
})
_SENSITIVE_NAME_RE = re.compile(
    r"(?i)(?:^|[_-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|"
    r"secret[_-]?(?:access[_-]?)?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"session[_-]?token|token|password|passwd|passphrase|client[_-]?secret|"
    r"private[_-]?key|credential)(?:$|[_-])"
)
_AUTH_HEADER_RE = re.compile(
    r"(?im)(\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+)"
    r"([^\s\"'`,;}{\]]{4,})"
)
_JSON_SECRET_RE = re.compile(
    r'''(?ix)
    (
      ["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|
      session[_-]?token|token|password|passwd|passphrase|client[_-]?secret|
      secret[_-]?(?:access[_-]?)?key|private[_-]?key|credential)["']?
      \s*:\s*
    )
    (["'])([^\r\n]*?)(\2)
    '''
)
_ENV_SECRET_RE = re.compile(
    r"(?im)(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET_KEY|"
    r"ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SESSION_TOKEN|TOKEN|PASSWORD|PASSWD|PASSPHRASE|"
    r"CLIENT_SECRET|PRIVATE_KEY|CREDENTIAL)\s*=\s*)"
    r"([^\s\"'`;]{4,})"
)
_FLAG_SECRET_RE = re.compile(
    r"(?i)(\B--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"session[_-]?token|token|password|client[_-]?secret|secret[_-]?key|credential)"
    r"(?:=|\s+))([^\s\"'`,;]{4,})"
)
_URL_CREDENTIAL_RE = re.compile(
    r"(?i)(\b[a-z][a-z0-9+.-]*://)([^\s/@:]+):([^\s/@]+)@"
)
_PREFIX_TOKEN_RE = re.compile(
    r"(?i)\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|"
    r"github_pat_[A-Za-z0-9_]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|"
    r"xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b"
)
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"
)
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?"
    r"-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"
)
_SUSPICIOUS_STREAM_TAIL_RE = re.compile(
    r"(?is)(?:\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)?\s*|"
    r"\b(?:sk-(?:proj-|svcacct-)?|github_pat_|gh[opusr]_|xox[baprs]-|eyJ)"
    r"[^\s\"'`,;}{\]]*)$"
)
_ENV_SECRET_LOCK = threading.Lock()
_ENV_SECRET_CACHE: tuple[str, ...] | None = None


def _usable_secret(value) -> str | None:
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (len(value) < _MIN_EXACT_SECRET or len(value) > _MAX_SECRET_CHARS
            or value.lower() in _SAFE_PLACEHOLDERS or "\x00" in value):
        return None
    return value


def sensitive_name(value) -> bool:
    """Whether a configuration/environment field name conventionally carries a credential."""
    return bool(_SENSITIVE_NAME_RE.search(str(value or "")))


def _environment_secret_values() -> tuple[str, ...]:
    """Snapshot ambient credentials once; a process cannot safely rotate its own environment."""
    global _ENV_SECRET_CACHE
    if _ENV_SECRET_CACHE is not None:
        return _ENV_SECRET_CACHE
    with _ENV_SECRET_LOCK:
        if _ENV_SECRET_CACHE is None:
            values = []
            for name, value in list(os.environ.items())[:4096]:
                usable = _usable_secret(value)
                if sensitive_name(name) and usable is not None:
                    values.append(usable)
                    if len(values) >= _MAX_SECRET_VALUES:
                        break
            _ENV_SECRET_CACHE = tuple(values)
    return _ENV_SECRET_CACHE


def secret_values(config=None) -> tuple[str, ...]:
    """Return bounded live credentials known to DGC, longest first.

    Environment values are included only when their variable name is credential-shaped. MCP and
    language-server environment maps receive the same treatment. This avoids treating every ambient
    environment value (HOME, PATH, locale) as secret text.
    """
    values: set[str] = set()

    def add(value) -> None:
        secret = _usable_secret(value)
        if secret is not None and len(values) < _MAX_SECRET_VALUES:
            values.add(secret)

    if config is not None:
        for key in ("api_key", "search_api_key", "subagent_api_key", "fallback_api_key"):
            try:
                add(config.get(key, ""))
            except Exception:
                pass
        for group_key in ("mcp_servers", "language_servers"):
            try:
                group = config.get(group_key, {}) or {}
            except Exception:
                group = {}
            if not isinstance(group, dict):
                continue
            for spec in list(group.values())[:64]:
                env = spec.get("env", {}) if isinstance(spec, dict) else {}
                auth_env = spec.get("auth_env", "") if isinstance(spec, dict) else ""
                if isinstance(env, dict):
                    for name, value in list(env.items())[:64]:
                        if sensitive_name(name) or name == auth_env:
                            add(value)
                if group_key == "mcp_servers" and isinstance(auth_env, str) and auth_env:
                    # auth_env is an explicit trust label, not a naming heuristic. Ambient
                    # variables such as MCP_BEARER must be redacted even without TOKEN/KEY in the
                    # name because DGC will deliberately send them as Authorization credentials.
                    add(os.environ.get(auth_env, ""))
        for env in list(getattr(config, "_stored_mcp_env", {}).values())[:64]:
            if isinstance(env, dict):
                for value in list(env.values())[:64]:
                    add(value)
        for value in getattr(config, "_session_secret_values", ()):
            add(value)
    for value in _environment_secret_values():
        add(value)
    return tuple(sorted(values, key=lambda item: (-len(item), item)))


def redact_text(value, secrets: Iterable[str] = ()) -> str:
    """Remove known credentials and high-confidence credential syntax from one string."""
    text = str(value or "").replace(REDACTED, _MARKER)
    for secret in secrets:
        usable = _usable_secret(secret)
        if usable:
            text = text.replace(usable, _MARKER)
    text = _PRIVATE_KEY_RE.sub(_MARKER, text)
    text = _URL_CREDENTIAL_RE.sub(r"\1" + _MARKER + "@", text)
    text = _AUTH_HEADER_RE.sub(r"\1" + _MARKER, text)
    text = _JSON_SECRET_RE.sub(lambda match: match.group(1) + match.group(2)
                              + _MARKER + match.group(4), text)
    text = _ENV_SECRET_RE.sub(r"\1" + _MARKER, text)
    text = _FLAG_SECRET_RE.sub(r"\1" + _MARKER, text)
    text = _PREFIX_TOKEN_RE.sub(_MARKER, text)
    text = _JWT_RE.sub(_MARKER, text)
    return text.replace(_MARKER, REDACTED)


def bounded_redacted_view(value, maximum: int, *, label: str = "characters",
                          head_fraction: float = 0.5) -> str:
    """Bound already-redacted text without ever slicing the disclosure sentinel.

    Callers must sanitize the complete source first.  Keeping a useful head and tail avoids both
    the credential-fragment bug caused by clip-before-redact and the ambiguity of a partial
    ``[REDACTED]`` marker at either retained boundary.
    """
    text = str(value or "")
    maximum = int(maximum)
    if maximum < 128:
        raise ValueError("a bounded redacted view must retain at least 128 characters")
    if len(text) <= maximum:
        return text
    ratio = max(0.0, min(1.0, float(head_fraction)))
    safe_label = re.sub(r"[^a-zA-Z0-9 _-]", "", str(label or "characters"))[:48] \
        or "characters"

    def prefix(limit: int) -> str:
        cut = max(0, min(len(text), limit))
        start = text.rfind(
            REDACTED, max(0, cut - len(REDACTED) + 1),
            min(len(text), cut + len(REDACTED)))
        if start >= 0 and start < cut < start + len(REDACTED):
            cut = start  # omit the sentinel whole; never retain a disclosure-looking fragment.
        return text[:cut]

    def suffix(limit: int) -> str:
        if limit <= 0:
            return ""
        start = max(0, len(text) - limit)
        marker = text.rfind(
            REDACTED, max(0, start - len(REDACTED) + 1),
            min(len(text), start + len(REDACTED)))
        if marker >= 0 and marker < start < marker + len(REDACTED):
            start = marker + len(REDACTED)
        return text[start:]

    marker = "\n… [bounded content omitted] …\n"
    head = tail = ""
    for _ in range(10):
        available = max(0, maximum - len(marker))
        head = prefix(int(available * ratio))
        tail = suffix(max(0, available - len(head)))
        omitted = max(0, len(text) - len(head) - len(tail))
        updated = f"\n… [{omitted} {safe_label} omitted from this bounded view] …\n"
        if updated == marker:
            break
        marker = updated
    available = max(0, maximum - len(marker))
    head = prefix(int(available * ratio))
    tail = suffix(max(0, available - len(head)))
    return head + marker + tail


def redact_known_text(value, secrets: Iterable[str] = ()) -> str:
    """Redact only exact known values, preserving opaque provider continuation payloads."""
    text = str(value or "").replace(REDACTED, _MARKER)
    for secret in secrets:
        usable = _usable_secret(secret)
        if usable:
            text = text.replace(usable, _MARKER)
    return text.replace(_MARKER, REDACTED)


def redact_value(value, secrets: Iterable[str] = (), *, _depth: int = 0):
    """Return a detached JSON-like value with string leaves redacted."""
    if _depth > 32:
        return REDACTED
    if isinstance(value, str):
        return redact_text(value, secrets)
    if isinstance(value, bytes):
        try:
            return redact_text(value.decode("utf-8"), secrets)
        except UnicodeDecodeError:
            return value
    if isinstance(value, dict):
        return {(redact_text(key, secrets) if isinstance(key, str) else key):
                redact_value(item, secrets, _depth=_depth + 1)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact_value(item, secrets, _depth=_depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_value(item, secrets, _depth=_depth + 1) for item in value)
    return value


def redact_known_value(value, secrets: Iterable[str] = (), *, _depth: int = 0):
    """Deep exact-value redaction for provider-private opaque transcript metadata."""
    if _depth > 32:
        return REDACTED
    if isinstance(value, str):
        return redact_known_text(value, secrets)
    if isinstance(value, bytes):
        try:
            return redact_known_text(value.decode("utf-8"), secrets)
        except UnicodeDecodeError:
            return value
    if isinstance(value, dict):
        return {(redact_known_text(key, secrets) if isinstance(key, str) else key):
                redact_known_value(item, secrets, _depth=_depth + 1)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact_known_value(item, secrets, _depth=_depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_known_value(item, secrets, _depth=_depth + 1) for item in value)
    return value


_OPAQUE_PROVIDER_FIELDS = frozenset({
    "encrypted_content", "encrypted_reasoning", "signature",
    "thinking_signature", "reasoning_signature",
})
_OPAQUE_PROVIDER_BLOCK_TYPES = frozenset({
    "thinking", "redacted_thinking", "server_tool_use", "fallback",
})


def _opaque_anthropic_block(value) -> bool:
    """Whether a Messages content block must be replayed as one exact provider value."""
    kind = str(value.get("type") or "").lower() if isinstance(value, dict) else ""
    return kind in _OPAQUE_PROVIDER_BLOCK_TYPES or kind.endswith("_tool_result")


def redact_provider_value(value, secrets: Iterable[str] = (), *, _depth: int = 0,
                          _opaque: bool = False, _provider: str = "",
                          _anthropic_content: bool = False):
    """Redact visible provider metadata while preserving signed/encrypted continuation blobs."""
    if _depth > 32:
        return REDACTED
    if isinstance(value, str):
        return (redact_known_text(value, secrets) if _opaque
                else redact_text(value, secrets))
    if isinstance(value, bytes):
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError:
            return value
        return redact_known_text(text, secrets) if _opaque else redact_text(text, secrets)
    if isinstance(value, dict):
        # Anthropic signs the complete thinking block, not only its ``signature`` field. Applying
        # shape-based token redaction to the thinking text would make an otherwise valid signature
        # impossible to replay. Exact configured credentials are still replaced here; Agent detects
        # that change and fails closed before either sending or retaining the broken continuation.
        provider = _provider or str(value.get("provider") or "").lower()
        block_opaque = (_opaque or (_anthropic_content and provider == "anthropic"
                                    and _opaque_anthropic_block(value)))
        return {
            (redact_known_text(key, secrets) if block_opaque else redact_text(key, secrets))
            if isinstance(key, str) else key: redact_provider_value(
                item, secrets, _depth=_depth + 1,
                _opaque=(block_opaque or str(key).lower() in _OPAQUE_PROVIDER_FIELDS),
                _provider=provider,
                _anthropic_content=(provider == "anthropic" and str(key).lower() == "content"
                                    and isinstance(item, (list, tuple))))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_provider_value(item, secrets, _depth=_depth + 1, _opaque=_opaque,
                                      _provider=_provider,
                                      _anthropic_content=_anthropic_content)
                for item in value]
    if isinstance(value, tuple):
        return tuple(redact_provider_value(item, secrets, _depth=_depth + 1, _opaque=_opaque,
                                           _provider=_provider,
                                           _anthropic_content=_anthropic_content)
                     for item in value)
    return value


def provider_continuation_has_secret(value, secrets: Iterable[str] = (), *,
                                     _depth: int = 0, _opaque: bool = False,
                                     _provider: str = "",
                                     _anthropic_content: bool = False) -> bool:
    """Whether exact redaction would mutate signed/encrypted provider continuation state.

    Such state cannot be safely redacted in place: its signature or ciphertext would no longer be
    valid. Callers must stop before replaying or persisting it. Visible provider text is deliberately
    ignored here because ordinary redaction can safely sanitize that material.
    """
    if _depth > 32:
        return _opaque
    if isinstance(value, str):
        return _opaque and redact_known_text(value, secrets) != value
    if isinstance(value, bytes):
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError:
            return False
        return _opaque and redact_known_text(text, secrets) != text
    if isinstance(value, dict):
        provider = _provider or str(value.get("provider") or "").lower()
        block_opaque = (_opaque or (_anthropic_content and provider == "anthropic"
                                    and _opaque_anthropic_block(value)))
        for key, item in value.items():
            if (block_opaque and isinstance(key, str)
                    and redact_known_text(key, secrets) != key):
                return True
            if provider_continuation_has_secret(
                    item, secrets, _depth=_depth + 1,
                    _opaque=(block_opaque or str(key).lower() in _OPAQUE_PROVIDER_FIELDS),
                    _provider=provider,
                    _anthropic_content=(provider == "anthropic" and str(key).lower() == "content"
                                        and isinstance(item, (list, tuple)))):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(provider_continuation_has_secret(
            item, secrets, _depth=_depth + 1, _opaque=_opaque,
            _provider=_provider, _anthropic_content=_anthropic_content) for item in value)
    return False


def redact_message(message, secrets: Iterable[str] = ()):
    """Redact one transcript message without corrupting opaque provider continuation fields."""
    if not isinstance(message, dict):
        return redact_value(message, secrets)
    return {
        (redact_text(key, secrets) if isinstance(key, str) else key):
        (redact_provider_value(value, secrets)
         if key in ("_responses_output", "_provider_message")
         else redact_value(value, secrets))
        for key, value in message.items()
    }


def redact_messages(messages, secrets: Iterable[str] = ()):
    if not isinstance(messages, list):
        return redact_value(messages, secrets)
    return [redact_message(message, secrets) for message in messages]


def contains_secret(value, secrets: Iterable[str] = ()) -> bool:
    """Whether the redaction contract would change this JSON-like value."""
    try:
        before = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        after = json.dumps(redact_value(value, secrets), ensure_ascii=False,
                           sort_keys=True, default=str)
        return before != after
    except (TypeError, ValueError, RecursionError):
        return True


def redact_checkpoint_state(state, secrets: Iterable[str] = ()) -> dict:
    """Redact checkpoint conversation blobs and rebuild their content-addressed graph.

    File snapshots are exact rollback data and remain byte-for-byte unchanged. Conversation hashes
    cannot merely be edited in place: every linked prefix and point head must be derived again or a
    resumed CheckpointManager will correctly reject the state as tampered.
    """
    if not isinstance(state, dict):
        return state
    raw_messages = state.get("messages")
    raw_chains = state.get("chains")
    raw_points = state.get("points")
    if not isinstance(raw_messages, dict) or not isinstance(raw_chains, dict) \
            or not isinstance(raw_points, list):
        return redact_value(state, secrets)
    if len(raw_messages) > 100_000 or len(raw_chains) > 200_000 or len(raw_points) > 512:
        return redact_value(state, secrets)

    message_map: dict[str, str] = {}
    messages: dict[str, object] = {}
    for old_hash, message in raw_messages.items():
        if not re.fullmatch(r"[0-9a-f]{64}", str(old_hash)):
            return redact_value(state, secrets)
        source_encoded = json.dumps(message, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), default=str).encode("utf-8")
        source_hash = hashlib.sha256(source_encoded).hexdigest()
        if str(old_hash) != source_hash:
            return redact_value(state, secrets)
        redacted = redact_message(json.loads(source_encoded), secrets)
        encoded = json.dumps(redacted, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), default=str).encode("utf-8")
        new_hash = hashlib.sha256(encoded).hexdigest()
        message_map[str(old_hash)] = new_hash
        messages[new_hash] = json.loads(encoded)

    chain_map: dict[str, str] = {"": ""}
    chains: dict[str, dict] = {}
    raw_chain_map = {str(key): node for key, node in raw_chains.items()}
    # Each node has exactly one predecessor. Walk each not-yet-mapped tail back to a known prefix,
    # then rebuild forward. This remains O(nodes) even if hostile JSON reverses dictionary order.
    for start in raw_chain_map:
        if start in chain_map:
            continue
        trail, seen, current = [], set(), start
        while current not in chain_map:
            if current in seen:
                return redact_value(state, secrets)
            seen.add(current)
            node = raw_chain_map.get(current)
            if not isinstance(node, dict):
                return redact_value(state, secrets)
            previous = str(node.get("previous") or "")
            old_message = str(node.get("message") or "")
            if ((previous and not re.fullmatch(r"[0-9a-f]{64}", previous))
                    or not re.fullmatch(r"[0-9a-f]{64}", old_message)):
                return redact_value(state, secrets)
            expected = hashlib.sha256(f"{previous}:{old_message}".encode("ascii")).hexdigest()
            if current != expected or old_message not in message_map:
                return redact_value(state, secrets)
            trail.append(current)
            current = previous
        while trail:
            old_hash = trail.pop()
            node = raw_chain_map[old_hash]
            previous = str(node.get("previous") or "")
            old_message = str(node.get("message") or "")
            new_message = message_map.get(old_message)
            if new_message is None or previous not in chain_map:
                return redact_value(state, secrets)
            new_previous = chain_map[previous]
            new_hash = hashlib.sha256(f"{new_previous}:{new_message}".encode("ascii")).hexdigest()
            chain_map[old_hash] = new_hash
            chains[new_hash] = {"previous": new_previous, "message": new_message}

    points = []
    for point in raw_points:
        if not isinstance(point, dict):
            return redact_value(state, secrets)
        row = dict(point)
        row["preview"] = redact_text(row.get("preview", ""), secrets)
        old_head = str(row.get("conversation_head") or "")
        if old_head not in chain_map:
            return redact_value(state, secrets)
        row["conversation_head"] = chain_map[old_head]
        # Snapshot maps intentionally come from the unredacted source row.
        row["files"] = point.get("files", {})
        points.append(row)

    clean = dict(state)
    clean["messages"] = messages
    clean["chains"] = chains
    clean["points"] = points
    return clean


class StreamingRedactor:
    """Redact exact credentials even when a provider splits them across stream chunks."""

    def __init__(self, secrets: Callable[[], Iterable[str]] | Iterable[str] = ()):
        self._source = secrets
        self._pending = ""

    def _secrets(self) -> tuple[str, ...]:
        try:
            values = self._source() if callable(self._source) else self._source
            return tuple(secret for secret in values if _usable_secret(secret))
        except Exception:
            return ()

    def feed(self, chunk) -> str:
        text = self._pending + str(chunk or "")
        self._pending = ""
        if not text:
            return ""
        secrets = self._secrets()
        hold = 0
        # Keep only a suffix that could be the start of a known credential. Normal prose streams
        # immediately; a suspicious prefix waits for the next chunk or the end-of-stream flush.
        for secret in secrets:
            limit = min(len(text), len(secret) - 1)
            for size in range(limit, 0, -1):
                if text.endswith(secret[:size]):
                    hold = max(hold, size)
                    break
        suspicious = _SUSPICIOUS_STREAM_TAIL_RE.search(text)
        if suspicious:
            hold = max(hold, len(text) - suspicious.start())
        if hold:
            self._pending = text[-hold:]
            text = text[:-hold]
        return redact_text(text, secrets)

    def flush(self) -> str:
        pending, self._pending = self._pending, ""
        return redact_text(pending, self._secrets())
