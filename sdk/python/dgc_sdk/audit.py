"""Run audit log with secret redaction. Stored in the isolated state_dir, not host ~/.dgc."""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Mapping

_SECRET_RE = re.compile(
    r"(?i)(sk-[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._\-]+|api[_-]?key\s*[:=]\s*\S+|"
    r"authorization\s*[:=]\s*\S+|x-api-key\s*[:=]\s*\S+)"
)
_KEYISH = re.compile(r"(?i)(api_key|token|secret|password|authorization|passwd)")


def redact_text(value: str) -> str:
    return _SECRET_RE.sub("[redacted]", value)


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        out = {}
        for key, item in value.items():
            if _KEYISH.search(str(key)):
                out[str(key)] = "[redacted]"
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


class AuditLog:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
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
            with path.open("a", encoding="utf-8") as handle:
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
