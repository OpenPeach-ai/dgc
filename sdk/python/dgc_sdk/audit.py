"""Run audit log with secret redaction. Stored in the isolated state_dir, not host ~/.dgc.

Files are owner-only (0600 in a 0700 directory). Redaction removes the same high-confidence
credential shapes DGC removes from its own transcripts (provider and forge tokens, JWTs, PEM
private keys, ``Authorization`` headers, credential-named JSON/env/flag values, URL userinfo),
plus the exact values of credential-named variables in this process's environment and any
secret the SDK was given (the provider ``api_key``).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Mapping

REDACTED = "[redacted]"
_MIN_EXACT_SECRET = 8
_MAX_SECRET_VALUES = 256
_SAFE_PLACEHOLDERS = frozenset({
    "ollama", "sk-local", "lm-studio", "none", "null", "undefined", "password",
    "changeme", "example", "placeholder",
})
# Key names that carry credentials (``max_tokens`` / ``token_estimate`` are not).
_SENSITIVE_NAME_RE = re.compile(
    r"(?i)(?:^|[_-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|"
    r"secret[_-]?(?:access[_-]?)?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"session[_-]?token|oauth[_-]?token|id[_-]?token|token|password|passwd|passphrase|"
    r"client[_-]?secret|private[_-]?key|credentials?|secret|authorization|cookie)(?:$|[_-])"
)
_AUTH_HEADER_RE = re.compile(
    r"(?im)(\b(?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)"
    r"([^\s\"'`,;}{\]]{4,})"
)
_BEARER_RE = re.compile(r"(?i)(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})")
_HEADER_KEY_RE = re.compile(r"(?im)(\bx-(?:api|auth)-(?:key|token)\s*[:=]\s*)(\S{4,})")
_JSON_SECRET_RE = re.compile(
    r'''(?ix)
    (
      ["']?[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|
      session[_-]?token|oauth[_-]?token|token|password|passwd|passphrase|client[_-]?secret|
      secret[_-]?(?:access[_-]?)?key|private[_-]?key|credential|secret)["']?
      \s*:\s*
    )
    (["'])([^\r\n]*?)(\2)
    '''
)
_ASSIGN_SECRET_RE = re.compile(
    r"(?im)(\b[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|APIKEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET_KEY|"
    r"ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SESSION_TOKEN|OAUTH_TOKEN|TOKEN|PASSWORD|PASSWD|"
    r"PASSPHRASE|CLIENT_SECRET|PRIVATE_KEY|CREDENTIAL|SECRET)\s*[:=]\s*[\"']?)"
    r"([^\s\"'`;,]{4,})"
)
_FLAG_SECRET_RE = re.compile(
    r"(?i)(\B--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"session[_-]?token|token|password|client[_-]?secret|secret[_-]?key|credential)"
    r"(?:=|\s+))([^\s\"'`,;]{4,})"
)
_URL_CREDENTIAL_RE = re.compile(r"(?i)(\b[a-z][a-z0-9+.-]*://)([^\s/@:]+):([^\s/@]+)@")
_PREFIX_TOKEN_RE = re.compile(
    r"(?i)\b(?:sk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_-]{12,}|"
    r"github_pat_[A-Za-z0-9_]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|"
    r"xox[abeprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[0-9A-Za-z_-]{30,}|"
    r"(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{12,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|"
    r"pypi-[A-Za-z0-9_-]{30,})\b"
)
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?"
    r"-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----"
)
_MARKER = "\x00DGC-SDK-REDACTED\x00"

_SECRETS_LOCK = threading.Lock()
_EXTRA_SECRETS: set[str] = set()
_ENV_SECRETS: tuple[str, ...] | None = None


def _usable_secret(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (len(value) < _MIN_EXACT_SECRET or len(value) > 16_384
            or value.lower() in _SAFE_PLACEHOLDERS or "\x00" in value):
        return None
    return value


def sensitive_name(name: Any) -> bool:
    """Whether a key or variable name conventionally carries a credential."""
    return bool(_SENSITIVE_NAME_RE.search(str(name or "")))


def remember_secret(value: Any) -> None:
    """Mask this exact value in every later audit row (the provider key passed to DGC)."""
    usable = _usable_secret(value)
    if usable is None:
        return
    with _SECRETS_LOCK:
        if len(_EXTRA_SECRETS) < _MAX_SECRET_VALUES:
            _EXTRA_SECRETS.add(usable)


def _known_secrets() -> tuple[str, ...]:
    global _ENV_SECRETS
    with _SECRETS_LOCK:
        if _ENV_SECRETS is None:
            found = []
            for name, value in list(os.environ.items())[:4096]:
                usable = _usable_secret(value)
                if usable is not None and sensitive_name(name):
                    found.append(usable)
                    if len(found) >= _MAX_SECRET_VALUES:
                        break
            _ENV_SECRETS = tuple(found)
        values = set(_ENV_SECRETS) | _EXTRA_SECRETS
    return tuple(sorted(values, key=lambda item: (-len(item), item)))


def redact_text(value: str, secrets: Iterable[str] = ()) -> str:
    """Remove known secret values and high-confidence credential syntax from one string."""
    text = str(value or "").replace(REDACTED, _MARKER)
    for secret in (*_known_secrets(), *secrets):
        usable = _usable_secret(secret)
        if usable:
            text = text.replace(usable, _MARKER)
    text = _PRIVATE_KEY_RE.sub(_MARKER, text)
    text = _URL_CREDENTIAL_RE.sub(r"\1" + _MARKER + "@", text)
    text = _AUTH_HEADER_RE.sub(r"\1" + _MARKER, text)
    text = _BEARER_RE.sub(r"\1" + _MARKER, text)
    text = _HEADER_KEY_RE.sub(r"\1" + _MARKER, text)
    text = _JSON_SECRET_RE.sub(lambda match: match.group(1) + match.group(2)
                              + _MARKER + match.group(4), text)
    text = _ASSIGN_SECRET_RE.sub(r"\1" + _MARKER, text)
    text = _FLAG_SECRET_RE.sub(r"\1" + _MARKER, text)
    text = _PREFIX_TOKEN_RE.sub(_MARKER, text)
    text = _JWT_RE.sub(_MARKER, text)
    return text.replace(_MARKER, REDACTED)


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        out = {}
        for key, item in value.items():
            if sensitive_name(key) and isinstance(item, (str, bytes, int, float)) \
                    and not isinstance(item, bool):
                out[str(key)] = REDACTED
            else:
                out[str(key)] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value[:80]]
    if isinstance(value, tuple):
        return [redact(item) for item in value[:80]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact_text(str(value)[:2000])


def _open_private_append(path: Path):
    """Open ``path`` for appending as an owner-only (0600) file."""
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        if os.name == "posix":
            info = os.fstat(fd)
            if info.st_mode & 0o077:
                os.fchmod(fd, 0o600)
        return os.fdopen(fd, "a", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


class AuditLog:
    def __init__(self, directory: Path):
        from ._state import private_dir
        self.directory = private_dir(Path(directory))
        self._lock = threading.Lock()

    def path_for(self, session_id: str) -> Path:
        stem = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in (session_id or "unknown"))[:80]
        return self.directory / f"{stem or 'unknown'}.jsonl"

    def append(self, session_id: str, run_id: str, kind: str, payload: Mapping[str, Any],
               *, do_redact: bool = True) -> None:
        body = redact(dict(payload)) if do_redact else dict(payload)
        row = {
            "ts": time.time(),
            "session_id": session_id,
            "run_id": run_id,
            "type": kind,
            "payload": body,
        }
        line = json.dumps(row, ensure_ascii=False, default=str) + "\n"
        path = self.path_for(session_id)
        with self._lock:
            with _open_private_append(path) as handle:
                handle.write(line)

    def export(self, session_id: str | None = None, *, redact_output: bool = True) -> list[dict[str, Any]]:
        paths = [self.path_for(session_id)] if session_id else sorted(self.directory.glob("*.jsonl"))
        rows: list[dict[str, Any]] = []
        for path in paths:
            if not path.is_file():
                continue
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if redact_output:
                        row = redact(row)
                    rows.append(row)
        return rows
